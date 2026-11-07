import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { prepareBrowserEnvironment } from './server.mjs';
import { createNetworkFixture, fixtureOrigin, writeOrigin, binaryHash, compressedLength } from './network-fixture.mjs';

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
      $responseHeaders = [];
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
        CURLOPT_CUSTOMREQUEST => $args['method'], CURLOPT_FOLLOWLOCATION => $args['follow'],
        CURLOPT_HTTPHEADER => $args['headers'],
        CURLOPT_HEADERFUNCTION => static function ($handle, $line) use (&$responseHeaders) { $responseHeaders[] = $line; return strlen($line); }]);
      if ($args['method'] === 'HEAD') curl_setopt($curl, CURLOPT_NOBODY, true);
      if ($args['body'] !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, base64_decode($args['body']));
      $body = curl_exec($curl);
      $result = ['transport'=>'curl', 'status'=>curl_getinfo($curl,CURLINFO_RESPONSE_CODE),
        'effectiveURL'=>curl_getinfo($curl,CURLINFO_EFFECTIVE_URL),
        'errno'=>curl_errno($curl), 'error'=>curl_error($curl), 'length'=>$body === false ? null : strlen($body),
        'hash'=>$body === false ? null : hash('sha256',$body), 'failed'=>$body === false, 'headers'=>$responseHeaders];
      curl_close($curl);
      echo json_encode($result, JSON_THROW_ON_ERROR);`;
    const response = await window.playground.runPhp(source);
    if (response.status !== 200) throw new Error(response.text);
    return JSON.parse(response.text);
  }, { url, method, body, headers, follow });
}

async function streamProbe(page, url, { method = 'GET', body = null, headers = [] } = {}) {
  return page.evaluate(async args => {
    const data = btoa(JSON.stringify(args));
    const source = `<?php
      $args = json_decode(base64_decode('${data}'), true, 512, JSON_THROW_ON_ERROR);
      error_clear_last();
      $options = ['timeout'=>20,'ignore_errors'=>true,'method'=>$args['method'],
        'header'=>implode("\\r\\n", $args['headers'])];
      if ($args['body'] !== null) $options['content'] = base64_decode($args['body']);
      $context = stream_context_create(['http'=>$options]);
      $body = @file_get_contents($args['url'], false, $context);
      $status = 0; foreach ($http_response_header ?? [] as $header) {
        if (preg_match('~^HTTP/\\S+\\s+(\\d+)~', $header, $m)) $status = (int)$m[1];
      }
      echo json_encode(['transport'=>'stream','status'=>$status,'failed'=>$body===false,
        'length'=>$body===false?null:strlen($body),'hash'=>$body===false?null:hash('sha256',$body),
        'headers'=>$http_response_header ?? [],'error'=>$body===false?(error_get_last()['message'] ?? ''):'']);`;
    const response = await window.playground.runPhp(source);
    if (response.status !== 200) throw new Error(response.text);
    return JSON.parse(response.text);
  }, { url, method, body, headers });
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
    assert.equal(fixture.relayRequests.length, before, 'A readable direct response must not contact the relay.');
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
    const streamHead = await streamProbe(page, `${writeOrigin}/denied/binary`, { method: 'HEAD' });
    assert.equal(streamHead.status, 200); assert.equal(streamHead.length, 0); assert.equal(streamHead.failed, false);
    assert.ok(streamHead.headers.some(header => /^content-length:\s*4096$/i.test(header)), 'Stream HEAD must retain upstream metadata.');
    receipt.cases.push({ case: 'head', curl: head, stream: streamHead });

    for (const transport of ['curl', 'stream']) {
      const read = transport === 'curl' ? probe : streamProbe;
      for (const [method, resource, status] of [['HEAD', 'compressed', 200], ['GET', 'compressed-not-modified', 304]]) {
        const result = await read(page, `${writeOrigin}/denied/${resource}`, { method });
        assert.equal(result.status, status); assert.equal(result.failed, false); assert.equal(result.length, 0);
        assert.ok(result.headers.some(header => /^content-encoding:\s*gzip$/i.test(header.trim())), `${transport} ${status}/${method} must retain representation encoding.`);
        assert.ok(result.headers.some(header => new RegExp(`^content-length:\\s*${compressedLength}$`, 'i').test(header.trim())), `${transport} ${status}/${method} must retain representation length.`);
        receipt.cases.push({ case: `compressed-${transport}-${status}-${method}`, ...result });
      }
      const decoded = await read(page, `${writeOrigin}/denied/compressed`);
      assert.equal(decoded.status, 200); assert.equal(decoded.hash, binaryHash); assert.equal(decoded.length, 4096);
      assert.ok(decoded.headers.every(header => !/^content-(?:encoding|length):/i.test(header.trim())), 'A decoded GET must not retain stale compressed metadata.');
      receipt.cases.push({ case: `compressed-${transport}-decoded-GET`, ...decoded });
    }

    const payload = Buffer.from([0, 255, 10, 13, 128, 65, 0, 254]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const transport of ['curl', 'stream']) {
      const beforeWrites = fixture.requests.filter(item => item.method === method).length;
      const result = await (transport === 'curl' ? probe : streamProbe)(page, `${writeOrigin}/denied/echo`, { method, body: payload.toString('base64'),
        headers: ['Content-Type: application/octet-stream', 'Authorization: Bearer upstream-fixture'] });
      assert.equal(result.status, 200); assert.equal(result.length, payload.length);
      assert.equal(result.hash, createHash('sha256').update(payload).digest('hex'));
      const received = fixture.requests.filter(item => item.method === method).slice(beforeWrites);
      assert.equal(received.length, 1, `${method} must dispatch once through its selected relay route.`);
      assert.deepEqual(received[0].body, payload);
      assert.equal(received[0].headers.authorization, 'Bearer upstream-fixture');
      assert.equal(received[0].headers['x-playground-request'], undefined);
      receipt.cases.push({ case: `binary-${transport}-${method}`, ...result });
    }
    for (const transport of ['curl', 'stream']) {
      before = fixture.relayRequests.length;
      const beforeWrites = fixture.requests.filter(item => item.path === '/denied/echo' && item.method === 'POST').length;
      const ambiguous = await (transport === 'curl' ? probe : streamProbe)(page, `${fixtureOrigin}/denied/echo`, { method: 'POST', body: Buffer.from('write-once').toString('base64'),
        headers: ['Content-Type: text/plain'] });
      assert.equal(ambiguous.failed, false);
      assert.equal(ambiguous.status, 200);
      assert.equal(fixture.relayRequests.length, before + 1, 'A cross-origin POST uses the proxy once without a speculative direct submission.');
      assert.equal(fixture.requests.filter(item => item.path === '/denied/echo' && item.method === 'POST').length - beforeWrites, 1);
      receipt.cases.push({ case: `${transport}-write-once`, ...ambiguous });
    }

    const html = await probe(page, `${writeOrigin}/denied/html`);
    assert.equal(html.status, 200); assert.equal(html.failed, false);
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
