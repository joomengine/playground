import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { createStaticServer } from './server.mjs';

test('real Adminer shares Joomla database, survives PHP restart and keeps portable saved data', { timeout: 300_000 }, async () => {
  const server = await createStaticServer({ directory: path.resolve(process.env.PLAYGROUND_DIST || 'dist'), isolation: false });
  const executablePath = process.env.PLAYGROUND_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
  const page = await context.newPage();
  const errors = [], relayRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/__public-assets/')) relayRequests.push(request.url()); });
  try {
    await page.goto(`${server.url}__test__.html`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const environment = await page.evaluate(async () => (await import('./src/playground.mjs')).prepareEnvironment());
      if (!environment.reloadRequired) break;
      await page.goto(environment.reloadURL);
    }
    const startup = await page.evaluate(async () => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.adminerConfiguration = { persistence: true, storageKey: `adminer-${crypto.randomUUID()}`,
        phpVersion: '8.4', initialPath: '/',
        admin: { name: 'Database Tester', username: 'dbtester', password: 'Database-test-2026!', email: 'db@example.test' } };
      window.adminerSite = await createPlayground(window.adminerConfiguration);
      const before = await window.adminerSite.request('/administrator/index.php');
      const html = await before.text();
      const [{ createDatabaseHost }, { createCodeLayout }, { t }] = await Promise.all([
        import('./src/database/host.mjs'), import('./src/code/layout.mjs'), import('./src/i18n.mjs'),
      ]);
      const host = document.createElement('main'), preview = document.createElement('section'), site = document.createElement('iframe');
      host.className = 'workspace'; preview.className = 'preview-panel'; site.id = 'proof-site'; site.src = window.adminerSite.url;
      preview.append(site); host.append(preview); document.body.replaceChildren(host);
      const editor = document.createElement('div'); editor.textContent = 'Editor remains available';
      window.codeLayout = createCodeLayout({ host, preview, editor, t }); window.codeLayout.show();
      window.adminerErrors = [];
      window.adminerHost = await createDatabaseHost({ runtime: window.adminerSite, host, preview, t,
        refreshSite() {}, onError: error => window.adminerErrors.push(error.message) });
      await window.adminerHost.open();
      return { status: before.status, loggedIn: !html.includes('name="passwd"'), policy: window.adminerSite.isolation.policy };
    });
    assert.equal(startup.status, 200); assert.equal(startup.loggedIn, true); assert.equal(startup.policy, 'credentialless');
    const database = page.frameLocator('iframe[title="Database"]');
    await database.locator('#content').waitFor();
    assert.match(await database.locator('#content').textContent(), /Tables/);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.dispatchEvent(new Event('joomengine:themechange')); });
    await database.locator('html[data-joomengine-theme="light"]').waitFor();
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible), false);
    assert.equal(await page.locator('.jec-panel:visible').count(), 1);
    if (await database.locator('#menuopen button').isVisible()) await database.locator('#menuopen button').click();
    await database.getByRole('link', { name: 'SQL command', exact: true }).click();
    const query = database.locator('pre.sqlarea[contenteditable="true"]');
    await query.fill("CREATE TABLE adminer_browser_proof (id INT PRIMARY KEY, value VARCHAR(255)); INSERT INTO adminer_browser_proof VALUES (1, 'saved café 🦁'); SELECT * FROM adminer_browser_proof;");
    await database.getByRole('button', { name: 'Execute', exact: true }).click();
    await database.locator('#content').getByText('saved café 🦁', { exact: true }).waitFor();
    assert.equal(await database.locator('.error').count(), 0);
    const controls = await page.evaluate(async () => {
      const site = window.adminerSite;
      const files = await site.workspace.request('list', { path: '/' });
      const hidden = await fetch(new URL('__adminer/adminer.php', site.baseUrl));
      const bridge = await fetch(new URL('__adminer/bridge.js', site.baseUrl));
      return { files: JSON.stringify(files), hidden: hidden.status, bridge: bridge.status,
        coep: bridge.headers.get('Cross-Origin-Embedder-Policy'), controller: Boolean(navigator.serviceWorker.controller) };
    });
    assert.doesNotMatch(controls.files, /__adminer|adminer\.php/);
    assert.equal(controls.hidden, 404); assert.equal(controls.bridge, 200); assert.equal(controls.coep, 'credentialless'); assert.equal(controls.controller, true);

    // A detached real Adminer view remains operational after PHP replacement.
    const draft = "INSERT INTO adminer_browser_proof VALUES (99, 'unsubmitted café 🦁');";
    await database.locator('pre.sqlarea[contenteditable="true"]').fill(draft);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Detach database viewer', exact: true }).click();
    const popup = await popupPromise;
    const detached = popup.frameLocator('iframe[title="Database"]');
    await detached.locator('#content').waitFor();
    await page.waitForFunction(() => window.adminerHost.detached);
    assert.equal(await detached.locator('pre.sqlarea[contenteditable="true"]').textContent(), draft);
    await page.evaluate(async () => {
      window.codeLayout.show();
      await window.adminerSite.updatePhpSettings(window.adminerSite.configuration.phpSettings);
    });
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible && window.adminerHost.detached), true);
    await detached.getByRole('link', { name: 'SQL command', exact: true }).click();
    await detached.locator('pre.sqlarea[contenteditable="true"]').fill("UPDATE adminer_browser_proof SET value='restarted café 🦁' WHERE id=1; SELECT * FROM adminer_browser_proof;");
    await detached.getByRole('button', { name: 'Execute', exact: true }).click();
    await detached.locator('#content').getByText('restarted café 🦁', { exact: true }).waitFor();
    assert.equal(await detached.locator('.error').count(), 0);
    await detached.locator('pre.sqlarea[contenteditable="true"]').fill(draft);
    await popup.getByRole('button', { name: 'Return to owner tab', exact: true }).click();
    await page.waitForFunction(() => !window.adminerHost.detached && window.adminerHost.visible);
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible), false);
    assert.equal(await database.locator('pre.sqlarea[contenteditable="true"]').textContent(), draft);

    const saved = await page.evaluate(async () => {
      const site = window.adminerSite;
      await site.flush();
      const exported = await site.exportSite({ format: 'bundle' });
      await site.fs.writeFile('/tmp/adminer-portability.zip', exported.bytes);
      const inspected = await site.runPhp(`<?php
        $zip = new ZipArchive(); $zip->open('/tmp/adminer-portability.zip'); $bad = array();
        for ($i = 0; $i < $zip->numFiles; $i++) { $name = $zip->getNameIndex($i); if (str_contains($name, '__adminer') || str_contains($name, 'internal/adminer')) $bad[] = $name; }
        echo json_encode($bad);
      `);
      const admin = await site.request('/administrator/index.php'); const html = await admin.text();
      await window.adminerHost.dispose(); window.codeLayout.dispose(); await site.close();
      return { bad: JSON.parse(inspected.text), status: admin.status, loggedIn: !html.includes('name="passwd"') };
    });
    assert.deepEqual(saved.bad, []); assert.equal(saved.status, 200); assert.equal(saved.loggedIn, true);
    const configuration = await page.evaluate(() => window.adminerConfiguration);
    await page.reload();
    const reopened = await page.evaluate(async configuration => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.adminerSite = await createPlayground(configuration);
      const opened = await window.adminerSite.openDatabase();
      const response = await fetch(`${opened.url}?select=adminer_browser_proof`);
      const html = await response.text();
      const admin = await window.adminerSite.request('/administrator/index.php');
      const untouched = await window.adminerSite.runPhp("<?php $pdo = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', ''); echo $pdo->query('SELECT COUNT(*) FROM adminer_browser_proof WHERE id=99')->fetchColumn();");
      return { status: response.status, value: html.includes('restarted café 🦁'), resumed: window.adminerSite.installation.resumed,
        authenticated: !(await admin.text()).includes('name="passwd"'), untouched: untouched.text };
    }, configuration);
    assert.equal(reopened.status, 200); assert.equal(reopened.value, true); assert.equal(reopened.resumed, true); assert.equal(reopened.authenticated, true);
    assert.equal(reopened.untouched, '0', 'Transferring a draft must never execute it.');
    assert.deepEqual(relayRequests, []); assert.deepEqual(errors, []);
    await page.evaluate(() => window.adminerSite.reset());
  } catch (error) {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/adminer-failure.html', await page.evaluate(() => document.querySelector('iframe[title="Database"]')?.contentDocument?.documentElement.outerHTML || document.documentElement.outerHTML));
    throw error;
  } finally { await context.close(); await browser.close(); await server.close(); }
});
