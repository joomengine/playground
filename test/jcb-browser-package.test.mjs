import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
import { deriveJcbBrowserPackage, prepareSelectedJcbPackage } from '../src/joomla/jcb-package.mjs';
import { applyJoomlaConfiguration } from '../src/joomla/index.mjs';

const codec = { unzipSync, zipSync };
const enc = new TextEncoder();
const text = (value) => enc.encode(value);
const digest = (algorithm, value) => createHash(algorithm).update(value).digest('hex');
const root = 'component-builder/libraries/phpspreadsheet/';
const filter = 'component-builder/libraries/vendor_jcb/VDM.Joomla/src/Import/Spreadsheet/ChunkReadFilter.php';
const filterSha = '742877f73d6817c54963cbc8767c7af805332b561a7c178cae1151147263f28e';
const patchedSha = '8b8f3e8845eb8844e419c3b05ada2be31eabe911a92365f9bc4e7d7f96cc89c6';
const original = new Uint8Array(gunzipSync(await readFile(new URL('./fixtures/jcb-chunk-read-filter.php.gz', import.meta.url))));
const sourceDependencies = new Uint8Array(gunzipSync(await readFile(new URL('./fixtures/jcb-spreadsheet-source-installed.json.gz', import.meta.url))));

function fixture({ version = '6.2.1-alpha1', originalFilter = original, dependencyMetadata = sourceDependencies, candidateExtra = {} } = {}) {
  const candidateComponent = zipSync({ [filter]: originalFilter, [`${root}vendor/autoload.php`]: text('old'),
    [`${root}vendor/composer/installed.json`]: dependencyMetadata,
    'component-builder/keep.php': text('candidate source'), ...candidateExtra });
  const base = 'pkg-component-builder-6.2.1-alpha1/';
  const candidate = zipSync({ [`${base}pkg_component_builder.xml`]: text(`<extension><version>${version}</version></extension>`),
    [`${base}src/joomla__Component-Builder__6.x.zip`]: candidateComponent,
    [`${base}src/plugin.zip`]: text('candidate companion plugin') });
  const provenance = { schemaVersion: 1, target: { integerBits: 32 }, source: { version: '6.2.0' },
    sourceOverlay: { sha256: filterSha, patchedSha256: patchedSha } };
  const donorComponent = zipSync({ [`${root}vendor/autoload.php`]: text('32-bit autoloader'),
    [`${root}vendor/composer/platform_check.php`]: text('32-bit platform guard'),
    ...Object.fromEntries(['composer.json', 'composer.lock', 'packages.json', 'vendor-inventory.json', 'vendor-source-inventory.json'].map(name => [`${root}${name}`, text('{}')])),
    [`${root}platform-provenance.json`]: text(JSON.stringify(provenance)) });
  const donor = zipSync({ 'pkg-component-builder-6.2.0/src/joomla__Component-Builder__6.x.zip': donorComponent });
  return { candidate, donor, source: { version: '6.2.1-alpha1', sha512: digest('sha512', candidate) },
    donorSha256: digest('sha256', donor), codec, subtle: webcrypto.subtle };
}

test('derives the selected candidate while retaining its package, plugins and provenance', async () => {
  const input = fixture();
  const result = await deriveJcbBrowserPackage(input);
  assert.equal(result.sha256, digest('sha256', result.bytes));
  const outer = unzipSync(result.bytes);
  assert.equal(new TextDecoder().decode(outer['pkg-component-builder-6.2.1-alpha1/src/plugin.zip']), 'candidate companion plugin');
  const files = unzipSync(outer['pkg-component-builder-6.2.1-alpha1/src/joomla__Component-Builder__6.x.zip']);
  assert.equal(digest('sha256', files[filter]), patchedSha);
  assert.equal(new TextDecoder().decode(files[`${root}vendor/autoload.php`]), '32-bit autoloader');
  assert.equal(new TextDecoder().decode(files['component-builder/keep.php']), 'candidate source');
  const provenance = JSON.parse(new TextDecoder().decode(files[`${root}platform-provenance.json`]));
  assert.equal(provenance.source.version, '6.2.1-alpha1');
  assert.equal(provenance.source.sha512, input.source.sha512);
  assert.equal(provenance.donorSha256, input.donorSha256);
});

test('rejects incorrect digests, selection mismatches and unreviewed source', async () => {
  const input = fixture();
  await assert.rejects(deriveJcbBrowserPackage({ ...input, source: { ...input.source, sha512: '0'.repeat(128) } }), /candidate JCB package failed its checksum/);
  await assert.rejects(deriveJcbBrowserPackage({ ...input, donorSha256: '0'.repeat(64) }), /donor package failed its checksum/);
  await assert.rejects(deriveJcbBrowserPackage({ ...input, source: { ...input.source, version: '6.2.0' } }), /version does not match/);
  await assert.rejects(deriveJcbBrowserPackage(fixture({ originalFilter: text('unreviewed source') })), /differs from the reviewed/);
  await assert.rejects(deriveJcbBrowserPackage(fixture({ dependencyMetadata: text('changed dependency') })), /dependency contract differs/);
  await assert.rejects(deriveJcbBrowserPackage({ ...input, source: { version: '3.2.5', sha512: input.source.sha512 } }), /not supported/);
});

test('refuses archives with unsafe paths before re-packing', async () => {
  const input = fixture({ candidateExtra: { '../escape.php': text('unsafe') } });
  await assert.rejects(deriveJcbBrowserPackage(input), /unsafe or duplicate path/);
});

test('the actual extension installation path prepares the selected package before PHP receives it', async () => {
  const input = fixture();
  const sourceURL = 'https://example.test/jcb.zip';
  const item = { url: sourceURL, sha512: input.source.sha512 };
  const donorURL = `https://playground.test/assets/packages/${input.donorSha256}.zip`;
  const manifest = { deploys: { packages: [{ sourceSha256: '17a2b4c7b352d0ead2592e7e5838ace8255bbcbdc71566d883e8e82ca3dacd8e',
    sha256: input.donorSha256, url: `packages/${input.donorSha256}.zip`,
    provenanceUrl: `packages/${input.donorSha256}.provenance.json` }] } };
  const requested = [];
  const fetchPackage = async (url) => {
    requested.push(String(url));
    if (String(url) === sourceURL) return new Response(input.candidate);
    if (String(url) === 'https://playground.test/assets/manifest.json') return new Response(JSON.stringify(manifest));
    if (String(url) === donorURL) return new Response(input.donor);
    throw new Error(`Unexpected download: ${url}`);
  };
  const writes = [];
  const runtime = { fs: { writeFile: async (path, bytes) => writes.push({ path, bytes }) }, runPhp: async source => {
    const operation = [...source.matchAll(/operation:([a-z]+)/g)].at(-1)?.[1];
    return { status: 200, text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(operation === 'status'
      ? { ok: true, marker: { state: 'complete', joomlaVersion: '6.2.0' }, configured: true, installerPresent: false }
      : { ok: false, error: 'Stop after observing the package' }) };
  } };
  const config = { joomlaVersion: '6.2.0', jcbVersion: input.source.version, jcbPackage: item,
    admin: { password: 'Local-Demo-Password-123!' }, extensions: [item] };
  await assert.rejects(applyJoomlaConfiguration(runtime, config, { fetchPackage,
    sourceLoader: async name => `<?php\n// operation:${name}\n`,
    jcbPackageOptions: { manifestURL: new URL('https://playground.test/assets/manifest.json'), codec },
  }), /Stop after observing the package/);
  assert.deepEqual(requested, [sourceURL, 'https://playground.test/assets/manifest.json', donorURL]);
  assert.equal(writes.length, 1);
  const outer = unzipSync(writes[0].bytes);
  const files = unzipSync(outer['pkg-component-builder-6.2.1-alpha1/src/joomla__Component-Builder__6.x.zip']);
  assert.equal(digest('sha256', files[filter]), patchedSha);
  assert.equal(new TextDecoder().decode(files[`${root}vendor/autoload.php`]), '32-bit autoloader');
});

test('the already-derived stable JCB artifact passes through for every deployment', async () => {
  const donor = fixture().donor;
  const donorHash = digest('sha256', donor);
  const url = `https://playground.test/assets/packages/${donorHash}.zip`;
  const manifestURL = new URL('https://playground.test/assets/manifest.json');
  const sourceHashes = { '5.2.0': '261e11de61a31ce6183fdcdf35fd3fdc7d0ff93b347bfb4cdaf7d4c66f93385b',
    '6.2.0': '17a2b4c7b352d0ead2592e7e5838ace8255bbcbdc71566d883e8e82ca3dacd8e' };
  for (const version of Object.keys(sourceHashes)) {
    const item = { url, sha256: donorHash };
    const manifest = { deploys: { packages: [{ sourceSha256: sourceHashes[version], sha256: donorHash,
      url: `packages/${donorHash}.zip`, provenanceUrl: `packages/${donorHash}.provenance.json` }] } };
    const requests = [];
    const result = await prepareSelectedJcbPackage({ bytes: donor, item, selection: { version, package: item }, codec,
      manifestURL, fetcher: async path => { requests.push(String(path)); return new Response(JSON.stringify(manifest)); } });
    assert.equal(result, null);
    assert.deepEqual(requests, [manifestURL.href], 'Pass-through must not download and derive the donor again.');
    await assert.rejects(prepareSelectedJcbPackage({ bytes: donor, item: { ...item, url: `${url}?replacement=1` },
      selection: { version, package: { ...item, url: `${url}?replacement=1` } }, codec, manifestURL,
      fetcher: async () => new Response(JSON.stringify(manifest)) }), /donor is missing|ambiguous|checksum|version|manifest/i);
  }
});
