# JoomEngine Playground — implementation roadmap

Prepared 30 October 2026 for implementation in [joomengine/playground](https://github.com/joomengine/playground).

This is the complete handoff for the requested interface, navigation, saved-site, editor, AI, theme and About changes. It incorporates the latest clarification on custom AI APIs, provider ordering, Site/Admin placement, responsive buttons and the supplied SVG bundle. It describes requirements; implementation and verification are recorded in [completion status](completion-status.md).

**Post-merge clarification, 30 October 2026:** the pearl SVG replaces interface rocket icons and the favicon only; the original launch-stage poster/video stays. Header/footer hiding fully removes their layout space and leaves compact overlays at the document corners. Site actions move to the dashboard’s top-right above saved-site details. One actual-state Light/Dark icon sits beside Downloads and realigns on the next system theme change. Light-mode branding has a clean black wordmark with no glare or background plate (updated 31 October 2026). The corresponding requirements below supersede the earlier interpretation in PR #8.

## 1. Direction and deliverables

Improve the existing Playground, retaining its browser-based Joomla/PHP/MariaDB runtime and editor. The result should feel modern, compact and polished, with useful controls, consistent spacing, clear states and a coherent icon system. Preserve running sessions, saved sites, unsaved editor work and the existing deployment/share/export features.

Use the accompanying curated icon package. Monochrome action icons come from the user's `black-svg-icons.zip`; branded rocket icons come from the newly supplied `JoomEngine_Pearl_Logo.svg`, which supersedes the old rocket icon and the generic bundle rocket. Review its numbered preview and `ICON-MAPPING.md` before integration. The selected icons are proposals for this review round, not a claim of final user approval. Do not reuse the earlier rejected, custom-drawn icon proposals, generate replacement artwork or silently substitute another library. Source geometry is retained. Black, white and `currentColor` variants are supplied for 101 monochrome action mappings; the pearl rocket stays full color and serves Deployment and Launch icons, the favicon and other interface rocket icons. Preserve the original launch-stage poster and video.

The final application work must include:

- The new pearl rocket used consistently for the favicon and interface rocket icons, sized and positioned for each use; the original launch-stage video/poster is preserved.
- Site/Admin navigation beside Deployment.
- One expanded dashboard containing configuration and saved-site management, with its site actions in a top-right row above saved-site details.
- Predictable launch/countdown behavior and saved-site rename/delete/resume.
- Full header/footer collapse with no reserved strip; small document-corner overlays scroll with the page and reveal/scroll to the restored area.
- Editable language selectors backed by the existing language catalog.
- Compact, responsive editor controls; a working Code toggle; reliable detach/redock.
- Named AI API presets, custom/self-hosted APIs, session credentials, provider model discovery and browsable context selection.
- One Light/Dark icon toggle beside Downloads, synchronized across the shell and Code; operating-system theme changes realign the session automatically.
- Reordered, clearer About content and repository links.

## 2. Reviewed baseline and implementation entry points

Repository main was checked at [`5f2ecc841ab4625f607ada90077050b3a00b9dde`](https://github.com/joomengine/playground/commit/5f2ecc841ab4625f607ada90077050b3a00b9dde). Recheck the current checkout, repository instructions and tests before editing. These are source findings, not a complete live-browser reproduction of every reported problem.

| Area | Existing behavior or structure | Primary files to inspect/change |
|---|---|---|
| Main controls | Code always opens; More is separate from the chevron dashboard | `index.html`, `src/app.mjs`, `src/styles.css` |
| Saved sites | `openSavedSite()` closes the runtime and launches the selected site immediately; `launch()` assumes no runtime is already active | `src/app.mjs`, `src/ui-state.mjs`, `src/launch-countdown.mjs` |
| Saved metadata | Site name participates in setup identity; last preview route is held in memory rather than saved per site | `src/ui-state.mjs`, `src/site-configuration.mjs`, `src/app.mjs` |
| Storage deletion | Existing reset logic handles per-site storage and locking | `src/playground.mjs` |
| Restore tabs/scroll | Restore tabs are fixed to viewport edges; chrome restoration preserves scroll instead of revealing the restored area | `src/styles.css`, `src/app.mjs`, `src/frame-view.mjs` |
| Languages | Dashboard already has a catalog-fed datalist; deployment languages remain free text | `index.html`, `src/app.mjs`, `src/deploys.mjs`, `dependencies/joomla-languages/packages.json` |
| Editor layout | Full repeated wordmark plus a permanent separate toolbar; detachment leaves an embedded shell | `src/code/layout.mjs`, `src/code/styles.css`, `src/code/host.mjs` |
| Detached editor | Separate styles and fixed toolbar offsets; native auxiliary-window editor transfer already exists | `src/code/detached-tools.mjs`, `src/code/workbench.mjs` |
| AI | OpenAI-compatible chat adapter, raw endpoint/model settings and development-status text; context can include open files and extra paths | `src/code/ai-provider.mjs`, `src/code/ai-panel.mjs`, `src/code/ai-review.mjs`, `src/code/host.mjs`, `src/code/workbench.mjs` |
| Accounts | No custom working AI Accounts integration was found; source also disables a native Accounts setting | `src/code/workbench.mjs`, built editor configuration |
| Credits | Microsoft/editor entries appear first; repeated vendor prose follows the list | `index.html`, translations, `NOTICE`, distributed dependency inventories |

Read the existing translation infrastructure and update all affected interface strings. Do not hard-code new English-only labels or rely on visible text as an action identifier.

## 3. Shared icons, buttons and responsive behavior

### 3.1 Icon integration

Use action IDs from `icon-manifest.json` as a central mapping, rather than scattering SVG markup and filenames across components. Decorative SVGs inside labelled buttons should be hidden from assistive technology; the button itself owns its accessible name. Preserve the same icon for the same action across embedded, detached, dashboard and dialog surfaces.

Use `currentColor` inline SVGs or a controlled SVG sprite for themed controls. An external `<img>` does not inherit the button's CSS `color`; use the explicit black/white file if choosing that rendering approach. Preserve `fill="none"`, cutouts and any original stroke/fill rules. Do not force every SVG child to fill, which would turn invisible bounds into solid squares.

Fork and Star are always icon-only. AI Assistant opens with the supplied robot icon and no visible words. Other buttons that have text should gain a matching icon; at comfortable widths show icon + label, and at narrower widths hide the visible label while retaining the icon, tooltip and accessible name. This applies consistently to the main shell, dashboard, footer, editor and dialogs. Native editor internals such as language/file-type icons do not require a wholesale replacement of the upstream workbench.

Where the bundle lacks an exact specialist glyph, the mapping explains the closest existing symbol. Debug step actions in particular require distinct tooltips and visual review; do not fabricate new geometry to fill a gap. The old top-level More menu is removed, so its generic overflow icon is reserved for genuine local toolbar overflow, not a second site-management menu.

### 3.2 Authoritative pearl rocket and size-specific framing

The user-supplied `JoomEngine_Pearl_Logo.svg` is the rocket identity for interface icons and the favicon. Use it for the browser favicon, Deployment/Launch rocket icons and other branded rocket icons. Search source, HTML, CSS, asset generation and any existing manifest/touch-icon declarations for older rocket icon artwork. Update those references consistently, including the detached window's favicon where supported. Keep the separate JoomEngine wordmark.

The launch-stage media is explicitly excluded from this replacement: preserve `rocket-poster.jpg` on the welcome/recovery stages and `rocket-launch.mp4` on the loading stage, with muted looping playback, pause when hidden and a reduced-motion poster fallback.

Preserve the exact master SVG under a brand-source path. The supplied file is 218,076 bytes with a `0 0 1280 1280` viewBox, gradients, vector lettering and a transparent background; it contains no embedded raster image, script or external resource reference. Its drawing bounds were measured for this handoff as approximately x=226.852, y=57.917, width=921.295, height=1185.34. These values explain the current empty margins; they are not a requirement to clip to a tight rectangle.

The handoff includes `brand/rocket.svg` and `brand/favicon.svg`, which retain all artwork and use centered square framing with modest padding. Width/height are convenient intrinsic sizes, not fixed rendering requirements. Tune `viewBox`, `preserveAspectRatio`, CSS dimensions and optical alignment per surface. Keep the complete flame/body in the selected frame; avoid distortion, clipping or making a 1280-pixel image box enlarge the toolbar. Reposition within its icon box without moving neighboring controls.

Use roughly 20–24px visible controls as a starting point, test 16/32/48px favicon rendering, and frame other interface icon sizes independently. Preserve the recognizable silhouette at small sizes; lettering and reflection detail cannot be expected to read at 16px. If a small-size framing adjustment is needed, derive it from this same vector and review it; do not invent a new simplified rocket or silently remove branded details.

Keep this asset full color in both Light and Dark modes. Exempt it from monochrome `currentColor`/fill rules. Check its edges, highlights and transparency on both backgrounds. For repeated UI use prefer a cached external SVG image instead of duplicating the full gradient-heavy markup into every button. If inlining, namespace all gradient/clip/title IDs per instance or use a validated shared symbol so duplicate IDs do not corrupt the rendering.

Optimize payload separately from display size: reducing width/height alone does not reduce SVG file bytes. Use a reproducible conservative SVG optimization step, removing safe metadata/whitespace and redundant data only after visual comparison. Preserve required attribution, paths, gradients, clipping and alpha; keep the original master untouched. Do not rasterize the primary SVG. Generate PNG/ICO fallbacks from the same master only where current browser/manifest/touch-icon requirements call for them; this does not add a new PWA feature. Validate browser-tab caching/cache-busting and update existing manifest references where applicable.

References: [SVG viewBox](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/viewBox), [preserveAspectRatio](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/preserveAspectRatio), [manifest icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons).

### 3.3 Responsive layout contract

On wide layouts, Code identity, workspace/layout selection and action buttons share one compact header. Keep the workspace/layout/window controls anchored in their corner with a protected minimum width. Action buttons must not overlap them, the title or the resize controls.

As the editor becomes narrower, first remove action labels and retain icons. If the icon group still cannot fit, only that action group may collapse/wrap into a compact action strip or an accessible overflow surface. Do not push the workspace/layout/window controls onto a second row. The implementation default is an action-only compact strip on the smallest editor widths; there must be no permanent second toolbar row at normal widths. Base the change on the editor container width, not only the browser viewport, because docked/floating editors can be narrow inside a wide screen.

Keep close, detach/redock, maximize/restore and layout selection reachable at every supported size. Preserve keyboard focus when a label disappears or an action moves into overflow. Ensure long translations, 200% zoom and touch input still work. Small visible glyphs may have a larger clear hit target, provided that target does not overlap Joomla controls.

## 4. Site/Admin navigation and the main dashboard

### 4.1 Site/Admin beside Deployment

Place Site and Admin immediately beside the Deployment button as a clear navigation pair. Site navigates the existing running preview to `/`; Admin navigates it to `/administrator/`, which shows the dashboard when signed in and the normal login flow otherwise. Do not rebuild the runtime, reinstall Joomla, reset credentials or start another saved site to switch areas.

Show the active area using actual preview navigation events, including navigation performed inside Joomla. Disable navigation while no site is ready and give a useful accessible state. Keep existing authentication and auto-login behavior. Clicking Admin should not promise to bypass Joomla authentication. Preserve applicable dirty-work checks when changing a page with unsaved forms.

### 4.2 One expanded dashboard

Keep the existing chevron as the disclosure for the main advanced dashboard. Move all actions from More into this area:

| Group | Controls |
|---|---|
| Saved sites | Select, manage, rename, delete; identify the running site separately |
| Runtime configuration | Deployment, Joomla version, PHP version, Joomla language, Keep this site |
| Launch | Launch button, startup countdown, Stop countdown, running/progress status |
| Site actions | New Site, Restart, Close Site, Login Details, PHP Settings, Reset Site |

Place New Site, Restart, Close Site, Login Details, PHP Settings and Reset Site in a right-aligned row at the very top of the expanded dashboard, above the saved-site selector, saved name and details. Keep a divider beneath the row. The actions should remain close to the dashboard disclosure control. The appearance toggle belongs beside Downloads in the main header, outside this dashboard.

Give dashboard actions icons and clear labels. Visually distinguish destructive actions without allowing them to dominate. Preserve the existing Deployment dialog for its detailed deployment fields; the dashboard consolidates the duplicated quick/More areas, not every dialog into one crowded screen.

Make action targets explicit: running-site actions operate on the running site; Rename/Delete operate on the selected saved entry and name that target. New Site stages a new configuration. Closing a site stops its runtime without deleting its saved data. Reset is distinct from deleting a saved entry and must describe its actual effect. Do not let selecting/configuring a potential next site silently stop the current one.

## 5. Saved sites, launch control and persistence

### 5.1 Behavioral contract

The user's later explicit-Launch instruction resolves the earlier optional-countdown wording: initial page entry may auto-launch after ten seconds; manually selecting a saved site stages it and waits for Launch. Do not introduce a new auto-launch countdown on every manual selection.

| Event | Required result |
|---|---|
| Open Playground normally | Select the last successfully used saved site, or the default when none exists; begin a visible 10 → 0 startup countdown |
| Startup countdown reaches zero | Launch that target and restore its last safe visited route |
| Click Stop | Cancel the pending startup launch; leave the target selected and Launch available |
| Select another saved site | Cancel any startup countdown, update the pending target, keep the current runtime running |
| Rename/manage a selected site | Perform management without starting it or stopping a different running site |
| Click Launch | Validate the pending target, resolve unsaved work, then switch/launch once |
| Select the already running site | Identify it as running; do not restart it merely because it was selected |
| Change staged runtime/deployment choices | Update the pending configuration; do not silently tear down the current site |
| Open via an explicit deployment/share link | Preserve intentional link configuration and existing no-auto-start semantics rather than always overriding with last-used metadata |

Keep `selectedSiteId`, `runningSiteId`, pending configuration and last-successfully-launched site distinct. A single mutable “active” variable must not mean all four. Launch must remain available for a different staged target while another site is running. Use explicit launch/switch states to prevent duplicate launches and stale countdown callbacks. Cancel timers on manual intervention, disposal and other existing cancellation conditions.

### 5.2 Rename, delete and resume

Saved-site management needs an obvious name field and Rename/Delete actions, empty states and progress/errors. Rename changes the saved display label without changing the storage key, filesystem, database or setup identity. The Joomla site's internal title is a separate configuration concern. Keep labels readable in the selector, optionally with Joomla/deployment details as secondary information.

Delete must name the selected site and ask once for confirmation of data removal. For an inactive site, delete its files, database, drafts and catalog entry without launching it. Reuse the existing storage/lock mechanisms. For a running site, resolve dirty work and stop it before deletion. If storage is locked elsewhere or deletion fails, retain recoverable metadata and show the actual result. Do not accidentally reset or delete the currently running site when a different entry is selected.

Store a last-safe route per saved site and update it from real navigation. Restore frontend/admin location when revisiting that site. Store normalized in-site paths, with only safe query/hash state needed to restore the page; exclude external URLs, credentials and transient action/security tokens. If the route is no longer usable, fall back to the site's initial page. A route is navigation state, not part of the immutable site storage identity.

Migrate existing launch preferences without losing saved entries. Introduce display labels and last-route metadata with defaults for older records. Review the existing 40-entry metadata limit so ordinary saves cannot silently make older stored sites disappear from management. Respect Keep This Site: temporary sites should not become resumable saved installations merely because the UI remembers a selection.

## 6. Header/footer restore tabs and scrolling

Hiding the chrome must completely collapse the header, dashboard, activity area and footer: no residual padding, margin, border, spacer or reserved restore strip may remain in document flow. The Joomla preview reclaims that space.

Place compact restore controls as absolute overlays exactly at the top-left and bottom-left document boundaries. They occupy no layout space and scroll with the document; they are not viewport-fixed. At a middle scroll position neither tab follows the user; the top tab returns near the top and the bottom tab appears only near the bottom.

Use the supplied inward-facing arrow choices: down-right at the top-left boundary and up-right at the bottom-left boundary. Keep each visible tab and its hit region compact, entirely in its corner, with adequate contrast in both themes. It may hover over the Joomla surface but must not cover Joomla buttons or other interactive controls; do not create a blank strip to accommodate it. Align the relevant hide/restore affordances closely enough that hiding chrome makes the new small tab discoverable near the pointer, rather than placing it far away at the opposite edge.

Clicking the top tab must reveal the existing chrome and scroll to the header; clicking the bottom tab must reveal it and scroll to the footer. Wait until layout has expanded before calculating the scroll target. Respect reduced-motion settings and focus the restored control area appropriately without a second accidental scroll.

Preserve the current shared header/footer hiding model unless implementation discovers a reason to separate it. “Top” and “bottom” choose the reveal destination. Do not remount the Joomla iframe, reset its route or lose the running session to hide/show chrome. Preserve the outer document's ownership of scrolling and verify interaction with the auto-sized iframe, dynamic content and Joomla modals.

## 7. Language selectors

Use one shared catalog-driven language selector in both the dashboard's Joomla Language field and the Deployment dialog's Site Languages field. Opening/focusing it must visibly offer existing language tags; typing filters the suggestions and also permits a custom tag. Provide keyboard navigation and readable language names alongside tags. Deployment Site Languages supports multiple selections/removable tags, while the primary Joomla Language is a single selection.

Use the actual available catalog for the selected Joomla version, plus built-in English. The reviewed catalog includes `en-GB`, `af-ZA`, `de-DE`, `fr-FR`, `it-IT`, `es-ES`, `zh-CN` and `nl-NL`; this list is descriptive of the reviewed snapshot, not a hard-coded replacement for the catalog. Keep the two surfaces synchronized with the pending deployment configuration and preserve import/export behavior.

Custom input must not be falsely advertised as an available installable package. Accept valid language tags, then resolve availability through the existing package mechanism. If a tag lacks a usable package, retain the input and give actionable validation before launch. Align HTML validation with the configuration parser, including supported script subtags; do not keep a restrictive two-part pattern that rejects otherwise valid configuration. Do not change the existing initial-language/multilingual policy incidentally to this UI work.

## 8. JoomEngine Code branding, toggle and detachment

### 8.1 Branding and header

Keep the main JoomEngine branding. Replace the repeated full JoomEngine Code wordmark beneath it with a compact “Code” identity. The main menu action remains named “JoomEngine Code” when its label is visible. Place the editor action group beside its workspace/layout selector in the shared header, following section 3's responsive rules. The detached window may retain a useful window title, “JoomEngine Code,” without duplicating oversized logos inside its content.

### 8.2 Toggle behavior

Clicking the main JoomEngine Code button opens a hidden embedded editor; clicking it again hides the editor. Reopening restores its files, buffers, layout, selections and scroll state. Hide is not dispose and must not discard unsaved work. Update `aria-expanded` and the tooltip for the current action.

When the editor is detached and visible, the main Code action still toggles it closed: coordinate redocking and hiding without discarding the session or momentarily reopening the embedded panel. Distinguish this intentional toggle from ordinary detached-window Close/Return, which restores the embedded editor as requested. Reopening Code restores the same embedded session. Do not create a duplicate instance, orphan a window or discard drafts. If the detached window has gone away unexpectedly, recover ownership before applying the toggle state.

### 8.3 Detached flow

Detach must transfer the current editor session into a correctly styled auxiliary window and reclaim the embedded stage space, including the leftover shell/divider. Only collapse the embedded editor after the popup is confirmed open; if popups are blocked, keep the working embedded editor and show a useful message.

Use shared theme tokens, icon components and responsive sizing in the detached window. Replace hard-coded toolbar-height offsets with layout that measures/flows correctly. The code pane, file tree, search results and AI panel must each scroll as appropriate; wheel, trackpad, keyboard and touch scroll must work without traps. Do not claim a particular wheel-event bug is fixed until reproduced and tested.

Closing the detached window or choosing Return to Workspace restores the embedded editor to its prior workspace layout. Preserve open/dirty files, undo/redo, splits, cursor/selection, scroll, diagnostics, debug state as supported, and the AI session. Reuse the existing native editor-group transfer instead of rebuilding editor models. Prevent duplicate ownership/event listeners. Handle owner-window closure and site switches deliberately; the detached editor depends on the owner's runtime and must not continue presenting stale files as an active site.

## 9. AI APIs, Accounts, models and context

### 9.1 Clear product language and provider ordering

Use “AI Assistant” for the conversation and “AI API settings” for the connection settings. Explain once: “Connect an AI API to help with the files you choose.” Field labels should identify Provider, Model, AI API key and, for custom connections, AI API base URL. A consumer chat website URL is not an API endpoint.

The preset provider order starts **OpenAI, Anthropic / Claude, Google / Gemini**. Follow them with DeepSeek, xAI / Grok, Mistral, Meta, Cohere, Alibaba / Qwen, Moonshot / Kimi, Z.ai / GLM, MiniMax and Perplexity; include prominent inference services such as Groq, Cerebras, Together AI, Fireworks, OpenRouter, Hugging Face, NVIDIA, Microsoft Azure / Foundry and Amazon Bedrock. Appendix A and the accompanying `AI-PROVIDER-CATALOG.md` describe their documented configuration differences. Include **Other / self-hosted AI API** last. The catalog is a maintained registry, not a permanent claim that the current market has exactly a fixed number of providers. Review prominent additions and official endpoint changes at implementation time.

Preset standard endpoint, protocol, authentication and model-list behavior internally. Ordinary users selecting a standard provider should not type its public endpoint. Region/account-specific services may expose the genuinely necessary region or resource field. Distinguish direct providers from optional gateways in descriptions; explain OpenRouter as an optional service that routes to multiple model providers, not a required step or “Open Route.” Do not route a selected direct provider through a different service silently.

### 9.2 Other and local servers

Other must allow a custom AI API base URL, optional API key, protocol choice where necessary and model selection/manual model ID. Default the custom protocol to OpenAI-compatible; explain that the server must support that protocol. Support documented native adapters where implemented instead of pretending all endpoints accept the same payload.

Show concrete examples next to the URL field:

- Ollama with OpenAI compatibility: `http://localhost:11434/v1`.
- LM Studio with OpenAI compatibility: `http://localhost:1234/v1`.
- Self-hosted compatible server: `https://ai.example.com/v1`.

These are examples, not preflight requests to run without selection. Clearly specify that the field is a base URL; compose `/models` and chat paths without doubling `/v1` or `/chat/completions`. Accept loopback/local hosting where browser policy permits it, and support a remote private endpoint without assuming it is OpenAI's cloud. Permit blank API keys for servers configured without authentication; mask supplied keys.

Provide Fetch Models / Refresh Models and an actionable connection error. Distinguish invalid authentication, missing model route, unsupported protocol, network/CORS, local-network permission and mixed-content failures. The browser and server must allow the connection; a URL setting alone cannot override those restrictions. Test from the actual deployed HTTPS Playground and its isolated AI context. Do not weaken the existing isolation or add an undisclosed proxy to force a connection to work.

### 9.3 Accounts and session credentials

Use the previously inert Accounts affordance as the proposed entry point to the same AI API account/settings surface opened from the assistant. This gives it a clear purpose without adding an unrelated sign-in/account service. Verify the actual built editor affordance and integrate with the appropriate extension/service mechanism rather than patching vendor DOM. If the native slot cannot support this reliably, provide a first-class Accounts control in the shared Code header that opens the same surface.

Both entry points share provider, model, URL and masked key state for the current Playground session. Enter a key once per provider/connection for that session; do not require reentry merely because the assistant closes, Code hides, the editor detaches/redocks or the user changes files. Provide an explicit clear/disconnect action. Do not persist secrets in deployment URLs, saved-site configuration, exports, logs or ordinary localStorage.

Preserve the current security boundary: AI credentials live in the isolated AI context, not in the same-origin Joomla page or accessible parent DOM. Do not relay raw keys through parent-window messages; share the isolated connection through authenticated channels/session capabilities rather than copying secrets into Joomla-accessible views. Retain credentials across in-session view/site changes by keeping the connection broker alive outside per-site UI teardown. Closing the owning browser session clears credentials; surviving a full reload is not promised without a separate secure persistence design. Non-secret theme preference has a different lifecycle.

Remove “Verification Required” and “Unverified” development-status labels from the normal UI. Keep real user-relevant states such as fetching models, connected, authentication failure and unavailable model. Documentation and automated tests track integration coverage; the interface should not narrate development status.

### 9.4 Model discovery and adapters

Fetch the selected provider's model catalog when credentials/settings are usable. Handle pagination, provider-specific response shapes, account entitlements and refresh/caching. Model discovery should not issue a paid generation request merely to fill a dropdown. Do not promise that every provider offers anonymous or universally free API access; catalog access and billing policies are provider-specific.

Filter/rank usable text/chat/coding models and check tool/streaming capability needed by the assistant. Put a curated suitable default first, retain a user's still-valid model choice and allow alternatives in a searchable list. Do not simply select the first opaque API result or hard-code a model that has disappeared. Keep provider preference rules maintainable separately from UI code. Provide a manual model ID for Other and for APIs where discovery is unavailable, with clear validation.

Introduce provider adapters for model listing, streaming, cancellation, tool calls and errors. Anthropic and Google native APIs need their own handling; OpenAI-compatible services also differ in details. Preserve existing change review, accept/reject, cancellation, dirty-buffer protection and undo. Do not advertise editing/tool use on a model that only supports text without an implemented alternative.

### 9.5 Context selection inside the assistant

Move the external “Choose AI context files” control inside the assistant dialog/panel. Provide a scope control for **Current file**, **Selected files/folders**, and **Entire project**. Default to Current file as the implementation recommendation; clearly show that scope so it is never mistaken for project-wide access. Let the user browse a hierarchical file/folder tree with search and selection, not type filesystem paths.

The current source can include all open files plus selected text and extra paths; do not label that as current-file-only. Make selected scope govern initial context and every subsequent AI file read/search/tool operation. A file-scoped chat must not silently inspect unrelated Joomla files. Folder selection must resolve recursively within that folder, support exclusions and enforce aggregate limits. Entire project means permission to retrieve relevant files within the project, not blindly uploading the full Joomla installation.

Show selected paths, counts and size/budget feedback. Include current unsaved buffers where appropriate and identify them as such. Preserve canonical path checks, boundaries and sensitive-file exclusions. Explain omission/truncation in plain language and ask for explicit inclusion where the existing sensitive-file policy requires it. Make context state follow the assistant into detached mode. Suggested edits remain reviewable before application.

## 10. Light/Dark toggle and system alignment

Default to the actual `prefers-color-scheme` value. Place a single icon-only toggle immediately beside Downloads in the main header, separated by a small vertical divider. Show the supplied sun icon when Light is active and the moon icon when Dark is active; the icon represents the current appearance. Clicking it switches to the other mode. Provide a translated accessible name and tooltip. There is no System button, dropdown or appearance control in the dashboard.

A manual toggle takes effect immediately, but the next operating-system color-scheme change clears that override and realigns the session to the new system value. Subsequent system transitions continue to apply until another manual toggle. An actual system event must clear the override even if its resulting theme already matches the current display.

The setting applies to this open Playground session, with a tab-scoped non-secret preference that can survive reloads. Synchronize the owner and its detached editor. Independent Playground sessions should not be forced to change by a global localStorage setting or cross-tab broadcast. A newly created independent session defaults to the current system theme.

Apply a shared palette to header, footer, dashboard, restore tabs, dialogs, tooltips, controls, focus/disabled/destructive states, Code shell, file tree, AI surface and detached tools. Apply an actual corresponding editor/workbench theme for code backgrounds, tokens, diff views and native widgets. Do not merely invert the shell around a dark editor. Handle logos/wordmarks and all icons with adequate contrast. In Light mode the main JoomEngine logo uses clean solid-black vector lettering on a transparent background, with both glare effects removed. Dark mode retains its light lettering and original gold highlights.

Set the CSS `color-scheme` and appropriate document theme metadata so supported native controls/scrollbars fit. The website can style its own surfaces; it cannot change the user's browser or operating-system preference. The embedded Joomla site's template retains its own styling unless it already supports a compatible theme integration; do not globally invert arbitrary Joomla content.

Avoid a flash of the wrong theme during initial render and detached-window creation. Theme changes must not recreate the runtime/editor or discard UI state. Test both actual system transitions and manual overrides, including an isolated AI panel and owner/detached synchronization. Preserve forced-colors accessibility and reduced-motion behavior.

Technical references: [prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme), [matchMedia](https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia), [color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme).

## 11. About, recognition and links

Reorder About around the technologies the Playground exists to run. Use this priority:

1. Joomla — [joomla/joomla-cms](https://github.com/joomla/joomla-cms).
2. Joomla Component Builder — [joomengine/Joomla-Component-Builder](https://github.com/joomengine/Joomla-Component-Builder).
3. JoomEngine Playground — [joomengine/playground](https://github.com/joomengine/playground).
4. PHP / phpdbg — [php/php-src](https://github.com/php/php-src).
5. MariaDB — [MariaDB/server](https://github.com/MariaDB/server).
6. Supporting runtime/bridge projects: Sean Morris / PHP-WASM, JoomEngine MariaDB WASM Bridge, lite4mariadb, Emscripten and other actually distributed runtime dependencies.
7. Editor and supporting UI technology: VS Code/Monaco, CodinGame integration and relevant contributors, after the runtime stack.

Use the established spelling Sean Morris. Supporting repository links include [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm), [joomengine/mariadb-wasm-bridge](https://github.com/joomengine/mariadb-wasm-bridge), [shyim/lite4mariadb](https://github.com/shyim/lite4mariadb), [emscripten-core/emscripten](https://github.com/emscripten-core/emscripten), [microsoft/vscode](https://github.com/microsoft/vscode), [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor) and [CodinGame/monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api). Verify against the actual dependency inventory before release.

Every technology's primary link goes to its GitHub repository, including JoomEngine Playground; do not send it to a license-file URL. Keep concise license information where needed and preserve required distributed licenses/notices/source material. Remove the repetitive vendor-focused paragraph from the normal About body. Keep the existing detailed attribution inventory accessible without repeating its full prose in the main explanation.

Suggested replacement explanation: “These projects work together to run Joomla, PHP, MariaDB and the code workspace in your browser. Your Playground site's files and database are stored locally in this browser.” Where AI is described, make clear that a selected external AI API receives the chosen context; do not imply that third-party AI inference necessarily runs locally.

## 12. Implementation order and checkpoints

| Phase | Work | Exit condition |
|---|---|---|
| 1 — Baseline and shared primitives | Recheck repository guidance; inventory all actions; integrate reviewed icon mapping, authoritative pearl rocket/favicon, shared button and theme tokens; define state transitions/migrations | No missing command coverage; icons render in both themes; behavior contracts agreed in code |
| 2 — Shell and navigation | Site/Admin; one dashboard; move More; language comboboxes; restore-tab positioning and scrolling | Navigation preserves runtime; dashboard actions target correct site; tabs behave at top/middle/bottom |
| 3 — Saved-site lifecycle | Separate selected/running state; Stop countdown; explicit manual Launch; rename/delete; last-route storage and migration | Existing saved data remains accessible; selection is non-destructive; launch/delete flows tested |
| 4 — Editor layout and windows | Compact Code identity/header; responsive icon/label behavior; toggle; detach/reclaim/redock/scroll | Embedded and detached editors retain work and use correct measured layouts |
| 5 — AI connections | Provider registry/adapters/model discovery; Other/local APIs; Accounts and isolated session sharing | Every shipped preset has a real validated configuration/adapter; representative protocols and a local endpoint pass browser checks; unexercised credential/account limits are recorded; keys stay isolated |
| 6 — AI context | In-panel browsable scopes, recursive folders, budget/exclusion feedback, enforcement in tools | Conversations use exactly the selected scope; edit review remains intact |
| 7 — Theme completion and About | Light/Dark toggle with live system realignment across all windows; About order/links/prose; full localization and visual pass | No mixed-theme surfaces or oversized duplicate branding; credits follow requested priority |
| 8 — Regression and handoff | Complete required checks, targeted browser scenarios and review evidence | All acceptance items below accounted for, with any real limitation explicitly recorded |

Build theme primitives early, then verify every later surface against them. AI connection protocol work and shell/saved-site work can proceed independently after shared state contracts are defined. Use small reviewable changes; do not perform a broad unrelated dependency/runtime upgrade as part of the UI work.

## 13. Acceptance and regression checklist

- [ ] The supplied pearl rocket replaces old interface rocket icons, including the favicon and Deployment/Launch; small sizes, positioning, both themes and existing manifest/fallback declarations are verified. The original launch-stage video/poster and reduced-motion fallback are preserved.
- [ ] Site/Admin sit beside Deployment, track actual route and switch without recreating the running site.
- [ ] Fork, Star and AI Assistant are icon-only with accessible names; other labelled buttons have icons and lose labels cleanly when constrained.
- [ ] The expanded dashboard contains all former More actions in a top-right row above saved-site details, with a divider; no duplicate main More menu remains. The appearance toggle sits beside Downloads.
- [ ] Hidden header/footer chrome collapses completely without a reserved strip. Compact absolute restore overlays sit exactly in the document corners and scroll away; neither follows the viewport in the middle.
- [ ] Top restore reveals and scrolls to header; bottom restore reveals and scrolls to footer; no Joomla control is covered.
- [ ] Both language fields visibly offer catalog values on focus/open and accept typed tags; multi-select and custom-package validation work.
- [ ] Startup countdown visibly runs 10 → 0, Stop cancels it, and manual selection never stops or launches a site by itself.
- [ ] Launch can switch to a staged target while another site runs, once dirty-work checks complete; repeated clicks/timer races do not duplicate launches.
- [ ] Rename preserves storage identity and data. Inactive delete never launches the site or deletes a different one. Locked/failed deletion is recoverable.
- [ ] Last saved site and safe last route resume; fresh/default/temporary/shared-link cases remain correct; old metadata migrates without loss.
- [ ] Main branding plus compact Code replaces the duplicate full logo; normal editor layout has one header row.
- [ ] Narrow editor widths hide labels first; only actions may collapse down; corner layout/window controls remain usable and anchored.
- [ ] Main Code action toggles embedded visibility without losing buffers/undo; detached state never creates a duplicate editor.
- [ ] Detach uses correct styles and theme, frees embedded space, handles blocked popups, scrolls properly and redocks on close/Return.
- [ ] OpenAI, Anthropic and Google are first; the expanded preset catalog and Other exist with correct AI API wording and documented configuration.
- [ ] Preset users need no standard base URL entry; Other accepts local/private endpoints, optional credentials and a usable model ID/list.
- [ ] Model fetch handles pagination/errors and chooses a suitable available default; no paid generation is used simply to populate a list.
- [ ] Accounts and assistant settings share the isolated session connection; keys remain masked and are not exported/logged/exposed to Joomla.
- [ ] Development-status labels are gone; actual connection/model errors remain useful.
- [ ] Context browser is inside the assistant and supports file/folder/project scope, unsaved buffers, limits and tool-scope enforcement.
- [ ] AI streaming, cancel, tool calls, diff review, accept/reject and undo retain their intended behavior for each supported adapter.
- [ ] One icon beside Downloads shows the active Light/Dark state and toggles it. The next system color-scheme event clears the manual override and realigns immediately; no System selector exists and unrelated sessions remain independent.
- [ ] Header/footer, all dialogs, Code, AI and detached windows use the chosen theme with readable icons, native controls and syntax colors. Light-mode JoomEngine lettering is solid black, without glare effects or a background plate.
- [ ] About order, concise explanation and technology repository links match section 11; distributed notices remain intact.
- [ ] Keyboard, focus, tooltip, screen-reader, zoom, narrow-screen, long-translation and reduced-motion behavior remain usable.

Extend the existing behavioral suites rather than only asserting source-text changes. Relevant starting points include `test/ui-state.test.mjs`, `test/launch-countdown.test.mjs`, `test/launch-ui-contract.mjs`, `test/deploys.test.mjs`, `test/code-host-lifecycle.browser.mjs`, `test/code-workbench.browser.mjs` and `test/code-ai.test.mjs`, plus frame/focus/AI browser suites present in the current checkout. Existing real popout tests cover some preservation behavior; add style, wheel/scroll, reclaimed owner space, theme and shared AI checks. A blocked-popup mock alone does not verify detachment.

Use the repository's current supported runtime and scripts. In the reviewed snapshot these include `npm run check`, `npm test`, `npm run build`, `npm run test:browser` and `npm run test:code-browser`; run provisioning tests if storage/deployment changes affect that layer. Follow the checked-out repository's setup and CI requirements, not a guessed install command. Test supported Chromium and Firefox paths and any additional browsers required by the project. Provider protocol fixtures do not replace a real browser smoke test with an actual supported provider and local endpoint; report which were exercised without publishing credentials.

## 14. Handoff boundaries and review evidence

This delivery prepares the plan and icon assets. It does not modify, merge or deploy the application. The implementing agent should carry the whole objective through, preserve existing user data, and report changes, validation and material limitations. Use screenshots or short recordings for wide/narrow light/dark layouts, top/bottom restoration and detached/redocked editor behavior. Record protocol tests and migration results separately from visual evidence.

The new pearl rocket is an explicit user choice; monochrome action mappings in the accompanying icon preview are the current selection round. Make any user-requested substitutions within the supplied bundle and regenerate all variants/mappings consistently. The archive contains no original README or license file, so record its source provenance and verify the applicable upstream release/notice before distributing the application; do not invent a license from the filenames. This does not require redrawing or replacing the user's selected icons.

Implementation defaults chosen where the discussion left options: startup-only automatic countdown; manual selection waits for Launch; Current File as the initial AI scope; Accounts opens shared AI API settings; tab-session theme override cleared by the next system change; an action-only collapsed strip at the narrowest editor widths. Keep these explicit in review so refinements do not accidentally alter the core requirements.

## Appendix A. Expanded AI API preset catalog

Official documentation reviewed 30 October 2026. These are configuration references, not authenticated browser test results. A name in the dropdown is not sufficient: implement the required adapter, discovery and actual browser connection. Verify endpoint changes and account access during implementation.

The first three rows define the required precedence. Following rows are a broad concrete starting catalog, not a popularity ranking. “Chat” means the provider-specific adapter for the named API; OpenAI-compatible still requires parameter, streaming, tool-call, and cancellation testing.

| Provider preset | API configuration | Model discovery and implementation note |
| --- | --- | --- |
| **1. OpenAI** | `https://api.openai.com/v1`; bearer key; Responses and/or Chat Completions adapter. | `GET /models`. Preserve full model IDs and filter for APIs/capabilities the editor implements. [Models](https://developers.openai.com/api/reference/resources/models/methods/list). |
| **2. Anthropic / Claude** | `https://api.anthropic.com`; native Messages adapter. Configure the required version and documented authentication headers internally. | `GET /v1/models`, paginated. Current catalog includes lifecycle and capability data; do not offer retired entries as defaults. [Models](https://platform.claude.com/docs/en/api/models/list). |
| **3. Google / Gemini** | `https://generativelanguage.googleapis.com/v1beta`; Gemini adapter with its API-key authentication. | `GET /models`, paginated. Filter for generation support and preserve native model identifiers. [Models](https://ai.google.dev/api/models). |
| DeepSeek | `https://api.deepseek.com`; bearer key; compatible chat adapter. | `GET /models`; current docs describe capability/limit metadata. [API overview](https://api-docs.deepseek.com/), [models](https://api-docs.deepseek.com/api/list-models/). |
| xAI / Grok | `https://api.x.ai/v1`; bearer key; compatible chat/Responses adapter as supported. | `GET /models`; `/language-models` provides additional language-model metadata. [Models](https://docs.x.ai/developers/rest-api-reference/inference/models). |
| Mistral AI | `https://api.mistral.ai/v1`; bearer key; chat adapter. | `GET /models`, with chat/function-call capabilities. [Models](https://docs.mistral.ai/api/endpoint/models). |
| Meta | `https://api.meta.ai/v1`; bearer key; documented Chat Completions, Responses, or Messages adapter. | `GET /models`. Respect account access. [API reference](https://dev.meta.ai/docs/api-reference). |
| Cohere | `https://api.cohere.com`; bearer key; native `POST /v2/chat` adapter. | `GET /v1/models?endpoint=chat`, paginated; do not append `/v2/models` merely because chat is v2. [Models](https://docs.cohere.com/v2/reference/list-models), [chat](https://docs.cohere.com/v2/reference/chat). |
| Alibaba Cloud / Qwen | Region/workspace preset; for example Singapore chat base `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`. Key and region must correspond. | Provider-specific `GET /api/v1/models`, with pagination and filters. Current docs show different catalog hosts by region and migration from DashScope hosts; derive from the selected regional configuration, not by appending `/models` to the chat base. [Chat compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [models](https://www.alibabacloud.com/help/en/model-studio/list-models). |
| Moonshot AI / Kimi | `https://api.moonshot.ai/v1`; bearer key; compatible chat adapter. | `GET /models`; account and regional keys are not interchangeable. [Models](https://platform.kimi.ai/docs/api/list-models), [quickstart](https://platform.kimi.ai/docs/get-your-api-key). |
| Z.ai / GLM | General API base `https://api.z.ai/api/paas/v4`; bearer key. Coding-plan endpoint is a distinct configuration, not an automatic substitute. | A general model-list method was not confirmed in the reviewed official API index. Validate documented discovery during implementation; otherwise ship a maintained provider catalog and allow a model ID. Do not invent a guaranteed `/models` operation. [API](https://docs.z.ai/api-reference/introduction), [official connection guidance](https://zcode.z.ai/en/docs/configuration). |
| MiniMax | `https://api.minimax.io/v1`; bearer key; compatible chat adapter. | Reviewed official compatibility docs list supported models but did not establish a model-list operation. Validate discovery before enabling it; provide catalog/manual fallback. Preserve required reasoning/tool message fields. [Compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api). |
| Perplexity | `https://api.perplexity.ai`; bearer key. Current public Agent API uses `POST /v1/agent` and requires its own adapter. | `GET /v1/models` catalogs Agent API models. Orchestrator uses a different `/orchestrator/v1` base/catalog and is described as private preview; do not silently mix them or assume old Sonar chat behavior. [Agent](https://docs.perplexity.ai/api-reference/agent-post), [models](https://docs.perplexity.ai/api-reference/models-get), [documentation index](https://docs.perplexity.ai/llms.txt). |
| Groq | `https://api.groq.com/openai/v1`; bearer key; compatible chat adapter. | `GET /models`; filter out non-chat models. [API reference](https://console.groq.com/docs/api-reference). |
| Cerebras | `https://api.cerebras.ai/v1`; bearer key; compatible chat adapter. | `GET /models`. [Models](https://inference-docs.cerebras.ai/api-reference/models/list-models). |
| Together AI | `https://api.together.ai/v1`; bearer key; compatible chat adapter. | `GET /models`; full vendor/model IDs. The current official compatibility page uses `.ai`; do not freeze an older `.xyz` example into the registry without rechecking. [Compatibility matrix](https://docs.together.ai/docs/inference/openai-compatibility). |
| Fireworks AI | `https://api.fireworks.ai/inference/v1`; bearer key; compatible chat adapter. | Reviewed official model management listing is `GET https://api.fireworks.ai/v1/accounts/{account_id}/models`. Confirm a suitable inference catalog or use the documented account catalog with availability filters; do not confuse stored models with callable serverless deployments. [Models](https://docs.fireworks.ai/api-reference/list-models), [text inference](https://docs.fireworks.ai/guides/querying-text-models). |
| OpenRouter | `https://openrouter.ai/api/v1`; bearer key; compatible adapter. Label as a multi-provider gateway. | `GET /models`; filter for text/tool capability and account/provider preferences. [Models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). |
| Hugging Face Inference Providers | `https://router.huggingface.co/v1`; Hugging Face bearer token; compatible chat adapter. Label as hosted routing. | `GET /models` includes provider metadata and tool support. [Hub API](https://huggingface.co/docs/inference-providers/hub-api), [provider overview](https://huggingface.co/docs/inference-providers/index). |
| NVIDIA hosted AI APIs / NIM | Hosted chat base `https://integrate.api.nvidia.com/v1`; bearer key. Self-hosted NIM belongs under Other/local or a local template. | Confirm the hosted catalog during implementation; the documented self-hosted NIM `GET /v1/models` does not by itself prove an equivalent hosted catalog contract. [Hosted LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis), [self-hosted NIM API](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html). |
| Microsoft Azure / Foundry | Resource endpoint, for example `https://{resource}.openai.azure.com/openai/v1`; documented API-key/token auth. | `GET /models` exists on the v1 route. Inference can require the user's deployment name rather than a catalog's base-model ID; retain a deployment selector/manual field. [Models](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/models), [endpoints](https://learn.microsoft.com/en-us/azure/ai-studio/ai-services/concepts/endpoints). |
| Amazon Bedrock | Region-aware preset. Runtime: `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`; compatibility Mantle: `https://bedrock-mantle.{region}.api.aws/v1`. Bedrock-specific credentials. | Runtime has no OpenAI-compatible model-list route; use native control-plane discovery. Mantle has `GET /v1/models`, but inference paths can differ by model. Implement provider-specific discovery/auth/routing rather than pretending these are identical bases. [Discovery](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html), [chat](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html). |
| Other / Local AI API | User-specified URL plus supported API format. Include **Ollama** `http://localhost:11434/v1` and **LM Studio** `http://localhost:1234/v1` templates. Key optional according to server configuration. | `GET /models` for compatible servers; editable model fallback. Ollama native `/api/tags` is a separate discovery option. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat), [LM Studio authentication](https://lmstudio.ai/docs/developer/rest/quickstart). |

