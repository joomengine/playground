import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { prepareBrowserEnvironment } from './server.mjs';
import { createNetworkFixture, fixtureOrigin, writeOrigin, binaryHash } from './network-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const engines = { chromium, firefox };
const names = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');
assert.ok(names.length && names.every(name => engines[name]), 'Select chromium and/or firefox.');

async function probe(page, url, { method = 'GET', body = null, headers = [], follow = true } = {}) {
  return page.evaluate(async args => {
    const data = btoa(JSON.stringify(args));
    const source = `<?php
      $args = json_decode(base64_decode('${data}'), true, 512, JSON_THROW_ON_ERROR);
      $curl = curl_init($args['url']);
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
        CURLOPT_CUSTOMREQUEST => $args['method'], CURLOPT_FOLLOWLOCATION => $args['follow'],
        CURLOPT_HTTPHEADER => $args['headers']]);
      if ($args['method'] === 'HEAD') curl_setopt($curl, CURLOPT_NOBODY, true);
      if ($args['body'] !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, base64_decode($args['body']));
      $body = curl_exec($curl);
      $result = ['transport'=>'curl', 'status'=>curl_getinfo($curl,CURLINFO_RESPONSE_CODE),
        'effectiveURL'=>curl_getinfo($curl,CURLINFO_EFFECTIVE_URL),
        'errno'=>curl_errno($curl), 'error'=>curl_error($curl), 'length'=>$body === false ? null : strlen($body),
        'hash'=>$body === false ? null : hash('sha256',$body), 'failed'=>$body === false];
      curl_close($curl);
      echo json_encode($result, JSON_THROW_ON_ERROR);`;
    const response = await window.playground.runPhp(source);
    if (response.status !== 200) throw new Error(response.text);
    return JSON.parse(response.text);
  }, { url, method, body, headers, follow });
}

async function streamProbe(page, url) {
  return page.evaluate(async url => {
    const source = `<?php
      error_clear_last();
      $context = stream_context_create(['http'=>['timeout'=>20,'ignore_errors'=>true]]);
      $body = @file_get_contents(${JSON.stringify(url)}, false, $context);
      $status = 0; foreach ($http_response_header ?? [] as $header) {
        if (preg_match('~^HTTP/\\S+\\s+(\\d+)~', $header, $m)) $status = (int)$m[1];
      }
      echo json_encode(['transport'=>'stream','status'=>$status,'failed'=>$body===false,
        'length'=>$body===false?null:strlen($body),'hash'=>$body===false?null:hash('sha256',$body),
        'headers'=>$http_response_header ?? [],'error'=>$body===false?(error_get_last()['message'] ?? ''):'']);`;
    const response = await window.playground.runPhp(source);
    if (response.status !== 200) throw new Error(response.text);
    return JSON.parse(response.text);
  }, url);
}

for (const name of names) test(`${name}: actual PHP networking preserves binary bytes, status and safe write routing`, { timeout: 480_000 }, async () => {
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  const receipt = { browser: name, status: 'running', localFixtureOriginMapping: true, hostedTLSValidated: false, cases: [] };
  const output = path.join(root, 'test-results', `network-runtime-${name}.json`);
  const fixture = await createNetworkFixture({ directory });
  let browser, context;
  try {
    browser = await engines[name].launch({ headless: true,
      ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
    receipt.browserVersion = browser.version();
    context = await browser.newContext();
    await fixture.attach(context);
    const page = await context.newPage();
    await page.goto(new URL('__test__.html', fixture.url).href);
    await prepareBrowserEnvironment(page);
    await page.evaluate(async () => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.playground = await createPlayground({ persistence: false, phpVersion: '8.4',
        admin: { username: 'networktester', password: 'Network-fixture-2026!' } });
    });
    let before = fixture.relayRequests.length;
    const direct = await probe(page, `${fixtureOrigin}/direct/binary`);
    assert.equal(direct.hash, binaryHash); assert.equal(direct.status, 200); assert.equal(direct.errno, 0);
    assert.equal(fixture.relayRequests.length, before, 'A readable direct response must not contact the relay or request verification.');
    receipt.cases.push({ case: 'direct-no-relay', ...direct });

    const fallback = await probe(page, `${fixtureOrigin}/denied/binary`);
    assert.equal(fallback.hash, binaryHash); assert.equal(fallback.status, 200); assert.equal(fallback.errno, 0);
    assert.ok(fixture.relayRequests.length > before, 'Genuine browser CORS failure must use the actual Worker.');
    assert.equal(fallback.effectiveURL, `${fixtureOrigin}/denied/binary`);
    receipt.cases.push({ case: 'curl-fallback', ...fallback });
    const stream = await streamProbe(page, `${fixtureOrigin}/denied/binary`);
    assert.equal(stream.hash, binaryHash); assert.equal(stream.status, 200); assert.equal(stream.failed, false);
    receipt.cases.push({ case: 'stream-fallback', ...stream });
    for (const code of [401, 403, 404, 429, 500]) {
      before = fixture.relayRequests.length;
      const result = await probe(page, `${fixtureOrigin}/direct/status/${code}`);
      assert.equal(result.status, code); assert.equal(result.failed, false);
      assert.equal(fixture.relayRequests.length, before, `Upstream HTTP ${code} must remain a direct result.`);
      const relayed = await probe(page, `${writeOrigin}/denied/status/${code}`);
      assert.equal(relayed.status, code); assert.equal(relayed.failed, false);
      receipt.cases.push({ case: `status-${code}`, direct: result, relayed });
    }
    const head = await probe(page, `${writeOrigin}/denied/binary`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.length, 0);
    receipt.cases.push({ case: 'head', ...head });

    const payload = Buffer.from([0, 255, 10, 13, 128, 65, 0, 254]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const beforeWrites = fixture.requests.filter(item => item.method === method).length;
      const result = await probe(page, `${writeOrigin}/denied/echo`, { method, body: payload.toString('base64'),
        headers: ['Content-Type: application/octet-stream', 'Authorization: Bearer upstream-fixture'] });
      assert.equal(result.status, 200); assert.equal(result.length, payload.length);
      const received = fixture.requests.filter(item => item.method === method).slice(beforeWrites);
      assert.equal(received.length, 1, `${method} must dispatch once through its selected relay route.`);
      assert.deepEqual(received[0].body, payload);
      assert.equal(received[0].headers.authorization, 'Bearer upstream-fixture');
      assert.equal(received[0].headers['x-playground-request'], undefined);
      receipt.cases.push({ case: `binary-${method}`, ...result });
    }
    before = fixture.relayRequests.length;
    const beforeWrites = fixture.requests.filter(item => item.path === '/denied/echo' && item.method === 'POST').length;
    const ambiguous = await probe(page, `${fixtureOrigin}/denied/echo`, { method: 'POST', body: Buffer.from('write-once').toString('base64'),
      headers: ['Content-Type: text/plain'] });
    assert.equal(ambiguous.failed, true);
    assert.equal(fixture.relayRequests.length, before, 'An uncertain direct POST must not replay through the relay.');
    assert.equal(fixture.requests.filter(item => item.path === '/denied/echo' && item.method === 'POST').length - beforeWrites, 1);
    receipt.cases.push({ case: 'ambiguous-write-no-replay', ...ambiguous });

    const html = await probe(page, `${writeOrigin}/denied/html`);
    assert.equal(html.status, 200); assert.equal(html.failed, false);
    const forbidden = await probe(page, `${writeOrigin}/denied/forbidden-redirect`);
    assert.equal(forbidden.failed, true);
    fixture.setAvailable(false);
    const exhausted = await probe(page, `${fixtureOrigin}/denied/binary`);
    assert.equal(exhausted.failed, true); assert.ok(exhausted.error);
    const health = await page.evaluate(async () => (await window.playground.runPhp('<?php echo 6 * 7;')).text);
    assert.equal(health, '42', 'Network failure must leave PHP alive.');
    receipt.cases.push({ case: 'safe-failure', forbidden, exhausted, health });
    await page.evaluate(() => window.playground.close());
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = error.stack || error.message; throw error; }
  finally {
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    await context?.close(); await browser?.close(); await fixture.close();
  }
});
