import test from 'node:test';
import assert from 'node:assert/strict';
import { builtWrapper, builtManifest, releasedLibraries } from './runtime-artifacts.mjs';
import { PhpDebugRuntime } from '../src/code/debug-runtime.mjs';

const pins = await builtManifest();
const versions = process.env.PHPDBG_TEST_VERSION ? [process.env.PHPDBG_TEST_VERSION] : pins.php.map(entry => entry.version);
const text = new TextEncoder();
function snapshot(files) {
  const time = new Date('2026-01-01T00:00:00Z');
  return [
    ...['/persist', '/persist/www', '/persist/sessions', '/config', '/tmp', '/internal']
      .map(path => [path, { directory: true, mode: 0o40755, atime: time, mtime: time }]),
    ...Object.entries(files).map(([path, value]) => [path, { bytes: text.encode(value), mode: 0o100644, atime: time, mtime: time }]),
  ];
}

for (const version of versions) test(`phpdbg HTTP SAPI preserves POST, cookies, response and one execution on PHP ${version}`, { timeout: 60_000 }, async () => {
  const { PhpDbgNode } = await builtWrapper(version, 'debugger');
  const runtime = new PhpDebugRuntime({
    Runtime: PhpDbgNode, phpVersion: version, siteURL: 'https://example.test/__site/owner/site/', cookieHeader: 'joomla_session=active',
    sharedLibs: [...await releasedLibraries(version), { name: `php${version}-jec-phpdbg-http.so`, ini: true,
      url: new URL(`../.cache/phpdbg/php${version}-jec-phpdbg-http.so`, import.meta.url) }],
    ini: 'variables_order=EGPCS\nsession.save_path=/persist/sessions\n', prepend: '/internal/prepend.php',
    snapshot: snapshot({
      '/internal/prepend.php': '<?php // No database shim needed in this isolated SAPI check.\n',
      '/persist/www/index.php': `<?php
header('Content-Type: application/json');
http_response_code(201);
setcookie('debug_response', 'accepted', ['path' => '/']);
$count = (int) @file_get_contents('/persist/www/count.txt') + 1;
file_put_contents('/persist/www/count.txt', (string) $count);
$object = (object) ['label' => 'inspected'];
function inspect_request($argument) {
    $local = 42;
    echo json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'post' => $_POST,
        'cookie' => $_COOKIE['joomla_session'], 'raw' => file_get_contents('php://input'),
        'object' => $argument->label, 'local' => $local]);
}
inspect_request($object);
`,
    }),
  });
  let stopped;
  const stop = new Promise(resolve => { stopped = resolve; });
  const logs = [];
  runtime.subscribe(event => {
    if (process.env.PHPDBG_TRACE) console.error(event);
    if (event.event === 'stopped') stopped(event);
    if (event.event === 'output') logs.push(event.body.output);
  });
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 10 }]);
  const execution = runtime.execute({ url: 'https://example.test/__site/owner/site/index.php?task=save', method: 'POST',
    headers: [['content-type', 'application/x-www-form-urlencoded']], body: text.encode('title=JoomEngine+Code') });
  if (process.env.PHPDBG_TRACE) setTimeout(() => { console.error('debug phase', runtime.phase, Boolean(runtime.binary)); runtime.php?.flush(); }, 3000).unref();
  execution.catch(() => {});
  await Promise.race([stop, execution.then(() => { throw new Error(`PHP completed without hitting the breakpoint.\n${logs.join('')}`); })]);
  const frames = await runtime.stackTrace();
  assert.ok(frames.length >= 2, JSON.stringify(frames));
  const scopes = await runtime.scopes(frames[0].id);
  const locals = await runtime.variables(scopes[0].variablesReference);
  assert.ok(locals.some(variable => variable.name === 'local' && variable.value === '42'), JSON.stringify(locals));
  const argument = locals.find(variable => variable.name === 'argument');
  assert.ok(argument?.variablesReference);
  const properties = await runtime.variables(argument.variablesReference);
  assert.ok(properties.some(variable => variable.name === 'label' && variable.value === '"inspected"'), JSON.stringify(properties));
  assert.equal((await runtime.evaluate('$local + 8', frames[0].id)).result, '50');
  assert.equal((await runtime.evaluate('$object->label', frames[1].id)).result, '"inspected"');
  await assert.rejects(runtime.evaluate('this is not PHP', frames[0].id), /evaluation failed/);
  assert.equal((await runtime.evaluate('$local', frames[0].id)).result, '42');
  await runtime.setBreakpoints('/persist/www/index.php', []);
  await runtime.continue();
  const response = await execution;
  assert.equal(response.status, 201);
  assert.ok(response.headers.some(([name, value]) => name.toLowerCase() === 'set-cookie' && value.includes('debug_response=accepted')));
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  assert.deepEqual(parsed, { method: 'POST', post: { title: 'JoomEngine Code' }, cookie: 'active', raw: 'title=JoomEngine+Code', object: 'inspected', local: 42 });
  const result = new Map(runtime.snapshotEntries);
  assert.equal(new TextDecoder().decode(result.get('/persist/www/count.txt').bytes), '1');
});
