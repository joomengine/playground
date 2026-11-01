import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));

test('complete site ZIP roundtrip preserves edits and credentials independently', { timeout: 900000 }, async t => {
  const server = await createStaticServer({ directory });
  const executablePath = process.env.PLAYGROUND_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  t.after(async () => { await browser.close(); await server.close(); });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  await page.goto(new URL('__test__.html', server.url).href);
  await prepareBrowserEnvironment(page);
  const configuration = { phpVersion: process.env.PLAYGROUND_PHP_VERSIONS?.split(',')[0] || '8.4',
    joomlaVersion: process.env.PLAYGROUND_JOOMLA_VERSIONS?.split(',')[0] || manifest.defaults.joomlaVersion,
    deployId: 'blank', persistence: true, storageKey: `export-source-${Date.now()}`,
    siteName: 'A modified exported site', initialPath: '/administrator/index.php?option=com_content',
    admin: { username: 'portableadmin', name: 'Portable Administrator', email: 'portable@example.test', password: 'Portable-roundtrip-password-123!' },
    extensions: [], startupCommands: [] };
  const exported = await page.evaluate(async configuration => {
    const { createPlayground } = await import('./src/playground.mjs');
    window.sourceConfig = configuration;
    window.site = await createPlayground(configuration);
    await window.site.fs.writeFile('/persist/www/roundtrip-proof.txt', 'Edited source file');
    const result = await window.site.runPhp("<?php $db = new PDO('mysql:dbname=joomla;charset=utf8mb4','root',''); $db->exec('CREATE TABLE roundtrip_proof (id INT PRIMARY KEY, value VARCHAR(255))'); $db->exec(\"INSERT INTO roundtrip_proof VALUES (1, 'Edited database row')\"); echo 'saved';");
    await window.site.flush();
    const bundle = await window.site.exportSite({ format: 'bundle', includePlaygroundConfiguration: true });
    window.originalBundle = bundle.bytes;
    await window.site.close();
    window.site = null;
    return { metadata: bundle.metadata, size: bundle.bytes.length };
  }, configuration);
  assert.ok(exported.size > 1000000);
  assert.deepEqual(exported.metadata.playground.configuration.admin, configuration.admin);
  assert.equal(exported.metadata.playground.configuration.initialPath, configuration.initialPath);
  assert.match(exported.metadata.playground.contentHash.value, /^[a-f0-9]{64}$/);

  const restored = await page.evaluate(async () => {
    const { createPlayground } = await import('./src/playground.mjs');
    const { readSiteExport, configurationForSiteExport } = await import('./src/site-import.mjs');
    const { parseCatalog } = await import('./src/config.mjs');
    const { unzipSync, zipSync, strToU8 } = await import('./assets/fflate/browser.js');
    const files = unzipSync(window.originalBundle);
    const metadata = JSON.parse(new TextDecoder().decode(files['export.json']));
    // Already-installed setup is descriptive: upload must neither resolve this
    // deleted custom recipe nor fetch its old URLs nor replay its commands.
    metadata.playground.configuration.deployId = 'custom-removed-on-another-browser';
    metadata.playground.configuration.extensions = [{ url: 'https://unavailable.invalid/previous-extension.zip' }];
    metadata.playground.configuration.addonExtensions = metadata.playground.configuration.extensions;
    metadata.playground.configuration.startupCommands = [['missing-command:never-replay']];
    files['export.json'] = strToU8(JSON.stringify(metadata));
    const siteExport = await readSiteExport(zipSync(files));
    const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
    window.importConfig = configurationForSiteExport(siteExport, catalog, { baseURL: location.href });
    const requests = [];
    const originalFetch = window.fetch;
    window.fetch = (...args) => { requests.push(String(args[0])); return originalFetch(...args); };
    const progress = [];
    try { window.site = await createPlayground(window.importConfig, { siteExport, onProgress: event => progress.push(event) }); }
    finally { window.fetch = originalFetch; }
    const administrator = await window.site.request('/administrator/');
    const html = await administrator.text();
    const row = await window.site.runPhp("<?php $db = new PDO('mysql:dbname=joomla;charset=utf8mb4','root',''); echo $db->query('SELECT value FROM roundtrip_proof WHERE id=1')->fetchColumn();");
    const file = new TextDecoder().decode(await window.site.fs.readFile('/persist/www/roundtrip-proof.txt'));
    const identity = window.site.installation.administrator;
    await window.site.fs.writeFile('/persist/www/roundtrip-proof.txt', 'Only the uploaded copy changed');
    await window.site.runPhp("<?php $db = new PDO('mysql:dbname=joomla;charset=utf8mb4','root',''); $db->exec(\"UPDATE roundtrip_proof SET value='Only uploaded database changed' WHERE id=1\");");
    await window.site.close(); window.site = null;
    return { file, row: row.text ?? new TextDecoder().decode(row.body), identity,
      loggedIn: administrator.status === 200 && !/name=["']passwd["']/.test(html), requests,
      key: window.importConfig.storageKey, initialPath: window.importConfig.initialPath, progress };
  });
  assert.equal(restored.file, 'Edited source file');
  assert.equal(restored.row, 'Edited database row');
  assert.deepEqual(restored.identity, configuration.admin);
  assert.equal(restored.loggedIn, true);
  assert.equal(restored.initialPath, configuration.initialPath);
  assert.notEqual(restored.key, configuration.storageKey);
  assert.ok(restored.progress.some(event => event.message === 'Package validated.'));
  assert.ok(!restored.requests.some(url => /\.zip(?:\?|$)|unavailable\.invalid/.test(url)), 'Upload downloads no Joomla or extension package.');

  const resumed = await page.evaluate(async () => {
    const { createPlayground } = await import('./src/playground.mjs');
    const read = async configuration => {
      const site = await createPlayground(configuration);
      const file = new TextDecoder().decode(await site.fs.readFile('/persist/www/roundtrip-proof.txt'));
      const row = await site.runPhp("<?php $db = new PDO('mysql:dbname=joomla;charset=utf8mb4','root',''); echo $db->query('SELECT value FROM roundtrip_proof WHERE id=1')->fetchColumn();");
      await site.close();
      return { file, row: row.text ?? new TextDecoder().decode(row.body) };
    };
    return { source: await read(window.sourceConfig), imported: await read(window.importConfig) };
  });
  assert.deepEqual(resumed.source, { file: 'Edited source file', row: 'Edited database row' });
  assert.deepEqual(resumed.imported, { file: 'Only the uploaded copy changed', row: 'Only uploaded database changed' });

  await t.test('legacy packages remain usable and altered payloads fail validation', async () => {
    const result = await page.evaluate(async () => {
      const { createPlayground } = await import('./src/playground.mjs');
      const { readSiteExport, configurationForSiteExport } = await import('./src/site-import.mjs');
      const { parseCatalog } = await import('./src/config.mjs');
      const { unzipSync, zipSync, strToU8 } = await import('./assets/fflate/browser.js');
      const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
      const files = unzipSync(window.originalBundle);
      files['site/roundtrip-proof.txt'] = strToU8('Changed after export');
      let mismatch;
      try {
        const siteExport = await readSiteExport(zipSync(files));
        await createPlayground(configurationForSiteExport(siteExport, catalog), { siteExport });
      } catch (error) { mismatch = error.message; }
      const metadata = JSON.parse(new TextDecoder().decode(files['export.json']));
      delete metadata.playground;
      files['export.json'] = strToU8(JSON.stringify(metadata));
      const legacy = await readSiteExport(zipSync(files));
      const progress = [];
      const site = await createPlayground(configurationForSiteExport(legacy, catalog, { admin: window.sourceConfig.admin }), { siteExport: legacy, onProgress: event => progress.push(event) });
      const imported = site.installation.fromSiteExport;
      await site.close();
      let invalid;
      try { await readSiteExport(zipSync({ 'extension.xml': strToU8('<extension/>') })); }
      catch (error) { invalid = error.message; }
      return { mismatch, imported, progress, invalid };
    });
    assert.match(result.mismatch, /Package validation failed/);
    assert.equal(result.imported, true);
    assert.ok(result.progress.some(event => /validation is unavailable/.test(event.message)));
    assert.equal(result.invalid, 'Choose a complete JoomEngine site export ZIP.');
  });

  await t.test('outdated exported login details do not overwrite the account or block restore and resume', async () => {
    const result = await page.evaluate(async () => {
      const { createPlayground } = await import('./src/playground.mjs');
      const { readSiteExport, configurationForSiteExport } = await import('./src/site-import.mjs');
      const { parseCatalog } = await import('./src/config.mjs');
      const { unzipSync, zipSync, strToU8 } = await import('./assets/fflate/browser.js');
      const files = unzipSync(window.originalBundle);
      const metadata = JSON.parse(new TextDecoder().decode(files['export.json']));
      metadata.playground.configuration.admin.password = 'Outdated-login-password-456!';
      metadata.playground.configuration.autoLogin = false;
      files['export.json'] = strToU8(JSON.stringify(metadata));
      const siteExport = await readSiteExport(zipSync(files));
      const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
      const configuration = configurationForSiteExport(siteExport, catalog);
      const site = await createPlayground(configuration, { siteExport });
      const unavailable = site.installation.administratorUnavailable;
      const expected = btoa(window.sourceConfig.admin.password);
      const response = await site.runPhp(`<?php require '/persist/www/configuration.php'; $config = new JConfig();
        $db = new PDO('mysql:dbname=joomla;charset=utf8mb4','root','');
        $hash = $db->query('SELECT password FROM ' . $config->dbprefix . "users WHERE username='portableadmin'")->fetchColumn();
        echo json_encode(password_verify(base64_decode('${expected}'), $hash));`);
      await site.close();
      const resumed = await createPlayground(configuration);
      const unavailableAfterResume = resumed.installation.administratorUnavailable;
      await resumed.close();
      return { unavailable, unavailableAfterResume, accountUnchanged: JSON.parse(response.text ?? new TextDecoder().decode(response.body)) };
    });
    assert.deepEqual(result, { unavailable: true, unavailableAfterResume: true, accountUnchanged: true });
  });

  await t.test('dashboard Upload opens the complete site and editor Use preserves it in a separate copy', async () => {
    const blobURL = await page.evaluate(() => URL.createObjectURL(new Blob([window.originalBundle], { type: 'application/zip' })));
    const ui = await page.context().newPage();
    ui.setDefaultTimeout(240000);
    const errors = [];
    ui.on('pageerror', error => errors.push(error.message));
    try {
      await ui.goto(`${server.url}?start=0`);
      await ui.locator('#embedded-launch:enabled').waitFor();
      await ui.locator('#settings-toggle').click();
      assert.equal(await ui.locator('#upload-site-button').isVisible(), true);
      await ui.evaluate(async blobURL => {
        const file = new File([await (await fetch(blobURL)).arrayBuffer()], 'complete-site.zip', { type: 'application/zip' });
        const transfer = new DataTransfer(); transfer.items.add(file);
        const input = document.getElementById('upload-site-file'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, blobURL);
      await ui.waitForFunction(() => !document.getElementById('credentials-button').disabled);
      assert.equal(await ui.locator('#header-feedback').textContent(), 'Package validated.');
      const importedKey = await ui.locator('#storage-key').inputValue();
      assert.notEqual(importedKey, configuration.storageKey);
      await ui.locator('#settings-toggle').click();
      await ui.locator('#credentials-button').click();
      assert.equal(await ui.locator('#credential-username').inputValue(), configuration.admin.username);
      assert.equal(await ui.locator('#credential-password').inputValue(), configuration.admin.password);
      await ui.locator('#credentials-dialog [data-close-dialog]').click();
      const siteURL = new URL(await ui.locator('#site-frame').getAttribute('src'));
      const proofURL = new URL('roundtrip-proof.txt', new URL('./', siteURL.href.replace(/administrator\/.*$/, ''))).href;
      assert.equal(await ui.evaluate(async url => (await fetch(url)).text(), proofURL), 'Edited source file');

      for (const sourceOpen of [true, false]) {
        if (!sourceOpen) {
          if (!await ui.locator('#close-button').isVisible()) await ui.locator('#settings-toggle').click();
          await ui.locator('#close-button').click();
          await ui.locator('#launch-button:enabled').waitFor();
        }
        const sourceKey = await ui.locator('#storage-key').inputValue();
        await ui.locator('#deploy-editor-button').click();
        await ui.locator('#site-name').fill(sourceOpen ? 'Copy from open upload' : 'Copy from closed upload');
        await ui.locator('#use-deploy').click();
        await ui.waitForFunction(() => !document.getElementById('credentials-button').disabled);
        assert.notEqual(await ui.locator('#storage-key').inputValue(), sourceKey);
        const copiedURL = new URL(await ui.locator('#site-frame').getAttribute('src'));
        const copiedProof = new URL('roundtrip-proof.txt', new URL('./', copiedURL.href.replace(/administrator\/.*$/, ''))).href;
        assert.equal(await ui.evaluate(async url => (await fetch(url)).text(), copiedProof), 'Edited source file');
      }
      assert.deepEqual(errors, []);
      if (!await ui.locator('#close-button').isVisible()) await ui.locator('#settings-toggle').click();
      await ui.locator('#close-button').click();
      await ui.locator('#launch-button:enabled').waitFor();
    } finally {
      await ui.close();
      await page.evaluate(url => URL.revokeObjectURL(url), blobURL);
    }
  });
});
