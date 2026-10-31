import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createImageRelay, validateRelayConfig } from '../relay/server.mjs';
import { isPublicAddress, validateUpstreamURL, resolvePublicDestination, downloadApprovedAsset } from '../relay/public-network.mjs';
import { validateImageBytes } from '../relay/image-validation.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaPjwHwAE5AKQBYzgxgAAAABJRU5ErkJggg==', 'base64');
const SHA = createHash('sha256').update(PNG).digest('hex');
const MD5 = createHash('md5').update(PNG).digest('hex');
const ORIGIN = 'https://playground.joomengine.org';
function asset(overrides = {}) {
  return { id: 'pixel', url: 'https://images.example.test/pixel.png', owner: 'Relay test fixture', mime: 'image/png', maxBytes: 1024,
    redirects: [], sha256: SHA, md5: MD5, compatibilityRequired: true, updatePolicy: 'pinned', cache: { maxAgeSeconds: 60, immutable: true }, ...overrides };
}
function registry(assets = [asset()], version = 'test-v1') { return { schemaVersion: 1, version, assets }; }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }

/** This host intentionally sends neither CORS nor CORP. Only the server relay may read it. */
async function fixtures(t, { assets, registries, config = {}, now } = {}) {
  const observed = [], pinned = [];
  const source = http.createServer((req, res) => {
    observed.push({ url: req.url, headers: req.headers, method: req.method });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/pixel.png' }); res.end(); return; }
    if (req.url === '/bad-redirect') { res.writeHead(302, { Location: 'https://unapproved.example.test/private' }); res.end(); return; }
    if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>upstream error</html>'); return; }
    if (req.url === '/fake.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('<html>not an image</html>'); return; }
    if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write(PNG); res.end(Buffer.alloc(2048)); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return; }
    if (req.url === '/truncated') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 1000 }); res.write(PNG); setTimeout(() => res.destroy(), 10); return; }
    const respond = () => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length, 'Set-Cookie': 'upstream=never-forward' }); res.end(PNG); } };
    if (req.url === '/slow') setTimeout(respond, 300); else respond();
  });
  const sourcePort = await listen(source);
  const transport = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request(url, options, callback) {
      options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.ifError(error); pinned.push(addresses); });
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, 'images.example.test');
      assert.equal(options.agent, false);
      // Test-only HTTPS transport substitution. Production always uses
      // node:https with certificate validation and the checked DNS address.
      return http.request(`http://127.0.0.1:${sourcePort}${url.pathname}`, { method: options.method, headers: options.headers }, callback);
    },
  };
  const diagnostics = [];
  const relay = createImageRelay({ registries: registries ?? [registry(assets)], config, now, transport, onDiagnostic: e => diagnostics.push(e) });
  const gateway = http.createServer((req, res) => { relay.handler(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  const port = await listen(gateway), base = `http://127.0.0.1:${port}`;
  t.after(async () => { relay.close(); await close(gateway); await close(source); });
  return { relay, base, sourcePort, observed, pinned, diagnostics, get: (suffix = 'test-v1/pixel', init = {}) => fetch(`${base}/v1/assets/${suffix}`, init) };
}

test('public destination validation rejects internal, metadata, reserved and transition addresses', async () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.20.30.40', '100.100.100.200', '169.254.169.254', '172.16.1.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1', 'fe80::1%eth0']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
  await assert.rejects(resolvePublicDestination(new URL('https://images.example.test/'), { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /non-public-destination/);
  let connected = false;
  await assert.rejects(downloadApprovedAsset(asset(), { lookup: async () => [{ address: '169.254.169.254', family: 4 }], request: () => { connected = true; } }), /non-public-destination/);
  assert.equal(connected, false);
});

test('upstream URLs and relay configuration fail closed', () => {
  for (const url of ['http://example.com/a.png', 'https://u:p@example.com/a.png', 'https://example.com/a.png#fragment', 'https://example.com:8443/a.png', 'https://127.0.0.1/a.png', 'https://example.com./a.png']) assert.throws(() => validateUpstreamURL(url));
  assert.throws(() => validateRelayConfig({ allowedOrigins: ['*'] }));
  assert.throws(() => validateRelayConfig({ allowedOrigins: ['http://example.com'] }));
  assert.throws(() => validateRelayConfig({ trustProxy: true }));
  assert.throws(() => validateRelayConfig({ maxConcurrency: 1000 }));
  assert.throws(() => createImageRelay({ registries: [registry([asset({ mime: 'image/svg+xml' })])] }));
  assert.throws(() => createImageRelay({ registries: [registry([asset({ updatePolicy: 'revalidate', cache: { maxAgeSeconds: 3601, immutable: false } })])] }));
});

test('approved bytes are unchanged, CORS-readable, and never carry caller or upstream credentials', async t => {
  const f = await fixtures(t);
  const upstream = await fetch(`http://127.0.0.1:${f.sourcePort}/pixel.png`);
  assert.equal(upstream.headers.get('access-control-allow-origin'), null);
  assert.equal(upstream.headers.get('cross-origin-resource-policy'), null);
  f.observed.length = 0;
  const response = await f.get(undefined, { headers: { Origin: ORIGIN, Cookie: 'joomla=session', Authorization: 'Bearer private', 'X-Forwarded-For': '8.8.8.8', 'X-Private': 'secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-public-asset-sha256'), SHA);
  assert.equal(response.headers.get('x-public-asset-id'), 'pixel');
  assert.equal(response.headers.get('x-public-asset-registry'), 'test-v1');
  assert.match(response.headers.get('access-control-expose-headers'), /X-Public-Asset-SHA256/);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].headers.authorization, undefined);
  assert.equal(f.observed[0].headers.cookie, undefined);
  assert.equal(f.observed[0].headers['x-private'], undefined);
  assert.equal(f.observed[0].headers['x-forwarded-for'], undefined);
  assert.deepEqual(f.pinned, [[{ address: '93.184.216.34', family: 4 }]]);
});

test('unknown IDs, registry versions, URLs, queries, methods and origins never reach an upstream', async t => {
  const f = await fixtures(t);
  for (const suffix of ['test-v1/nope', 'other/pixel', 'test-v1/pixel?url=https://example.com', 'test-v1/%70ixel']) assert.equal((await f.get(suffix)).status, 404);
  assert.equal((await f.get(undefined, { method: 'POST', body: 'image' })).status, 405);
  assert.equal((await f.get(undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(f.observed.length, 0);
  assert.equal((await f.get()).status, 200, 'CORS is not the authorization boundary; non-browser clients can only request reviewed IDs');
});

test('HEAD validates the complete bytes; validated versioned entries support cache and ETag', async t => {
  let time = 1000;
  const f = await fixtures(t, { now: () => time, registries: [registry(), registry([asset()], 'test-v2')] });
  const head = await f.get(undefined, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), PNG.length);
  assert.equal(f.observed[0].method, 'GET');
  const etag = head.headers.get('etag');
  assert.equal((await f.get(undefined, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal(f.observed.length, 1);
  assert.equal((await f.get('test-v2/pixel')).status, 200); assert.equal(f.observed.length, 2);
  time += 61000;
  assert.equal((await f.get()).status, 200); assert.equal(f.observed.length, 3);
});

test('only reviewed redirects are followed and each destination is revalidated', async t => {
  const f = await fixtures(t, { assets: [asset({ url: 'https://images.example.test/redirect', redirects: ['https://images.example.test/pixel.png'] })] });
  assert.equal((await f.get()).status, 200);
  assert.deepEqual(f.observed.map(r => r.url), ['/redirect', '/pixel.png']);
  const rejected = await fixtures(t, { assets: [asset({ url: 'https://images.example.test/bad-redirect' })] });
  assert.equal((await rejected.get()).status, 403); assert.equal(rejected.observed.length, 1);
  assert.equal(rejected.relay.stats.cacheEntries, 0);
  let calls = 0;
  await assert.rejects(downloadApprovedAsset(asset({ url: 'https://images.example.test/redirect', redirects: ['https://images.example.test/pixel.png'] }), {
    lookup: async () => [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    request: (url, options, callback) => http.request(`http://127.0.0.1:${f.sourcePort}${url.pathname}`, callback),
  }), /non-public-destination/);
});

test('invalid type, disguised HTML, oversized, truncated and changed images fail without cache entries', async t => {
  for (const [pathname, status] of [['/html', 502], ['/fake.png', 422], ['/huge', 413], ['/missing', 502], ['/truncated', 502]]) {
    const f = await fixtures(t, { assets: [asset({ url: `https://images.example.test${pathname}` })] });
    assert.equal((await f.get()).status, status, pathname);
    assert.equal((await f.get()).status, status, pathname);
    assert.equal(f.relay.stats.cacheEntries, 0); assert.equal(f.observed.length, 2);
    assert.ok(f.diagnostics.every(e => Object.keys(e).sort().join() === 'code,id,version'));
  }
  for (const hashes of [{ sha256: '0'.repeat(64) }, { md5: '0'.repeat(32) }]) {
    const f = await fixtures(t, { assets: [asset(hashes)] });
    const response = await f.get(); assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'image-checksum-mismatch'); assert.equal(f.relay.stats.cacheEntries, 0);
  }
});

test('timeouts, concurrency and client-independent global limits bound relay work', async t => {
  const f = await fixtures(t, { assets: [asset({ url: 'https://images.example.test/slow' })], config: { maxConcurrency: 1, timeoutMs: 100 } });
  const pending = f.get();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.get()).status, 503);
  assert.equal((await pending).status, 504); assert.equal(f.relay.stats.active, 0); assert.equal(f.relay.stats.cacheEntries, 0);
  const rate = await fixtures(t, { config: { requestsPerMinute: 2 } });
  assert.equal((await rate.get()).status, 200); assert.equal((await rate.get()).status, 200);
  assert.equal((await rate.get(undefined, { headers: { 'X-Forwarded-For': 'changed' } })).status, 429);
  const global = await fixtures(t, { config: { globalRequestsPerMinute: 1 } });
  assert.equal((await global.get()).status, 200); assert.equal((await global.get()).status, 429);
});

test('container validation accepts actual raster formats and rejects truncation, trailing HTML and damaged PNG CRC', () => {
  assert.equal(validateImageBytes(PNG, asset()), SHA);
  const gif = Buffer.from('R0lGODdhAQABAIEAABSA8AAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');
  const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoBAAEAAUAmJaACdLoB+AH4AAPIAP7q1H/9tDOqEv+Cb/69EHiDfqaAAAA=', 'base64');
  for (const [bytes, mime] of [[gif, 'image/gif'], [webp, 'image/webp']]) {
    assert.equal(typeof validateImageBytes(bytes, { mime, maxBytes: 4096 }), 'string');
    assert.throws(() => validateImageBytes(bytes.subarray(0, bytes.length - 2), { mime, maxBytes: 4096 }), /invalid-image/);
  }
  const damaged = Buffer.from(PNG); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => validateImageBytes(damaged, asset()), /invalid-image/);
  assert.throws(() => validateImageBytes(Buffer.concat([PNG, Buffer.from('<html>')]), asset()), /invalid-image/);
});
