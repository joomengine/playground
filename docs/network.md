# Shared PHP HTTP networking

The PHP runtime uses one component-independent HTTP transport. An eligible public
GET or HEAD first uses browser Fetch. If that fails before a usable response, it
can make one attempt through the deployment's configured network service. Failure
then stops the request. No component names, repository mirrors, Power GUIDs or
expected response content participate in production routing.

The checked-in relay configuration is disabled. Source and local test success do
not establish that a public Worker is deployed. The operator must complete the
staging and release procedure in [the Worker guide](../services/network-worker/README.md)
before enabling `config/network.json`.

## Request paths

| Caller | Existing bridge | Shared boundary |
| --- | --- | --- |
| `curl_exec()` / Joomla cURL transport | Pinned `php-wasm-curl` Fetch implementation | `globalThis.__joomenginePhpFetch` in the PHP worker |
| `file_get_contents()`, `fopen()`, Joomla stream transport | `native/http-stream.c` → `src/php-http-stream.php` → native cURL | The same hook |
| PHP debugger requests | The same native extension in `src/code/debug-worker.mjs` | The same hook and shell session service |
| Static application files, PHP/WASM binaries, MariaDB assets | Ordinary browser/worker Fetch | Not intercepted by the PHP hook |

`native/curl-network.patch` carries the remaining cURL timeout, redirect preference
and redirect budget into `src/network-transport.mjs`. The native transport receives
the reconstructed upstream status, headers, body, effective URL and redirect count.
The existing stream adapter exposes response headers through PHP stream metadata
and `$http_response_header`; its ordinary `ignore_errors` handling still applies.

`src/php-network.mjs` retains the guard against synchronous requests back into the
same busy PHP site. Such a request cannot complete while that site's only PHP and
database session is executing its caller. When the shared network service is
enabled, every PHP HTTP request—including images—uses this transport with the
original URL. The legacy approved-image PHP route is used only while the shared
service is disabled or unconfigured; a shared-service denial never falls back to
that route. Browser image compatibility remains separate service-worker
functionality and does not grant general network access.

The baseline was `58b21b3d61c7415c231f8d180c388409b4910d74`. The earlier unmerged
PR #18 was closed. Its component-specific mirror selection is not incorporated;
useful compiler/repository regression coverage is adapted to the shared transport.
The investigation does not establish that PHP int64 or a particular historical
Playground commit caused the original network failure.

## Delivery and replay rules

| Condition | Result |
| --- | --- |
| Direct Fetch returns any usable HTTP response | Return it, including 401, 403, 404, 429 and 500 |
| Anonymous replay-safe GET/HEAD fails before response delivery | At most one relay attempt, within the remaining deadline |
| POST, PUT, PATCH, DELETE, authenticated or custom-credential request | Select direct/relay before dispatch; no fallback replay |
| Origin appears in `proxyOrigins` | Select relay before dispatch |
| Authorized HTTP URL from an HTTPS browser context, with relay enabled | Use relay, preserving HTTP rather than rewriting to HTTPS |
| HTTP URL from an HTTP development context or native Node caller | Try direct first unless its origin requires relay; eligible failures can use the relay |
| Abort, timeout, relay authorization/policy denial, rate limit | Stop; do not try another endpoint |
| Body fails after headers or data delivery | Fail the transfer; never append bytes from a second route |

Unknown request headers may contain API credentials, so they require the same
explicit relay/destination trust grant as `Authorization` and `Cookie`. Browser
ambient cookies are omitted. Credentials must be permitted both by client
`credentialGrants` and server `CREDENTIAL_ORIGINS`. Cross-origin redirects strip
sensitive headers. Permission for the old destination is not permission for a new
destination.

Direct requests containing credentials or custom headers reject automatic
redirects before dispatching a second request. Browser Fetch cannot safely strip
arbitrary API-key headers at an unobservable redirect. Configure that destination
in `proxyOrigins`, with its credential grant, when authenticated redirects are
required; the trusted relay can validate each hop and remove sensitive headers.

A Fetch exception can occur after an upstream server has already processed a
request. It is not evidence that retrying a write is safe. Upstream HTTP errors
are not proxy errors, and a generic browser transport failure is not automatically
labelled a CORS failure.

## Public deployment configuration

`config/network.json` is the production configuration. A build with
`PLAYGROUND_DEPLOYMENT_ENV=staging` selects `config/network.staging.json` instead.
Both builds write the selected normalized configuration to
`dist/config/network.json`; the staging source file is excluded from the static
artifact. This keeps the same source commit available for separately configured
staging and production builds. Configuration belongs to the Playground deployment.
Imported Joomla sites, deployment recipes, shared links and query parameters
cannot choose a relay.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Configuration schema, currently `1` |
| `enabled` | Allow configured relay delivery |
| `endpoint` | Trusted HTTPS relay base URL; `null` while disabled |
| `protocolVersion` | Wire protocol, currently `1` |
| `turnstileSiteKey` | Public widget site key for this deployment |
| `proxyOrigins` | Exact upstream origins that must use the relay on first dispatch |
| `credentialGrants` | Objects containing exact `relayOrigin` and `destinationOrigin` |
| `maxRedirects` | Client redirect ceiling, default `5` |

An explicit development-only option permits an HTTP loopback relay while testing
a loopback Playground. Production configuration requires HTTPS. These values are
public; none authenticates deployment or signs sessions. Relay session tokens and
Turnstile verification tokens remain in memory and are not saved in site exports,
local storage, IndexedDB, URL query strings or the browser build.

## Protocol version 1

| Operation | Request | Response |
| --- | --- | --- |
| `GET /healthz` | No secrets | Availability, protocol version, enabled state and controlled-origin mode |
| `POST /v1/session` | JSON `{version:1, turnstileToken}`; renewal uses relay bearer token | JSON `{version:1, token, expiresAt}`; expiry is Unix milliseconds |
| `POST /v1/fetch` | Relay bearer token, request metadata header and raw upstream body | Upstream metadata header and raw upstream body, or typed relay error |

The outer `Authorization: Bearer …` authorizes use of the relay. Upstream
authorization is contained only in the upstream header list. These are separate
credentials; the outer bearer token must never reach the target server.

`X-Playground-Request` contains unpadded base64url-encoded UTF-8 JSON:

```json
{
  "version": 1,
  "url": "https://example.org/api/resource?first=1&second=2",
  "method": "GET",
  "headers": [["Accept", "application/json"]],
  "redirect": "follow",
  "maxRedirects": 5,
  "timeoutMs": 20000,
  "forwardCredentials": false
}
```

The URL is the requested destination; query ordering and signed query contents are
not rebuilt. Metadata is bounded at 32 KiB including its encoded header value.
Uploads and ZIPs are raw bytes in the HTTP body, never base64 metadata.

An upstream response uses outer HTTP 200 and `X-Playground-Response` containing
encoded metadata with `version`, `status`, `statusText`, `headers` (name/value
pairs), `url`, `redirected` and `redirectCount`. The outer body is the raw upstream
body. HEAD and upstream 204/205/304 have no body. The client reconstructs the
upstream response before handing it to PHP. Upstream headers cannot override the
outer metadata, CORS policy or relay status.

A relay rejection uses outer non-200 status and JSON
`{version:1,error:{code,message}}`. `Retry-After` is exposed for rate limits.
Malformed metadata, unsupported protocol versions and incomplete bodies fail.
The Worker manually follows authorized redirects and validates every next origin;
an upstream Location never redirects the browser away from `/v1/fetch`.
Upstream Set-Cookie values, where returned as metadata, are never installed as
cookies on the relay's domain. The service does not provide a PHP cookie jar.

## Verification and startup

Verification is requested only when PHP actually needs relay access. The shell
shows a user-operated verification button and opens the exact deployment-local
`network-verify.html` page. That standalone page is outside COEP so Turnstile can
render while the PHP shell stays isolated. A random, short-lived BroadcastChannel
name connects the two even if COOP severs `window.opener`. The page cannot be
framed or act as a PHP runtime owner. The popup loads the fixed deployment
configuration; it does not accept a caller-supplied relay URL or widget site key.

The shell exchanges the single-use Turnstile proof for an opaque relay session.
Normal staging and production require Siteverify's expected hostname and action.
The separately protected automated staging mode uses official test credentials
and an additional CI-only authorization header; see the Worker guide. Public test
credentials alone cannot obtain a session, and production rejects that mode.
Concurrent requests share verification. Renewal preserves the same session identity
and cumulative budget; an expired session does not silently obtain a fresh quota.
Verification cancellation cancels the waiting request without restarting PHP.

Isolation remains capability-based: verified credentialless first, require-corp
only if required. No user-agent or screen-width classification is used. Startup
now verifies that session storage actually retained its navigation budget. A
blocked storage getter, failed write or silently discarded write stops before
automatic navigation. A host that removes the bootstrap marker receives a stable
error after the one takeover attempt. Networking failures never switch isolation,
reload the application or erase saved sites.

`test/isolation.browser.mjs` includes the actual `index.html` entry, marker loss,
storage failures, the verification exception and real Joomla startup with PHP and
MariaDB under capability fallback. Its small viewport is responsive-layout
evidence, not a physical phone result. Device model, OS/browser versions, top-level
versus embedded use, service-worker upgrade, background/resume and observed
navigation counts must be recorded separately before claiming the reported mobile
problem fixed. Memory eviction or a browser process crash is not repaired by a
navigation guard.

## Compatibility boundaries

- HTTP and HTTPS only. Raw TCP, SMTP, FTP, SSH, WebSocket tunnels and arbitrary
  database connections are outside this transport.
- The hosted Worker permits reviewed origins, not arbitrary public destinations.
  Extending its origin configuration does not require recompiling PHP.
- Browser Fetch controls direct TLS, forbidden headers, cookies and opaque
  redirects. Browser-unobservable direct redirect status/headers cannot be
  manufactured. Select relay delivery when an API needs server-side semantics.
- PHP stream TLS options `cafile`, `capath`, `local_cert`, `local_pk`,
  `peer_fingerprint` and `peer_name`, plus PHP-configured HTTP proxies, remain
  rejected by the stream adapter. The relay does not emulate TLS or client
  certificates.
- The pinned native bridge silently ignores `CURLOPT_COOKIEFILE` and
  `CURLOPT_COOKIEJAR`: PHP cookie-jar compatibility is not implemented. Explicit
  upstream Cookie headers or `CURLOPT_COOKIE` need a relay credential grant
  (direct browser Fetch cannot set a Cookie header). Set-Cookie can be returned as
  PHP metadata only; application-managed cookies must remain scoped to their
  destination and cannot become browser cookies for the relay.
- Exact redirect count and custom redirect ceilings cannot be guaranteed on a
  direct browser-followed redirect: Fetch exposes only whether a redirect
  occurred. Relay delivery reports its exact count and clamps the caller's budget
  to the deployment ceiling (default five). Native cURL's default of 30 and the
  stream adapter's default of 20 do not enlarge the relay allowance.
- Native connection/DNS/TLS tuning options cannot customize browser or Worker
  connections. Some unsupported cURL options are silently ignored by the pinned
  upstream extension; this change does not turn them into native networking.
- Browser/PHP buffers still consume memory even though the Worker streams bytes.
  The stream adapter retains its PHP-memory/upload budget. HTTP `fopen()` is a
  buffered read interface, not a network socket or writable remote file.
- One overall deadline includes verification and fallback. If the PHP caller's
  deadline is too short to complete interactive verification, that request times
  out; the transport does not silently extend it.
- Self-hosting is an optional future implementation of the same contract. No
  self-hosted service or automatic secondary endpoint is enabled by this change.

## Dependencies, licenses and evidence

The shared browser transport and Worker are original Apache-2.0 code. No source
was copied from WordPress's GPL proxy or Joomla's GPL reference Worker. They were
considered as architecture references, not silently relicensed dependencies.
The service pins Wrangler `4.158.0` (MIT OR Apache-2.0) and Miniflare
`4.20260730.0` (MIT); its lockfile pins the development dependency graph, including
workerd `1.20261104.1` (Apache-2.0). Bundled dependencies retain their own terms.

The existing native bridge remains pinned to `seanmorris/php-wasm-curl` commit
`6085917954da9682c32ebcbea27a626d2308381b`, archive SHA-256
`c27dbc1d9e9b1099b1db707544057bd554dc3c200cb38d2dadb249e374166203`.
`native/curl-network.patch` is recorded in the rebuilt extension's provenance;
unpatched cached binaries cannot satisfy that check. Its existing Apache-2.0 /
GPL-2.0-only dual-license notices, PHP notices and curl notices remain intact;
see [NOTICE](../NOTICE).

Release evidence must identify the final commit, all required CI jobs, the deployed
staging endpoint and browser versions. Live JCB proof must begin with absent
dependencies, fetch real indexes/files, compile the Demo, inspect actual generated
Power classes and unresolved placeholders, install it, open its dashboard, and
exercise entity import. A successful ZIP or mocked response alone is insufficient.
Keep hosted integration and physical-device results visibly outstanding until
they have actually run.

### Relay compression behavior

The controlled Worker returns decoded entity bytes for gzip, Brotli and deflate.
Gzip and Brotli use workerd's HTTP decoding; deflate passes through a streaming
`DecompressionStream`. Decoded responses omit upstream `Content-Encoding` and
compressed `Content-Length` metadata. HEAD keeps both entity headers and has no
body. Other encodings and compound encoding lists fail explicitly with
`UNSUPPORTED_TRANSPORT_OPTION`. Actual local workerd/SQLite tests verify binary
uploads/downloads, all three supported encodings, HEAD, upstream HTTP errors and
quota enforcement; these local fixtures do not certify the hosted deployment.
