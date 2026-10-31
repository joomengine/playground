import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { readURLConfiguration } from '../src/config.mjs';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const archive = Buffer.from(zipSync({ 'selection-fixture.txt': strToU8('A package selection fixture; never installed.') }));
const sha256 = createHash('sha256').update(archive).digest('hex');
const sha512 = createHash('sha512').update(archive).digest('hex');
const jcbURL = 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v6.2.1-alpha1.zip';
const nightlyURL = version => `https://developer.joomla.org/nightlies/Joomla_${version}-Development-Full_Package.zip`;
const runtimeManifest = {
  php: [{ version: '8.3', patchVersion: '8.3.29' }, { version: '8.4', patchVersion: '8.4.1' }, { version: '8.5', patchVersion: '8.5.0' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.3', '8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
};

async function selectedConfiguration(page) {
  await page.locator('#share-button').click();
  await page.locator('#share-dialog[open]').waitFor();
  const result = readURLConfiguration(await page.locator('#share-url').inputValue()).config;
  await page.locator('#share-dialog [data-close-dialog]').click();
  return result;
}

for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`live release selection preserves defaults and verifies direct or local ZIPs (${name})`, { timeout: 90_000 }, async () => {
    const server = await createStaticServer({ directory, fixtures: { 'assets/manifest.json': JSON.stringify(runtimeManifest) } });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        const originalNow = Date.now;
        window.catalogTimeOffset = 0;
        Date.now = () => originalNow() + window.catalogTimeOffset;
      });
      let nightlyVersion = '7.0.0-alpha1-dev';
      let blockDownloads = true;
      const downloads = [];
      const headers = { 'Access-Control-Allow-Origin': '*' };
      await context.route('https://api.github.com/repos/**', route => route.fulfill({ headers, json: [] }));
      await context.route('https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/**/componentbuilder_update_server.xml', route => route.fulfill({
        headers, contentType: 'application/xml', body: `<updates><update><element>pkg_component_builder</element><version>6.2.1-alpha1</version><downloads><downloadurl type="full" format="zip">${jcbURL}</downloadurl></downloads><sha512>${sha512}</sha512></update></updates>`,
      }));
      await context.route('https://update.joomla.org/core/nightlies/*_list.xml', route => route.fulfill({
        headers, contentType: 'application/xml', body: '<extensionset><extension element="joomla" type="file" detailsurl="https://update.joomla.org/core/nightlies/next_major_extension.xml" /></extensionset>',
      }));
      await context.route('https://update.joomla.org/core/nightlies/*_extension.xml', route => route.fulfill({
        headers, contentType: 'application/xml', body: `<updates><update><version>${nightlyVersion}</version><php_minimum>8.4.0</php_minimum><downloads><downloadurl>${nightlyURL(nightlyVersion).replace('-Full_Package.zip', '-Update_Package.zip')}</downloadurl></downloads></update></updates>`,
      }));
      for (const pattern of ['https://developer.joomla.org/nightlies/*.zip', jcbURL]) await context.route(pattern, async route => {
        downloads.push(route.request().url());
        if (blockDownloads) await route.abort('failed');
        else await route.fulfill({ headers, contentType: 'application/zip', body: archive });
      });

      await page.goto(`${server.url}?start=0`);
      await page.locator('#embedded-launch:enabled').waitFor();
      await page.locator('#settings-toggle').click();
      await page.locator('#joomla-version option[value="7.0.0-alpha1-dev"]').waitFor({ state: 'attached' });
      await page.locator('#jcb-version option[value="6.2.1-alpha1"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('#joomla-version').inputValue(), '6.2.0');
      assert.equal(await page.locator('#php-version').inputValue(), '8.4');
      assert.equal(await page.locator('#jcb-version').inputValue(), '6.2.0');
      assert.deepEqual(downloads, [], 'Discovering choices does not download their packages or alter pinned defaults.');

      await page.locator('#deploy').selectOption('blank');
      await page.waitForFunction(() => document.getElementById('jcb-version').value === 'none' && !document.getElementById('launch-button').disabled);
      await page.locator('#deploy').selectOption('servicedirectory');
      await page.waitForFunction(() => document.getElementById('jcb-version').value === '6.2.0' && !document.getElementById('launch-button').disabled);
      await page.locator('#deploy').selectOption('blank');
      await page.waitForFunction(() => document.getElementById('jcb-version').value === 'none' && !document.getElementById('launch-button').disabled);

      const previous = await page.evaluate(() => Object.fromEntries(['deploy', 'joomla-version', 'php-version', 'storage-key', 'admin-password'].map(id => [id, document.getElementById(id).value])));
      await page.locator('#joomla-version').selectOption(nightlyVersion);
      await page.locator('#package-download-dialog[open]').waitFor();
      assert.equal(await page.locator('#package-download-link').getAttribute('href'), nightlyURL(nightlyVersion));
      assert.equal(await page.locator('#launch-button').isDisabled(), true, 'A pending package selection cannot launch an unrelated profile.');
      await page.locator('#package-download-cancel').click();
      await page.locator('#launch-button:enabled').waitFor();
      assert.deepEqual(await page.evaluate(() => Object.fromEntries(['deploy', 'joomla-version', 'php-version', 'storage-key', 'admin-password'].map(id => [id, document.getElementById(id).value]))), previous,
        'Cancelling a failed download restores the complete prior profile, including credentials and storage.');

      await page.locator('#jcb-version').selectOption('6.2.1-alpha1');
      await page.locator('#package-download-dialog[open]').waitFor();
      assert.equal(await page.locator('#package-download-link').getAttribute('href'), jcbURL);
      const wrongArchive = Buffer.from(zipSync({ 'wrong.txt': strToU8('Wrong version of the package.') }));
      await page.locator('#package-download-file').setInputFiles({ name: 'wrong.zip', mimeType: 'application/zip', buffer: wrongArchive });
      await page.waitForFunction(() => document.getElementById('package-download-error').textContent.includes('SHA-512'));
      assert.equal(await page.locator('#package-download-dialog').evaluate(dialog => dialog.open), true);
      await page.locator('#package-download-file').setInputFiles({ name: 'jcb.zip', mimeType: 'application/zip', buffer: archive });
      await page.locator('#package-download-dialog').waitFor({ state: 'hidden' });
      await page.locator('#launch-button:enabled').waitFor();
      assert.equal(await page.locator('#jcb-version').inputValue(), '6.2.1-alpha1');
      const imported = await selectedConfiguration(page);
      assert.deepEqual(imported.jcbPackage, { url: jcbURL, sha256, sha512 });
      assert.equal(imported.deployId, 'blank', 'Joomla-only accepts an explicit JCB selection.');

      blockDownloads = false;
      await page.locator('#joomla-version').selectOption(nightlyVersion);
      await page.locator('#launch-button:enabled').waitFor();
      assert.equal(await page.locator('#joomla-version').inputValue(), nightlyVersion);
      assert.equal(await page.locator('#php-version option[value="8.3"]').isDisabled(), true);
      assert.equal(await page.locator('#php-version option[value="8.4"]').isDisabled(), false);
      assert.equal(await page.locator('#jcb-version').inputValue(), 'none', 'A new Joomla-only profile keeps its default None.');
      const selected = await selectedConfiguration(page);
      assert.deepEqual(selected.joomlaPackage, { url: nightlyURL(nightlyVersion), sha256, php: ['8.4', '8.5'] });

      nightlyVersion = '7.0.0-alpha2-dev';
      await page.evaluate(() => { window.catalogTimeOffset = 6 * 60_000; });
      await page.locator('#joomla-version').focus();
      await page.locator('#joomla-version option[value="7.0.0-alpha2-dev"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('#joomla-version').inputValue(), '7.0.0-alpha1-dev', 'Refreshing available nightlies preserves the selected archive.');
      assert.deepEqual((await selectedConfiguration(page)).joomlaPackage, selected.joomlaPackage);
      assert.equal(await page.locator('#site-frame').count(), 0, 'This contract validates selection and transfer, not a fabricated Joomla installation.');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
