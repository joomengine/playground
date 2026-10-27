import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { inventory } from '../scripts/assets.mjs';
import { deterministicZip, verifyJcbVendor } from '../scripts/jcb-package.mjs';

test('derived package ZIP bytes are independent of input traversal order', () => {
  const a = new TextEncoder().encode('first');
  const b = new TextEncoder().encode('second');
  const forward = deterministicZip({ 'A.php': a, 'b.php': b });
  const reverse = deterministicZip({ 'b.php': b, 'A.php': a });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(unzipSync(forward), { 'A.php': a, 'b.php': b });
});

test('reviewed vendor verification rejects extra and changed package files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jcb-vendor-verification-'));
  try {
    await writeFile(path.join(directory, 'allowed.php'), '<?php return true;');
    const expected = await inventory(directory);
    await verifyJcbVendor(directory, expected);
    await writeFile(path.join(directory, 'unexpected.php'), '<?php return false;');
    await assert.rejects(() => verifyJcbVendor(directory, expected), /reviewed file inventory/);
    await rm(path.join(directory, 'unexpected.php'));
    await writeFile(path.join(directory, 'allowed.php'), '<?php return false;');
    await assert.rejects(() => verifyJcbVendor(directory, expected), /reviewed file inventory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
