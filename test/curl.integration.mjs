import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { PhpCgiNode } from 'php-cgi-wasm/PhpCgiNode.mjs';
import { stageCurl } from '../scripts/curl.mjs';
import { createPhpFetch, NESTED_PHP_REQUEST_ERROR } from '../src/php-network.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const directory = path.resolve(root, process.env.CURL_EXTENSION_DIR || '.cache/curl');
const payload = Buffer.from([0, 65, 255, 66, 128, 10]);

async function fixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });
    response.setHeader('X-Playground-Proof', 'native-curl-fetch');
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/binary' });
      response.end();
    } else if (request.url === '/slow') {
      // Keep the response open so the client's timeout must abort a real request.
    } else if (request.url === '/binary') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(payload);
    } else if (request.url === '/missing') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Missing fixture');
    } else if (request.url === '/status') {
      response.writeHead(418, { 'Content-Type': 'text/plain' });
      response.end('Status fixture');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ method: request.method, body: body.toString('base64'),
        custom: request.headers['x-client-proof'] ?? null, authorization: request.headers.authorization ?? null }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

for (const version of pins.php) {
  test(`PHP ${version.version}: upstream native cURL performs real HTTP requests through Fetch`, { timeout: 90_000 }, async t => {
    const destination = await mkdtemp(path.join(tmpdir(), 'playground-curl-'));
    t.after(() => rm(destination, { recursive: true, force: true }));
    const record = await stageCurl({ directory, destination, version, upstream: pins.upstream });
    const server = await fixture(t);
    const php = new PhpCgiNode({ version: version.version, persist: [], docroot: '/www', prefix: '/',
      sharedLibs: [{ name: record.provenance.extension.file,
        url: pathToFileURL(path.join(destination, record.provenance.extension.file)).href, ini: true }],
      ini: 'display_errors=1\nerror_reporting=E_ALL\n',
    });
    await php.mkdir('/config');
    await php.mkdir('/www');
    await php.writeFile('/www/index.php', `<?php
      $base = '${server.url}';
      function executeCurl(string $url, array $options = []): array {
        $handle = curl_init($url);
        curl_setopt_array($handle, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5]);
        curl_setopt_array($handle, $options);
        $body = curl_exec($handle);
        $result = ['body' => $body === false ? false : base64_encode($body),
          'status' => curl_getinfo($handle, CURLINFO_HTTP_CODE), 'error' => curl_error($handle),
          'errno' => curl_errno($handle)];
        unset($handle);
        return $result;
      }
      $get = executeCurl($base . '/binary', [CURLOPT_USERAGENT => 'JoomEngine native cURL proof',
        CURLOPT_SSL_VERIFYPEER => false]);
      $loopback = executeCurl($base . '/site/callback');
      $afterLoopback = executeCurl($base . '/binary');
      $post = executeCurl($base . '/echo', [CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => base64_decode('${payload.toString('base64')}'),
        CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'X-Client-Proof: binary-post']]);
      $head = executeCurl($base . '/binary', [CURLOPT_NOBODY => true, CURLOPT_HEADER => true]);
      $missing = executeCurl($base . '/missing', [CURLOPT_NOBODY => true]);
      $status = executeCurl($base . '/status');
      $redirect = executeCurl($base . '/redirect', [CURLOPT_FOLLOWLOCATION => true]);
      $custom = executeCurl($base . '/echo', [CURLOPT_CUSTOMREQUEST => 'PATCH', CURLOPT_POSTFIELDS => 'update',
        CURLOPT_USERPWD => 'fixture:password', CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_HTTPHEADER => ['Content-Type: text/plain', 'X-Client-Proof: custom-method']]);
      $timeout = executeCurl($base . '/slow', [CURLOPT_TIMEOUT_MS => 150]);
      $afterTimeout = executeCurl($base . '/binary');
      $unsupported = executeCurl('ftp://127.0.0.1/unsupported');
      $failStatus = executeCurl($base . '/missing', [CURLOPT_FAILONERROR => true]);
      $shortWrite = executeCurl($base . '/binary', [CURLOPT_WRITEFUNCTION => static fn($handle, $data) => 0]);
      $events = [];
      $callbacks = executeCurl($base . '/binary', [
        CURLOPT_HEADERFUNCTION => static function ($handle, $data) use (&$events) { $events[] = 'header'; return strlen($data); },
        CURLOPT_WRITEFUNCTION => static function ($handle, $data) use (&$events) { $events[] = 'body'; return strlen($data); }
      ]);
      echo json_encode(['php' => PHP_VERSION, 'intSize' => PHP_INT_SIZE, 'loaded' => extension_loaded('curl'),
        'version' => phpversion('curl'), 'protocols' => curl_version()['protocols'],
        'get' => $get, 'loopback' => $loopback, 'afterLoopback' => $afterLoopback,
        'post' => $post, 'head' => $head, 'missing' => $missing, 'status' => $status,
        'redirect' => $redirect, 'custom' => $custom, 'timeout' => $timeout, 'unsupported' => $unsupported,
        'afterTimeout' => $afterTimeout, 'failStatus' => $failStatus, 'shortWrite' => $shortWrite, 'events' => $events,
        'timeoutCode' => CURLE_OPERATION_TIMEDOUT, 'unsupportedCode' => CURLE_UNSUPPORTED_PROTOCOL,
        'statusCode' => CURLE_HTTP_RETURNED_ERROR, 'writeCode' => CURLE_WRITE_ERROR], JSON_THROW_ON_ERROR);
    `);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createPhpFetch(originalFetch, `${server.url}/site/`, () => true);
    let response;
    try { response = await php.request({ url: '/index.php', method: 'GET', headers: { host: 'localhost' } }); }
    finally { globalThis.fetch = originalFetch; }
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.doesNotMatch(body, /Deprecated|Warning|Fatal error/, body);
    const result = JSON.parse(body);
    assert.equal(result.php, version.patchVersion);
    assert.equal(result.intSize, 4);
    assert.equal(result.loaded, true);
    assert.equal(result.version, version.patchVersion);
    assert.ok(result.protocols.includes('http') && result.protocols.includes('https'));
    for (const key of ['get', 'afterLoopback', 'post', 'head', 'missing', 'status', 'redirect', 'custom', 'afterTimeout']) {
      assert.equal(result[key].error, '', `${key}: ${result[key].error}`);
      assert.equal(result[key].errno, 0, key);
    }
    assert.equal(result.get.status, 200);
    assert.equal(result.loopback.body, false);
    assert.notEqual(result.loopback.errno, 0);
    assert.ok(result.loopback.error.includes(NESTED_PHP_REQUEST_ERROR), result.loopback.error);
    assert.equal(server.requests.some(request => request.path === '/site/callback'), false);
    assert.deepEqual(Buffer.from(result.afterLoopback.body, 'base64'), payload);
    assert.deepEqual(Buffer.from(result.get.body, 'base64'), payload);
    assert.deepEqual(JSON.parse(Buffer.from(result.post.body, 'base64').toString()), {
      method: 'POST', body: payload.toString('base64'), custom: 'binary-post', authorization: null,
    });
    const head = Buffer.from(result.head.body, 'base64').toString();
    assert.match(head, /^HTTP\/\S+ 200\b/);
    assert.match(head, /x-playground-proof: native-curl-fetch/i);
    assert.ok(head.endsWith('\r\n\r\n'));
    assert.equal(result.missing.status, 404);
    assert.equal(result.missing.body, '');
    assert.equal(result.status.status, 418);
    assert.equal(Buffer.from(result.status.body, 'base64').toString(), 'Status fixture');
    assert.equal(result.redirect.status, 200);
    assert.deepEqual(Buffer.from(result.redirect.body, 'base64'), payload);
    assert.deepEqual(JSON.parse(Buffer.from(result.custom.body, 'base64').toString()), {
      method: 'PATCH', body: Buffer.from('update').toString('base64'), custom: 'custom-method',
      authorization: `Basic ${Buffer.from('fixture:password').toString('base64')}`,
    });
    assert.deepEqual(Buffer.from(result.afterTimeout.body, 'base64'), payload);
    for (const [key, code] of [['timeout', 'timeoutCode'], ['unsupported', 'unsupportedCode'], ['failStatus', 'statusCode'], ['shortWrite', 'writeCode']]) {
      assert.equal(result[key].body, false, key);
      assert.equal(result[key].errno, result[code], key);
      assert.ok(result[key].error.length > 0, key);
    }
    const firstBody = result.events.indexOf('body');
    assert.ok(firstBody > 0);
    assert.ok(result.events.slice(0, firstBody).every(event => event === 'header'));
    assert.ok(result.events.slice(firstBody).every(event => event === 'body'));
    assert.ok(server.requests.some(request => request.method === 'HEAD' && request.path === '/binary'));
    assert.ok(server.requests.some(request => request.path === '/slow'));
    const received = server.requests.find(request => request.method === 'POST');
    assert.deepEqual(received.body, payload, 'The HTTP server must receive the exact uploaded bytes.');
  });
}
