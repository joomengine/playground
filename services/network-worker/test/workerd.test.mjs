import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { encodeMetadata, decodeMetadata } from '../src/policy.mjs';

// Run the deployed module, SQLite Durable Object storage and stream plumbing in
// workerd. Only outbound HTTP is controlled; no production auth bypass is used.
test('actual workerd issues scoped sessions, streams binary uploads and decoded gzip, preserves errors and enforces DO quotas', { timeout: 30000 }, async () => {
  const received = [];
  const original = Buffer.from([0, 255, 128, 1, 2, 3, 0, 254]);
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (url.hostname === 'challenges.cloudflare.com') {
      const payload = JSON.parse(body);
      assert.equal(payload.secret, 'fixture-secret'); assert.equal(payload.response, 'verified-token');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, hostname: 'playground.example.com', action: 'network-session' })); return;
    }
    received.push({ url: url.href, method: request.method, headers: Object.entries(request.headers), body });
    if (['/gzip', '/br', '/deflate'].includes(url.pathname)) {
      const encoding = url.pathname.slice(1);
      const compressed = ({ gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync })[encoding](original);
      response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': compressed.length, 'Set-Cookie': 'upstream=secret' });
      response.end(compressed); return;
    }
    if (url.pathname === '/error') { response.writeHead(403); response.end('upstream denied'); return; }
    response.setHeader('Content-Type', 'application/octet-stream'); response.end(body.length ? body : original);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    compatibilityDate: '2026-07-30', compatibilityFlags: ['enable_request_signal'],
    durableObjects: { RELAY_STATE: { className: 'RelayCoordinator', useSQLite: true } },
    bindings: {
      ENABLED: 'true', DEPLOYMENT_ENV: 'staging', RELAY_AUDIENCE: 'https://relay.example.com',
      ALLOWED_ORIGINS: '["https://playground.example.com"]',
      UPSTREAM_ORIGINS: '["https://first.example.com"]', CREDENTIAL_ORIGINS: '[]',
      POLICY_VERSION: '1', TURNSTILE_ACTION: 'network-session', TURNSTILE_SECRET_KEY: 'fixture-secret',
      LIMITS: JSON.stringify({ requestsPerMinute: 7 }),
    },
    outboundService: { external: { address: `127.0.0.1:${upstream.address().port}`, http: { style: 'PROXY' } } },
  });
  try {
    const send = (path, init = {}) => mf.dispatchFetch(`https://relay.example.com${path}`, { method: 'POST', ...init,
      headers: { Origin: 'https://playground.example.com', 'CF-Connecting-IP': '198.51.100.2', ...init.headers } });
    const sessionResponse = await send('/v1/session', { body: JSON.stringify({ version: 1, turnstileToken: 'verified-token' }) });
    assert.equal(sessionResponse.status, 200, await sessionResponse.clone().text());
    const session = await sessionResponse.json(); assert.equal(session.token.length, 43);
    const relay = (path, metadata = {}, body) => send('/v1/fetch', { body, headers: { Authorization: `Bearer ${session.token}`,
      'X-Playground-Request': encodeMetadata({ version: 1, url: `https://first.example.com${path}`, method: 'GET', headers: [], redirect: 'follow', maxRedirects: 5, timeoutMs: 1000, ...metadata }) } });
    const binary = await relay('/binary'); assert.equal(binary.status, 200, await binary.clone().text()); assert.deepEqual(Buffer.from(await binary.arrayBuffer()), original);
    assert.equal(new Map(received.at(-1).headers).get('accept-encoding'), 'gzip, br');
    const upload = await relay('/upload', { method: 'POST', headers: [['Content-Type', 'application/octet-stream']] }, original);
    assert.equal(upload.status, 200); assert.deepEqual(Buffer.from(await upload.arrayBuffer()), original);
    assert.deepEqual(received.at(-1).body, original); assert.equal(received.at(-1).method, 'POST');
    assert.equal(new Map(received.at(-1).headers).get('accept-encoding'), 'gzip, br');
    const gzip = await relay('/gzip', { headers: [['Accept-Encoding', 'gzip']] }); assert.equal(gzip.status, 200);
    assert.equal(new Map(received.at(-1).headers).get('accept-encoding'), 'gzip');
    const gzipMetadata = decodeMetadata(gzip.headers.get('x-playground-response'));
    assert.equal(gzipMetadata.headers.some(([name]) => ['content-encoding', 'content-length'].includes(name)), false);
    assert.equal(gzip.headers.get('set-cookie'), null);
    assert.deepEqual(Buffer.from(await gzip.arrayBuffer()), original);
    for (const encoding of ['br', 'deflate']) {
      const compressed = await relay(`/${encoding}`, { headers: [['Accept-Encoding', encoding]] });
      assert.equal(compressed.status, 200); assert.deepEqual(Buffer.from(await compressed.arrayBuffer()), original, encoding);
      assert.equal(new Map(received.at(-1).headers).get('accept-encoding'), encoding);
    }
    const head = await relay('/gzip', { method: 'HEAD' });
    const headMetadata = decodeMetadata(head.headers.get('x-playground-response'));
    assert.equal(headMetadata.headers.find(([name]) => name === 'content-encoding')?.[1], 'gzip');
    assert.equal(headMetadata.headers.find(([name]) => name === 'content-length')?.[1], String(gzipSync(original).length));
    assert.equal(await head.text(), '');
    const error = await relay('/error'); assert.equal(error.status, 200); assert.equal(decodeMetadata(error.headers.get('x-playground-response')).status, 403); assert.equal(await error.text(), 'upstream denied');
    const limited = await relay('/binary'); assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    assert.equal(received.length, 7);
    assert.ok(received.every(call => !call.headers.some(([name]) => name === 'authorization' || name.startsWith('x-playground-') || name.startsWith('x-relay-'))));
  } finally { await mf.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('physical HTTP client reset cancels workerd upstream work and releases the session reservation', { timeout: 30000 }, async () => {
  const configuration = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const environment of [configuration, configuration.env.staging, configuration.env.production]) {
    assert.ok(environment.compatibility_flags.includes('enable_request_signal'));
  }
  let observed; let disconnected;
  const upstreamObserved = new Promise(resolve => { observed = resolve; });
  const upstreamDisconnected = new Promise(resolve => { disconnected = resolve; });
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    for await (const _chunk of request) { /* Drain the complete request envelope. */ }
    if (url.hostname === 'challenges.cloudflare.com') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, hostname: 'playground.example.com', action: 'network-session' })); return;
    }
    if (url.pathname === '/slow') {
      response.on('close', () => { if (!response.writableEnded) disconnected(); });
      observed(); return; // No headers yet: only incoming Request.signal can stop this fetch promptly.
    }
    response.end('released');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    compatibilityDate: '2026-07-30', compatibilityFlags: configuration.env.staging.compatibility_flags,
    unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
    durableObjects: { RELAY_STATE: { className: 'RelayCoordinator', useSQLite: true } },
    bindings: {
      ENABLED: 'true', DEPLOYMENT_ENV: 'staging', RELAY_AUDIENCE: 'http://relay.example.com',
      ALLOWED_ORIGINS: '["https://playground.example.com"]', UPSTREAM_ORIGINS: '["https://first.example.com"]',
      CREDENTIAL_ORIGINS: '[]', POLICY_VERSION: '1', TURNSTILE_ACTION: 'network-session', TURNSTILE_SECRET_KEY: 'fixture-secret',
      LIMITS: JSON.stringify({ concurrent: 1, headerMs: 20000, totalMs: 30000 }),
    },
    outboundService: { external: { address: `127.0.0.1:${upstream.address().port}`, http: { style: 'PROXY' } } },
  });
  let client;
  const deadline = (promise, milliseconds, message) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
  };
  try {
    const address = await mf.unsafeGetDirectURL();
    const sessionResponse = await mf.dispatchFetch('http://relay.example.com/v1/session', { method: 'POST', headers: {
      Origin: 'https://playground.example.com', 'CF-Connecting-IP': '198.51.100.2',
    }, body: JSON.stringify({ version: 1, turnstileToken: 'verified-token' }) });
    assert.equal(sessionResponse.status, 200, await sessionResponse.clone().text());
    const { token } = await sessionResponse.json();
    const headers = path => ({
      Host: 'relay.example.com', Origin: 'https://playground.example.com', Authorization: `Bearer ${token}`,
      'X-Playground-Request': encodeMetadata({ version: 1, url: `https://first.example.com${path}`, method: 'GET', headers: [], redirect: 'follow', maxRedirects: 5, timeoutMs: 30000 }),
    });
    client = httpRequest(new URL('/v1/fetch', address), { method: 'POST', headers: headers('/slow') });
    client.on('error', () => {}); client.end();
    await deadline(upstreamObserved, 3000, 'The physical client request did not reach the upstream fixture.');
    const before = await mf.dispatchFetch('http://relay.example.com/v1/fetch', { method: 'POST', headers: headers('/after') });
    assert.equal(before.status, 429, 'The in-flight request must occupy the session concurrency slot.');
    // A reset is an unambiguous aborted request. A TCP FIN alone can mean only
    // that the peer finished sending and still intends to receive the response.
    client.socket.resetAndDestroy();
    client.destroy(); // Real HTTP connection cancellation, not an injected AbortController.
    await deadline(upstreamDisconnected, 3000, 'Client disconnect did not cancel the upstream HTTP connection.');
    const after = await mf.dispatchFetch('http://relay.example.com/v1/fetch', { method: 'POST', headers: headers('/after') });
    assert.equal(after.status, 200, await after.clone().text()); assert.equal(await after.text(), 'released');
  } finally {
    client?.destroy(); await mf.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
