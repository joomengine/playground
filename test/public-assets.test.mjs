import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assetRouteURL, findApprovedAsset, parsePublicAssetRoute, resolvePublicAssetURL,
  validatePublicAssetConfiguration, validatePublicAssetRegistry, sha256Hex,
} from '../src/public-assets.mjs';
import { createPublicAssetHandler, handlePublicAssetRequest } from '../src/public-assets-worker.mjs';
import { createPhpFetch, NESTED_PHP_REQUEST_ERROR } from '../src/php-network.mjs';

const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH2kAAAAASUVORK5CYII=', 'base64'));
const baseURL = 'https://playground.example/sub/';
const original = 'https://images.example/approved.png';
const asset = { id: 'approved', url: original, owner: 'fixture', mime: 'image/png', maxBytes: 1024,
  redirects: [], sha256: await sha256Hex(bytes), compatibilityRequired: true,
  cache: { maxAgeSeconds: 60, immutable: true }, updatePolicy: 'pinned' };
const registry = validatePublicAssetRegistry({ schemaVersion: 1, version: 'test-v1', assets: [asset] });
const config = validatePublicAssetConfiguration({ schemaVersion: 1, enabled: true,
  relayBaseURL: 'https://relay.example/', registryVersions: ['test-v1'], timeoutMs: 1000 });
const options = { policy: 'require-corp', registry, config, baseURL };
const route = assetRouteURL(asset, registry, baseURL);
const relayHeaders = { 'Content-Type': asset.mime, 'X-Public-Asset-Id': asset.id,
  'X-Public-Asset-Registry': registry.version, 'X-Public-Asset-SHA256': asset.sha256, 'Cache-Control': 'public, max-age=60' };

test('reviewed package registry is valid, exact and remains separate from saved deployments', async () => {
  const actual = validatePublicAssetRegistry(JSON.parse(await readFile(new URL('../config/public-assets.json', import.meta.url), 'utf8')));
  assert.equal(actual.assets.length, 31);
  assert.ok(actual.assets.every(item => item.md5 && item.compatibilityRequired && item.redirects.length === 0));
  assert.ok(actual.assets.every(item => item.mime !== 'image/svg+xml'));
  assert.ok(Object.isFrozen(actual.assets));
});

test('registry rejects unsafe URLs, unbounded content, duplicate identities and active SVG', () => {
  for (const change of [
    { url: 'http://images.example/approved.png' }, { url: 'https://user:password@images.example/approved.png' },
    { url: `${original}#fragment` }, { url: 'https://images.example/%0a.png' }, { mime: 'image/svg+xml' },
    { maxBytes: Infinity }, { redirects: ['https://user@images.example/x.png'] }, { sha256: undefined },
    { updatePolicy: 'revalidate', cache: { maxAgeSeconds: 60, immutable: true } },
    { updatePolicy: 'revalidate', cache: { maxAgeSeconds: 86400, immutable: false } },
  ]) assert.throws(() => validatePublicAssetRegistry({ schemaVersion: 1, version: 'v1', assets: [{ ...asset, ...change }] }));
  assert.throws(() => validatePublicAssetRegistry({ schemaVersion: 1, version: 'v1', assets: [asset, asset] }));
  assert.throws(() => validatePublicAssetConfiguration({ ...config, relayBaseURL: null }));
});

test('resolver preserves original URLs in normal mode and exact query strings cannot expand approval', () => {
  assert.equal(resolvePublicAssetURL(original, { ...options, policy: 'credentialless' }), original);
  assert.equal(resolvePublicAssetURL(original, options), route);
  assert.equal(resolvePublicAssetURL(`${original}?download=1`, options), `${original}?download=1`);
  assert.equal(resolvePublicAssetURL(original, { ...options, config: { ...config, enabled: false } }), original);
  assert.equal(findApprovedAsset(registry, 'https://images.example/unapproved.png'), undefined);
  assert.deepEqual(parsePublicAssetRoute(route, baseURL), { version: 'test-v1', id: 'approved' });
  for (const value of [`${route}?url=https://other.example/a.png`, `${route}/more`, route.replace('test-v1', '%74est-v1')]) {
    assert.throws(() => parsePublicAssetRoute(value, baseURL));
  }
});

test('normal mode does not load image configuration or make relay requests', async () => {
  let calls = 0;
  const handler = createPublicAssetHandler({ baseURL, load() { calls++; throw new Error('must not load'); } });
  assert.equal(await handler(new Request(original), { policy: 'credentialless' }), null);
  assert.equal((await handler(new Request(route), { policy: 'credentialless' })).status, 403);
  assert.equal(calls, 0);
});

test('disabled image delivery leaves original image requests untouched in compatibility mode', async () => {
  const disabled = { ...config, enabled: false, relayBaseURL: null };
  const request = new Request(original);
  Object.defineProperty(request, 'destination', { value: 'image' });
  const fetcher = () => { throw new Error('A disabled relay must not be contacted.'); };
  assert.equal(await handlePublicAssetRequest(request, { ...options, config: disabled, fetcher }), null);
  assert.equal((await handlePublicAssetRequest(new Request(route), { ...options, config: disabled, fetcher })).status, 503);
});

test('PHP image downloads preserve method, cancellation and original bytes through the external asset route', async () => {
  const calls = [], controller = new AbortController();
  const fetcher = createPhpFetch(async (input, init) => { calls.push({ input, init }); return new Response(bytes, { status: 200 }); },
    `${baseURL}__site/owner/instance/`, () => true, options);
  const response = await fetcher(original, { signal: controller.signal, method: 'HEAD', headers: { Accept: 'image/png', 'User-Agent': 'JCB legacy public image helper' } });
  assert.equal(calls[0].input, route);
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.has('User-Agent'), false);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  await assert.rejects(fetcher(`${baseURL}__site/owner/instance/image.php`), new RegExp(NESTED_PHP_REQUEST_ERROR));
});

test('PHP normal, authenticated, non-image, POST and custom-header requests are passed untouched', async () => {
  const seen = [];
  const sink = async (input, init) => { seen.push([input, init]); return new Response('ok'); };
  const normal = createPhpFetch(sink, `${baseURL}__site/o/i/`, () => false, { ...options, policy: 'credentialless' });
  const compatible = createPhpFetch(sink, `${baseURL}__site/o/i/`, () => false, options);
  const unchanged = [
    [normal, new Request(original), undefined],
    [compatible, original, { headers: { Authorization: 'secret' } }],
    [compatible, original, { credentials: 'include' }],
    [compatible, original, { method: 'POST', body: 'test' }],
    [compatible, original, { headers: { 'X-Token': 'secret' } }],
    [compatible, 'https://images.example/api', { headers: { Accept: 'application/json' } }],
  ];
  for (const [call, input, init] of unchanged) {
    await call(input, init);
    assert.equal(seen.at(-1)[0], input); assert.equal(seen.at(-1)[1], init);
  }
});

test('asset route validates exact bytes before caching and never forwards caller credentials', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(bytes, { headers: relayHeaders }); };
  const response = await handlePublicAssetRequest(new Request(route), { ...options, fetcher });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(calls[0].url, 'https://relay.example/v1/assets/test-v1/approved');
  assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.mode, 'cors');
  assert.deepEqual(calls[0].init.headers, { Accept: 'image/png' });
  assert.equal((await handlePublicAssetRequest(new Request(route, { method: 'HEAD' }), { ...options, fetcher })).status, 200);
  assert.equal(calls.length, 1, 'Only validated complete images can satisfy a later HEAD.');
  const rejected = await handlePublicAssetRequest(new Request(route, { headers: { Authorization: 'secret' } }), { ...options, fetcher });
  assert.equal(rejected.status, 400); assert.equal(calls.length, 1);
});

test('unknown IDs/versions, HTML, wrong digest, oversized data and relay outages fail without successful cache entries', async () => {
  for (const [requestURL, status] of [[route.replace('approved', 'unknown'), 404], [route.replace('test-v1', 'old'), 404]]) {
    const response = await handlePublicAssetRequest(new Request(requestURL), { ...options, fetcher() { throw new Error('must not fetch'); } });
    assert.equal(response.status, status);
  }
  for (const response of [
    () => new Response('<html>error</html>', { headers: { ...relayHeaders, 'Content-Type': 'text/html' } }),
    () => new Response('<html>error</html>', { headers: relayHeaders }),
    () => new Response(bytes, { headers: { ...relayHeaders, 'Content-Length': '9000000' } }),
    () => new Response(bytes, { headers: { ...relayHeaders, 'X-Public-Asset-SHA256': 'bad' } }),
    () => new Response(bytes, { headers: { ...relayHeaders, 'X-Public-Asset-SHA256': '0'.repeat(64) } }),
    () => new Response(bytes, { headers: { ...relayHeaders, 'X-Public-Asset-Id': 'other' } }),
    () => new Response('unavailable', { status: 503 }),
    () => { throw new TypeError('https://secret:password@host unavailable'); },
  ]) {
    const result = await handlePublicAssetRequest(new Request(route, { cache: 'no-store' }), { ...options, fetcher: response });
    assert.ok(result.status >= 500); assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await result.text(), /password|secret/);
  }
});

test('cancelled PHP relay requests stay cancelled and return bounded diagnostics', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await handlePublicAssetRequest(new Request(route, { cache: 'no-store', signal: controller.signal }), {
    ...options, fetcher(url, init) { assert.equal(init.signal.aborted, true); throw init.signal.reason; },
  });
  assert.equal(result.status, 504);
});
