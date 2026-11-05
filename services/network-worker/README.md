# Controlled Playground network service

This is the separately deployed server-side service for
[shared PHP networking](../../docs/network.md). GitHub Pages remains the static
Playground host. Both checked-in Worker environments start disabled and with empty
origin policies. No production endpoint or Cloudflare plan is assumed to exist.

## Deployment model

The Worker exposes `/healthz`, `/v1/session` and `/v1/fetch`. A SQLite-backed
`RelayCoordinator` Durable Object, bound as `RELAY_STATE`, maintains opaque
sessions and consistent request/byte budgets. One coordinator per deployment
provides an auditable hard budget. It deliberately favors bounded public-service
costs over unrestricted throughput; measure contention and usage before scaling.

This is a **restricted and abuse-controlled service**. Exact browser Origin checks
are additional policy, not authentication: a non-browser caller can forge Origin.
Turnstile-backed sessions, expiration, revocation, method/destination scopes and
quotas provide independent controls.

Only operator-reviewed origins are accepted. URL parsing rejects userinfo,
unsupported schemes, address literals including alternative IPv4 forms, localhost,
local/reserved-style hostnames, unauthorized ports and the relay itself. Redirects
are checked at every hop. The operator must review the ownership and egress
behavior of every approved upstream. Do not add customer-controlled wildcard
hosts, arbitrary redirectors or hostnames resolving into private infrastructure.

This Worker does **not** implement arbitrary-host DNS address pinning. A DNS lookup
followed by `fetch(hostname)` would resolve again; it is not a rebinding defense.
Cloudflare's `resolveOverride` is constrained by zone ownership and is not a
general public-host pinning interface. Broad public-host proxying requires a
separate verified egress/pinning service. Authentication alone does not supply it.

## Configuration and secrets

Each `env.staging` / `env.production` entry in `wrangler.jsonc` declares its own
bindings and variables. Keep both complete; environment bindings and variables
must not depend on accidental inheritance.

| Setting | Where | Meaning |
| --- | --- | --- |
| `ENABLED` | Worker variable | String `true` enables service, `false` is emergency stop |
| `DEPLOYMENT_ENV` | Worker variable | `staging` or `production` |
| `RELAY_AUDIENCE` | Worker variable | Exact deployed HTTPS origin |
| `ALLOWED_ORIGINS` | Worker variable | JSON array of exact permitted Playground origins |
| `UPSTREAM_ORIGINS` | Worker variable | JSON array of reviewed HTTP(S) upstream origins |
| `CREDENTIAL_ORIGINS` | Worker variable | Subset allowed to receive explicitly granted upstream credentials |
| `ALLOWED_METHODS` | Worker variable | JSON method array; defaults GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS |
| `ALLOWED_PORTS` | Worker variable | JSON port array, defaults 80 and 443 |
| `POLICY_VERSION` | Worker variable | Changing this invalidates existing sessions |
| `REVOKED_SESSION_IDS` | Worker variable | JSON stable-session-ID revocation list |
| `TURNSTILE_ACTION` | Worker variable | Expected widget action; must match the verification page |
| `TURNSTILE_TEST_MODE` | Worker variable | `false` normally; `true` only for separately protected automated staging |
| `LIMITS` | Worker variable | JSON overrides of the named limits in `src/policy.mjs` |
| `TURNSTILE_SECRET_KEY` | Worker **secret** | Siteverify secret for that environment's widget |
| `STAGING_TEST_SECRET` | Staging Worker **secret** | Additional high-entropy 32–256 character credential, required only in automated staging mode |
| `CLOUDFLARE_API_TOKEN` | Protected GitHub environment **secret** | Wrangler deployment authorization |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub environment variable | Owning account identifier |
| `NETWORK_CLOUDFLARE_PLAN` | GitHub environment variable | Recorded Workers plan used by the deployment |
| `NETWORK_PLAYGROUND_URL` | `network-staging` GitHub variable | HTTPS URL of the actual staging client built from the workflow's exact commit |
| `NETWORK_TEST_TARGET` | `network-staging` GitHub variable | Reviewed CORS-denied binary target used for actual PHP relay verification |
| `NETWORK_EXPECTED_SHA256` | `network-staging` GitHub variable | Expected SHA-256 of the target's body |
| `NETWORK_STAGING_TEST_SECRET` | `network-staging` GitHub **secret** | Same value as staging Worker's `STAGING_TEST_SECRET`, used only by hosted CI |
| Relay endpoint / Turnstile site key | Public `config/network.json` | Browser configuration; not secrets |

There is no `SESSION_SIGNING_KEY`: sessions use random opaque bearer tokens and
server-side state. Only a SHA-256 digest of the token is stored. Never put the
Cloudflare deployment token, widget secret or upstream user API keys into the
static build, site export, JSON configuration or browser storage.

Upstream `Authorization` is carried separately from relay bearer authorization.
Relay control headers never reach upstreams. Custom credential headers need the
same grant as Authorization/Cookie. Cookies returned by targets remain HTTP
metadata; they cannot become cookies for this service's domain.

## Initial provisioning

1. Select the owning Cloudflare account and record its Workers plan, CPU,
   request, subrequest, Durable Object storage and billing limits. Compare current
   [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
   and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
   No free-tier capacity or fixed cost is promised by this implementation.
2. Install the locked tooling and deploy the disabled staging service:

   ```bash
   cd services/network-worker
   npm ci
   npm test
   npm run check
   npm run build
   npx wrangler login
   npx wrangler whoami
   npx wrangler deploy --env staging
   ```

3. Record the actual deployed origin from Wrangler. Set staging `RELAY_AUDIENCE`
   to it. Set exact Playground and upstream origins, methods, credential policy
   and limits. The provided names are `joomengine-network-staging` and
   `joomengine-network`; these names do not establish a live URL by themselves.
4. Create separate Turnstile widgets for staging and production. Their allowed
   hostname must be the corresponding Playground verification-page hostname.
   Preserve the expected action. Provision staging's secret:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
   ```

   This prompts for the secret without placing it in shell history. Ordinary
   `secret put` creates and deploys a new Worker version. For a staged rollout,
   use `wrangler versions secret put` followed by reviewed version deployment,
   as described in [Cloudflare's secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).
5. Enable **staging** only after policy and secret values are complete. Deploy it
   and run the public endpoint's health, real session, contract/security and
   browser→Worker→upstream checks. Use official Turnstile test credentials only
   in isolated automated test deployments; production rejects test credentials.
6. Build the candidate Playground with staging's public endpoint and site key.
   Configure these in `config/network.staging.json`; the production configuration
   remains in `config/network.json`. Publish the staging build at the exact HTTPS
   URL recorded as `NETWORK_PLAYGROUND_URL`.
   For an isolated staging build that uses official Turnstile test keys, set
   `PLAYGROUND_DEPLOYMENT_ENV=staging` when running the build. The normal/default
   production build rejects test site keys; the Worker independently rejects
   test secrets in its production environment. A fake Turnstile API in the
   deterministic popup UI tests proves shell communication, not live Siteverify.
   Validate real PHP cURL and streams, both browser engines, the complete JCB
   workflow and startup/verification under both isolation modes. Keep the main
   published Playground unchanged while these checks run.
7. Bootstrap production independently, provision its own secret with
   `--env production`, and repeat the origin/limits review. Deploy a
   backward-compatible production Worker before publishing the client that uses
   it. Run production smoke checks after publication.

For a custom domain, choose an unused hostname in an active Cloudflare zone.
Use Workers & Pages → Worker → Settings → Domains & Routes → Add → Custom Domain.
Resolve conflicting DNS records first. `network.joomengine.org` is only a possible
operator choice; it is not asserted to exist. See
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

Bootstrap creation requires administrative access; routine deployment should use
a token restricted to the chosen account and existing Worker. Domain/route changes
need the relevant zone permissions. See
[Worker roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/).
GitHub deployment environments should restrict branches and require review for
production. Fork PRs must never receive deployment credentials or execute
untrusted code with those credentials. Validation must succeed independently of
production secrets, while a hosted acceptance gate must report missing staging
access as blocked/failing rather than passed.

## Hosted CI acceptance and isolated test mode

Use protected GitHub environments named `network-staging` and `network-production`.
The manually dispatched `network-staging.yml` first runs all source/runtime
validation, then requires reviewed, enabled staging configuration. It deploys the
Worker, verifies its real HTTPS endpoint and tests the hosted candidate's real PHP
cURL/stream binary hash and CORS behavior plus clean Joomla 5/6 JCB workflows.
The hosted page's build manifest must report this workflow's exact commit and
`deployment.environment=staging`. Missing variables, test secrets or evidence
fail the job; none is treated as a passing skipped test.

Automated hosted staging uses official Turnstile always-pass test credentials.
A live Siteverify check during this implementation returned the testing marker
`metadata.result_with_testing_key=true`, hostname `example.com` and no action for
the official dummy token. Its test response cannot satisfy the production
hostname/action checks. Those checks remain strict in normal staging and
production. The explicit automated mode therefore requires **all** of:

- `DEPLOYMENT_ENV=staging` and `TURNSTILE_TEST_MODE=true` on the Worker.
- The exact official always-pass Turnstile test secret and test token.
- A successful live Siteverify response bearing its testing-key marker.
- A separate random high-entropy `STAGING_TEST_SECRET` server secret, 32–256
  characters, on every `/v1/session` request, including renewals.

Provision the additional secret interactively with:

```bash
cd services/network-worker
npx wrangler secret put STAGING_TEST_SECRET --env staging
```

Store the same value as GitHub environment secret `NETWORK_STAGING_TEST_SECRET`.
The protected Playwright runner attaches it as `X-Playground-Staging-Test` only
to the configured relay's exact HTTPS `/v1/session` URL. It is never embedded in
JavaScript, browser configuration, exports, traces, upstream requests or logs.
Missing or incorrect credentials are explicitly tested to return 403 before
session issuance. Production rejects this mode and official test credentials.

Use normal staging with a real widget separately when evaluating the actual human
challenge experience. The test-mode run verifies real public networking,
Siteverify transport and session enforcement; it does not prove that a real user
passes a production challenge on every browser/device.

`network-production.yml` accepts `staging_run_id` and checks via GitHub's API that
the corresponding hosted staging workflow and acceptance step succeeded for the
**same commit**. It then deploys the production Worker and verifies health and
rejection policy. The Pages publication gate checks the production manifest and
configured endpoint before publishing an enabled client. Keep that production
deployment protected and activate it only after reviewing the staging evidence.

## Limits and sessions

Defaults are engineering starting points. Measure actual JCB compilation,
package downloads, concurrency and costs before raising them.

| Control | Default |
| --- | --- |
| Session lifetime / maximum renewed lifetime | 30 minutes / 2 hours |
| Minimum renewal interval | 60 seconds |
| Concurrent upstream requests per session | 4 |
| Requests per session per minute | 300 |
| Upload / response size | 8 MiB / 64 MiB |
| Cumulative response bytes per session | 512 MiB |
| Redirects / metadata header size | 5 / 32 KiB |
| Header / body-idle / total timeout | 20 / 30 / 120 seconds |
| Session issuance per IP per hour / global per hour | 10 / 1,000 |
| Deployment requests / bytes per day | 100,000 / 10 GiB |

The PHP request's remaining deadline can be shorter than the relay ceiling.
Renewing a token retains its session identity and usage counters. Sessions bind
to browser origin, audience and policy version. Altered, expired, revoked or
wrong-audience sessions fail. Issuance is separately bounded so discarding a
browser token is not an unlimited quota reset mechanism.

The coordinator accounts bytes while streaming and reserves capacity before
dispatch. Oversized or incomplete responses fail, including failures after
headers were sent. No truncated ZIP is returned as a successful transfer.
Cancellation closes upstream work. No shared content cache is enabled.

## Rollback and incident handling

1. To stop new relay work immediately, set that environment's `ENABLED` to
   `false` and deploy the configuration. Existing requests are still bounded by
   their deadlines. Do not erase Durable Object state to disable service; doing
   so would discard quota and revocation history.
2. To revoke all issued sessions, change `POLICY_VERSION`; for identified
   sessions use `REVOKED_SESSION_IDS`. Rotate the Turnstile secret if compromised.
3. To stop client attempts, publish `config/network.json` with `enabled:false`.
   Direct ordinary networking remains available; clients already running can
   still receive the server-side disabled response.
4. Roll back the client to the previously verified static artifact. Keep the
   server protocol backward compatible until old pages have aged out. Worker
   code rollback must preserve the Durable Object schema and budget state.
5. Retain request IDs, method, destination hostname, route, status, duration and
   bytes. Never log bearer tokens, Authorization/Cookie values, request/response
   bodies, full URLs, query strings, signed URLs or secrets.

Keep a deployment record with account/plan, endpoint, origin policy, commit and
Worker version, staging/production validation links, observed browser/device
versions and emergency-stop owner. A health HTTP 200 is only an availability
probe; it is not a complete release receipt.

## Development and future self-hosting

`npm test` runs deterministic protocol, authorization, quota and destination tests.
`npm run build` performs a Wrangler dry run against the pinned tooling. Production
verification additionally requires a real deployed public endpoint and actual
browser CORS enforcement with normal certificate validation.

The browser protocol is documented in [network.md](../../docs/network.md).
An optional self-hosted implementation must implement that contract and equivalent
authorization, streaming and accounting controls. A PHP/cURL service based on the
WordPress proxy can provide connection-time validated address pinning; preserve
its upstream licensing and original hostname for TLS verification. Its deployment
would need TLS termination, controlled egress, resource limits, health checks and
an independent session policy. It is not implemented or enabled here. A backend
behind Cloudflare or using Turnstile is not fully independent during a Cloudflare
outage. No automatic second relay bypasses a denial, rate limit or uncertain write.

### Compression and actual Worker runtime coverage

When the caller omits `Accept-Encoding`, the Worker explicitly requests
`gzip, br`. This keeps default negotiation stable across Fetch runtime upgrades
and avoids implicitly requesting an unsupported encoding such as zstd. Explicit
caller headers, including an empty value, remain unchanged. Unsupported response
encodings still fail explicitly.

The Worker delivers decoded HTTP entity bytes. workerd's native HTTP fetch
performs gzip and Brotli decoding; `deflate` uses a streaming
`DecompressionStream('deflate')` because workerd leaves that format encoded.
The response envelope removes `Content-Encoding` and the compressed
`Content-Length` only when a body was decoded. HEAD retains the upstream entity
encoding and length while returning no body. Unknown encodings and compound
encoding lists return `UNSUPPORTED_TRANSPORT_OPTION`; they never become raw
encoded bytes labelled as decoded data. Limits count decoded bytes.

`test/workerd.test.mjs` uses pinned Miniflare 4.20260730.0 and the actual Worker
module with a SQLite Durable Object. A local HTTP upstream supplies original
binary bytes, binary uploads, gzip, Brotli and deflate wire responses, HEAD and
HTTP 403. The suite verifies exact decoded bytes and metadata, separation of
relay credentials, and a quota rejection before another upstream dispatch.
Siteverify is a controlled HTTP fixture in this test. This proves local workerd
behavior, not a deployed Cloudflare endpoint or live Turnstile verification.

Byte counters saturate when an incoming chunk crosses a session or global
boundary; subsequent dispatches stop. Streaming limits cannot retract bytes
already in flight from an upstream server, and concurrent transfers can have
bounded in-flight data when a limit is reached. No crossing chunk is delivered
as a successful complete response. Session renewal preserves these counters.

### Client disconnect propagation

The pinned `2026-07-30` compatibility date requires the explicit
`enable_request_signal` compatibility flag, configured for staging and production.
The Worker passes `request.signal` explicitly when constructing the forwarded
request and calling the Durable Object stub; the coordinator links it to the
upstream request and its cleanup. This does not depend on the separate
`request_signal_passthrough` flag. Cloudflare makes incoming signals the default
only from compatibility date `2026-11-17` onward.

The actual workerd regression opens an HTTP connection directly to the Worker,
waits for an upstream request that has not returned headers, confirms its
concurrency reservation, then resets the client TCP connection. It requires the
upstream HTTP connection to close promptly and the same session to admit its next
request. A TCP FIN alone is a half-close and does not unambiguously mean the client
has abandoned reading its response; the test uses a reset to exercise cancellation.

References: [Cloudflare request-signal announcement](https://developers.cloudflare.com/changelog/post/2026-11-02-request-signal-default/)
and [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests).
