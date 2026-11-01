import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { joomlaPackagePhpMinimum, stageVersionCatalog } from '../scripts/version-catalog.mjs';
import { compatibleDynamicPhp } from '../src/dynamic-selection.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => createHash('sha512').update(bytes).digest('hex');
const zip = (text, php = '8.3.0') => Buffer.from(zipSync({ 'version.txt': strToU8(text),
  'index.php': strToU8(`<?php\ndefine('JOOMLA_MINIMUM_PHP', '${php}');\n`),
  'installation/index.php': strToU8(`<?php\n\\define('JOOMLA_MINIMUM_PHP', '${php}');\n`) }));
const stableBytes = zip('6.2.0');
const jcbBytes = zip('6.2.1-alpha1');
const stable = { version: '6.2.0', label: 'Joomla 6.2.0', source: 'release', channel: 'stable',
  url: 'https://publisher.test/joomla.zip', sha256: sha256(stableBytes), prerelease: false };
const jcb = { version: '6.2.1-alpha1', label: 'JCB 6.2.1-alpha1', source: 'jcb-update', channel: 'preview',
  url: 'https://publisher.test/jcb.zip', sha512: sha512(jcbBytes), prerelease: true };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-version-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets');
  await mkdir(assets);
  const requests = [];
  const configuration = { assets, cache: path.join(directory, 'cache'),
    discover: async () => ({ joomla: [stable], jcb: [jcb], errors: [] }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(url === stable.url ? stableBytes : jcbBytes);
    },
    now: () => Date.UTC(2026, 9, 31), ...options };
  return { configuration, requests,
    catalog: () => readFile(path.join(assets, 'version-catalog.json'), 'utf8').then(JSON.parse) };
}

test('published catalog serves exact verified ZIP bytes on its own origin and retains upstream provenance', async t => {
  const f = await fixture(t);
  assert.deepEqual(await stageVersionCatalog(f.configuration), { url: 'version-catalog.json', generatedAt: '2026-10-31T00:00:00.000Z' });
  const catalog = await f.catalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.errors, []);
  for (const [entry, original, expectedBytes] of [[catalog.joomla[0], stable, stableBytes], [catalog.jcb[0], jcb, jcbBytes]]) {
    assert.equal(entry.url, `packages/${sha256(expectedBytes)}.zip`);
    assert.equal(entry.sourceUrl, original.url);
    assert.equal(entry.sha256, sha256(expectedBytes));
    assert.equal(entry.channel, original.channel);
    const actual = await readFile(path.join(f.configuration.assets, entry.url));
    assert.deepEqual(actual, expectedBytes);
    assert.equal(new TextDecoder().decode(unzipSync(actual)['version.txt']), entry.version);
  }
  assert.equal(catalog.jcb[0].sha512, jcb.sha512);
  assert.equal(catalog.joomla[0].phpMinimum, '8.3.0');
  assert.ok(f.requests.every(request => request.init.credentials === 'omit' && request.init.cache === 'no-store'));
});

test('verified immutable cache avoids downloads while mutable nightlies refresh their content identity', async t => {
  let nightlyBytes = zip('first build');
  const nightly = { version: '7.0.0-alpha1-dev', label: 'Joomla nightly', source: 'nightly', channel: 'nightly',
    url: 'https://publisher.test/nightly.zip', phpMinimum: '8.3.0', sha256: null, prerelease: true };
  let nightlyDownloads = 0;
  let immutableDownloads = 0;
  const f = await fixture(t, {
    discover: async () => ({ joomla: [stable, nightly], jcb: [jcb], errors: [] }),
    fetchImpl: async url => {
      if (url === nightly.url) { nightlyDownloads++; return new Response(nightlyBytes); }
      immutableDownloads++;
      return new Response(url === stable.url ? stableBytes : jcbBytes);
    },
  });
  await stageVersionCatalog(f.configuration);
  const first = (await f.catalog()).joomla[1];
  nightlyBytes = zip('second build');
  await stageVersionCatalog(f.configuration);
  const second = (await f.catalog()).joomla[1];
  assert.equal(immutableDownloads, 2);
  assert.equal(nightlyDownloads, 2);
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(first.url, second.url);
  assert.equal(second.sha256, sha256(nightlyBytes));
  assert.equal(second.phpMinimum, nightly.phpMinimum);
});

test('a corrupted immutable cache is replaced only by a freshly verified source', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const cached = path.join(f.configuration.cache, 'packages', `${jcb.sha512}.zip`);
  await writeFile(cached, zip('corrupted'));
  await stageVersionCatalog(f.configuration);
  assert.equal(f.requests.filter(request => request.url === jcb.url).length, 2);
  assert.deepEqual(await readFile(cached), jcbBytes);
});

test('a changed publisher checksum leaves the previous catalog untouched', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const previous = await f.catalog();
  await assert.rejects(stageVersionCatalog({ ...f.configuration,
    discover: async () => ({ joomla: [stable], jcb: [{ ...jcb, sha512: '0'.repeat(128) }], errors: [] }) }), /published sha512 checksum/);
  assert.deepEqual(await f.catalog(), previous);
});

test('partial metadata cannot publish an apparently complete catalog', async t => {
  const f = await fixture(t, { discover: async () => ({ joomla: [stable], jcb: [], errors: [{ source: 'jcb-6.x', message: 'HTTP 503' }] }) });
  await assert.rejects(stageVersionCatalog(f.configuration), /incomplete version catalog.*jcb-6.x/);
  assert.deepEqual(f.requests, []);
  await assert.rejects(f.catalog(), { code: 'ENOENT' });
});

test('non-ZIP, oversized declared responses and oversized streams are rejected before catalog publication', async t => {
  for (const response of [
    () => new Response('<html>Download error</html>'),
    () => new Response(stableBytes, { headers: { 'Content-Length': '1025' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); } })),
  ]) {
    const f = await fixture(t, { maxPackageBytes: 1024, fetchImpl: async () => response() });
    await assert.rejects(stageVersionCatalog(f.configuration), /not a ZIP|exceeds 128 MiB/);
    await assert.rejects(f.catalog(), { code: 'ENOENT' });
  }
});

test('staged pinned Joomla archives are verified and reused without a second upstream download', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.configuration.assets, 'joomla'));
  await writeFile(path.join(f.configuration.assets, 'joomla', 'Joomla_6.2.0.zip'), stableBytes);
  await stageVersionCatalog({ ...f.configuration,
    stagedJoomla: [{ version: stable.version, sourceUrl: stable.url, sha256: stable.sha256, url: 'joomla/Joomla_6.2.0.zip' }] });
  assert.deepEqual(f.requests.map(request => request.url), [jcb.url]);
  assert.equal((await f.catalog()).joomla[0].url, 'joomla/Joomla_6.2.0.zip');
  await assert.rejects(readFile(path.join(f.configuration.assets, 'packages', `${stable.sha256}.zip`)), { code: 'ENOENT' });
  await writeFile(path.join(f.configuration.assets, 'joomla', 'Joomla_6.2.0.zip'), zip('corrupt staged file'));
  await assert.rejects(stageVersionCatalog({ ...f.configuration,
    stagedJoomla: [{ version: stable.version, sourceUrl: stable.url, sha256: stable.sha256, url: 'joomla/Joomla_6.2.0.zip' }] }), /published sha256 checksum/);
});

test('published Joomla 7 previews use the archive PHP requirement without a pinned Joomla 7 runtime entry', async t => {
  const bytes = zip('7.0.0-beta1', '8.4.0');
  const release = { version: '7.0.0-beta1', source: 'release', channel: 'preview', prerelease: true,
    url: 'https://publisher.test/joomla7.zip', sha256: sha256(bytes) };
  const f = await fixture(t, { discover: async () => ({ joomla: [release], jcb: [jcb], errors: [] }),
    fetchImpl: async url => new Response(url === release.url ? bytes : jcbBytes) });
  await stageVersionCatalog(f.configuration);
  const entry = (await f.catalog()).joomla[0];
  assert.equal(entry.phpMinimum, '8.4.0');
  assert.deepEqual(compatibleDynamicPhp(entry, {
    php: [{ version: '8.3', patchVersion: '8.3.29' }, { version: '8.4', patchVersion: '8.4.1' }, { version: '8.5', patchVersion: '8.5.2' }],
    joomla: [{ version: '6.2.0', php: ['8.3', '8.4', '8.5'] }],
  }), ['8.4', '8.5']);
});

test('archive inspection keeps stricter feed requirements and rejects incomplete or contradictory installers', () => {
  assert.equal(joomlaPackagePhpMinimum(zip('test', '8.4.1'), '8.3.0'), '8.4.1');
  assert.equal(joomlaPackagePhpMinimum(zip('test', '8.3.0'), '8.4.1'), '8.4.1');
  assert.throws(() => joomlaPackagePhpMinimum(zipSync({ 'index.php': strToU8("<?php\ndefine('JOOMLA_MINIMUM_PHP', '8.3.0');") })), /missing installation\/index.php/);
  const contradictory = unzipSync(zip('test', '8.3.0'));
  contradictory['installation/index.php'] = strToU8("<?php\ndefine('JOOMLA_MINIMUM_PHP', '8.4.0');");
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /disagree/);
  contradictory['installation/index.php'] = strToU8('<?php\n// no minimum declaration');
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /missing or ambiguous/);
  contradictory['installation/index.php'] = new Uint8Array(64 * 1024 + 1);
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /size limit/);
});
