# Shared HTTP transport

PHP cURL, PHP HTTP streams and application downloads use
`src/network-transport.mjs`. The browser still provides the underlying Fetch
implementation. A configured Cloudflare Worker supplies the fallback when the
browser cannot expose a remote response.

## Request flow

| Request | Delivery |
| --- | --- |
| GET or HEAD | Direct Fetch first; one Worker attempt if Fetch fails or returns an unreadable opaque response. |
| Browser request with explicit Cookie, Origin or Referer | One Worker request so the browser does not discard the supplied headers. |
| Same-origin write | One direct request. |
| Cross-origin write with a configured endpoint | One Worker request, chosen before sending the body. |
| No configured endpoint | Direct Fetch. |
| HTTP response, including 401, 403, 404, 429 or 500 | Return that response to the caller. |
| Caller cancellation, deadline or incomplete delivered body | Fail the request without replaying it. |

The original HTTP/HTTPS URL and query string are preserved. The caller's body
and explicitly supplied headers are forwarded. The transport does not choose
repository mirrors, substitute content or require a destination registration.

`native/curl-network.patch` connects PHP's existing cURL Fetch implementation to
`globalThis.__joomenginePhpFetch`. PHP HTTP streams use `native/http-stream.c`
and `src/php-http-stream.php`, then the same cURL implementation. The normal PHP
worker, debugger worker and Node runtime install this shared transport.

Browser application downloads use `networkFetch()`. In require-corp
compatibility mode, the service worker also uses it for external images; image
URLs remain unchanged in stored Joomla content. The image path has no separate
registry or relay.

## Configuration

`config/network.json` contains the public fallback endpoint:

```json
{
  "endpoint": "https://joomengine-network.llewellyn-a59.workers.dev"
}
```

Use `"endpoint": null` for direct Fetch only. A staging build selects
`config/network.staging.json` using `PLAYGROUND_DEPLOYMENT_ENV=staging`. The
selected endpoint is included in the static distribution and its manifest.

The Worker is anonymous. It has no verification popup, session token,
per-destination grant or startup health prerequisite. Deploy it with the normal
Cloudflare deployment credentials as described in the
[Worker guide](../services/network-worker/README.md).

## HTTP bridge

The client sends the original method and raw body to the endpoint with a `url`
query parameter. `X-Playground-Request` carries base64url JSON containing the
upstream headers and redirect options, plus a remaining timeout when the caller
specified one. `X-Playground-Response` carries the upstream status, headers,
effective URL and redirect metadata. The response body stays raw binary data.
For proxied responses, this envelope preserves headers that ordinary browser
CORS would hide. Direct responses retain the browser's exposed headers.

The Worker removes connection and transport headers before making its upstream
request. Explicit Authorization and Cookie headers belong to that upstream
request; browser cookies for the proxy are omitted. Returned Set-Cookie values
are carried as response metadata and are not installed as proxy-domain browser
cookies. Direct browser Fetch does not expose Set-Cookie; this bridge does not
create a separate PHP cookie jar.

The Worker honors explicit redirect limits and removes Authorization, Cookie
and Proxy-Authorization when a redirect crosses origins. Direct browser Fetch
uses the browser's redirect limit. The Worker follows redirects with ordinary
Fetch method/header transitions and a default of 20 redirects, honoring a PHP
caller's explicit limit (including unlimited redirects). The transport does not impose an additional byte limit or
timeout; the caller's AbortSignal and timeout cover response consumption too.
The browser and Cloudflare platform retain their own runtime limits.

The Worker returns decoded gzip, Brotli and deflate body bytes and removes stale
encoding and compressed-length headers. HEAD and bodyless responses preserve
appropriate entity metadata without a body.

## Runtime boundaries

This remains an HTTP/HTTPS bridge, not arbitrary TCP networking. Direct browser
Fetch controls TLS, forbidden headers, ambient cookies and CORS. PHP cURL
settings cannot change those browser mechanisms. The PHP HTTP stream adapter
retains its documented stream behavior and unsupported-option errors.

Custom extension and template URLs are given to Joomla's
`extension:install --url=URL` command. Joomla downloads and installs them through
this PHP transport. Joomla validates extension archives during installation.
Runtime package downloads have no additional Playground checksum or size gate.
Build-time source pins and saved-site checkpoint integrity remain separate.

## Validation

`test/network-transport.test.mjs`, `test/network-contract.test.mjs` and the Worker
tests exercise the request flow, status handling, redirects, cancellation and
binary bodies. Native cURL/stream integration and browser networking tests cover
the PHP bridge. JCB integration checks fetch actual repositories and compile and
install the Demo. These are CI tests, not runtime access requirements.
