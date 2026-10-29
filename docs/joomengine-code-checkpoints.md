# JoomEngine Code implementation checkpoints

This checklist implements the complete [scope and roadmap](./joomengine-code-scope.md), baseline 29 October 2026. It is an execution record, not a replacement or reduction of that scope. The implementation branch starts from `main` at `936cc4601e58647a0be91b01b1fda42632d4d447`; the roadmap's earlier research baseline remains useful context.

**Keep the pull request in draft until every requirement below is implemented and verified, the existing Playground remains stable, and all applicable workflows pass on the final head commit. Full PHP debugging of real Joomla requests is mandatory.** A usable editor, a dependency installation, an adapter interface, syntax checks or a debugger panel alone does not meet that requirement. Do not merge as part of marking ready for review.

Check an item only after its implementation and stated evidence are available. Record the implementing commit and validation receipt in the evidence log; a partially delivered item stays unchecked. Discovery work and passing tests for existing behavior do not complete new product requirements. Tests remain focused and behavior-driven; no additional approval gates or calendar estimates are introduced.

## Baseline inspection

- [x] B01 — Read the complete supplied roadmap, including completion boundaries and implementation references.
- [x] B02 — Inspect the current main runtime, worker, request routing, persistence, asset build, translations and validation workflow.

| Existing integration point | Finding and consequence |
| --- | --- |
| `src/playground.mjs` | `createPlayground()` owns one PHP worker, database, `/persist/www`, saved-site locks and lifecycle. Extend this owner; do not create another runtime for the editor. Its current `fs` API is intentionally broader than an editor workspace. |
| `src/php-worker.mjs` | Existing `fs.*` operations cover mkdir, read/write, readdir, stat and unlink. `virtualPath()` rejects some invalid paths but is not confined to the document root and does not enforce symlink confinement. Editor and AI operations need an authoritative worker-side boundary, more operations and notifications. |
| `PhpSession.send()` and worker operation queue | Both serialize work. Save batches must reserve one request interval. Paused debugging needs a separate responsive control channel and pause-aware timeout handling; putting debugger commands on the blocked request queue cannot work. |
| `src/cgi-request.mjs`, `src/http.mjs`, `src/php-routing.mjs`, `src/php-recovery.mjs` | Preserve the existing body, response, routing and recovery semantics when integrating phpdbg. Existing request recovery explicitly avoids replay. |
| `src/frame-view.mjs`, `src/app.mjs` | The live Joomla iframe is same-origin and explicitly not a security sandbox for extension code. Merely adding AI credentials to the owner window or local storage is insufficient isolation. Preserve current navigation/resize behavior while establishing a real origin or sandbox boundary for credentials. |
| `src/static-assets.mjs` | Reuse current static asset revalidation. Saving and reloading are separate events. |
| `package.json`, `versions.json`, `scripts/build.mjs` | No CodinGame workbench or debugger distribution is currently shipped. PHP-WASM is pinned to 0.2.0; supported PHP minors are 8.3, 8.4 and 8.5. Extend the verified asset pipeline for the exact compatible editor, language and debugger packages. Do not alter runtime defaults to simplify this work. |
| `src/i18n.mjs`, `src/locales/`, `index.html`, `NOTICE` | Follow existing translation, accessible-label, About and distribution-notice conventions. |
| `.github/workflows/validate.yml`, `scripts/ci-plan.mjs` | Existing fast checks, native build/provisioning and Chromium/Firefox jobs must remain effective. Documentation-only green checks do not validate product delivery; verify the final implementation through all applicable jobs. |

## 1 — Integration and shared ownership

- [x] I01 — Pin a compatible CodinGame Monaco VS Code package set and lockfile; integrate the browser workbench and `@codingame/monaco-vscode-files-service-override`. Evidence: reproducible locked install/build and a real workbench opened from Playground.
- [x] I02 — Initialize explorer, editor groups, text models, search, settings, language contributions, diffs and debugging services with one controlled lifetime. Evidence: required native workbench features function and unsupported desktop-only commands are hidden.
- [x] I03 — Provide the lazy-loaded “Open JoomEngine Code” entry point with retry/close and actionable loading failures. Evidence: no editor/language/debugger startup assets are fetched until needed, and editor startup failure leaves Joomla usable.
- [x] I04 — Establish shared Playground-owner, workspace-service, editor-session and view contracts in focused modules. Evidence: editor, AI and debugger use the same active site and document identities; no second site, competing models or unnecessary framework/fork.
- [x] I05 — Translate workspace URIs through one adapter into the active document root; authoritative worker operations canonicalize and confine all reads, searches and mutations, including symlinks, source/destination paths, traversal and missing mutation targets. Evidence: targeted boundary tests reject access to configuration, other sites and paths outside `/persist/www`.
- [x] I06 — Integrate lifecycle, existing read-only recovery, site locks, persistence and reset. Evidence: closing/resetting/changing sites stops stale editor operations; site-scoped data does not leak across site identities.
- [x] I07 — Begin real Joomla request integration for phpdbg alongside the file/session contracts. Evidence: documented request/control/ownership interfaces and an executable route integration; completion still requires every D item below.

## 2 — Files, editing, language services and recovery

- [x] F01 — Browse folders lazily with expansion, file types, refresh and reveal-active-file. Evidence: a Joomla tree opens without eagerly loading all files/models.
- [x] F02 — Create files/folders; upload, download and replace files with explicit overwrite handling. Evidence: text and binary round trips preserve bytes, with collision choices.
- [x] F03 — Rename, move, copy and delete files and complete folder trees. Evidence: source and destination are confined; the workspace root cannot be deleted or moved; failures/read-only states are actionable.
- [x] F04 — Handle missing files, naming collisions, large files, unsupported file content and failed writes. Evidence: no silent truncation, false success or discarded editable buffers.
- [x] F05 — Provide cancellable workspace search and replace with affected-file review before project-wide replacement. Evidence: cancellation remains responsive and all searched/replaced paths obey the worker boundary.
- [x] F06 — Provide multiple tabs, groups, split editors, dirty indicators, undo/redo, keyboard shortcuts, find/replace, quick open and command palette. Evidence: native workbench interactions edit actual Joomla files.
- [x] F07 — Save and Save All against the active runtime; manual save is initial behavior and autosave is independently configurable. Evidence: successful saves alter disk, unsaved buffers remain unsaved, and undo/redo changes buffers until saving.
- [ ] F08 — Preserve buffers, selections, cursor/scroll positions, tab order and undo history across every movement, detach/redock and hide/reopen. Evidence: dirty multi-tab continuity smoke flow.
- [ ] F09 — Dirty close offers save/discard/cancel; hiding preserves documents; rename/move updates open identities and deletion accounts for dirty buffers. Evidence: each choice preserves its documented outcome.
- [x] F10 — Publish file-change notifications and detect Joomla/other-view writes. Evidence: changed content prompts diff/reload/overwrite and neither disk nor unsaved changes are silently lost.
- [x] F11 — Preserve supported encodings and line endings; unsupported decoding is explicit and original bytes remain intact. Evidence: supported text round trips plus unsupported/binary rejection without corruption.
- [x] F12 — Maintain bounded recovery for destructive operations and accepted AI sets, scoped to the active site and cleared with that site. Evidence: restore a previous file/tree safely without overwriting a new conflicting change.
- [x] F13 — Persist drafts for saved sites and distinguish draft state from saved files and durable-storage failure. Evidence: persisted reopen recovers drafts and saved edits; temporary sites keep the existing temporary policy.
- [x] F14 — Provide PHP/mixed-PHP-HTML highlighting, bracket/indentation support, completion, navigation and diagnostics with browser-compatible tooling matched to the selected PHP runtime. Evidence: Joomla symbols and diagnostics work without blocking the UI.
- [x] F15 — Provide JavaScript, TypeScript, HTML and CSS language services including highlighting, completion and diagnostics. Evidence: representative actual project files exercise supported features.
- [x] F16 — Identify SCSS, LESS, XML, INI, JSON, YAML, SQL, Markdown and shell text with appropriate grammars and supported formatting/diagnostics. Evidence: concise supported-feature inventory agrees with bundled services.
- [x] F17 — Offer unknown-text fallback and manual language selection; provide supported image/binary previews plus ordinary binary file operations. Evidence: fallback is editable, previews do not corrupt bytes, unsupported binaries remain manageable.
- [x] F18 — Bundle focused free, licence-compatible browser extensions/services; perform indexing/search off the main UI thread where practical. Evidence: exact package/licence inventory and responsive indexing; documentation separates editing support from execution/build/debug support.

## 3 — Layout and preview

- [ ] L01 — Left and right docks show editor and independently navigable site with draggable dividers. Evidence: both orientations resize within usable minimums.
- [ ] L02 — Bottom dock has adjustable height; full-workspace mode fills available space while Joomla continues. Evidence: restore returns to the remembered layout without runtime replacement.
- [ ] L03 — Floating panel is draggable, resizable and modeless; uncovered site areas remain interactive. Evidence: move/resize and site navigation coexist.
- [ ] L04 — Detached mode opens a real browser window tied to the same owner and editor session; blocked popups leave the editor docked with an actionable message. Evidence: browser window and blocked-popup flows.
- [ ] L05 — Dock, detach, maximize, restore and close controls remain reachable; remember layout/dimensions and clamp them after viewport changes. Evidence: resize to a smaller viewport and restore preferences.
- [x] L06 — Detach/redock uses relocation or a narrow validated view bridge; messages validate expected origin/window and cannot create competing document authorities. Evidence: stale/foreign messages are ignored and shared edits cannot overwrite each other silently.
- [x] L07 — Closing a detached window restores the host editor intact; owner loss/site end clearly disconnects or closes the detached view and preserves recoverable saved-site drafts. Evidence: window close, owner close and site reset flows; no ownership-transfer requirement is invented.
- [ ] L08 — Desktop Firefox and Chromium, keyboard navigation, visible focus, contrast and smaller viewports remain usable. Evidence: focused browser checks and accessible controls; the site preview gains no new device restrictions.
- [x] R01 — Manual refresh is the default; Save/Save All/autosave never reload in manual mode. Evidence: save and undo/redo flows keep the preview document until explicit refresh.
- [x] R02 — Refresh site appears in both the editor and Playground toolbars while enabled, including detached mode; saved-since-refresh status stays distinct from dirty buffers. Evidence: both controls and status transitions work.
- [x] R03 — Refresh waits for in-flight saves and reloads the current preview URL without saving dirty buffers, restarting PHP, reinstalling Joomla or changing database/site/editor identity. Evidence: current-location refresh after a queued save.
- [x] R04 — Optional automatic refresh debounces nearby saves and reloads once after a successful batch; PHP pause suppresses refresh. Evidence: save-batch and paused-debug behavior checks.
- [x] R05 — Save All and accepted AI sets reserve a write batch so requests cannot split it; failures report exact outcomes with recoverable snapshots rather than claiming unsupported transactions. Evidence: controlled partial failure and recovery.
- [x] R06 — Distinguish active-file write success from durable-storage failure and reuse persisted/temporary-site policy. Evidence: a failed flush does not falsely report failed/successful active writes or delete buffers.
- [x] R07 — Reuse asset revalidation, invalidate PHP code cache when present and provide explicit Joomla cache clearing. Evidence: refreshed PHP/assets reflect saved changes; cache clear and runtime restart remain separate actions.
- [x] R08 — Explain save visibility, subsequent navigation/AJAX using saved files, in-flight PHP semantics and form/UI reset on refresh in concise usage help. Evidence: user documentation matches actual behavior.

## 4 — Initial AI project editing

- [x] A01 — Deliver optional chat, provider settings, user key, configurable model/base URL and one small OpenAI-compatible chat/tool-calling adapter. Evidence: local editing/preview/debugging remain usable without AI credentials or provider availability.
- [ ] A02 — Ship at least one verified browser-compatible provider preset. Evidence: real browser authentication, streaming, tool calls and cancellation verification recorded without keys; arbitrary custom endpoints are not described as verified presets.
- [x] A03 — Include selected text, open files and explicitly chosen project files; provide root-confined listing/search/read tools. Evidence: the assistant finds relevant code through the shared workspace service.
- [x] A04 — Propose file/folder creation, modification, rename, move and deletion as reviewable diffs and operation summaries. Evidence: accept/reject is required before every mutation; rejection leaves disk unchanged.
- [x] A05 — Detect conflicts against current disk and dirty editor buffers before applying. Evidence: stale proposals cannot silently overwrite either source of changes.
- [x] A06 — Apply accepted sets using the shared file/save service, with recoverable history and undo. Evidence: completed operations are accounted for, partial failures identify their outcome, recovery avoids blindly repeating completed writes and refresh obeys R01/R04.
- [x] A07 — Stream progress, support cancellation and surface provider/authentication/quota/network/tool errors with an accurate applied-change account. Evidence: cancellation and provider failures do not disable the IDE or conceal already applied operations.
- [x] A08 — Limit file/context/request sizes, automatically exclude sensitive configuration/credentials, allow explicit user selection and treat project text as data. Evidence: ordinary automatic context omits secrets; model instructions cannot bypass the tools' path/mutation restrictions; no unrestricted shell tool exists.
- [x] A09 — Keep session-only credentials out of project files, URLs, exports, logs, snapshots and persistent defaults. Isolate the credential-bearing context from executable Joomla content through a real origin/sandbox boundary and a narrow validated message interface. Evidence: Joomla script cannot read credentials or cause unauthorized credential-bearing requests; exports/logs contain no key.
- [x] A10 — Use deterministic provider fixtures in normal CI and document independent real-provider verification. Evidence: reproducible routine checks need no embedded credentials and match the actual streaming/tool protocol.

## 5 — Complete PHP debugging

- [ ] D01 — Ship the required phpdbg builds and reproducible small runtime/SAPI patches for every supported PHP version, preserving required extensions and the MariaDB bridge. Evidence: build provenance and actual Joomla debug requests on the supported catalog versions.
- [x] D02 — Arm the next explicitly matching request, debug-refresh the current page, or wait for navigation/form submission. Evidence: unrelated background requests cannot consume the armed target.
- [x] D03 — Preserve actual request method/URL/query/headers/body/uploads, cookies, authentication, sessions, selected PHP, current files and database; populate correct request globals and return actual status/headers/body to the existing preview. Evidence: authenticated GET plus POST/upload behavior against real Joomla routes.
- [x] D04 — Execute the selected request exactly once; no normal execution followed by replay. Coordinate exclusive ownership and filesystem handoff if a distinct phpdbg instance is needed. Evidence: one observable POST/database side effect and one authoritative filesystem/database state.
- [x] D05 — Connect phpdbg to the native VS Code debugging UI through an in-browser Debug Adapter Protocol adapter without a network debugger server. Evidence: debugger events drive the real workbench and source documents.
- [x] D06 — Persist file/line breakpoints with enable/disable/remove, conditional breakpoints and honest unresolved-location reporting. Evidence: breakpoints in Joomla source bind/hit or explicitly report why unresolved.
- [ ] D07 — Start, continue, pause, step into, step over, step out and stop; highlight and reveal the current executing line. Evidence: a real Joomla request steps through a caller/callee and continues to a valid response.
- [x] D08 — Inspect call stack and selected frames, local/global variables, nested arrays/objects, property names and types. Expand large/recursive values progressively. Evidence: authenticated request inspection includes an object and caller frame without freezing or unbounded output.
- [x] D09 — Support watches and debug-console expressions in the selected frame, with clear evaluation side effects and recoverable errors. Evidence: frame-specific evaluation and an invalid expression both produce accurate results.
- [x] D10 — Report PHP errors and exception locations with source navigation using the same URI/path mapping as ordinary editing. Evidence: known error/exception opens its real document and line.
- [x] D11 — Keep debugger control responsive while PHP is paused using a channel that is not queued behind the request; suspend ordinary request timeouts only during intentional pause, retain bounded startup/stop/recovery. Evidence: pause beyond ordinary timeout, inspect/step and stop successfully.
- [x] D12 — Keep editing responsive during pause, retain edits in buffers and visibly queue writes until request completion/stop. Suppress automatic refresh and implicit debug restart. Evidence: displayed paused source remains consistent with execution and queued saves complete afterward.
- [x] D13 — Coordinate database access, other requests, persistence and writes with debug ownership. Continue completes the pending response; stop releases locks and restores usability without replaying a stopped POST. Evidence: stop/recovery and a subsequent normal Joomla request succeed.
- [x] D14 — Document that completed database writes are not automatically rolled back and that explicit evaluation may have side effects. Evidence: behavior/help agree; no rollback or replay promise is made.

## 6 — Identity, integration and documentation

- [x] G01 — Produce reusable vector JOOMENGINE CODE artwork, small/large variants and light/dark variants following the existing logo typography, proportions, colors and gold treatment, with restrained C/O glare. Evidence: source artwork and rendered variants remain legible at target sizes.
- [x] G02 — Apply “JoomEngine Code” consistently to launcher, editor/detached titles, welcome, overlays, commands, settings, notifications and About; reserve “JEC” for compact contexts. Evidence: full-name accessible labels/tooltips and a wording review of all new surfaces.
- [x] G03 — Extend About and exact shipped distribution notices for Microsoft VS Code/Monaco, CodinGame, PHP/phpdbg, Sean Morris PHP-WASM, Emscripten, services, grammars, themes and dependencies. Evidence: retained existing credits and package/version/licence notices, not recognition alone.
- [x] G04 — Translate added labels through existing conventions; complete focus, keyboard access, contrast, responsive layout and loading/error/retry states. Evidence: language and UI checks plus browser review.
- [ ] G05 — Preserve launch/install/deployment presets/navigation/authentication/saved and temporary sites/export/import/runtime selection/current controls and defaults. Evidence: relevant existing regression checks pass and no existing default changes to accommodate the IDE.
- [x] G06 — Keep editor, language, search/indexing, AI and debugger failures isolated from the site and dispose unused resources without losing session state. Evidence: induced feature failure permits retry/close and Joomla stays usable.
- [x] G07 — Keep assets lazy, pinned, cached and reproducible under existing browser isolation/content-security requirements; document any small upstream patch. Evidence: build inventory and cold-start behavior for a user who never opens the editor.
- [x] G08 — Add concise user/developer documentation for files/languages, layouts/detached-owner relationship, save/refresh/cache behavior, AI provider/privacy/review/recovery and complete debugger usage. Evidence: instructions describe shipped behavior and explicit limits.

## 7 — Stabilization and readiness

- [x] V01 — Focused Joomla browser smoke: open/edit/save/refresh and observe a real change; create/upload/rename/delete and reopen a saved site. Evidence: browser receipt linked to final implementation commit.
- [ ] V02 — Focused multi-tab smoke: preserve dirty state/undo/selections through docks, floating, detach/redock and hide/reopen. Evidence: Firefox/Chromium coverage across the focused suite.
- [x] V03 — Focused refresh checks: manual mode never reloads on save; automatic mode reloads once per completed batch and stays suppressed during debug pause. Evidence: behavior-driven checks.
- [ ] V04 — Focused AI flow: review/apply one set, reject another, detect a conflict and recover accepted changes. Evidence: deterministic CI receipt plus the separate real-provider receipt required by A02.
- [x] V05 — Focused debugger flow: authenticated Joomla request, object/caller-frame inspection, stepping, valid continuation, POST once-only behavior and stop/recovery. Evidence: actual phpdbg request execution, not simulated DAP events or isolated snippets.
- [x] V06 — Targeted root-confinement and failed-save/recovery checks pass. Evidence: boundary/symlink/mutation-target and partial-write cases protect the authoritative worker.
- [ ] V07 — Run `npm run check`, `npm test`, verified build, applicable provisioning checks and focused Chromium/Firefox validation without removing existing safeguards. Evidence: all applicable jobs green on the final PR head; skipped documentation-only jobs do not count as implementation verification.
- [ ] V08 — Resolve observed regressions and record final manual/provider/debugger evidence; verify every requirement above against the actual shipped build and close remaining scope gaps. Evidence: complete checklist and no open required-capability blockers.
- [ ] V09 — Change the PR from draft to ready for review only after V01–V08 and every product requirement are complete. Evidence: readiness transition follows the final successful checks. Release/publication follows the repository's normal process after review; this checklist does not authorize merging.

## Evidence log

| Requirement | Implementation evidence | Verification evidence | Status |
| --- | --- | --- | --- |
| B01 | Complete attached scope read; all sections mapped above | Cross-check against original source | Inspected |
| B02 | Main `936cc4601e58647a0be91b01b1fda42632d4d447`; integration points above | Source inspection only; no product validation claimed | Inspected |
| I05, F12 | `75b77e1`; authoritative workspace service, revisions and bounded pre-write snapshots | `test/code-workspace-files.test.mjs`: confinement, traversal, symlinks, root protections, partial writes and conflict-safe restoration | Verified within active-site service scope |
| A04 | `48f58e9`; AI proposes through read-only review preparation, mutations require explicit acceptance | AI unit and Chromium sandbox flow: reject leaves disk unchanged, accept applies the reviewed set, recovery restores it | Verified; the stabilization milestone also fixes queued-buffer and canonical-alias checks |
| D01–D14 | `cc65be0`; native HTTP SAPI bridge and execution controls | 21 local native checks across PHP 8.3/8.4/8.5 cover form/raw bodies, multipart, sessions, conditions, steps, frame evaluation, progressive objects, pause/stop and errors | Earlier native milestone; subsequent real Joomla and UI evidence is recorded below |
| V07 | CI run [40966451725](https://github.com/joomengine/playground/actions/runs/40966451725) on `48f58e9` | Source checks and verified distribution build passed; provisioning correctly failed the three new POST-body cases | Failed, corrected by `cc65be0`; no readiness claim |

### Integration stabilization evidence (current source milestone)

The following local receipts establish the checked implementation requirements. They do **not** replace the final-head workflow requirement, the Firefox requirement or authenticated provider verification. The PR commit history identifies the implementing milestone; the final evidence update will name its immutable SHA.

| Requirements | Behavior and receipt | Result |
| --- | --- | --- |
| I01–I07, F01–F07, F10–F18 | Locked dependency and asset build; `test/code-workbench.browser.mjs` exercises real native groups/tabs, dirty recovery, breakpoints, PHP/JS/CSS/HTML completion, PHP definitions and diagnostics, JSON diagnostics, reviewed project replacement, stale-write conflict/explicit overwrite, UTF-16 BOM/CRLF preservation and malformed UTF-8 rejection | Chromium pass (124 seconds); full verified distribution build passes for all three PHP and both Joomla catalog versions |
| I05, F02–F05, F12, A03–A08, R05–R06, V06 | Workspace/file/AI tests exercise root confinement, equal-byte symlink retargeting, original-buffer canonical provenance, late dirty checks after queue reservation, bounded snapshots, partial failures and conflict-safe recovery | Focused cases and complete source suite pass; latest source suite: 190 tests |
| A01, A04–A10, L06, G06 | `test/code-ai-browser.mjs` exercises opaque credential isolation, expected window/origin/nonce validation, detached handshake, hostile localized strings, review/accept/reject/recovery and cancellation fixtures | Chromium pass; no real-provider claim |
| I06, L07, G06 | `test/code-host-lifecycle.browser.mjs` exercises pending panel/mount disposal and independent cleanup after teardown failures | Chromium pass |
| R01–R03, R05–R08, V01 | `test/code-joomla.browser.mjs` uses the freshly built distribution: native edit/save, zero automatic refresh in manual mode, explicit refresh with changed live bytes, binary upload/rename/delete/recovery, separate Joomla cache clearing and persisted-site reopen with healthy Joomla response | Chromium pass (34 seconds); save/refresh and owner-queue unit cases also pass |
| R07 | Direct execution of changed same-path PHP on all three pinned CGI builds returns the new source immediately. PHP 8.3/8.4 do not load Zend OPcache; PHP 8.5 loads it but reports no active cache. Existing asset revalidation is preserved. | No active PHP opcode cache requires invalidation in the shipped runtime configuration |
| D02–D06, D08–D14, V05 | `test/code-debug-joomla.browser.mjs`: persisted authenticated real Joomla request on PHP 8.3/8.4/8.5; application object/caller inspection, stepping and HTTP 200; actual POST database/file counts prove one execution; paused writes queue; executing-request pause/stop yields bounded recovery and a healthy authenticated subsequent request. The default-PHP UI branch sets a native gutter breakpoint and verifies Variables, Call Stack and current-line decoration. | Chromium passes; final Step Over revision, rebuilt artifacts and final-head Firefox evidence remain tracked separately |
| R04, D11–D13 | `test/code-request-liveness.test.mjs` and editor-session cases: deliberate pause survives ordinary request deadlines, new queued requests inherit pause, owner loss fails, stale timeout races cannot win and paused automatic refresh stays suppressed | Pass |
| G01–G04, G07–G08 | Four rendered vector variants; full/compact accessible branding; exact shipped source/licence inventory; strict build patches documented; 20-locale parity for all added labels including About; user, AI, debugger and branding guides | Build, visual review and localization checks pass; final cross-browser usability remains L08/G05/V02/V07 work |

Remaining open evidence is deliberate: dirty-close choices and movement/selection/scroll/layout interaction coverage, final Step Over UI verification, full existing regressions and Firefox on the final head, and **A02 authenticated browser provider verification**. A02 requires an actual user-owned credential in the isolated settings panel; fixture tests and an unverified candidate endpoint do not satisfy it.

Add rows as commits land. Keep incomplete checkboxes open and describe any blocker concretely. Cross-cutting requirements may share one behavior-driven receipt; avoid an exhaustive duplicate test matrix.

## Explicit boundaries

The completed IDE and debugger require no new application server or browser extension. AI uses the user's supported external provider. JavaScript debugging stays in browser developer tools. Arbitrary desktop extensions, a host OS terminal, general build infrastructure, multi-user collaboration and independent runtime ownership transfer are excluded. These exclusions do not defer any file, layout, AI, PHP-debugging, branding, recovery or verification requirement above.
