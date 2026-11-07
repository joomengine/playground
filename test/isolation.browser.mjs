import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createStaticServer } from './server.mjs';
import { withPinnedCatalog } from './dynamic-catalog-fixture.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const browserName = process.env.PLAYGROUND_ISOLATION_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('Use chromium or webkit for PLAYGROUND_ISOLATION_BROWSER.');
const browserType = { chromium, webkit }[browserName];

async function launchBrowser(server) {
  try {
    const executablePath = process.env.PLAYGROUND_BROWSER_EXECUTABLE
      || (browserName === 'chromium' ? process.env.PLAYGROUND_CHROMIUM_EXECUTABLE : undefined);
    return await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
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

async function assertSharedMemory(page, { baseURL, ownerId }) {
  const result = await page.evaluate(async ({ baseURL, ownerId }) => {
    const { ownedClientURL } = await import(new URL('src/isolation.mjs', baseURL));
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const worker = new Worker(ownedClientURL(new URL('test/isolation-worker.mjs', baseURL), { baseURL, ownerId }), { type: 'module' });
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Shared-memory worker test timed out.')), 12_000);
        worker.onmessage = event => event.data.ok ? resolve(event.data) : reject(new Error(event.data.error));
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('Shared memory could not be transferred to the worker.'));
        worker.postMessage({ memory });
      });
      return { ...result, shared: memory.buffer instanceof SharedArrayBuffer, value: Atomics.load(new Int32Array(memory.buffer), 0) };
    } finally { clearTimeout(timer); worker.terminate(); }
  }, { baseURL, ownerId });
  assert.deepEqual(result, { ok: true, isolated: true, shared: true, value: 2 });
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
    await assertSharedMemory(normal, { baseURL: server.url, ownerId: normalState.result.ownerId });
    await assertSharedMemory(compatible, { baseURL: server.url, ownerId: compatibleState.result.ownerId });
    const headers = async page => page.evaluate(async () => {
      const response = await fetch('./src/isolation.mjs', { cache: 'no-store' });
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

test(`${browserName}: the production entry stops before navigation when startup storage is blocked or discards writes`, { timeout: 120_000 }, async () => {
  const server = await createStaticServer({ directory, isolation: false });
  const browser = await launchBrowser(server);
  try {
    for (const mode of ['blocked', 'discarded']) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(mode => {
          Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() {
            if (mode === 'blocked') throw new DOMException('Storage is blocked', 'SecurityError');
            return { getItem() { return null; }, setItem() {}, removeItem() {} };
          } });
        }, mode);
        const page = await context.newPage();
        const navigations = [];
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
        await page.goto(`${server.url}?start=0`);
        await page.locator('#error-view:not([hidden])').waitFor();
        assert.match(await page.locator('#error-message').textContent(), /Session storage.*(?:unavailable|cannot retain)/);
        // Observe the live application, including its timers, after the failure.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
        assert.equal(navigations.length, 1, `${mode} storage must stop before the first automatic navigation`);
        assert.equal(await page.locator('#site-frame').count(), 0);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await server.close(); }
});

test(`${browserName}: the production entry stops if an intervening host removes the isolation marker`, { timeout: 120_000 }, async () => {
  const server = await createStaticServer({ directory, isolation: false });
  const browser = await launchBrowser(server);
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const url = new URL(location.href);
      if (url.searchParams.has('__je_coep')) {
        url.searchParams.delete('__je_coep');
        history.replaceState(null, '', url.href);
      }
    });
    const navigations = [];
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url()); });
    await page.goto(`${server.url}?start=0`);
    await page.locator('#error-view:not([hidden])').waitFor();
    assert.match(await page.locator('#error-message').textContent(), /did not retain its bootstrap marker/);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
    assert.equal(navigations.length, 2, 'The persisted takeover budget must stop a second automatic navigation');
  } finally { await browser.close(); await server.close(); }
});

test(`${browserName}: production entry and service worker start Joomla under capability fallback`, {
  timeout: 300_000, skip: !process.env.PLAYGROUND_ISOLATION_RUNTIME_DIST,
}, async () => {
  const server = await createStaticServer({ directory: path.resolve(process.env.PLAYGROUND_ISOLATION_RUNTIME_DIST), isolation: false });
  const browser = await launchBrowser(server);
  const context = await withPinnedCatalog(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const documents = [], runtimeAssets = [], pageErrors = [], siteDocuments = [];
  const evidence = { browser: browserName, version: browser.version(), documents, runtimeAssets, pageErrors, siteDocuments };
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.url().includes('/__site/') && response.request().resourceType() === 'document') {
      siteDocuments.push({ url: response.url(), status: response.status() });
    }
  });
  try {
    await page.addInitScript(() => {
      if (new URL(location.href).searchParams.get('__je_coep')?.endsWith(':credentialless')) {
        Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false });
      }
    });
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
    });
    context.on('request', request => {
      if (/\.(?:wasm|so)(?:\?|$)/.test(request.url())) runtimeAssets.push(request.url());
    });
    await page.goto(`${server.url}?deploy=blank&php=8.4&jcb=none&persist=0&start=1&immediate=1`);
    await page.locator('html[data-playground-environment="ready"]').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('#site-frame') || !document.getElementById('error-view').hidden,
      undefined, { timeout: 240_000 });
    assert.equal(await page.locator('#error-view').isVisible(), false,
      `The actual application failed to start: ${await page.locator('#error-message').textContent()}`);
    await page.locator('#site-frame').waitFor({ timeout: 240_000 });
    const element = await page.locator('#site-frame').elementHandle();
    const expected = new URL(await element.getAttribute('src'));
    assert.ok(expected.pathname.includes('/__site/'), 'The application must mount its real PHP site');
    const frame = await element.contentFrame();
    assert.ok(frame, 'The preview must have an attached browsing context');
    await frame.waitForURL(url => url.origin === expected.origin && url.pathname.startsWith(expected.pathname),
      { waitUntil: 'load', timeout: 60_000 });
    await frame.locator('body.site').waitFor({ timeout: 60_000 });
    // Cassiopeia's visible brand is an image, not a body-text Joomla label.
    // Verify the actual rendered CMS document and its component container.
    evidence.generator = await frame.locator('meta[name="generator"]').getAttribute('content');
    assert.match(evidence.generator, /^Joomla!/i);
    assert.equal(await frame.locator('main').count(), 1);
    assert.equal(siteDocuments.at(-1)?.status, 200, 'The visible site document must be a successful PHP response');
    assert.match(new URL(page.url()).searchParams.get('__je_coep'), /:require-corp$/);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    assert.equal(documents.length, 3, 'Initial page plus credentialless takeover plus one require-corp fallback');
    assert.ok(runtimeAssets.length > 0, 'The production page must load the real PHP/MariaDB runtime');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
    assert.equal(documents.length, 3, 'Resuming the application must not restart isolation navigation');
    assert.equal(await page.locator('#error-view').isVisible(), false);
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.failure = error.message;
    evidence.ui = await page.evaluate(() => ({
      error: document.getElementById('error-message')?.textContent,
      loading: document.getElementById('loading-message')?.textContent,
      environment: document.documentElement.dataset.playgroundEnvironment,
      frame: document.getElementById('site-frame')?.getAttribute('src'),
      frameTitle: document.getElementById('site-frame')?.contentDocument?.title,
      frameBody: document.getElementById('site-frame')?.contentDocument?.body?.innerText?.slice(0, 1000),
    })).catch(() => null);
    throw error;
  } finally {
    await mkdir(path.join(directory, 'test-results'), { recursive: true });
    await writeFile(path.join(directory, 'test-results', `isolation-startup-${browserName}.json`), JSON.stringify(evidence, null, 2));
    await context.close(); await browser.close(); await server.close();
  }
});

test(`${browserName}: mobile-sized compatibility mode runs PHP, MariaDB and Joomla without external downloads`, {
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
