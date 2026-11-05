import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createNetworkFixture, fixtureOrigin, writeOrigin, binaryHash } from './network-fixture.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, firefox };
const names = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');
for (const name of names) test(`${name}: browser CORS and actual Worker agree on raw binary protocol`, { timeout: 90_000 }, async () => {
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
      let session, exchanges = 0;
      const getSession = async ({ signal }) => {
        if (!session) {
          exchanges++;
          const response = await fetch(`${config.endpoint}/v1/session`, { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, turnstileToken: 'fixture' }) });
          if (!response.ok) throw new Error(await response.text());
          session = await response.json();
        }
        return session;
      };
      const transport = createNetworkTransport(fetch.bind(globalThis), config, { getSession, allowInsecureLocalhost: true });
      const hash = async response => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const direct = await hash(await transport(`${fixtureOrigin}/direct/binary`));
      const directExchanges = exchanges;
      let denied = false;
      try { await fetch(`${fixtureOrigin}/denied/binary`); } catch { denied = true; }
      const fallback = await hash(await transport(`${fixtureOrigin}/denied/binary`));
      const upload = await transport(`${writeOrigin}/denied/echo`, { method: 'PATCH', body: new Uint8Array([0, 255, 65, 128]),
        headers: { Authorization: 'Bearer upstream-fixture', 'Content-Type': 'application/octet-stream' } });
      const status = await transport(`${writeOrigin}/denied/status/500`);
      let failure;
      try { await transport(`${fixtureOrigin}/denied/echo`, { method: 'POST', body: 'write once', headers: { 'Content-Type': 'text/plain' } }); }
      catch (error) { failure = error.code; }
      return { direct, directExchanges, denied, fallback, upload: [...new Uint8Array(await upload.arrayBuffer())],
        status: status.status, failure, exchanges };
    }, { config: fixture.config, fixtureOrigin, writeOrigin });
    assert.equal(results.direct, binaryHash); assert.equal(results.directExchanges, 0);
    assert.equal(results.denied, true, 'The browser must enforce CORS before relay success is accepted.');
    assert.equal(results.fallback, binaryHash); assert.deepEqual(results.upload, [0, 255, 65, 128]);
    assert.equal(results.status, 500); assert.equal(results.failure, 'DIRECT_NETWORK_FAILED'); assert.equal(results.exchanges, 1);
    const writes = fixture.requests.filter(item => item.method === 'POST' && item.path === '/denied/echo');
    assert.equal(writes.length, 1, 'The uncertain direct write must not replay.');
    const patch = fixture.requests.filter(item => item.method === 'PATCH');
    assert.equal(patch.length, 1); assert.equal(patch[0].headers.authorization, 'Bearer upstream-fixture');
    assert.equal(patch[0].headers['x-playground-request'], undefined);
  } catch (error) { console.error(error.stack || error); throw error; }
  finally { await browser?.close(); await fixture.close(); }
});
