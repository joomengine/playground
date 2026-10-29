/*
 * JoomEngine Code HTTP bridge for the upstream phpdbg WebAssembly runtime.
 * Copyright 2026 Vast Development Method. Licensed under Apache-2.0.
 *
 * Loaded only into a disposable phpdbg request instance. The host copies the
 * authoritative site filesystem in before starting it and copies it back before
 * releasing the request queue. These callbacks implement PHP's SAPI contract;
 * no PHP wrapper fabricates superglobals or replays the application request.
 */
#include "php.h"
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "SAPI.h"
#include "main/php_variables.h"
#include "Zend/zend_execute.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_smart_str.h"
#include "ext/json/php_json.h"
#include "sapi/phpdbg/phpdbg.h"

/* Upstream exports the bp_count address but keeps phpdbg_globals local. The
 * version-pinned PHP header gives its exact offset; no guessed memory layout. */
extern int *php_wasm_get_bpcount(void);
static zend_phpdbg_globals *jec_debug_globals(void)
{
    return (zend_phpdbg_globals *) ((char *) php_wasm_get_bpcount() - offsetof(zend_phpdbg_globals, bp_count));
}
#undef PHPDBG_G
#define PHPDBG_G(value) (jec_debug_globals()->value)

#define JEC_RESPONSE_LIMIT (320u * 1024u * 1024u)
#define JEC_INPUT_PATH "/internal/jec-request-body.bin"
#define JEC_OUTPUT_PATH "/internal/jec-response-body.bin"
#define JEC_HEADERS_PATH "/internal/jec-response-headers.txt"
#define JEC_FAILURE_PATH "/internal/jec-response-error.txt"
#define JEC_ENV_PATH "/internal/jec-request-environment.bin"

static FILE *jec_input;
static FILE *jec_output;
static size_t jec_output_length;
static char *jec_method, *jec_query, *jec_uri, *jec_filename, *jec_type, *jec_cookies;
static sapi_module_struct jec_original_sapi;
static user_opcode_handler_t jec_original_handlers[256];
static const unsigned char jec_opcodes[] = { ZEND_EXT_STMT, ZEND_JMP, ZEND_JMPZ, ZEND_JMPNZ, ZEND_JMPZ_EX, ZEND_JMPNZ_EX,
    ZEND_RETURN, ZEND_GENERATOR_RETURN };
static zend_execute_data *jec_step_out_frame;
static zend_execute_data *jec_step_over_frame;
static uint32_t jec_step_over_line;
static void (*jec_original_execute)(zend_execute_data *);
static void (*jec_original_error)(int, zend_string *, const uint32_t, zend_string *);
static unsigned jec_stmt_count;
static double jec_next_yield;
static bool jec_active;
static bool jec_request_started;
static bool jec_inspection_output;
static HashTable jec_values;
static bool jec_values_initialized;
static zend_long jec_next_value = 1;

/* The worker sets this field directly; these messages never queue behind PHP. */
EM_ASYNC_JS(int, jec_yield_control, (void), {
    await new Promise(resolve => setTimeout(resolve, 0));
    const command = Module.jecDebugControl || 0;
    Module.jecDebugControl = 0;
    return command;
});

EM_JS(void, jec_report_error, (const char *message, const char *filename, unsigned line), {
    if (Module.jecDebugError) Module.jecDebugError(UTF8ToString(message), UTF8ToString(filename), line);
});

EM_JS(void, jec_install_inspection_resume, (bool *flag), {
    /* ev's output-context teardown runs after PHPDBG_IN_EVAL is cleared. The
     * host releases this extra guard only after its final command prompt, so
     * resuming between EXT_STMT and ECHO still writes to the HTTP response. */
    Module.jecDebugResume = () => { HEAPU8[flag] = 0; };
});

static void jec_error(int type, zend_string *filename, const uint32_t line, zend_string *message)
{
    if (!(PHPDBG_G(flags) & PHPDBG_IN_EVAL) && !SG(headers_sent)
        && (type & (E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR))) {
        SG(sapi_headers).http_response_code = 500;
    }
    if (EG(error_reporting) & type) jec_report_error(ZSTR_VAL(message), filename ? ZSTR_VAL(filename) : "", line);
    jec_original_error(type, filename, line, message);
}

static void jec_record_failure(const char *message)
{
    FILE *file = fopen(JEC_FAILURE_PATH, "wb");
    if (file) {
        fwrite(message, 1, strlen(message), file);
        fclose(file);
    }
}

static char *jec_environment_copy(const char *name, const char *fallback)
{
    const char *value = getenv(name);
    return strdup(value ? value : fallback);
}

static int jec_initialize_environment(void)
{
    FILE *file = fopen(JEC_ENV_PATH, "rb");
    long size;
    char *data, *cursor, *end;
    if (!file || fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 || size > 1024 * 1024
        || fseek(file, 0, SEEK_SET) != 0) { if (file) fclose(file); return FAILURE; }
    data = malloc((size_t) size + 1);
    if (!data || fread(data, 1, (size_t) size, file) != (size_t) size) {
        free(data); fclose(file); return FAILURE;
    }
    fclose(file);
    cursor = data; end = data + size; *end = '\0';
    while (cursor < end) {
        char *name = cursor;
        cursor += strlen(cursor) + 1;
        if (cursor >= end || !*name || strchr(name, '=')) { free(data); return FAILURE; }
        char *value = cursor;
        cursor += strlen(cursor) + 1;
        if (cursor > end || setenv(name, value, 1) != 0) { free(data); return FAILURE; }
    }
    free(data);
    return SUCCESS;
}

static size_t jec_read_post(char *buffer, size_t count)
{
    /* php_module_startup deactivates its empty bootstrap request after MINIT.
     * SAPI drains unread input then, although our real request has not started.
     * Real activation reads POST before calling our activate callback, so permit
     * that read through PHP's startup flag and later lazy php://input reads. */
    if (!jec_request_started && !PG(during_request_startup)) return 0;
    if (!jec_input) return 0;
    return fread(buffer, 1, count, jec_input);
}

static char *jec_read_cookies(void)
{
    return jec_cookies;
}

static int jec_activate(void)
{
    jec_request_started = true;
    int result = jec_original_sapi.activate ? jec_original_sapi.activate() : SUCCESS;
    SG(request_info).proto_num = 1001;
    return result;
}

/* A selected HTTP request has exactly one execution. phpdbg normally cleans
 * and starts a second request after run, which would reset HTTP outputs and
 * suppress application shutdown callbacks. Exit its command loop instead. */
static void jec_execute(zend_execute_data *execute_data)
{
    zend_try {
        jec_original_execute(execute_data);
        jec_inspection_output = false;
        zend_exception_restore();
        zend_try_exception_handler();
        if (EG(exception) && !zend_is_unwind_exit(EG(exception))) {
            /* The debugger already stopped at the throw. Report the final HTTP
             * failure without a second prompt after the application stack ended. */
            PHPDBG_G(flags) |= PHPDBG_PREVENT_INTERACTIVE;
            zend_exception_error(EG(exception), E_ERROR);
        }
    } zend_catch {
        jec_inspection_output = false;
        /* The original PHP error/exit state is preserved for request shutdown. */
    } zend_end_try();
    PHPDBG_G(flags) = (PHPDBG_G(flags) & ~PHPDBG_IS_CLEANING) | PHPDBG_IS_QUITTING;
    zend_bailout();
}

static int jec_header_handler(sapi_header_struct *header, sapi_header_op_enum op,
    sapi_headers_struct *headers)
{
    /* SAPI owns replacement/deletion and the final ordered header list. */
    return SAPI_HEADER_ADD;
}

static int jec_send_headers(sapi_headers_struct *headers)
{
    if ((PHPDBG_G(flags) & PHPDBG_IN_EVAL) || jec_inspection_output) {
        /* phpdbg temporarily activates an output context for ev. Its console
         * print must not commit the pending HTTP response's status or headers. */
        SG(headers_sent) = 0;
        return SAPI_HEADER_SENT_SUCCESSFULLY;
    }
    FILE *file = fopen(JEC_HEADERS_PATH, "wb");
    sapi_header_struct *header;
    zend_llist_position position;
    if (!file) {
        jec_record_failure("Could not write the PHP debug response headers.");
        return SAPI_HEADER_SEND_FAILED;
    }
    fprintf(file, "%d\n", headers->http_response_code > 0 ? headers->http_response_code : 200);
    for (header = zend_llist_get_first_ex(&headers->headers, &position); header;
         header = zend_llist_get_next_ex(&headers->headers, &position)) {
        if (fwrite(header->header, 1, header->header_len, file) != header->header_len
            || fputc('\n', file) == EOF) {
            fclose(file);
            jec_record_failure("Could not complete the PHP debug response headers.");
            return SAPI_HEADER_SEND_FAILED;
        }
    }
    if (fclose(file) != 0) {
        jec_record_failure("Could not finish the PHP debug response headers.");
        return SAPI_HEADER_SEND_FAILED;
    }
    return SAPI_HEADER_SENT_SUCCESSFULLY;
}

static void jec_register_variables(zval *variables)
{
    /* The host supplies the same CGI environment used by the normal request. */
    php_import_environment_variables(variables);
}

static size_t jec_write_response(const char *bytes, size_t length)
{
    /* Explicit debugger evaluation writes to the console, never the HTTP body. */
    if ((PHPDBG_G(flags) & PHPDBG_IN_EVAL) || jec_inspection_output) {
        return jec_original_sapi.ub_write(bytes, length);
    }
    if (!jec_output || length > JEC_RESPONSE_LIMIT - jec_output_length) {
        jec_record_failure("The PHP debug response exceeds the transport limit or cannot be written.");
        zend_bailout();
    }
    if (fwrite(bytes, 1, length, jec_output) != length || fflush(jec_output) != 0) {
        jec_record_failure("Could not write the complete PHP debug response body.");
        zend_bailout();
    }
    jec_output_length += length;
    return length;
}

static int jec_statement(zend_execute_data *execute_data)
{
    if (!(PHPDBG_G(flags) & PHPDBG_IN_EVAL)) jec_inspection_output = false;
    if (jec_step_over_frame && !(PHPDBG_G(flags) & PHPDBG_IN_EVAL)) {
        bool return_opcode = execute_data->opline->opcode == ZEND_RETURN || execute_data->opline->opcode == ZEND_GENERATOR_RETURN;
        bool returned = execute_data == jec_step_over_frame && return_opcode;
        if (returned) {
            jec_step_over_frame = NULL;
            /* The outermost wrapper owns the HTTP request and has no editor
             * source. Leaving the request's main file should finish normally. */
            if (execute_data->prev_execute_data && execute_data->prev_execute_data->prev_execute_data)
                PHPDBG_G(flags) |= PHPDBG_IS_STEPPING;
        } else if (return_opcode && execute_data->prev_execute_data) {
            /* Returning from a callee resumes the same call-site line. Keep
             * phpdbg's line-breakpoint guard on that line so the original
             * gutter breakpoint is not hit again midway through Step Over. */
            PHPDBG_G(last_line) = execute_data->prev_execute_data->opline->lineno;
        } else if (execute_data->opline->opcode == ZEND_EXT_STMT) {
            zend_execute_data *frame = execute_data;
            while (frame && frame != jec_step_over_frame) frame = frame->prev_execute_data;
            if (!frame || (execute_data == frame && execute_data->opline->lineno != jec_step_over_line)) {
                /* EXT_STMT has no application side effects. Pause before the
                 * next opcode at the next caller line, including an exception
                 * unwinding the selected frame. Ordinary breakpoints remain
                 * enabled inside callees while a step-over is pending. */
                jec_step_over_frame = NULL;
                PHPDBG_G(flags) |= PHPDBG_IS_SIGNALED;
            }
        }
    }
    if (execute_data == jec_step_out_frame
        && (execute_data->opline->opcode == ZEND_RETURN || execute_data->opline->opcode == ZEND_GENERATOR_RETURN)) {
        /* phpdbg's finish command suppresses stops inside the current frame but
         * ordinarily continues through its caller too. Arm one step at return. */
        jec_step_out_frame = NULL;
        if (execute_data->prev_execute_data && execute_data->prev_execute_data->prev_execute_data)
            PHPDBG_G(flags) |= PHPDBG_IS_STEPPING;
    }
    /* Extended statement opcodes are enabled by phpdbg's existing -e switch. */
    if (!(++jec_stmt_count & 63u) && emscripten_get_now() >= jec_next_yield) {
        int command = jec_yield_control();
        jec_next_yield = emscripten_get_now() + 16.0;
        if (command == 2) {
            PHPDBG_G(flags) |= PHPDBG_IS_QUITTING;
            jec_record_failure("PHP debugging was stopped. The request was not replayed.");
            zend_bailout();
        }
        if (command == 1) PHPDBG_G(flags) |= PHPDBG_IS_SIGNALED;
    }
    user_opcode_handler_t previous = jec_original_handlers[execute_data->opline->opcode];
    return previous ? previous(execute_data) : ZEND_USER_OPCODE_DISPATCH;
}

PHP_FUNCTION(jec_debug_step_out)
{
    jec_inspection_output = true;
    ZEND_PARSE_PARAMETERS_NONE();
    if (!(PHPDBG_G(flags) & PHPDBG_IN_EVAL)) RETURN_FALSE;
    zend_execute_data *frame = execute_data->prev_execute_data;
    while (frame && (!frame->func || frame->func->type != ZEND_USER_FUNCTION)) frame = frame->prev_execute_data;
    jec_step_out_frame = frame;
    RETURN_BOOL(frame != NULL);
}

PHP_FUNCTION(jec_debug_step_over)
{
    jec_inspection_output = true;
    ZEND_PARSE_PARAMETERS_NONE();
    if (!(PHPDBG_G(flags) & PHPDBG_IN_EVAL)) RETURN_FALSE;
    zend_execute_data *frame = execute_data->prev_execute_data;
    while (frame && (!frame->func || frame->func->type != ZEND_USER_FUNCTION)) frame = frame->prev_execute_data;
    jec_step_over_frame = frame;
    jec_step_over_line = frame ? frame->opline->lineno : 0;
    RETURN_BOOL(frame != NULL);
}

static zend_long jec_capture(zval *value)
{
    if (!jec_values_initialized) {
        zend_hash_init(&jec_values, 16, NULL, ZVAL_PTR_DTOR, 0);
        jec_values_initialized = true;
    }
    if (zend_hash_num_elements(&jec_values) >= 50000) {
        zend_throw_error(NULL, "Too many debug value handles. Continue PHP to release them.");
        return 0;
    }
    zval copy;
    ZVAL_COPY(&copy, value);
    zend_long handle = jec_next_value++;
    zend_hash_index_add_new(&jec_values, handle, &copy);
    return handle;
}

static void jec_describe(zval *result, const char *name, size_t name_length, zval *value)
{
    ZVAL_DEREF(value);
    if (Z_TYPE_P(value) == IS_INDIRECT) { value = Z_INDIRECT_P(value); ZVAL_DEREF(value); }
    array_init(result);
    add_assoc_stringl(result, "name", name, name_length);
    zend_long reference = 0;
    switch (Z_TYPE_P(value)) {
        case IS_ARRAY:
            add_assoc_string(result, "type", "array");
            add_assoc_str(result, "value", strpprintf(0, "Array(%u)", zend_hash_num_elements(Z_ARRVAL_P(value))));
            add_assoc_long(result, "indexedVariables", zend_hash_num_elements(Z_ARRVAL_P(value)));
            reference = jec_capture(value); break;
        case IS_OBJECT:
            add_assoc_string(result, "type", "object");
            add_assoc_str(result, "value", zend_string_copy(Z_OBJCE_P(value)->name));
            reference = jec_capture(value); break;
        case IS_STRING: {
            /* Bound each displayed string without traversing other properties. */
            size_t length = Z_STRLEN_P(value) > 4096 ? 4096 : Z_STRLEN_P(value);
            zend_string *quoted = php_json_encode_string(Z_STRVAL_P(value), length, PHP_JSON_INVALID_UTF8_SUBSTITUTE);
            if (length < Z_STRLEN_P(value)) {
                zend_string *truncated = strpprintf(0, "%s…", ZSTR_VAL(quoted));
                zend_string_release(quoted); quoted = truncated;
            }
            add_assoc_string(result, "type", "string");
            add_assoc_str(result, "value", quoted); break;
        }
        case IS_LONG:
            add_assoc_string(result, "type", "int");
            add_assoc_str(result, "value", zend_long_to_str(Z_LVAL_P(value))); break;
        case IS_DOUBLE:
            add_assoc_string(result, "type", "float");
            add_assoc_str(result, "value", zend_double_to_str(Z_DVAL_P(value))); break;
        case IS_TRUE: case IS_FALSE:
            add_assoc_string(result, "type", "bool");
            add_assoc_string(result, "value", Z_TYPE_P(value) == IS_TRUE ? "true" : "false"); break;
        case IS_NULL:
            add_assoc_string(result, "type", "null"); add_assoc_string(result, "value", "null"); break;
        case IS_RESOURCE:
            add_assoc_string(result, "type", "resource"); add_assoc_string(result, "value", "Resource"); break;
        default:
            add_assoc_string(result, "type", "uninitialized"); add_assoc_string(result, "value", "<uninitialized>");
    }
    add_assoc_long(result, "variablesReference", reference);
}

static void jec_json(zval *return_value, zval *value)
{
    smart_str json = {0};
    php_json_encode(&json, value, PHP_JSON_INVALID_UTF8_SUBSTITUTE);
    smart_str_0(&json);
    if (json.s) RETVAL_STR(json.s); else RETVAL_STRING("null");
    zval_ptr_dtor(value);
}

PHP_FUNCTION(jec_debug_describe)
{
    jec_inspection_output = true;
    zval *value, result;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_ZVAL(value) ZEND_PARSE_PARAMETERS_END();
    jec_describe(&result, "", 0, value);
    jec_json(return_value, &result);
}

PHP_FUNCTION(jec_debug_scope)
{
    jec_inspection_output = true;
    bool global;
    zval value, result;
    ZEND_PARSE_PARAMETERS_START(1, 1) Z_PARAM_BOOL(global) ZEND_PARSE_PARAMETERS_END();
    if (global) {
        ZVAL_ARR(&value, zend_array_dup(&EG(symbol_table)));
    } else {
        zend_execute_data *frame = execute_data->prev_execute_data;
        while (frame && (!frame->func || frame->func->type != ZEND_USER_FUNCTION)) frame = frame->prev_execute_data;
        if (!frame) { array_init(&value); }
        else {
            zend_execute_data *original = EG(current_execute_data);
            EG(current_execute_data) = frame;
            ZVAL_ARR(&value, zend_array_dup(zend_rebuild_symbol_table()));
            EG(current_execute_data) = original;
            if (Z_TYPE(frame->This) == IS_OBJECT) { zval object; ZVAL_COPY(&object, &frame->This); zend_hash_str_update(Z_ARRVAL(value), "this", 4, &object); }
        }
    }
    jec_describe(&result, "", 0, &value);
    zval_ptr_dtor(&value);
    jec_json(return_value, &result);
}

PHP_FUNCTION(jec_debug_variables)
{
    jec_inspection_output = true;
    zend_long handle, start, count;
    zval result;
    ZEND_PARSE_PARAMETERS_START(3, 3) Z_PARAM_LONG(handle) Z_PARAM_LONG(start) Z_PARAM_LONG(count) ZEND_PARSE_PARAMETERS_END();
    zval *value = jec_values_initialized ? zend_hash_index_find(&jec_values, handle) : NULL;
    if (!value) { zend_throw_error(NULL, "The PHP variable reference expired."); RETURN_THROWS(); }
    if (start < 0 || count < 1 || count > 1000) { zend_throw_error(NULL, "Invalid PHP variable page."); RETURN_THROWS(); }
    ZVAL_DEREF(value);
    /* Read stored properties directly: inspecting protected/private fields must
     * never invoke application __get(), __debugInfo() or property hooks. */
    HashTable *properties = Z_TYPE_P(value) == IS_ARRAY ? Z_ARRVAL_P(value) : zend_std_get_properties(Z_OBJ_P(value));
    array_init(&result);
    zend_ulong index; zend_string *key; zval *entry; zend_long position = 0, added = 0;
    ZEND_HASH_FOREACH_KEY_VAL(properties, index, key, entry) {
        if (position++ < start) continue;
        if (added++ >= count) break;
        zend_string *name;
        if (key && ZSTR_LEN(key) && ZSTR_VAL(key)[0] == '\0') {
            const char *class_name, *property_name; size_t property_length;
            if (zend_unmangle_property_name_ex(key, &class_name, &property_name, &property_length) == SUCCESS)
                name = strpprintf(0, "%.*s (%s)", (int) property_length, property_name, *class_name == '*' ? "protected" : class_name);
            else name = zend_string_copy(key);
        } else name = key ? zend_string_copy(key) : zend_long_to_str((zend_long) index);
        zval descriptor;
        jec_describe(&descriptor, ZSTR_VAL(name), ZSTR_LEN(name), entry);
        zend_string_release(name);
        add_next_index_zval(&result, &descriptor);
    } ZEND_HASH_FOREACH_END();
    jec_json(return_value, &result);
}

PHP_FUNCTION(jec_debug_clear)
{
    jec_inspection_output = true;
    ZEND_PARSE_PARAMETERS_NONE();
    if (jec_values_initialized) zend_hash_clean(&jec_values);
    jec_step_over_frame = NULL;
    jec_step_out_frame = NULL;
    RETURN_NULL();
}

static PHP_RSHUTDOWN_FUNCTION(jec_phpdbg_http)
{
    if (jec_values_initialized) { zend_hash_destroy(&jec_values); jec_values_initialized = false; }
    return SUCCESS;
}

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_jec_debug_step_out, 0, 0, _IS_BOOL, 0)
ZEND_END_ARG_INFO()
ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_jec_debug_describe, 0, 1, IS_STRING, 0)
    ZEND_ARG_INFO(0, value)
ZEND_END_ARG_INFO()
ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_jec_debug_scope, 0, 1, IS_STRING, 0)
    ZEND_ARG_TYPE_INFO(0, global, _IS_BOOL, 0)
ZEND_END_ARG_INFO()
ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_jec_debug_variables, 0, 3, IS_STRING, 0)
    ZEND_ARG_TYPE_INFO(0, handle, IS_LONG, 0)
    ZEND_ARG_TYPE_INFO(0, start, IS_LONG, 0)
    ZEND_ARG_TYPE_INFO(0, count, IS_LONG, 0)
ZEND_END_ARG_INFO()
ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_jec_debug_clear, 0, 0, IS_VOID, 0)
ZEND_END_ARG_INFO()
static const zend_function_entry jec_functions[] = {
    PHP_FE(jec_debug_step_out, arginfo_jec_debug_step_out)
    PHP_FE(jec_debug_step_over, arginfo_jec_debug_step_out)
    PHP_FE(jec_debug_describe, arginfo_jec_debug_describe)
    PHP_FE(jec_debug_scope, arginfo_jec_debug_scope)
    PHP_FE(jec_debug_variables, arginfo_jec_debug_variables)
    PHP_FE(jec_debug_clear, arginfo_jec_debug_clear)
    PHP_FE_END
};

static PHP_MINIT_FUNCTION(jec_phpdbg_http)
{
    const char *enabled;
    char *end;
    unsigned long length;
    const char *length_text;
    if (jec_initialize_environment() != SUCCESS) return FAILURE;
    enabled = getenv("JEC_HTTP_REQUEST");
    if (strcmp(sapi_module.name, "phpdbg") != 0 || !enabled || strcmp(enabled, "1") != 0) {
        php_error_docref(NULL, E_WARNING, "JoomEngine's HTTP debugger bridge requires an explicitly configured phpdbg request (SAPI=%s, enabled=%s).", sapi_module.name, enabled ? enabled : "missing");
        return FAILURE;
    }
    jec_method = jec_environment_copy("REQUEST_METHOD", "GET");
    jec_query = jec_environment_copy("QUERY_STRING", "");
    jec_uri = jec_environment_copy("REQUEST_URI", "/");
    jec_filename = jec_environment_copy("SCRIPT_FILENAME", "");
    jec_type = jec_environment_copy("CONTENT_TYPE", "");
    jec_cookies = jec_environment_copy("HTTP_COOKIE", "");
    if (!jec_method || !jec_query || !jec_uri || !jec_filename || !jec_type || !jec_cookies) return FAILURE;
    length_text = getenv("CONTENT_LENGTH");
    length = strtoul(length_text ? length_text : "0", &end, 10);
    if (*end || length > JEC_RESPONSE_LIMIT) {
        jec_record_failure("Invalid PHP debug request body length.");
        return FAILURE;
    }
    jec_input = fopen(JEC_INPUT_PATH, "rb");
    jec_output = fopen(JEC_OUTPUT_PATH, "wb");
    if (!jec_input || !jec_output) {
        jec_record_failure("Could not open the PHP debug request or response stream.");
        return FAILURE;
    }
    jec_original_sapi = sapi_module;
    sapi_module.activate = jec_activate;
    sapi_module.read_post = jec_read_post;
    sapi_module.read_cookies = jec_read_cookies;
    sapi_module.header_handler = jec_header_handler;
    sapi_module.send_headers = jec_send_headers;
    sapi_module.register_server_variables = jec_register_variables;
    sapi_module.ub_write = jec_write_response;
    SG(server_context) = &jec_active;
    SG(request_info).request_method = jec_method;
    SG(request_info).query_string = jec_query;
    SG(request_info).request_uri = jec_uri;
    SG(request_info).path_translated = jec_filename;
    SG(request_info).content_type = *jec_type ? jec_type : NULL;
    SG(request_info).content_length = length;
    SG(request_info).no_headers = 0;
    SG(sapi_headers).http_response_code = 200;
    jec_install_inspection_resume(&jec_inspection_output);
    for (size_t index = 0; index < sizeof(jec_opcodes); index++) {
        unsigned char opcode = jec_opcodes[index];
        jec_original_handlers[opcode] = zend_get_user_opcode_handler(opcode);
        if (zend_set_user_opcode_handler(opcode, jec_statement) != SUCCESS) {
            jec_record_failure("Could not install PHP debugger pause/stop polling.");
            sapi_module = jec_original_sapi;
            return FAILURE;
        }
    }
    jec_original_execute = zend_execute_ex;
    zend_execute_ex = jec_execute;
    jec_original_error = zend_error_cb;
    zend_error_cb = jec_error;
    jec_output_length = 0;
    jec_stmt_count = 0;
    jec_next_yield = 0;
    jec_active = true;
    return SUCCESS;
}

static PHP_MSHUTDOWN_FUNCTION(jec_phpdbg_http)
{
    if (jec_active) {
        for (size_t index = 0; index < sizeof(jec_opcodes); index++) {
            unsigned char opcode = jec_opcodes[index];
            zend_set_user_opcode_handler(opcode, jec_original_handlers[opcode]);
        }
        zend_execute_ex = jec_original_execute;
        zend_error_cb = jec_original_error;
        sapi_module = jec_original_sapi;
    }
    if (jec_input) fclose(jec_input);
    if (jec_output) fclose(jec_output);
    jec_input = jec_output = NULL;
    free(jec_method); free(jec_query); free(jec_uri); free(jec_filename); free(jec_type); free(jec_cookies);
    jec_active = false;
    return SUCCESS;
}

zend_module_entry jec_phpdbg_http_module_entry = {
    STANDARD_MODULE_HEADER,
    "jec_phpdbg_http",
    jec_functions,
    PHP_MINIT(jec_phpdbg_http),
    PHP_MSHUTDOWN(jec_phpdbg_http),
    NULL,
    PHP_RSHUTDOWN(jec_phpdbg_http),
    NULL,
    "1.0.0",
    STANDARD_MODULE_PROPERTIES
};

#ifdef COMPILE_DL_JEC_PHPDBG_HTTP
ZEND_GET_MODULE(jec_phpdbg_http)
#endif
