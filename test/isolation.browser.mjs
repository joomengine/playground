import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const browserName = process.env.PLAYGROUND_ISOLATION_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('Use chromium or webkit for PLAYGROUND_ISOLATION_BROWSER.');
const browserType = { chromium, webkit }[browserName];

async function prepare(page, url, { simulateUnsupportedCredentialless = false } = {}) {
  if (simulateUnsupportedCredentialless) await page.addInitScript(() => {
    if (new URL(location.href).searchParams.get('__je_coep')?.endsWith(':credentialless')) {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false });
    }
  });
  await page.goto(url);
  const attempts = [];
  for (let index = 0; index < 3; index++) {
    const result = await page.evaluate(async () => {
      const { prepareBrowserIsolation } = await import('./src/isolation-bootstrap.mjs');
      return prepareBrowserIsolation({ baseURL: new URL('./', location.href).href });
    });
    attempts.push({ policy: result.policy, reload: result.reloadRequired });
    if (!result.reloadRequired) return { result, attempts };
    await page.goto(result.reloadURL);
  }
  throw new Error('The bootstrap exceeded two controlled navigations.');
}

test(`${browserName}: headerless hosting, independent policies, owned workers, detached views and SW restart`, { timeout: 120_000 }, async () => {
  const server = await createStaticServer({ directory, isolation: false, fixtures: {
    'config/browser-compatibility.json': JSON.stringify({ schemaVersion: 1, fallbackEnabled: true }),
  } });
  const browser = await browserType.launch({ headless: true,
    ...(process.env.PLAYGROUND_BROWSER_EXECUTABLE ? { executablePath: process.env.PLAYGROUND_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  try {
    const normal = await context.newPage(), compatible = await context.newPage();
    const direct = await context.request.get(new URL('__test__.html', server.url).href);
    assert.equal(direct.headers()['cross-origin-embedder-policy'], undefined, 'The host must not mask SW bootstrap failures.');
    const normalState = await prepare(normal, new URL('__test__.html', server.url).href);
    assert.equal(normalState.result.reloadRequired, false);
    // WebKit versions without credentialless support legitimately choose fallback.
    if (browserName === 'chromium') assert.equal(normalState.result.policy, 'credentialless');
    const compatibleState = await prepare(compatible, new URL('__test__.html', server.url).href, { simulateUnsupportedCredentialless: true });
    assert.equal(compatibleState.result.policy, 'require-corp');
    assert.deepEqual(compatibleState.attempts.map(item => item.policy), ['credentialless', 'require-corp', 'require-corp']);
    const headers = async page => page.evaluate(async () => {
      const response = await fetch('./src/isolation-probe.mjs', { cache: 'no-store' });
      return { coep: response.headers.get('Cross-Origin-Embedder-Policy'), coop: response.headers.get('Cross-Origin-Opener-Policy') };
    });
    assert.deepEqual(await headers(normal), { coep: normalState.result.policy, coop: 'same-origin' });
    assert.deepEqual(await headers(compatible), { coep: 'require-corp', coop: 'same-origin' });
    const popupPromise = compatible.waitForEvent('popup');
    await compatible.evaluate(async state => {
      const { ownedClientURL } = await import('./src/isolation.mjs');
      window.open(ownedClientURL(new URL('__test__.html', location.href), { ownerId: state.ownerId, baseURL: new URL('./', location.href).href }));
    }, compatibleState.result);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => crossOriginIsolated), true);
    assert.equal((await headers(popup)).coep, 'require-corp');
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(compatible);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();
      assert.equal((await headers(normal)).coep, normalState.result.policy);
      assert.equal((await headers(compatible)).coep, 'require-corp');
      assert.equal((await headers(popup)).coep, 'require-corp');
    }
    await popup.close();
    await compatible.reload();
    const reopened = await compatible.evaluate(async () => {
      const { prepareBrowserIsolation } = await import('./src/isolation-bootstrap.mjs');
      return prepareBrowserIsolation({ baseURL: new URL('./', location.href).href });
    });
    assert.equal(reopened.policy, 'require-corp');
    assert.equal(reopened.reloadRequired, false);
    assert.equal((await headers(normal)).coep, normalState.result.policy);
  } finally { await context.close(); await browser.close(); await server.close(); }
});
