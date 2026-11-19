import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { updateJoomla } from '../scripts/update-joomla.mjs';
import { catalogWithSelectedJoomlaPackage, normalizeConfiguration, parseCatalog } from '../src/config.mjs';
import { catalogForRestoredSite } from '../src/site-import.mjs';
import { dynamicJoomlaChoices } from '../src/dynamic-selection.mjs';

const minimum = strToU8("<?php\ndefine('JOOMLA_MINIMUM_PHP', '8.4.2');\n");
const zip = zipSync({ 'index.php': minimum, 'installation/index.php': minimum });
const digest = createHash('sha256').update(zip).digest('hex');
function release(version) {
  const name = `Joomla_${version}-Stable-Full_Package.zip`;
  return { tag_name: version, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', digest: 'sha256:' + digest,
    browser_download_url: `https://github.com/joomla/joomla-cms/releases/download/${version}/${name}` }] };
}
function pin(version) {
  return { version, label: 'Joomla ' + version, php: ['8.3', '8.4', '8.5'], url: release(version).assets[0].browser_download_url, sha256: digest };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'playground-joomla-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'versions.json');
  const pins = { joomla: [pin('5.4.10'), pin('6.2.0')], php: ['8.3','8.4','8.5'], defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } };
  await writeFile(file, JSON.stringify(pins));
  const releases = [release('5.4.10'), release('6.2.0'), release('6.2.1'), { ...release('6.3.0'), prerelease: true }];
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.github.com/repos/joomla/joomla-cms/releases?per_page=100') {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.redirect, 'error');
      return Response.json(releases);
    }
    assert.equal(url, release('6.2.1').assets[0].browser_download_url);
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    return new Response(zip);
  };
  return { update: () => updateJoomla({ root, fetchImpl, token: 'test-token' }), file, releases, pins };
}

test('stable rotation changes only the selected baseline/default and retains previous exact installs for legacy saves', async t => {
  const { update, file, pins } = await fixture(t);
  assert.deepEqual(await update(), ['6.2.1']);
  const updated = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(updated.joomla[0], pins.joomla[0]);
  assert.deepEqual(updated.joomla[1].php, ['8.4', '8.5']);
  assert.deepEqual(updated.retiredJoomla, [pins.joomla[1]]);
  assert.equal(updated.defaults.joomlaVersion, '6.2.1');
  const before = await readFile(file);
  assert.deepEqual(await update(), []);
  assert.deepEqual(await readFile(file), before);
  const baseURL = 'https://playground.example/nested/';
  const catalog = parseCatalog(updated);
  const old = pins.joomla[1];
  const saved = { joomlaVersion: old.version, phpVersion: '8.3', storageKey: 'existing', admin: { password: 'restore-a-saved-site' } };
  assert.equal(dynamicJoomlaChoices(catalog, []).some(entry => entry.version === old.version), false);
  assert.equal(normalizeConfiguration(saved, { catalog }).joomlaVersion, old.version);
  const exact = catalogWithSelectedJoomlaPackage(catalog, saved, baseURL);
  assert.equal(exact.joomla.find(entry => entry.version === old.version).url, old.url);
  assert.equal(catalogWithSelectedJoomlaPackage(catalog, { joomlaVersion: '6.2' }, baseURL), catalog);
  const uploaded = { ...saved, restoredSite: { joomlaVersion: old.version, php: ['8.3'] } };
  assert.equal(catalogForRestoredSite(catalog, uploaded).joomla.find(entry => entry.version === old.version).url, undefined);
  for (const pathname of ['assets/joomla/Joomla_6.2.0.zip', 'joomla/Joomla_6.2.0.zip', 'my-archive.zip']) {
    const url = new URL(pathname, baseURL).href;
    const input = { ...saved, joomlaPackage: { url, sha256: old.sha256, php: ['8.3'] } };
    const selected = catalogWithSelectedJoomlaPackage(catalog, input, baseURL);
    const next = normalizeConfiguration(input, { catalog: selected, baseURL });
    assert.equal(next.joomlaPackage.url, pathname === 'my-archive.zip' ? url : old.url);
  }
});

test('unsigned, ambiguous, changed or missing current releases cannot partially rotate the stable baselines', async t => {
  for (const change of [
    items => { items[2].assets[0].digest = null; },
    items => { items[2].assets.push(items[2].assets[0]); },
    items => { items[2].assets[0].digest = 'sha256:' + 'a'.repeat(64); },
    items => { items[0].assets[0].digest = 'sha256:' + 'a'.repeat(64); },
    items => { items.splice(0, 1); },
  ]) {
    const { update, file, releases } = await fixture(t);
    const before = await readFile(file);
    change(releases);
    await assert.rejects(update());
    assert.deepEqual(await readFile(file), before);
  }
});
