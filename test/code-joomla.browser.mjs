import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';

const browsers = { chromium, firefox };
const directory = path.resolve(process.env.PLAYGROUND_DIST || 'dist');
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`JoomEngine Code edits and reopens the real Joomla site (${name})`, { timeout: 300_000 }, async () => {
    assert.ok(browsers[name], `Unknown browser ${name}`);
    const server = await createStaticServer({ directory });
    const browser = await browsers[name].launch({ headless: true,
      ...(name === 'chromium' && process.env.PLAYGROUND_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYGROUND_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] } : {}) });
    const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${server.url}__test__.html`);
      await prepareBrowserEnvironment(page);
      const setup = await page.evaluate(async () => {
        const { createPlayground } = await import('./src/playground.mjs');
        window.codeConfiguration = { persistence: true, storageKey: `code-browser-${crypto.randomUUID()}`, initialPath: '/',
          admin: { name: 'Code Tester', username: 'codetester', password: 'JoomEngine-test-2026!', email: 'code@example.test' } };
        window.codeSite = await createPlayground(window.codeConfiguration);
        const workspace = window.codeSite.workspace;
        const index = await workspace.request('read', { path: '/index.php' });
        const result = await workspace.request('write', { path: '/jec-proof.txt', bytes: new TextEncoder().encode('before save'), expectedRevision: null, overwrite: false });
        let confined = false;
        try { await workspace.request('read', { path: '/../config/.cookies' }); } catch { confined = true; }
        return { bytes: index.bytes.length, confined, result, status: (await window.codeSite.request('/')).status };
      });
      assert.ok(setup.bytes > 100); assert.equal(setup.confined, true);
      assert.equal(setup.result.ok, true); assert.equal(setup.result.persistence.saved, true); assert.equal(setup.status, 200);
      await page.evaluate(async () => {
        const { createCodeHost } = await import('./src/code/host.mjs');
        const { t } = await import('./src/i18n.mjs');
        const container = document.createElement('div'); container.className = 'workspace';
        const preview = document.createElement('section'); preview.className = 'preview-panel';
        const frame = document.createElement('iframe'); frame.id = 'code-site-preview';
        frame.src = `${window.codeSite.baseUrl}jec-proof.txt`; preview.append(frame); container.append(preview); document.body.append(container);
        window.codeRefreshes = 0; window.codeHostErrors = [];
        window.codeHost = await createCodeHost({ runtime: window.codeSite, host: container, preview, t,
          onError: error => window.codeHostErrors.push(error.message),
          getPreviewURL: () => frame.src,
          refreshSite: () => { window.codeRefreshes++; frame.src = `${window.codeSite.baseUrl}jec-proof.txt`; } });
        await window.codeHost.open();
      });
      const editor = page.frame({ url: /assets\/code\/editor.html/ });
      assert.ok(editor);
      await editor.getByRole('treeitem', { name: /jec-proof.txt/ }).dblclick();
      await editor.locator('.monaco-editor .view-lines').first().click();
      await page.keyboard.press('Control+End'); await page.keyboard.type(' after edit'); await page.keyboard.press('Control+s');
      const savedUntil = Date.now() + 15_000;
      while (!await page.evaluate(async () => new TextDecoder().decode((await window.codeSite.workspace.request('read', { path: '/jec-proof.txt' })).bytes) === 'before save after edit')) {
        assert.ok(Date.now() < savedUntil, 'Native Save must write the actual edited buffer.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(await page.evaluate(() => window.codeRefreshes), 0, 'Manual save must not refresh the site.');
      await page.getByRole('button', { name: 'Refresh site', exact: true }).click();
      await page.waitForFunction(() => window.codeRefreshes === 1);
      const visible = await page.evaluate(async () => ({ disk: new TextDecoder().decode((await window.codeSite.workspace.request('read', { path: '/jec-proof.txt' })).bytes), direct: await (await window.codeSite.request('/jec-proof.txt')).text(), fetched: await (await fetch(`${window.codeSite.baseUrl}jec-proof.txt`)).text(), reloaded: await (await fetch(`${window.codeSite.baseUrl}jec-proof.txt`, { cache: 'reload' })).text() }));
      assert.deepEqual(visible, { disk: 'before save after edit', direct: 'before save after edit', fetched: 'before save after edit', reloaded: 'before save after edit' });
      // Ordinary binary operations use the same authoritative worker and survive reopen.
      const operations = await page.evaluate(async () => {
        const { uploadWorkspaceFiles } = await import('./src/code/file-actions.mjs');
        const workspace = window.codeSite.workspace;
        const result = await uploadWorkspaceFiles({ workspace, files: [new File([new Uint8Array([0, 255, 254, 128])], 'proof.bin')] });
        await workspace.request('rename', { path: '/proof.bin', target: '/renamed.bin' });
        const bytes = [...(await workspace.request('read', { path: '/renamed.bin' })).bytes];
        const removed = await workspace.request('delete', { path: '/renamed.bin' });
        const restored = await workspace.request('recover', { recoveryId: removed.recoveryId });
        const cache = await window.codeSite.clearJoomlaCache();
        return { result, bytes, restored, cache, refreshes: window.codeRefreshes };
      });
      assert.equal(operations.result.ok, true); assert.deepEqual(operations.bytes, [0, 255, 254, 128]);
      assert.equal(operations.restored.ok, true); assert.equal(operations.cache.ok, true);
      assert.equal(operations.refreshes, 1, 'Cache clearing is independent of refresh.');
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: `test-results/code-joomla-${name}.png` });
      const reopened = await page.evaluate(async () => {
        if (window.codeHostErrors.length) throw new Error(window.codeHostErrors.join('\n'));
        await window.codeHost.dispose(); await window.codeSite.close();
        const { createPlayground } = await import('./src/playground.mjs');
        window.codeSite = await createPlayground(window.codeConfiguration);
        return { text: new TextDecoder().decode((await window.codeSite.workspace.request('read', { path: '/jec-proof.txt' })).bytes),
          bytes: [...(await window.codeSite.workspace.request('read', { path: '/renamed.bin' })).bytes], status: (await window.codeSite.request('/')).status };
      });
      assert.equal(reopened.text, 'before save after edit'); assert.deepEqual(reopened.bytes, [0, 255, 254, 128]); assert.equal(reopened.status, 200);
      assert.deepEqual(errors, []);
      await page.evaluate(async () => window.codeSite.reset());
    } finally { await browser.close(); await server.close(); }
  });

  test(`Rocket opens JoomEngine Code lazily without replacing its live preview (${name})`, { timeout: 240_000 }, async () => {
    assert.ok(browsers[name], `Unknown browser ${name}`);
    const server = await createStaticServer({ directory });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await browsers[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
      const errors = [], codeRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/\/(?:assets|src)\/code\//.test(new URL(request.url()).pathname)) codeRequests.push(request.url());
      });
      await page.goto(`${server.url}?deploy=blank&persist=0&start=1&path=%2F`);
      await page.waitForFunction(() => document.getElementById('site-frame')
        || !document.getElementById('error-view').hidden, undefined, { timeout: 120_000 });
      assert.equal(await page.locator('#error-view').isVisible(), false, await page.locator('#error-message').textContent());
      await page.locator('#code-button:enabled').waitFor();
      const site = await (await page.locator('#site-frame').elementHandle()).contentFrame();
      await site.waitForURL(url => url.pathname.includes('/__site/'), { waitUntil: 'load' });
      await site.locator('body').waitFor();
      assert.deepEqual(codeRequests, [], 'Launching Joomla must not load the editor source or assets.');
      await page.evaluate(() => {
        window.originalSiteFrame = document.getElementById('site-frame');
        window.originalSiteDocument = window.originalSiteFrame.contentDocument;
      });
      await page.locator('#code-button').click();
      const editor = page.frameLocator('.jec-workbench-frame');
      await editor.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
      assert.ok(codeRequests.some(url => url.includes('/assets/code/')), 'The actual Code button loads the workbench assets.');
      assert.equal(await page.locator('#code-refresh-button').isVisible(), true);
      assert.equal(await page.locator('#code-button').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.originalSiteFrame
        && window.originalSiteFrame.contentDocument === window.originalSiteDocument), true, 'Opening Code keeps the live site frame and document.');
      await page.evaluate(() => {
        window.originalEditorFrame = document.querySelector('.jec-workbench-frame');
        window.originalEditorDocument = window.originalEditorFrame.contentDocument;
      });
      await editor.locator('.monaco-workbench').click({ position: { x: 100, y: 100 } });
      await page.keyboard.press('Control+p');
      const quickOpen = editor.locator('.quick-input-box input');
      await quickOpen.fill('index.php');
      await editor.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'index.php' }).first().waitFor();
      await quickOpen.press('Enter');
      await editor.locator('.monaco-editor .view-lines').first().click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('// Rocket entrypoint unsaved proof\n');
      await editor.locator('.tab.dirty').first().waitFor();
      const draftLine = editor.locator('.monaco-editor .view-line').filter({ hasText: 'Rocket entrypoint unsaved proof' });
      await draftLine.first().waitFor();
      for (const hide of ['#code-button', '#code-button', '.jec-window-controls [data-i18n-aria-label="code.hide"]']) {
        await page.locator(hide).click();
        await page.locator('.jec-panel').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#code-button').getAttribute('aria-expanded'), 'false');
        await page.locator('#code-button').click();
        await page.locator('.jec-panel').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#code-button').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => document.querySelector('.jec-workbench-frame') === window.originalEditorFrame
          && window.originalEditorFrame.contentDocument === window.originalEditorDocument), true, 'Reopening uses the same native editor realm.');
        await editor.locator('.tab.dirty').first().waitFor();
        await draftLine.first().waitFor();
      }
      assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.originalSiteFrame
        && window.originalSiteFrame.contentDocument === window.originalSiteDocument), true, 'Hiding and reopening Code never reloads the running site.');
      assert.equal(await page.locator('#code-refresh-button').isVisible(), true);
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: `test-results/code-rocket-entry-${name}.png` });
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
