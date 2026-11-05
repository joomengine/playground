import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNetworkTransport } from '../src/network-transport.mjs';
import { createPhpFetch, NESTED_PHP_REQUEST_ERROR } from '../src/php-network.mjs';
import { normalizeNetworkConfig } from '../src/network-config.mjs';
import { encodeNetworkMetadata, decodeNetworkMetadata, NETWORK_REQUEST_HEADER, NETWORK_RESPONSE_HEADER } from '../src/network-protocol.mjs';

const endpoint = 'https://relay.example';
const destination = 'https://api.example';
const config = { schemaVersion: 1, enabled: true, endpoint, protocolVersion: 1 };
const session = { token: 'opaque-test-session', expiresAt: Date.now() + 600000 };
const options = { getSession: async () => session };
const response = (body = 'ok', extra = {}) => new Response(body, {
  headers: { [NETWORK_RESPONSE_HEADER]: encodeNetworkMetadata({ version: 1, status: 200, statusText: 'OK',
    headers: [['Content-Type', 'text/plain']], url: `${destination}/result`, redirected: false, ...extra }) },
});
const fails = code => error => { assert.equal(error.code, code); return true; };

test('network configuration is deployment-owned, exact, versioned and disabled by default', () => {
  assert.equal(normalizeNetworkConfig().enabled, false);
  for (const invalid of [
    { enabled: true }, { enabled: 'true' }, { protocolVersion: 2 }, { schemaVersion: 2 },
    { endpoint: 'http://relay.example' }, { endpoint: 'https://secret@relay.example' },
    { endpoint: `${endpoint}?relay=https://other.example` }, { proxyOrigins: [`${destination}/path`] },
    { credentialGrants: [{ relayOrigin: endpoint, destinationOrigin: '*' }] }, { maxRedirects: Infinity },
  ]) assert.throws(() => normalizeNetworkConfig(invalid));
  assert.throws(() => normalizeNetworkConfig({ ...config, endpoint: 'http://localhost:8787' }));
  assert.equal(normalizeNetworkConfig({ ...config, endpoint: 'http://localhost:8787' }, { allowInsecureLocalhost: true }).endpoint, 'http://localhost:8787');
  assert.throws(() => normalizeNetworkConfig({ ...config, endpoint: 'http://private.example:8787' }, { allowInsecureLocalhost: true }));
});

test('metadata is bounded UTF-8 base64url and rejects unsupported versions and malformed input', () => {
  const value = { version: 1, text: 'Namibia 🦁', url: `${destination}/?z=%2f&a=2&a=1` };
  assert.deepEqual(decodeNetworkMetadata(encodeNetworkMetadata(value)), value);
  for (const invalid of ['', '???', 'A'.repeat(32769), encodeNetworkMetadata({ version: 2 })]) assert.throws(() => decodeNetworkMetadata(invalid));
  assert.throws(() => encodeNetworkMetadata({ version: 1, text: 'x'.repeat(25000) }));
});

test('direct HTTP statuses never trigger session issuance or fallback and omit ambient credentials', async () => {
  for (const status of [200, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const transport = createNetworkTransport(async (url, init) => {
      calls++; assert.equal(url, destination); assert.equal(init.credentials, 'omit');
      return new Response('upstream', { status, headers: { 'X-Upstream': 'yes' } });
    }, config, { getSession() { assert.fail('Must not issue session for an HTTP response.'); } });
    const result = await transport(destination, { credentials: 'include' });
    assert.equal(result.status, status); assert.equal(result.headers.get('X-Upstream'), 'yes');
    assert.equal(await result.text(), 'upstream'); assert.equal(calls, 1);
  }
});

test('anonymous GET fallback preserves signed URL, upstream headers, binary body, status and effective URL', async () => {
  const url = `${destination}/download?z=%2f&a=2&a=1&signature=a%2Bb`;
  const seen = [];
  const bytes = Uint8Array.from([0, 255, 50, 128]);
  const transport = createNetworkTransport(async (input, init) => {
    seen.push([input, init]);
    if (seen.length === 1) throw new TypeError('Fetch failed');
    assert.equal(input, `${endpoint}/v1/fetch`);
    assert.equal(init.headers.Authorization, `Bearer ${session.token}`);
    const request = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(request.url, url); assert.equal(request.method, 'GET');
    assert.equal(request.headers.find(([name]) => name === 'range')[1], 'bytes=0-3');
    assert.equal(request.forwardCredentials, false);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return response(bytes, { status: 206, statusText: 'Partial Content', url,
      headers: [['Content-Type', 'application/zip'], ['Content-Range', 'bytes 0-3/4']] });
  }, config, options);
  const result = await transport(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(result.status, 206); assert.equal(result.url, url);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes); assert.equal(seen.length, 2);
});

test('opaque redirect follows the same eligible fallback path without changing the original URL', async () => {
  let calls = 0;
  const transport = createNetworkTransport(async () => {
    if (++calls === 1) return { status: 0, type: 'opaqueredirect', body: null };
    return response(null, { status: 302, statusText: 'Found', headers: [['Location', '/next']], redirectCount: 0 });
  }, config, options);
  const result = await transport(destination, { redirect: 'manual' });
  assert.equal(result.status, 302); assert.equal(result.headers.get('Location'), '/next');
  assert.equal(result.networkRedirectCount, 0); await result.arrayBuffer();
});

test('ambiguous writes, credentialed reads and explicitly non-replayable reads never retry', async () => {
  for (const init of [
    { method: 'POST', body: 'write' }, { method: 'PUT', body: 'write' }, { method: 'PATCH', body: 'write' },
    { method: 'DELETE' }, { headers: { Authorization: 'Bearer upstream-secret' } },
    { headers: { Cookie: 'private=value' } }, { headers: { 'X-API-Key': 'secret' } },
    { credentials: 'include' }, { network: { replayAllowed: false } },
  ]) {
    let writes = 0;
    const transport = createNetworkTransport(async () => { writes++; throw new TypeError('uncertain completion'); }, config, {
      getSession() { assert.fail('Never relay an uncertain write or ungranted credential.'); },
    });
    await assert.rejects(transport(destination, init), fails('DIRECT_NETWORK_FAILED'));
    assert.equal(writes, 1);
  }
});

test('origin policy chooses relay before a write; binary upload and upstream auth remain separate', async () => {
  let calls = 0;
  const bytes = Uint8Array.from([255, 0, 42]);
  const transport = createNetworkTransport(async (url, init) => {
    calls++; assert.equal(url, `${endpoint}/v1/fetch`);
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(metadata.method, 'POST'); assert.equal(metadata.forwardCredentials, true);
    assert.deepEqual(metadata.headers, [['authorization', 'Bearer upstream-secret'], ['content-type', 'application/octet-stream']]);
    assert.equal(init.headers.Authorization, `Bearer ${session.token}`);
    assert.deepEqual(init.body, bytes);
    return response(null, { status: 204, statusText: 'No Content' });
  }, { ...config, proxyOrigins: [destination], credentialGrants: [{ relayOrigin: endpoint, destinationOrigin: destination }] }, options);
  const result = await transport(destination, { method: 'POST', body: bytes,
    headers: { Authorization: 'Bearer upstream-secret', 'Content-Type': 'application/octet-stream' } });
  assert.equal(result.status, 204); assert.equal(await result.text(), ''); assert.equal(calls, 1);
});

test('multipart uploads preserve the generated boundary and exact binary file bytes', async () => {
  const form = new FormData(); form.set('label', 'sample'); form.set('file', new Blob([Uint8Array.from([0, 255, 128])]), 'sample.bin');
  const transport = createNetworkTransport(async (_url, init) => {
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    const reconstructed = new Response(init.body, { headers: metadata.headers });
    const decoded = await reconstructed.formData();
    assert.equal(decoded.get('label'), 'sample');
    assert.deepEqual(new Uint8Array(await decoded.get('file').arrayBuffer()), Uint8Array.from([0, 255, 128]));
    assert.equal(init.body instanceof ReadableStream, false);
    return response();
  }, { ...config, proxyOrigins: [destination] }, options);
  await (await transport(destination, { method: 'POST', body: form })).text();
});

test('credential forwarding cannot be enabled by request data, a different relay or a different origin', async () => {
  for (const credentialGrants of [[], [{ relayOrigin: 'https://other.example', destinationOrigin: destination }],
    [{ relayOrigin: endpoint, destinationOrigin: 'https://other.example' }]]) {
    const transport = createNetworkTransport(() => assert.fail('Denied credentials must not be sent.'),
      { ...config, proxyOrigins: [destination], credentialGrants }, options);
    await assert.rejects(transport(destination, { headers: { Authorization: 'secret' }, network: { forwardCredentials: true } }), fails('CREDENTIAL_FORWARDING_DENIED'));
  }
});

test('HTTPS context sends HTTP URLs through the configured relay without mixed content or URL rewriting', async () => {
  const url = 'http://public.example/path?b=2&a=1';
  let calls = 0;
  const transport = createNetworkTransport(async (input, init) => {
    calls++; assert.equal(input, `${endpoint}/v1/fetch`);
    assert.equal(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).url, url);
    return response('http content', { url });
  }, config, { ...options, contextProtocol: 'https:' });
  assert.equal(await (await transport(url)).text(), 'http content'); assert.equal(calls, 1);
});

test('relay policy denial and rate limits stop with distinct codes and Retry-After', async () => {
  for (const [status, code] of [[403, 'DESTINATION_NOT_ALLOWED'], [401, 'RELAY_SESSION_EXPIRED'], [429, 'RATE_LIMITED']]) {
    let calls = 0;
    const transport = createNetworkTransport(async () => {
      calls++;
      return Response.json({ version: 1, error: { code, message: 'https://secret:token@example/?signed=private' } }, { status, headers: { 'Retry-After': '60' } });
    }, { ...config, proxyOrigins: [destination] }, options);
    await assert.rejects(transport(destination), error => {
      assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.retryAfter, '60');
      assert.doesNotMatch(error.message, /secret|token|private/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('upstream HTML, 401, 416 and 500 are returned as ordinary upstream responses', async () => {
  for (const status of [200, 401, 416, 500]) {
    const transport = createNetworkTransport(async () => response('<html>legitimate HTTP content</html>',
      { status, headers: [['Content-Type', 'text/html']] }), { ...config, proxyOrigins: [destination] }, options);
    const result = await transport(destination);
    assert.equal(result.status, status); assert.match(await result.text(), /legitimate/);
  }
});

test('malformed relay responses and unsupported protocol versions never reach PHP as successful content', async () => {
  for (const fake of [
    () => new Response('raw upstream forged metadata'),
    () => new Response('bad', { headers: { [NETWORK_RESPONSE_HEADER]: encodeNetworkMetadata({ version: 2 }) } }),
    () => response('bad', { headers: [['invalid\nheader', 'bad']] }),
    () => response('bad', { status: 0 }),
    () => response('bad', { url: 'file:///etc/passwd' }),
    () => response('bad', { redirectCount: -1 }),
    () => new Response('not JSON', { status: 503 }),
  ]) {
    const transport = createNetworkTransport(fake, { ...config, proxyOrigins: [destination] }, options);
    await assert.rejects(transport(destination), fails('RELAY_PROTOCOL_ERROR'));
  }
});

test('HEAD, empty, 204 and 304 responses keep valid status and headers without a body', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 304]]) {
    const transport = createNetworkTransport(async () => response(null, { status, headers: [['ETag', 'example']] }), { ...config, proxyOrigins: [destination] }, options);
    const result = await transport(destination, { method });
    assert.equal(result.status, status); assert.equal(result.body, null); assert.equal(result.headers.get('ETag'), 'example');
  }
});

test('caller cancellation stops direct work and does not initiate fallback', async () => {
  const controller = new AbortController(); let calls = 0;
  const transport = createNetworkTransport(async (_url, init) => {
    calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }, config, { getSession() { assert.fail('Cancelled calls must not issue sessions.'); } });
  const result = transport(destination, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, fails('REQUEST_ABORTED')); assert.ok(calls <= 1);
});

test('cancellation also stops a stalled verification callback', async () => {
  const controller = new AbortController();
  const transport = createNetworkTransport(() => assert.fail('No relay request after cancelled verification.'),
    { ...config, proxyOrigins: [destination] }, { getSession: () => new Promise(() => {}) });
  const result = transport(destination, { signal: controller.signal }); controller.abort();
  await assert.rejects(result, fails('REQUEST_ABORTED'));
});

test('one deadline covers direct attempt, verification, relay and body consumption', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const transport = createNetworkTransport(async (_url, init) => {
    if (++calls === 1) { t.mock.timers.tick(60); throw new TypeError('direct failure'); }
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(metadata.timeoutMs, 40);
    return response(new ReadableStream({ start() {} }));
  }, config, { getSession: async () => ({ token: 'session', expiresAt: Date.now() + 100000 }) });
  const result = await transport(destination, { network: { timeoutMs: 100 } });
  const read = result.arrayBuffer(); t.mock.timers.tick(40);
  await assert.rejects(read, fails('UPSTREAM_TIMEOUT')); assert.equal(calls, 2);
});

test('failed delivered body is never retried or spliced with a second route', async () => {
  let calls = 0, reads = 0;
  const transport = createNetworkTransport(async () => {
    calls++;
    return new Response(new ReadableStream({ pull(controller) {
      if (++reads === 1) controller.enqueue(Uint8Array.of(1, 2));
      else controller.error(new Error('truncated'));
    } }));
  }, config, options);
  const result = await transport(destination);
  await assert.rejects(result.arrayBuffer(), fails('RESPONSE_INCOMPLETE')); assert.equal(calls, 1);
});

test('session expiry, missing session support and relay outage remain distinct failures', async () => {
  const forced = { ...config, proxyOrigins: [destination] };
  await assert.rejects(createNetworkTransport(() => assert.fail(), forced)(destination), fails('RELAY_SESSION_REQUIRED'));
  await assert.rejects(createNetworkTransport(() => assert.fail(), forced, { getSession: async () => ({ token: 'old', expiresAt: 1 }) })(destination), fails('RELAY_SESSION_EXPIRED'));
  await assert.rejects(createNetworkTransport(() => { throw new TypeError('failure'); }, forced, options)(destination), fails('RELAY_UNAVAILABLE'));
});

test('diagnostics disclose hostname and category only, never tokens, query strings or bodies', async () => {
  const diagnostics = [];
  const transport = createNetworkTransport(async () => response(), { ...config, proxyOrigins: [destination] },
    { ...options, onDiagnostic: item => diagnostics.push(item) });
  await (await transport(`${destination}/secret/path?token=confidential`)).text();
  assert.equal(diagnostics[0].hostname, 'api.example');
  assert.equal(diagnostics[0].route, 'relay');
  assert.doesNotMatch(JSON.stringify(diagnostics), /confidential|secret\/path|opaque-test-session/);
});

test('shared PHP transport retains recursion protection and accepts a non-JCB consumer unchanged', async () => {
  const site = 'https://playground.example/__site/a/b/';
  let calls = 0;
  const fetcher = createPhpFetch(async () => { calls++; return new Response('plain php'); }, site, () => true, {}, { config });
  await assert.rejects(fetcher(`${site}nested.php`), new RegExp(NESTED_PHP_REQUEST_ERROR));
  assert.equal(await (await fetcher(`${destination}/ordinary-script`)).text(), 'plain php'); assert.equal(calls, 1);
});

test('native logical redirects reach relay while direct Fetch keeps its explicit redirect mode', async () => {
  let calls = 0;
  const transport = createNetworkTransport(async (_url, init) => {
    if (++calls === 1) { assert.equal(init.redirect, 'manual'); throw new TypeError('CORS'); }
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(metadata.redirect, 'follow'); assert.equal(metadata.maxRedirects, 5);
    return response('followed', { redirected: true, redirectCount: 2 });
  }, config, options);
  const result = await transport(destination, { redirect: 'manual', network: { redirect: 'follow', maxRedirects: -1 } });
  assert.equal(result.redirected, true); assert.equal(result.networkRedirectCount, 2); await result.text();
});

test('a zero redirect limit is distinct from manual mode and larger limits respect relay policy', async () => {
  for (const [requested, expected] of [[0, 0], [3, 3], [20, 5]]) {
    const transport = createNetworkTransport(async (_url, init) => {
      const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
      assert.equal(metadata.maxRedirects, expected); assert.equal(metadata.redirect, 'follow');
      return response();
    }, { ...config, proxyOrigins: [destination] }, options);
    await (await transport(destination, { network: { maxRedirects: requested, redirect: 'follow' } })).text();
  }
});

test('unknown public config fields and nested secrets are rejected before bundling', () => {
  for (const invalid of [
    { ...config, SESSION_SIGNING_KEY: 'secret' }, { ...config, CLOUDFLARE_API_TOKEN: 'secret' },
    { ...config, credentialGrants: [{ relayOrigin: endpoint, destinationOrigin: destination, token: 'secret' }] },
  ]) assert.throws(() => normalizeNetworkConfig(invalid));
});

test('body failure diagnostics include byte count and a safe failure category', async () => {
  const diagnostics = []; let reads = 0;
  const transport = createNetworkTransport(async () => new Response(new ReadableStream({ pull(controller) {
    if (++reads === 1) controller.enqueue(Uint8Array.of(1, 2)); else controller.error(new Error('private upstream detail'));
  } })), config, { ...options, onDiagnostic: value => diagnostics.push(value) });
  await assert.rejects((await transport(destination)).arrayBuffer(), fails('RESPONSE_INCOMPLETE'));
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].bytes, 2);
  assert.equal(diagnostics[0].code, 'RESPONSE_INCOMPLETE');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private upstream detail/);
});

test('direct response type remains CORS and leaves native redirect accounting untouched', async () => {
  const original = new Response('decoded content', { headers: { 'Content-Length': '9' } });
  Object.defineProperties(original, { type: { value: 'cors' }, url: { value: destination }, redirected: { value: false } });
  const transport = createNetworkTransport(async () => original, config, options);
  const result = await transport(destination, { redirect: 'manual' });
  assert.equal(result.type, 'cors'); assert.equal(result.networkRedirectCount, undefined);
  assert.equal(await result.text(), 'decoded content');
});

test('native deadline aborts preserve timeout code 28 while caller cancellation stays code 42', async () => {
  for (const [reason, code, curlCode] of [[new DOMException('deadline', 'TimeoutError'), 'UPSTREAM_TIMEOUT', 28],
    [new DOMException('cancelled', 'AbortError'), 'REQUEST_ABORTED', 42]]) {
    const controller = new AbortController(); controller.abort(reason);
    const transport = createNetworkTransport(() => assert.fail('An aborted request must not dispatch.'), config, options);
    await assert.rejects(transport(destination, { signal: controller.signal }), error => {
      assert.equal(error.code, code); assert.equal(error.curlCode, curlCode); return true;
    });
  }
});

test('direct custom credentials cannot automatically follow redirects or trigger replay', async () => {
  for (const inputKind of ['url', 'request']) {
    for (const headers of [{ 'X-Api-Key': 'secret' }, { Authorization: 'Bearer secret' }, { Cookie: 'session=secret' }]) {
      let calls = 0;
      const transport = createNetworkTransport(async (_url, init) => {
        calls++; assert.equal(init.redirect, 'error');
        throw new TypeError('Fetch rejected upstream redirect');
      }, config, { getSession() { assert.fail('Credentialed redirect failure must not initiate relay delivery.'); } });
      const init = { headers, redirect: 'follow' };
      await assert.rejects(inputKind === 'request'
        ? transport(new Request(destination, init)) : transport(destination, init), fails('DIRECT_NETWORK_FAILED'));
      assert.equal(calls, 1);
    }
  }
});

test('direct credential redirect protection covers native manual Fetch with logical following', async () => {
  const transport = createNetworkTransport(async (_url, init) => {
    assert.equal(init.redirect, 'error');
    return new Response('authorized', { status: 200 });
  }, config, options);
  assert.equal(await (await transport(destination, { headers: { 'X-Api-Key': 'secret' },
    redirect: 'manual', network: { redirect: 'follow' } })).text(), 'authorized');
});

test('credentialed explicit manual requests keep redirects and upstream errors visible when Fetch permits', async () => {
  for (const status of [302, 401, 403, 500]) {
    const transport = createNetworkTransport(async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response('upstream', { status, headers: { Location: '/next' } });
    }, config, options);
    const result = await transport(destination, { headers: { 'X-Api-Key': 'secret' }, redirect: 'manual' });
    assert.equal(result.status, status); assert.equal(await result.text(), 'upstream');
  }
});

test('real direct HTTP redirect cannot leak a custom API key or repeat a write on a second origin', async t => {
  const received = [];
  async function server(handler) {
    const instance = createServer(handler);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => instance.close(resolve)));
    return `http://127.0.0.1:${instance.address().port}`;
  }
  const redirected = await server((request, reply) => {
    received.push({ origin: 'redirected', key: request.headers['x-api-key'] }); reply.end('must not arrive');
  });
  const original = await server(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ origin: 'original', key: request.headers['x-api-key'], method: request.method, body });
    reply.writeHead(307, { Location: `${redirected}/write` }); reply.end();
  });
  const transport = createNetworkTransport(fetch, { enabled: false });
  await assert.rejects(transport(`${original}/write`, {
    method: 'POST', body: 'one write', headers: { 'X-Api-Key': 'private-key' }, redirect: 'follow',
  }), fails('DIRECT_NETWORK_FAILED'));
  assert.deepEqual(received, [{ origin: 'original', key: 'private-key', method: 'POST', body: 'one write' }]);
});

test('relay status text permits HTTP Latin-1 and horizontal tabs but rejects control injection and Unicode outside byte range', async () => {
  for (const statusText of ['Créé', 'OK\tresponse', '', 'ÿ']) {
    const transport = createNetworkTransport(async () => response('body', { status: 201, statusText }),
      { ...config, proxyOrigins: [destination] }, options);
    const result = await transport(destination); assert.equal(result.statusText, statusText); await result.text();
  }
  for (const statusText of ['OK\r\nInjected: value', 'bad\x00value', 'bad\x1fvalue', 'bad\x7fvalue', '🦁']) {
    const transport = createNetworkTransport(async () => response('body', { statusText }),
      { ...config, proxyOrigins: [destination] }, options);
    await assert.rejects(transport(destination), { code: 'RELAY_PROTOCOL_ERROR' });
  }
});

test('HTTP contexts and Node callers attempt HTTP directly before eligible relay fallback', async () => {
  const url = 'http://public.example/path?b=2&a=1';
  for (const contextProtocol of ['http:', undefined]) {
    for (const directFails of [false, true]) {
      const calls = [];
      const transport = createNetworkTransport(async (input, init) => {
        calls.push(input);
        if (input === url) {
          if (directFails) throw new TypeError('Controlled CORS failure');
          return new Response('direct HTTP');
        }
        assert.equal(input, `${endpoint}/v1/fetch`);
        assert.equal(decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]).url, url);
        return response('relayed HTTP', { url });
      }, config, { ...options, contextProtocol });
      assert.equal(await (await transport(url)).text(), directFails ? 'relayed HTTP' : 'direct HTTP');
      assert.deepEqual(calls, directFails ? [url, `${endpoint}/v1/fetch`] : [url]);
    }
  }
});

test('forced HTTP origin routes before dispatch even in an HTTP development context', async () => {
  const origin = 'http://public.example';
  let calls = 0;
  const transport = createNetworkTransport(async (input, init) => {
    calls++; assert.equal(input, `${endpoint}/v1/fetch`);
    const metadata = decodeNetworkMetadata(init.headers[NETWORK_REQUEST_HEADER]);
    assert.equal(metadata.url, `${origin}/write`); assert.equal(metadata.method, 'POST');
    return response('written', { url: `${origin}/write` });
  }, { ...config, proxyOrigins: [origin] }, { ...options, contextProtocol: 'http:' });
  assert.equal(await (await transport(`${origin}/write`, { method: 'POST', body: 'one write' })).text(), 'written');
  assert.equal(calls, 1);
});
