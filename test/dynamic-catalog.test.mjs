import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverDynamicCatalog, parseJoomlaReleases, parseJoomlaNightlies, parseJoomlaNightlyList, parseJoomlaNightlyUpdates, parseJcbUpdates, parseJcbTags } from '../src/dynamic-catalog.mjs';

const sha256 = 'a'.repeat(64);
const sha512 = 'b'.repeat(128);
const joomlaRelease = (version, digest = `sha256:${sha256}`) => ({ tag_name: version, prerelease: version.includes('-'), assets: [
  { name: `Joomla_${version}-Release_Candidate-Full_Package.zip`, browser_download_url: `https://github.com/joomla/joomla-cms/releases/download/${version}/Joomla_${version}-Release_Candidate-Full_Package.zip`, digest },
] });
const jcbXML = (version, checksum = sha512, target = version) => `<updates><update><element>pkg_component_builder</element><version>${version}</version><downloads><downloadurl type="full" format="zip">https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v${target}.zip</downloadurl></downloads><sha512>${checksum}</sha512></update></updates>`;
const nightlyXML = (version, php = '8.3.0') => `<updates><update><version>${version}</version><downloads><downloadurl type="full" format="zip">https://developer.joomla.org/nightlies/Joomla_${version}-Development-Update_Package.zip</downloadurl></downloads><php_minimum>${php}</php_minimum></update></updates>`;
const nightlyList = (url = 'https://update.joomla.org/core/nightlies/next_patch_extension.xml') => `<extensionset name="Joomla! Core Nightly Builds"><extension name="Joomla" element="joomla" type="file" version="5.4.11-dev" targetplatformversion="5.4" detailsurl="${url}"/><extension name="Joomla" element="joomla" type="file" version="6.2.1-dev" targetplatformversion="6.2" detailsurl="${url}"/></extensionset>`;

test('release discovery keeps real installers and upstream digest, rejecting source or mismatched assets', () => {
  const valid = joomlaRelease('6.2.0-rc2');
  const noHash = joomlaRelease('6.2.0', null);
  const source = { tag_name: '6.3.0-alpha1', assets: [{ name: 'source.zip', browser_download_url: 'https://github.com/joomla/joomla-cms/archive/refs/tags/6.3.0-alpha1.zip' }] };
  const mismatch = joomlaRelease('6.4.0');
  mismatch.assets[0].browser_download_url = mismatch.assets[0].browser_download_url.replace('/6.4.0/', '/6.3.0/');
  const result = parseJoomlaReleases([valid, noHash, source, mismatch]);
  assert.deepEqual(result.map((entry) => [entry.version, entry.sha256]), [['6.2.0-rc2', sha256], ['6.2.0', null]]);
  assert.equal(result[0].prerelease, true);
});

test('nightly metadata picks full installation archives and retains the publisher PHP minimum', () => {
  const xml = `${nightlyXML('6.3.0-alpha1-dev')}${nightlyXML('6.3.0-alpha1-dev')}${nightlyXML('7.0.0-alpha1-dev')}`;
  const result = parseJoomlaNightlyUpdates(xml);
  assert.equal(result.length, 2);
  assert.equal(result[0].url, 'https://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip');
  assert.equal(result[0].phpMinimum, '8.3.0');
  assert.equal(result[0].sha256, null);
  assert.deepEqual(parseJoomlaNightlyUpdates(xml.replaceAll('developer.joomla.org', 'attacker.invalid')), []);
  assert.equal(parseJoomlaNightlies('<a href="/nightlies/Joomla_6.3.0-alpha1-dev-Development-Full_Package.zip">full</a>').length, 1);
});

test('nightly list feeds follow deduplicated official Joomla details URLs', () => {
  const url = 'https://update.joomla.org/core/nightlies/next_patch_extension.xml';
  assert.deepEqual(parseJoomlaNightlyList(nightlyList()), [url]);
  assert.deepEqual(parseJoomlaNightlyList(nightlyList().replaceAll('"', "'")), [url]);
  assert.deepEqual(parseJoomlaNightlyList(nightlyList('https://attacker.invalid/next_patch_extension.xml')), []);
  assert.deepEqual(parseJoomlaNightlyList(nightlyList().replaceAll('element="joomla"', 'element="other"')), []);
  assert.deepEqual(parseJoomlaNightlyList(nightlyList('https://update.joomla.org/core/nightlies/next_patch_extension.xml?redirect=evil')), []);
});

test('an update ZIP checksum is never reused for the full nightly installer', () => {
  const xml = nightlyXML('7.0.0-alpha1-dev').replace('</update>', `<sha256>${sha256}</sha256><sha512>${sha512}</sha512></update>`);
  const [entry] = parseJoomlaNightlyUpdates(xml);
  assert.ok(entry.url.endsWith('-Full_Package.zip'));
  assert.equal(entry.sha256, null);
  assert.equal(entry.sha512, undefined);
});

test('JCB discovery requires a matching version, official package URL and published SHA-512', () => {
  assert.equal(parseJcbUpdates(jcbXML('6.2.1-alpha1'))[0].sha512, sha512);
  assert.deepEqual(parseJcbUpdates(jcbXML('6.1.2', sha512, '6.1.3')), []);
  assert.deepEqual(parseJcbUpdates(jcbXML('6.1.2', 'bad')), []);
  assert.deepEqual(parseJcbUpdates(jcbXML('6.1.2').replace('github.com', 'attacker.invalid')), []);
});

test('JCB tags expose a source commit, never a fabricated archive hash', () => {
  const parsed = parseJcbTags([{ name: 'v5.1.9', commit: { sha: 'c'.repeat(40) } }, { name: 'v9.9.9', commit: { sha: 'bad' } }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].version, '5.1.9');
  assert.equal(parsed[0].gitCommit, 'c'.repeat(40));
  assert.equal(parsed[0].sha512, null);
});

test('discovery handles multiple sources independently and reports unavailable feeds', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith('https://test.invalid/releases?')) return { ok: true, json: async () => [joomlaRelease('6.2.0-rc2')] };
    if (url === 'https://test.invalid/nightly') return { ok: true, text: async () => nightlyXML('7.0.0-alpha1-dev') };
    if (url === 'https://test.invalid/down') throw new Error('offline');
    if (url.startsWith('https://test.invalid/branches?')) return { ok: true, json: async () => [{ name: '6.x' }, { name: '../../evil' }] };
    if (url.startsWith('https://test.invalid/tags?')) return { ok: true, json: async () => [{ name: 'v6.2.1-alpha1', commit: { sha: 'c'.repeat(40) } }, { name: 'v5.1.9', commit: { sha: 'd'.repeat(40) } }] };
    if (url === 'https://test.invalid/raw/6.x/componentbuilder_update_server.xml') return { ok: true, text: async () => jcbXML('6.2.1-alpha1') };
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const pages = [];
  const result = await discoverDynamicCatalog({ fetchImpl, sources: { releases: 'https://test.invalid/releases', nightlyURLs: ['https://test.invalid/nightly', 'https://test.invalid/down'], branches: 'https://test.invalid/branches', jcbRawBase: 'https://test.invalid/raw', jcbTags: 'https://test.invalid/tags' }, onJoomlaPage: (_entries, page) => pages.push(page) });
  assert.deepEqual(pages, [1]);
  assert.deepEqual(result.joomla.map((entry) => entry.version), ['7.0.0-alpha1-dev', '6.2.0-rc2']);
  assert.equal(result.jcb[0].version, '6.2.1-alpha1');
  assert.equal(result.jcb[0].sha512, sha512);
  assert.equal(result.jcb[0].gitCommit, 'c'.repeat(40));
  assert.equal(result.jcb[1].sha512, null);
  assert.deepEqual(result.errors, [{ source: 'joomla-nightlies-2', message: 'offline' }]);
});

test('catalog cache avoids repeated requests and reports stale metadata after a refresh fails', async () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  let time = 100_000;
  let offline = false;
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (offline) throw new Error('offline');
    if (url.startsWith('https://test.invalid/releases?')) return { ok: true, json: async () => [joomlaRelease('6.2.0')] };
    if (url.startsWith('https://test.invalid/branches?')) return { ok: true, json: async () => [{ name: '6.x' }] };
    if (url.startsWith('https://test.invalid/tags?')) return { ok: true, json: async () => [] };
    if (url === 'https://test.invalid/raw/6.x/componentbuilder_update_server.xml') return { ok: true, text: async () => jcbXML('6.2.1-alpha1') };
    throw new Error('Unexpected request');
  };
  const options = { fetchImpl, cacheStorage: storage, cacheTtlMs: 1000, now: () => time,
    sources: { releases: 'https://test.invalid/releases', nightlyURLs: [], branches: 'https://test.invalid/branches', jcbRawBase: 'https://test.invalid/raw', jcbTags: 'https://test.invalid/tags' } };
  const first = await discoverDynamicCatalog(options);
  assert.equal(first.joomla.length, 1);
  assert.equal(first.errors.length, 0);
  const firstCount = calls;
  time += 999;
  assert.equal((await discoverDynamicCatalog(options)).joomla.length, 1);
  assert.equal(calls, firstCount);
  offline = true;
  const stale = await discoverDynamicCatalog({ ...options, forceRefresh: true });
  assert.equal(stale.joomla.length, 1);
  assert.equal(stale.jcb.length, 1);
  assert.equal(stale.errors.length, 4);
  assert.ok(stale.errors.every((error) => error.message.includes('cached copy')));
  time += 24 * 60 * 60_000;
  const expired = await discoverDynamicCatalog(options);
  assert.equal(expired.joomla.length, 0);
  assert.ok(expired.errors.every((error) => error.message === 'offline'));
});

test('bounded pagination announces partial catalogs and reports both types of page progress', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://test.invalid/releases?')) return { ok: true, json: async () => Array.from({ length: 100 }, () => joomlaRelease('6.2.0')) };
    if (url.startsWith('https://test.invalid/branches?')) return { ok: true, json: async () => [{ name: '6.x' }] };
    if (url.startsWith('https://test.invalid/tags?')) return { ok: true, json: async () => Array.from({ length: 100 }, () => ({ name: 'v6.2.0', commit: { sha: 'c'.repeat(40) } })) };
    if (url === 'https://test.invalid/raw/6.x/componentbuilder_update_server.xml') return { ok: true, text: async () => jcbXML('6.2.0') };
    throw new Error('Unexpected request');
  };
  const pages = [];
  const result = await discoverDynamicCatalog({ fetchImpl, maxPages: 1, cacheStorage: null,
    sources: { releases: 'https://test.invalid/releases', nightlyURLs: [], branches: 'https://test.invalid/branches', jcbRawBase: 'https://test.invalid/raw', jcbTags: 'https://test.invalid/tags' },
    onJoomlaPage: (_entries, page) => pages.push(`joomla-${page}`), onJcbPage: (_entries, page) => pages.push(`jcb-${page}`) });
  assert.deepEqual(pages.sort(), ['jcb-1', 'joomla-1']);
  assert.equal(result.errors.filter((entry) => entry.message.includes('partial')).length, 2);
});

test('an aborted refresh never falls back to cached metadata', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverDynamicCatalog({ signal: controller.signal, fetchImpl: async () => { throw new Error('Unexpected fetch'); } }), { name: 'AbortError' });
});

test('official list feeds discover new nightly versions and direct JCB manifests survive unavailable GitHub metadata', async () => {
  let version = '7.0.0-alpha1-dev';
  const requests = [];
  const data = new Map();
  const cacheStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.startsWith('https://api.github.com/')) return { ok: false, status: 403 };
    if (url.startsWith('https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/')) return { ok: true, text: async () => jcbXML('6.2.1-alpha1') };
    if (url.endsWith('_list.xml')) return { ok: true, text: async () => nightlyList() };
    if (url === 'https://update.joomla.org/core/nightlies/next_patch_extension.xml') return { ok: true, text: async () => nightlyXML(version) };
    throw new Error(`Unexpected request ${url}`);
  };
  const result = await discoverDynamicCatalog({ fetchImpl, cacheStorage });
  assert.deepEqual(result.joomla.map((entry) => entry.version), ['7.0.0-alpha1-dev']);
  assert.deepEqual(result.jcb.map((entry) => entry.version), ['6.2.1-alpha1']);
  assert.equal(requests.filter((url) => url.endsWith('next_patch_extension.xml')).length, 1, 'Shared details feed is fetched once.');
  assert.equal(requests.filter((url) => url.endsWith('_list.xml')).length, 3);
  assert.equal(result.errors.length, 3, 'GitHub errors do not hide direct-feed results.');
  version = '7.0.0-beta1-dev';
  assert.equal((await discoverDynamicCatalog({ fetchImpl, cacheStorage, forceRefresh: true })).joomla[0].version, version);
});

test('catalog ordering places final releases above their release candidates, then beta and alpha', async () => {
  const versions = ['6.2.0-rc2', '6.2.0-beta2', '6.2.0', '6.2.0-alpha1', '6.2.0-rc10', '6.2.0-rc10-dev'];
  const result = await discoverDynamicCatalog({ cacheStorage: null, sources: { nightlyURLs: [], branches: 'https://test.invalid/branches' },
    fetchImpl: async (url) => {
      if (url.includes('/releases?')) return { ok: true, json: async () => versions.map((version) => joomlaRelease(version)) };
      if (url.includes('/tags?')) return { ok: true, json: async () => versions.map((version) => ({ name: `v${version}`, commit: { sha: 'c'.repeat(40) } })) };
      return { ok: true, json: async () => [] };
    } });
  const expected = ['6.2.0', '6.2.0-rc10', '6.2.0-rc10-dev', '6.2.0-rc2', '6.2.0-beta2', '6.2.0-alpha1'];
  assert.deepEqual(result.joomla.map((entry) => entry.version), expected);
  assert.deepEqual(result.jcb.map((entry) => entry.version), expected);
});
