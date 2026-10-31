import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const root = new URL('../', import.meta.url);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

// Screenshots are PNG; reconstruct the first scanline to prove CSS really painted
// the approved red pixels instead of merely exposing a computed background URL.
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

test('real browser COEP blocks restricted images; approved SW delivery renders src/srcset/picture/CSS/dynamic with exact PHP-fetch bytes', { timeout: 120_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'public-images-'));
  const keyFile = path.join(temporary, 'key.pem'), certFile = path.join(temporary, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const key = await readFile(keyFile), cert = await readFile(certFile);
  const restrictedRequests = [], relayRequests = [];
  const restricted = https.createServer({ key, cert }, (req, res) => {
    restrictedRequests.push(req.url);
    // Deliberately no Access-Control-Allow-Origin or Cross-Origin-Resource-Policy.
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(pixel);
  });
  const restrictedAddress = (await listen(restricted)).replace('http:', 'https:');
  let appOrigin, relayAvailable = true;
  const relay = http.createServer((req, res) => {
    relayRequests.push({ url: req.url, headers: req.headers });
    res.setHeader('Access-Control-Allow-Origin', appOrigin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Public-Asset-SHA256');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    if (!relayAvailable) { res.statusCode = 503; res.end('unavailable'); return; }
    res.setHeader('X-Public-Asset-SHA256', createHash('sha256').update(pixel).digest('hex'));
    res.end(pixel);
  });
  const relayOrigin = await listen(relay);
  const assetURL = `${restrictedAddress}/approved.png`;
  const registry = { schemaVersion: 1, version: 'fixture-v1', assets: [{ id: 'approved', url: assetURL, owner: 'browser fixture',
    mime: 'image/png', maxBytes: 1024, redirects: [], sha256: createHash('sha256').update(pixel).digest('hex'),
    compatibilityRequired: true, cache: { maxAgeSeconds: 0, immutable: false }, updatePolicy: 'pinned' }] };
  const config = { schemaVersion: 1, enabled: true, relayBaseURL: 'https://relay.fixture/', registryVersions: ['fixture-v1'], timeoutMs: 3000 };
  const app = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, appOrigin), policy = url.searchParams.get('policy') === 'credentialless' ? 'credentialless' : 'require-corp';
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', policy);
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/sw.mjs') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`import { handlePublicAssetRequest } from '/src/public-assets-worker.mjs';
          const registry=${JSON.stringify(registry)}, config=${JSON.stringify(config)};
          self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
          self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
          self.addEventListener('fetch',event=>{
            if(event.request.destination!=='image'&&!new URL(event.request.url).pathname.startsWith('/__public-assets/')) return;
            event.respondWith((async()=>{
              const client=await self.clients.get(event.clientId);
              const policy=client&&new URL(client.url).searchParams.get('policy')==='credentialless'?'credentialless':'require-corp';
              const response=await handlePublicAssetRequest(event.request,{policy,baseURL:self.registration.scope,registry,config,
                fetcher:(url,init)=>fetch(url.replace('https://relay.fixture/',${JSON.stringify(`${relayOrigin}/`)}),init)});
              return response||fetch(event.request);
            })());
          });`);
      } else if (url.pathname.startsWith('/src/')) {
        const name = url.pathname.slice('/src/'.length);
        if (!['public-assets.mjs', 'public-assets-worker.mjs', 'php-network.mjs'].includes(name)) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/javascript'); res.end(await readFile(new URL(`src/${name}`, root)));
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>Image contract</title><body style="margin:0;background:white"></body>');
      }
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  appOrigin = await listen(app);
  let browser;
  try {
    const name = process.env.PUBLIC_ASSET_BROWSER ?? 'webkit';
    const type = { chromium, firefox, webkit }[name];
    if (!type) throw new Error('PUBLIC_ASSET_BROWSER must be webkit, chromium or firefox.');
    browser = await type.launch({ headless: true, executablePath: process.env.PUBLIC_ASSET_BROWSER_EXECUTABLE || undefined,
      ...(name === 'chromium' ? { args: ['--no-sandbox', '--ignore-certificate-errors'] } : {}) });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${appOrigin}/?policy=require-corp`);
    assert.equal(await page.evaluate(() => crossOriginIsolated && new SharedArrayBuffer(8).byteLength === 8), true);
    const blocked = await page.evaluate(url => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve(false); img.onerror = () => resolve(true); img.src = url; document.body.append(img);
    }), assetURL);
    assert.equal(blocked, true, 'Fixture must demonstrate the actual require-corp restriction before any proxy.');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.mjs', { type: 'module' }); await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await page.reload();
    const results = await page.evaluate(async url => {
      const image = (kind, configure) => new Promise(resolve => {
        const img = new Image(); img.dataset.kind = kind;
        img.onload = () => resolve({ kind, loaded: true, width: img.naturalWidth });
        img.onerror = () => resolve({ kind, loaded: false }); configure(img);
        if (!img.isConnected) document.body.append(img);
      });
      const result = [];
      result.push(await image('src', img => { img.src = url; }));
      result.push(await image('srcset', img => { img.srcset = `${url} 1x, ${url} 2x`; }));
      result.push(await image('picture', img => { const picture = document.createElement('picture'); const source = document.createElement('source'); source.srcset = url; picture.append(source, img); document.body.append(picture); }));
      result.push(await image('dynamic', img => { document.body.append(img); img.setAttribute('src', url); }));
      const css = document.createElement('div'); css.id = 'css'; css.style.cssText = `width:5px;height:5px;background-image:url("${url}");background-size:cover`; document.body.append(css);
      return result;
    }, assetURL);
    assert.ok(results.every(result => result.loaded && result.width === 1), JSON.stringify(results));
    await page.waitForTimeout(250);
    assert.deepEqual(firstPixel(await page.locator('#css').screenshot()), [255, 0, 0]);
    const php = await page.evaluate(async ({ url, registry, config, baseURL }) => {
      const { createPhpFetch } = await import('/src/php-network.mjs');
      const fetcher = createPhpFetch(fetch, `${baseURL}__site/owner/instance/`, () => true,
        { policy: 'require-corp', registry, config, baseURL });
      const response = await fetcher(url);
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      return { status: response.status, hash, length: bytes.byteLength };
    }, { url: assetURL, registry, config, baseURL: `${appOrigin}/` });
    assert.deepEqual(php, { status: 200, hash: registry.assets[0].sha256, length: pixel.length });
    assert.ok(relayRequests.length >= 1);
    assert.ok(relayRequests.every(request => request.url === '/v1/assets/fixture-v1/approved'
      && !request.headers.authorization && !request.headers.cookie));
    const count = relayRequests.length;
    const normal = await context.newPage(); await normal.goto(`${appOrigin}/?policy=credentialless`);
    assert.equal(await normal.evaluate(url => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = url; document.body.append(image); }), assetURL), true);
    assert.equal(relayRequests.length, count, 'Normal mode must make zero automatic relay requests.');
    relayAvailable = false;
    const unavailable = await page.evaluate(async () => ({ status: (await fetch('/__public-assets/fixture-v1/approved', { cache: 'no-store' })).status,
      isolated: crossOriginIsolated, shared: new SharedArrayBuffer(8).byteLength }));
    assert.deepEqual(unavailable, { status: 503, isolated: true, shared: 8 });
    assert.equal(errors.length, 0, errors.join('\n'));
    const evidence = { browser: name, version: browser.version(), isolated: true, blockedWithoutRelay: blocked, results,
      cssPixel: [255, 0, 0], php, normalModeRelayRequests: 0, relayFailure: unavailable, restrictedRequests: restrictedRequests.length };
    t.diagnostic(JSON.stringify(evidence));
    if (process.env.PUBLIC_ASSET_BROWSER_EVIDENCE) await writeFile(process.env.PUBLIC_ASSET_BROWSER_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await browser?.close(); await Promise.all([close(app), close(relay), close(restricted)]); await rm(temporary, { recursive: true, force: true });
  }
});
