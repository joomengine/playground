import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkSession, createNetworkSessionClient, createNetworkSessionHost, isLocalNetworkDevelopment,
  loadNetworkConfiguration, networkDiagnosticText } from '../src/network-session.mjs';

const config = { enabled: true, endpoint: 'https://relay.example/network', turnstileSiteKey: 'public-site-key' };
const token = 'opaque-session-token-1234567890';
const respond = expiresAt => Response.json({ version: 1, token, expiresAt });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('session creation is lazy, concurrent callers share verification, and only public verification is exchanged', async () => {
  let verification = 0, calls = 0, verified;
  const now = 100_000;
  const session = createNetworkSession(config, {
    now: () => now,
    verify: () => { verification++; return new Promise(resolve => { verified = resolve; }); },
    fetcher: async (input, options) => {
      calls++;
      assert.equal(String(input), 'https://relay.example/network/v1/session');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { version: 1, turnstileToken: 'one-use-challenge' });
      assert.equal(options.headers.Authorization, undefined);
      return respond(now + 1_800_000);
    },
  });
  assert.equal(verification, 0);
  const first = session.getSession(), second = session.getSession();
  assert.equal(verification, 1);
  verified('one-use-challenge');
  assert.deepEqual(await first, { token, expiresAt: now + 1_800_000 });
  assert.deepEqual(await second, await session.getSession());
  assert.equal(calls, 1);
  session.dispose();
  await assert.rejects(session.getSession(), { code: 'REQUEST_ABORTED' });
});

test('cancelling one waiter does not cancel another waiting for the shared verification', async () => {
  let verified, verificationSignal;
  const firstController = new AbortController();
  const session = createNetworkSession(config, {
    verify: ({ signal }) => { verificationSignal = signal; return new Promise(resolve => { verified = resolve; }); },
    fetcher: async () => respond(Date.now() + 1_800_000),
  });
  const first = session.getSession({ signal: firstController.signal });
  const second = session.getSession();
  firstController.abort();
  await assert.rejects(first, { code: 'REQUEST_ABORTED' });
  assert.equal(verificationSignal.aborted, false);
  verified('one-use-challenge');
  assert.equal((await second).token, token);
  session.dispose();
});

test('renewal presents the same session and does not obtain a fresh challenge or reset identity', async () => {
  let now = 100_000, verification = 0;
  const requests = [];
  const session = createNetworkSession(config, {
    now: () => now, verify: async () => { verification++; return 'challenge'; },
    fetcher: async (_url, options) => { requests.push(options); return respond(now + 1_800_000); },
  });
  await session.getSession();
  now += 1_750_000;
  await session.getSession();
  assert.equal(verification, 1);
  assert.equal(requests[1].headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(requests[1].body), { version: 1 });
  now += 1_800_001;
  await assert.rejects(session.getSession(), { code: 'RELAY_SESSION_EXPIRED' });
  assert.equal(requests.length, 2, 'expiry must not silently request a new usage budget');
  session.dispose();
});

test('invalid protocol, oversized session data and server denials fail without retries', async () => {
  for (const reply of [Response.json({ version: 2, token, expiresAt: Date.now() + 100_000 }),
    new Response('x'.repeat(20_000)), Response.json({ version: 1, error: { code: 'RATE_LIMITED' } }, { status: 429 })]) {
    let calls = 0;
    const session = createNetworkSession(config, { verify: async () => 'challenge', fetcher: async () => { calls++; return reply; } });
    await assert.rejects(session.getSession(), error => ['RELAY_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code));
    assert.equal(calls, 1);
    session.dispose();
  }
});

test('worker-to-shell verification travels outside the PHP operation queue and cancellation reaches the shell', async () => {
  let client, host, receivedSignal;
  const pending = new Promise(() => {});
  host = createNetworkSessionHost({ getSession: async ({ signal }) => { receivedSignal = signal; return pending; } }, message => client.receive(message));
  client = createNetworkSessionClient(message => host.receive(message));
  const controller = new AbortController();
  const request = client.getSession({ signal: controller.signal });
  await tick();
  assert.ok(receivedSignal);
  controller.abort();
  await assert.rejects(request, { code: 'REQUEST_ABORTED' });
  assert.equal(receivedSignal.aborted, true);
  host.dispose(); client.dispose();
});

test('disposing a worker session client cancels each host verification exactly once and prevents new work', async () => {
  const signals = [], outbound = [];
  let client;
  const host = createNetworkSessionHost({ getSession: ({ signal }) => {
    signals.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }, message => client.receive(message));
  client = createNetworkSessionClient(message => { outbound.push(message); host.receive(message); });
  const requests = [client.getSession(), client.getSession()];
  const settled = Promise.all(requests.map(request => assert.rejects(request, { code: 'REQUEST_ABORTED' })));
  await tick();
  assert.equal(signals.length, 2);
  client.dispose();
  await settled;
  assert.ok(signals.every(signal => signal.aborted));
  const cancellations = outbound.filter(message => message.type === 'network-session-cancel');
  assert.equal(cancellations.length, 2);
  assert.equal(new Set(cancellations.map(message => message.id)).size, 2);
  client.dispose();
  await assert.rejects(client.getSession(), { code: 'REQUEST_ABORTED' });
  assert.equal(outbound.length, 4, 'Disposal must not send duplicate cancellation or start another request.');
  host.dispose();
});

test('worker RPC validates returned sessions and ignores stale reply IDs', async () => {
  const outbound = [];
  const client = createNetworkSessionClient(message => outbound.push(message));
  const pending = client.getSession();
  assert.equal(client.receive({ type: 'database-result' }), false);
  assert.equal(client.receive({ type: 'network-session-result', id: 'unknown', value: { token } }), true);
  client.receive({ type: 'network-session-result', id: outbound[0].id, value: { token, expiresAt: Date.now() + 1_800_000 } });
  assert.equal((await pending).token, token);
  client.dispose();
});

test('configuration comes from the fixed deployment path and permits HTTP only on a loopback development host', async () => {
  const config = await loadNetworkConfiguration('http://127.0.0.1:8080/playground/', async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:8080/playground/config/network.json');
    assert.equal(options.credentials, 'omit');
    return Response.json({ schemaVersion: 1, enabled: true, endpoint: 'http://127.0.0.1:8787', turnstileSiteKey: 'test-key' });
  });
  assert.equal(config.endpoint, 'http://127.0.0.1:8787');
  assert.equal(isLocalNetworkDevelopment('http://localhost:8080'), true);
  assert.equal(isLocalNetworkDevelopment('https://localhost:8080'), false);
  assert.equal(isLocalNetworkDevelopment('http://localhost.example'), false);
  await assert.rejects(loadNetworkConfiguration('https://playground.example/', async () => Response.json({ enabled: true, endpoint: 'http://127.0.0.1:8787' })), /HTTPS/);
});

test('diagnostics cannot disclose tokens, query strings, bodies or arbitrary relay errors', () => {
  assert.equal(networkDiagnosticText({ code: 'DIRECT_NETWORK_FAILED', route: 'direct', method: 'GET', hostname: 'api.example',
    url: 'https://api.example/?token=secret', token: 'secret', body: 'secret', error: 'secret', durationMs: 5 }),
  'code: DIRECT_NETWORK_FAILED\nroute: direct\nmethod: GET\nhostname: api.example\ndurationMs: 5');
  assert.equal(networkDiagnosticText({ hostname: 'api.example?secret=value', code: '<script>secret</script>' }), '');
});
