import test from 'node:test';
import assert from 'node:assert/strict';
import { PhpDbgNode } from 'php-dbg-wasm/PhpDbgNode';
import { PhpDebugRuntime } from '../src/code/debug-runtime.mjs';

const versions = process.env.PHPDBG_TEST_VERSION ? [process.env.PHPDBG_TEST_VERSION] : ['8.3', '8.4', '8.5'];
const encoder = new TextEncoder();
for (const version of versions) {
function runtimeFor(code) {
  const time = new Date('2026-01-01T00:00:00Z');
  const runtime = new PhpDebugRuntime({
    Runtime: PhpDbgNode, phpVersion: version, siteURL: 'https://example.test/site/',
    sharedLibs: [{ name: `php${version}-jec-phpdbg-http.so`, ini: true,
      url: new URL(`../.cache/phpdbg/php${version}-jec-phpdbg-http.so`, import.meta.url) }],
    ini: 'variables_order=EGPCS\n', prepend: '/internal/prepend.php',
    snapshot: [
      ...['/persist', '/persist/www', '/config', '/tmp', '/internal']
        .map(path => [path, { directory: true, mode: 0o40755, atime: time, mtime: time }]),
      ...Object.entries({ '/persist/www/index.php': code, '/internal/prepend.php': '<?php\n' })
        .map(([path, text]) => [path, { bytes: encoder.encode(text), mode: 0o100644, atime: time, mtime: time }]),
    ],
  });
  runtime.subscribe(event => { if (process.env.PHPDBG_TRACE) console.error(event); });
  return runtime;
}
const request = { url: 'https://example.test/site/index.php', method: 'GET' };
function nextStop(runtime) {
  return new Promise(resolve => {
    const remove = runtime.subscribe(event => { if (event.event === 'stopped') { remove(); resolve(event.body); } });
  });
}
async function step(runtime, command) {
  const stopped = nextStop(runtime);
  await runtime[command]();
  await stopped;
  return runtime.stackTrace();
}

test(`native PHP ${version} steps into, over and out of real application frames`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
function increment($value) {
    $next = $value + 1;
    return $next;
}
$seed = 4;
$answer = increment($seed);
echo json_encode($answer);
`);
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 7 }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Breakpoint was not reached.'); })]);
    await runtime.setBreakpoints('/persist/www/index.php', []);
    let frames = await step(runtime, 'stepIn');
    for (let attempt = 0; frames.length < 2 && attempt < 3; attempt++) frames = await step(runtime, 'stepIn');
    assert.ok(frames.length >= 2, JSON.stringify(frames));
    assert.equal(frames[0].line, 3);
    frames = await step(runtime, 'next');
    assert.equal(frames[0].line, 4);
    assert.equal((await runtime.evaluate('$next', frames[0].id)).result, '5');
    frames = await step(runtime, 'stepOut');
    assert.equal(frames.length, 1);
    assert.ok([7, 8].includes(frames[0].line), JSON.stringify(frames));
    await runtime.continue();
    assert.equal(new TextDecoder().decode((await execution).body), '5');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} steps over nested application calls without entering their frames`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
function inner($value) {
    return $value + 1;
}
function outer($value) {
    $result = inner($value);
    return $result;
}
$first = outer(4);
$second = outer(7);
echo json_encode([$first, $second]);
`);
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 9 }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Breakpoint was not reached.'); })]);
    let frames = await step(runtime, 'next');
    assert.equal(frames.length, 1, 'Step Over must retain the caller frame.');
    assert.equal(frames[0].line, 10);
    assert.equal((await runtime.evaluate('$first')).result, '5');
    frames = await step(runtime, 'next');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].line, 11);
    assert.equal((await runtime.evaluate('$second')).result, '8');
    await runtime.next();
    assert.equal(new TextDecoder().decode((await execution).body), '[5,8]');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} preserves callee breakpoints during Step Over and cancels its pending step on Continue`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
function nested() {
    return 9;
}
$value = nested();
echo $value;
`);
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 3 }, { line: 5 }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Breakpoint was not reached.'); })]);
    const frames = await step(runtime, 'next');
    assert.equal(frames.length, 2);
    assert.equal(frames[0].line, 3);
    await runtime.setBreakpoints('/persist/www/index.php', []);
    await runtime.continue();
    assert.equal(new TextDecoder().decode((await execution).body), '9');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} continues through a call-site breakpoint without hitting it again on return`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
function nested() {
    return 9;
}
$value = nested();
echo $value;
`);
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 5 }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Breakpoint was not reached.'); })]);
    const repeated = nextStop(runtime).then(() => { throw new Error('Returning from the call must not hit the same breakpoint again.'); });
    await runtime.continue();
    const response = await Promise.race([execution, repeated]);
    assert.equal(new TextDecoder().decode(response.body), '9');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} reads paused source from its active filesystem without allowing writes or symlink escapes`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
file_put_contents('/persist/www/generated.php', '<?php // before continue');
file_put_contents('/config/secret', 'private');
symlink('/config/secret', '/persist/www/escape');
symlink('generated.php', '/persist/www/alias.php');
echo 'ready';
file_put_contents('/persist/www/generated.php', '<?php // after continue');
`);
  await assert.rejects(runtime.workspaceRead('read', { path: '/index.php' }), { code: 'DEBUG_NOT_PAUSED' });
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 6 }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request); execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Breakpoint was not reached.'); })]);
    const read = await runtime.command('workspaceRead', { operation: 'read', args: { path: '/alias.php' } });
    assert.equal(new TextDecoder().decode(read.bytes), '<?php // before continue');
    assert.equal(read.canonicalPath, '/generated.php');
    assert.equal(read.stat.readonly, false, 'Readonly transport must still allow editing in-memory buffers.');
    assert.match(read.revision, /^[a-f0-9]{64}$/);
    const entries = await runtime.workspaceRead('list', { path: '/' });
    assert.ok(entries.some(entry => entry.name === 'generated.php'));
    await assert.rejects(runtime.workspaceRead('read', { path: '/escape' }), { code: 'PATH_OUTSIDE_WORKSPACE' });
    await assert.rejects(runtime.workspaceRead('write', { path: '/generated.php', bytes: 'forbidden' }), { code: 'INVALID_OPERATION' });
    const heldRead = runtime.workspaceRead('read', { path: '/generated.php' });
    const continuing = runtime.continue();
    assert.equal(new TextDecoder().decode((await heldRead).bytes), '<?php // before continue');
    await continuing;
    await assert.rejects(runtime.workspaceRead('stat', { path: '/index.php' }), { code: 'DEBUG_NOT_PAUSED' });
    assert.equal(new TextDecoder().decode((await execution).body), 'ready');
    assert.equal(new TextDecoder().decode(new Map(runtime.snapshotEntries).get('/persist/www/generated.php').bytes), '<?php // after continue');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} evaluates conditional breakpoints and paged recursive values`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
class DebugValue { public $label = 'root'; public $self; protected $secret = 'hidden'; public function __get($name) { throw new RuntimeException('Inspection invoked __get'); } public function __debugInfo() { throw new RuntimeException('Inspection invoked __debugInfo'); } } $object = new DebugValue(); $object->self = $object;
for ($index = 0; $index < 4; $index++) {
    $value = $index;
}
echo 'done';
`);
  await runtime.setBreakpoints('/persist/www/index.php', [{ line: 4, condition: '$index === 2' }]);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  execution.catch(() => {});
  try {
    await Promise.race([stopped, execution.then(() => { throw new Error('Conditional breakpoint was not reached.'); })]);
    assert.equal((await runtime.evaluate('$index')).result, '2');
    const object = await runtime.evaluate('$object');
    assert.ok(object.variablesReference);
    const properties = await runtime.variables(object.variablesReference, { start: 1, count: 1 });
    assert.equal(properties.length, 1);
    assert.equal(properties[0].name, 'self');
    const nested = await runtime.variables(properties[0].variablesReference, { start: 0, count: 1 });
    assert.equal(nested[0].name, 'label');
    assert.equal(nested[0].value, '"root"');
    const all = await runtime.variables(object.variablesReference, { start: 0, count: 10 });
    assert.ok(all.some(value => value.name === 'secret (protected)' && value.value === '"hidden"'));
    await runtime.setBreakpoints('/persist/www/index.php', []);
    await runtime.continue();
    assert.equal(new TextDecoder().decode((await execution).body), 'done');
  } finally { await runtime.stop(); await execution.catch(() => {}); }
});

test(`native PHP ${version} accepts pause and stop during an executing loop without replay`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
file_put_contents('/persist/www/once.txt', 'once');
$ticks = 0;
while (true) { $ticks++; }
`);
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request, { started: () => setTimeout(() => runtime.pause(), 30) });
  execution.catch(() => {});
  await Promise.race([stopped, execution.then(() => { throw new Error('Infinite loop unexpectedly finished.'); })]);
  assert.equal(runtime.phase, 'paused');
  assert.ok(Number((await runtime.evaluate('$ticks')).result) > 0);
  await runtime.stop();
  await assert.rejects(execution, /stopped/);
  assert.equal(new TextDecoder().decode(new Map(runtime.snapshotEntries).get('/persist/www/once.txt').bytes), 'once');
  assert.equal(runtime.phase, 'idle');
});

test(`native PHP ${version} emits source locations for PHP errors and can run a later request`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor("<?php\nthrow new RuntimeException('debug-error-location');\n");
  const events = [];
  runtime.subscribe(event => events.push(event));
  const stopped = nextStop(runtime);
  const execution = runtime.execute(request);
  await stopped;
  assert.equal((await runtime.stackTrace())[0].line, 2);
  await runtime.continue();
  assert.equal((await execution).status, 500);
  assert.ok(events.some(event => event.event === 'output' && event.body.source?.path === '/persist/www/index.php'
    && event.body.line === 2 && event.body.output.includes('debug-error-location')), JSON.stringify(events));
  const later = runtimeFor("<?php echo 'recovered';\n");
  assert.equal(new TextDecoder().decode((await later.execute(request)).body), 'recovered');
});

test(`native PHP ${version} preserves sessions, binary uploads and shutdown writes`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor(`<?php
session_start();
register_shutdown_function(function () { file_put_contents('/persist/www/shutdown.txt', 'completed'); });
$upload = $_FILES['document'];
$bytes = file_get_contents($upload['tmp_name']);
$moved = move_uploaded_file($upload['tmp_name'], '/persist/www/upload.bin');
$_SESSION['counter'] = ($_SESSION['counter'] ?? 0) + 1;
header('Content-Type: application/json');
echo json_encode(['user' => $_SESSION['user_id'], 'counter' => $_SESSION['counter'],
    'title' => $_POST['title'], 'name' => $upload['name'], 'hex' => bin2hex($bytes), 'moved' => $moved]);
`);
  runtime.options.cookieHeader = 'PHPSESSID=debug-session';
  runtime.options.ini += 'session.save_path=/tmp\n';
  runtime.options.snapshot.push(['/tmp/sess_debug-session', { bytes: encoder.encode('user_id|i:42;'), mode: 0o100600,
    atime: new Date(), mtime: new Date() }]);
  const head = encoder.encode('--jec-boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\nBinary upload\r\n'
    + '--jec-boundary\r\nContent-Disposition: form-data; name="document"; filename="proof.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
  const tail = encoder.encode('\r\n--jec-boundary--\r\n');
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const response = await runtime.execute({ ...request, method: 'POST',
    headers: [['content-type', 'multipart/form-data; boundary=jec-boundary']], body });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), {
    user: 42, counter: 1, title: 'Binary upload', name: 'proof.bin', hex: '00017f80ff', moved: true,
  });
  const files = new Map(runtime.snapshotEntries);
  assert.deepEqual(files.get('/persist/www/upload.bin').bytes, bytes);
  assert.equal(new TextDecoder().decode(files.get('/persist/www/shutdown.txt').bytes), 'completed');
  assert.equal(new TextDecoder().decode(files.get('/tmp/sess_debug-session').bytes), 'user_id|i:42;counter|i:1;');
});

test(`native PHP ${version} stops during startup before executing the selected request`, { timeout: 20_000 }, async () => {
  const runtime = runtimeFor("<?php file_put_contents('/persist/www/should-not-run', 'executed');\n");
  const execution = runtime.execute(request);
  await runtime.stop();
  await assert.rejects(execution, /stopped/);
  assert.equal(runtime.phase, 'idle');
  assert.ok(!runtime.snapshotEntries || !new Map(runtime.snapshotEntries).has('/persist/www/should-not-run'));
});
}
