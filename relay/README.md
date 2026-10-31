# JoomEngine Playground package relay

This optional Node.js service provides a browser-accessible HTTPS route to the
official Joomla full installation packages and JCB package ZIPs. It is a
separate service: **GitHub Pages only hosts static files and cannot run it.**
The Playground must be configured to use a deployed relay before the service can
be used. The service does not change the repository or deploy itself.

The relay accepts `GET /fetch?url=<encoded-upstream-url>` and `HEAD` for the
same route. The source must be a Joomla development full ZIP on
`developer.joomla.org`, a Joomla full release ZIP in `joomla/joomla-cms`, or a
tagged package in `joomengine/pkg-component-builder`. Redirects are followed
manually only to the corresponding allowed GitHub asset hosts and paths. Each
request has a 256 MiB streaming limit, a two-minute timeout, and a shared
eight-request concurrency limit. The response is not cached; in particular, a
fresh request for a moving nightly obtains the current upstream content.

The CORS response is restricted to the explicitly configured Playground origin.
This is not client authentication: non-browser clients can still request an
allowed public package. Apply suitable request-rate and bandwidth limits at the
HTTPS reverse proxy. Do not expose the Node listener publicly. The relay does not
create or assert an independent upstream checksum: clients must verify trusted
published checksums, and a hash calculated from a downloaded nightly only
identifies those bytes. This service does not add Joomla/PHP runtimes or apply
the JCB browser compatibility overlays.

## Test locally

Install Node.js 20 or newer, then run from this directory:

```bash
node --test test.mjs
node server.mjs
```

By default the development listener binds `127.0.0.1:8080` and accepts browser
requests from `https://playground.joomengine.org`. Environment variables
`RELAY_HOST`, `RELAY_PORT`, and comma-separated `RELAY_ALLOWED_ORIGINS` can be
used to configure it. Origins must be HTTPS, except local development origins.

## Run behind an existing Ubuntu HTTPS host

Use a dedicated HTTPS hostname whose DNS and certificate are already configured
on your server. The packaged service listens only on localhost port 8787 and
uses the official Playground origin by default. From the repository root, with
Node.js 20 or newer installed and available in the system service's `PATH`:

```bash
sudo install -d -m 0755 /opt/joomengine-playground-relay
sudo install -m 0644 relay/server.mjs /opt/joomengine-playground-relay/server.mjs
sudo install -m 0644 relay/joomengine-playground-relay.service /etc/systemd/system/joomengine-playground-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now joomengine-playground-relay.service
sudo systemctl status --no-pager joomengine-playground-relay.service
```

For Apache, enable `proxy` and `proxy_http`, and place the following inside that
hostname's existing TLS virtual host, alongside your normal access controls and
rate limits:

```apache
ProxyPass        /fetch http://127.0.0.1:8787/fetch
ProxyPassReverse /fetch http://127.0.0.1:8787/fetch
```

Reload Apache after validating its configuration:

```bash
sudo apachectl configtest && sudo systemctl reload apache2
```

Changing the HTTPS hostname, setting up its DNS/certificate, enabling the Apache
modules, or wiring the deployed URL into Playground are separate deployment
steps. Use a systemd drop-in to override the allowed origins or port; do not
change the packaged unit directly.
