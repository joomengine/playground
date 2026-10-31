import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelay, allowedSource } from './server.mjs';

const origin = 'https://playground.joomengine.org';
const jcb = 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v6.2.1-alpha1.zip';
const nightly = 'https://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip';
const release = 'https://github.com/joomla/joomla-cms/releases/download/6.2.0/Joomla_6.2.0-Stable-Full_Package.zip';
const releaseCandidate = 'https://github.com/joomla/joomla-cms/releases/download/6.2.0-rc2/Joomla_6.2.0-rc2-Release_Candidate-Full_Package.zip';
const zip = () => new Response('PK12345', { headers: { 'content-type': 'application/zip', 'content-length': '7' } });

async function withRelay(options, run) {
  const server = createRelay(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const route = (base, source) => `${base}/fetch?url=${encodeURIComponent(source)}`;

test('source allowlist restricts upstream, repository, archive and release identities', () => {
  for (const source of [jcb, nightly, release, releaseCandidate]) assert.ok(allowedSource(source), source);
  for (const source of [
    'http://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip',
    'https://evil.example/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip',
    'https://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Update_Package.zip',
    'https://github.com/joomengine/other/archive/refs/tags/v6.2.0.zip',
    'https://github.com/joomla/joomla-cms/releases/download/6.2.0/Joomla_5.4.0-Stable-Full_Package.zip',
    `${release}?token=secret`, 'https://release-assets.githubusercontent.com/github-production-release-asset/1/test?sig=x',
    'https://github.com@127.0.0.1/joomla/joomla-cms',
  ]) assert.equal(allowedSource(source), null, source);
});

test('GET forwards an approved ZIP with CORS only for the configured origin', async () => {
  let called = 0;
  await withRelay({ fetchImpl: async () => { called++; return zip(); } }, async base => {
    const ok = await fetch(route(base, nightly), { headers: { Origin: origin } });
    assert.equal(ok.status, 200); assert.equal(await ok.text(), 'PK12345');
    assert.equal(ok.headers.get('access-control-allow-origin'), origin);
    assert.equal(ok.headers.get('vary'), 'Origin');
    assert.equal((await fetch(route(base, nightly), { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal(called, 1);
  });
});

test('only the original JCB tag may be followed to codeload', async () => {
  const calls = [];
  await withRelay({ fetchImpl: async url => { calls.push(url.toString()); return calls.length === 1
    ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/joomengine/pkg-component-builder/zip/refs/tags/v6.2.1-alpha1' } }) : zip(); } }, async base => {
    assert.equal((await fetch(route(base, jcb))).status, 200);
    assert.equal(calls.length, 2);
  });
  await withRelay({ fetchImpl: async () => new Response(null, { status: 302,
    headers: { location: 'https://codeload.github.com/joomengine/pkg-component-builder/zip/refs/tags/v5.2.0' } }) }, async base => {
    assert.equal((await fetch(route(base, jcb))).status, 502);
  });
});

test('redirect to an unapproved or private destination is never fetched', async () => {
  let calls = 0;
  await withRelay({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); } }, async base => {
    assert.equal((await fetch(route(base, release))).status, 502);
    assert.equal(calls, 1);
  });
});

test('signed GitHub release assets are allowed only as redirects from Joomla', async () => {
  let calls = 0;
  await withRelay({ fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 302,
    headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/12/abcdef?signature=test' } }) : zip() }, async base => {
    assert.equal((await fetch(route(base, release))).status, 200);
    assert.equal(calls, 2);
  });
});

test('validates method, query and preflight', async () => {
  await withRelay({ fetchImpl: async () => zip() }, async base => {
    assert.equal((await fetch(route(base, release), { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${route(base, release)}&url=${encodeURIComponent(release)}`)).status, 400);
    const opt = await fetch(`${base}/fetch`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    assert.equal(opt.status, 204); assert.equal(opt.headers.get('access-control-allow-origin'), origin);
    assert.equal((await fetch(`${base}/fetch`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })).status, 403);
  });
});

test('HEAD returns metadata without downloading a response body', async () => {
  let method;
  await withRelay({ fetchImpl: async (url, options) => { method = options.method; return new Response(null, { headers: { 'content-type': 'application/zip', 'content-length': '7' } }); } }, async base => {
    const response = await fetch(route(base, release), { method: 'HEAD' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '7'); assert.equal(method, 'HEAD');
  });
});

test('rejects errors, non-zip responses and declared oversize', async () => {
  for (const response of [new Response('missing', { status: 404 }), new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('zip', { headers: { 'content-type': 'application/zip', 'content-length': '100' } })]) {
    await withRelay({ fetchImpl: async () => response, maxBytes: 10 }, async base => assert.equal((await fetch(route(base, nightly))).status, 502));
  }
});

test('aborts an undeclared oversized stream', async () => {
  const body = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); c.close(); } });
  await withRelay({ maxBytes: 10, fetchImpl: async () => new Response(body(), { headers: { 'content-type': 'application/zip' } }) }, async base => {
    await assert.rejects(async () => { const response = await fetch(route(base, nightly)); await response.arrayBuffer(); });
  });
});
