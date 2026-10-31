import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverDynamicCatalog, parseJoomlaReleases, parseJoomlaNightlies, parseJoomlaNightlyList, parseJoomlaNightlyUpdates, parseJcbUpdates, parseJcbTags, selectCurrentForwardVersions } from '../src/dynamic-catalog.mjs';

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

test('current and forward policy excludes history and superseded previews, with stable first', () => {
  const versions = ['4.4.14', '5.4.9', '5.4.10', '5.4.10-rc1', '5.4.11-dev',
    '6.1.6', '6.2.0', '6.2.0-rc2', '6.2.1-dev', '6.2.2-dev', '6.3.0-alpha1-dev',
    '6.3.0-alpha1', '6.3.0-beta1', '6.3.0-rc2', '6.4.0-alpha1', '7.0.0-alpha1-dev', '7.0.0-alpha1', '8.0.0-alpha1'];
  const entries = versions.map(version => ({ version, url: `https://test.invalid/${version}.zip` }));
  const result = selectCurrentForwardVersions(entries);
  assert.deepEqual(result.map(entry => [entry.version, entry.channel]), [
    ['6.2.0', 'stable'], ['5.4.10', 'stable'],
    ['7.0.0-alpha1-dev', 'nightly'], ['6.3.0-alpha1-dev', 'nightly'], ['6.2.2-dev', 'nightly'], ['5.4.11-dev', 'nightly'],
    ['7.0.0-alpha1', 'preview'], ['6.4.0-alpha1', 'preview'], ['6.3.0-rc2', 'preview'],
  ]);
  assert.equal(result[0].url, 'https://test.invalid/6.2.0.zip');
  assert.equal(entries[0].channel, undefined, 'Policy must not mutate source metadata.');
  assert.deepEqual(selectCurrentForwardVersions([{ version: '6.2.0' }, { version: '6.2.1' }, { version: '6.2.1-rc1' }])
    .map(entry => entry.version), ['6.2.1'], 'A new stable replaces its older stable and preview.');
});

test('discovery uses the supplied channels once and never traverses historical APIs', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === 'https://api.github.com/repos/joomla/joomla-cms/releases?per_page=100&page=1') {
      return { ok: true, json: async () => [joomlaRelease('6.2.0'), joomlaRelease('5.4.10'),
        ...Array.from({ length: 98 }, () => joomlaRelease('4.4.14'))] };
    }
    if (url.endsWith('_list.xml')) return { ok: true, text: async () => nightlyList() };
    if (url === 'https://update.joomla.org/core/nightlies/next_patch_extension.xml') {
      return { ok: true, text: async () => nightlyXML('7.0.0-alpha1-dev') + nightlyXML('6.2.1-dev') };
    }
    if (url === 'https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/5.x/componentbuilder_update_server.xml') {
      return { ok: true, text: async () => jcbXML('5.2.0') + jcbXML('5.2.1-alpha1') + jcbXML('6.2.0') + jcbXML('4.2.0') };
    }
    if (url === 'https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/6.x/componentbuilder_update_server.xml') {
      return { ok: true, text: async () => jcbXML('6.2.0') + jcbXML('6.2.1-alpha1') + jcbXML('5.2.0') + jcbXML('6.1.2', sha512, '6.1.3') };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await discoverDynamicCatalog({ fetchImpl, cacheStorage: null });
  assert.deepEqual(result.errors, []);
  assert.equal(requests.length, 7, 'One release list, three nightly lists, one deduplicated details feed, two JCB feeds.');
  assert.deepEqual(result.joomla.map(entry => entry.version), ['6.2.0', '5.4.10', '7.0.0-alpha1-dev', '6.2.1-dev']);
  assert.deepEqual(result.jcb.map(entry => entry.version), ['6.2.0', '5.2.0', '6.2.1-alpha1', '5.2.1-alpha1']);
  assert.ok(result.jcb.every(entry => entry.sha512 === sha512));
  assert.equal(result.joomla.find(entry => entry.version.startsWith('7.')).phpMinimum, '8.3.0');
});

test('independent feed failures retain pinned baselines without admitting obsolete metadata', async () => {
  const result = await discoverDynamicCatalog({ cacheStorage: null,
    pinnedJoomla: [{ version: '5.4.10', url: '/pinned-5.zip' }, { version: '6.2.0', url: '/pinned-6.zip' }],
    pinnedJcb: [{ version: '5.2.0', url: '/pinned-jcb.zip' }],
    sources: { releases: 'https://test.invalid/releases', nightlyURLs: ['https://test.invalid/nightly'], jcbURLs: ['https://test.invalid/jcb'] },
    fetchImpl: async url => {
      if (url === 'https://test.invalid/nightly') return { ok: true, text: async () => nightlyXML('7.0.0-alpha1-dev') };
      if (url === 'https://test.invalid/jcb') return { ok: true, text: async () => jcbXML('5.1.9') + jcbXML('5.2.1-alpha1') };
      throw new Error('offline');
    } });
  assert.deepEqual(result.joomla.map(entry => entry.version), ['6.2.0', '5.4.10', '7.0.0-alpha1-dev']);
  assert.deepEqual(result.jcb.map(entry => entry.version), ['5.2.0', '5.2.1-alpha1']);
  assert.deepEqual(result.errors, [{ source: 'joomla-releases', message: 'offline' }]);
});

test('overlapping JCB feeds deduplicate identical packages but reject conflicting published checksums', async () => {
  const result = await discoverDynamicCatalog({ cacheStorage: null,
    sources: { nightlyURLs: [], jcbURLs: ['https://test.invalid/jcb5', 'https://test.invalid/jcb6'] },
    fetchImpl: async url => {
      if (url.includes('/releases?')) return { ok: true, json: async () => [] };
      return { ok: true, text: async () => jcbXML('5.2.0') + jcbXML('6.2.0', url.endsWith('6') ? 'c'.repeat(128) : sha512) };
    } });
  assert.deepEqual(result.jcb.map(entry => entry.version), ['5.2.0']);
});

test('catalog cache avoids repeated requests and expires stale metadata after a failed refresh', async () => {
  const data = new Map();
  const cacheStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  let time = 100_000, calls = 0, offline = false;
  const options = { cacheStorage, cacheTtlMs: 1000, now: () => time,
    sources: { nightlyURLs: [], jcbURLs: [] },
    fetchImpl: async () => {
      calls++;
      if (offline) throw new Error('offline');
      return { ok: true, json: async () => [joomlaRelease('6.2.0')] };
    } };
  assert.equal((await discoverDynamicCatalog(options)).joomla.length, 1);
  time += 999;
  assert.equal((await discoverDynamicCatalog(options)).joomla.length, 1);
  assert.equal(calls, 1);
  offline = true;
  const stale = await discoverDynamicCatalog({ ...options, forceRefresh: true });
  assert.equal(stale.joomla.length, 1);
  assert.ok(stale.errors[0].message.includes('cached copy'));
  time += 24 * 60 * 60_000;
  const expired = await discoverDynamicCatalog(options);
  assert.equal(expired.joomla.length, 0);
  assert.equal(expired.errors[0].message, 'offline');
});

test('an aborted refresh never falls back to cached metadata', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverDynamicCatalog({ signal: controller.signal, fetchImpl: async () => { throw new Error('Unexpected fetch'); } }), { name: 'AbortError' });
});
