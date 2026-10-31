# Browser isolation and approved public images

Playground keeps its existing PHP and MariaDB WebAssembly runtimes. Browser
compatibility changes neither database credentials nor saved-site storage.

| Mode | Document and dedicated-worker policy | External public images |
| --- | --- | --- |
| Normal | COOP `same-origin`, COEP `credentialless` | Original URLs and ordinary browser/PHP behavior; no automatic relay requests. |
| Compatibility | COOP `same-origin`, COEP `require-corp` | Only explicitly registered images use the restricted relay. Other requests retain normal browser restrictions. |

COEP selects the embedding policy. CORP permits particular cross-origin
embeddings. CORS permits reading a response from another origin. These are
separate permissions: an image that can be displayed is not necessarily readable
by PHP's browser Fetch transport.

## Startup and ownership

Before creating PHP or MariaDB, `prepareEnvironment()` registers the module
service worker, waits for its exact bootstrap version to control the page, and
performs a controlled navigation under `credentialless`. Verification checks
`crossOriginIsolated`, constructs shared WebAssembly memory, and exchanges that
memory through a dedicated module worker and a nested module worker. User-agent
names, screen size and similarly named properties do not select a mode.

If that controlled normal-mode document fails verification, an enabled fallback
gets one controlled navigation under `require-corp` and the same verification.
Both failures stop startup with a diagnostic. The session-scoped state records
the bootstrap version, initial takeover and attempted policies, so an image
failure cannot cause a runtime restart or a reload loop. A later deployment may
enable a previously untried fallback without requiring users to delete storage.

The validated `__je_coep` navigation marker identifies the current page's
bootstrap version and policy. It remains in the owner's URL during runtime
navigation but is excluded from shared deployment URLs and saved configuration.
The policy is independent for each owner page. No origin-wide cookie, localStorage
policy, mutable worker-global policy or database setting selects it.

Joomla URLs retain `__site/<owner-client-id>/<instance-id>/`. Static runtime
modules, worker entry points and tool windows use
`__runtime/<owner-client-id>/<original-static-path>`. The service worker resolves
the live owner's marker and fetches the original static bytes. Relative imports
and nested worker paths retain ownership. This permits recovery after service
worker suspension or updates without trusting an in-memory policy map. Response
headers are applied after cached bytes are retrieved, including relevant errors.
Closing the owning page makes its owned runtime routes unavailable.

The shared routing service worker itself does not need shared memory. Serve its
`service-worker.mjs` registration script without a restrictive COEP header, as
GitHub Pages does. A `require-corp` policy on that shared worker can restrict its
ordinary opaque-image forwarding for normal-mode tabs. PHP, MariaDB, editor and
probe dedicated workers still receive their owner's selected policy. Forwarded
normal-mode `no-cors` image requests explicitly omit credentials, preserving
`credentialless` behavior; CORS requests retain their existing semantics.

Start with direct top-level access. Embedding is supported only when the parent
page also provides compatible isolation. An embedded Playground owner must have
its own controlled marker and pass the same memory/worker checks. An iframe
permission cannot repair an incompatible parent. Virtual Joomla and tool frames
cannot promote themselves into runtime owners.

## Image delivery

The shared, versioned registry is [`config/public-assets.json`](../config/public-assets.json).
Its initial inventory records 31 exact JCB image URLs; the source evidence and
update procedure are documented alongside the registry. Neither extension
metadata nor a deployment document can add relay permissions.

In compatibility mode, the service worker intercepts approved image requests and
serves validated original bytes. That covers `src`, `srcset`, `picture`, CSS image
URLs and dynamic image creation without changing saved HTML or metadata. The
dedicated `__public-assets/<registry-version>/<asset-id>` route bypasses Joomla
and PHP. PHP's narrow Fetch adapter resolves approved unauthenticated GET/HEAD
image downloads through that route, preserving the nested-site-request guard.

The relay must allow CORS reads from the configured Playground origin. Approved
intercepted external images also carry CORP `cross-origin`: WebKit evaluates
their original external URL even when the response bytes were supplied by the
service worker. Only validated public raster images receive that permission;
documents, code, runtime responses and errors retain their ordinary policy.

The relay never resizes or recompresses images. Existing JCB checksums,
image-format guards and verified cached-image handling remain intact. Original
source references remain portable in database records, content and exports.
Unknown images are not silently approved or replaced. Image failures report
bounded diagnostics and do not reset a site or stop its database.

See [`relay/README.md`](../relay/README.md) for the server, HTTPS deployment,
registry enforcement, DNS/address restrictions, image validation, limits, caching
and the explicit exclusion of SVG from runtime relay delivery.

## Rollout and disable controls

The checked-in defaults are deliberately inactive for relay-dependent fallback:

- `config/browser-compatibility.json`: `fallbackEnabled: false`.
- `config/public-assets-config.json`: `enabled: false`, `relayBaseURL: null`.

Adminer and normal-mode clients can be deployed with these defaults. A supported
normal-mode page never depends on relay availability.

Before enabling compatibility delivery:

1. Deploy the restricted server on an actual HTTPS host and verify its CORS,
   exact image bytes, error behavior and deployed registry versions.
2. Set the client's real `relayBaseURL`, enable image delivery, and retain support
   for any registry version still used by the previous client release.
3. Enable `fallbackEnabled`, build and verify the deployed candidate. The build
   rejects enabling fallback while client relay delivery is disabled.

To disable new fallback sessions, set `fallbackEnabled: false` and deploy the
configuration. Normal mode is unchanged; affected clients receive an accurate
unsupported/disabled message. Do not reset saved sites or remove their storage.
An already running page keeps its selected mode until its next navigation; image
errors never select a different mode. Keep the relay available for old running
clients and supported previous registry versions during rollout.

The local server defaults to host COEP `none`, exercising the actual
service-worker bootstrap instead of masking it with server headers. Explicit
`PLAYGROUND_COEP=credentialless` or `PLAYGROUND_COEP=require-corp` exercises hosts
with document/worker headers; the registration script remains exempt.

## Recorded validation

Focused checks on 31 October 2026 passed with **Chromium 156.0.8078.4** and
**Playwright WebKit 27.2** on Linux:

- Headerless static hosting, controlled takeover, actual shared-memory and nested
  module-worker verification, and bounded fallback selection.
- Independent page policies, ownership-preserving worker URLs, detached static
  tool windows and reload recovery.
- Service-worker stop/restart recovery with two live policies in Chromium's
  DevTools protocol. WebKit was checked through document reload; it was not
  claimed to have the same forced-worker-stop mechanism.
- Approved restricted images in `src`, `srcset`, `picture`, CSS and dynamic
  creation pass through the production service worker; the CSS check verifies
  rendered pixels. The fixture first proves that its original HTTPS image host,
  which supplies neither CORS nor CORP, is blocked without compatible delivery.
- With the built runtime enabled, **actual PHP 8.4, MariaDB and Joomla start under
  `require-corp` in both browsers**. Native `file_get_contents()` and native cURL
  (including JCB's legacy User-Agent option) each receive the original 69-byte
  fixture with SHA-256
  `b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640`.
  Normal-mode tabs make zero automatic relay requests; a relay 503 leaves
  the page isolated and shared memory usable.

Run `node --test test/isolation.test.mjs` for the bounded-state and ownership
contracts. Run `node --test test/isolation.browser.mjs` for Chromium, or set
`PLAYGROUND_ISOLATION_BROWSER=webkit` for WebKit.
`PLAYGROUND_BROWSER_EXECUTABLE` can select an installed browser executable.

Run the image and native-PHP contract against the build with:

```bash
PUBLIC_ASSET_BROWSER=webkit PUBLIC_ASSET_RUNTIME_DIST=dist node --test test/public-assets.browser.mjs
PUBLIC_ASSET_BROWSER=chromium PUBLIC_ASSET_RUNTIME_DIST=dist node --test test/public-assets.browser.mjs
```

`PUBLIC_ASSET_BROWSER_EXECUTABLE` selects a browser binary when necessary;
`PUBLIC_ASSET_BROWSER_EVIDENCE` writes the machine-readable result to a chosen
path. Omitting `PUBLIC_ASSET_RUNTIME_DIST` runs only the rendering and JavaScript
Fetch-adapter checks and is not evidence of native PHP/MariaDB execution.

Automated WebKit is not a physical iPhone/iPad test, and responsive layout is not
runtime compatibility. Maintainers will test real iOS Safari and representative
Android browsers after deployment and record device/browser versions and any
memory or storage limitations. Those physical-device checks do not block merging
the implementation. Operational HTTPS relay verification is still required
before enabling a production client that depends on it. This document does not
claim universal browser support or an already deployed relay.
