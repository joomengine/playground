# Using JoomEngine Code

JoomEngine Code opens a browser workbench beside the active Joomla site. The Playground tab continues to own PHP, MariaDB and the site files. The editor uses that same site; opening it does not install another Joomla instance.

This guide accompanies the implementation branch. The complete feature set is still being developed and validated. The [checkpoints](joomengine-code-checkpoints.md) record completion evidence; this guide does not mark the [full scope](joomengine-code-scope.md) complete.

## Open and edit

1. Launch or reopen a Joomla site in Playground.
2. Select **Open JoomEngine Code**. Editor assets load when opened.
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

Maximize fills the available workspace; Restore returns to the previous mode. Closing the editor panel hides it and preserves its current editor session. Reopen it with **Open JoomEngine Code**. The site keeps running in the same owner tab.

Detach opens a browser-managed auxiliary editor window. Browser popup rules still apply; a blocked popup leaves the editor docked. The auxiliary window keeps the native editor tabs, split groups, text models and undo history, with a companion file tree, project text search, Save All, Refresh site, cache clearing, file actions and AI assistant. Its debugging controls can arm a request, refresh under the debugger, continue, pause, step and stop; controls are enabled according to the active debugging state. **Files** toggles the companion sidebar; **Return to owner tab** redocks the editors. Closing the auxiliary window also returns its tabs and groups to the original workbench.

Keep the Playground owner tab open: detachment does not transfer PHP or MariaDB ownership to the new window. The full workbench's settings and Run and Debug views remain in the owner window. The companion search opens matching files and reports its result limit; use the owner workbench Search view for project-wide replacement. The Playground toolbar, file actions, AI panel, detached companion and custom workbench commands/status labels follow the selected interface language across all 20 existing locales. Upstream workbench contributions and some technical error messages may still use English.

## Saving and recovering work

Saved sites keep saved file changes under the existing Playground persistence policy. Temporary sites remain temporary until you explicitly use Playground's existing save/keep-site flow.

For persisted sites, editor drafts are stored separately from Joomla files and restored when the editor reopens for that site. The current draft record is bounded to 128 documents and 8 MiB of draft text. A draft is not a saved Joomla file or a portable site backup. If a draft cannot reopen because its file is missing, use **JoomEngine Code: Recover missing drafts** from the command palette, then explicitly save the recovered content.

Resetting a saved site clears its associated draft record. Keep the owner tab open if draft storage reports a failure. Use the existing Playground export/download controls for portable site backups; editor drafts and AI credentials are not part of the site export.

Use **File recovery** to inspect and restore recent saved-file changes while the site remains open. Recovery retains at most eight snapshots within a 96 MiB budget; older snapshots expire. Review every affected path before restoring: restoring a snapshot can remove files that snapshot created, and later disk changes or dirty editor buffers can prevent restoration. Applied AI proposals also offer **Recover previous files**. Recovery is bounded session history, not an ordinary trash folder or a substitute for a backup.

## Optional AI editing

Select **AI assistant** in the editor toolbar and expand **Provider settings**. Enter an HTTPS OpenAI-compatible API base URL, a tool-capable model and your API key. The initial implementation labels endpoints as unverified until authenticated browser checks have been recorded. OpenRouter is a documented candidate, not yet a verified supported preset.

The AI can read bounded relevant context and propose changes. Review the operation list and before/after content before selecting Accept. Reject makes no filesystem changes. Accepted changes use the normal file-save workflow and recovery history; manual refresh remains manual. A partial failure reports completed and failed operations instead of silently repeating the proposal.

Use **Cancel request** to stop an in-progress provider request. Cancellation does not undo changes you already accepted. Use **Recover previous files** on an accepted proposal for the supported recovery path, and resolve any conflicting disk or unsaved-buffer changes first.

Keys stay in a session-only, opaque-origin sandboxed panel. **Clear credentials and conversation** removes them from that panel. Keys are not sent through the workspace message interface or written to Joomla files, deployment URLs, browser-storage settings, exports or snapshots. The selected provider receives the context sent with your request and must permit browser requests from the panel's opaque origin. Provider availability, quota and cancellation behavior remain provider-dependent.

The integration uses the active selection and open documents as context, with sensitive-file and embedded-credential filtering. **Choose AI context files** lets you explicitly select up to 16 existing workspace files, each no larger than 128 KiB, by entering their paths. Explicitly selecting a configuration file permits its contents, including secrets, to be sent to the provider; inspect it first. Clear the path list to remove that explicit context. Local editing and PHP debugging do not require AI credentials.

The Joomla preview and host are not a hostile-extension security sandbox. The AI key is isolated from their direct script access, but malicious same-origin extension code can still alter surrounding host UI. See the [AI implementation notes](joomengine-code-ai.md) for the precise boundary and provider-verification status.

## PHP debugging

**Debug and refresh** arms the current preview URL as a GET request and refreshes it under the PHP debugger. Use **Arm PHP request** to enter the exact site URL and HTTP method, then perform the matching navigation or form submission in Joomla. The workbench's Run and Debug view uses the same **JoomEngine Code PHP** debugger and launch configuration. Matching includes the query string, so a different route does not consume the selected request.

Set breakpoints in Joomla PHP files using the editor gutter; conditional breakpoints accept a PHP expression. Once the selected request pauses, use the debugging controls to continue, step into/over/out, inspect the call stack, choose a frame, expand variables and evaluate expressions. Evaluation executes PHP expressions and may have side effects. Breakpoints remain unresolved until the runtime confirms an executable location; merely adding one is not proof it will be hit.

The selected request is executed once. It is not first executed normally and replayed under the debugger. Source saves and ordinary requests share the owner's queue; while paused, keep new changes in editor buffers and continue or stop the request before waiting for queued saves to complete. Automatic preview refresh is suppressed during pause.

Stop ends the selected request and does not automatically replay a stopped POST. Database writes already completed are not automatically rolled back. Cooperative stop preserves the returned filesystem changes; if forced termination is needed, the owner retains its last confirmed filesystem state and reports the failure. Inspect the result before submitting an action again.

The implementation includes the HTTP SAPI bridge, worker ownership and in-browser adapter. Targeted native checks cover PHP 8.3, 8.4 and 8.5, including stepping, conditional breakpoints, recursive values, sessions, uploads and pause/stop controls. Local Chromium validation on persisted Joomla sites across all three PHP versions has also passed authenticated GET inspection and stepping, a POST with exactly one set of database/file effects, queued writes during pause, and stop followed by a usable authenticated request. Native workbench debugging UI verification and the final browser workflow results are still pending. See the [debugger notes](joomengine-code-debugger.md) and [checkpoints](joomengine-code-checkpoints.md) for the recorded evidence.

## Language and browser boundaries

The editor bundles language identification and grammars for PHP, mixed PHP/HTML, JavaScript, TypeScript, HTML, CSS, SCSS, LESS, XML, INI, JSON, YAML, SQL, Markdown and shell text. The workbench includes browser language-feature extensions for JavaScript/TypeScript, HTML, CSS and JSON. Targeted Chromium checks exercise JavaScript, HTML and CSS completion, JSON diagnostics, and PHP source definitions, diagnostics and mixed-template HTML completion; the final browser workflow results remain recorded separately in the checklist.

PHP tooling provides syntax diagnostics for the selected PHP version and declaration-based completion, source definitions and document outlines. It indexes classes, interfaces, traits, enums, functions, constants and members; recognizes namespace imports; and handles known receivers such as `$this`, explicit class access, typed parameters and simple assignments using `new`. Mixed PHP/HTML templates receive HTML tag and attribute completion in their HTML regions.

This is syntax and declaration analysis, not full PHP type checking, autoloader analysis or a complete built-in signature database. Unknown receiver types do not produce guessed definitions. Background indexing is limited to 12,000 PHP files, 96 MiB of source and 1 MiB per file; unsupported encodings and excluded cache, temporary, log, Git and node-module folders are skipped. The PHP status item reports incomplete or stale indexing. After an arbitrary PHP request may have changed files, use **JoomEngine Code: Refresh PHP project index** from the command palette. Ordinary editor changes update the index incrementally without creating editor models for every Joomla file.

A file being editable does not make it executable, compiled or debuggable by Playground. PHP runs in the existing WebAssembly runtime. JavaScript debugging remains in browser developer tools. Arbitrary desktop VS Code extensions, host operating-system terminals, general build infrastructure and multi-user editing are outside the agreed scope.

The intended desktop browsers are Chromium and Firefox. Smaller viewports collapse side-by-side layouts to keep controls usable. Browser-specific completion evidence, provider verification and remaining limitations are tracked in the [implementation checkpoints](joomengine-code-checkpoints.md).
