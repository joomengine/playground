import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Public resources have no CORS/CORP headers; explicit data fetches still use CORS. */
export async function assertExternalAssets(page) {
  const nonce = randomUUID();
  const requests = [];
  const resources = {
    '/image.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="11"><path fill="#123456" d="M0 0h7v11H0z"/></svg>'],
    '/style.css': ['text/css', '#public-image { border-top: 3px solid rgb(18, 52, 86); }'],
    '/script.js': ['text/javascript', `window.publicAssetProof = ${JSON.stringify(nonce)};`],
    '/data.json': ['application/json', JSON.stringify({ nonce })],
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const resource = resources[pathname];
    if (!resource) { response.writeHead(404).end(); return; }
    requests.push({ path: pathname, credentialsReceived: Boolean(request.headers.cookie), mode: request.headers['sec-fetch-mode'] ?? null });
    response.setHeader('Content-Type', resource[0]);
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/data.json') response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(resource[1]);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookieName = `asset-proof-${nonce}`;
  const filename = `/persist/www/external-assets-${nonce}.php`;
  const frameId = `external-assets-${nonce}`;
  try {
    // Same-site, different-origin cookies would normally accompany these tags.
    await page.context().addCookies([{ name: cookieName, value: nonce, url: origin, sameSite: 'Lax' }]);
    const proofURL = await page.evaluate(async ({ origin, filename, frameId }) => {
      const source = `<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
$proof = $db->query('SELECT 6 * 7')->fetchColumn();
?><!doctype html><html lang="en"><head><meta charset="utf-8"><title>External assets</title>
<link rel="stylesheet" href="${origin}/style.css"><script src="${origin}/script.js"></script>
</head><body data-sql="<?= $proof ?>"><img id="public-image" src="${origin}/image.svg" alt="Public image"></body></html>`;
      await window.playground.fs.writeFile(filename, new TextEncoder().encode(source));
      const frame = document.createElement('iframe');
      frame.id = frameId;
      frame.src = new URL(filename.slice('/persist/www/'.length), window.playground.baseUrl).href;
      document.body.append(frame);
      return frame.src;
    }, { origin, filename, frameId });
    const frame = await (await page.locator(`#${frameId}`).elementHandle()).contentFrame();
    await frame.waitForURL(proofURL, { waitUntil: 'load' });
    await frame.waitForFunction(() => document.querySelector('#public-image')?.complete && window.publicAssetProof);
    const proof = await frame.evaluate(async origin => {
      const image = document.querySelector('#public-image');
      const response = await fetch(`${origin}/data.json`, { mode: 'cors', credentials: 'omit' });
      return {
        isolated: crossOriginIsolated,
        sharedMemory: typeof SharedArrayBuffer === 'function',
        image: [image.naturalWidth, image.naturalHeight],
        border: getComputedStyle(image).borderTopWidth,
        script: window.publicAssetProof,
        database: document.body.dataset.sql,
        fetch: await response.json(),
      };
    }, origin);
    assert.deepEqual(proof, {
      isolated: true, sharedMemory: true, image: [7, 11], border: '3px', script: nonce,
      database: '42', fetch: { nonce },
    }, 'Ordinary external assets and CORS data must load while native MariaDB remains available.');
    for (const pathname of ['/image.svg', '/style.css', '/script.js']) {
      const recorded = requests.filter(request => request.path === pathname);
      assert.equal(recorded.length, 1, `The browser must fetch ${pathname} directly from its original host.`);
      assert.equal(recorded[0].credentialsReceived, false, 'Credentialless public resource loading must omit cookies.');
      if (recorded[0].mode) assert.equal(recorded[0].mode, 'no-cors');
    }
    assert.equal(requests.filter(request => request.path === '/data.json').length, 1);
    return { publicImage: true, classicScript: true, stylesheet: true, corsFetch: true, credentialsOmitted: true, nativeDatabase: true };
  } finally {
    await page.locator(`#${frameId}`).evaluateAll(frames => frames.forEach(frame => frame.remove())).catch(() => {});
    await page.evaluate(filename => window.playground.fs.unlink(filename), filename).catch(() => {});
    await page.context().clearCookies({ name: cookieName });
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
