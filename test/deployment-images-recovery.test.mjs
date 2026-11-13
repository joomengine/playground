import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeploymentImageCache, createIndexedDBImageStorage } from '../src/deployment-images.mjs';

const baseURL = 'https://playground.example/project/';

test('quota recovery waits for maintained writes and reclaims only downloadable prepared archives', async () => {
  const records = new Map([
    ['server:old:6.2.0', { key: 'server:old:6.2.0', kind: 'server', size: 12 }],
    ['custom:user', { key: 'custom:user', kind: 'custom', size: 16 }],
    ['site:user', { key: 'site:user', kind: 'site', size: 18 }],
  ]);
  let finishWrite, writeStarted;
  const writing = new Promise(resolve => { writeStarted = resolve; });
  const writeGate = new Promise(resolve => { finishWrite = resolve; });
  const removed = [];
  const storage = {
    get: async () => null,
    list: async () => [...records.values()],
    put: async record => { writeStarted(); await writeGate; records.set(record.key, record); },
    remove: async key => { removed.push(key); records.delete(key); },
  };
  const cache = createDeploymentImageCache({ baseURL, storage, fetcher: async () => new Response(Uint8Array.of(1, 2, 3)) });
  await cache.getMaintained({ key: 'server:pending:6.2.0', kind: 'server', size: 3, sha256: 'a'.repeat(64), url: baseURL });
  await writing;
  const recovery = cache.reclaimMaintained();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, [], 'Recovery must not race an archive that is still being committed.');
  finishWrite();
  assert.deepEqual(await recovery, { removed: 2, bytes: 15 });
  assert.deepEqual([...records.keys()], ['custom:user', 'site:user']);
  assert.deepEqual(await cache.reclaimMaintained(), { removed: 0, bytes: 0 });
});

test('IndexedDB keeps empty-message quota identity through open and transaction failures', async () => {
  const quota = new DOMException('', 'QuotaExceededError');
  for (const failOpen of [true, false]) {
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          if (failOpen) { request.error = quota; request.onerror(); return; }
          request.result = {
            transaction() {
              const tx = { error: quota, objectStore: () => ({ put() {} }) };
              queueMicrotask(() => tx.onabort({ target: tx }));
              return tx;
            },
          };
          request.onsuccess();
        });
        return request;
      },
    };
    const storage = createIndexedDBImageStorage({ baseURL, indexedDB });
    await assert.rejects(storage.put({ key: 'server:test:6.2.0' }, new Uint8Array([1])), error => error === quota);
  }
});
