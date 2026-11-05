import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createStaticServer } from './server.mjs';

export const fixtureOrigin = 'http://first.example.com';
export const writeOrigin = 'http://second.example.com';
export const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
export const binaryHash = createHash('sha256').update(binary).digest('hex');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

/** Test adapter only: real browser CORS, actual Worker policy and recorded upstream bytes.
 * The two example.com HTTP origins are mapped to a local fixture; no TLS claim is made.
 * All other upstream URLs retain normal TLS verification and are never substituted.
 */
export async function createNetworkFixture({ directory, liveOrigins = [], prefix = '/playground/', fixtures = {}, isolation = false } = {}) {
  const { createRelayWorker } = await import('../services/network-worker/src/index.mjs');
  const { createTestEnvironment } = await import('../services/network-worker/test/helpers.mjs');
  const requests = [], relayRequests = [], liveReads = [];
  let app, relay, appOrigin, relayOrigin;
  let available = true;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/direct/')) {
      res.setHeader('Access-Control-Allow-Origin', appOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, User-Agent, Authorization, X-Proof');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Type, X-Proof');
    }
    if (req.method === 'OPTIONS') { res.writeHead(url.pathname.startsWith('/direct/') ? 204 : 403).end(); return; }
    res.setHeader('X-Proof', 'upstream');
    const resource = url.pathname.replace(/^\/(?:direct|denied)\//, '/');
    if (resource === '/status-text') {
      res.statusCode = 201; res.statusMessage = 'Créé'; res.end('created'); return;
    }
    if (resource.startsWith('/status/')) {
      res.statusCode = Number(resource.split('/').at(-1));
      res.setHeader('Content-Type', 'text/plain'); res.end(`upstream:${res.statusCode}`); return;
    }
    if (resource === '/redirect') { res.writeHead(302, { Location: `${fixtureOrigin}/denied/binary` }).end(); return; }
    if (resource === '/forbidden-redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end(); return; }
    if (resource === '/echo') {
      res.setHeader('Content-Type', 'application/octet-stream'); res.end(body); return;
    }
    if (resource === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Legitimate HTTP content</title>'); return; }
    if (resource === '/binary') {
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', binary.length);
      res.end(req.method === 'HEAD' ? undefined : binary); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, method: req.method }));
  });
  const upstreamOrigin = await listen(upstream);
  const mapFixture = input => {
    const url = new URL(input instanceof Request ? input.url : input);
    return [fixtureOrigin, writeOrigin].includes(url.origin) ? `${upstreamOrigin}${url.pathname}${url.search}` : null;
  };
  const fetcher = async (input, init) => {
    const original = input instanceof Request ? input.url : String(input);
    if (original === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json({ success: true, hostname: '127.0.0.1', action: 'network-session' });
    }
    const mapped = mapFixture(input);
    const response = await fetch(mapped || input, init);
    if (!mapped) liveReads.push({ event: 'response', url: original, status: response.status,
      contentType: response.headers.get('content-type') || '', route: 'relay' });
    return response;
  };
  const worker = createRelayWorker({ fetcher });
  let env;
  relay = http.createServer(async (req, res) => {
    try {
      relayRequests.push({ path: req.url, method: req.method });
      if (!available) { res.writeHead(503, { 'Access-Control-Allow-Origin': appOrigin }).end('Unavailable'); return; }
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request(`${relayOrigin}${req.url}`, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.2' },
        signal: controller.signal, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
  });
  relayOrigin = await listen(relay);
  const config = { schemaVersion: 1, enabled: true, endpoint: relayOrigin, protocolVersion: 1,
    turnstileSiteKey: '1x00000000000000000000AA', proxyOrigins: [writeOrigin], maxRedirects: 5,
    credentialGrants: [{ relayOrigin, destinationOrigin: writeOrigin }] };
  app = await createStaticServer({ directory, prefix, isolation, fixtures: {
    ...fixtures,
    'config/network.json': JSON.stringify(config),
  } });
  appOrigin = new URL(app.url).origin;
  env = createTestEnvironment({ fetcher, allowedOrigins: [appOrigin], upstreamOrigins: [fixtureOrigin, writeOrigin, ...liveOrigins],
    relayOrigin, credentialOrigins: [writeOrigin], turnstileHostname: '127.0.0.1' });
  return { url: app.url, config, requests, relayRequests, liveReads, upstreamOrigin, relayOrigin,
    setAvailable(value) { available = Boolean(value); },
    async attach(context) {
      await context.addInitScript(() => {
        globalThis.turnstile = { render(_container, options) { queueMicrotask(() => options.callback('network-fixture-verification')); return 'fixture'; }, remove() {} };
      });
      await context.route(/^http:\/\/(?:first|second)\.example\.com\//, route =>
        // Continue a real browser request. Fulfilling through Playwright would
        // bypass the browser's CORS checks and cannot prove this contract.
        route.continue({ url: mapFixture(route.request().url()) }));
      context.on('page', page => {
        // Every independently created PHP site owns its own session. Drive each
        // real modal without assuming one verification covers later sites.
        void (async () => {
          while (!page.isClosed()) {
            try {
              const button = await page.waitForSelector('button:has-text("Verify network access")', { timeout: 5000 });
              await button.click();
              await page.waitForSelector('button:has-text("Verify network access")', { state: 'hidden', timeout: 10000 });
            } catch { if (page.isClosed()) return; }
          }
        })();
      });
    },
    async close() { await Promise.all([app.close(), close(relay), close(upstream)]); },
  };
}
