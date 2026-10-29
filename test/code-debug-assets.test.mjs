import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPhpDebugWorkerOverlay } from '../scripts/phpdbg.mjs';
import { sha256 } from '../scripts/assets.mjs';

test('debugger worker overlay checks exact package inputs and records every modified file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jec-phpdbg-overlay-'));
  try {
    for (const version of ['8.3', '8.4', '8.5']) {
      const file = `php${version}-dbg-web.mjs`;
      await cp(new URL(`../node_modules/php-dbg-wasm/${file}`, import.meta.url), path.join(directory, file));
    }
    const result = await applyPhpDebugWorkerOverlay(directory);
    assert.equal(result.files.length, 3);
    for (const file of result.files) {
      const source = await readFile(path.join(directory, file.file), 'utf8');
      assert.equal(sha256(source), file.sha256);
      assert.notEqual(file.sha256, file.originalSha256);
      assert.ok(source.includes('var specialHTMLTargets=[0,globalThis.document,globalThis.window];'));
      assert.ok(source.includes('var ENVIRONMENT_IS_WORKER=typeof WorkerGlobalScope!=="undefined";'));
    }
    await assert.rejects(applyPhpDebugWorkerOverlay(directory), /Review the upstream debugger worker correction/);
    await writeFile(path.join(directory, 'php8.3-dbg-web.mjs'), 'unexpected upstream build');
    await assert.rejects(applyPhpDebugWorkerOverlay(directory), /Review the upstream debugger worker correction/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
