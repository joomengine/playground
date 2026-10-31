import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createNodeWorkerClient } from '../scripts/node-runtime-client.mjs';

function fixture() {
  return new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({id: 0, value: {ready: true}});
    parentPort.on('message', ({id, operation, args}) => {
      if (operation === 'block') while (true) {}
      if (operation === 'delay') setTimeout(() => parentPort.postMessage({id, value: args[0]}), args[0]);
      else parentPort.postMessage({id, value: args});
    });
  `, { eval: true });
}

test('Node host stops a CPU-bound worker and rejects subsequent work without replay', { timeout: 5000 }, async () => {
  const client = createNodeWorkerClient(fixture());
  try {
    assert.deepEqual(await client.ready, { ready: true });
    await assert.rejects(client.call('block', [], 30), error => error.code === 'TIMEOUT' && /not replayed/.test(error.message));
    await assert.rejects(client.call('next'), error => error.code === 'TIMEOUT');
  } finally { await client.terminate(); }
});

test('Node operation deadlines reject invalid limits and clear completed timers', { timeout: 5000 }, async () => {
  const client = createNodeWorkerClient(fixture());
  try {
    await client.ready;
    for (const limit of [0, 9, 600001, 10.5, NaN, Infinity, '180000']) {
      await assert.rejects(client.call('echo', [], limit), RangeError);
    }
    assert.deepEqual(await client.call('echo', ['done'], 50), ['done']);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(await client.call('echo', ['still open'], 50), ['still open']);
    assert.equal(client.failed, undefined);
  } finally { await client.terminate(); }
});

test('Node worker failures reject pending and later operations', { timeout: 5000 }, async () => {
  const worker = fixture();
  const client = createNodeWorkerClient(worker);
  try {
    await client.ready;
    const pending = client.call('delay', [1000]);
    const rejected = assert.rejects(pending, /exited unexpectedly/);
    await worker.terminate();
    await rejected;
    await assert.rejects(client.call('echo'), /exited unexpectedly/);
  } finally { await client.terminate(); }
});

test('Node deadline starts after queued work completes, including raw concurrent calls', { timeout: 5000 }, async () => {
  const client = createNodeWorkerClient(fixture());
  try {
    await client.ready;
    const first = client.call('delay', [100], 500);
    const second = client.call('echo', ['queued'], 30);
    assert.deepEqual(await Promise.all([first, second]), [100, ['queued']]);
  } finally { await client.terminate(); }
});
