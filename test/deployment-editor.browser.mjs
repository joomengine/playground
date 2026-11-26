import { continueLiveReplacement } from './live-replacement-contract.mjs';
import { assertExtensionFormValidation } from './extension-form-contract.mjs';
import { assertLaunchReadiness } from './launch-readiness-browser.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const presets = ['jcb', 'jcb-mcp', 'servicedirectory', 'blank', 'heritage-demo', 'patchtester', 'weblinks'];
const formManifest = { php: [{ version: '8.4' }], joomla: [{ version: '6.2.0', php: ['8.4'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } };
const formFixtures = {
  'assets/manifest.json': JSON.stringify(formManifest),
  'assets/version-catalog.json': JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-01T00:00:00Z', joomla: [], jcb: [], errors: [] }),
};
const jsonValue = async (page, id) => JSON.parse(await page.locator(`#${id}`).inputValue());

async function typeValue(control, value) {
  await control.click();
  await control.press('ControlOrMeta+A');
  await control.pressSequentially(value);
}

async function editJSON(page, detailsId, textareaId, value) {
  const advanced = page.locator(`#${detailsId}`);
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  await page.locator(`#${textareaId}`).fill(JSON.stringify(value));
  await advanced.locator(':scope > summary').click();
  await page.waitForFunction(id => !document.getElementById(id).open, detailsId);
}

async function exportDeployment(page) {
  const download = page.waitForEvent('download');
  await page.locator('#export-config').click();
  const stream = await (await download).createReadStream();
  let json = ''; for await (const chunk of stream) json += chunk.toString();
  return { json, document: JSON.parse(json) };
}

for (const browserName of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
for (const preset of presets) {
test(`Configure a deployment supports stable editing and saved copies for ${preset} (${browserName})`, { timeout: 90_000 }, async () => {
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: formFixtures });
  let browser;
  const diagnostics = { pageErrors: [], consoleErrors: [] };
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const failedRequests = [];
    page.on('requestfailed', request => failedRequests.push({
      url: request.url(), resourceType: request.resourceType(), reason: request.failure()?.errorText,
    }));
    page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || /Unable to check|invalid.*(?:regexp|regular expression)/i.test(message.text())) diagnostics.consoleErrors.push(message.text()); });
    await page.goto(`${server.url}?deploy=${preset}&start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    if (preset === 'blank') {
      if (await page.locator('#settings').isHidden()) await page.locator('#settings-toggle').click();
      await assertExtensionFormValidation(page);
    }
    await page.locator('#deploy-editor-button').click();
    assert.equal(await page.locator('#editor-deployment').inputValue(), preset);
    const originalName = await page.locator('#site-name').inputValue();
    const originalMenus = await jsonValue(page, 'deploy-menus');
    const originalContent = await jsonValue(page, 'deploy-content');
    const select = async id => {
      await page.locator('#editor-deployment').selectOption(id);
      await page.locator('#save-deployment:enabled').waitFor();
    };
    const save = async () => {
      await page.locator('#save-deployment').click();
      await page.waitForFunction(() => !document.getElementById('save-deployment').disabled
        && (!document.getElementById('deployment-save-status').hidden || !document.getElementById('deploy-error').hidden));
      const failure = await page.locator('#deploy-error').textContent();
      const invalid = await page.locator('#deploy-dialog input, #deploy-dialog select, #deploy-dialog textarea').evaluateAll(controls => controls
        .filter(control => !control.disabled && !control.validity.valid).map(control => control.id || control.getAttribute('aria-label')));
      assert.equal(await page.locator('#deploy-error').isVisible(), false, `Save failed: ${failure}; invalid controls: ${invalid.join(', ')}`);
      const id = await page.locator('#editor-deployment').inputValue();
      assert.match(id, /^custom-/);
      return id;
    };

    // The actual popup wiring must allow a click to reach a newly created field.
    await page.getByRole('button', { name: 'Menus and home pages', exact: true }).click();
    const menus = page.locator('#menu-inputs');
    await menus.getByRole('button', { name: 'Add menu item', exact: true }).click();
    const menuIndex = originalMenus.length;
    assert.equal(await menus.locator('.deployment-card').count(), menuIndex + 1);
    const menu = menus.locator('.deployment-card').nth(menuIndex);
    const title = menu.getByRole('textbox', { name: 'Title', exact: true });

    // Leave the required title unfinished while editing an unrelated field.
    // This deliberately crosses the old 150 ms background-validation deadline.
    await typeValue(page.locator('#template-name'), 'cassiopeia');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#template-name').evaluate(control => control === document.activeElement), true,
      'An incomplete menu must not take focus away from template editing.');
    await typeValue(title, `Saved ${preset} menu`);
    assert.equal(await title.inputValue(), `Saved ${preset} menu`);
    assert.equal(await menu.getByRole('textbox', { name: 'URL name', exact: true }).inputValue(), `saved-${preset}-menu`);
    await typeValue(menu.getByRole('textbox', { name: 'Menu', exact: true }), 'custom-menu');
    await menu.getByRole('checkbox', { name: 'Published', exact: true }).uncheck();
    assert.equal(await menu.getByRole('checkbox', { name: 'Published', exact: true }).isChecked(), false);
    const menuTitleNode = await title.elementHandle();
    await menus.getByRole('button', { name: 'Add menu item', exact: true }).click();
    await menus.locator('.deployment-card').last().getByRole('button', { name: /^Remove / }).click();
    assert.equal(await menuTitleNode.evaluate(control => control.isConnected), true, 'Adding/removing another menu preserves this input.');
    await menu.locator(':scope > summary').click();
    assert.equal(await menu.getAttribute('open'), null);
    await menu.locator(':scope > summary').click();
    assert.notEqual(await menu.getAttribute('open'), null);
    if (originalMenus.length) {
      const existing = menus.locator('.deployment-card').first();
      if (await existing.getAttribute('open') === null) await existing.locator(':scope > summary').click();
      await typeValue(existing.getByRole('textbox', { name: 'Title', exact: true }), 'Edited existing directory');
    }

    // Extension packages and setup commands remain ordinary editable rows.
    const packageCount = (await jsonValue(page, 'extensions')).length;
    await page.locator('#add-package').click();
    const packageRow = page.locator('#package-list .extension-url-row').last();
    await typeValue(packageRow.locator('input').first(), 'https://packages.example.test/extra.zip');
    assert.equal((await jsonValue(page, 'extensions')).at(-1).url, 'https://packages.example.test/extra.zip');
    await packageRow.locator('.extension-url-remove').click();
    assert.equal((await jsonValue(page, 'extensions')).length, packageCount);
    const commands = page.locator('#command-inputs');
    const commandCount = (await jsonValue(page, 'startup-commands')).length;
    await commands.getByRole('button', { name: 'Add command', exact: true }).click();
    const command = commands.locator('.deployment-card').last();
    await typeValue(command.getByRole('textbox', { name: 'Command', exact: true }), 'config:set');
    await command.getByRole('button', { name: 'Add argument', exact: true }).click();
    await typeValue(command.getByRole('textbox', { name: 'Argument 1', exact: true }), 'sitename');
    await command.getByRole('button', { name: 'Add argument', exact: true }).click();
    await typeValue(command.getByRole('textbox', { name: 'Argument 2', exact: true }), `Configured ${preset}`);
    assert.deepEqual((await jsonValue(page, 'startup-commands')).at(-1), ['config:set', 'sitename', `Configured ${preset}`]);
    await commands.getByRole('button', { name: 'Add command', exact: true }).click();
    await commands.locator('.deployment-card').last().getByRole('button', { name: 'Remove', exact: true }).click();
    assert.equal((await jsonValue(page, 'startup-commands')).length, commandCount + 1);

    // Both JSON and generated template fields edit the same saved values.
    await editJSON(page, 'template-advanced', 'template-params', { brand: 'Original brand' });
    await typeValue(page.locator('#template-parameter-inputs').getByRole('textbox', { name: 'Brand', exact: true }), `Brand ${preset}`);
    assert.equal((await jsonValue(page, 'template-params')).brand, `Brand ${preset}`);
    const languages = page.locator('#deploy-languages-entry');
    await typeValue(languages, 'pt-PT');
    await languages.press('Enter');
    assert.ok((await page.locator('#deploy-languages').inputValue()).split(',').map(tag => tag.trim()).includes('pt-PT'));
    await page.getByRole('button', { name: 'Remove pt-PT', exact: true }).click();
    assert.equal((await page.locator('#deploy-languages').inputValue()).split(',').map(tag => tag.trim()).includes('pt-PT'), false);

    // Content has separate category and article lists, including Heritage's existing cards.
    const content = page.locator('#content-inputs');
    const categories = content.locator('.deployment-list').filter({ has: page.getByRole('button', { name: 'Add category', exact: true }) });
    const articles = content.locator('.deployment-list').filter({ has: page.getByRole('button', { name: 'Add article', exact: true }) });
    const categoryIndex = originalContent?.categories?.length || 0;
    const articleIndex = originalContent?.articles?.length || 0;
    await content.getByRole('button', { name: 'Add category', exact: true }).click();
    const category = categories.locator(':scope > .deployment-card').nth(categoryIndex);
    const categoryTitle = category.getByRole('textbox', { name: 'Title', exact: true });
    await typeValue(categoryTitle, `News ${preset}`);
    const suggestions = await category.getByRole('combobox', { name: 'Language', exact: true }).evaluate(control => [...(control.list?.options || [])].map(option => option.value));
    assert.equal(suggestions.includes('*'), false, 'Content only suggests valid Joomla language tags.');
    await content.getByRole('button', { name: 'Add article', exact: true }).click();
    const article = articles.locator(':scope > .deployment-card').nth(articleIndex);
    await typeValue(article.getByRole('textbox', { name: 'Title', exact: true }), `Article ${preset}`);
    await article.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: `News ${preset}` });
    await typeValue(article.getByRole('textbox', { name: 'Article introduction', exact: true }), 'Saved article introduction.');
    await article.getByRole('checkbox', { name: 'Featured article', exact: true }).check();
    const categoryNode = await categoryTitle.elementHandle();
    await content.getByRole('button', { name: 'Add article', exact: true }).click();
    await articles.locator(':scope > .deployment-card').last().getByRole('button', { name: /^Remove / }).click();
    await content.getByRole('button', { name: 'Add category', exact: true }).click();
    await categories.locator(':scope > .deployment-card').last().getByRole('button', { name: /^Remove / }).click();
    assert.equal(await categoryNode.evaluate(control => control.isConnected), true, 'An article change must not rebuild category fields.');

    const overlays = page.locator('#overlay-inputs');
    await overlays.getByRole('button', { name: 'Add configuration', exact: true }).click();
    const overlay = overlays.locator('.deployment-card').last();
    await typeValue(overlay.getByRole('textbox', { name: 'Record GUID', exact: true }), '11111111-1111-4111-8111-111111111111');
    await typeValue(overlay.getByRole('textbox', { name: 'Repository name', exact: true }), `Repository ${preset}`);
    await overlay.getByRole('combobox', { name: 'Published', exact: true }).selectOption('0');
    await overlays.getByRole('button', { name: 'Add configuration', exact: true }).click();
    await overlays.locator('.deployment-card').last().getByRole('button', { name: 'Remove', exact: true }).click();
    assert.equal((await jsonValue(page, 'deploy-overlays')).at(-1).fields.published, 0);
    await typeValue(page.locator('#site-name'), `Custom ${preset} site`);
    assert.equal(await menuTitleNode.evaluate(control => control.isConnected), true, 'Unrelated sections preserve the original menu input.');

    const saveButton = page.locator('#save-deployment');
    await saveButton.scrollIntoViewIfNeeded();
    const scrollBeforeSave = await page.locator('#deploy-dialog').evaluate(dialog => dialog.scrollTop);
    const customId = await save();
    assert.equal(await menuTitleNode.evaluate(control => control.isConnected), true, 'Save does not reload the form it just stored.');
    assert.notEqual(await menu.getAttribute('open'), null, 'Save keeps expanded cards open.');
    assert.ok(Math.abs(await page.locator('#deploy-dialog').evaluate(dialog => dialog.scrollTop) - scrollBeforeSave) <= 1, 'Save preserves dialog scroll.');
    assert.equal(await page.locator('#site-frame').count(), 0, 'Configuring and saving must not launch Joomla.');
    const exported = await exportDeployment(page);
    const configuration = exported.document.configuration;
    assert.equal(configuration.siteName, `Custom ${preset} site`);
    assert.equal(configuration.menus[menuIndex].published, false);
    assert.equal(configuration.menus[menuIndex].menuType, 'custom-menu');
    assert.equal(configuration.content.categories[categoryIndex].title, `News ${preset}`);
    assert.equal(configuration.content.articles[articleIndex].introtext, 'Saved article introduction.');
    assert.equal(configuration.template.params.brand, `Brand ${preset}`);
    assert.equal(configuration.overlays.at(-1).fields.system_name, `Repository ${preset}`);
    await page.locator('#copy-deployment').click();
    await page.waitForFunction(id => document.getElementById('editor-deployment').value !== id && !document.getElementById('save-deployment').disabled, customId);
    const copyId = await page.locator('#editor-deployment').inputValue();
    assert.match(copyId, /^custom-/);
    await page.locator('#import-config').setInputFiles({ name: `${preset}.json`, mimeType: 'application/json', buffer: Buffer.from(exported.json) });
    await page.waitForFunction(id => document.getElementById('editor-deployment').value !== id && !document.getElementById('save-deployment').disabled, copyId);
    assert.equal(await page.locator('#site-name').inputValue(), `Custom ${preset} site`);
    await page.reload();
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#deploy-editor-button').click();
    await select(preset);
    assert.equal(await page.locator('#site-name').inputValue(), originalName, 'The original preset is unchanged.');
    assert.deepEqual(await jsonValue(page, 'deploy-menus'), originalMenus);
    await select(copyId);
    assert.equal(await page.locator('#site-name').inputValue(), `Custom ${preset} site`);
    assert.equal((await jsonValue(page, 'deploy-content')).articles[articleIndex].title, `Article ${preset}`);
    assert.equal((await jsonValue(page, 'template-params')).brand, `Brand ${preset}`);
    // Explicit clearing must not inherit content back from either the preset or the saved recipe.
    await editJSON(page, 'content-advanced', 'deploy-content', null);
    await page.locator('#multilingual').uncheck();
    while (await menus.locator('.deployment-card').count()) {
      const item = menus.locator('.deployment-card').last();
      if (await item.getAttribute('open') === null) await item.locator(':scope > summary').click();
      await item.getByRole('button', { name: /^Remove / }).click();
    }
    await save();
    assert.equal(await jsonValue(page, 'deploy-content'), null);
    assert.deepEqual(await jsonValue(page, 'deploy-menus'), []);
    assert.equal(await page.locator('#multilingual').isChecked(), false);
    await select(preset);
    await select(copyId);
    assert.equal(await jsonValue(page, 'deploy-content'), null);
    assert.deepEqual(await jsonValue(page, 'deploy-menus'), []);
    assert.equal(await page.locator('#multilingual').isChecked(), false);
    assert.deepEqual(diagnostics, { pageErrors: [], consoleErrors: [] },
      `Ordinary configuration emitted a browser error. Failed requests: ${JSON.stringify(failedRequests)}`);
    await mkdir('test-results', { recursive: true });
    await writeFile(`test-results/configure-deployment-${preset}-${browserName}.json`, JSON.stringify({ preset, browser: browserName,
      sections: ['packages', 'commands', 'template', 'languages', 'menus', 'content', 'configuration'],
      save: true, copy: true, export: true, import: true, reload: true, preservedControls: true, clearedContent: true, diagnostics }, null, 2));
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
});
}

test(`Configure a deployment preserves prepared JCB readiness while settings are unchanged (${browserName})`, { timeout: 45_000 }, async () => {
  const recipe = JSON.parse(await readFile(new URL('../deploys/jcb.json', import.meta.url), 'utf8'));
  const snapshot = { url: '../assets/snapshots/jcb-prepared.zip', sha256: 'a'.repeat(64),
    format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0' };
  recipe.variants['6'].snapshot = snapshot;
  const manifest = { ...formManifest, php: [{ version: '8.3' }, { version: '8.4' }],
    joomla: [{ version: '6.2.0', php: ['8.3', '8.4'] }],
    prebuiltDeploys: [{ id: 'jcb', joomlaVersion: '6.2.0', phpVersion: '8.4',
      url: 'snapshots/jcb-prepared.zip', sha256: snapshot.sha256, size: 100 }] };
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: {
    ...formFixtures, 'assets/manifest.json': JSON.stringify(manifest), 'deploys/jcb.json': JSON.stringify(recipe),
  } });
  let browser;
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}?deploy=jcb&key=prepared-readiness&immediate=1&start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    await assertLaunchReadiness(page);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
});

test(`Configure a deployment loads native fields before editing and applies the complete draft (${browserName})`, { timeout: 45_000 }, async () => {
  let releaseDiscovery;
  const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
  const metadata = { languageTags: ['en-GB'], menuTypes: [], configurationTargets: [],
    templates: [{ template: 'cassiopeia', schema: { type: 'object', properties: {
      params: { type: 'object', required: ['brand'], properties: { brand: { type: 'string', title: 'Native template brand' } } },
    } } }] };
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: {
    ...formFixtures,
    'fixture-discovery.json': () => discovery,
    'site/': '<!doctype html><title>Configured site</title><main>Running site</main>',
    'site/index.html': '<!doctype html><title>Configured site</title><main>Running site</main>',
    // Exercise the real popup and application boundary without booting PHP.
    // Native content/menu writes are covered by the provisioning tests.
    'src/playground.mjs': `
      export async function prepareEnvironment() { return { reloadRequired: false }; }
      export async function resetPlayground() {}
      export async function createPlayground(configuration) {
        const baseUrl = new URL('site/', location.href).href;
        return { configuration, baseUrl, url: new URL('index.html', baseUrl).href, healthy: true,
          debugger: { state: 'idle', subscribe: () => () => {} },
          workspace: { id: configuration.storageKey, storageId: configuration.storageKey, root: '/', subscribe: () => () => {} },
          installation: { siteName: configuration.siteName, administrator: configuration.admin },
          async discoverConfiguration() {
            return (await fetch(new URL('fixture-discovery.json', location.href))).json();
          },
          async applyConfiguration(next) {
            window.appliedConfiguration = structuredClone(next);
            this.configuration = next; this.installation.siteName = next.siteName;
          },
          async request() { return new Response('Ready'); }, async flush() {}, async close() {}, async reset() {} };
      }`,
  } });
  let browser;
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}?deploy=blank&start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#deploy-editor-button').click();
    await typeValue(page.locator('#template-name'), 'cassiopeia');
    await editJSON(page, 'template-advanced', 'template-params', { brand: 'Initial brand' });
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    await page.locator('#embedded-launch').click();
    await page.locator('#site-frame').waitFor();
    await page.locator('#deploy-editor-button:enabled').waitFor();
    const requested = page.waitForRequest(request => request.url().endsWith('/fixture-discovery.json'));
    await page.locator('#deploy-editor-button').click();
    await requested;
    assert.equal(await page.locator('#deploy-dialog').getAttribute('open'), null,
      'The running-site form waits for its native fields before becoming editable.');
    releaseDiscovery(JSON.stringify(metadata));
    const brand = page.locator('#template-parameter-inputs').getByRole('textbox', { name: 'Native template brand', exact: true });
    await brand.waitFor();
    assert.equal(await brand.inputValue(), 'Initial brand', 'Native fields are available on the first running-site opening.');
    const brandNode = await brand.elementHandle();
    const frameNode = await page.locator('#site-frame').elementHandle();
    const initialName = await page.locator('#site-name').inputValue();
    await brand.fill('');
    for (const action of ['save-deployment', 'apply-deploy']) {
      await page.locator(`#${action}`).click();
      await page.locator('#deploy-error:not([hidden])').waitFor();
      assert.equal(await brand.evaluate(control => document.activeElement === control && !control.validity.valid), true,
        `${action} must reveal and focus the required native template field.`);
      assert.equal(await brand.inputValue(), '', 'Validation preserves the unfinished draft.');
      assert.equal(await page.locator('#site-name').inputValue(), initialName);
      assert.equal(await brandNode.evaluate(control => control.isConnected), true);
      assert.equal(await frameNode.evaluate(frame => frame.isConnected), true, 'Invalid input must not remount the running site.');
      assert.equal(await page.evaluate(() => window.appliedConfiguration), undefined, 'Invalid input must not reach the runtime.');
      assert.notEqual(await page.locator('#deploy-dialog').getAttribute('open'), null);
    }
    await typeValue(brand, 'Applied native brand');
    await typeValue(page.locator('#site-name'), 'Applied popup settings');
    const content = { categories: [{ key: 'news', title: 'News', alias: 'news', language: 'en-GB' }],
      articles: [{ key: 'welcome', title: 'Welcome', alias: 'welcome', language: 'en-GB', category: 'news', introtext: 'Applied content' }] };
    await editJSON(page, 'content-advanced', 'deploy-content', content);
    await page.locator('#menu-inputs').getByRole('button', { name: 'Add menu item', exact: true }).click();
    await typeValue(page.locator('#menu-inputs').getByRole('textbox', { name: 'Title', exact: true }), 'New menu');
    assert.equal(await brandNode.evaluate(control => control.isConnected), true, 'Editing other sections keeps native template inputs in place.');
    await page.locator('#save-deployment').click();
    await page.locator('#deployment-save-status:not([hidden])').waitFor();
    await page.locator('#save-deployment:enabled').waitFor();
    assert.equal(await brandNode.evaluate(control => control.isConnected), true, 'Saving preserves the native template control.');
    await page.locator('#apply-deploy').click();
    await page.waitForFunction(() => !document.getElementById('deploy-dialog').open && window.appliedConfiguration);
    const applied = await page.evaluate(() => window.appliedConfiguration);
    assert.equal(applied.siteName, 'Applied popup settings');
    assert.equal(applied.template.params.brand, 'Applied native brand');
    assert.equal(applied.menus[0].title, 'New menu');
    assert.equal(applied.content.articles[0].introtext, 'Applied content');
    assert.equal(await page.locator('#preview-label').textContent(), 'Applied popup settings');
    assert.deepEqual(errors, []);
  } finally {
    releaseDiscovery(JSON.stringify(metadata));
    try { await browser?.close(); } finally { await server.close(); }
  }
});

test(`deployment editor clones core recipes, saves reloadable customs and imports complete JSON (${browserName})`, { timeout: 60_000 }, async () => {
  const manifest = { php: [{ version: '8.3' }, { version: '8.4' }],
    joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.3', '8.4'] }],
    defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } };
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)), fixtures: {
    'assets/manifest.json': JSON.stringify(manifest),
    'assets/version-catalog.json': JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-01T00:00:00Z', joomla: [], jcb: [], errors: [] }),
  } });
  let browser;
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}?start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    const localPackage = await page.evaluate(async () => {
      const { parseDeploymentDocument } = await import('./src/config.mjs');
      return parseDeploymentDocument({ schemaVersion: 1, configuration: { extensions: [{ url: './demo.zip' }] } }).extensions[0].url;
    });
    assert.equal(localPackage, new URL('demo.zip', server.url).href);
    await page.locator('#settings-toggle').click();
    await page.locator('#deploy').selectOption('servicedirectory');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), 'none');
    const stable = await page.locator('#jcb-version option').evaluateAll(options => options.find(option => /^6\.\d+\.\d+$/.test(option.value))?.value);
    assert.ok(stable, 'The reviewed stable JCB 6 package must be selectable.');
    await page.locator('#jcb-version').selectOption(stable);
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#jcb-version').inputValue(), stable);
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
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
    await page.locator('#save-button').click();
    await page.waitForFunction(() => document.getElementById('deploy').value.startsWith('custom-')
      && !document.getElementById('save-button').disabled);
    assert.equal(await page.locator('#site-frame').count(), 0, 'Dashboard Save stores configuration without starting a site.');
    assert.deepEqual(await page.evaluate(async () => (await import('./src/site-backups.mjs')).createSiteBackups().list()), [],
      'Dashboard Save does not create a site backup.');
    await page.locator('#deploy-editor-button').click();
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
    await page.screenshot({ path: `test-results/deployment-editor-desktop-${browserName}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#deploy-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'The editor fits a narrow viewport.');
    assert.equal(await page.locator('#save-deployment').isVisible(), true);
    assert.equal(await page.locator('#delete-deployment').isVisible(), true);
    await page.screenshot({ path: `test-results/deployment-editor-mobile-${browserName}.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const downloaded = page.waitForEvent('download');
    await page.locator('#export-config').click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    let json = ''; for await (const chunk of stream) json += chunk.toString();
    const document = JSON.parse(json);
    assert.equal(document.schemaVersion, 3);
    assert.equal(document.configuration.siteName, 'My saved directory');
    assert.equal(document.configuration.admin.username, 'directory-admin');
    assert.ok(document.configuration.extensions.length > 0);
    assert.deepEqual(document.configuration.addonExtensions, [{ url: 'https://packages.example.test/custom.zip' }]);
    await page.evaluate(({ document, baseURL }) => {
      const key = `joomengine:deployments:${baseURL}`;
      const registry = JSON.parse(localStorage.getItem(key));
      registry.deployments.push({ id: 'custom-unavailable-runtime', title: 'Unavailable runtime', document: {
        ...document, name: 'Unavailable runtime', requirements: { ...document.requirements, php: ['9.9'] },
      } });
      localStorage.setItem(key, JSON.stringify(registry));
    }, { document, baseURL: server.url });
    await page.reload();
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#deploy-editor-button').click();
    for (const selector of ['#deploy', '#editor-deployment']) {
      assert.equal(await page.locator(`${selector} option[value="custom-unavailable-runtime"]`).isDisabled(), true,
        'Both deployment selectors must disable a saved recipe with no available compatible runtime.');
    }
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
    await page.locator('#local-images-button').click();
    await page.locator('#legacy-sites > summary').click();
    await page.locator('#saved-site').selectOption('saved-custom-instance');
    await page.locator('#launch-button:enabled').waitFor();
    assert.equal(await page.locator('#deploy').inputValue(), importedId, 'An installed site keeps its standalone recipe after the reusable entry is deleted.');
    await page.locator('#edit-deployment').click();
    assert.equal(await page.locator('#site-name').inputValue(), 'My saved directory');
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
});

for (const deployment of [
  { id: 'blank', initialPath: '/' },
  { id: 'jcb', initialPath: '/administrator/index.php?option=com_componentbuilder' },
]) {
test(`editor Use creates a new instance while dashboard Launch resumes a closed saved ${deployment.id} site (${browserName})`, { timeout: 30_000 }, async () => {
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
        (window.launchedConfigurations ||= JSON.parse(sessionStorage.getItem('fixture-launches') || '[]')).push(structuredClone(configuration));
        sessionStorage.setItem('fixture-launches', JSON.stringify(window.launchedConfigurations));
        const baseUrl = new URL('./', location.href).href;
        return { configuration, baseUrl, url: new URL('__test__.html', baseUrl).href, healthy: true,
          debugger: { state: 'idle', subscribe: () => () => {} },
          workspace: { id: configuration.storageKey, storageId: configuration.storageKey, root: '/', subscribe: () => () => {} },
          installation: { siteName: configuration.siteName, administrator: configuration.admin },
          async request() { return new Response('Ready'); }, async flush() {}, async close() {}, async reset() {} };
      }`,
  } });
  let browser;
  try {
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}?deploy=${deployment.id}`);
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
    const savedKey = await page.locator('#storage-key').inputValue();
    await page.locator('#settings-toggle').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#close-button:enabled').click();
    await page.locator('#welcome:not([hidden])').waitFor();
    await page.goto(`${server.url}?key=${encodeURIComponent(savedKey)}&start=0`);
    await page.locator('#embedded-launch:enabled').waitFor();
    await page.locator('#embedded-launch').click();
    await page.locator('#site-frame').waitFor();
    await page.locator('#settings-toggle').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#close-button:enabled').click();
    await page.locator('#welcome:not([hidden])').waitFor();
    await page.locator('#deploy-editor-button').click();
    const originalName = await page.locator('#site-name').inputValue();
    assert.equal(await page.locator('#initial-path').inputValue(), deployment.initialPath, 'Resuming the last visited page must not overwrite the configured initial path.');
    const stopped = await page.evaluate(({ baseURL, key }) => JSON.parse(localStorage.getItem(`joomengine:launch:${baseURL}`)).sites[key], { baseURL: server.url, key: savedKey });
    assert.equal(stopped.initialPath, deployment.initialPath, 'The deployment keeps its chosen initial path separately from navigation state.');
    assert.equal(stopped.lastPath, '/__test__.html');
    await page.locator('#use-deploy').click();
    await continueLiveReplacement(page);
    await page.locator('#site-frame').waitFor();
    await page.waitForFunction(() => !document.getElementById('launch-button').disabled);
    const launches = await page.evaluate(() => window.launchedConfigurations);
    assert.equal(launches.length, 3);
    assert.equal(launches[0].storageKey, launches[1].storageKey, 'Dashboard Launch reopens the closed saved identity.');
    assert.equal(launches[1].initialPath, '/__test__.html', 'Dashboard Launch still restores the saved last route.');
    assert.notEqual(launches[1].storageKey, launches[2].storageKey, 'Use creates a separate fresh identity even without edits or a running runtime.');
    assert.equal(launches[2].initialPath, launches[0].initialPath, 'A fresh Use starts at the configured path instead of the source site’s last route.');
    assert.equal(launches[2].siteName, originalName);
    assert.deepEqual(launches[1].admin, launches[2].admin, 'The chosen administrator is preserved.');
    const saved = await page.evaluate(baseURL => JSON.parse(localStorage.getItem(`joomengine:launch:${baseURL}`)), server.url);
    assert.equal(saved.sites[launches[0].storageKey], undefined, 'Continuing without a backup replaces the prior managed live slot.');
    assert.ok(saved.sites[launches[2].storageKey]);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
});
}
}
