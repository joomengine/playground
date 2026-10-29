import assert from 'node:assert/strict';
import test from 'node:test';
import { StaticAssetCache, staticAssetResponse, MAX_STATIC_ASSET_BYTES } from '../src/static-assets.mjs';

const encode = value => new TextEncoder().encode(value);
const request = (url = 'https://site.test/__site/owner/instance/image.svg') => ({ url, method: 'GET', headers: [] });
const response = value => ({ status: 200, statusText: 'OK', headers: [['Content-Type', 'image/svg+xml']], body: encode(value) });

test('static validators omit unchanged bodies and detect same-size file edits', async () => {
  const first = await staticAssetResponse(response('first'), request(), { staticAsset: true });
  const headers = new Headers(first.headers);
  assert.match(headers.get('ETag'), /^"[a-f0-9]{64}"$/);
  assert.equal(headers.get('Cache-Control'), 'private, no-cache');
  const conditional = { ...request(), headers: [['If-None-Match', headers.get('ETag')]] };
  const unchanged = await staticAssetResponse(response('first'), conditional, { staticAsset: true });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.byteLength, 0);
  const changed = await staticAssetResponse(response('other'), conditional, { staticAsset: true });
  assert.equal(changed.status, 200);
  assert.notEqual(new Headers(changed.headers).get('ETag'), headers.get('ETag'));
  for (const input of [request(), { ...request(), method: 'POST' }]) {
    const dynamic = response('dynamic');
    assert.equal(await staticAssetResponse(dynamic, input), dynamic);
  }
  const large = { ...response(''), body: new Uint8Array(MAX_STATIC_ASSET_BYTES + 1) };
  assert.equal(await staticAssetResponse(large, request(), { staticAsset: true }), large);
});

test('cached assets always revalidate, immediately reflect edits and never hide missing files', async () => {
  const cache = new StaticAssetCache();
  let contents = 'first', calls = 0, status = 200;
  const transferred = [];
  const exchange = async input => {
    calls++;
    const result = await staticAssetResponse({ ...response(contents), status }, input, { staticAsset: status === 200 });
    transferred.push(result.body.byteLength);
    return result;
  };
  assert.equal(new TextDecoder().decode((await cache.respond(request(), exchange)).body), 'first');
  assert.equal(new TextDecoder().decode((await cache.respond(request(), exchange)).body), 'first');
  assert.deepEqual(transferred, [5, 0]);
  contents = 'other';
  assert.equal(new TextDecoder().decode((await cache.respond(request(), exchange)).body), 'other');
  assert.equal(calls, 3);
  status = 404;
  assert.equal((await cache.respond(request(), exchange)).status, 404);
  status = 200;
  await cache.respond(request(), input => {
    assert.equal(new Headers(input.headers).has('If-None-Match'), false, 'A missing file evicts its old body.');
    return exchange(input);
  });
});

test('cache eviction, explicit bypass and instance URLs keep live sites separate', async () => {
  const cache = new StaticAssetCache({ maxBytes: 8, maxEntryBytes: 6 });
  const exchange = input => staticAssetResponse(response('12345'), input, { staticAsset: true });
  await cache.respond(request('https://site.test/instance-one/image'), exchange);
  await cache.respond(request('https://site.test/instance-two/image'), input => {
    assert.equal(new Headers(input.headers).has('If-None-Match'), false);
    return exchange(input);
  });
  await cache.respond(request('https://site.test/instance-one/image'), input => {
    assert.equal(new Headers(input.headers).has('If-None-Match'), false, 'The old instance was evicted to honor the byte budget.');
    return exchange(input);
  });
  await cache.respond(request('https://site.test/instance-one/image'), input => {
    assert.equal(new Headers(input.headers).has('If-None-Match'), false, 'Reload explicitly bypasses cached bodies.');
    return exchange(input);
  }, { cache: 'reload' });
  const dynamic = response('dynamic');
  await cache.respond(request(), async () => dynamic);
  await cache.respond(request(), input => {
    assert.equal(new Headers(input.headers).has('If-None-Match'), false, 'Dynamic responses are never cached.');
    return dynamic;
  });
});
