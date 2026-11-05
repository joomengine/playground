import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayWorker } from '../src/index.mjs';
import { readPolicy, validateDestination, encodeMetadata, decodeMetadata } from '../src/policy.mjs';
import { createTestEnvironment } from './helpers.mjs';

function fixture(options = {}) {
  const calls = []; const logs = [];
  let now = Date.now();
  const fetcher = async (input, init) => {
    const url = String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json(options.verification ?? { success: true, hostname: 'playground.example.com', action: 'network-session' });
    }
    calls.push({ url, ...init, headers: new Headers(init.headers), body: init.body ? await new Response(init.body).arrayBuffer() : null });
    return options.upstream ? options.upstream(input, init, calls.length) : new Response('response', { headers: { 'Content-Type': 'text/plain' } });
  };
  const env = createTestEnvironment({ fetcher, now: () => now, ...options });
  const worker = createRelayWorker({ now: () => now });
  const send = (path, { headers, ...init } = {}) => worker.fetch(new Request(`${env.RELAY_AUDIENCE}${path}`, {
    method: 'POST', headers: { Origin: 'https://playground.example.com', 'CF-Connecting-IP': '198.51.100.2', ...headers }, ...init,
  }), env);
  const session = async () => {
    const response = await send('/v1/session', { body: JSON.stringify({ version: 1, turnstileToken: 'approved' }) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const relay = (token, metadata = {}, init = {}) => send('/v1/fetch', {
    ...init, headers: { Authorization: `Bearer ${token}`, 'X-Playground-Request': encodeMetadata({
      version: 1, url: 'https://first.example.com/resource?x=1&x=2', method: 'GET', headers: [], redirect: 'follow', maxRedirects: 5, timeoutMs: 1000, ...metadata,
    }), ...init.headers },
  });
  return { calls, logs, env, send, session, relay, advance: milliseconds => { now += milliseconds; } };
}
async function errorCode(response) { return (await response.json()).error.code; }

test('health reports version and disabled state; no deployment configuration leaks', async () => {
  const worker = createRelayWorker();
  const response = await worker.fetch(new Request('https://relay.example.com/healthz'), { ENABLED: 'false' });
  assert.deepEqual(await response.json(), { version: 1, enabled: false, mode: 'controlled-origins' });
});
test('origin alone cannot relay; exact CORS and authenticated sessions are required', async () => {
  const f = fixture();
  const response = await f.relay('bad');
  assert.equal(response.status, 401); assert.equal(await errorCode(response), 'RELAY_SESSION_REQUIRED'); assert.equal(f.calls.length, 0);
  const forbidden = await f.send('/v1/fetch', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
  const preflight = await f.send('/v1/fetch', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,x-playground-request' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://playground.example.com');
});
test('verification requires success, the exact hostname and action', async () => {
  for (const verification of [{ success: false }, { success: true, hostname: 'evil.example.com', action: 'network-session' }, { success: true, hostname: 'playground.example.com', action: 'wrong' }]) {
    const f = fixture({ verification });
    const response = await f.send('/v1/session', { body: JSON.stringify({ version: 1, turnstileToken: 'bad' }) });
    assert.equal(await errorCode(response), 'VERIFICATION_FAILED');
  }
});
test('upstream HTTP errors and raw bytes remain upstream results; metadata cannot forge relay headers', async () => {
  for (const status of [200, 401, 403, 404, 429, 500]) {
    const bytes = Uint8Array.from([0, 255, 1, 128, 42]);
    const f = fixture({ upstream: () => new Response(bytes, { status, headers: { 'X-Playground-Response': 'forged', 'Set-Cookie': 'private=upstream', 'Content-Length': '5' } }) });
    const { token } = await f.session(); const response = await f.relay(token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
    const metadata = decodeMetadata(response.headers.get('x-playground-response'));
    assert.equal(metadata.status, status); assert.equal(metadata.url, 'https://first.example.com/resource?x=1&x=2');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(f.calls[0].headers.get('authorization'), null);
    assert.equal(f.calls[0].headers.get('origin'), null);
  }
});
test('public policy rejects private addresses, encoded IP forms, credentials, malformed URLs and unreviewed origins', () => {
  const policy = readPolicy(fixture().env);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://localhost/', 'https://first.example.com@evil.example.com/', 'https://u:p@first.example.com/', 'https://first.example.com./', 'https://first.example.com:8443/', 'https://first.example.com\\@evil.example.com/', 'https://evil.example.com/', 'file:///etc/passwd']) {
    assert.throws(() => validateDestination(url, policy, policy.audience), { code: 'DESTINATION_NOT_ALLOWED' }, url);
  }
});
test('redirects validate every destination and strip cross-origin credentials', async () => {
  const f = fixture({ credentialOrigins: ['https://first.example.com'], upstream: (_url, _init, call) => call === 1
    ? new Response(null, { status: 302, headers: { Location: 'https://second.example.com/final' } }) : new Response('done') });
  const { token } = await f.session();
  const response = await f.relay(token, { headers: [['Authorization', 'Bearer upstream'], ['Cookie', 'private=1']], forwardCredentials: true });
  assert.equal(await response.text(), 'done');
  assert.equal(f.calls[0].headers.get('authorization'), 'Bearer upstream');
  assert.equal(f.calls[1].headers.get('authorization'), null); assert.equal(f.calls[1].headers.get('cookie'), null);
  assert.equal(decodeMetadata(response.headers.get('x-playground-response')).redirectCount, 1);
  const denied = fixture({ upstream: () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/metadata' } }) });
  const s = await denied.session(); const bad = await denied.relay(s.token);
  assert.equal(await errorCode(bad), 'DESTINATION_NOT_ALLOWED'); assert.equal(denied.calls.length, 1);
});
test('credential forwarding requires both the client grant and server destination grant', async () => {
  for (const [credentialOrigins, forwardCredentials] of [[[], true], [['https://first.example.com'], false]]) {
    const f = fixture({ credentialOrigins }); const { token } = await f.session();
    const response = await f.relay(token, { headers: [['Authorization', 'Bearer upstream']], forwardCredentials });
    assert.equal(await errorCode(response), 'CREDENTIALS_NOT_ALLOWED'); assert.equal(f.calls.length, 0);
  }
});
test('HEAD, 204, 304, ranges and manual redirects preserve status and body rules', async () => {
  for (const status of [204, 304]) {
    const f = fixture({ upstream: () => new Response(null, { status }) }); const { token } = await f.session();
    const response = await f.relay(token); assert.equal(decodeMetadata(response.headers.get('x-playground-response')).status, status); assert.equal(await response.text(), '');
  }
  const f = fixture({ upstream: () => new Response(null, { status: 302, headers: { Location: 'https://second.example.com/next', 'Content-Length': '10' } }) });
  const { token } = await f.session(); const response = await f.relay(token, { method: 'HEAD', redirect: 'manual' });
  assert.equal(await response.text(), ''); assert.equal(decodeMetadata(response.headers.get('x-playground-response')).status, 302); assert.equal(f.calls.length, 1);
});
test('binary uploads preserve method and bytes without a second write after connection failure', async () => {
  const bytes = Uint8Array.from([255, 0, 127, 1]);
  const f = fixture({ upstream: () => { throw new TypeError('connection failed'); } }); const { token } = await f.session();
  const response = await f.relay(token, { method: 'PUT', headers: [['Content-Type', 'application/octet-stream']] }, { body: bytes });
  assert.equal(await errorCode(response), 'UPSTREAM_NETWORK_FAILED'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'PUT'); assert.deepEqual(new Uint8Array(f.calls[0].body), bytes);
});
test('response overflow and truncation fail the body instead of returning a successful truncated download', async () => {
  for (const options of [{ limits: { responseBytes: 2 }, upstream: () => new Response('four') }, { upstream: () => new Response('short', { headers: { 'Content-Length': '10' } }) }]) {
    const f = fixture(options); const { token } = await f.session(); const response = await f.relay(token);
    assert.equal(response.status, 200); await assert.rejects(response.arrayBuffer()); assert.equal(f.calls.length, 1);
  }
});
test('concurrent byte consumption cannot exceed session quota and renewal does not reset usage', async () => {
  const f = fixture({ limits: { sessionBytes: 8 }, upstream: () => new Response('12345') }); const { token } = await f.session();
  const responses = await Promise.all([f.relay(token), f.relay(token)]);
  const results = await Promise.allSettled(responses.map(response => response.arrayBuffer()));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  f.advance(61000);
  const renewal = await f.send('/v1/session', { headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ version: 1 }) });
  assert.equal(renewal.status, 200); assert.equal((await renewal.json()).token, token);
  const third = await f.relay(token); await assert.rejects(third.arrayBuffer());
  const sessions = [...f.env.testStorage.values].filter(([key]) => key.startsWith('session:'));
  assert.equal(sessions[0][1].bytes, 5);
});
test('expired, altered, policy-revoked, wrong-origin and individually revoked sessions fail', async () => {
  for (const kind of ['expired', 'altered', 'policy', 'origin', 'revoked']) {
    const f = fixture(); const session = await f.session(); let token = session.token;
    if (kind === 'expired') f.advance(1800001);
    if (kind === 'altered') token = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
    if (kind === 'policy') f.env.POLICY_VERSION = '2';
    if (kind === 'origin') { f.env.ALLOWED_ORIGINS = JSON.stringify(['https://playground.example.com', 'https://other.example.com']); }
    if (kind === 'revoked') f.env.REVOKED_SESSION_IDS = JSON.stringify([session.sessionId]);
    const response = await f.relay(token, {}, kind === 'origin' ? { headers: { Origin: 'https://other.example.com' } } : {});
    assert.equal(response.status, 401, kind); assert.equal(f.calls.length, 0);
  }
});
test('session issuance attempts and production test credentials are bounded', async () => {
  const f = fixture({ limits: { issuancePerHour: 1 } }); await f.session();
  const response = await f.send('/v1/session', { body: JSON.stringify({ version: 1, turnstileToken: 'approved' }) });
  assert.equal(response.status, 429); assert.ok(response.headers.has('retry-after'));
  assert.throws(() => readPolicy({ ...f.env, DEPLOYMENT_ENV: 'production', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }), { code: 'RELAY_CONFIGURATION_INVALID' });
});
test('malformed or oversized metadata and relay control headers fail closed', async () => {
  const f = fixture(); const { token } = await f.session();
  for (const value of ['_', 'x'.repeat(32769), encodeMetadata({ version: 2 })]) {
    const response = await f.send('/v1/fetch', { headers: { Authorization: `Bearer ${token}`, 'X-Playground-Request': value } });
    assert.equal(response.status, 400);
  }
  for (const header of ['X-Playground-Request', 'X-Relay-Dispatch', 'Host', 'CF-Connecting-IP', 'Origin', 'Proxy-Authorization']) {
    const response = await f.relay(token, { headers: [[header, 'injected']] }); assert.equal(await errorCode(response), 'HEADER_NOT_ALLOWED');
  }
  assert.equal(f.calls.length, 0);
});
