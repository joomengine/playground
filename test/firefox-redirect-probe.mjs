import assert from 'node:assert/strict';
import { createStaticServer } from './server.mjs';

const prefix = '[JavaScript Error: "Failed to load ‘’. A ServiceWorker intercepted the request and encountered an unexpected error." {file: "';
export function isSyntheticRedirectDiagnostic(record, sourceURL) {
  return record.url === sourceURL && record.message.startsWith(prefix + sourceURL + '" line: ')
    && /^\d+\}\]$/.test(record.message.slice((prefix + sourceURL + '" line: ').length));
}

/** Reproduce the browser's own redirect diagnostic without application/runtime code. */
export async function probeSyntheticRedirect(browser) {
  if (browser.browserType().name() !== 'firefox') return null;
  const source = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
let submissions = 0;
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/form')) return;
  if (event.request.method === 'POST') {
    submissions++;
    url.search = 'complete=1';
    event.respondWith(Response.redirect(url.href, 303));
    return;
  }
  if (url.searchParams.has('redirect')) {
    const remaining = Number(url.searchParams.get('redirect')) - 1;
    url.search = remaining ? 'redirect=' + remaining : 'complete=1';
    event.respondWith(Response.redirect(url.href, 301));
    return;
  }
  event.respondWith(new Response('<!doctype html><title>Native redirect proof</title><body><form method="post" action="form"><button id="submit">Submit</button></form><output id="result">' + event.request.method + ':' + submissions + '</output>', { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin'
  }}));
});`;
  const server = await createStaticServer({ directory: '.', prefix: '/synthetic-redirect/', fixtures: {
    'redirect-worker.mjs': source,
    'redirect.html': '<!doctype html><title>Isolated HTTP redirect proof</title><body>Native browser redirect</body>',
  } });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], diagnostics = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.push({ message: message.text(), url: message.location().url });
  });
  try {
    await page.goto(new URL('redirect.html', server.url).href);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('redirect-worker.mjs');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      const frame = document.createElement('iframe'); frame.id = 'redirect-proof'; frame.src = 'form'; document.body.append(frame);
    });
    const frame = await (await page.locator('#redirect-proof').elementHandle()).contentFrame();
    await frame.locator('#submit').waitFor();
    await Promise.all([frame.waitForNavigation({ waitUntil: 'load' }), frame.locator('#submit').click()]);
    assert.equal(await frame.locator('#result').textContent(), 'GET:1', 'A 303 must submit once and finish with GET.');
    assert.equal(frame.url(), new URL('form?complete=1', server.url).href, 'The browser must follow the exact Location target.');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    assert.deepEqual(errors, []);
    const sourceURL = new URL('redirect-worker.mjs', server.url).href;
    assert.ok(diagnostics.length <= 1 && diagnostics.every(record => isSyntheticRedirectDiagnostic(record, sourceURL)),
      `The isolated redirect produced an unrelated browser error: ${JSON.stringify(diagnostics)}`);
    const postDiagnostics = diagnostics.splice(0);
    await frame.goto(new URL('form?redirect=2', server.url).href);
    assert.equal(frame.url(), new URL('form?complete=1', server.url).href);
    assert.equal(await frame.locator('#result').textContent(), 'GET:1', 'GET redirects must not replay the earlier submission.');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    assert.ok(diagnostics.length <= 2 && diagnostics.every(record => isSyntheticRedirectDiagnostic(record, sourceURL)),
      `The isolated GET redirects produced an unrelated browser error: ${JSON.stringify(diagnostics)}`);
    assert.deepEqual(errors, []);
    const proof = { browserVersion: browser.version(), methodAfterRedirect: 'GET', submissions: 1,
      cases: { post303: { reproduced: postDiagnostics.length === 1, status: 303, redirects: 1, diagnostics: postDiagnostics },
        get301: { reproduced: diagnostics.length === 2, status: 301, redirects: 2, diagnostics } } };
    console.log(JSON.stringify({ syntheticRedirectProbe: proof }));
    return proof;
  } finally { await context.close(); await server.close(); }
}

/** Observe actual service-worker RPC responses without changing their data or behavior. */
export async function startRedirectTrace(page) {
  return page.evaluate(() => {
    if (!window.__redirectProof) {
      window.__redirectProof = [];
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type !== 'playground-request' || !event.ports[0]) return;
        const { request } = event.data, port = event.ports[0], post = port.postMessage.bind(port);
        port.postMessage = function (response, ...options) {
          if ([301, 303].includes(response?.status)) window.__redirectProof.push({
            url: request.url, method: request.method, status: response.status,
            location: new Headers(response.headers).get('Location'),
          });
          return post(response, ...options);
        };
      });
    }
    return window.__redirectProof.length;
  });
}

export async function recordVerifiedRedirectDiagnostic(page, { probe, kind, from, traceFrom, sourceURL, step, finalURL, responseStatus, methodAfterRedirect }) {
  if (!probe?.cases[kind]?.reproduced) return;
  assert.equal(responseStatus, 200);
  assert.equal(methodAfterRedirect, 'GET');
  const known = page.consoleErrors.slice(from).filter(record => record.step === step && isSyntheticRedirectDiagnostic(record, sourceURL));
  const redirects = (await page.evaluate(from => window.__redirectProof.slice(from), traceFrom))
    .filter(record => record.status === probe.cases[kind].status && record.method === (kind === 'post303' ? 'POST' : 'GET'));
  for (const redirect of redirects) {
    assert.equal(new URL(redirect.url).origin, new URL(finalURL).origin);
    assert.ok(new URL(redirect.location, redirect.url).pathname.includes('/__site/'));
  }
  assert.ok(known.length <= redirects.length, 'Every known browser diagnostic needs an observed native HTTP redirect.');
  if (known.length) assert.equal(new URL(redirects.at(-1).location, redirects.at(-1).url).href, finalURL);
  for (const record of known) {
    page.knownBrowserDiagnostics.push({ ...record, reason: 'Reproduced by the current Firefox using direct Response.redirect; native redirects and final page verified.', redirects, probe: probe.cases[kind] });
    page.consoleErrors.splice(page.consoleErrors.indexOf(record), 1);
  }
}
