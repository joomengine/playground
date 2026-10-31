import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDynamicPackage, importDynamicPackage, createPackageFetcher } from '../src/dynamic-packages.mjs';

const zip = Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3);
const hash = async (algorithm, bytes = zip) => Buffer.from(await crypto.subtle.digest(algorithm, bytes)).toString('hex');

test('direct downloads verify upstream SHA-512 and supply the identical bytes to installation', async () => {
  const url = 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v6.2.1-alpha1.zip';
  const sha512 = await hash('SHA-512');
  let downloads = 0;
  const selected = await resolveDynamicPackage({ url, sha512 }, { fetchImpl: async (input, options) => {
    downloads++;
    assert.equal(input, url);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    return new Response(zip);
  } });
  assert.equal(selected.sha256, await hash('SHA-256'));
  assert.equal(selected.sha512, sha512);
  const fetcher = createPackageFetcher([selected], () => { throw new Error('Must reuse downloaded ZIP.'); });
  assert.deepEqual(new Uint8Array(await (await fetcher(url)).arrayBuffer()), zip);
  assert.equal(downloads, 1);
});

test('nightly fingerprints pin actual bytes and changing the same URL keeps both selected installations intact', async () => {
  const url = 'https://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip';
  const php = ['8.3', '8.4'];
  const first = await resolveDynamicPackage({ url, sha256: null }, { php, fetchImpl: async () => new Response(zip) });
  const nextZip = Uint8Array.from([...zip, 4]);
  const second = await resolveDynamicPackage({ url, sha256: null }, { php, fetchImpl: async () => new Response(nextZip) });
  assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(first.php, php);
  const noNetwork = () => { throw new Error('Unexpected network call.'); };
  assert.deepEqual(new Uint8Array(await (await createPackageFetcher([first], noNetwork)(url)).arrayBuffer()), zip);
  assert.deepEqual(new Uint8Array(await (await createPackageFetcher([second], noNetwork)(url)).arrayBuffer()), nextZip);
});

test('mismatches, malformed digests, non-ZIP responses and failed direct fetches cannot become selected packages', async () => {
  const url = 'https://example.org/release.zip';
  for (const algorithm of ['sha256', 'sha512']) {
    await assert.rejects(resolveDynamicPackage({ url, [algorithm]: '0'.repeat(algorithm === 'sha256' ? 64 : 128) }, { fetchImpl: async () => new Response(zip) }), /published SHA-/);
  }
  await assert.rejects(resolveDynamicPackage({ url, sha256: 'invalid' }), /checksum is invalid/);
  await assert.rejects(resolveDynamicPackage({ url }, { fetchImpl: async () => new Response('<html>Error</html>') }), /not a ZIP/);
  await assert.rejects(resolveDynamicPackage({ url }, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /direct package download from example.org/);
  await assert.rejects(resolveDynamicPackage({ url: 'http://example.org/release.zip' }), /HTTPS/);
});

test('a declared oversized package is rejected without reading it and a missing cached digest fetches normally', async () => {
  const url = 'https://example.org/large.zip';
  await assert.rejects(resolveDynamicPackage({ url }, { fetchImpl: async () => new Response(zip, { headers: { 'Content-Length': String(129 * 1024 * 1024) } }) }), /128 MiB/);
  let called = false;
  const fetcher = createPackageFetcher([{ url, sha256: 'e'.repeat(64) }], async input => { called = true; assert.equal(input, url); return new Response(zip); });
  await fetcher(url);
  assert.equal(called, true);
});

test('locally supplied upstream ZIPs are verified and installed without another request', async () => {
  const entry = { url: 'https://example.org/downloaded.zip', sha512: await hash('SHA-512') };
  const selected = await importDynamicPackage(entry, new File([zip], 'downloaded.zip'));
  assert.equal(selected.sha256, await hash('SHA-256'));
  const fetcher = createPackageFetcher([selected], () => { throw new Error('Local ZIP must not be uploaded or fetched again.'); });
  assert.deepEqual(new Uint8Array(await (await fetcher(entry.url)).arrayBuffer()), zip);
  await assert.rejects(importDynamicPackage(entry, new File([Uint8Array.from([...zip, 9])], 'downloaded.zip')), /SHA-512/);
  await assert.rejects(importDynamicPackage(entry, new File(['error'], 'downloaded.zip')), /not a ZIP/);
  await assert.rejects(importDynamicPackage(entry, new File([zip], 'downloaded.zip'), { signal: AbortSignal.abort() }), /aborted/i);
});

test('shared packages missing from memory can be supplied locally without changing their selected checksum', async () => {
  const entry = { url: 'https://example.org/shared.zip', sha256: await hash('SHA-256'), php: ['8.4'] };
  let resolved = false;
  const fetcher = createPackageFetcher([entry], () => { throw new Error('Must use the supplied ZIP.'); }, {
    resolvePackage: async (selected, options) => {
      resolved = true;
      assert.deepEqual(selected, entry);
      assert.deepEqual(options.php, ['8.4']);
      return importDynamicPackage(selected, new File([zip], 'shared.zip'), options);
    },
  });
  assert.deepEqual(new Uint8Array(await (await fetcher(entry.url)).arrayBuffer()), zip);
  assert.equal(resolved, true);
});
