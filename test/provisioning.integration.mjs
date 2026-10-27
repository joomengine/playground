import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadBlueprintCatalog, resolveBlueprintConfiguration } from '../src/blueprints.mjs';
import { exportSite } from '../src/export.mjs';
import { checkJoomla, importJoomlaSnapshot, inspectJoomla, installJoomla, requestJoomlaPage, sha256 } from '../src/joomla/index.mjs';

const sourceLoader = (name) => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
const exportSource = () => readFile(new URL('../src/export/site.php', import.meta.url), 'utf8');

async function page(runtime, pathname) {
  const response = await requestJoomlaPage(runtime, pathname);
  assert.equal(response.status, 200, pathname);
  return response.text();
}

async function loginSite(runtime, administrator) {
  const html = await page(runtime, 'index.php?option=com_users&view=login');
  const token = html.match(/name="([a-f0-9]{32})"[^>]*value="1"/i)?.[1];
  assert.ok(token, 'The real site login form must issue a CSRF token.');
  const response = await runtime.request('index.php?option=com_users&task=user.login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: administrator.username, password: administrator.password,
      option: 'com_users', task: 'user.login', [token]: '1' }).toString(),
  });
  await response.arrayBuffer();
  assert.ok(response.status >= 200 && response.status < 400);
  assert.match(await page(runtime, 'index.php?option=com_users&view=login'), /user\.logout/);
}

for (const major of ['5', '6']) {
  test(`Joomla ${major}: real multilingual provisioning, saved login/logout, portable snapshot restoration`, { timeout: 600_000 }, async () => {
    let runtime;
    let restored;
    try {
      runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: major === '5' ? '8.3' : '8.4' });
      const catalog = parseCatalog(runtime.manifest);
      const release = catalog.joomla.find((item) => item.version.startsWith(`${major}.`));
      assert.ok(release, `The built artifact must stage Joomla ${major}.`);
      const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
      const blueprintCatalog = await loadBlueprintCatalog({
        url: new URL(runtime.manifest.blueprints.url, manifestURL), fetcher: runtime.fetchAsset,
      });
      const { configuration } = await resolveBlueprintConfiguration({
        blueprintId: 'heritage-demo', joomlaVersion: release.version,
        phpVersion: runtime.phpVersion, fresh: true, persistence: false,
        admin: { name: 'Integration Administrator', username: 'admin', email: 'admin@example.test', password: `Integration-${crypto.randomUUID()}!` },
      }, { catalog, blueprintCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
      const archive = await runtime.fetchAsset(new URL(release.url, manifestURL));
      assert.equal(archive.status, 200);
      const options = { sourceLoader, fetchPackage: runtime.fetchAsset };
      const installed = await installJoomla(runtime, configuration, {
        ...options, archiveBytes: await archive.arrayBuffer(), sha256: release.sha256,
      });
      assert.equal(installed.resumed, false);
      assert.equal(installed.blueprintId, 'heritage-demo');
      assert.equal(installed.language, 'en-GB');
      assert.match(await page(runtime, 'index.php'), /Stories connect generations/);
      assert.match(await page(runtime, 'index.php'), /mod-languages/);
      assert.match(await page(runtime, 'index.php?lang=nl'), /Verhalen verbinden generaties/);
      assert.ok(await runtime.fs.stat('/persist/meta/administrator.json'));
      assert.equal(await runtime.fs.stat('/persist/www/meta/administrator.json'), null);

      await loginSite(runtime, installed.administrator);
      const loggedOut = await installJoomla(runtime, { ...configuration, autoLogin: false }, options);
      assert.equal(loggedOut.resumed, true);
      assert.match(await page(runtime, 'administrator/index.php'), /name="passwd"/);
      assert.match(await page(runtime, 'index.php?option=com_users&view=login'), /name="password"/);
      const resumed = await installJoomla(runtime, {
        ...configuration, language: 'nl-NL', admin: { ...configuration.admin, password: `Unused-${crypto.randomUUID()}!` },
      }, options);
      assert.equal(resumed.administrator.password, installed.administrator.password);
      assert.equal(resumed.language, 'nl-NL');
      const administratorPage = await page(runtime, 'administrator/index.php');
      assert.doesNotMatch(administratorPage, /name="passwd"/);
      assert.match(administratorPage, /lang="nl-nl"/i);
      await assert.rejects(installJoomla(runtime, { ...configuration, joomlaVersion: major === '5' ? '6.2.0' : '5.4.10' }, options), /another Joomla release/);

      const exported = await runtime.withExclusive((raw) => exportSite(raw, {}, { sourceLoader: exportSource }));
      assert.equal(exported.metadata.joomlaVersion, release.version);
      await runtime.close();
      runtime = undefined;
      restored = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: major === '5' ? '8.4' : '8.5' });
      const restoredConfiguration = {
        ...configuration, language: 'nl-NL', siteName: 'Restored heritage',
        admin: { ...configuration.admin, username: 'restored', password: `Restored-${crypto.randomUUID()}!` },
        addonStartupCommands: [['cache:clean']],
      };
      await assert.rejects(importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, archiveBytes: exported.bytes, sha256: '0'.repeat(64),
      }), /SHA-256 verification/);
      assert.equal((await inspectJoomla(restored, { sourceLoader })).marker, null, 'A checksum failure must not start importing.');
      const imported = await importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, fetchPackage: restored.fetchAsset, archiveBytes: exported.bytes, sha256: await sha256(exported.bytes),
      });
      assert.equal(imported.fromSnapshot, true);
      assert.equal(imported.resumed, false);
      assert.equal(imported.siteName, 'Restored heritage');
      assert.equal(imported.administrator.username, 'restored');
      assert.equal(imported.administrator.password, restoredConfiguration.admin.password);
      assert.equal((await checkJoomla(restored, { sourceLoader })).language, 'nl-NL');
      assert.match(await page(restored, 'index.php?lang=nl'), /Verhalen verbinden generaties/);
      assert.doesNotMatch(await page(restored, 'administrator/index.php'), /name="passwd"/);
      await assert.rejects(importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, archiveBytes: exported.bytes, sha256: await sha256(exported.bytes),
      }), /fresh playground/);
    } finally {
      await runtime?.close();
      await restored?.close();
    }
  });
}
