import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createNetworkFixture, fixtureOrigin, writeOrigin, binaryHash } from './network-fixture.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, firefox };
const names = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');
for (const name of names) test(`${name}: direct CORS downloads and anonymous proxy fallback preserve bytes without user interaction`, { timeout: 90_000 }, async () => {
  assert.ok(engines[name], 'Select chromium and/or firefox.');
  const fixture = await createNetworkFixture({ directory });
  let browser;
  try {
    browser = await engines[name].launch({ headless: true, ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
    const context = await browser.newContext();
    await fixture.attach(context);
    const page = await context.newPage();
    await page.goto(new URL('__test__.html', fixture.url).href);
    const results = await page.evaluate(async ({ config, fixtureOrigin, writeOrigin }) => {
      const { createNetworkTransport } = await import('./src/network-transport.mjs');
      const transport = createNetworkTransport(fetch.bind(globalThis), config);
      const hash = async response => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const direct = await hash(await transport(`${fixtureOrigin}/direct/binary`));
      const requestedHeaders = { Cookie: 'php_session=exact-cookie', Origin: 'https://caller.example', Referer: 'https://caller.example/source' };
      const browserHeaders = await (await fetch(`${fixtureOrigin}/direct/headers`, { headers: requestedHeaders })).json();
      const deliveredHeaders = await (await transport(`${fixtureOrigin}/direct/headers`, { headers: requestedHeaders })).json();
      let denied = false;
      try { await fetch(`${fixtureOrigin}/denied/binary`); } catch { denied = true; }
      const fallback = await hash(await transport(`${fixtureOrigin}/denied/binary`));
      const upload = await transport(`${writeOrigin}/denied/echo`, { method: 'PATCH', body: new Uint8Array([0, 255, 65, 128]),
        headers: { Authorization: 'Bearer upstream-fixture', 'Content-Type': 'application/octet-stream', 'X-API-Key': 'custom' } });
      const form = new FormData(); form.append('name', 'Joomla');
      const requestUpload = await transport(new Request(`${writeOrigin}/denied/echo`, { method: 'POST', body: form }));
      const status = await transport(`${writeOrigin}/denied/status/500`);
      const post = await transport(`${fixtureOrigin}/denied/echo`, { method: 'POST', body: 'write once', headers: { 'Content-Type': 'text/plain' } });
      return { direct, browserHeaders, deliveredHeaders, denied, fallback, upload: [...new Uint8Array(await upload.arrayBuffer())],
        status: status.status, post: await post.text(), requestUpload: await requestUpload.text() };
    }, { config: fixture.config, fixtureOrigin, writeOrigin });
    assert.equal(results.direct, binaryHash);
    assert.equal(results.browserHeaders.cookie, null, 'Native browser Fetch must demonstrate the header delivery limitation.');
    assert.deepEqual(results.deliveredHeaders, { cookie: 'php_session=exact-cookie', origin: 'https://caller.example', referer: 'https://caller.example/source' });
    assert.equal(fixture.requests.filter(item => item.headers.cookie === 'php_session=exact-cookie').length, 1);
    assert.equal(results.denied, true, 'The browser must enforce CORS before fallback success is accepted.');
    assert.equal(results.fallback, binaryHash); assert.deepEqual(results.upload, [0, 255, 65, 128]);
    assert.equal(results.status, 500); assert.equal(results.post, 'write once');
    assert.match(results.requestUpload, /name="name"[\s\S]*Joomla/);
    assert.equal(fixture.requests.filter(item => item.method === 'POST' && item.body.toString() === 'write once').length, 1);
    const patch = fixture.requests.filter(item => item.method === 'PATCH');
    assert.equal(patch.length, 1); assert.equal(patch[0].headers.authorization, 'Bearer upstream-fixture');
    assert.equal(patch[0].headers['x-api-key'], 'custom'); assert.equal(patch[0].headers['x-playground-request'], undefined);
    assert.ok(fixture.relayRequests.every(item => item.method === 'OPTIONS' || new URL(item.path, fixture.relayOrigin).searchParams.has('url')));
    assert.equal(context.pages().length, 1, 'Downloads never open verification pages.');
  } finally { await browser?.close(); await fixture.close(); }
});
