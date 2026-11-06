import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupNetworkWorker, verifyDisabledRelay } from '../scripts/network-setup.mjs';

const accountId = 'a'.repeat(32);
const apiToken = 'test-api-token-must-never-be-published';
const secret = 'real-turnstile-secret-must-never-be-published';
const sitekey = '0x4AAAAAAAAAAAAAAAAAAAAA';
const hostname = 'playground.example.com';
const endpoint = 'https://joomengine-network.account-subdomain.workers.dev';
const widgetName = `joomengine-network / ${hostname} / network-setup-v1`;
const apiResult = result => Response.json({ success: true, result });
const absent = () => Response.json({ success: false, errors: [{ code: 10007, message: secret }] }, { status: 404 });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'network-setup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(new URL('../services/network-worker/wrangler.jsonc', import.meta.url), 'utf8'));
  const configFile = path.join(root, 'services/network-worker/wrangler.jsonc');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(path.join(root, 'CNAME'), hostname);
  const state = { bindings: null, activeBindings: null, widgets: [], widgetCreates: 0, deploys: 0,
    calls: [], temporary: null, fail: null, version: '00000000-0000-0000-0000-000000000001', changes: null };
  const fetcher = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    state.calls.push({ url: url.href, method: init.method || 'GET', headers: init.headers });
    if (state.fail) {
      const failure = await state.fail(url, init);
      if (failure) return failure;
    }
    if (url.origin === endpoint) {
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      assert.equal(new Headers(init.headers).has('Cookie'), false);
      if (url.pathname === '/healthz') return Response.json({ version: 1, enabled: false, mode: 'controlled-origins' });
      assert.ok(['/v1/session', '/v1/fetch'].includes(url.pathname));
      assert.equal(new Headers(init.headers).get('Origin'), `https://${hostname}`);
      return Response.json({ version: 1, error: { code: 'RELAY_DISABLED' } }, { status: 503 });
    }
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${apiToken}`);
    const route = url.pathname.slice(`/client/v4/accounts/${accountId}`.length);
    if (route === '/workers/subdomain') return apiResult({ subdomain: 'account-subdomain' });
    if (route.endsWith('/settings')) {
      state.changes?.();
      return state.bindings ? apiResult({ bindings: state.bindings }) : absent();
    }
    if (route.endsWith('/deployments')) return apiResult({ deployments: [{ versions: [{ version_id: state.version, percentage: 100 }] }] });
    if (route.includes('/versions/')) return apiResult({ resources: { bindings: state.activeBindings || state.bindings } });
    if (route === '/challenges/widgets') {
      if (init.method === 'POST') {
        state.widgetCreates++;
        const widget = { ...JSON.parse(init.body), sitekey, secret };
        state.widgets.push(widget);
        return apiResult(widget);
      }
      return apiResult(state.widgets.map(({ secret: _secret, ...widget }) => widget));
    }
    if (route === `/challenges/widgets/${sitekey}`) return apiResult(state.widgets.find(widget => widget.sitekey === sitekey));
    throw new Error(`Unexpected mocked route: ${route}`);
  };
  const deploy = async ({ configPath, secretsPath, temporary, accountId: selectedAccount, apiToken: selectedToken }) => {
    assert.equal(selectedAccount, accountId); assert.equal(selectedToken, apiToken);
    state.temporary = temporary;
    assert.equal((await stat(temporary)).mode & 0o777, 0o700);
    assert.equal((await stat(secretsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const uploaded = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(path.isAbsolute(uploaded.main), true);
    assert.deepEqual(uploaded.migrations, config.migrations);
    assert.deepEqual(JSON.parse(await readFile(secretsPath, 'utf8')), { TURNSTILE_SECRET_KEY: secret });
    assert.equal(JSON.stringify(uploaded).includes(secret), false);
    const selected = uploaded.env.production;
    assert.equal(selected.vars.ENABLED, 'false');
    assert.equal(selected.vars.TURNSTILE_TEST_MODE, 'false');
    assert.equal(selected.vars.RELAY_AUDIENCE, endpoint);
    assert.equal(selected.vars.ALLOWED_ORIGINS, JSON.stringify([`https://${hostname}`]));
    state.bindings = [...Object.entries(selected.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
      { name: 'RELAY_STATE', type: 'durable_object_namespace', class_name: 'RelayCoordinator', namespace_id: 'b'.repeat(32) },
      { name: 'TURNSTILE_SECRET_KEY', type: 'secret_text' }];
    state.activeBindings = null;
    state.deploys++;
  };
  return { root, config, configFile, state, fetcher, deploy, options: { root, accountId, apiToken, fetcher, deploy,
    healthOptions: { timeoutMs: 100, retryMs: 0 } } };
}

test('setup bootstraps disabled Worker/DO and real widget, writes only public candidates, and reruns reuse the widget/secret', async t => {
  const f = await fixture(t);
  const before = await readFile(f.configFile, 'utf8');
  const first = await setupNetworkWorker(f.options);
  assert.equal(first.workerCreated, true); assert.equal(first.widgetCreated, true);
  assert.equal(first.relayActivated, false); assert.equal(first.pagesChanged, false);
  assert.equal(first.upstreamPolicyReviewRequired, true);
  await assert.rejects(access(f.state.temporary));
  const output = path.join(f.root, 'test-results/network-setup');
  assert.deepEqual((await readdir(output)).sort(), ['network.production.candidate.json', 'setup-summary.json', 'worker-policy.candidate.json']);
  for (const filename of await readdir(output)) {
    const body = await readFile(path.join(output, filename), 'utf8');
    assert.equal(body.includes(secret), false); assert.equal(body.includes(apiToken), false);
  }
  const publicConfig = JSON.parse(await readFile(path.join(output, 'network.production.candidate.json')));
  assert.equal(publicConfig.enabled, false); assert.equal(publicConfig.endpoint, endpoint);
  assert.equal(publicConfig.turnstileSiteKey, sitekey);
  assert.deepEqual(publicConfig.proxyOrigins, []);
  assert.equal(await readFile(f.configFile, 'utf8'), before);
  assert.equal(await readFile(path.join(f.root, 'CNAME'), 'utf8'), hostname);
  const second = await setupNetworkWorker(f.options);
  assert.equal(second.workerCreated, false); assert.equal(second.widgetCreated, false);
  assert.equal(f.state.widgetCreates, 1); assert.equal(f.state.deploys, 2);
  assert.equal(f.state.calls.some(call => /rotate_secret|workers\/subdomain/.test(call.url) && call.method !== 'GET'), false);
});

test('setup refuses active, unrelated, changed-policy and extra-binding Workers before any mutation', async t => {
  for (const change of [bindings => bindings.find(binding => binding.name === 'ENABLED').text = 'true',
    bindings => bindings.find(binding => binding.name === 'PLAYGROUND_SETUP_OWNER').text = 'someone-else',
    bindings => bindings.find(binding => binding.name === 'UPSTREAM_ORIGINS').text = '["https://changed.example.com"]',
    bindings => bindings.push({ name: 'UNRELATED_SECRET', type: 'secret_text' }),
    bindings => bindings.find(binding => binding.name === 'RELAY_STATE').script_name = 'another-worker',
    bindings => bindings.find(binding => binding.name === 'RELAY_STATE').environment = 'another-environment',
    bindings => bindings.find(binding => binding.name === 'RELAY_STATE').dispatch_namespace = 'another-namespace']) {
    const f = await fixture(t);
    await setupNetworkWorker(f.options);
    change(f.state.bindings);
    const calls = f.state.calls.length;
    await assert.rejects(setupNetworkWorker(f.options), /Existing Worker/);
    assert.equal(f.state.deploys, 1);
    assert.ok(f.state.calls.slice(calls).every(call => call.method === 'GET'));
  }
});

test('disabled unpublished settings cannot hide an active live or gradual deployment', async t => {
  const f = await fixture(t);
  await setupNetworkWorker(f.options);
  f.state.activeBindings = structuredClone(f.state.bindings);
  f.state.activeBindings.find(binding => binding.name === 'ENABLED').text = 'true';
  await assert.rejects(setupNetworkWorker(f.options), /active or its state is unknown/);
  f.state.activeBindings = null;
  f.state.fail = url => url.pathname.endsWith('/deployments')
    ? apiResult({ deployments: [{ versions: [{ version_id: f.state.version, percentage: 50 }] }] }) : null;
  await assert.rejects(setupNetworkWorker(f.options), /gradual or unknown deployment/);
  assert.equal(f.state.deploys, 1);
});

test('a concurrent activation during widget setup stops before deployment and removes private temporary files', async t => {
  const f = await fixture(t);
  await setupNetworkWorker(f.options);
  let reads = 0;
  f.state.changes = () => {
    if (++reads === 2) f.state.bindings.find(binding => binding.name === 'ENABLED').text = 'true';
  };
  await assert.rejects(setupNetworkWorker(f.options), /active or its state is unknown/);
  assert.equal(f.state.deploys, 1);
});

test('a concurrent Durable Object namespace change cannot be overwritten even with the same version ID', async t => {
  const f = await fixture(t);
  await setupNetworkWorker(f.options);
  let reads = 0;
  f.state.changes = () => {
    if (++reads === 2) f.state.bindings.find(binding => binding.name === 'RELAY_STATE').namespace_id = 'c'.repeat(32);
  };
  await assert.rejects(setupNetworkWorker(f.options), /changed during setup/);
  assert.equal(f.state.deploys, 1);
});

test('generic 404, permission failures, malformed and oversized API replies never authorize creation or disclose payloads', async t => {
  for (const response of [() => Response.json({ success: false, errors: [{ code: 9999, message: secret }] }, { status: 404 }),
    () => Response.json({ success: false, errors: [{ code: 10000, message: apiToken }] }, { status: 403 }),
    () => new Response(secret), () => new Response('x'.repeat(1048577))]) {
    const f = await fixture(t);
    f.state.fail = url => url.pathname.endsWith('/settings') ? response() : null;
    await assert.rejects(setupNetworkWorker(f.options), error => {
      assert.equal(error.message.includes(secret), false); assert.equal(error.message.includes(apiToken), false);
      return /Cloudflare rejected|bounded JSON/.test(error.message);
    });
    assert.equal(f.state.widgetCreates, 0); assert.equal(f.state.deploys, 0);
  }
});

test('missing account subdomain gives an actionable failure without changing account configuration', async t => {
  const f = await fixture(t);
  f.state.fail = url => url.pathname.endsWith('/workers/subdomain') ? absent() : null;
  await assert.rejects(setupNetworkWorker(f.options), /Configure the account workers.dev subdomain/);
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.deploys, 0);
});

test('Turnstile permission failure is actionable, and duplicate or mismatched widgets are never changed', async t => {
  for (const kind of ['permission', 'duplicate', 'mismatch']) {
    const f = await fixture(t);
    const widget = { name: widgetName, mode: 'managed', domains: [hostname], clearance_level: 'no_clearance', sitekey, secret };
    if (kind === 'permission') f.state.fail = url => url.pathname.includes('/challenges/widgets')
      ? Response.json({ success: false, errors: [{ code: 10000, message: secret }] }, { status: 403 }) : null;
    if (kind === 'duplicate') f.state.widgets = [widget, widget];
    if (kind === 'mismatch') f.state.widgets = [{ ...widget, domains: ['other.example.com'] }];
    await assert.rejects(setupNetworkWorker(f.options), /Turnstile Sites Write|Multiple setup|does not match/);
    assert.equal(f.state.widgetCreates, 0); assert.equal(f.state.deploys, 0);
    assert.ok(f.state.calls.every(call => call.method === 'GET'));
  }
});

test('widget lookup reads subsequent pages before creating a new widget', async t => {
  const f = await fixture(t);
  const widget = { name: widgetName, mode: 'managed', domains: [hostname], clearance_level: 'no_clearance', sitekey, secret };
  f.state.widgets = [widget];
  f.state.fail = url => url.pathname.endsWith('/challenges/widgets') && url.searchParams.get('page') === '1'
    ? apiResult(Array.from({ length: 1000 }, (_, i) => ({ name: `other-${i}`, sitekey: `other-${i}` }))) : null;
  const result = await setupNetworkWorker(f.options);
  assert.equal(result.widgetCreated, false); assert.equal(f.state.widgetCreates, 0);
  assert.ok(f.state.calls.some(call => call.url.endsWith('page=2')));
});

test('Wrangler output cannot disclose credentials and failed deployment removes private files', async t => {
  const f = await fixture(t);
  const wrapper = path.join(f.root, 'services/network-worker/node_modules/wrangler/bin/wrangler.js');
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, `const fs = require('node:fs');
    const secretsPath = process.argv[process.argv.indexOf('--secrets-file') + 1];
    fs.writeFileSync(${JSON.stringify(path.join(f.root, 'last-secret-path.txt'))}, secretsPath);
    process.stdout.write(fs.readFileSync(secretsPath, 'utf8'));
    process.stderr.write(process.env.CLOUDFLARE_API_TOKEN);
    process.exit(1);`);
  await assert.rejects(setupNetworkWorker({ ...f.options, deploy: undefined }), error => {
    assert.match(error.message, /Wrangler deployment failed/);
    assert.equal(error.message.includes(secret), false); assert.equal(error.message.includes(apiToken), false);
    return true;
  });
  const secretsPath = await readFile(path.join(f.root, 'last-secret-path.txt'), 'utf8');
  await assert.rejects(access(path.dirname(secretsPath)));
  await assert.rejects(access(path.join(f.root, 'test-results/network-setup')));
});

test('disabled smoke rejects an enabled service or an operation that accepts requests', async () => {
  for (const kind of ['health', 'operation']) {
    await assert.rejects(verifyDisabledRelay(endpoint, `https://${hostname}`, { retryMs: 0, timeoutMs: 50,
      fetcher: async url => url.endsWith('/healthz')
        ? Response.json({ version: 1, enabled: kind === 'health', mode: 'controlled-origins' })
        : Response.json({ version: 1, accepted: true }) }), /disabled health\/rejection checks did not pass/);
  }
});

test('invalid input and accidental secret-bearing policy fail before account API calls', async t => {
  const f = await fixture(t);
  await assert.rejects(setupNetworkWorker({ ...f.options, accountId: '' }), /CLOUDFLARE_ACCOUNT_ID/);
  await assert.rejects(setupNetworkWorker({ ...f.options, apiToken: '' }), /CLOUDFLARE_API_TOKEN/);
  f.config.env.production.vars.TURNSTILE_SECRET_KEY = secret;
  await writeFile(f.configFile, JSON.stringify(f.config));
  await assert.rejects(setupNetworkWorker(f.options), /only the reviewed public policy/);
  assert.equal(f.state.calls.length, 0);
});
