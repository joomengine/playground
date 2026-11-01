import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { readURLConfiguration } from '../src/config.mjs';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const archive = Buffer.from(zipSync({ 'selection-fixture.txt': strToU8('Selection and transfer fixture; installation is covered by the runtime suite.') }));
const sha256 = createHash('sha256').update(archive).digest('hex');
const sha512 = createHash('sha512').update(archive).digest('hex');
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
  test(`version selection uses a short local catalog and downloads only for installation (${name})`, { timeout: 90_000 }, async () => {
    let nightlyVersion = '7.0.0-alpha1-dev';
    let jcbStableVersion = '6.2.0';
    let catalogUnavailable = false;
    const catalog = () => ({ schemaVersion: 1, generatedAt: '2026-10-31T00:00:00.000Z', errors: [],
      joomla: ['5.4.11-dev', '6.2.1-dev', '6.3.0-alpha1-dev', nightlyVersion].map(version => ({
        version, label: `Joomla ${version}`, url: `packages/${sha256}.zip`, sha256,
        channel: 'nightly', source: 'nightly', prerelease: true, phpMinimum: '8.4.0',
      })),
      jcb: [{ version: jcbStableVersion, label: `JCB ${jcbStableVersion}`, channel: 'stable' },
        { version: '6.2.1-alpha1', label: 'JCB 6.2.1-alpha1', channel: 'preview' }].map(entry => ({
        ...entry, source: 'jcb-update', url: `packages/${sha256}.zip`, sha256, sha512,
      })),
    });
    const server = await createStaticServer({ directory, fixtures: {
      'assets/manifest.json': JSON.stringify(runtimeManifest),
      'assets/version-catalog.json': () => catalogUnavailable ? '{}' : JSON.stringify(catalog()),
      [`assets/packages/${sha256}.zip`]: archive,
    } });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [], downloads = [], upstream = [], dialogs = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      page.on('request', request => {
        if (request.url().endsWith('.zip')) downloads.push(request.url());
        if (/^https:\/\/(?:api\.github\.com|raw\.githubusercontent\.com|github\.com|update\.joomla\.org|developer\.joomla\.org)\//.test(request.url())) upstream.push(request.url());
      });
      await page.addInitScript(() => {
        const originalNow = Date.now;
        window.catalogTimeOffset = 0;
        Date.now = () => originalNow() + window.catalogTimeOffset;
      });
      await page.goto(`${server.url}?start=0`);
      await page.locator('#embedded-launch:enabled').waitFor();
      await page.locator('#settings-toggle').click();
      assert.deepEqual(await page.locator('#joomla-version optgroup').evaluateAll(groups => groups.map(group => group.label)), ['Current stable', 'Nightly builds']);
      assert.equal(await page.locator('#joomla-version option').count(), 6);
      assert.equal(await page.locator('#joomla-version').inputValue(), '6.2.0');
      assert.equal(await page.locator('#jcb-version').inputValue(), '6.2.0');
      assert.deepEqual(downloads, []);
      assert.deepEqual(upstream, []);

      await page.locator('#deploy').selectOption('blank');
      await page.waitForFunction(() => document.getElementById('jcb-version').value === 'none' && !document.getElementById('launch-button').disabled);
      await page.locator('#jcb-version').selectOption('6.2.1-alpha1');
      await page.locator('#launch-button:enabled').waitFor();
      const jcb = await selectedConfiguration(page);
      const packageURL = `${server.url}assets/packages/${sha256}.zip`;
      assert.deepEqual(jcb.jcbPackage, { url: packageURL, sha256, sha512 });
      await page.locator('#joomla-version').selectOption(nightlyVersion);
      await page.locator('#launch-button:enabled').waitFor();
      const selected = await selectedConfiguration(page);
      assert.deepEqual(selected.joomlaPackage, { url: packageURL, sha256, php: ['8.4', '8.5'] });
      assert.equal(await page.locator('#php-version option[value="8.3"]').isDisabled(), true, JSON.stringify(await page.evaluate(() => ({
        joomla: document.getElementById('joomla-version').value, php: document.getElementById('php-version').value,
        note: document.getElementById('compatibility-note').textContent,
        feedback: document.getElementById('feedback')?.textContent,
      }))));
      assert.equal(await page.locator('#package-download-dialog').count(), 0);
      assert.deepEqual(downloads, [], 'Choosing Joomla/JCB only records the published metadata.');
      assert.deepEqual(dialogs, []);

      // Exercise the same package-fetch function the runtime uses after Launch;
      // real Joomla installation is independently covered by the runtime suite.
      const transferred = await page.evaluate(async ({ url, sha256 }) => {
        const { createPackageFetcher } = await import('./src/dynamic-packages.mjs');
        const response = await createPackageFetcher([{ url, sha256 }])(url);
        return [...new Uint8Array(await response.arrayBuffer())].slice(0, 4);
      }, selected.joomlaPackage);
      assert.deepEqual(transferred, [0x50, 0x4b, 3, 4]);
      assert.deepEqual(downloads, [packageURL]);

      nightlyVersion = '7.0.0-alpha2-dev';
      await page.evaluate(() => { window.catalogTimeOffset = 6 * 60_000; });
      await page.locator('#joomla-version').focus();
      await page.locator(`#joomla-version option[value="${nightlyVersion}"]`).waitFor({ state: 'attached' });
      assert.equal(await page.locator('#joomla-version').inputValue(), '7.0.0-alpha1-dev');
      assert.equal(await page.locator('#joomla-version option[value="7.0.0-alpha1-dev"]').evaluate(option => option.parentElement.label), 'Saved version');
      assert.deepEqual((await selectedConfiguration(page)).joomlaPackage, selected.joomlaPackage);
      assert.deepEqual(upstream, []);
      assert.deepEqual(errors, []);

      // A temporary catalog outage retains the verified default launch choices.
      catalogUnavailable = true;
      const fallback = await context.newPage();
      await fallback.goto(`${server.url}?start=0`);
      await fallback.locator('#embedded-launch:enabled').waitFor();
      assert.equal(await fallback.locator('#joomla-version').inputValue(), '6.2.0');
      assert.equal(await fallback.locator('#joomla-version option').count(), 2);
      await fallback.close();

      // Future stable publications replace pinned defaults for newly created sites.
      catalogUnavailable = false;
      jcbStableVersion = '6.2.1';
      const current = await context.newPage();
      await current.goto(`${server.url}?start=0`);
      await current.locator('#embedded-launch:enabled').waitFor();
      assert.equal(await current.locator('#jcb-version').inputValue(), '6.2.1');
      await current.locator('#settings-toggle').click();
      await current.locator('#deploy-editor-button').click();
      await current.locator('#editor-deployment').selectOption('jcb');
      await current.locator('#use-deploy:enabled').waitFor();
      assert.equal(await current.locator('#jcb-version').inputValue(), '6.2.1');
      assert.equal(await current.locator('#jcb-version option[value="6.2.0"]').count(), 0);
      await current.close();
    } finally { await browser?.close(); await server.close(); }
  });
}
