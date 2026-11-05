import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const browserName = process.env.PLAYGROUND_ISOLATION_BROWSER || 'chromium';
const browserType = { chromium, webkit }[browserName];
if (!browserType) throw new Error('Use chromium or webkit for PLAYGROUND_ISOLATION_BROWSER.');

for (const fallback of [false, true]) test(`${browserName}: actual verification popup completes and cancels without changing ${fallback ? 'fallback' : 'normal'} shell isolation`, { timeout: 120_000 }, async () => {
  const server = await createStaticServer({ directory, isolation: false, fixtures: {
    'config/network.json': JSON.stringify({ schemaVersion: 1, enabled: true, endpoint: 'https://relay.example', turnstileSiteKey: '1x00000000000000000000AA' }),
  } });
  let browser, context;
  try {
    browser = await browserType.launch({ headless: true,
      ...(process.env.PLAYGROUND_BROWSER_EXECUTABLE ? { executablePath: process.env.PLAYGROUND_BROWSER_EXECUTABLE } : {}) });
    context = await browser.newContext();
    await context.addInitScript(fallback => {
      if (fallback && new URL(location.href).searchParams.get('__je_coep')?.endsWith(':credentialless')) {
        Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false });
      }
      // Isolated UI proof only: hosted Siteverify and real challenge acceptance
      // are covered by the separate hosted staging workflow.
      if (location.pathname.endsWith('/network-verify.html')) {
        globalThis.turnstile = {
          render(_container, options) {
            globalThis.verificationOptions = { sitekey: options.sitekey, action: options.action };
            globalThis.completeVerification = () => options.callback('one-use-browser-fixture-proof');
            return 'fixture-widget';
          },
          remove() {},
        };
      }
    }, fallback);
    const page = await context.newPage();
    await page.goto(`${server.url}__test__.html`);
    const environment = await prepareBrowserEnvironment(page);
    if (fallback) assert.equal(environment.policy, 'require-corp');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    for (const cancel of [false, true]) {
      await page.evaluate(async () => {
        const { requestNetworkVerification } = await import('./src/network-session.mjs');
        window.proofController = new AbortController();
        window.proof = null;
        void requestNetworkVerification(new URL('./', location.href), { signal: window.proofController.signal })
          .then(token => { window.proof = { token }; }, error => { window.proof = { error: error.code }; });
      });
      const popupPromise = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Verify network access', exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForFunction(() => typeof window.completeVerification === 'function');
      assert.equal(await popup.evaluate(() => crossOriginIsolated), false);
      assert.deepEqual(await popup.evaluate(() => window.verificationOptions), { sitekey: '1x00000000000000000000AA', action: 'network-session' });
      const closed = popup.waitForEvent('close');
      if (cancel) await page.evaluate(() => window.proofController.abort());
      else await popup.evaluate(() => window.completeVerification());
      await closed;
      await page.waitForFunction(() => window.proof !== null);
      assert.deepEqual(await page.evaluate(() => window.proof), cancel ? { error: 'REQUEST_ABORTED' } : { token: 'one-use-browser-fixture-proof' });
      assert.equal(await page.locator('dialog').count(), 0);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      assert.equal(new URL(page.url()).searchParams.get('__je_coep')?.split(':').at(-1), environment.policy);
    }
  } finally { await context?.close(); await browser?.close(); await server.close(); }
});
