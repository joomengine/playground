import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { applyPhpDebugWorkerOverlay } from '../scripts/phpdbg.mjs';
import { sha256 } from '../scripts/assets.mjs';

const legacyEnvironment = 'var ENVIRONMENT_IS_WEB=true;var ENVIRONMENT_IS_WORKER=false;';
const dynamicEnvironment = 'var ENVIRONMENT_IS_WEB=!!globalThis.window;var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;';
const domTargets = 'var specialHTMLTargets=[0,document,window];';
const optionalTargets = 'var specialHTMLTargets=[0,globalThis.document??0,globalThis.window??0];';
const workerAssertion = 'assert(!ENVIRONMENT_IS_WORKER,"worker environment detected but not enabled at build time (add `worker` to `-sENVIRONMENT` to enable)");';
const workerGlue = dynamicEnvironment + domTargets
  + 'var readAsync,readBinary;{readAsync=async url=>new Uint8Array([9]).buffer;}'
  + 'var findEventTarget=target=>{var domElement=specialHTMLTargets[target]||document.querySelector(target);return domElement};'
  + 'function visibility(userData,useCapture,callbackfunc,targetThread){targetThread>>>=0;return registerVisibilityChangeEventCallback(specialHTMLTargets[1],userData,useCapture,callbackfunc,targetThread)}'
  + workerAssertion;

async function fixture(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jec-phpdbg-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const minor = '8.4';
  const file = `php${minor}-dbg-web.mjs`;
  await writeFile(path.join(directory, file), source);
  const options = { minor, upstreamVersion: 'fixture', manifest: { emscripten: { version: '6.0.6' }, files: {
    [`packages/php-dbg-wasm/${file}`]: { sha256: sha256(source) },
  } } };
  return { directory, file, options };
}

test('debugger worker overlay validates manifest inputs and handles both generated environment forms', async t => {
  for (const environment of [legacyEnvironment, dynamicEnvironment]) {
    const original = environment + domTargets;
    const item = await fixture(t, original);
    const result = await applyPhpDebugWorkerOverlay(item.directory, item.options);
    assert.equal(result.files.length, 1);
    const source = await readFile(path.join(item.directory, item.file), 'utf8');
    assert.equal(result.files[0].originalSha256, sha256(original));
    assert.equal(result.files[0].sha256, sha256(source));
    assert.notEqual(sha256(source), sha256(original));
    const proof = runInNewContext(`${source};({web:ENVIRONMENT_IS_WEB,worker:ENVIRONMENT_IS_WORKER,targets:specialHTMLTargets})`, {
      WorkerGlobalScope: class WorkerGlobalScope {},
    });
    assert.equal(proof.web, false);
    assert.equal(proof.worker, true);
    assert.equal(proof.targets[1], 0);
    assert.equal(proof.targets[2], 0);
    await assert.rejects(applyPhpDebugWorkerOverlay(item.directory, item.options), /differs from its release manifest/);
  }
});

test('released web glue supplies worker binary loading and safe missing DOM callbacks', async t => {
  const item = await fixture(t, workerGlue);
  const result = await applyPhpDebugWorkerOverlay(item.directory, item.options);
  const source = await readFile(path.join(item.directory, item.file), 'utf8');
  assert.match(result.buildScriptSha256, /^[a-f0-9]{64}$/);
  const requests = [];
  const proof = runInNewContext(`${source};({binary:readBinary('/runtime.wasm'),async:readAsync('/runtime.wasm'),target:findEventTarget('#missing'),visibility:visibility(0,0,0,0)})`, {
    WorkerGlobalScope: class WorkerGlobalScope {},
    XMLHttpRequest: class {
      open(...args) { requests.push(args); }
      send(body) { assert.equal(body, null); this.response = new Uint8Array([1, 2, 255]).buffer; }
    },
    assert: (condition, message) => assert.ok(condition, message),
    registerVisibilityChangeEventCallback: () => assert.fail('A Worker has no document to register.'),
  });
  assert.deepEqual([...proof.binary], [1, 2, 255]);
  assert.deepEqual([...new Uint8Array(await proof.async)], [9]);
  assert.deepEqual(requests, [['GET', '/runtime.wasm', false]]);
  assert.equal(proof.target, undefined);
  assert.equal(proof.visibility, -4);
});

test('unknown compiler glue or incomplete worker support cannot bypass the environment assertion', async t => {
  for (const [source, compiler] of [
    [workerGlue, '6.1.0'],
    [workerGlue.replace('{readAsync=async url=>', '{readAsync=async renamed=>'), '6.0.6'],
    [workerGlue + workerAssertion, '6.0.6'],
    [workerGlue.replace('document.querySelector(target)', 'document.querySelectorAll(target)'), '6.0.6'],
  ]) {
    const item = await fixture(t, source);
    item.options.manifest.emscripten.version = compiler;
    await assert.rejects(applyPhpDebugWorkerOverlay(item.directory, item.options), /Review the changed debugger|Review debugger worker glue/);
    assert.equal(await readFile(path.join(item.directory, item.file), 'utf8'), source);
  }
});

test('an already corrected release module is preserved without another overlay', async t => {
  const original = dynamicEnvironment + optionalTargets;
  const item = await fixture(t, original);
  const result = await applyPhpDebugWorkerOverlay(item.directory, item.options);
  assert.equal(result.files[0].sha256, result.files[0].originalSha256);
  assert.equal(await readFile(path.join(item.directory, item.file), 'utf8'), original);
});

test('changed or ambiguous debugger structures cannot silently receive an overlay', async t => {
  for (const source of ['unexpected module', dynamicEnvironment + domTargets + domTargets, legacyEnvironment + legacyEnvironment + domTargets]) {
    const item = await fixture(t, source);
    await assert.rejects(applyPhpDebugWorkerOverlay(item.directory, item.options), /changed debugger|Ambiguous debugger/);
    assert.equal(await readFile(path.join(item.directory, item.file), 'utf8'), source);
  }
});
