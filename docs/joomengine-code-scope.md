JoomEngine Code brings a complete browser development workspace into [JoomEngine Playground](https://github.com/joomengine/playground): manage the Joomla filesystem, edit multiple files, use AI to make reviewed changes, refresh the running site when ready, and debug real PHP requests.

The implementation follows the KISS principle: reuse the existing runtime and proven editor components, keep responsibilities clear, and preserve the working Playground experience. **Full PHP debugging is required for completion.** The roadmap orders the work by dependency; it does not defer required functionality to an unspecified future project.

**Scope baseline:** 29 October 2026. No time estimates. All capabilities below are implementation requirements unless explicitly identified as outside scope.

# Product objective

Users open JoomEngine Code from the existing Playground, browse only the active Joomla site's files, edit and save them, and see the result in the same running site. They can keep the site visible, navigate it independently, move or detach the editor, and return to their open files without losing work.

The completed product includes the full editor and filesystem integration, every layout mode, initial AI-assisted project editing, and working PHP debugging. Editing can become usable earlier in the implementation sequence, but delivery of that part does not complete this overall scope.

The IDE and PHP debugger run in the browser without a new application server or a browser extension. Hosted AI uses the user's chosen supported provider and credentials. JavaScript debugging remains with the browser's existing developer tools.

# Name and visual identity

| Surface | Required wording |
| - | - |
| Product name in normal text | JoomEngine Code |
| Main logo and wordmark | JOOMENGINE CODE |
| Compact labels and internal shorthand | JEC, only where space or context warrants it |
| Launcher and accessible name | Open JoomEngine Code |

Extend the existing [JoomEngine logo](https://github.com/joomengine/playground/blob/main/src/brand/joomengine-logo.webp) and project styling. Preserve its typography, proportions, colours and gold treatment; incorporate CODE as part of the same identity. Add a restrained gold glare to the C and/or O where it remains legible at the intended size. Produce reusable vector artwork and suitable small and large variants, including light and dark backgrounds.

Apply the identity consistently to the launcher, editor title, detached-window title, welcome view, overlays, commands, settings, notifications and About information. Use the full product name in tooltips and accessible labels even when a compact icon or abbreviation is shown.

Extend the existing About and third-party recognition listing with the actual bundled technologies: Microsoft VS Code and Monaco, CodinGame, PHP and phpdbg, Sean Morris's PHP-WASM, Emscripten, and added language services, grammars, themes and dependencies. Retain existing credits and required distribution notices. Record the licences of the exact shipped components; About recognition accompanies those obligations.

# Technical foundation

Use the CodinGame Monaco VS Code integration with the browser workbench and the services needed for explorer, editor groups, text models, search, settings, language contributions, diffs and debugging. Use `@codingame/monaco-vscode-files-service-override` to connect the workspace to Joomla. Select a compatible set of pinned packages and use a wrapper only where it removes integration work.

Keep four clear responsibilities:

| Responsibility | Implementation role |
| - | - |
| Playground session | Owns the active PHP runtime, database, persistence and preview |
| Filesystem bridge | Provides root-confined file operations to the editor and AI |
| Editor session | Preserves documents, unsaved buffers, undo state, layout preferences and breakpoints |
| JoomEngine Code views | Present the workbench in docked, floating, maximized or detached form |

Expose the active document root, currently `/persist/www`, as the workspace root. Translate editor URIs through one adapter rather than spreading runtime paths through UI code. Enforce the boundary in the authoritative worker operations, including canonical paths, traversal, symlinks and mutation targets. Runtime configuration, other sites and host files stay outside that workspace.

Extend the existing worker bridge for missing file operations and change notifications. Reuse the current filesystem, database ownership, persistence and recovery mechanisms. Do not create a second site for an editor window or a separate AI copy of the project.

Initialize workbench services in a controlled lifetime and load the editor only when opened. Keep the integration in focused modules following the repository's conventions. Avoid a broad rewrite of the existing app, a custom editor framework or an unnecessary fork of VS Code. Any required upstream patch must be small, documented and reproducible.

# Files and editing

Provide the complete file and folder workflow:

- Browse and expand folders, display file types, refresh listings and reveal an open file.

- Create files and folders; upload existing files; replace files with explicit overwrite handling; download files.

- Open, edit, save and Save All; rename, move, copy and delete files and folder trees.

- Handle missing files, naming collisions, failed writes, read-only states, large files and external changes clearly.

- Prevent deletion or movement of the workspace root and reject every operation outside it.

Load folder children on demand and keep search cancellable. Do not eagerly read the entire Joomla installation into editor models. Workspace search and replace must respect the same filesystem boundary and show affected files before replacing across the project.

Provide multiple tabs, editor groups, split editing, dirty indicators, undo and redo, keyboard shortcuts, find and replace, quick file opening and the command palette. Preserve buffers, selections, cursor and scroll positions, tab order and undo history when the editor moves, detaches, redocks or is hidden and reopened.

Closing a file with unsaved changes offers save, discard or cancel. Hiding the editor preserves its open documents. Renames and moves update open document identities; deletes account for dirty buffers. Detect Joomla or another view changing a file and offer a diff/reload/overwrite choice rather than silently losing either version.

Keep manual save as the initial setting; autosave is independently configurable. Preserve supported encodings and line endings. When decoding is unsupported, show that clearly and preserve the original bytes rather than saving corrupted text. Maintain a bounded recovery history for destructive operations and accepted AI change sets, scoped to the active site and cleared with that site.

| File group | Required treatment |
| - | - |
| PHP and mixed PHP/HTML | Language-aware editing, bracket and indentation support; integrate browser-compatible completion, navigation and diagnostics |
| JavaScript, TypeScript, HTML and CSS | Appropriate language services, highlighting, completion and diagnostics |
| SCSS, LESS, XML, INI, JSON, YAML, SQL, Markdown and shell text | Appropriate language identification and grammars; formatting and diagnostics where supported by the bundled tooling |
| Unknown text formats | Editable plain-text fallback and manual language selection |
| Images and other binary files | Suitable previews where supported, plus upload, download, rename, move, delete and replacement |

Bundle a focused set of free, licence-compatible browser extensions and language services. Match PHP tooling to the selected runtime and index Joomla code without blocking the interface. State supported language features accurately. Being editable does not imply that a file is executable, compiled or debuggable by Playground.

# Layout and session continuity

| Mode | Required behaviour |
| - | - |
| Left dock | Editor on the left, site on the right, with a draggable divider |
| Right dock | Editor on the right, site on the left, with a draggable divider |
| Bottom dock | Editor below the site, with adjustable height |
| Full workspace | Editor fills the available Playground area; the site runtime continues |
| Floating panel | Draggable, resizable modeless editor inside the page; visible site areas remain interactive |
| Detached window | A browser-managed editor window connected to the same active site |

Provide clear dock, detach, maximize, restore and close controls. Remember the user's layout and dimensions, impose sensible minimum sizes and keep controls reachable after a viewport change. Reuse native workbench layouts and editor groups wherever possible.

A floating panel remains inside the page. Detachment uses a real browser window so the editor can move to another monitor. Browser chrome and placement remain browser-controlled; if a popup is blocked, keep the editor docked and show an actionable message.

Use one authoritative editor session and one site owner. Prefer relocating the existing workbench where supported; otherwise transfer its state through a narrow view bridge. Do not allow two independent document models to overwrite each other. Closing the detached window restores the editor to the host with its state intact. Validate messaging against the expected window and origin.

The Playground owner tab remains responsible for the running site. Make that relationship clear when detached; closing the owner must not silently discard editor drafts or leave an apparently usable disconnected editor. Recover drafts for persisted sites on reopen, and stop or close detached views cleanly when their site ends. Independent runtime ownership transfer is not required for editor detachment.

Support the project's desktop Firefox and Chromium experience, accessible keyboard navigation, visible focus and readable contrast. Keep smaller viewports usable through sensible layout collapse; introduce no new device restrictions to the existing site view.

# Saving and preview refresh

**Manual refresh is the default.** Saving changes the site's filesystem; refreshing changes the currently displayed page.

| Action | Required result |
| - | - |
| Save or Save All | Write the requested files successfully; do not refresh in manual mode |
| Undo or redo | Change the editor buffer; write only through save or enabled autosave |
| Refresh site | Wait for in-flight saves, then reload the current preview URL |
| Optional automatic refresh | Refresh once after a completed save batch, with a short debounce for nearby saves |
| PHP debugging pause | Suppress automatic refresh and keep the paused request under debugger control |

Provide Refresh site in the editor toolbar and in the Playground toolbar while JoomEngine Code is enabled, including when detached. Show a modest “Saved changes since last refresh” indicator. Keep unsaved-buffer status distinct from saved changes.

Refresh must preserve editor state, the active PHP engine, the database and site identity. Normal source changes do not require restarting WebAssembly or reinstalling Joomla. Reload only the preview, preserving the current location; the user navigates to the area affected by their changes. Refresh does not silently save unsaved buffers.

Manual refresh is not a staging mechanism. Navigation, AJAX and subsequent requests may use files as soon as they are saved. PHP already executing does not become a new execution merely because its source changes. Make these behaviours consistent and document them briefly.

Reuse the current persistence policy: persisted sites retain saved edits, and temporary sites remain temporary. Make active-file writes and durable-storage failures distinguishable. Coordinate Save All and AI changes so a queued request does not split their intended write batch; report a failure without falsely reporting that the entire batch succeeded. Use recoverable snapshots for multi-file changes rather than promising unsupported filesystem transactions.

Reuse asset revalidation, handle PHP code-cache invalidation if present, and provide an explicit Joomla cache-clear action where application caching obscures a change. Runtime restart stays separate for settings, version changes or recovery. A page refresh may reset the website's unsaved forms and temporary UI state.

# Initial AI integration

Deliver useful project editing in the initial JoomEngine Code integration, with a chat panel, provider settings and reviewed changes. Users supply an API key, select a supported model and ask for explanations, fixes or modifications across the active Joomla project.

Use one small provider interface. The first adapter supports a documented OpenAI-compatible chat and tool-calling endpoint with configurable model and base URL. Ship at least one verified browser-compatible provider preset; verify authentication, streaming, tool calls and cancellation for each advertised preset. Do not label arbitrary endpoints as supported without that verification or introduce a hidden server proxy.

The complete interaction includes:

- Context from the current selection, open files and explicitly selected project files.

- Root-confined file listing, search and reads so the assistant can locate relevant code.

- Proposed creation, modification, rename, movement and deletion of files or folders.

- Reviewable diffs and operation summaries, with accept/reject controls before mutations.

- Conflict detection against both current disk contents and unsaved editor buffers.

- Applying accepted changes through the same file service, with a recoverable change set and undo.

- Streaming progress, cancellation, useful provider errors and a clear account of applied changes.

Keep AI mutations in the normal save and refresh workflow. Applying changes saves the accepted set; manual refresh remains manual. Optional automatic refresh happens once after the set is successfully applied. If applying a set fails partway, report the exact result and offer recovery without repeating completed writes blindly.

Send only relevant context, with file and request size limits. Exclude credentials and sensitive configuration from automatic context; allow deliberate user selection when needed. Treat file contents as project data, not authority to bypass tool restrictions. Do not provide unrestricted shell execution.

Keep keys out of project files, deployment URLs, exports, logs and snapshots. Default to session-only credentials. Keep the credential-bearing AI context isolated from executable Joomla content through an appropriate browser origin/sandbox boundary; use a narrow, validated message interface. A key entered into a browser belongs to the user and remains subject to that provider's browser-access policies.

AI is optional for using the IDE. Missing credentials, provider outages or exhausted quota must leave local editing, saving, preview and PHP debugging available.

# Complete PHP debugging

Implement PHP debugging inside JoomEngine Code for the actual Joomla application. Logs, syntax checks, a debugger-shaped panel or running an isolated PHP snippet do not fulfil this requirement.

The upstream [PhpDbgWeb implementation](https://github.com/seanmorris/php-wasm/blob/master/source/PhpDbgWeb.mjs) and [browser debugger tests](https://github.com/seanmorris/php-wasm/blob/master/test/browser/browser.spec.mjs#L149) provide a starting point for browser breakpoints, variables, object values and stack inspection. Its phpdbg execution mode is separate from the CGI mode currently serving Joomla. Build the missing request integration and runtime hooks as part of this scope.

## Joomla request execution

Provide a debug session that can arm the next matching Joomla request, refresh the current page under the debugger, or wait for navigation or a form action. Use explicit matching so background requests do not accidentally consume the intended debug run.

Preserve the active PHP version and required extensions, current files, MariaDB bridge, cookies, authentication, sessions, request method and URL, query data, headers, request body and uploads. Supply correct PHP request globals and return the actual status, response headers and body to the existing preview.

Execute the selected request once. Do not run it normally and replay it afterward for debugging, which could repeat database writes or other side effects. Reuse the active execution context where practical. If a distinct phpdbg instance is required, coordinate exclusive request execution and filesystem handoff with the existing runtime owner; keep one authoritative site state.

Adapt the phpdbg SAPI or add the necessary upstream runtime hooks where required for HTTP correctness. Keep any patches maintained and reproducible. Complete the integration across the PHP versions that Playground supports; include the required debugger builds in the asset pipeline.

## Controls and inspection

Connect the engine to the VS Code debugging UI through an in-browser Debug Adapter Protocol adapter. No network debugger server is required.

Deliver file and line breakpoints with persistence, enable/disable/remove controls, conditional breakpoints and clear reporting for unresolved locations. Provide start, continue, pause, step into, step over, step out and stop, with current-line highlighting and navigation to the executing file.

Provide the call stack, frame selection, local and global variables, nested arrays and objects, property names and types, watch expressions and a debug console. Expand large or recursive values progressively. Evaluate expressions in the selected frame, surface evaluation errors without breaking the UI and make side effects of explicit evaluation clear.

Include PHP errors and exception locations with navigation to source. Map runtime paths to the same editor documents used for normal editing.

## Responsiveness and state

Debugger commands must remain responsive while PHP is paused; they cannot wait behind the blocked request queue. Suspend ordinary request timeouts during an intentional pause while retaining bounded startup, stop and failure recovery.

Keep editing responsive. During a paused request, retain new edits in buffers and visibly queue source writes until that request finishes or is stopped; do not silently make displayed source disagree with the paused execution. Do not trigger automatic refresh or silently restart a debug session on save.

Coordinate database access, file writes, other requests and persistence while debugging. Continue completes the pending request; stop terminates it cleanly, releases locks and returns the site to a usable state. Completed database writes are not automatically rolled back. Never replay a stopped POST request automatically.

PHP debugging may be implemented alongside the editor once the shared session and file interfaces exist. It remains required before this full roadmap is complete; runtime gaps are implementation work to resolve rather than a reason to omit the feature.

# Preserve the working Playground

Keep current launch, installation, deployment presets, navigation, authentication, saved and temporary sites, export/import, runtime selection and existing controls working. Preserve their defaults.

Load editor, language and debugger assets on demand and avoid adding their startup cost to users who never open JoomEngine Code. Cache compatible assets through the existing build and delivery approach. Keep search, indexing, AI and debugging work out of the main UI thread where practical, and dispose unused resources without losing session state.

An editor, language service or AI failure must not tear down the running site. Provide retry and close paths, retain drafts where possible and keep error messages actionable. Respect existing content security and browser-isolation requirements.

Keep dependencies pinned and reproducible, retain licence notices, avoid committing credentials and update the project's documentation and translated labels using its existing conventions. Hide unsupported desktop-only commands rather than presenting controls that cannot work.

# Implementation roadmap

The stages below are an implementation order, with work continuing in parallel where interfaces are established. They contain no calendar estimates and introduce no additional approval gates.

| Stage | Work and resulting capability |
| - | - |
| 1 Establish the integration | Confirm current runtime and persistence interfaces; pin the compatible CodinGame packages; define the workspace URI and session contracts; create the JoomEngine Code entry point and lazy-loaded workbench. Begin the PHP request bridge against a real Joomla route in parallel. |
| 2 Complete files and editor state | Finish root-confined file/folder operations, uploads, search, open tabs, saving, conflict handling, change notifications, recovery and persistence. Integrate the required language contributions and services. |
| 3 Complete layout and preview | Deliver left/right/bottom docks, resizing, full workspace, floating panel and detached window; preserve document state throughout. Add manual Refresh site, saved-change indication and optional batched automatic refresh. |
| 4 Complete initial AI editing | Implement provider settings and the first verified preset, context tools, streaming chat, reviewed diffs, multi-file operations, conflict handling, apply/reject, recovery and credential isolation. |
| 5 Complete PHP debugging | Finish the Joomla request integration, required runtime builds, in-browser adapter, breakpoints, stepping, inspection, watches, console, pause coordination, stop and recovery. Resolve integration defects until real Joomla requests work end to end. |
| 6 Finish branding and integration | Apply the JOOMENGINE CODE artwork and JoomEngine Code wording everywhere; update About and notices; complete accessibility, responsive layout, translations, loading/error states and concise usage documentation. This work can proceed alongside the earlier stages. |
| 7 Stabilize and deliver | Run the focused smoke suite and relevant existing checks, resolve observed regressions, verify the normal Playground experience and publish the complete implementation through the repository's normal release process. |

Use focused commits and reviewable pull requests, with working integration demonstrated as it develops. Avoid unrelated refactoring. Share the file service and editor session contracts early so layout, AI and debugger work can progress without building competing implementations.

# Focused verification

Keep the new suite small and behaviour-driven. Use a few browser smoke flows supported by targeted checks where they protect files and state:

- Open a real Joomla file, edit and save it, refresh manually and observe the change; exercise create, upload, rename and delete, plus persisted reopen.

- Keep several dirty tabs intact while docking, floating, detaching, redocking and hiding/reopening the editor.

- Confirm manual mode never reloads because of save events, and optional automatic mode reloads once per completed batch.

- Review and apply an AI change set, reject another, detect a conflicting file and recover an accepted change.

- Debug an authenticated Joomla request, inspect an object and caller frame, step and continue to a valid response; include one POST case and a stop/recovery check.

- Retain concise checks for root confinement and failed-save recovery.

Use deterministic provider responses for routine CI and verify real provider connectivity separately without embedding keys. Run the relevant existing build and regression checks; do not remove existing safeguards to obtain a passing result. Exercise Firefox and Chromium without multiplying every scenario across an exhaustive matrix.

Tests run during development and CI, not on user saves. Add regression coverage when real defects expose missing cases. Keep verification proportional to the change.

# Completion and boundaries

The project is complete when users can manage the Joomla filesystem, edit the supported text formats in persistent tabs, use every layout, apply reviewed AI changes, refresh the current site manually by default, and debug real PHP requests with stepping and state inspection. Branding, recognition, recovery, documentation and the focused checks are part of that result.

The editor and debugger require no new application server. Hosted AI still requires a supported external provider. Saved files affect subsequent requests even before a manual preview refresh. Detached windows depend on the owner session and browser window rules.

This scope excludes a native JavaScript debugger, arbitrary desktop VS Code extensions, a host operating-system terminal, general-purpose build infrastructure and multi-user collaborative editing. Those capabilities are not needed to deliver the agreed Joomla development workflow.

# Implementation references

- [JoomEngine Playground source baseline](https://github.com/joomengine/playground/tree/4d9847759fb404fec5081b512dd0b133b6097a43) and [existing branding asset](https://github.com/joomengine/playground/blob/4d9847759fb404fec5081b512dd0b133b6097a43/src/brand/joomengine-logo.webp).

- [Playground session and filesystem interface](https://github.com/joomengine/playground/blob/4d9847759fb404fec5081b512dd0b133b6097a43/src/playground.mjs), [PHP worker](https://github.com/joomengine/playground/blob/4d9847759fb404fec5081b512dd0b133b6097a43/src/php-worker.mjs) and [asset revalidation](https://github.com/joomengine/playground/blob/4d9847759fb404fec5081b512dd0b133b6097a43/src/static-assets.mjs).

- [CodinGame Monaco VS Code API](https://github.com/CodinGame/monaco-vscode-api), [custom workbench container](https://github.com/CodinGame/monaco-vscode-api/blob/main/src/workbench.ts) and [product icon override](https://github.com/CodinGame/monaco-vscode-api/blob/main/vscode-patches/0062-feat-allow-to-override-product-icon.patch).

- [PHP-WASM](https://github.com/seanmorris/php-wasm), [browser debugger](https://github.com/seanmorris/php-wasm/blob/master/source/PhpDbgWeb.mjs), [browser debugger tests](https://github.com/seanmorris/php-wasm/blob/master/test/browser/browser.spec.mjs#L149) and [CGI request implementation](https://github.com/seanmorris/php-wasm/blob/master/source/PhpCgiBase.mjs).

- [VS Code browser extension constraints](https://code.visualstudio.com/api/extension-guides/web-extensions), [debugger adapter integration](https://code.visualstudio.com/api/extension-guides/debugger-extension) and [source licence](https://github.com/microsoft/vscode/blob/main/LICENSE.txt).

- [Browser window behaviour](https://developer.mozilla.org/en-US/docs/Web/API/Window/open).
