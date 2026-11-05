import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { assertJcbCompiler } from './jcb-compiler-contract.mjs';
import { assertLiveNetworkApi, assertLivePowerClient, assertLiveFieldImport } from './jcb-network-contract.mjs';

const required = name => {
  assert.ok(process.env[name], `${name} is required; missing hosted access is not a successful test.`);
  return process.env[name];
};

test('deployed staging relay completes actual PHP and clean JCB workflows over verified HTTPS', { timeout: 1_200_000 }, async () => {
  const appURL = new URL(required('NETWORK_PLAYGROUND_URL'));
  const endpoint = new URL(required('NETWORK_ENDPOINT'));
  const target = new URL(required('NETWORK_TEST_TARGET'));
  const expectedHash = required('NETWORK_EXPECTED_SHA256');
  const sourceCommit = required('GITHUB_SHA');
  const stagingSecret = required('NETWORK_STAGING_TEST_SECRET');
  assert.ok(stagingSecret.length >= 32 && stagingSecret.length <= 256, 'A separate protected staging test credential is required.');
  for (const url of [appURL, endpoint, target]) {
    assert.equal(url.protocol, 'https:', 'Hosted acceptance requires real HTTPS.');
    assert.equal(url.username + url.password, '', 'Hosted test URLs must not contain credentials.');
  }
  assert.equal(target.search + target.hash, '', 'Use an unsigned controlled test target; receipts must not contain signed query credentials.');
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  appURL.searchParams.set('start', '0');
  const receipt = { status: 'running', sourceCommit, endpoint: endpoint.origin, appOrigin: appURL.origin, hostedTLSValidated: true, cases: [] };
  await mkdir('test-results', { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    receipt.browserVersion = browser.version();
    const context = await browser.newContext(); // Never ignore certificate errors or disable CORS.
    const sessionURL = new URL('/v1/session', endpoint).href;
    // This secret remains in the trusted Node test process. It is injected only
    // into the exact HTTPS verification exchange, never into page JS or an
    // upstream request. The client uses redirect:error for this operation.
    await context.route(sessionURL, async route => {
      if (route.request().url() !== sessionURL || route.request().method() !== 'POST') return route.continue();
      await route.continue({ headers: { ...route.request().headers(), 'x-playground-staging-test': stagingSecret } });
    });
    for (const value of [null, 'incorrect-staging-test-credential']) {
      const response = await fetch(sessionURL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Origin: appURL.origin, 'Content-Type': 'application/json', ...(value ? { 'X-Playground-Staging-Test': value } : {}) },
        body: JSON.stringify({ version: 1, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
      });
      assert.equal(response.status, 403, 'Public test keys must not authorize an unprotected staging caller.');
      await response.arrayBuffer();
    }
    receipt.unprotectedTestSessionsRejected = true;
    const page = await context.newPage();
    await page.goto(appURL.href, { waitUntil: 'domcontentloaded' });
    // Exercise the real entry point and service-worker-controlled navigation.
    await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 60000 });
    const metadata = await page.evaluate(async () => {
      const base = new URL('./', location.href);
      const [manifest, network] = await Promise.all(['assets/manifest.json', 'config/network.json'].map(async path => {
        const response = await fetch(new URL(path, base), { cache: 'no-store' });
        if (!response.ok) throw new Error(`Missing hosted ${path}`);
        return response.json();
      }));
      return { manifest, network };
    });
    assert.equal(metadata.manifest.sourceCommit, sourceCommit, 'The hosted candidate must match the current commit.');
    assert.equal(metadata.manifest.deployment.environment, 'staging');
    assert.equal(metadata.network.endpoint.replace(/\/+$/, ''), endpoint.origin);
    assert.equal(metadata.network.enabled, true);
    assert.equal(metadata.network.turnstileSiteKey, '1x00000000000000000000AA', 'Staging uses the official always-pass browser test key.');
    const blocked = await page.evaluate(async target => {
      try { await fetch(target, { mode: 'cors', credentials: 'omit' }); return false; } catch { return true; }
    }, target.href);
    assert.equal(blocked, true, 'The controlled target must actually deny direct browser access.');
    for (const major of ['5', '6']) {
      const joomlaVersion = metadata.manifest.joomla.find(entry => entry.version.startsWith(`${major}.`))?.version;
      assert.ok(joomlaVersion, `Candidate must include Joomla ${major}.`);
      await page.evaluate(async joomlaVersion => {
        const { parseCatalog } = await import('./src/config.mjs');
        const { loadDeployCatalog, resolveDeployConfiguration } = await import('./src/deploys.mjs');
        const { createPlayground } = await import('./src/playground.mjs');
        const manifestURL = new URL('./assets/manifest.json', location.href);
        const catalog = parseCatalog(await (await fetch(manifestURL)).json(), { baseURL: manifestURL.href });
        const { configuration } = await resolveDeployConfiguration({ deployId: 'jcb', joomlaVersion, phpVersion: '8.4',
          persistence: false, storageKey: `hosted-${crypto.randomUUID()}`, admin: { username: 'networktester', password: `Hosted-${crypto.randomUUID()}!` } },
        { catalog, deployCatalog: await loadDeployCatalog(), baseURL: location.href });
        window.playground = await createPlayground(configuration);
      }, joomlaVersion);
      const click = page.getByRole('button', { name: 'Verify network access', exact: true }).waitFor({ state: 'visible', timeout: 90000 })
        .then(() => page.getByRole('button', { name: 'Verify network access', exact: true }).click());
      click.catch(() => {});
      const native = await page.evaluate(async target => {
        const source = `<?php $url=${JSON.stringify(target)}; $c=curl_init($url); curl_setopt_array($c,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>90]);
          $a=curl_exec($c); $status=curl_getinfo($c,CURLINFO_RESPONSE_CODE); $error=curl_error($c); curl_close($c);
          $b=file_get_contents($url); echo json_encode(['curl'=>$a===false?false:hash('sha256',$a),'stream'=>$b===false?false:hash('sha256',$b),'status'=>$status,'error'=>$error]);`;
        const response = await window.playground.runPhp(source);
        if(response.status !== 200) throw new Error(response.text); return JSON.parse(response.text);
      }, target.href);
      await click;
      assert.equal(native.curl, expectedHash); assert.equal(native.stream, expectedHash); assert.equal(native.status, 200); assert.equal(native.error, '');
      const discovery = await assertLiveNetworkApi(page);
      const power = await assertLivePowerClient(page);
      const compiler = await assertJcbCompiler(page);
      const entity = await assertLiveFieldImport(page);
      receipt.cases.push({ joomlaVersion, native, discovery, power, compiler, entity });
      await page.evaluate(() => window.playground.close());
    }
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = error.stack || error.message; throw error; }
  finally { await browser?.close(); await writeFile('test-results/network-hosted.json', `${JSON.stringify(receipt, null, 2)}\n`); }
});
