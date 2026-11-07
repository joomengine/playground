# Browser isolation and external HTTP requests

Playground runs PHP and MariaDB in browser workers. MariaDB requires shared
WebAssembly memory and an isolated browser context.

| Mode | Document and dedicated-worker policy |
| --- | --- |
| Normal | COOP `same-origin`, COEP `credentialless` |
| Compatibility | COOP `same-origin`, COEP `require-corp` |

COEP controls embedding, CORP controls cross-origin resource use, and CORS
controls whether Fetch can read a response. PHP uses Fetch through the
[shared HTTP transport](network.md), so it has the same browser boundary.

## Startup and ownership

Before creating PHP or MariaDB, `prepareEnvironment()` registers the module
service worker, waits for its exact bootstrap version to control the page, and
performs a controlled navigation under `credentialless`. Readiness uses
`crossOriginIsolated` and availability of `SharedArrayBuffer`, `Atomics.add`,
`Worker` and `WebAssembly.Memory`. Startup does not construct test memory or
launch probe workers. User-agent names and screen size do not select a mode.

If that controlled normal-mode document is not ready, the default enabled
fallback gets one controlled navigation under `require-corp` and the same readiness check.
Both failures stop startup with a diagnostic. The session-scoped state records
the bootstrap version, initial takeover and attempted policies, so an image
failure cannot cause a runtime restart or a reload loop. A later deployment may
enable a previously untried fallback without requiring users to delete storage.
If the small compatibility configuration cannot be read, automatic fallback
remains available; a valid explicit `fallbackEnabled: false` disables it.

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
ordinary opaque-image forwarding for normal-mode tabs. PHP, MariaDB and editor
dedicated workers still receive their owner's selected policy. Forwarded
normal-mode `no-cors` image requests explicitly omit credentials, preserving
`credentialless` behavior; CORS requests retain their existing semantics.

Start with direct top-level access. Embedding is supported only when the parent
page also provides compatible isolation. An embedded Playground owner must have
its own controlled marker and meet the same browser requirements. An iframe
permission cannot repair an incompatible parent. Virtual Joomla and tool frames
cannot promote themselves into runtime owners.

## External images and package downloads

Original URLs remain in Joomla content, metadata and exports. In compatibility
mode, the service worker uses the same HTTP transport for external images.
There is no separate image registry or image-only relay. Image failures do not
restart the site or erase saved data.

Custom extension and template URLs are passed to Joomla's
`extension:install --url=URL` command. Joomla downloads and installs the package.
Its PHP request uses the same transport as cURL and HTTP streams. A failed custom
installation keeps its error available while the site opens.

## Development checks

Run `node --test test/isolation.test.mjs` for ownership and bootstrap behavior.
After building the runtime, run `node --test test/isolation.browser.mjs` for
real browser startup and the shared-memory exchange through nested workers in
`test/isolation-worker.mjs`. Run `node --test test/network-images.browser.mjs` for
external-image delivery through the actual service worker. Browser isolation is
selected by capability checks, not
screen dimensions or user-agent names. Physical mobile-device behavior must be
checked on the device separately.
