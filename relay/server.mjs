import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validatePublicAssetRegistry } from '../src/public-assets.mjs';
import { downloadApprovedAsset, RelayError, validateUpstreamURL } from './public-network.mjs';
import { IMAGE_TYPES, validateImageBytes } from './image-validation.mjs';

const DEFAULTS = Object.freeze({
  schemaVersion: 1, development: false, listen: { host: '127.0.0.1', port: 8787 },
  allowedOrigins: ['https://playground.joomengine.org'], timeoutMs: 15000,
  maxConcurrency: 8, requestsPerMinute: 120, globalRequestsPerMinute: 1200,
  maxTrackedClients: 4096, maxCacheBytes: 64 * 1024 * 1024, maxCacheEntries: 128,
});
const EXPOSE_HEADERS = 'Content-Type, Content-Length, ETag, X-Public-Asset-Id, X-Public-Asset-Registry, X-Public-Asset-SHA256';

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid relay configuration: ${label}`);
  return value;
}
export function validateRelayConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid relay configuration');
  const unknown = Object.keys(input).filter(key => !(key in DEFAULTS));
  if (unknown.length) throw new Error(`Unknown relay configuration field: ${unknown[0]}`);
  const config = { ...DEFAULTS, ...input, listen: { ...DEFAULTS.listen, ...input.listen } };
  if (config.schemaVersion !== 1 || typeof config.development !== 'boolean') throw new Error('Unsupported relay configuration version');
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.length > 10) throw new Error('Configure explicit allowedOrigins');
  config.allowedOrigins = config.allowedOrigins.map(origin => {
    const url = new URL(origin);
    const local = config.development && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (origin !== url.origin || url.username || url.password || url.protocol !== 'https:' && !local) throw new Error('Allowed origins must be canonical HTTPS origins');
    return origin;
  });
  if (Object.keys(config.listen).some(key => !['host', 'port'].includes(key)) || typeof config.listen.host !== 'string' || !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(config.listen.host)) throw new Error('Invalid relay listener');
  boundedInteger(config.listen.port, 1, 65535, 'listen.port');
  boundedInteger(config.timeoutMs, 100, 30000, 'timeoutMs');
  boundedInteger(config.maxConcurrency, 1, 64, 'maxConcurrency');
  boundedInteger(config.requestsPerMinute, 1, 10000, 'requestsPerMinute');
  boundedInteger(config.globalRequestsPerMinute, 1, 100000, 'globalRequestsPerMinute');
  boundedInteger(config.maxTrackedClients, 1, 100000, 'maxTrackedClients');
  boundedInteger(config.maxCacheBytes, 0, 256 * 1024 * 1024, 'maxCacheBytes');
  boundedInteger(config.maxCacheEntries, 0, 2048, 'maxCacheEntries');
  Object.freeze(config.listen); Object.freeze(config.allowedOrigins);
  return Object.freeze(config);
}

function registryMap(registries) {
  if (!Array.isArray(registries) || !registries.length || registries.length > 8) throw new Error('Load between one and eight reviewed registries');
  const versions = new Map();
  for (const source of registries) {
    const registry = validatePublicAssetRegistry(source);
    if (versions.has(registry.version)) throw new Error('Duplicate registry version');
    const assets = new Map();
    for (const asset of registry.assets) {
      // These are server-side checks independent of the browser resolver. The
      // only authority for upstream access is the operator's deployed registry.
      if (!IMAGE_TYPES.includes(asset.mime)) throw new Error('Relay excludes SVG and unsupported image formats');
      validateUpstreamURL(asset.url);
      for (const redirect of asset.redirects) validateUpstreamURL(redirect);
      if (!Number.isSafeInteger(asset.maxBytes) || asset.maxBytes < 1 || asset.maxBytes > 16 * 1024 * 1024) throw new Error('Invalid image byte limit');
      if (asset.sha256 && !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.md5 && !/^[a-f0-9]{32}$/.test(asset.md5)) throw new Error('Invalid image checksum');
      if (asset.cache.immutable && (!asset.sha256 || asset.updatePolicy !== 'pinned')) throw new Error('Immutable images require SHA256-pinned content');
      if (asset.updatePolicy === 'revalidate' && asset.cache.maxAgeSeconds > 3600) throw new Error('Mutable image refresh exceeds one hour');
      assets.set(asset.id, asset);
    }
    versions.set(registry.version, assets);
  }
  return versions;
}

function createRateLimiter(config, now) {
  let globalWindow = { since: now(), count: 0 };
  const clients = new Map();
  return key => {
    const time = now();
    if (time - globalWindow.since >= 60000) {
      globalWindow = { since: time, count: 0 };
      for (const [client, window] of clients) if (time - window.since >= 60000) clients.delete(client);
    }
    if (++globalWindow.count > config.globalRequestsPerMinute) return false;
    let current = clients.get(key);
    if (!current || time - current.since >= 60000) {
      if (!current && clients.size >= config.maxTrackedClients) return false;
      current = { since: time, count: 0 }; clients.set(key, current);
    }
    return ++current.count <= config.requestsPerMinute;
  };
}

/** An HTTP handler behind an operator-controlled HTTPS edge; no hosting account is assumed. */
export function createImageRelay({ registries, config: input, now = Date.now, transport, onDiagnostic = () => {} }) {
  const config = validateRelayConfig(input), versions = registryMap(registries);
  const allowedOrigins = new Set(config.allowedOrigins), admit = createRateLimiter(config, now);
  const cache = new Map(), active = new Set();
  let cacheBytes = 0;
  const cacheKey = (version, asset) => `${version}/${asset.id}/${asset.sha256 || asset.md5 || 'mutable'}`;
  function cached(key) {
    const value = cache.get(key);
    if (!value) return;
    cache.delete(key);
    if (value.expires <= now()) { cacheBytes -= value.bytes.length; return; }
    cache.set(key, value);
    return value;
  }
  function remember(key, value, ttl) {
    if (!ttl || !config.maxCacheEntries || value.bytes.length > config.maxCacheBytes) return;
    const old = cache.get(key);
    if (old) { cache.delete(key); cacheBytes -= old.bytes.length; }
    while (cache.size >= config.maxCacheEntries || cacheBytes + value.bytes.length > config.maxCacheBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheBytes -= cache.get(oldest).bytes.length; cache.delete(oldest);
    }
    cache.set(key, { ...value, expires: now() + ttl * 1000 }); cacheBytes += value.bytes.length;
  }
  function headers(response, origin) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    }
  }
  function json(response, request, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  }
  async function handler(request, response) {
    const origin = request.headers.origin;
    headers(response, origin);
    // Never trust forwarding headers. Behind a reverse proxy all callers share
    // the conservative socket limit; an edge may additionally rate-limit IPs.
    if (!admit(request.socket.remoteAddress || 'unknown')) {
      response.setHeader('Retry-After', '60'); json(response, request, 429, { error: 'rate-limit' }); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); json(response, request, 405, { error: 'method-not-allowed' }); return;
    }
    if (origin && !allowedOrigins.has(origin)) { json(response, request, 403, { error: 'origin-not-allowed' }); return; }
    if (request.url === '/healthz') {
      json(response, request, 200, { ok: true, contract: 1, registryVersions: [...versions.keys()] }); return;
    }
    const match = /^\/v1\/assets\/([a-z0-9][a-z0-9._-]{0,95})\/([a-z0-9][a-z0-9._-]{0,95})$/.exec(request.url || '');
    if (!match) { json(response, request, 404, { error: 'unknown-asset-route' }); return; }
    const [, version, id] = match, registry = versions.get(version), asset = registry?.get(id);
    if (!registry) { json(response, request, 404, { error: 'unsupported-registry-version', version }); return; }
    if (!asset) { json(response, request, 404, { error: 'unknown-asset-id', version, id }); return; }
    const key = cacheKey(version, asset);
    let value = cached(key);
    if (!value) {
      if (active.size >= config.maxConcurrency) {
        response.setHeader('Retry-After', '1'); json(response, request, 503, { error: 'relay-busy', version, id }); return;
      }
      const controller = new AbortController(); active.add(controller);
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const aborted = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', aborted);
      try {
        value = await downloadApprovedAsset(asset, { ...transport, signal: controller.signal });
        if (controller.signal.aborted) throw new RelayError('upstream-timeout', 504);
        value.sha256 = validateImageBytes(value.bytes, asset, value.mime);
        remember(key, value, asset.cache.maxAgeSeconds);
      } catch (error) {
        const failure = error instanceof RelayError ? error : new RelayError('image-validation-failed', 422);
        // Diagnostics intentionally contain IDs and bounded internal codes, not
        // source URLs, headers, credentials, or raw upstream response bodies.
        try { onDiagnostic({ version, id, code: failure.code }); } catch { /* Do not break requests on logging errors. */ }
        if (!response.destroyed) json(response, request, failure.status, { error: failure.code, version, id });
        return;
      } finally {
        clearTimeout(timeout); response.removeListener('close', aborted); active.delete(controller);
      }
    }
    if (response.destroyed) return;
    const etag = `"sha256-${value.sha256}"`;
    response.setHeader('Content-Type', value.mime);
    response.setHeader('Content-Length', value.bytes.length);
    response.setHeader('ETag', etag);
    response.setHeader('X-Public-Asset-Id', id);
    response.setHeader('X-Public-Asset-Registry', version);
    response.setHeader('X-Public-Asset-SHA256', value.sha256);
    const maxAge = value.expires === undefined ? asset.cache.maxAgeSeconds : Math.max(0, Math.floor((value.expires - now()) / 1000));
    response.setHeader('Cache-Control', `public, max-age=${maxAge}${asset.cache.immutable ? ', immutable' : ', must-revalidate'}`);
    if (request.headers['if-none-match'] === etag) {
      response.removeHeader('Content-Length'); response.writeHead(304); response.end(); return;
    }
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : value.bytes);
  }
  return {
    handler,
    get stats() { return { active: active.size, cacheEntries: cache.size, cacheBytes }; },
    close() { for (const controller of active) controller.abort(); cache.clear(); cacheBytes = 0; },
  };
}

export async function startRelay({ configFile, registryFiles }) {
  const config = validateRelayConfig(JSON.parse(await readFile(configFile, 'utf8')));
  const registries = await Promise.all(registryFiles.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const relay = createImageRelay({ registries, config, onDiagnostic: event => process.stderr.write(`${JSON.stringify(event)}\n`) });
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: config.timeoutMs + 5000, headersTimeout: 5000 }, (request, response) => {
    relay.handler(request, response).catch(() => { if (!response.headersSent) response.writeHead(500, { 'Cache-Control': 'no-store' }); response.end(); });
  });
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listen.port, config.listen.host, resolve); });
  server.once('close', () => relay.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), registryFiles = [];
  let configFile;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    if (!value || !['--config', '--registry'].includes(flag)) throw new Error('Usage: node relay/server.mjs --config FILE --registry FILE [--registry PREVIOUS_FILE]');
    if (flag === '--config') { if (configFile) throw new Error('Specify --config once'); configFile = value; }
    else registryFiles.push(value);
  }
  if (!configFile || !registryFiles.length) throw new Error('Supply an explicit relay configuration and reviewed registry file');
  const server = await startRelay({ configFile, registryFiles });
  process.stdout.write(`Public image relay listening on ${JSON.stringify(server.address())}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
