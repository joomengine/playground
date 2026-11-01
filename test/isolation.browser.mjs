import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const browserName = process.env.PLAYGROUND_ISOLATION_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('Use chromium or webkit for PLAYGROUND_ISOLATION_BROWSER.');
const browserType = { chromium, webkit }[browserName];

async function launchBrowser(server) {
  try {
    return await browserType.launch({ headless: true,
      ...(process.env.PLAYGROUND_BROWSER_EXECUTABLE ? { executablePath: process.env.PLAYGROUND_BROWSER_EXECUTABLE } : {}) });
  } catch (error) { await server.close(); throw error; }
}

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
  // Exercise the configuration that ships, rather than enabling a test-only
  // fallback that could hide a disabled production deployment.
  const server = await createStaticServer({ directory, isolation: false });
  const browser = await launchBrowser(server);
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

test(`${browserName}: unavailable compatibility configuration retains automatic capability fallback`, { timeout: 120_000 }, async () => {
  const server = await createStaticServer({ directory, isolation: false, fixtures: {
    'config/browser-compatibility.json': 'unavailable',
  } });
  const browser = await launchBrowser(server);
  try {
    const page = await browser.newPage();
    const state = await prepare(page, new URL('__test__.html', server.url).href, { simulateUnsupportedCredentialless: true });
    assert.equal(state.result.policy, 'require-corp');
    assert.equal(state.result.reloadRequired, false);
    assert.match(state.result.diagnostic, /automatic browser compatibility defaults/);
    assert.equal(await page.evaluate(() => crossOriginIsolated && new SharedArrayBuffer(8).byteLength === 8), true);
  } finally { await browser.close(); await server.close(); }
});

test(`${browserName}: mobile-sized compatibility mode runs PHP, MariaDB and Joomla without an image relay`, {
  timeout: 300_000, skip: !process.env.PLAYGROUND_ISOLATION_RUNTIME_DIST,
}, async () => {
  const server = await createStaticServer({ directory: path.resolve(process.env.PLAYGROUND_ISOLATION_RUNTIME_DIST), isolation: false });
  const browser = await launchBrowser(server);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const externalRequests = [];
    context.on('request', request => { if (!request.url().startsWith(server.url)) externalRequests.push(request.url()); });
    const state = await prepare(page, new URL('__test__.html', server.url).href, { simulateUnsupportedCredentialless: true });
    assert.equal(state.result.policy, 'require-corp');
    const proof = await page.evaluate(async () => {
      const { createPlayground } = await import('./src/playground.mjs');
      const delivery = await (await fetch('./config/public-assets-config.json')).json();
      if (delivery.enabled || delivery.relayBaseURL !== null) throw new Error('This proof requires the unconfigured image relay shipped by default.');
      const site = await createPlayground({ persistence: false, phpVersion: '8.4',
        admin: { name: 'Mobile test', username: 'mobile-test', password: 'Mobile-fixture-2026!', email: 'mobile@example.test' } });
      try {
        const response = await site.request('/');
        const text = await response.text();
        const result = await site.runPhp("<?php $db = new PDO('mysql:host=127.0.0.1;dbname=joomla', 'root', ''); echo json_encode(['php' => PHP_VERSION, 'answer' => (int) $db->query('SELECT 42')->fetchColumn()]);");
        return { policy: site.isolation.policy, status: response.status, joomla: /Joomla/i.test(text), database: JSON.parse(result.text) };
      } finally { await site.close(); }
    });
    assert.equal(proof.policy, 'require-corp');
    assert.equal(proof.status, 200);
    assert.equal(proof.joomla, true);
    assert.equal(proof.database.answer, 42);
    assert.match(proof.database.php, /^8\.4\./);
    assert.deepEqual(externalRequests, [], 'Core runtime startup must not depend on an external relay.');
  } finally { await context.close(); await browser.close(); await server.close(); }
});
