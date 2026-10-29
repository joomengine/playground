import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`Code layout controls preserve the live documents and modeless site (${name})`, { timeout: 45_000 }, async () => {
    const server = await createStaticServer({ directory, fixtures: {
      'assets/code/editor.html': '<!doctype html><textarea id="buffer" style="display:block;width:80%;height:80px"></textarea><script>window.documentIdentity=crypto.randomUUID();window.JoomEngineCode={mount:options=>parent.mockLayoutMount(options)}</script>',
      'layout-preview.html': '<!doctype html><button id="site-action">Use running site</button><output id="count">0</output><script>window.siteIdentity=crypto.randomUUID();document.getElementById("site-action").onclick=()=>document.getElementById("count").value=String(Number(document.getElementById("count").value)+1)</script>',
    } });
    const launcher = { chromium, firefox }[name];
    let browser;
    try {
      browser = await launcher.launch({ headless: true,
        ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const { createCodeHost } = await import('./src/code/host.mjs');
        const { default: english } = await import('./src/locales/en.mjs');
        document.body.style.margin = '0'; document.querySelector('main').replaceChildren();
        const container = document.createElement('div'); container.style.width = '100%';
        const preview = document.createElement('section'); preview.style.height = '320px';
        const site = document.createElement('iframe'); site.id = 'layout-preview';
        site.style.cssText = 'width:100%;height:300px;border:0;display:block'; site.src = './layout-preview.html';
        preview.append(site); container.append(preview); document.querySelector('main').append(container);
        const feedback = document.createElement('p'); feedback.setAttribute('role', 'alert'); document.body.append(feedback);
        window.layoutCounts = { mounted: 0, disposed: 0, refreshed: 0, detachAttempts: 0 };
        window.layoutPreferences = new Map([['joomengine-code-layout', JSON.stringify({ mode: 'right', dock: 44,
          bottom: 320, x: 600, y: 80, width: 640, height: 460 })]]);
        const workspace = { id: 'layout-proof', request: async () => null,
          withBatch: callback => callback(workspace), subscribe: () => () => {} };
        window.mockLayoutMount = async () => {
          window.layoutCounts.mounted++;
          return { layout() {}, hasDirty: () => false, getActivePath: () => '/', isDirty: () => false,
            async dispose() { window.layoutCounts.disposed++; },
            // Exercise the layout's real blocked-popup fallback contract.
            async detach() { window.layoutCounts.detachAttempts++; return null; } };
        };
        window.layoutHost = await createCodeHost({ host: container, preview,
          runtime: { healthy: true, workspace, configuration: { phpVersion: '8.5' }, debugger: { state: 'idle' } },
          refreshSite: () => { window.layoutCounts.refreshed++; }, t: key => english[key] || key,
          storage: { getItem: key => window.layoutPreferences.get(key), setItem: (key, value) => window.layoutPreferences.set(key, value) },
          onError: error => { feedback.textContent = error.message; } });
        await window.layoutHost.open();
        const frame = document.querySelector('.jec-workbench-frame');
        window.originalEditorFrame = frame; window.originalEditorDocument = frame.contentDocument;
        window.originalPreviewFrame = site;
        const buffer = frame.contentDocument.getElementById('buffer');
        buffer.value = Array.from({ length: 60 }, (_, i) => `Unsaved draft line ${i}`).join('\n');
        buffer.setSelectionRange(11, 29, 'forward'); buffer.scrollTop = 170;
        window.editorState = { value: buffer.value, start: buffer.selectionStart, end: buffer.selectionEnd,
          scroll: buffer.scrollTop, identity: frame.contentWindow.documentIdentity };
      });
      await page.frameLocator('#layout-preview').getByRole('button', { name: 'Use running site' }).waitFor();
      const previewIdentity = await page.frameLocator('#layout-preview').locator('body').evaluate(() => window.siteIdentity);
      const panel = page.locator('.jec-panel'), preview = page.locator('.jec-preview');
      const mode = page.locator('.jec-mode'), divider = page.locator('.jec-divider');
      const drag = async (element, dx, dy) => {
        const box = await element.boundingBox(); assert.ok(box);
        const x = box.x + Math.min(box.width / 2, 40), y = box.y + Math.min(box.height / 2, 20);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
      };
      const assertDocuments = async () => {
        assert.deepEqual(await page.evaluate(() => {
          const frame = document.querySelector('.jec-workbench-frame'), buffer = frame.contentDocument.getElementById('buffer');
          return { sameFrame: frame === window.originalEditorFrame, sameDocument: frame.contentDocument === window.originalEditorDocument,
            samePreview: document.getElementById('layout-preview') === window.originalPreviewFrame,
            state: { value: buffer.value, start: buffer.selectionStart, end: buffer.selectionEnd, scroll: buffer.scrollTop,
              identity: frame.contentWindow.documentIdentity }, expected: window.editorState, ...window.layoutCounts };
        }), await page.evaluate(() => ({ sameFrame: true, sameDocument: true, samePreview: true,
          state: window.editorState, expected: window.editorState, mounted: 1, disposed: 0, refreshed: 0,
          detachAttempts: window.layoutCounts.detachAttempts })));
        assert.equal(await page.frameLocator('#layout-preview').locator('body').evaluate(() => window.siteIdentity), previewIdentity);
      };

      await mode.selectOption('left');
      let before = await panel.boundingBox(), siteBox = await preview.boundingBox();
      assert.ok(before.x + before.width <= siteBox.x + 1, 'Left dock places the editor physically left of the site.');
      assert.equal(await divider.getAttribute('aria-orientation'), 'vertical');
      await drag(divider, 80, 0);
      assert.ok((await panel.boundingBox()).width >= before.width + 70, 'Dragging the left divider enlarges the editor.');
      await assertDocuments();

      await mode.selectOption('right');
      before = await panel.boundingBox(); siteBox = await preview.boundingBox();
      assert.ok(siteBox.x + siteBox.width <= before.x + 1, 'Right dock places the site physically left of the editor.');
      await drag(divider, -80, 0);
      assert.ok((await panel.boundingBox()).width >= before.width + 70, 'Dragging the right divider left enlarges the editor.');
      await assertDocuments();

      await mode.selectOption('bottom');
      before = await panel.boundingBox(); siteBox = await preview.boundingBox();
      assert.ok(siteBox.y + siteBox.height <= before.y, 'Bottom dock places the editor beneath the site.');
      assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal');
      await drag(divider, 0, -70);
      assert.ok((await panel.boundingBox()).height >= before.height + 60, 'Dragging the bottom divider upward enlarges the editor.');
      await assertDocuments();

      await mode.selectOption('floating');
      before = await panel.boundingBox();
      assert.ok(Math.abs(before.x - 600) < 3 && Math.abs(before.y - 80) < 3
        && Math.abs(before.width - 640) < 3 && Math.abs(before.height - 460) < 3,
      'The floating geometry is restored from saved layout preferences.');
      await drag(page.locator('.jec-panel-title'), -120, 40);
      let after = await panel.boundingBox();
      assert.ok(Math.abs(after.x - before.x + 120) < 3 && Math.abs(after.y - before.y - 40) < 3, 'The floating title bar moves the panel.');
      before = after;
      await drag(page.locator('.jec-resize-corner'), 90, 60);
      after = await panel.boundingBox();
      assert.ok(after.width >= before.width + 80 && after.height >= before.height + 50, 'The floating corner resizes both dimensions.');
      await page.frameLocator('#layout-preview').getByRole('button', { name: 'Use running site' }).click();
      assert.equal(await page.frameLocator('#layout-preview').locator('#count').textContent(), '1', 'The exposed site remains interactive while the panel floats.');
      await assertDocuments();
      const floating = await panel.boundingBox();
      const remembered = await page.evaluate(() => JSON.parse(window.layoutPreferences.get('joomengine-code-layout')));
      assert.equal(remembered.mode, 'floating');
      assert.ok(Math.abs(remembered.x - floating.x) < 3 && Math.abs(remembered.width - floating.width) < 3);

      await page.locator('[data-i18n-aria-label="code.maximize"]').click();
      assert.equal(await preview.isVisible(), false);
      assert.equal(await mode.inputValue(), 'full');
      await page.locator('[data-i18n-aria-label="code.restore"]').click();
      assert.equal(await mode.inputValue(), 'floating');
      after = await panel.boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(after[key] - floating[key]) < 3, `Restore preserves floating ${key}.`);
      await assertDocuments();

      await page.locator('[data-i18n-aria-label="code.hide"]').click();
      await panel.waitFor({ state: 'hidden' });
      await page.frameLocator('#layout-preview').getByRole('button', { name: 'Use running site' }).click();
      assert.equal(await page.frameLocator('#layout-preview').locator('#count').textContent(), '2');
      await page.evaluate(() => window.layoutHost.open());
      await panel.waitFor({ state: 'visible' });
      await assertDocuments();

      await page.setViewportSize({ width: 390, height: 540 });
      await page.waitForFunction(() => {
        const box = document.querySelector('.jec-panel').getBoundingClientRect();
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
      });
      for (const selector of ['.jec-titlebar', '[data-i18n-aria-label="code.hide"]', '.jec-resize-corner']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 541,
          `${selector} stays reachable after the viewport becomes smaller.`);
      }
      await assertDocuments();
      await mode.selectOption('right');
      assert.equal(await page.locator('.jec-layout-host').getAttribute('data-jec-mode'), 'bottom',
        'A narrow viewport collapses the chosen side dock below the site.');
      assert.equal(await mode.inputValue(), 'right', 'Responsive collapse preserves the preferred dock mode.');
      await page.setViewportSize({ width: 1400, height: 900 });
      await mode.selectOption('right');
      await page.locator('[data-i18n-aria-label="code.detach"]').click();
      await page.getByRole('alert').filter({ hasText: /popup|pop-up/i }).waitFor();
      assert.match(await page.getByRole('alert').textContent(), /allow/i, 'Blocked-popup feedback explains the next action.');
      assert.equal(await mode.inputValue(), 'right');
      assert.equal(await panel.isVisible(), true);
      assert.equal(await page.locator('[data-i18n-aria-label="code.detach"]').isEnabled(), true);
      assert.equal(await page.locator('[data-i18n-aria-label="code.redock"]').count(), 0);
      await assertDocuments();
      assert.equal(await page.evaluate(() => window.layoutCounts.detachAttempts), 1);
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.layoutHost.dispose());
    } finally { await browser?.close(); await server.close(); }
  });

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
