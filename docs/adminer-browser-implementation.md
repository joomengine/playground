# Adminer, browser isolation and public-image delivery

This branch adds a database workspace to the existing in-browser Joomla/PHP/MariaDB runtime, introduces verified per-tab isolation fallback and restricted approved-image delivery, and makes project credits follow one consistent order.

## Implementation objectives

### Database workspace
- [ ] Pin and stage the multilingual MySQL/MariaDB Adminer distribution with checksum and required notices.
- [ ] Adapt Adminer to the existing PDO transport without changing MariaDB, database credentials, stored data or engine builds.
- [ ] Add the original committed database icon next to JoomEngine Code, with the short label DB, accessible Database name, correct light/dark rendering and icon-only narrow layout.
- [ ] Reuse the active site's PHP, database and request queue; no second Joomla installation or database copy.
- [ ] Support left/right/bottom dock, floating, full workspace, and detached window.
- [ ] Show at most one embedded Code/Database panel. Detached tools may remain visible while another tool shares the site.
- [ ] Preserve code buffers and database navigation/query drafts during tool switches; never replay a write when detaching.
- [ ] Preserve site iframe identity, authentication, saved-site lifecycle, backup/export portability and lazy loading.

### Browser isolation
- [ ] Prefer COEP credentialless with COOP same-origin; preserve normal URLs, PHP networking and zero automatic relay traffic.
- [ ] Verify the controlling service worker, crossOriginIsolated, usable SharedArrayBuffer and required worker capabilities before runtime creation.
- [ ] Fall back to require-corp through bounded controlled navigation only when credentialless fails verification.
- [ ] Version startup state; distinguish initial takeover and fallback; stop with accurate diagnostics if neither succeeds without resetting storage.
- [ ] Keep the confirmed policy fixed for the running page and scoped to its top-level owner, not global shared state.
- [ ] Recover policy after worker suspension/restart using validated navigation/ownership metadata; propagate to preview, workers and detached windows.
- [ ] Apply correct document/worker/error headers and avoid cache contamination between modes.
- [ ] Provide a controlled fallback-disable switch independent of saved Joomla and deployment content.
- [ ] Explain top-level and embedding limitations without user-agent or screen-size detection.

### Approved public images and relay
- [ ] Inventory supported Joomla/JCB package and metadata image references; explicitly record scope and excluded assets.
- [ ] Version a shared reviewed registry with asset IDs, canonical URLs, owner, type, byte limit, allowed redirects, available hashes and update/cache policy.
- [ ] Keep registry authority server-side; extensions, imported configuration and caller URLs cannot add access.
- [ ] Implement a separately hostable HTTPS relay for GET/HEAD public images only; document the actual deployment contract, configuration and rollback.
- [ ] Add a deployment-relative service-worker asset route outside virtual Joomla/PHP routes; preserve the nested-request deadlock guard.
- [ ] Enforce CORS for the configured Playground origin while separately enforcing registry and abuse limits.
- [ ] Strip cookies, Authorization, arbitrary caller headers and upstream Set-Cookie.
- [ ] Reject credential URLs, unapproved query parameters and redirects; enforce public destinations and DNS-rebinding controls.
- [ ] Bound timeout, size, redirects, concurrency and rate; validate MIME, actual image format and original-byte hashes.
- [ ] Exclude runtime SVG proxying unless explicitly reviewed and hash pinned with suitable protections.
- [ ] Use one compatibility-gated resolver for approved browser images and PHP Fetch/cURL/stream downloads; preserve ordinary requests.
- [ ] Cover approved src, srcset, picture, CSS and dynamic image requests with a verified browser mechanism.
- [ ] Preserve cancellation, timeout, HTTP status and exact binary bytes; keep JCB checksum, format guards and verified-cache behavior.
- [ ] Keep original source URLs portable; no proxy URL persistence in content, metadata, templates, database or exports.
- [ ] Cache only validated public content with registry/content identity and explicit freshness; failed requests remain bounded diagnostics.
- [ ] Record relay endpoint/deployment status honestly; never invent an operational endpoint or claim local relay testing proves production availability.

### Credits
- [ ] Keep About order: Joomla; Joomla Component Builder; JoomEngine Playground; PHP; MariaDB; Sean Morris php-wasm; JoomEngine MariaDB WASM Bridge; lite4mariadb; editor projects; Adminer; all remaining acknowledgments below.
- [ ] Make NOTICE follow that order, omitting JoomEngine Playground.
- [ ] Reorder existing README credits consistently and add Adminer immediately after editor credits.
- [ ] Place vector attribution among the remaining credits at the bottom, crediting the upstream project simply without discussing how the artwork was supplied or purchased.
- [ ] Preserve legally required licenses and notices.

## Delivery and validation
- [x] Create an isolated branch from current main and open a draft PR immediately.
- [ ] Push runtime implementation progressively; complete implementation before spending time on full test runs.
- [ ] Run existing relevant checks and only focused new contract tests after implementation; repair failures before ready/merge.
- [ ] Exercise normal/fallback modes, a deliberately restricted image fixture, exact PHP image bytes, rejected requests, relay outage, persistence/export, service-worker recovery and mixed-mode tabs.
- [ ] Include available automated Chromium, Firefox and WebKit evidence, clearly separating responsive layout from runtime checks.
- [ ] Leave real iPhone/iPad and representative Android testing to the maintainers after deployment, as requested; this is not a merge blocker.
- [ ] Mark ready and merge only after implemented changes pass relevant checks; report actual relay hosting requirements and any remaining limitations.
