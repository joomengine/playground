import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { chromium, firefox, webkit } from 'playwright';
import { isolationNavigationURL } from '../src/isolation.mjs';
import { createRelayWorker } from '../services/network-worker/src/index.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const root = new URL('../', import.meta.url);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

// Screenshots are PNG; reconstruct the first scanline to prove CSS really painted
// red pixels instead of merely exposing a computed background URL.
function firstPixel(png) {
  let offset = 8, width, color, depth; const chunks = [];
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') { width = data.readUInt32BE(0); depth = data[8]; color = data[9]; }
    if (type === 'IDAT') chunks.push(data);
    offset += size + 12;
  }
  assert.equal(depth, 8); assert.ok([2, 6].includes(color)); assert.ok(width);
  const decoded = inflateSync(Buffer.concat(chunks));
  // First pixel has no left/above neighbour for all PNG filter types.
  assert.ok(decoded[0] <= 4);
  return [...decoded.subarray(1, 4)];
}

test('shared HTTP transport renders cross-origin images in compatibility mode without an asset registry', { timeout: 120_000 }, async t => {
  const restrictedRequests = [], relayRequests = [];
  const restricted = http.createServer((req, res) => {
    restrictedRequests.push({ url: req.url, cookie: req.headers.cookie });
    // Deliberately no Access-Control-Allow-Origin or Cross-Origin-Resource-Policy.
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(pixel);
  });
  const restrictedOrigin = await listen(restricted);
  let relayOrigin, relayAvailable = true;
  const worker = createRelayWorker();
  const relay = http.createServer(async (req, res) => {
    try {
      relayRequests.push({ url: req.url, headers: req.headers });
      if (!relayAvailable) {
        res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Fixture relay unavailable.' } }));
        return;
      }
      const response = await worker.fetch(new Request(new URL(req.url, relayOrigin), { method: req.method, headers: req.headers }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  relayOrigin = await listen(relay);
  let appOrigin;
  const app = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, appOrigin);
      const policy = url.searchParams.get('__je_coep')?.endsWith(':credentialless') ? 'credentialless' : 'require-corp';
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', policy);
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/service-worker.mjs') {
        // A shared service worker does not inherit a particular tab's policy.
        res.removeHeader('Cross-Origin-Embedder-Policy');
        res.setHeader('Content-Type', 'application/javascript');
        res.end(await readFile(new URL('service-worker.mjs', root)));
      } else if (url.pathname === '/config/network.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ endpoint: relayOrigin }));
      } else if (url.pathname.startsWith('/src/')) {
        const name = url.pathname.slice('/src/'.length);
        if (!/^[a-zA-Z0-9_.-]+\.mjs$/.test(name)) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/javascript');
        res.end(await readFile(new URL(`src/${name}`, root)));
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>Image transport</title><body style="margin:0;background:white"></body>');
      }
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  appOrigin = await listen(app);
  let browser;
  try {
    const name = process.env.NETWORK_IMAGES_BROWSER ?? 'chromium';
    const type = { chromium, firefox, webkit }[name];
    if (!type) throw new Error('NETWORK_IMAGES_BROWSER must be webkit, chromium or firefox.');
    browser = await type.launch({ headless: true, executablePath: process.env.PLAYGROUND_BROWSER_EXECUTABLE || (name === 'chromium' ? process.env.PLAYGROUND_CHROMIUM_EXECUTABLE : undefined),
      ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (process.env.NETWORK_IMAGES_BROWSER_DEBUG) {
      context.on('console', message => console.error('browser console:', message.type(), message.text()));
      page.on('requestfailed', request => console.error('failed:', request.url(), request.failure()));
    }
    const assetURL = `${restrictedOrigin}/arbitrary-image.png`;
    const loadImage = (page, url) => page.evaluate(url => new Promise(resolve => {
      const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false);
      image.src = url; document.body.append(image);
    }), url);
    await page.goto(isolationNavigationURL(`${appOrigin}/`, 'require-corp'));
    assert.equal(await page.evaluate(() => crossOriginIsolated && new SharedArrayBuffer(8).byteLength === 8), true);
    assert.equal(await loadImage(page, assetURL), false, 'The fixture must demonstrate COEP blocking before the service worker takes control.');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/service-worker.mjs', { type: 'module' }); await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await page.reload();
    const results = await page.evaluate(async url => {
      const image = (kind, configure) => new Promise(resolve => {
        const img = new Image(); img.dataset.kind = kind;
        img.onload = () => resolve({ kind, loaded: true, width: img.naturalWidth });
        img.onerror = () => resolve({ kind, loaded: false }); configure(img, `${url}?kind=${kind}`);
        if (!img.isConnected) document.body.append(img);
      });
      const result = [];
      result.push(await image('src', (img, src) => { img.src = src; }));
      result.push(await image('srcset', (img, src) => { img.sizes = '1px'; img.srcset = `${src} 1w`; }));
      result.push(await image('picture', (img, src) => { const picture = document.createElement('picture'); const source = document.createElement('source'); source.srcset = src; picture.append(source, img); document.body.append(picture); }));
      result.push(await image('dynamic', (img, src) => { document.body.append(img); img.setAttribute('src', src); }));
      const css = document.createElement('div'); css.id = 'css'; css.style.cssText = `width:5px;height:5px;background-image:url("${url}?kind=css");background-size:cover`; document.body.append(css);
      return result;
    }, assetURL);
    assert.ok(results.every(result => result.loaded && result.width === 1), JSON.stringify(results));
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('?kind=css')));
    assert.deepEqual(firstPixel(await page.locator('#css').screenshot()), [255, 0, 0]);
    // A newly encountered image needs no registry, content hash, or MIME policy.
    assert.equal(await loadImage(page, `${restrictedOrigin}/new-image-path?added=after-startup`), true);
    assert.ok(relayRequests.some(request => new URL(request.url, relayOrigin).searchParams.get('url') === `${assetURL}?kind=src`));
    assert.ok(relayRequests.every(request => !request.headers.authorization && !request.headers.cookie));
    const count = relayRequests.length;
    const normal = await context.newPage(); await normal.goto(isolationNavigationURL(`${appOrigin}/`, 'credentialless'));
    assert.equal(await loadImage(normal, `${assetURL}?mode=credentialless`), true);
    assert.equal(relayRequests.length, count, 'Credentialless mode loads images directly.');
    assert.deepEqual(errors, [], 'Successful image delivery must not produce page errors.');
    relayAvailable = false;
    const unavailableURL = `${assetURL}?unavailable=true`;
    assert.equal(await loadImage(page, unavailableURL), false);
    assert.deepEqual(await page.evaluate(() => ({ isolated: crossOriginIsolated, shared: new SharedArrayBuffer(8).byteLength })), { isolated: true, shared: 8 });
    // WebKit reports this deliberately failed subresource as page errors. Its
    // Playwright error messages can omit the scheme and one slash. Accept only
    // the observed resource/CORP diagnostics for this exact outage-test URL.
    const expectedResourceErrors = new Set([unavailableURL, unavailableURL.replace(/^https?:\//, '')].flatMap(url => [
      `${url}.`, `${url} because it violates the resource's Cross-Origin-Resource-Policy response header.`,
    ]));
    for (const error of errors) {
      assert.ok(name === 'webkit' && expectedResourceErrors.has(error), `Unexpected page error during the deliberate image outage: ${error}`);
    }
    const evidence = { browser: name, version: browser.version(), isolated: true, blockedBeforeServiceWorker: true,
      results, cssPixel: [255, 0, 0], unregisteredImage: true, credentiallessProxyRequests: 0,
      unavailableImage: true, expectedResourceErrors: errors.length, upstreamRequests: restrictedRequests.length };
    t.diagnostic(JSON.stringify(evidence));
    if (process.env.NETWORK_IMAGES_BROWSER_EVIDENCE) await writeFile(process.env.NETWORK_IMAGES_BROWSER_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally { await browser?.close(); await Promise.all([close(app), close(relay), close(restricted)]); }
});
