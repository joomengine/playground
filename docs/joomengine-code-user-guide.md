# Using JoomEngine Code

JoomEngine Code opens a browser workbench beside the active Joomla site. The Playground tab continues to own PHP, MariaDB and the site files. The editor uses that same site; opening it does not install another Joomla instance.

This guide describes the current implementation. The [experience roadmap](roadmap/implementation-roadmap.md) and [AI validation record](roadmap/ai-validation.md) track its requirements and remaining verification. The earlier [checkpoints](joomengine-code-checkpoints.md) and [full scope](joomengine-code-scope.md) remain historical milestone records; evidence from those versions does not establish that every current browser/provider scenario has passed.

## Open and edit

1. Select a saved site or configure a new one, then choose **Launch**. Manual selection stages the target without stopping the running site; normal page entry also offers a cancellable startup countdown.
2. Select **JoomEngine Code**. Editor assets load when opened; select it again to hide the same session.
3. Expand the Explorer folders and open a file. The visible workspace root is the active Joomla document root, currently `/persist/www`; runtime configuration and other sites are outside the editor workspace.
4. Make changes in tabs or split editor groups. Use the workbench's Save command for the current file or **Save All** in the JoomEngine Code toolbar.
5. Select **Refresh site** when you want the displayed Joomla page to reload.

Manual saving and manual refresh are the initial behavior. A dirty tab means its buffer has unsaved changes. **Saved changes since last refresh** means files have changed but the current preview has not yet been refreshed. These are separate states.

Save writes to the active site's filesystem. It does not refresh the page in manual mode. Joomla navigation, AJAX and later requests can use saved files immediately, even before a manual refresh. A PHP request already executing does not restart because its source changed. Refresh waits for in-flight editor saves, reloads the current preview location and leaves unsaved buffers alone; it can reset unsaved website forms and temporary page state.

Use **Refresh after saving** if you want a debounced refresh after completed saves. Autosave is a separate workbench setting. Automatic refresh is suppressed while PHP is paused in the debugger.

If a file changed outside the editor, resolve the conflict before overwriting it. Read errors, unsupported contents and failed saves should remain visible rather than being treated as successful writes. A browser-storage error can occur after a file was successfully changed in the running site: keep the owner tab open, preserve the affected work and retry saving the site.

**Upload files** adds files to an existing workspace folder, with confirmation before replacing saved files. Save or discard dirty editor changes in affected files first. Limits are 32 MiB per file and 64 MiB per upload. **Download file** downloads saved bytes; save your editor buffer first if you want its changes included. **Preview image** supports PNG, JPEG, GIF and WebP. Other formats, including SVG, remain downloadable without executing their contents.

If Joomla application caching hides a change, select **Clear Joomla cache**, then refresh when ready. Clearing cache and refreshing do not restart PHP. Runtime restart stays a separate Playground action.

## Arrange the workspace

The layout selector offers left dock, right dock, bottom dock, floating panel and full workspace. Drag the dock divider to resize it. In floating mode, drag the title control to move the panel and the corner control to resize it. The controls also support arrow keys; Shift uses larger steps.

The header uses a compact **Code** identity, with actions beside the workspace selector. Action labels disappear before icons at narrow editor widths; at the smallest widths only the action group moves to a compact strip. Layout/window controls remain available.

Maximize fills the available workspace; Restore returns to the previous mode. Closing the editor panel or toggling the main **JoomEngine Code** action hides it and preserves buffers, undo history and layout. Reopen it with the same action. If the editor is detached, the main toggle redocks and hides that session; ordinary auxiliary-window Close or **Return to owner tab** redocks it visibly. The site keeps running in the owner tab.

Detach opens a browser-managed auxiliary editor window. Browser popup rules still apply; a blocked popup leaves the editor docked. The auxiliary window keeps the native editor tabs, split groups, text models and undo history, with a companion file tree, project text search, Save All, Refresh site, cache clearing, file actions and AI assistant. Its debugging controls can arm a request, refresh under the debugger, continue, pause, step and stop; controls are enabled according to the active debugging state. **Files** toggles the companion sidebar; **Return to owner tab** redocks the editors. Closing the auxiliary window also returns its tabs and groups to the original workbench.

A successful detach reclaims the embedded editor space. The companion uses the same icons and appearance as the owner; its files, search, code and assistant surfaces have their own scrollable areas. Select **System**, **Light** or **Dark** in Playground's dashboard to update both windows without recreating the editor. The setting is tab-session scoped; System follows live operating-system changes.

Keep the Playground owner tab open: detachment does not transfer PHP or MariaDB ownership to the new window. The full workbench's settings and Run and Debug views remain in the owner window. The companion search opens matching files and reports its result limit; use the owner workbench Search view for project-wide replacement. The Playground toolbar, file actions, AI panel, detached companion and custom workbench commands/status labels follow the selected interface language across all 20 existing locales. Upstream workbench contributions and some technical error messages may still use English.

## Saving and recovering work

Saved sites keep saved file changes under Playground's persistence policy. Temporary sites remain temporary until you explicitly select **Save**. Keeping a temporary site transfers the open Code session, models and drafts to the saved runtime; unsaved buffers remain unsaved rather than being silently written into Joomla files. **Keep this site** in the dashboard stages the persistence choice for the next launch.

For persisted sites, editor drafts are stored separately from Joomla files and restored when the editor reopens for that site. The current draft record is bounded to 128 documents and 8 MiB of draft text. A draft is not a saved Joomla file or a portable site backup. If a draft cannot reopen because its file is missing, use **JoomEngine Code: Recover missing drafts** from the command palette, then explicitly save the recovered content.

Resetting a saved site or deleting its saved entry clears its associated draft record. Renaming the saved entry only changes its display name and preserves its storage identity. Keep the owner tab open if draft storage reports a failure. Use the existing Playground export/download controls for portable site backups; editor drafts and AI credentials are not part of the site export.

Use **File recovery** to inspect and restore recent saved-file changes while the site remains open. Recovery retains at most eight snapshots within a 96 MiB budget; older snapshots expire. Review every affected path before restoring: restoring a snapshot can remove files that snapshot created, and later disk changes or dirty editor buffers can prevent restoration. Applied AI proposals also offer **Recover previous files**. Recovery is bounded session history, not an ordinary trash folder or a substitute for a backup.

## Optional AI editing

Select the robot **AI Assistant** action and expand **AI API settings**, or select **Accounts** in the Code header to open those settings directly. Choose a provider, enter its session API key and select a usable model. OpenAI, Anthropic / Claude and Google / Gemini appear first, followed by the wider direct-provider and inference-service catalog. Standard endpoints and protocol/authentication details are supplied; services such as Qwen, Azure, Fireworks and Bedrock ask for their required workspace, region, resource or account details. OpenRouter is an optional multi-provider gateway, not a required intermediary.

**Fetch Models / Refresh Models** uses provider catalog requests, not paid generation, and retains an available selection where possible. Model IDs remain editable for custom APIs, deployment aliases and services without discovery. Authentication, catalog and connection errors appear in the panel; integration-test status is recorded in [AI validation](roadmap/ai-validation.md), rather than displayed as an “Unverified” product label.

Choose **Other / Local AI API** for your own server, select its API format and enter the base URL. OpenAI-compatible examples are Ollama at `http://localhost:11434/v1` and LM Studio at `http://localhost:1234/v1`. A key may be left blank when the server allows anonymous access. Use the base URL, without appending `/models` or `/chat/completions`. Local/private HTTP endpoints remain subject to browser mixed-content, local-network and CORS restrictions; Playground does not probe local ports or add a proxy.

AI text edits support UTF-8 files and preserve an existing byte-order mark and uniform line-ending style before displaying the review. New files retain the proposed format. If an existing file has mixed line endings, choose its intended line endings in the editor, save it, and prepare the AI proposal again. Use the editor for deliberate encoding or line-ending conversion.

The AI can read bounded relevant context and propose changes. Review the operation list and before/after content before selecting Accept. Reject makes no filesystem changes. Accepted changes use the normal file-save workflow and recovery history; manual refresh remains manual. A partial failure reports completed and failed operations instead of silently repeating the proposal.

Use **Cancel request** to stop an in-progress provider request. Cancellation does not undo changes you already accepted. Use **Recover previous files** on an accepted proposal for the supported recovery path, and resolve any conflicting disk or unsaved-buffer changes first.

Keys stay in an opaque-origin session connection broker, shared by Accounts, the assistant and detached panels through isolated channels. Closing a panel, hiding Code, redocking or switching sites does not require re-entering the same connection's key. The conversation follows the same site/session between owner and detached views; a new site has its own bounded conversation history. **Clear credentials and conversation** clears the shared session credentials and conversations. Closing or reloading the owner page ends that in-memory connection session. Keys remain masked and are not sent through the owner-facing workspace channel or stored in Joomla files, deployment URLs, ordinary browser storage, exports or snapshots.

The context browser is inside the assistant. **Current file** is the default. **Selected files and folders** provides a searchable tree, removable selections and recursive folder scope; **Entire project** permits bounded retrieval without uploading the entire installation. The scope applies to initial context and subsequent file-list, read, search and change-proposal tools. A scope change starts a new conversation for that scope. Eligible unsaved buffers are included and identified, with selected-path, byte-budget and omission feedback. The default limits are 64 selected paths, 128 KiB per file and 512 KiB of aggregate context.

Generated-folder exclusions and sensitive-file/embedded-credential filtering still apply. Selecting a folder does not implicitly authorize its sensitive descendants. To include a sensitive configuration file, deliberately select that exact canonical file in Selected files and folders and inspect it first: its contents may contain secrets that the chosen API will receive. Local editing and PHP debugging do not require AI credentials.

The selected provider receives the context sent with a request and must allow requests from the panel's opaque origin. Live cloud-provider and local-server compatibility checks remain outstanding; protocol fixtures alone do not establish account access, browser CORS support or billing/cancellation behavior. See the [AI validation record](roadmap/ai-validation.md) for current evidence and limitations.

The Joomla preview and host are not a hostile-extension security sandbox. The AI key is isolated from their direct script access, but malicious same-origin extension code can still alter surrounding host UI. See the [AI implementation notes](joomengine-code-ai.md) for the precise boundary and provider-verification status.

## PHP debugging

**Debug and refresh** arms the current preview URL as a GET request and refreshes it under the PHP debugger. Use **Arm PHP request** to enter the exact site URL and HTTP method, then perform the matching navigation or form submission in Joomla. The workbench's Run and Debug view uses the same **JoomEngine Code PHP** debugger and launch configuration. Matching includes the query string, so a different route does not consume the selected request.

Set breakpoints in Joomla PHP files using the editor gutter; conditional breakpoints accept a PHP expression. Once the selected request pauses, use the debugging controls to continue, step into/over/out, inspect the call stack, choose a frame, expand variables and evaluate expressions. Evaluation executes PHP expressions and may have side effects. Breakpoints remain unresolved until the runtime confirms an executable location; merely adding one is not proof it will be hit.

The selected request is executed once. It is not first executed normally and replayed under the debugger. Source saves and ordinary requests share the owner's queue; while paused, keep new changes in editor buffers and continue or stop the request before waiting for queued saves to complete. Automatic preview refresh is suppressed during pause.

Stop ends the selected request and does not automatically replay a stopped POST. Database writes already completed are not automatically rolled back. Cooperative stop preserves the returned filesystem changes; if forced termination is needed, the owner retains its last confirmed filesystem state and reports the failure. Inspect the result before submitting an action again.

The implementation includes the HTTP SAPI bridge, worker ownership and in-browser adapter. Earlier milestone evidence records targeted native checks covering PHP 8.3, 8.4 and 8.5, including stepping, conditional breakpoints, recursive values, sessions, uploads and pause/stop controls. Local Chromium validation on persisted Joomla sites across all three PHP versions has also passed authenticated GET inspection and stepping, a POST with exactly one set of database/file effects, queued writes during pause, and stop followed by a usable authenticated request. The native workbench UI also passed a Chromium check on PHP 8.4: a gutter breakpoint paused the real Joomla request, displayed its current line, call stack and application properties, and Step Over and Continue completed the authenticated response. The final browser workflow results remain pending. See the [debugger notes](joomengine-code-debugger.md) and [checkpoints](joomengine-code-checkpoints.md) for the recorded evidence.

## Language and browser boundaries

The editor bundles language identification and grammars for PHP, mixed PHP/HTML, JavaScript, TypeScript, HTML, CSS, SCSS, LESS, XML, INI, JSON, YAML, SQL, Markdown and shell text. The workbench includes browser language-feature extensions for JavaScript/TypeScript, HTML, CSS and JSON. Earlier milestone Chromium checks exercised JavaScript, HTML and CSS completion, JSON diagnostics, and PHP source definitions, diagnostics and mixed-template HTML completion; the final browser workflow results remain recorded separately in the checklist.

PHP tooling provides syntax diagnostics for the selected PHP version and declaration-based completion, source definitions and document outlines. It indexes classes, interfaces, traits, enums, functions, constants and members; recognizes namespace imports; and handles known receivers such as `$this`, explicit class access, typed parameters and simple assignments using `new`. Mixed PHP/HTML templates receive HTML tag and attribute completion in their HTML regions.

This is syntax and declaration analysis, not full PHP type checking, autoloader analysis or a complete built-in signature database. Unknown receiver types do not produce guessed definitions. Background indexing is limited to 12,000 PHP files, 96 MiB of source and 1 MiB per file; unsupported encodings and excluded cache, temporary, log, Git and node-module folders are skipped. The PHP status item reports incomplete or stale indexing. After an arbitrary PHP request may have changed files, use **JoomEngine Code: Refresh PHP project index** from the command palette. Ordinary editor changes update the index incrementally without creating editor models for every Joomla file.

A file being editable does not make it executable, compiled or debuggable by Playground. PHP runs in the existing WebAssembly runtime. JavaScript debugging remains in browser developer tools. Arbitrary desktop VS Code extensions, host operating-system terminals, general build infrastructure and multi-user editing are outside the agreed scope.

The intended desktop browsers are Chromium and Firefox. Smaller viewports collapse side-by-side layouts to keep controls usable. Historical browser evidence remains in the [implementation checkpoints](joomengine-code-checkpoints.md); current experience requirements and provider limitations are tracked in the [roadmap](roadmap/implementation-roadmap.md) and [AI validation record](roadmap/ai-validation.md).
