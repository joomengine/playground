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
static const unsigned char jec_opcodes[] = { ZEND_EXT_STMT, ZEND_JMP, ZEND_JMPZ, ZEND_JMPNZ, ZEND_JMPZ_EX, ZEND_JMPNZ_EX };
static void (*jec_original_execute)(zend_execute_data *);
static unsigned jec_stmt_count;
static double jec_next_yield;
static bool jec_active;

/* The worker sets this field directly; these messages never queue behind PHP. */
EM_ASYNC_JS(int, jec_yield_control, (void), {
    await new Promise(resolve => setTimeout(resolve, 0));
    const command = Module.jecDebugControl || 0;
    Module.jecDebugControl = 0;
    return command;
});

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
    if (!jec_input) return 0;
    return fread(buffer, 1, count, jec_input);
}

static char *jec_read_cookies(void)
{
    return jec_cookies;
}

static int jec_activate(void)
{
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
    } zend_catch {
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
    if (PHPDBG_G(flags) & PHPDBG_IN_EVAL) {
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
    NULL,
    PHP_MINIT(jec_phpdbg_http),
    PHP_MSHUTDOWN(jec_phpdbg_http),
    NULL,
    NULL,
    NULL,
    "1.0.0",
    STANDARD_MODULE_PROPERTIES
};

#ifdef COMPILE_DL_JEC_PHPDBG_HTTP
ZEND_GET_MODULE(jec_phpdbg_http)
#endif
