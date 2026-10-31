# Adminer, browser isolation and public-image delivery

This branch adds a database workspace to the existing in-browser Joomla/PHP/MariaDB runtime, introduces verified per-tab isolation fallback and restricted approved-image delivery, and makes project credits follow one consistent order.

## Implementation objectives

### Database workspace
- [x] Pin and stage the multilingual MySQL/MariaDB Adminer distribution with checksum and required notices.
- [x] Adapt Adminer to the existing PDO transport without changing MariaDB, database credentials, stored data or engine builds.
- [x] Add the original committed database icon next to JoomEngine Code, with the short label DB, accessible Database name, correct light/dark rendering and icon-only narrow layout.
- [x] Reuse the active site's PHP, database and request queue; no second Joomla installation or database copy.
- [x] Support left/right/bottom dock, floating, full workspace, and detached window.
- [x] Show at most one embedded Code/Database panel. Detached tools may remain visible while another tool shares the site.
- [x] Preserve code buffers and database navigation/query drafts during tool switches; never replay a write when detaching.
- [x] Preserve site iframe identity, authentication, saved-site lifecycle, backup/export portability and lazy loading.

### Browser isolation
- [x] Prefer COEP credentialless with COOP same-origin; preserve normal URLs, PHP networking and zero automatic relay traffic.
- [x] Verify the controlling service worker, crossOriginIsolated, usable SharedArrayBuffer and required worker capabilities before runtime creation.
- [x] Fall back to require-corp through bounded controlled navigation only when credentialless fails verification.
- [x] Version startup state; distinguish initial takeover and fallback; stop with accurate diagnostics if neither succeeds without resetting storage.
- [x] Keep the confirmed policy fixed for the running page and scoped to its top-level owner, not global shared state.
- [x] Recover policy after worker suspension/restart using validated navigation/ownership metadata; propagate to preview, workers and detached windows.
- [x] Apply correct document/worker/error headers and avoid cache contamination between modes.
- [x] Provide a controlled fallback-disable switch independent of saved Joomla and deployment content.
- [x] Explain top-level and embedding limitations without user-agent or screen-size detection.

### Approved public images and relay
- [x] Inventory supported Joomla/JCB package and metadata image references; explicitly record scope and excluded assets.
- [x] Version a shared reviewed registry with asset IDs, canonical URLs, owner, type, byte limit, allowed redirects, available hashes and update/cache policy.
- [x] Keep registry authority server-side; extensions, imported configuration and caller URLs cannot add access.
- [x] Implement a separately hostable HTTPS relay for GET/HEAD public images only; document the actual deployment contract, configuration and rollback.
- [x] Add a deployment-relative service-worker asset route outside virtual Joomla/PHP routes; preserve the nested-request deadlock guard.
- [x] Enforce CORS for the configured Playground origin while separately enforcing registry and abuse limits.
- [x] Strip cookies, Authorization, arbitrary caller headers and upstream Set-Cookie.
- [x] Reject credential URLs, unapproved query parameters and redirects; enforce public destinations and DNS-rebinding controls.
- [x] Bound timeout, size, redirects, concurrency and rate; validate MIME, actual image format and original-byte hashes.
- [x] Exclude runtime SVG proxying unless explicitly reviewed and hash pinned with suitable protections.
- [x] Use one compatibility-gated resolver for approved browser images and PHP Fetch/cURL/stream downloads; preserve ordinary requests.
- [x] Cover approved src, srcset, picture, CSS and dynamic image requests with a verified browser mechanism.
- [x] Preserve cancellation, timeout, HTTP status and exact binary bytes; keep JCB checksum, format guards and verified-cache behavior.
- [x] Keep original source URLs portable; no proxy URL persistence in content, metadata, templates, database or exports.
- [x] Cache only validated public content with registry/content identity and explicit freshness; failed requests remain bounded diagnostics.
- [x] Record relay endpoint/deployment status honestly; never invent an operational endpoint or claim local relay testing proves production availability.

### Credits
- [x] Keep About order: Joomla; Joomla Component Builder; JoomEngine Playground; PHP; MariaDB; Sean Morris php-wasm; JoomEngine MariaDB WASM Bridge; lite4mariadb; editor projects; Adminer; all remaining acknowledgments below.
- [x] Make NOTICE follow that order, omitting JoomEngine Playground.
- [x] Reorder existing README credits consistently and add Adminer immediately after editor credits.
- [x] Place vector attribution among the remaining credits at the bottom, crediting the upstream project simply without discussing how the artwork was supplied or purchased.
- [x] Preserve legally required licenses and notices.

## Delivery and validation
- [x] Create an isolated branch from current main and open a draft PR immediately.
- [x] Push runtime implementation progressively; complete implementation before spending time on full test runs.
- [x] Run existing relevant checks and only focused new contract tests after implementation; repair failures before ready/merge.
- [x] Exercise normal/fallback modes, a deliberately restricted image fixture, exact PHP image bytes, rejected requests, relay outage, persistence/export, service-worker recovery and mixed-mode tabs.
- [x] Include available automated Chromium, Firefox and WebKit evidence, clearly separating responsive layout from runtime checks.
- [x] Leave real iPhone/iPad and representative Android testing to the maintainers after deployment, as requested; this is not a merge blocker.
- [ ] Mark ready for review and merge only after implemented changes pass relevant checks; report actual relay hosting requirements and any remaining limitations.


## Implementation and release status

Adminer, tool switching, per-owner isolation, the restricted relay, the reviewed
image registry and ordered credits are implemented. The relay-dependent fallback
ships **disabled** until an operator supplies and verifies a real HTTPS relay.
GitHub Pages serves only the static client; no deployed relay is invented here.
The build rejects enabling fallback without enabled relay configuration.

The Adminer executable bundle adds **445,011 bytes** (about **435 KiB**), or
**251,792 bytes** (about **246 KiB**) when its files are individually gzipped.
It loads only when DB is opened and reuses the existing PHP/MariaDB runtimes.

Validation recorded on 31 October 2026:

- Source syntax and the repository source suite pass; the latest totals and
  candidate CI status are recorded in the pull request.
- Real Adminer on PHP 8.3, 8.4 and 8.5 with MariaDB: table/schema browsing,
  Unicode SQL and exports, local session/CSRF protection; PHP 8.4 additionally
  exercises row editing and SQL file import.
- Chromium 156.0.8078.4: real Joomla authentication, Adminer SQL,
  Code/DB exclusion and detached coexistence, PHP restart, private tool routes,
  portable export, save/reload/reopen and unchanged saved database contents.
- Chromium 156.0.8078.4 and automated Linux WebKit 27.2: headerless hosting,
  controlled isolation bootstrap, shared WASM memory, nested workers, per-owner
  policies and reload recovery. Chromium also forcibly stops/restarts the SW.
- Both engines start real PHP 8.4, MariaDB and Joomla under `require-corp`.
  A fixture host deliberately has neither CORS nor CORP. Approved `src`,
  `srcset`, `picture`, CSS and dynamic images display; actual PHP streams and
  cURL receive the exact original 69-byte PNG with its SHA-256 intact.
- Normal-mode fixture traffic makes zero automatic relay requests. Relay outage,
  unknown registry IDs, invalid formats, redirects, oversize content and private
  destinations have bounded failure contracts.

The GitHub validation workflow builds the complete candidate and runs the
existing native/runtime/browser checks plus focused isolation, image and Adminer
coverage. Its final status gates readiness; the evidence above is not a claim
that an unfinished workflow passed.

Before enabling compatibility delivery, deploy the relay, verify its real
outbound access and all approved image IDs, configure its HTTPS address and
allowed Playground origin, and then enable fallback. All 31 canonical image
URLs were downloaded through this environment's standard HTTP transport on
2026-10-31: each returned HTTP 200 without redirects, matched the JCB metadata
MD5 and expected MIME, and now has a recorded SHA-256 and measured size in the
registry. The relay's separate direct DNS/pinned-HTTPS upstream check failed
with `EAI_AGAIN` before connection in this environment. The downloaded-byte
verification therefore does not certify the production relay's outbound access
or its deployment; fixture tests prove its controlled transport contract.
No physical iPhone/iPad or Android result is claimed. Maintainers perform those
checks after deployment as requested; they are not implementation merge blockers.

See [database usage](database-user-guide.md), [browser compatibility and rollout](browser-compatibility.md),
[approved image inventory](public-image-inventory.md), and [relay deployment](../relay/README.md).
