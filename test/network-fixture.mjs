import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createStaticServer } from './server.mjs';

export const fixtureOrigin = 'http://first.example.com';
export const writeOrigin = 'http://second.example.com';
export const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
export const binaryHash = createHash('sha256').update(binary).digest('hex');
const compressedBinary = gzipSync(binary);
export const compressedLength = compressedBinary.length;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

/** Test adapter only: real browser CORS, actual anonymous Worker and recorded upstream bytes.
 * The two example.com HTTP origins are mapped to a local fixture; no TLS claim is made.
 * All other upstream URLs retain normal TLS verification and are never substituted.
 */
export async function createNetworkFixture({ directory, liveOrigins = [], prefix = '/playground/', fixtures = {}, isolation = false } = {}) {
  const { createRelayWorker } = await import('../services/network-worker/src/index.mjs');
  const requests = [], relayRequests = [], liveReads = [], relayOperations = [];
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
    if (resource === '/redirect') { res.writeHead(302, { Location: `${upstreamOrigin}/denied/binary` }).end(); return; }
    if (resource === '/headers') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null })); return;
    }
    if (resource === '/echo') {
      res.setHeader('Content-Type', 'application/octet-stream'); res.end(body); return;
    }
    if (resource === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Legitimate HTTP content</title>'); return; }
    if (resource === '/compressed' || resource === '/compressed-not-modified') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Length', compressedLength);
      if (resource === '/compressed-not-modified') res.statusCode = 304;
      res.end(req.method === 'HEAD' || res.statusCode === 304 ? undefined : compressedBinary); return;
    }
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
    const mapped = mapFixture(input);
    const startedAt = Date.now();
    try {
      const request = input instanceof Request && mapped ? new Request(mapped, input) : mapped || input;
      const response = await fetch(request, init);
      if (mapped) Object.defineProperty(response, 'url', { value: `${new URL(original).origin}${new URL(response.url).pathname}${new URL(response.url).search}` });
      if (!mapped) liveReads.push({ event: 'response', url: original, status: response.status,
        contentType: response.headers.get('content-type') || '', contentEncoding: response.headers.get('content-encoding') || '',
        route: 'relay', startedAt, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      if (!mapped) liveReads.push({ event: 'requestfailed', url: original, route: 'relay', startedAt,
        durationMs: Date.now() - startedAt,
        error: ['AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'UPSTREAM_FETCH_FAILED' });
      throw error;
    }
  };
  const worker = createRelayWorker({ fetcher });
  relay = http.createServer(async (req, res) => {
    try {
      relayRequests.push({ path: req.url, method: req.method });
      if (!available) { res.writeHead(503, { 'Access-Control-Allow-Origin': appOrigin }).end('Unavailable'); return; }
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request(`${relayOrigin}${req.url}`, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.2' },
        signal: controller.signal, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await worker.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
  });
  relayOrigin = await listen(relay);
  const config = { endpoint: relayOrigin };
  app = await createStaticServer({ directory, prefix, isolation, fixtures: {
    ...fixtures,
    'config/network.json': JSON.stringify(config),
  } });
  appOrigin = new URL(app.url).origin;
  return { url: app.url, config, requests, relayRequests, liveReads, relayOperations, upstreamOrigin, relayOrigin,
    setAvailable(value) { available = Boolean(value); },
    async attach(context) {
      await context.route(/^http:\/\/(?:first|second)\.example\.com\//, route =>
        // Continue a real browser request. Fulfilling through Playwright would
        // bypass the browser's CORS checks and cannot prove this contract.
        route.continue({ url: mapFixture(route.request().url()) }));
    },
    async close() { await Promise.all([app.close(), close(relay), close(upstream)]); },
  };
}
