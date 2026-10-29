/* SPDX-License-Identifier: Apache-2.0
 * Native PHP HTTP stream metadata around the browser's existing cURL transport.
 */
#include "php.h"
#include "main/php_streams.h"
#include "main/php_memory_streams.h"
#include "ext/standard/basic_functions.h"

static php_stream *rocket_http_open(php_stream_wrapper *wrapper, const char *path,
    const char *mode, int options, zend_string **opened_path,
    php_stream_context *context STREAMS_DC)
{
    zval callable, result, args[5], headers;
    php_stream *stream = NULL;
    zval *body, *returned_headers, *error;

#if PHP_VERSION_ID >= 80400
    zval_ptr_dtor(&BG(last_http_headers));
    ZVAL_UNDEF(&BG(last_http_headers));
#endif
    ZVAL_STRING(&callable, "JoomEngine\\Rocket\\httpOpen");
    ZVAL_STRING(&args[0], path);
    ZVAL_STRING(&args[1], mode);
    ZVAL_LONG(&args[2], options);
    if (context && Z_TYPE(context->options) == IS_ARRAY) {
        ZVAL_COPY(&args[3], &context->options);
    } else {
        array_init(&args[3]);
    }
    ZVAL_BOOL(&args[4], (options & STREAM_ONLY_GET_HEADERS) != 0);
    ZVAL_UNDEF(&result);
    ZVAL_UNDEF(&headers);
    zend_result called = call_user_function(EG(function_table), NULL, &callable, &result, 5, args);
    zval_ptr_dtor(&callable);
    for (int i = 0; i < 5; i++) zval_ptr_dtor(&args[i]);
    if (called != SUCCESS || EG(exception) || Z_TYPE(result) != IS_ARRAY) {
        if (!Z_ISUNDEF(result)) zval_ptr_dtor(&result);
        if (!EG(exception)) php_stream_wrapper_log_error(wrapper, options, "Browser HTTP transport did not return a response");
        return NULL;
    }
    returned_headers = zend_hash_str_find(Z_ARRVAL(result), "headers", sizeof("headers") - 1);
    body = zend_hash_str_find(Z_ARRVAL(result), "body", sizeof("body") - 1);
    error = zend_hash_str_find(Z_ARRVAL(result), "error", sizeof("error") - 1);
    if (returned_headers && Z_TYPE_P(returned_headers) == IS_ARRAY) {
        ZVAL_COPY(&headers, returned_headers);
    }
    if (body && Z_TYPE_P(body) == IS_STRING) {
        stream = php_stream_memory_open(TEMP_STREAM_READONLY, Z_STR_P(body));
        if (stream) {
            if (!Z_ISUNDEF(headers)) ZVAL_COPY(&stream->wrapperdata, &headers);
            if (context) php_stream_context_set(stream, context);
            if (opened_path) *opened_path = zend_string_init(path, strlen(path), 0);
        }
    } else if (error && Z_TYPE_P(error) == IS_STRING) {
        php_stream_wrapper_log_error(wrapper, options, "%s", Z_STRVAL_P(error));
    }
    if (!Z_ISUNDEF(headers)) {
#if PHP_VERSION_ID >= 80400
        ZVAL_COPY(&BG(last_http_headers), &headers);
#endif
        /* PHP's HTTP wrapper publishes these in the caller's scope, even on 4xx. */
        if (FAILURE == zend_set_local_var_str("http_response_header", sizeof("http_response_header") - 1, &headers, 0)) {
            zval_ptr_dtor(&headers);
        }
    }
    zval_ptr_dtor(&result);
    return stream;
}

static int rocket_http_stat(php_stream_wrapper *wrapper, php_stream *stream, php_stream_statbuf *stat)
{
    /* HTTP does not expose the virtual response buffer as a filesystem file. */
    return -1;
}

static const php_stream_wrapper_ops rocket_http_ops = {
    rocket_http_open, NULL, rocket_http_stat, NULL, NULL, "http",
    NULL, NULL, NULL, NULL, NULL
};

static php_stream_wrapper rocket_http_wrapper = { &rocket_http_ops, NULL, 1 };

PHP_RINIT_FUNCTION(curl_rocket_http)
{
    /* Standalone upstream cURL users retain their existing stream transport. */
    if (!PG(auto_prepend_file) || strcmp(PG(auto_prepend_file), "/internal/rocket-http.php") != 0) return SUCCESS;
    zend_string *http = zend_string_init("http", 4, 0);
    zend_string *https = zend_string_init("https", 5, 0);
    php_unregister_url_stream_wrapper_volatile(http);
    php_unregister_url_stream_wrapper_volatile(https);
    zend_result first = php_register_url_stream_wrapper_volatile(http, &rocket_http_wrapper);
    zend_result second = php_register_url_stream_wrapper_volatile(https, &rocket_http_wrapper);
    zend_string_release(http);
    zend_string_release(https);
    return first == SUCCESS && second == SUCCESS ? SUCCESS : FAILURE;
}
