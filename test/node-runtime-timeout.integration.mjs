import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';

test('Node host terminates CPU-bound PHP at its operation deadline without replay', { timeout: 90_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
  t.after(() => runtime.close());
  await assert.rejects(runtime.runPhp('<?php while (true) {}', { timeoutMs: 100 }),
    error => error.code === 'TIMEOUT' && /not replayed/.test(error.message));
  await assert.rejects(runtime.runPhp('<?php echo "must not run";'), error => error.code === 'TIMEOUT');
});
