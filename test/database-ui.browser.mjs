import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('database and code panels share one embedded slot and retain drafts through a detached window', { timeout: 90000 }, async () => {
  let posts = 0;
  const server = await createStaticServer({ directory: root, fixtures: {
    'database.html': request => { if (request.method === 'POST') posts++; return '<!doctype html><html><title>Database fixture</title><form method="post"><textarea name="query"></textarea><input name="token" type="hidden" value="csrf"><button>Run</button></form></html>'; },
  } });
  const executablePath = process.env.PLAYGROUND_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  try {
    // This test covers view transfer only. The isolation suite exercises the actual
    // service worker's owned static route instead of this fixture transport.
    await context.route('**/__runtime/test-owner/**', async route => {
      const url = route.request().url().replace('/__runtime/test-owner/', '/');
      await route.fulfill({ response: await route.fetch({ url }) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}__test__.html`);
    await page.evaluate(async () => {
      const [{ createDatabaseHost }, { createCodeLayout }, { t }] = await Promise.all([
        import('./src/database/host.mjs'), import('./src/code/layout.mjs'), import('./src/i18n.mjs'),
      ]);
      const host = document.createElement('main'), preview = document.createElement('section'), site = document.createElement('iframe');
      host.className = 'workspace'; preview.className = 'preview-panel'; site.srcdoc = '<p>Site remains running</p>';
      preview.append(site); host.append(preview); document.body.replaceChildren(host);
      window.siteFrame = site;
      window.codeState = []; window.databaseState = []; window.uiErrors = [];
      const editor = document.createElement('div'); editor.textContent = 'Unsaved code buffer';
      window.codeLayout = createCodeLayout({ host, preview, editor, t, onState: state => window.codeState.push(state) });
      window.codeLayout.show();
      const runtime = { healthy: true, isolation: { ownerId: 'test-owner', policy: 'credentialless' },
        workspace: { subscribe() { return () => {}; } },
        async openDatabase() { return { url: new URL('./database.html?sql=', location.href).href }; },
      };
      window.databaseHost = await createDatabaseHost({ runtime, host, preview, t, refreshSite() {},
        onError: error => window.uiErrors.push(error.message), onState: state => window.databaseState.push(state) });
      await window.databaseHost.open();
    });
    assert.equal(await page.locator('.jec-panel:visible').count(), 1);
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible), false);
    const frame = page.frameLocator('iframe[title="Database"]');
    await frame.locator('textarea').fill('UPDATE items SET value = 5');
    await page.evaluate(() => window.codeLayout.show());
    assert.equal(await page.evaluate(() => window.databaseHost.visible), false);
    await page.evaluate(() => window.databaseHost.open());
    assert.equal(await frame.locator('textarea').inputValue(), 'UPDATE items SET value = 5');
    for (const mode of ['left', 'right', 'bottom', 'full', 'floating']) {
      await page.locator('.jec-panel:visible .jec-mode').selectOption(mode);
      assert.equal(await page.locator('.workspace').getAttribute('data-jec-mode'), mode);
      assert.equal(await page.locator('.jec-panel:visible').count(), 1);
    }
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Detach database viewer', exact: true }).click();
    const popup = await popupPromise;
    const detached = popup.frameLocator('iframe[title="Database"]');
    await detached.locator('textarea').waitFor();
    await page.waitForFunction(() => window.databaseHost.detached);
    assert.equal(await detached.locator('textarea').inputValue(), 'UPDATE items SET value = 5');
    await page.evaluate(() => window.codeLayout.show());
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible && window.databaseHost.detached), true);
    assert.equal(await page.locator('.jec-panel:visible').count(), 1);
    await detached.locator('textarea').fill('SELECT * FROM items WHERE id = 10');
    await popup.getByRole('button', { name: 'Return to owner tab', exact: true }).click();
    await page.waitForFunction(() => !window.databaseHost.detached && window.databaseHost.visible);
    assert.equal(await page.evaluate(() => window.codeLayout.state.visible), false);
    assert.equal(await frame.locator('textarea').inputValue(), 'SELECT * FROM items WHERE id = 10');
    assert.equal(await page.evaluate(() => document.querySelector('.preview-panel iframe') === window.siteFrame), true);
    assert.equal(posts, 0, 'detaching/redocking must never replay submitted SQL');
    assert.deepEqual(await page.evaluate(() => window.uiErrors), []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => { window.codeLayout.dispose(); return window.databaseHost.dispose(); });
  } finally { await context.close(); await browser.close(); await server.close(); }
});
