import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { NESTED_PHP_REQUEST_ERROR } from '../src/php-network.mjs';
import { builtManifest } from './runtime-artifacts.mjs';

for (const phpVersion of (process.env.PLAYGROUND_PHP_VERSIONS?.split(',') || (await builtManifest()).php.map(entry => entry.version))) {
test(`PHP ${phpVersion}: native HTTP streams preserve bytes, contexts, response headers and timeouts`, { timeout: 60_000 }, async t => {
  const requests = [];
  const binary = Buffer.from([0, 255, 65, 128, 10]);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, body: Buffer.concat(chunks), proof: request.headers['x-proof'] });
    response.setHeader('X-Stream-Proof', 'actual-http');
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/binary' }); response.end(); }
    else if (request.url === '/missing') { response.writeHead(404); response.end('not found'); }
    else if (request.url === '/slow') { /* The stream's real timeout must abort this response. */ }
    else if (request.url === '/headers-only') { response.setHeader('Content-Length', 1024 * 1024 * 1024); response.flushHeaders(); }
    else if (request.url === '/echo') response.end(Buffer.concat(chunks));
    else response.end(binary);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await runtime.runPhp(`<?php
    $base = '${base}';
    $read = base64_encode(file_get_contents($base . '/binary'));
    $context = stream_context_create(['http' => ['method' => 'PATCH', 'content' => base64_decode('${binary.toString('base64')}'),
      'header' => ['Content-Type: application/octet-stream', 'X-Proof: stream-post']]]);
    $post = base64_encode(file_get_contents($base . '/echo', false, $context));
    $redirect = base64_encode(file_get_contents($base . '/redirect'));
    $missing = @file_get_contents($base . '/missing');
    $errorBody = file_get_contents($base . '/missing', false, stream_context_create(['http' => ['ignore_errors' => true]]));
    $start = microtime(true);
    $timeout = @file_get_contents($base . '/slow', false, stream_context_create(['http' => ['timeout' => 0.1]]));
    $elapsed = microtime(true) - $start;
    $handleContext = stream_context_create(['http' => ['header' => ['X-Proof: retained-context']]]);
    $handle = fopen($base . '/binary', 'rb', false, $handleContext);
    $retainedContext = stream_context_get_options($handle);
    $meta = stream_get_meta_data($handle);
    $first = bin2hex(fread($handle, 2));
    fseek($handle, 0);
    $again = base64_encode(stream_get_contents($handle));
    $stat = fstat($handle);
    fclose($handle);
    $customTrust = @file_get_contents($base . '/binary', false, stream_context_create(['ssl' => ['cafile' => '/custom-ca.pem']]));
    function requestHeaders($url) {
      $body = @file_get_contents($url);
      return ['body' => $body === false ? false : base64_encode($body), 'headers' => $http_response_header ?? null,
        'last' => function_exists('http_get_last_response_headers') ? http_get_last_response_headers() : null];
    }
    $localHeaders = requestHeaders($base . '/binary');
    $errorHeaders = requestHeaders($base . '/missing');
    $headerFunction = get_headers($base . '/missing', true);
    $headFunction = get_headers($base . '/binary', false, stream_context_create(['http' => ['method' => 'HEAD']]));
    $headerStart = microtime(true);
    $largeHeaders = get_headers($base . '/headers-only');
    $headerElapsed = microtime(true) - $headerStart;
    $overLimit = @file_get_contents($base . '/headers-only');
    $recursive = @file_get_contents('${runtime.baseUrl}callback');
    $recursiveCurl = curl_init('${runtime.baseUrl}callback');
    curl_setopt($recursiveCurl, CURLOPT_RETURNTRANSFER, true);
    $recursiveCurlResult = curl_exec($recursiveCurl);
    $recursiveError = curl_error($recursiveCurl);
    curl_close($recursiveCurl);
    $remoteFileExists = file_exists($base . '/binary');
    echo json_encode(compact('read', 'post', 'redirect', 'missing', 'errorBody', 'timeout', 'elapsed', 'first', 'again', 'stat', 'customTrust')
      + compact('localHeaders', 'errorHeaders', 'headerFunction', 'headFunction', 'largeHeaders', 'headerElapsed', 'remoteFileExists', 'retainedContext', 'overLimit', 'recursive', 'recursiveCurlResult', 'recursiveError')
      + ['headers' => $meta['wrapper_data'],
      'afterTimeout' => base64_encode(file_get_contents($base . '/binary'))], JSON_THROW_ON_ERROR);
  `);
  assert.equal(result.status, 200, result.text);
  const proof = JSON.parse(result.text);
  for (const key of ['read', 'post', 'redirect', 'again', 'afterTimeout']) assert.equal(proof[key], binary.toString('base64'), key);
  assert.equal(proof.missing, false);
  assert.equal(proof.errorBody, 'not found');
  assert.equal(proof.timeout, false);
  assert.ok(proof.elapsed < 3, 'An HTTP timeout must not hang the PHP worker.');
  assert.equal(proof.first, '00ff');
  assert.equal(proof.stat, false, 'HTTP must not report the buffer filesystem metadata as a remote file.');
  assert.ok(proof.headers.some(header => /^x-stream-proof: actual-http$/i.test(header)));
  assert.equal(proof.customTrust, false, 'Custom TLS trust must not be silently ignored.');
  assert.match(proof.localHeaders.headers[0], /^HTTP\/\S+ 200/);
  assert.match(proof.errorHeaders.headers[0], /^HTTP\/\S+ 404/);
  assert.equal(proof.errorHeaders.body, false);
  if (phpVersion !== '8.3') assert.deepEqual(proof.localHeaders.last, proof.localHeaders.headers);
  assert.match(proof.headerFunction[0], /^HTTP\/\S+ 404/);
  assert.match(proof.headFunction[0], /^HTTP\/\S+ 200/);
  assert.match(proof.largeHeaders[0], /^HTTP\/\S+ 200/);
  assert.ok(proof.headerElapsed < 3, 'get_headers must return without waiting for the response body.');
  assert.equal(proof.remoteFileExists, false, 'HTTP file_exists follows PHP native unsupported-stat behavior.');
  assert.deepEqual(proof.retainedContext, { http: { header: ['X-Proof: retained-context'] } });
  assert.equal(proof.overLimit, false, 'The response must be rejected before exceeding the PHP memory budget.');
  assert.equal(proof.recursive, false);
  assert.equal(proof.recursiveCurlResult, false);
  assert.ok(proof.recursiveError.includes(NESTED_PHP_REQUEST_ERROR), proof.recursiveError);
  assert.ok(requests.some(request => request.method === 'HEAD'));
  const received = requests.find(request => request.path === '/echo');
  assert.equal(received.method, 'PATCH');
  assert.equal(received.proof, 'stream-post');
  assert.deepEqual(received.body, binary);
});
}
