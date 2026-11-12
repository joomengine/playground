import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createNetworkTransport } from '../src/network-transport.mjs';
import { normalizeNetworkConfig, loadNetworkConfiguration } from '../src/network-config.mjs';
import { encodeNetworkMetadata, decodeNetworkMetadata, NETWORK_REQUEST_HEADER, NETWORK_RESPONSE_HEADER } from '../src/network-protocol.mjs';

const endpoint = 'https://proxy.example/';
const destination = 'https://downloads.example/package.zip?z=%2f&a=2&a=1&signature=a%2Bb';
const config = { endpoint };
function proxied(body = 'ok', values = {}) {
  return new Response(body, { headers: { [NETWORK_RESPONSE_HEADER]: encodeNetworkMetadata({
    version: 1, status: 200, statusText: 'OK', headers: [['Content-Type', 'application/octet-stream']],
    url: destination, redirected: false, redirectCount: 0, ...values,
  }) } });
}

test('configuration contains only an optional proxy endpoint', async () => {
  assert.deepEqual(normalizeNetworkConfig(), { endpoint: null });
  assert.deepEqual(normalizeNetworkConfig({ endpoint }), config);
  assert.deepEqual(await loadNetworkConfiguration('https://playground.example/base/', async input => {
    assert.equal(input.href, 'https://playground.example/base/config/network.json');
    return Response.json(config);
  }), config);
});

test('unavailable optional proxy configuration leaves direct networking available', async () => {
  for (const fetcher of [async () => new Response('missing', { status: 404 }), async () => { throw new TypeError('Offline'); }, async () => new Response('not JSON')]) {
    assert.deepEqual(await loadNetworkConfiguration('https://app.example/', fetcher), { endpoint: null });
  }
});

test('Request inputs preserve direct Fetch credentials, cache and method semantics', async () => {
  const input = new Request(destination, { credentials: 'include', cache: 'no-cache', headers: { 'X-Custom': 'yes' } });
  const transport = createNetworkTransport(async (request, init) => {
    assert.equal(request, input);
    const effective = new Request(request, init);
    assert.equal(effective.credentials, 'include'); assert.equal(effective.cache, 'no-cache'); assert.equal(effective.headers.get('x-custom'), 'yes');
    return new Response('direct');
  });
  assert.equal(await (await transport(input)).text(), 'direct');
});

test('direct Request uploads remain native requests and proxied Request uploads become portable bodies', async () => {
  for (const proxy of [false, true]) {
    const data = new FormData(); data.append('name', 'Joomla');
    const input = new Request(destination, { method: 'POST', body: data, credentials: 'include' });
    const transport = createNetworkTransport(async (request, init) => {
      if (!proxy) {
        assert.equal(request, input); assert.equal(init.body, undefined);
        assert.equal((await new Request(request, init).formData()).get('name'), 'Joomla');
        return new Response('saved');
      }
      assert.ok(init.body instanceof Blob, 'Proxy upload must work in browsers without request streams.');
      const headers = new Headers(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).headers);
      assert.equal((await new Response(init.body, { headers }).formData()).get('name'), 'Joomla');
      return proxied('saved');
    }, proxy ? config : {});
    assert.equal(await (await transport(input)).text(), 'saved');
  }
});

test('proxy uploads preserve Request payloads and multipart boundaries without Request.body support', async t => {
  // Older Firefox exposes Body methods but no Request.body stream.
  t.mock.getter(Request.prototype, 'body', () => null);
  for (const requestInput of [false, true]) {
    const data = new FormData(); data.append('name', 'Joomla');
    const transport = createNetworkTransport(async (_url, init) => {
      assert.ok(init.body instanceof Blob);
      const headers = new Headers(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).headers);
      assert.equal((await new Response(init.body, { headers }).formData()).get('name'), 'Joomla');
      return proxied('saved');
    }, config);
    const input = requestInput ? new Request(destination, { method: 'POST', body: data }) : destination;
    assert.equal(await (await transport(input, requestInput ? {} : { method: 'POST', body: data })).text(), 'saved');
  }
  const input = new Request(destination, { method: 'POST', body: 'original' });
  const transport = createNetworkTransport(async (_url, init) => {
    assert.equal(init.method, 'PATCH');
    assert.equal(await new Response(init.body).text(), 'replacement');
    return proxied('saved');
  }, config);
  await transport(input, { method: 'PATCH', body: 'replacement' });
});

test('proxy serialization rejects consumed Request bodies and cancels unfinished uploads', async () => {
  const used = new Request(destination, { method: 'POST', body: 'already consumed' });
  await used.text();
  const noDispatch = createNetworkTransport(() => assert.fail('Invalid or cancelled uploads must not be dispatched.'), config);
  await assert.rejects(noDispatch(used), TypeError);
  let cancelled = false;
  const streaming = new Request(destination, { method: 'POST', duplex: 'half', body: new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
  }) });
  await assert.rejects(noDispatch(streaming, { network: { timeoutMs: 15 } }), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(cancelled, true);
});

test('real Fetch enforces caller integrity on fallback and applies RequestInit overrides', async t => {
  const bytes = Buffer.from([0, 255, 128, 65]);
  const correct = `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
  const incorrect = `sha256-${Buffer.alloc(32).toString('base64')}`;
  const received = [];
  const server = createServer((request, response) => {
    received.push(request.url);
    if (request.url.startsWith('/proxy')) {
      response.setHeader(NETWORK_RESPONSE_HEADER, encodeNetworkMetadata({ version: 1, status: 200,
        statusText: 'OK', headers: [], url: destination, redirected: false, redirectCount: 0 }));
    }
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const direct = createNetworkTransport(fetch, { endpoint: `${origin}/proxy` });
  await assert.rejects(fetch(`${origin}/file`, { integrity: incorrect }), TypeError);
  await assert.rejects(direct(`${origin}/file`, { integrity: incorrect }), TypeError);
  assert.equal(received.filter(url => url.startsWith('/proxy')).length, 1,
    'An integrity failure on the direct response must not become successful through the proxy.');

  const fallback = createNetworkTransport((url, init) => {
    if (!new URL(url).pathname.startsWith('/proxy')) throw new TypeError('Browser CORS failure');
    return fetch(url, init);
  }, { endpoint: `${origin}/proxy` });
  for (const [requestIntegrity, override, succeeds] of [
    [incorrect, undefined, false], [correct, undefined, true],
    [incorrect, correct, true], [correct, incorrect, false], [incorrect, '', true],
  ]) {
    const request = new Request(`${origin}/file`, { integrity: requestIntegrity });
    const response = fallback(request, override === undefined ? {} : { integrity: override });
    if (succeeds) assert.deepEqual(Buffer.from(await (await response).arrayBuffer()), bytes);
    else await assert.rejects(response, TypeError);
  }
});

test('metadata preserves Unicode and large ordinary header values without an artificial quota', () => {
  const value = { version: 1, text: `Namibia 🦁 ${'x'.repeat(40000)}` };
  assert.deepEqual(decodeNetworkMetadata(encodeNetworkMetadata(value)), value);
  assert.throws(() => decodeNetworkMetadata('not json'), { code: 'RELAY_PROTOCOL_ERROR' });
});

test('public fallback uses v1 while custom credentials require the v2 redirect and no-store contract', async () => {
  for (const secret of [false, true]) {
    let calls = 0;
    const transport = createNetworkTransport(async (_url, init) => {
      if (++calls === 1) throw new TypeError('CORS');
      const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
      assert.equal(metadata.version, secret ? 2 : 1);
      if (secret) {
        assert.deepEqual(metadata.credentialHeaders, ['x-download-key']);
        assert.equal(metadata.cache, 'no-store'); assert.equal(init.cache, 'no-store');
      }
      return proxied('downloaded', { version: metadata.version });
    }, config);
    const init = secret ? { headers: { 'X-Download-Key': 'private' }, network: { credentialHeaders: ['X-Download-Key'] } } : {};
    assert.equal(await (await transport(destination, init)).text(), 'downloaded');
    assert.equal(calls, 2);
  }
});

test('direct custom-token redirects retain same-origin credentials and strip every declared secret on another origin', async () => {
  const requests = [];
  const transport = createNetworkTransport(async input => {
    const request = new Request(input); requests.push(request);
    if (requests.length === 1) return new Response(null, { status: 302, headers: { Location: '/next' } });
    if (requests.length === 2) return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/package.zip' } });
    return new Response('package');
  }, () => assert.fail('Exposed direct responses do not need the proxy.'));
  const response = await transport(destination, { headers: { 'PRIVATE-TOKEN': 'gitlab', 'X-Download-Key': 'custom', Accept: 'application/zip' },
    network: { credentialHeaders: ['X-Download-Key'] } });
  assert.equal(await response.text(), 'package'); assert.equal(response.redirected, true);
  assert.equal(response.networkRedirectCount, 2);
  for (const request of requests.slice(0, 2)) {
    assert.equal(request.headers.get('private-token'), 'gitlab'); assert.equal(request.headers.get('x-download-key'), 'custom');
    assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'manual');
  }
  assert.equal(requests[2].headers.has('private-token'), false); assert.equal(requests[2].headers.has('x-download-key'), false);
  assert.equal(requests[2].headers.get('accept'), 'application/zip');
});

test('successful direct requests and real HTTP errors never contact the proxy', async () => {
  for (const status of [200, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const transport = createNetworkTransport(async (url, init) => {
      calls++; assert.equal(url, destination); assert.equal(init.credentials, 'include');
      return new Response('upstream body', { status, headers: { 'X-Upstream': 'yes' } });
    }, config);
    const response = await transport(destination, { credentials: 'include' });
    assert.equal(response.status, status); assert.equal(await response.text(), 'upstream body');
    assert.equal(response.headers.get('x-upstream'), 'yes'); assert.equal(calls, 1);
  }
});

test('Node requests with explicit Cookie remain direct without browser header routing', async () => {
  let calls = 0;
  const transport = createNetworkTransport(async (url, init) => {
    calls++; assert.equal(url, destination); assert.equal(new Headers(init.headers).get('cookie'), 'php_session=value');
    return new Response('direct');
  }, config);
  assert.equal(await (await transport(destination, { headers: { Cookie: 'php_session=value' } })).text(), 'direct');
  assert.equal(calls, 1);
});

test('anonymous fallback preserves signed query, custom headers, status and binary bytes', async () => {
  const bytes = new Uint8Array([0, 255, 128, 1]);
  let calls = 0;
  const transport = createNetworkTransport(async (url, init) => {
    if (++calls === 1) throw new TypeError('CORS');
    assert.equal(new URL(url).searchParams.get('url'), destination);
    assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, undefined);
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.deepEqual(metadata.headers, [['authorization', 'Bearer upstream'], ['x-api-key', 'key']]);
    return proxied(bytes, { status: 206, statusText: 'Partial Content', headers: [['Content-Range', 'bytes 0-3/4']] });
  }, config);
  const response = await transport(destination, { headers: { Authorization: 'Bearer upstream', 'X-API-Key': 'key' } });
  assert.equal(response.status, 206); assert.equal(response.url, destination);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/4');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.equal(calls, 2);
});

test('opaque manual redirects use proxy without changing the original URL', async () => {
  let calls = 0;
  const transport = createNetworkTransport(async (_url, init) => {
    if (++calls === 1) return { status: 0, type: 'opaqueredirect', body: null };
    assert.equal(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).redirect, 'manual');
    return proxied(null, { status: 302, headers: [['Location', '/next']] });
  }, config);
  const response = await transport(destination, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/next');
});

test('cross-origin writes are sent once through proxy; same-origin writes remain direct', async () => {
  for (const [url, proxy] of [[destination, true], ['https://app.example/save', false]]) {
    let calls = 0;
    const transport = createNetworkTransport(async (input, init) => {
      calls++; assert.equal(new URL(input).origin, proxy ? new URL(endpoint).origin : 'https://app.example');
      assert.equal(init.method, 'PATCH'); assert.equal(init.body, 'write');
      throw new TypeError('Connection lost after sending');
    }, config, { contextOrigin: 'https://app.example' });
    await assert.rejects(transport(url, { method: 'PATCH', body: 'write' }));
    assert.equal(calls, 1);
  }
});

test('FormData uses its matching generated boundary and no upload-size policy', async () => {
  const data = new FormData(); data.append('name', 'Joomla');
  const transport = createNetworkTransport(async (_url, init) => {
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    const headers = new Headers(metadata.headers);
    const received = await new Response(init.body, { headers }).formData();
    assert.equal(received.get('name'), 'Joomla');
    return proxied('saved');
  }, config);
  assert.equal(await (await transport(destination, { method: 'POST', body: data })).text(), 'saved');
});

test('normal direct redirects keep Fetch follow; explicit redirect options reach the proxy when needed', async () => {
  let calls = 0;
  const direct = createNetworkTransport(async (_url, init) => {
    calls++; assert.equal(init.redirect, 'follow');
    return new Response('direct redirect result');
  }, config);
  assert.equal(await (await direct(destination, { network: { maxRedirects: 17 } })).text(), 'direct redirect result');
  assert.equal(calls, 1);
  calls = 0;
  const fallback = createNetworkTransport(async (_url, init) => {
    if (++calls === 1) throw new TypeError('CORS');
    assert.equal(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).maxRedirects, 17);
    return proxied('done');
  }, config);
  assert.equal(await (await fallback(destination, { network: { maxRedirects: 17 } })).text(), 'done');
});

test('native direct redirect mode stays manual while proxy follows the PHP request policy', async () => {
  let calls = 0;
  const direct = createNetworkTransport(async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: '/next' } });
  }, config);
  const response = await direct(destination, { redirect: 'manual', network: { redirect: 'follow', maxRedirects: 30 } });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/next'); assert.equal(calls, 1);
  calls = 0;
  const fallback = createNetworkTransport(async (_url, init) => {
    if (++calls === 1) { assert.equal(init.redirect, 'manual'); throw new TypeError('Fetch unavailable'); }
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(metadata.redirect, 'follow'); assert.equal(metadata.maxRedirects, 30);
    return proxied('followed');
  }, config);
  assert.equal(await (await fallback(destination, { redirect: 'manual', network: { redirect: 'follow', maxRedirects: 30 } })).text(), 'followed');
});

test('successful reads never load proxy configuration and stalled fallback configuration observes cancellation', async () => {
  const direct = createNetworkTransport(async () => new Response('direct'), () => assert.fail('Direct reads must not load proxy configuration.'));
  assert.equal(await (await direct(destination)).text(), 'direct');
  for (const write of [false, true]) {
    let calls = 0; let configCalls = 0;
    const transport = createNetworkTransport(async () => { calls++; throw new TypeError('CORS'); }, () => {
      configCalls++; return new Promise(() => {});
    });
    await assert.rejects(transport(destination, { ...(write ? { method: 'POST', body: 'once' } : {}), network: { timeoutMs: 10 } }), { code: 'UPSTREAM_TIMEOUT' });
    assert.equal(calls, write ? 0 : 1); assert.equal(configCalls, 1);
  }
  const controller = new AbortController();
  const transport = createNetworkTransport(async () => { throw new TypeError('CORS'); }, () => new Promise(() => {}));
  const pending = transport(destination, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: 'REQUEST_ABORTED' });
});

test('abort before dispatch and during Fetch never start a fallback', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createNetworkTransport(() => assert.fail('No dispatch'), config)(destination, { signal: controller.signal }), { code: 'REQUEST_ABORTED' });
  let calls = 0;
  const pending = createNetworkTransport(() => { calls++; return new Promise(() => {}); }, config);
  await assert.rejects(pending(destination, { network: { timeoutMs: 10 } }), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(calls, 1);
});

test('caller deadline covers streamed response body and cancellation reaches its reader', async () => {
  let cancelled = false;
  const transport = createNetworkTransport(async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
  })), config);
  const response = await transport(destination, { network: { timeoutMs: 15 } });
  await assert.rejects(response.arrayBuffer(), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(cancelled, true);
});

test('HEAD and empty statuses preserve headers and expose no body', async () => {
  for (const status of [200, 204, 304]) {
    let calls = 0;
    const transport = createNetworkTransport(async () => {
      if (++calls === 1) throw new TypeError('CORS');
      return proxied(null, { status, headers: [['Content-Length', '987']] });
    }, config);
    const response = await transport(destination, { method: 'HEAD' });
    assert.equal(response.status, status); assert.equal(response.headers.get('content-length'), '987');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});
