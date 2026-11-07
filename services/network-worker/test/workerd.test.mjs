import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { encodeMetadata, decodeMetadata } from '../src/index.mjs';

function runtime(upstream, extra = {}) {
  return new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    compatibilityDate: '2026-07-30', compatibilityFlags: ['enable_request_signal'],
    outboundService: { external: { address: `127.0.0.1:${upstream.address().port}`, http: { style: 'PROXY' } } },
    ...extra,
  });
}
function relayURL(path, base = 'https://proxy.example/') {
  const url = new URL(base); url.searchParams.set('url', `https://arbitrary-upstream.example${path}`); return url;
}
function metadataHeaders(options = {}) {
  return { 'X-Playground-Request': encodeMetadata({ version: 1, headers: [], redirect: 'follow', maxRedirects: 20, ...options }) };
}
const metadata = response => decodeMetadata(response.headers.get('X-Playground-Response'));

test('real workerd streams anonymous binary downloads/uploads, compression and redirects without bindings', { timeout: 30000 }, async () => {
  const received = [];
  const original = Buffer.from([0, 255, 128, 1, 2, 3, 0, 254]);
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ url: url.href, method: request.method, headers: request.headers, body });
    if (['/gzip', '/br', '/deflate'].includes(url.pathname)) {
      const encoding = url.pathname.slice(1);
      const compressed = ({ gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync })[encoding](original);
      response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': compressed.length, 'Set-Cookie': 'upstream=value' });
      response.end(compressed); return;
    }
    if (url.pathname === '/redirect') { response.writeHead(302, { Location: 'https://another-host.example/final?value=one%26two' }); response.end(); return; }
    if (url.pathname === '/error') { response.writeHead(403); response.end('upstream denied'); return; }
    response.setHeader('Content-Type', 'application/octet-stream'); response.end(body.length ? body : original);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const mf = runtime(upstream);
  try {
    const send = (path, options = {}, body) => mf.dispatchFetch(relayURL(path), { method: body ? 'POST' : options.method || 'GET', body, headers: metadataHeaders(options) });
    const binary = await send('/file?a=one%26two&b=three');
    assert.equal(metadata(binary).status, 200);
    assert.equal(new URL(received.at(-1).url).host, 'arbitrary-upstream.example');
    assert.equal(new URL(received.at(-1).url).pathname + new URL(received.at(-1).url).search, '/file?a=one%26two&b=three');
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), original);
    const upload = await send('/upload', { headers: [['Content-Type', 'application/octet-stream'], ['Authorization', 'Bearer upstream-token'], ['X-Api-Key', 'key']] }, original);
    assert.deepEqual(Buffer.from(await upload.arrayBuffer()), original);
    assert.equal(received.at(-1).headers.authorization, 'Bearer upstream-token');
    assert.equal(received.at(-1).headers['x-api-key'], 'key');
    assert.equal(received.at(-1).headers['x-playground-request'], undefined);
    for (const encoding of ['gzip', 'br', 'deflate']) {
      const compressed = await send(`/${encoding}`, { headers: [['Accept-Encoding', encoding]] });
      assert.equal(metadata(compressed).status, 200);
      assert.equal(metadata(compressed).headers.some(([name]) => ['content-encoding', 'content-length'].includes(name)), false);
      assert.equal(compressed.headers.get('set-cookie'), null);
      assert.equal(new Headers(metadata(compressed).headers).get('set-cookie'), 'upstream=value');
      assert.deepEqual(Buffer.from(await compressed.arrayBuffer()), original, encoding);
    }
    const head = await send('/gzip', { method: 'HEAD' });
    assert.equal(new Headers(metadata(head).headers).get('content-encoding'), 'gzip');
    assert.equal(await head.text(), '');
    const error = await send('/error');
    assert.equal(metadata(error).status, 403); assert.equal(await error.text(), 'upstream denied');
    const redirect = await send('/redirect');
    assert.equal(metadata(redirect).url, 'https://another-host.example/final?value=one%26two');
    assert.equal(metadata(redirect).redirectCount, 1);
    assert.deepEqual(Buffer.from(await redirect.arrayBuffer()), original);
  } finally { await mf.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('physical HTTP client cancellation cancels the upstream download', { timeout: 30000 }, async () => {
  let observed; let disconnected;
  const upstreamObserved = new Promise(resolve => { observed = resolve; });
  const upstreamDisconnected = new Promise(resolve => { disconnected = resolve; });
  const upstream = createServer((request, response) => {
    response.on('close', () => { if (!response.writableEnded) disconnected(); });
    observed();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const mf = runtime(upstream, { unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }] });
  let client;
  const deadline = (promise, milliseconds) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation deadline exceeded')), milliseconds); })]).finally(() => clearTimeout(timer));
  };
  try {
    const address = await mf.unsafeGetDirectURL();
    client = httpRequest(relayURL('/slow', address), { headers: metadataHeaders() });
    client.on('error', () => {}); client.end();
    await deadline(upstreamObserved, 3000);
    client.socket.resetAndDestroy(); client.destroy();
    await deadline(upstreamDisconnected, 3000);
  } finally { client?.destroy(); await mf.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
