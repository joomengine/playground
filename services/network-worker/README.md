# Playground HTTP fallback Worker

This Worker forwards HTTP requests for the shared Playground transport. Requests
are anonymous and carry the destination in the `url` query parameter. It does
not require a session, user verification or a registered upstream destination.

The browser tries GET/HEAD directly first. A browser transport failure can use
this Worker once. Cross-origin writes go through the Worker once from the
outset when a fallback endpoint is configured. Upstream HTTP errors are returned
to the caller with their status and body.

## Deploy

The repository provides manually dispatched **Deploy network production** and
**Deploy network staging** workflows. Configure `CLOUDFLARE_API_TOKEN` as a
repository or environment secret and `CLOUDFLARE_ACCOUNT_ID` as a variable or
secret. Each workflow installs dependencies, runs the Worker tests and deploys
its Wrangler environment.

From this directory, the equivalent deployment commands are:

```sh
npm ci --ignore-scripts
npm test
npx wrangler deploy --env production
```

Use `--env staging` for the staging Worker. Wrangler uses your Cloudflare login
or the usual `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment
variables. No application secret or database binding is needed. The retained
Wrangler migration removes the Durable Object class used by older deployments.

Set the resulting public endpoint in `config/network.json`, or in
`config/network.staging.json` for a staging client build. Deploy the static client
normally. `null` selects direct Fetch only. Client startup does not probe Worker
health or run a qualification process.

Release the website and Worker from the same reviewed source revision. Updating
the website alone does not update the separately deployed Worker. Once both are
available, use the **Verify deployed networking** workflow to exercise the pair
over HTTPS. Select the branch or tag at the deployed website's source commit,
and provide its environment, website URL, Worker endpoint, a public test file
that denies cross-origin browser Fetch, and that file's decoded SHA-256. The
workflow runs ordinary PHP/JCB requests without deployment credentials and
retains its evidence; it does not deploy or change the public Worker.

## Protocol

A request targets `?url=<encoded-upstream-URL>` with the original HTTP method and
body. The optional `X-Playground-Request` header carries base64url JSON for
upstream headers, redirect options and a caller timeout. The response envelope
uses `X-Playground-Response` to preserve upstream status, headers and effective
URL while streaming the raw body. A request without the envelope receives the
ordinary upstream response with CORS headers.

`OPTIONS` handles browser preflight. `GET /healthz` reports the implementation
version for optional diagnostics. Neither route authorizes subsequent requests.

The Worker forwards application headers and removes connection/proxy transport
headers. Redirects preserve Fetch semantics and honor an explicit caller limit.
Caller cancellation and deadlines terminate the request. It does not introduce
per-user quotas, an upstream host list or a separate image transport.

## Tests

```sh
npm test
npx wrangler deploy --dry-run --env production
npx wrangler deploy --dry-run --env staging
```

The local tests exercise the Worker implementation and workerd behavior. They
require no deployment credentials. The separate hosted verification workflow
checks the deployed website and Worker together using actual PHP cURL/streams,
Joomla 5/6 and JCB repository and compiler operations. See
[the shared transport](../../docs/network.md#validation) for the inputs and
retained evidence.
