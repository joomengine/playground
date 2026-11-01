import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createStaticServer } from './server.mjs';

test('deployment editor clones core recipes, saves reloadable customs and imports complete JSON', { timeout: 60_000 }, async () => {
  const manifest = { php: [{ version: '8.3' }, { version: '8.4' }],
    joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.3', '8.4'] }],
    defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } };
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: {
    'assets/manifest.json': JSON.stringify(manifest),
    'assets/version-catalog.json': JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-01T00:00:00Z', joomla: [], jcb: [], errors: [] }),
  } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${server.url}?start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#settings-toggle').click();
    await page.locator('#deploy').selectOption('servicedirectory');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), 'none');
    await page.locator('#jcb-version').selectOption('6.2.0');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), '6.2.0');
    await page.locator('#deploy').selectOption('heritage-demo');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), 'none');
    await page.locator('#deploy').selectOption('jcb');
    await page.locator('#launch-button:enabled').waitFor();
    await page.locator('#joomla-version').selectOption('5.4.10');
    await page.locator('#launch-button:enabled').waitFor();
    assert.match(await page.locator('#jcb-version').inputValue(), /^5\./);
    await page.locator('#deploy').selectOption('jcb-mcp');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#joomla-version').inputValue(), '6.2.0');
    await page.locator('#deploy').selectOption('jcb');
    await page.locator('#launch-button:enabled').waitFor();
    await page.locator('#deploy-editor-button').click();
    assert.equal(await page.locator('#editor-deployment').inputValue(), 'jcb');
    assert.equal(await page.locator('#jcb-version option[value="none"]').isDisabled(), true);
    assert.ok(JSON.parse(await page.locator('#extensions').inputValue()).length > 0, 'Core packages are visible in the editor.');
    await page.locator('#editor-deployment').selectOption('servicedirectory');
    await page.locator('#save-deployment:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), 'none');
    const originalName = await page.locator('#site-name').inputValue();
    await page.locator('#site-name').fill('My saved directory');
    assert.match(await page.locator('#deployment-name').inputValue(), /Custom/);
    await page.locator('#admin-username').fill('directory-admin');
    await page.locator('#extension-advanced summary').click();
    const packages = JSON.parse(await page.locator('#extensions').inputValue());
    packages.push({ url: 'https://packages.example.test/custom.zip', sha256: 'ignored-user-checksum' });
    await page.locator('#extensions').fill(JSON.stringify(packages));
    await page.locator('#extension-advanced summary').click();
    await page.locator('#save-deployment').click();
    await page.locator('#deployment-save-status:not([hidden])').waitFor();
    const customId = await page.locator('#editor-deployment').inputValue();
    assert.match(customId, /^custom-/);
    assert.equal(await page.locator('#delete-deployment').isEnabled(), true);
    await page.locator('#editor-deployment').selectOption('servicedirectory');
    await page.locator('#save-deployment:enabled').waitFor();
    assert.equal(await page.locator('#site-name').inputValue(), originalName, 'Core selection is unchanged by its clone.');
    assert.equal(await page.locator('#delete-deployment').isDisabled(), true);
    await page.locator('#editor-deployment').selectOption(customId);
    await page.locator('#save-deployment:enabled').waitFor();
    assert.equal(await page.locator('#site-name').inputValue(), 'My saved directory');
    assert.equal(await page.locator('#admin-username').inputValue(), 'directory-admin');
    await mkdir('test-results', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'test-results/deployment-editor-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#deploy-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'The editor fits a narrow viewport.');
    assert.equal(await page.locator('#save-deployment').isVisible(), true);
    assert.equal(await page.locator('#delete-deployment').isVisible(), true);
    await page.screenshot({ path: 'test-results/deployment-editor-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const downloaded = page.waitForEvent('download');
    await page.locator('#export-config').click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    let json = ''; for await (const chunk of stream) json += chunk.toString();
    const document = JSON.parse(json);
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.configuration.siteName, 'My saved directory');
    assert.equal(document.configuration.admin.username, 'directory-admin');
    assert.ok(document.configuration.extensions.length > 0);
    assert.deepEqual(document.configuration.addonExtensions, [{ url: 'https://packages.example.test/custom.zip' }]);
    await page.reload();
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#deploy-editor-button').click();
    assert.equal(await page.locator(`#editor-deployment option[value="${customId}"]`).count(), 1);
    await page.locator('#import-config').setInputFiles({ name: 'directory.json', mimeType: 'application/json', buffer: Buffer.from(json) });
    await page.waitForFunction(id => document.getElementById('editor-deployment').value.startsWith('custom-') && document.getElementById('editor-deployment').value !== id, customId);
    assert.equal(await page.locator('#site-name').inputValue(), 'My saved directory');
    const importedId = await page.locator('#editor-deployment').inputValue();
    await page.evaluate(({ document: recipe, id, baseURL }) => {
      const storageKey = 'saved-custom-instance';
      const { admin, ...configuration } = recipe.configuration;
      const publicRecipe = { ...recipe, configuration };
      localStorage.setItem(`joomengine:launch:${baseURL}`, JSON.stringify({ schemaVersion: 2, active: null,
        sites: { [storageKey]: { ...configuration, deployId: id, deploymentRecipe: publicRecipe,
          persistence: true, storageKey, displayName: 'Existing saved site', lastPath: '/' } } }));
    }, { document, id: importedId, baseURL: server.url });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#delete-deployment').click();
    await page.waitForFunction(id => !document.querySelector(`#editor-deployment option[value="${id}"]`), importedId);
    assert.equal(await page.locator(`#editor-deployment option[value="${customId}"]`).count(), 1);
    await page.reload();
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#settings-toggle').click();
    await page.locator('#saved-site').selectOption('saved-custom-instance');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#deploy').inputValue(), importedId, 'An installed site keeps its standalone recipe after the reusable entry is deleted.');
    await page.locator('#edit-deployment').click();
    assert.equal(await page.locator('#site-name').inputValue(), 'My saved directory');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await server.close(); }
});

test('editor Use creates a new instance while dashboard Launch resumes a closed saved site', { timeout: 30_000 }, async () => {
  const manifest = { php: [{ version: '8.4' }], joomla: [{ version: '6.2.0', php: ['8.4'] }],
    defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } };
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: {
    'assets/manifest.json': JSON.stringify(manifest),
    'assets/version-catalog.json': JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-01T00:00:00Z', joomla: [], jcb: [], errors: [] }),
    // Record the app/runtime boundary; actual independent databases are covered
    // by browser.test.mjs. This fixture needs no PHP downloads to prove identity.
    'src/playground.mjs': `
      export async function prepareEnvironment() { return { reloadRequired: false }; }
      export async function resetPlayground() {}
      export async function createPlayground(configuration) {
        (window.launchedConfigurations ||= []).push(structuredClone(configuration));
        const baseUrl = new URL('./', location.href).href;
        return { configuration, baseUrl, url: new URL('__test__.html', baseUrl).href, healthy: true,
          debugger: { state: 'idle' }, installation: { siteName: configuration.siteName, administrator: configuration.admin },
          async request() { return new Response('Ready'); }, async flush() {}, async close() {}, async reset() {} };
      }`,
  } });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${server.url}?deploy=blank`);
    await page.locator('#launch-countdown:not([hidden])').waitFor();
    for (const id of ['stop-countdown', 'stop-countdown-button']) {
      assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), 'Stop countdown');
      assert.equal(await page.locator(`#${id}`).evaluate(button => button.classList.contains('je-icon-only')), true);
      assert.equal(await page.locator(`#${id} .je-icon`).count(), 1);
    }
    await page.locator('#stop-countdown').click();
    assert.equal(await page.locator('#new-site-button').count(), 0);
    await page.locator('#embedded-launch').click();
    await page.locator('#site-frame').waitFor();
    await page.locator('#settings-toggle').click();
    await page.locator('#close-button:enabled').click();
    await page.locator('#welcome:not([hidden])').waitFor();
    await page.locator('#embedded-launch').click();
    await page.locator('#site-frame').waitFor();
    await page.locator('#settings-toggle').click();
    await page.locator('#close-button:enabled').click();
    await page.locator('#welcome:not([hidden])').waitFor();
    await page.locator('#deploy-editor-button').click();
    const originalName = await page.locator('#site-name').inputValue();
    await page.locator('#use-deploy').click();
    await page.locator('#site-frame').waitFor();
    const launches = await page.evaluate(() => window.launchedConfigurations);
    assert.equal(launches.length, 3);
    assert.equal(launches[0].storageKey, launches[1].storageKey, 'Dashboard Launch reopens the closed saved identity.');
    assert.notEqual(launches[1].storageKey, launches[2].storageKey, 'Use creates a separate identity even without edits or a running runtime.');
    assert.equal(launches[2].siteName, originalName);
    assert.deepEqual(launches[1].admin, launches[2].admin, 'The chosen administrator is preserved.');
    const saved = await page.evaluate(baseURL => JSON.parse(localStorage.getItem(`joomengine:launch:${baseURL}`)), server.url);
    assert.ok(saved.sites[launches[0].storageKey], 'The original saved site remains available.');
    assert.ok(saved.sites[launches[2].storageKey]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
