import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`${name}: companion channels keep all tools on one owning site`, { timeout: 45_000 }, async () => {
    const server = await createStaticServer({ directory });
    let browser;
    try {
      browser = await { chromium, firefox }[name].launch({ headless: true,
        ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
      const context = await browser.newContext();
      const owner = await context.newPage(), companion = await context.newPage(), second = await context.newPage();
      const errors = [];
      for (const page of [owner, companion, second]) page.on('pageerror', error => errors.push(error.message));
      await owner.goto(`${server.url}__test__.html`);
      const identity = await owner.evaluate(async () => {
        const { createRuntimeViewHost } = await import('./src/runtime-views.mjs');
        let value = 'original', writes = 0;
        const listeners = new Set();
        const runtime = {
          baseUrl: new URL('__site/existing-owner/existing-runtime/', location.href).href,
          url: new URL('__site/existing-owner/existing-runtime/administrator/', location.href).href,
          configuration: { storageKey: 'existing-live-site', persistence: true, phpVersion: '8.4' },
          installation: { administrator: { username: 'existing' } }, healthy: true, closed: false, idle: true,
          workspace: {
            id: 'existing-runtime', storageId: 'existing-live-site', root: '/',
            async request(operation, args) {
              if (operation === 'write') { value = args.contents; writes++; for (const listener of listeners) listener({ type: 'changed', changes: [{ path: '/index.php', type: 'changed' }] }); }
              return { value, writes };
            },
            withBatch: callback => callback(runtime.workspace),
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          },
          debugger: { state: 'idle', capabilities: {}, subscribe: () => () => {} },
          openDatabase: async () => ({ url: new URL('__adminer/', runtime.baseUrl).href }),
        };
        window.ownerRuntime = runtime;
        window.ownerView = createRuntimeViewHost({ getRuntime: () => runtime });
        window.addEventListener('pagehide', () => window.ownerView.dispose());
        return { token: window.ownerView.token, baseUrl: runtime.baseUrl };
      });
      for (const page of [companion, second]) {
        await page.goto(`${server.url}__test__.html`);
        await page.evaluate(async token => {
          const { attachRuntimeView } = await import('./src/runtime-views.mjs');
          window.runtimeView = await attachRuntimeView({ token, beforeTransition: () => !window.hasDraft,
            onUnavailable: () => { document.body.dataset.owner = 'unavailable'; } });
          window.addEventListener('pagehide', () => window.runtimeView.dispose());
          window.events = [];
          window.runtimeView.workspace.subscribe(event => window.events.push(event));
        }, identity.token);
      }
      assert.equal(await companion.evaluate(() => window.runtimeView.baseUrl), identity.baseUrl);
      assert.equal(await second.evaluate(() => window.runtimeView.workspace.id), 'existing-runtime');
      await companion.evaluate(() => window.runtimeView.workspace.request('write', { path: '/index.php', contents: 'written once' }));
      assert.deepEqual(await second.evaluate(() => window.runtimeView.workspace.request('read', { path: '/index.php' })), { value: 'written once', writes: 1 });
      await second.waitForFunction(() => window.events.some(event => event.changes?.[0]?.path === '/index.php'));
      assert.equal((await second.evaluate(() => window.runtimeView.openDatabase())).url, `${identity.baseUrl}__adminer/`);
      await companion.evaluate(() => { window.hasDraft = true; });
      assert.equal(await owner.evaluate(() => window.ownerView.prepareTransition('stop')), false);
      await companion.close();
      await owner.waitForFunction(() => window.ownerView.clients === 1);
      assert.equal(await owner.evaluate(() => window.ownerRuntime.healthy), true);
      assert.equal(await owner.evaluate(() => window.ownerView.prepareTransition('stop')), true);
      await owner.close();
      await second.waitForFunction(() => document.body.dataset.owner === 'unavailable');
      assert.equal(await second.evaluate(() => window.runtimeView.healthy), false);
      assert.equal(await second.evaluate(() => window.runtimeView.isRemoteView), true);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
