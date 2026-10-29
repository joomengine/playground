# JoomEngine Code AI integration

This is the implementation record for the optional AI workstream in the [complete scope](joomengine-code-scope.md). It does not declare the initial AI milestone complete. The provider adapter, bounded context tools, reviewed change sets and isolated panel are implemented; real provider verification and the final workbench integration evidence remain required.

## Interfaces

`src/code/ai-provider.mjs` provides `createChatProvider({baseURL, model, apiKey})`. Its `stream({messages, tools, signal, onDelta})` method parses bounded OpenAI-compatible SSE responses, assembles complete function-call arguments and returns an assistant message. Incomplete streams never execute partial tools. Cancellation aborts the fetch, redirect following is disabled, cookies are omitted and provider error bodies are not forwarded. `dispose()` aborts pending requests and clears the retained key.

`src/code/ai-review.mjs` provides two services:

- `createAiReview({workspace, isDirty, onApplied})` prepares reviewed sets without writing. `accept(id)` sends one `batch` operation with worker-checked file and directory-tree revisions; `reject(id)` writes nothing. `undo(id)` calls the shared worker recovery service. Dirty buffers are checked immediately before apply and recovery. Partial failures report the exact completed and failed operations; a resolved set cannot be blindly replayed.
- `createAiWorkspaceTools({workspace, review, selectedPaths})` exposes `list_files`, `read_file`, `search_files` and `propose_changes`. The model has no apply, shell, PHP execution or credential-setting tool. `context({selection, openFiles, signal})` accepts paths or open-document descriptors `{path, content, unsaved}`, includes deliberately selected files, and filters automatic context. Sensitive paths and common embedded credential patterns require deliberate file selection. Reads, search, context and review sizes are bounded; search accepts cancellation.

`workspace.request(operation, args)` is the same authoritative root-confined bridge used by the editor, with slash-prefixed workspace paths. It must serialize `batch` and `recover` with normal PHP requests. `isDirty(path, recursive)` must inspect the authoritative editor models, including descendants for directory operations. `onApplied(result)` receives one result for a successful or partial batch; it must use the normal saved-change/refresh workflow and must not bypass manual refresh.

`src/code/ai-panel.mjs` provides `createIsolatedAiPanel({container, tools, review, getContext})`. Use `tools.context` inside `getContext`; do not assemble an unrestricted Joomla installation dump. The returned `dispose()` method disconnects the panel and clears the isolated credential context. Move the existing panel between layouts where possible, and dispose it when its site ends. The host must not create duplicate AI sessions for a detached editor.

## Credential boundary

The existing Joomla preview is same-origin and is not a security sandbox. Consequently, the key, model, provider URL, prompt entry and provider fetch run inside an iframe with **only** `sandbox="allow-scripts"`. The iframe has an opaque origin, no same-origin DOM/storage access, no forms, no popups, and a restrictive CSP. Its provider and panel code are embedded under a nonce, so it needs no external scripts or opaque-origin module imports. The provider must accept CORS requests from the opaque origin (`Origin: null`).

The host validates the exact frame window, opaque origin and one-time nonce before transferring a `MessagePort`. The sandbox validates the parent origin and window. The port carries bounded context/read requests, proposed changes and explicit review actions. It never carries the API key, a credential export, or a host request to issue an authenticated provider call. Only user interaction inside the isolated panel starts provider requests. Disposal cancels reads and provider requests; explicit file mutations already accepted by the user retain the worker's normal completion/recovery semantics.

This isolates credential memory from Joomla script access. It does **not** make the same-origin host page immune to DOM replacement or phishing by a malicious Joomla extension: such code can alter the surrounding host UI. A separate trusted editor origin or a separately isolated Joomla preview is needed to address that broader host-integrity threat. Do not describe the entire Playground as a hostile-code security sandbox.

No key is written to project files, persistent browser storage, deployment URLs, export metadata, logs, snapshots or the message channel. The UI clears it explicitly and on session teardown. Browser or provider failures remain local to the AI feature.

## Provider verification status

OpenRouter is included as a **documentation-backed candidate requiring verification**, not as a verified preset. Its documented API supports the OpenAI-compatible chat-completions format, streaming tool-call deltas and stream cancellation. Server-side cancellation/billing behavior depends on the routed provider; aborting a browser fetch does not establish a billing guarantee.

Completion still requires a user-supplied test key and a tool-capable model to verify, from the actual isolated browser context:

1. Successful authentication and opaque-origin CORS preflight.
2. Incremental streamed text and complete tool-call arguments.
3. A root-confined context read and a reviewed, explicitly accepted change.
4. Aborted streaming, provider error handling and continued local editing.
5. The advertised provider/model selection in Chromium and Firefox.

No key is available in this development environment, so that authenticated check has not been performed. Custom base URLs remain labeled unverified. The PR's verified-provider requirement must stay unchecked until evidence is recorded. Do not remove that requirement or relabel deterministic mock checks as live verification.

Primary references:

- [OpenRouter chat-completions endpoint](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [OpenRouter streaming and cancellation](https://github.com/OpenRouterTeam/docs/blob/main/api_reference/streaming.mdx)
- [OpenRouter tool-call behavior](https://openrouter.ai/blog/tutorials/tool-calling/)

## Focused checks

`node --test test/code-ai.test.mjs` verifies fragmented UTF-8 SSE and tool calls, cancellation, endpoint/request limits, key-safe errors, read-only preparation/rejection, batch apply/recovery, disk/dirty-buffer/folder membership conflicts, partial failure without replay, and sensitive context exclusion.

`node --test test/code-ai-browser.mjs` verifies the isolated UI with a deterministic provider in Chromium and Firefox. It uses the repository test server with COOP `same-origin`, COEP `credentialless` and CORP `same-origin`. The scenario checks `Origin: null`, inaccessible credential DOM, no key in host messages, no writes before acceptance, explicit acceptance/recovery, clearing and disposal. This is a sandbox/protocol check, not a real provider connectivity test or an end-to-end Joomla/IDE test.

The Chromium scenario passed locally using an installed headless-shell executable. Regular Chromium and Firefox could not start in the execution environment because of restricted process/socket permissions. Firefox verification remains outstanding; normal CI can use its installed Playwright browsers. The optional `PLAYGROUND_BROWSERS` and `PLAYGROUND_CHROMIUM_EXECUTABLE` / `PLAYGROUND_FIREFOX_EXECUTABLE` variables select browsers and local executable paths without changing production behavior.
