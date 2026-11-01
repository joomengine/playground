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
const optionalTargets = 'var specialHTMLTargets=[0,globalThis.document,globalThis.window];';

async function fixture(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jec-phpdbg-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const minor = '8.4';
  const file = `php${minor}-dbg-web.mjs`;
  await writeFile(path.join(directory, file), source);
  const options = { minor, upstreamVersion: 'fixture', manifest: { files: {
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
    assert.equal(proof.targets[1], undefined);
    assert.equal(proof.targets[2], undefined);
    await assert.rejects(applyPhpDebugWorkerOverlay(item.directory, item.options), /differs from its release manifest/);
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
