import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCatalogPackage, createPackageFetcher } from '../src/dynamic-packages.mjs';

const sha256 = 'a'.repeat(64);
const sha512 = 'b'.repeat(128);
const url = `https://playground.example/assets/packages/${sha256}.zip`;
const zip = Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3);

test('selecting a verified catalog entry only records its exact metadata', () => {
  const php = ['8.3', '8.4'];
  const entry = { url, sha256, sha512, sourceUrl: 'https://publisher.example/upstream.zip', version: '6.2.1-alpha1' };
  const selected = selectCatalogPackage(entry, { php });
  assert.deepEqual(selected, { url, sha256, sha512, php });
  php.push('8.5');
  assert.deepEqual(selected.php, ['8.3', '8.4']);
  assert.throws(() => selectCatalogPackage({ url }), /SHA-256/);
  assert.throws(() => selectCatalogPackage({ url, sha256, sha512: 'bad' }), /SHA-512/);
  assert.throws(() => selectCatalogPackage(entry, { php: [] }), /PHP runtime/);
  assert.throws(() => selectCatalogPackage({ url: 'http://remote.example/package.zip', sha256 }), /HTTPS/);
  assert.equal(selectCatalogPackage({ url: 'http://127.0.0.1:8000/assets/package.zip', sha256 }).sha256, sha256);
});

test('selected and custom packages download through the same fetch path when installation requests them', async () => {
  const calls = [];
  const selected = selectCatalogPackage({ url, sha256 });
  const fetcher = createPackageFetcher([selected], async (input, init) => {
    calls.push({ input, init });
    return new Response(zip);
  });
  assert.deepEqual(calls, []);
  const signal = new AbortController().signal;
  assert.deepEqual(new Uint8Array(await (await fetcher(url, { signal })).arrayBuffer()), zip);
  const custom = 'https://extensions.example/component.zip';
  await fetcher(custom);
  assert.deepEqual(calls, [{ input: url, init: { signal } }, { input: custom, init: undefined }]);
});

test('legacy shared downloads fail promptly with retry guidance and preserve cancellation', async () => {
  const failure = new TypeError('Failed to fetch');
  const fetcher = createPackageFetcher([{ url, sha256 }], async () => { throw failure; });
  await assert.rejects(fetcher(url), error => error.cause === failure && /Check your connection and retry/.test(error.message));
  await assert.rejects(fetcher('https://extensions.example/component.zip'), error => error === failure);
  const signal = AbortSignal.abort();
  await assert.rejects(fetcher(new Request(url, { signal })), error => error === failure);
});
