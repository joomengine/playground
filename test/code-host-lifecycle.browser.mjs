import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`Code host disposes pending panels and contains teardown failures (${name})`, { timeout: 45_000 }, async () => {
    const server = await createStaticServer({ directory, fixtures: {
      'assets/code/editor.html': '<!doctype html><script>window.JoomEngineCode={mount:options=>parent.mockCodeMount(options)}</script>',
    } });
    const launcher = { chromium, firefox }[name];
    let browser;
    try {
      browser = await launcher.launch({ headless: true,
        ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const { createCodeHost } = await import('./src/code/host.mjs');
        const { default: english } = await import('./src/locales/en.mjs');
        window.makeCodeHost = async ({ brokenRedock = false, brokenDisposal = false, delayedMount = false } = {}) => {
          window.lifecycle = { disposed: 0, reports: [], unsubscribed: 0 };
          const container = document.createElement('div');
          const preview = document.createElement('section'); preview.textContent = 'Joomla remains usable';
          container.append(preview); document.querySelector('main').append(container);
          window.mockCodeMount = async () => {
            if (delayedMount) await new Promise(resolve => { window.releaseCodeMount = resolve; });
            return { layout() {}, hasDirty: () => false, getActivePath: () => '/', isDirty: () => false,
              getContext: () => ({ selection: null, openFiles: [] }),
              async dispose() {
                window.lifecycle.disposed++;
                if (delayedMount) await new Promise(resolve => { window.finishCodeDisposal = resolve; });
                if (brokenDisposal) throw new Error('injected workbench disposal failure');
              },
              async detach() { return { async redock() { if (brokenRedock) throw new Error('injected redock failure'); } }; },
            };
          };
          const workspace = { id: 'host-lifecycle', request: async () => null,
            withBatch: callback => callback(workspace), subscribe: () => () => { window.lifecycle.unsubscribed++; } };
          window.codePreview = preview;
          window.codeHost = await createCodeHost({ host: container, preview,
            runtime: { healthy: true, workspace, configuration: { phpVersion: '8.5' }, debugger: { state: 'idle' } },
            refreshSite() {}, t: key => english[key] || key,
            onError: error => window.lifecycle.reports.push(error.message) });
          window.codeOpening = window.codeHost.open();
          if (!delayedMount) await window.codeOpening;
        };
        await window.makeCodeHost();
      });
      // Rapid clicks share the same lazy import and create one credential realm.
      await page.evaluate(() => {
        const button = document.querySelector('[data-i18n="code.ai"]');
        button.click(); button.click(); button.click();
      });
      await page.waitForFunction(() => document.querySelectorAll('.jec-ai-panel iframe').length === 1);
      assert.equal(await page.locator('.jec-ai-panel iframe').count(), 1);
      await page.evaluate(async () => { await window.codeHost.dispose(); await window.makeCodeHost(); });

      // Force the exact async-boundary race: the sandbox exists, but the caller
      // has not yet received the panel object when workspace disposal begins.
      await page.evaluate(() => {
        const append = Element.prototype.append;
        Element.prototype.append = function (...nodes) {
          const result = append.apply(this, nodes);
          if (this.classList?.contains('jec-ai-panel') && nodes[0]?.tagName === 'IFRAME') {
            window.pendingAiFrame = nodes[0];
            queueMicrotask(() => { window.racedDisposal = window.codeHost.dispose(); });
            Element.prototype.append = append;
          }
          return result;
        };
        document.querySelector('[data-i18n="code.ai"]').click();
      });
      await page.waitForFunction(() => window.codeHost.closed && window.pendingAiFrame);
      await page.evaluate(() => window.racedDisposal);
      assert.equal(await page.evaluate(() => window.pendingAiFrame.parentNode === null), true);
      assert.equal(await page.evaluate(() => window.codePreview.isConnected), true);
      assert.equal(await page.evaluate(() => window.lifecycle.disposed), 1);

      // A failed auxiliary close must not skip workbench cleanup or remove the
      // running site. The failure is still reported after the host is closed.
      await page.evaluate(() => window.makeCodeHost({ brokenRedock: true }));
      await page.locator('[data-i18n-aria-label="code.detach"]').click();
      await page.locator('[data-i18n-aria-label="code.redock"]').waitFor();
      const result = await page.evaluate(async () => {
        let failed;
        try { await window.codeHost.dispose(); } catch (error) { failed = error.message; }
        return { failed, ...window.lifecycle, preview: window.codePreview.isConnected };
      });
      assert.equal(result.failed, 'injected redock failure');
      assert.equal(result.disposed, 1);
      assert.equal(result.unsubscribed, 1);
      assert.equal(result.preview, true);
      assert.deepEqual(result.reports, ['injected redock failure']);

      await page.evaluate(() => window.makeCodeHost({ brokenRedock: true, brokenDisposal: true }));
      await page.locator('[data-i18n-aria-label="code.detach"]').click();
      await page.locator('[data-i18n-aria-label="code.redock"]').waitFor();
      const failures = await page.evaluate(async () => {
        try { await window.codeHost.dispose(); } catch (error) { return error.errors.map(item => item.message); }
      });
      assert.deepEqual(failures, ['injected redock failure', 'injected workbench disposal failure']);
      assert.equal(await page.locator('.jec-panel').count(), 0);

      // If mounting finishes after disposal, open() must await that workbench's
      // asynchronous draft/resource cleanup rather than dropping its promise.
      await page.evaluate(() => window.makeCodeHost({ delayedMount: true }));
      await page.waitForFunction(() => typeof window.releaseCodeMount === 'function');
      await page.evaluate(async () => {
        window.openSettled = false;
        window.codeOpening.then(() => { window.openSettled = true; });
        await window.codeHost.dispose();
        window.releaseCodeMount();
      });
      await page.waitForFunction(() => typeof window.finishCodeDisposal === 'function');
      assert.equal(await page.evaluate(() => window.openSettled), false);
      await page.evaluate(async () => { window.finishCodeDisposal(); await window.codeOpening; });
      assert.equal(await page.evaluate(() => window.lifecycle.disposed), 1);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
