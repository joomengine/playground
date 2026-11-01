# JoomEngine Code PHP debugger

The browser debugger executes a selected Joomla HTTP request in the pinned
`php-dbg-wasm` runtime. Its in-browser Debug Adapter Protocol adapter connects
breakpoints, stepping, stack frames, variables, watches and the debug console to
the VS Code workbench. It uses no debugger server or browser extension.

Choose the request method and exact site URL before starting. Background requests
that do not match continue normally. Refresh or submit the matching form to start
the selected request. Breakpoints stay unresolved until execution confirms their
source location. Conditional breakpoints evaluate a PHP expression in the frame;
hit-count breakpoints and logpoints are not supported. Explicit watch and console
evaluation can change application state.

The selected request runs once. The existing PHP owner holds the request and write
queue, copies the current filesystem to a disposable debugger worker, and forwards
database calls to the same MariaDB instance. Cookies, session files, PHP settings,
extensions, headers, query strings, request bodies and multipart uploads travel
with that request. Before its HTTP response is released, the owner applies the
filesystem delta, updates cookies and flushes persistence. The debugger never
opens the owner's browser filesystem store itself.

Continue returns the real status, headers and response body to the pending
preview request. While paused, editing remains available in buffers and source
writes wait in the owner queue. Control messages bypass that queue. Intentional
pauses suspend normal HTTP and service-worker heartbeat deadlines. Stop is
cooperative through native opcode hooks; the owner terminates an unresponsive
debugger worker after ten seconds. A forced termination keeps the last confirmed
filesystem. Completed database writes remain; stopped POST requests are never
replayed automatically.

Source reads also remain available during a pause. A bounded read lane uses the
paused debugger's actual filesystem and the normal workspace confinement,
canonical-path and revision checks. This includes source files created by PHP
before the pause. Newly opened callee files retain their normal editor identity;
clean models revalidate and dirty buffers keep their content and original save
revision. Read operations cannot mutate the debug filesystem. Save All retains
its position in the owner's write queue until the request finishes.

## Native bridge and reproducible builds

`native/phpdbg/jec_phpdbg_http.c` is an Apache-2.0 PHP extension loaded only in
explicitly configured disposable phpdbg instances. It supplies PHP's native SAPI
callbacks for environment registration, POST input, cookies, headers and response
output. PHP itself parses superglobals, multipart files and session data. Debug
console output stays separate from the HTTP response.

The extension also yields to worker control messages during statement and loop
opcodes, preserves application shutdown callbacks after a single run, reports
PHP errors with source locations, and implements caller-aware Step Over and
Step Out. Unlike upstream phpdbg's `next`, Step Over stays in the caller across
nested calls while honoring breakpoints inside callees. Its access to phpdbg globals uses the upstream exported
`php_wasm_get_bpcount` address and the exact pinned PHP header offset. No guessed
memory layout is used. A hash-verified build overlay supplies the released web
JavaScript package's complete Emscripten worker loading and optional DOM handling.
The WebAssembly binary is unchanged; no fabricated DOM is used.

Variable inspection uses native bounded handles and Zend property tables. It
does not invoke application getters, `__debugInfo`, or recursively print large
objects. Private and protected property names remain visible; pages contain at
most 1,000 entries and displayed strings are limited to 4 KiB. Continuing releases
the handles before execution resumes.

The selected JoomEngine int64 release supplies PHP source commits, configured
SDK headers and the Emscripten compiler identity for each supported PHP minor.
After `npm run prepare:php`, use that matching compiler as described in the main
README, then run:

```sh
node scripts/phpdbg-build.mjs 8.4
```

Repeat for each supported PHP minor. The source cache is reconstructed from the
release's exact PHP commit and patches. The script checks the release fingerprint,
PHP version, wasm32/int64 SDK and compiler version before compilation. Its output
includes the extension, license and provenance hashes. The normal build rejects
artifacts whose source, build script, runtime pin or license differs.

## Checks

`test/code-debug-http.integration.mjs` executes the real phpdbg WebAssembly binary
for every supported PHP minor and checks POST data, raw input, cookies, response
headers, object and caller-frame inspection, expression errors and exactly-once
filesystem effects. `test/code-debug-controls.integration.mjs` additionally checks
step into/over/out, nested-call Step Over and callee breakpoints, conditional breakpoints, recursive value paging, active pause
and stop, HTTP 500 error locations, binary multipart uploads, existing session
data, shutdown writes and cancellation before execution.

```sh
node --test test/code-debug-http.integration.mjs test/code-debug-controls.integration.mjs
PLAYGROUND_DIST=dist node --test test/code-debug-joomla.browser.mjs
```

The browser contract uses a provisioned persistent Joomla administrator session,
the normal service-worker route and the site's real PHP owner. It inspects the
administrator application object and caller, steps and continues, instruments the
real dispatch path to prove POST database/filesystem side effects happen once,
checks queued source writes, stops an executing POST and verifies the next normal
authenticated page still works. On the default PHP version it also opens the
actual workbench, sets a gutter breakpoint with F9, starts Debug and Refresh,
checks the native call stack, current-line marker and expanded application
properties, then uses the native Step Over and Continue toolbar buttons to
complete the real Joomla response. It steps into an unopened callee file, edits
both source buffers while paused, queues Save All, steps back to the original
dirty model and verifies both files save after the HTTP response. Browser selection uses
`PLAYGROUND_BROWSERS`; PHP selection uses `PLAYGROUND_PHP_VERSIONS`.
Without a PHP selector the browser contract covers every supported PHP minor.
