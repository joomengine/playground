# Restricted public-image relay

This directory implements the server component of Playground's compatibility
image transport. **GitHub Pages cannot execute this server.** It must run on an
operator-controlled host with Node.js 26.12.1 (the repository's pinned runtime),
an HTTPS reverse proxy, and outbound HTTPS/DNS access. No hosting account,
hostname, TLS certificate or production deployment is implied by this source.
Relay-dependent fallback remains disabled until a real HTTPS relay is operational
and its production contract has been verified. The Adminer and compatibility code
can be reviewed, merged and deployed with that fallback disabled. Maintainers
perform real iPhone/iPad and Android checks after deployment; lack of physical
device access does not block merging the implementation.

## Start and deploy

The server has no third-party runtime dependencies. Copy the repository's
`relay/`, `src/public-assets.mjs`, and the reviewed `config/public-assets.json`
to the relay host. Keep the exact registry files with each deployed release.
Run the focused checks before deployment:

```sh
node --test test/public-image-relay.test.mjs
node relay/server.mjs --config relay/config.example.json --registry config/public-assets.json
```

The provided configuration binds to `127.0.0.1:8787` and permits CORS reads only
from `https://playground.joomengine.org`. Its schema is
[`config.schema.json`](config.schema.json); `validateRelayConfig()` in
[`server.mjs`](server.mjs) enforces these bounds at startup and rejects unknown
configuration fields. Run the process as an unprivileged service account under
the host's process supervisor. Termination closes active connections and clears
the public in-memory cache; restarting has no effect on saved Joomla data.

Alternatively, the supplied container provides the pinned Node runtime and runs
as the unprivileged `node` user, with no npm dependencies or installation step:

```sh
docker compose -f relay/compose.yaml up -d --build
curl --fail --silent http://127.0.0.1:8787/healthz
docker compose -f relay/compose.yaml logs --tail=50 public-image-relay
```

[`Dockerfile`](Dockerfile) uses Node.js 26.12.1 and a restricted build context.
[`compose.yaml`](compose.yaml) publishes the port **only on the host's
127.0.0.1**, drops Linux capabilities, disables privilege escalation, uses a
read-only container filesystem and applies process/memory/CPU limits. Its
[`config.container.json`](config.container.json) listens on the container's
interface so that the loopback-only host mapping can reach it. The configuration
and current reviewed registry are mounted read-only. The health check verifies
the local server; it does not verify the external HTTPS edge or image origins.
Stop this deployment with `docker compose -f relay/compose.yaml down`.

Configure the chosen HTTPS edge to forward only `/v1/assets/` and `/healthz` to
this loopback listener. Preserve the path, `Origin`, `If-None-Match` and HTTP
method. Do not rewrite failures into image responses or cache them as successes.
The relay independently ignores all caller credentials and arbitrary headers.
Restrict the listening port with the host firewall. The edge must terminate TLS
with a valid certificate and should apply additional request/header/connection
limits and a response timeout longer than `timeoutMs`.

The Node listener deliberately does not trust `X-Forwarded-For` or similar
headers. Behind a reverse proxy, callers therefore share the conservative
socket-address limit as well as the global limit. Add per-client limits at the
trusted edge and tune the documented bounded limits for the chosen deployment;
do not disable limits or make forwarding headers an authorization mechanism.

Use the actual assigned HTTPS base URL in the client's
`config/public-assets-config.json`. The base URL must end in `/`, and requests
append `v1/assets/<registry-version>/<asset-id>`. If an edge serves a base path,
strip that fixed base path before forwarding to the Node listener. There is no
arbitrary URL parameter or generic proxy route. A real same-origin HTTPS edge
can expose the same contract; GitHub Pages alone cannot.

## HTTP contract

| Request | Result |
| --- | --- |
| `GET /healthz` | JSON readiness and the loaded registry versions; no upstream fetch. |
| `GET /v1/assets/<version>/<id>` | Exact original, validated raster bytes for a deployed registry entry. |
| `HEAD /v1/assets/<version>/<id>` | The same status/headers without a body. A cache miss still downloads and validates the full image using upstream GET. |
| Unknown version or ID, query string, encoded path alias | `404`, JSON error, no upstream fetch. |
| Other methods | `405`, `Allow: GET, HEAD`, no upstream fetch. |
| Disallowed browser Origin | `403`; requests without Origin still face all registry/network/validation limits. |
| Rate limit / concurrency limit | `429` / `503`, with bounded `Retry-After`. |
| Oversized / invalid or changed image | `413` / `422`; never cached as an image. |
| Upstream failure / deadline | `502` / `504`; no retries and no runtime reset. |

Successful responses identify `X-Public-Asset-Id`, `X-Public-Asset-Registry`, and
the **actual** `X-Public-Asset-SHA256`; these and content headers are exposed to
the allowed CORS origin. `Access-Control-Allow-Credentials` is never sent.
Responses include `X-Content-Type-Options: nosniff`, a restrictive CSP,
`Cross-Origin-Resource-Policy: cross-origin`, and `Vary: Origin`. Upstream
`Set-Cookie` and caller cookies, authorization, origin and arbitrary headers are
never forwarded. Browser CORS permission is not authentication: direct clients
are equally constrained by the server's local registry and limits.

## Registry authority and image integrity

`src/public-assets.mjs` validates the same versioned schema used by Playground.
The server loads immutable operator-supplied files at startup; requests,
installed extensions, imported deployments and metadata cannot extend them.
Entries contain the exact canonical HTTPS URL, feature owner, image MIME type,
maximum bytes, exact permitted redirect targets, checksums, compatibility flag,
and cache/update policy. Every registry update needs review and a new version.
See the inventory evidence accompanying `config/public-assets.json`.

Only PNG, JPEG, GIF and WebP are supported. SVG, HTML, JavaScript, CSS, API
requests, credentials, uploads and extension archives are excluded. Both MIME
type and the actual raster container are checked; PNG chunks/CRC, JPEG markers,
GIF blocks and WebP chunks/dimensions are inspected. This is container validation,
not a pixel decoder or transcoder. Dimensions are bounded. Known SHA-256 and
JCB metadata MD5 values are checked over the original bytes. MD5 preserves JCB's
existing integrity contract; it is not used to claim cryptographic collision
resistance. No resizing, recompression, metadata stripping or format conversion
occurs. JCB independently retains its own checksum verification.

One reviewed upstream quirk is explicitly recorded for `jcb-builder-22`. Its
original GIF contains 229 decodable 480×540 frames and a trailer at zero-based
byte offset 2,168,647, followed by 310,076 bytes of raster residue (353 bytes of
compressed-looking data and 30 further GIF frame blocks). The entire original
file is 2,478,724 bytes, with SHA-256
`0013bf931f6ac48f9c1a6e72e80c7f71d2deddb87eae0d5e86914f0fbcfb47bd`.
The retained bytes match JCB's source MD5; the trailing region has no additional
GIF header, HTML/script/SVG/XML or ZIP signature. The registry's optional
`validation.gifTrailingData` records the exact parsed trailer offset and total
length. This allowance requires a GIF and SHA-256 pin: the relay checks the full
hash **before** accepting the explicitly reviewed remainder, and still parses
the preceding GIF frames normally. Every other GIF requires an exact terminal
trailer. No bytes are removed or rewritten; `image/gif`, `nosniff` and the
restrictive CSP continue to apply. Changing this image or allowance requires a
new source review, not a generic trailing-data exception.

HTTPS requests use only a fixed Accept header for the expected MIME type,
`Accept-Encoding: identity`, and the relay User-Agent. Credentials, fragments,
non-HTTPS URLs and nonstandard ports are rejected. Redirects are disabled unless
the exact destination is listed; at most three hops are permitted, and each hop
is independently checked. URL query parameters are allowed only when they are
part of the exact reviewed URL, never supplied by the caller.

Before each TLS connection, all DNS answers must be public addresses. The relay
rejects private, loopback, link-local, multicast, documentation, metadata and
reserved destinations, IPv4-mapped IPv6 and transition networks. It permits
conservative global-unicast IPv6 ranges. The selected checked address is pinned
in Node's actual `https.request` lookup callback, with the original hostname
retained for TLS certificate validation/SNI and no reused connection pool. DNS
rebinding cannot change the address between validation and connection. An egress
firewall denying private networks and infrastructure metadata is recommended as
a second layer on the actual host; it does not replace these application checks.

There is one deadline across DNS, every redirect, headers and body. Declared and
streamed sizes are bounded. Invalid, incomplete, encoded or oversized downloads
are discarded. Per-process concurrency, per-socket-address and global request
rates, tracked-client count, and cache memory/entry counts have enforced maxima.

## Cache and rollout

Only completely downloaded, validated public images enter the bounded memory
cache. Its key includes registry version, ID and expected SHA-256/metadata MD5.
Each successful image receives an ETag derived from its actual SHA-256.
`immutable` requires a pinned SHA-256 entry. Mutable `revalidate` entries have an
explicit TTL of at most one hour and receive `must-revalidate`; cache hits use
the remaining TTL rather than restarting the freshness window. Failures always
receive `Cache-Control: no-store`. No Joomla sessions or saved-site data enter
this cache.

Deploy the relay with the new registry **before** enabling clients that reference
it. Keep at least the previous client registry available while that client can
still be active. Repeat `--registry` to serve up to eight reviewed versions:

```sh
node relay/server.mjs --config relay/config.example.json \
  --registry config/public-assets.json \
  --registry config/public-assets.previous.json
```

The previous filename in that rollover example must contain the actual retained
release registry; it is not supplied or generated automatically. The readiness
endpoint lists loaded versions. Probe each approved ID through the production
HTTPS URL and compare returned SHA-256/MD5 to the approved original bytes. Also
probe unknown IDs, a disallowed Origin and a non-GET/HEAD method. Verify headers,
limits and no transformations at the HTTPS edge, not just the local listener.

The operator verification command checks every registered ID through the deployed
HTTPS endpoint with the configured Playground Origin. Set
`PUBLIC_IMAGE_RELAY_URL` to the actual deployed base URL, including its trailing
slash, then run:

```sh
: "${PUBLIC_IMAGE_RELAY_URL:?Set the actual deployed HTTPS relay base URL}"
node relay/verify.mjs \
  --base-url "$PUBLIC_IMAGE_RELAY_URL" \
  --config relay/config.example.json \
  --registry config/public-assets.json \
  --report .cache/relay-production-verification.json
```

The command has no live URL default. It allows at most four concurrent requests,
uses a bounded per-image timeout, rejects endpoint redirects, and verifies exact
image bytes against the shared raster parser and all registry checksums. It also
checks CORS, exposed identity/digest headers, response sizes and integrity. Each
asset's status, type, byte count, hashes or failure code is recorded in the JSON
report; any failure produces a nonzero exit code. For configurations with more
than one allowed origin, select one using `--origin`. Run this command successfully
against the deployed relay before enabling relay-dependent fallback.

Only after the relay is operational and its HTTPS contract is verified should
relay-dependent compatibility delivery be enabled. Missing relay hosting blocks
that enablement, not a code or Adminer release with fallback disabled. Run the
focused automated browser checks for the candidate. After deployment, maintainers
perform the real iPhone/iPad Safari and representative Android checks and record
browser/device versions, startup/shared-memory results, Joomla/JCB image bytes,
save/reload/export behaviour, service-worker restart, and two tabs with differing
policies. Those physical-device checks are follow-up validation, not a merge or
release gate. Node fixtures or desktop WebKit alone do not establish verified
iPhone support; report device results and remaining limitations when available.

Rollback disables the client's compatibility/fallback switches while leaving
normal credentialless operation and saved-site storage untouched. Keep the
previous relay registry online for already-open compatibility tabs. Do not
remove registry support until those clients have been retired. Relay failure
must remain an image error; neither the relay nor its diagnostics can restart
Joomla or MariaDB.

## Validation evidence

`test/public-image-relay.test.mjs` runs a controlled fixture image host that sends
neither CORS nor CORP and routes its bytes through the relay. It checks exact
bytes/hashes, CORS headers, no credential forwarding, versioned cache/HEAD/ETag,
unknown IDs and URLs, redirect restrictions, mixed public/private DNS answers,
pinned lookup, raster validation, truncation, timeouts, response limits,
concurrency and rate limits. Tests substitute only the HTTPS socket transport to
reach the local fixture; production always uses verified HTTPS and checked DNS.
The fixture does not certify the chosen production network or browser/device.

The initial development-host check attempted all 31 approved upstream URLs using
the relay's actual DNS/HTTPS controls (four concurrent requests, ten-second
deadlines). It verified zero images: all failed before connection with
`upstream-dns-failed`, and direct DNS diagnostics returned `EAI_AGAIN` for all
three source hosts and an unrelated baseline host. That direct-transport check
established no live upstream status, redirect, MIME or checksum result. A separate
source-inventory download through the environment's standard HTTPS proxy verified
all 31 canonical URLs with HTTP 200, expected MIME types and exact JCB metadata
MD5 values, and recorded their SHA-256 values without following redirects. That
source-byte evidence does not exercise the relay's pinned direct DNS/HTTPS path.
The deployed-endpoint verification above remains necessary; the direct DNS
failures are not evidence that an approved image itself is invalid or unavailable.
