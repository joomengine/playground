import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayWorker, encodeMetadata, decodeMetadata } from '../src/index.mjs';

const endpoint = 'https://proxy.example/';
function request(target, { method = 'GET', headers = [], body, ...options } = {}) {
  const url = new URL(endpoint); url.searchParams.set('url', target);
  return new Request(url, { method, body, headers: {
    'X-Playground-Request': encodeMetadata({ version: 1, headers, redirect: 'follow', ...options }),
  }, ...(body ? { duplex: 'half' } : {}) });
}
const metadata = response => decodeMetadata(response.headers.get('X-Playground-Response'));

test('anonymous requests preserve full target URLs and binary response bytes without a session or catalog', async () => {
  const bytes = Uint8Array.from([0, 255, 128, 1, 0, 254]);
  const target = 'https://arbitrary-download.example/archive.zip?a=one%26two&b=three%2Bfour';
  let received;
  const worker = createRelayWorker({ fetcher: async value => { received = value; return new Response(bytes, { headers: { 'Content-Type': 'application/zip' } }); } });
  const response = await worker.fetch(request(target));
  assert.equal(received.url, target);
  assert.equal(response.status, 200);
  assert.equal(metadata(response).url, target);
  assert.equal(metadata(response).status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('upstream errors retain status, headers and body as upstream results', async () => {
  const worker = createRelayWorker({ fetcher: async () => new Response('Upstream denied', { status: 403, statusText: 'Forbidden', headers: { 'X-Upstream': 'result' } }) });
  const response = await worker.fetch(request('https://api.example/error'));
  assert.equal(metadata(response).status, 403);
  assert.equal(new Headers(metadata(response).headers).get('X-Upstream'), 'result');
  assert.equal(await response.text(), 'Upstream denied');
});

test('plain HTTP callers receive upstream status and streaming bytes directly', async () => {
  const worker = createRelayWorker({ fetcher: async () => new Response('not found', { status: 404 }) });
  const response = await worker.fetch(new Request(`${endpoint}?url=${encodeURIComponent('https://target.example/missing')}`));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'not found');
});

test('arbitrary methods, custom headers and uploads reach the upstream once without grants', async () => {
  let calls = 0;
  const worker = createRelayWorker({ fetcher: async upstream => {
    calls++;
    assert.equal(upstream.method, 'PATCH');
    assert.equal(upstream.headers.get('Authorization'), 'Bearer upstream-key');
    assert.equal(upstream.headers.get('X-Api-Key'), 'custom-key');
    assert.equal(upstream.headers.get('X-Playground-Request'), null);
    assert.equal(await upstream.text(), 'patch bytes');
    return new Response(null, { status: 204 });
  } });
  const response = await worker.fetch(request('https://api.example/record', { method: 'PATCH', body: 'patch bytes', headers: [['Authorization', 'Bearer upstream-key'], ['X-Api-Key', 'custom-key']] }));
  assert.equal(metadata(response).status, 204);
  assert.equal(await response.text(), '');
  assert.equal(calls, 1);
});

test('redirects follow arbitrary hosts, honor caller limits and remove cross-origin credentials', async () => {
  const calls = [];
  const worker = createRelayWorker({ fetcher: async upstream => {
    calls.push(upstream);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://cdn.other.example/file?x=1&y=2' } }) : new Response('archive');
  } });
  const response = await worker.fetch(request('https://download.example/file', { headers: [['Authorization', 'Bearer token'], ['Cookie', 'key=value']] }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get('Authorization'), null);
  assert.equal(calls[1].headers.get('Cookie'), null);
  assert.equal(metadata(response).url, 'https://cdn.other.example/file?x=1&y=2');
  assert.equal(metadata(response).redirectCount, 1);
  assert.equal(await response.text(), 'archive');
  const redirecting = createRelayWorker({ fetcher: async () => new Response(null, { status: 302, headers: { Location: '/again' } }) });
  const limited = await redirecting.fetch(request('https://example.test/start', { maxRedirects: 0 }));
  assert.equal((await limited.json()).error.code, 'TOO_MANY_REDIRECTS');
});

test('manual redirects preserve original status and location without following', async () => {
  let calls = 0;
  const worker = createRelayWorker({ fetcher: async () => { calls++; return new Response(null, { status: 307, headers: { Location: '/next' } }); } });
  const response = await worker.fetch(request('https://download.example/start', { redirect: 'manual' }));
  assert.equal(metadata(response).status, 307);
  assert.equal(new Headers(metadata(response).headers).get('Location'), '/next');
  assert.equal(calls, 1);
});

test('307 repeats upload bytes; 303 changes the follow-up to GET', async () => {
  for (const redirectStatus of [307, 303]) {
    const calls = [];
    const worker = createRelayWorker({ fetcher: async upstream => {
      calls.push({ method: upstream.method, body: await upstream.text() });
      return calls.length === 1 ? new Response(null, { status: redirectStatus, headers: { Location: '/second' } }) : new Response('done');
    } });
    const response = await worker.fetch(request('https://upload.example/first', { method: 'POST', body: 'original upload', maxRedirects: 3 }));
    assert.equal(await response.text(), 'done');
    assert.deepEqual(calls, [{ method: 'POST', body: 'original upload' }, { method: redirectStatus === 303 ? 'GET' : 'POST', body: redirectStatus === 303 ? '' : 'original upload' }]);
  }
});

test('client cancellation and explicit timeouts reach the upstream signal', async () => {
  const fetcher = upstream => new Promise((resolve, reject) => {
    upstream.signal.addEventListener('abort', () => reject(upstream.signal.reason), { once: true });
  });
  const worker = createRelayWorker({ fetcher });
  const controller = new AbortController();
  const outgoing = request('https://slow.example/');
  const pending = worker.fetch(new Request(outgoing, { signal: controller.signal }));
  controller.abort();
  const cancelled = await pending;
  assert.equal((await cancelled.json()).error.code, 'REQUEST_ABORTED');
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const timedOut = await worker.fetch(request('https://slow.example/', { timeoutMs: 5 }));
    assert.equal((await timedOut.json()).error.code, 'UPSTREAM_TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

test('preflight and health require no state store or configured secrets', async () => {
  const worker = createRelayWorker({ fetcher: async () => { throw new Error('unexpected upstream'); } });
  const preflight = await worker.fetch(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://any-browser.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-playground-request' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'x-playground-request');
  const health = await worker.fetch(new Request(`${endpoint}healthz`));
  assert.deepEqual(await health.json(), { version: 1, mode: 'anonymous' });
});


test('default Fetch ceiling and PHP unlimited redirects preserve exact hop counts', async () => {
  for (const maxRedirects of [undefined, -1, 25]) {
    let calls = 0;
    const worker = createRelayWorker({ fetcher: async upstream => {
      assert.equal(upstream.redirect, 'manual');
      calls++;
      return calls <= 22 ? new Response(null, { status: 302, headers: { Location: '/hop-' + calls } }) : new Response('arrived');
    } });
    const response = await worker.fetch(request('https://download.example/start', { maxRedirects }));
    if (maxRedirects === undefined) {
      assert.equal((await response.json()).error.code, 'TOO_MANY_REDIRECTS');
      assert.equal(calls, 21);
    } else {
      assert.equal(await response.text(), 'arrived');
      assert.equal(metadata(response).redirectCount, 22);
      assert.equal(calls, 23);
    }
  }
});


test('explicit PHP headers retain Cloudflare Access, Origin, Referer and application headers', async () => {
  const intended = [
    ['CF-Access-Client-Id', 'access-client'], ['CF-Access-Client-Secret', 'access-secret'],
    ['Origin', 'https://caller.example'], ['Referer', 'https://caller.example/page'],
    ['X-Playground-Feature', 'extension-owned'],
  ];
  let received;
  const worker = createRelayWorker({ fetcher: async upstream => { received = upstream.headers; return new Response('ok'); } });
  const response = await worker.fetch(request('https://protected-api.example/', {
    headers: [...intended, ['Connection', 'X-Hop'], ['X-Hop', 'framing-only'], ['X-Playground-Response', 'internal-only']],
  }));
  assert.equal(await response.text(), 'ok');
  for (const [name, value] of intended) assert.equal(received.get(name), value, name);
  assert.equal(received.get('Connection'), null);
  assert.equal(received.get('X-Hop'), null);
  assert.equal(received.get('X-Playground-Response'), null);
});
