import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBlueprints } from '../scripts/build-blueprints.mjs';

test('prepared blueprint generation rejects modified input before loading its runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-blueprint-integrity-'));
  try {
    await writeFile(path.join(directory, 'asset-inventory.json'), '[]\n');
    await writeFile(path.join(directory, 'changed.mjs'), 'throw new Error("Unverified code was executed");\n');
    await assert.rejects(() => buildBlueprints({ directory }), /input static artifact must match/);
    assert.equal(await readFile(path.join(directory, 'asset-inventory.json'), 'utf8'), '[]\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
