import assert from 'node:assert/strict';
import test from 'node:test';
import { resetPlayground } from '../src/playground.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDatabase = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const requests = [];
  let held = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      assert.match(name, /^joomengine-playground:[a-f0-9]{32}$/);
      held = true;
      try { return await callback({ name }); } finally { held = false; }
    },
  } } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    deleteDatabase(name) { const request = { name }; requests.push(request); return request; },
  } });
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    if (previousDatabase) Object.defineProperty(globalThis, 'indexedDB', previousDatabase); else delete globalThis.indexedDB;
  });
  return { requests, get held() { return held; } };
}

test('reset holds the runtime lock while native deletion is blocked and through its next pending store', async t => {
  const f = fixture(t), blocked = [];
  let completed = false;
  const resetting = resetPlayground({ storageKey: 'pending-delete', onBlocked: name => blocked.push(name) });
  const storageFailure = new Error('Database deletion failed');
  const checked = assert.rejects(resetting, storageFailure).then(() => { completed = true; });
  await drain();
  assert.equal(f.requests.length, 1, 'Start only one uncancellable native deletion at a time.');
  assert.match(f.requests[0].name, /^\/joomengine-/);
  f.requests[0].onblocked(); await drain();
  assert.equal(f.held, true);
  assert.equal(completed, false);
  assert.deepEqual(blocked, [f.requests[0].name]);
  f.requests[0].onsuccess(); await drain();
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].name, /^\/mariadb\/idb\/joomengine-/);
  assert.equal(f.held, true, 'Completing PHP deletion cannot release the lock while MariaDB deletion remains pending.');
  f.requests[1].onblocked(); await drain();
  assert.equal(completed, false);
  assert.equal(f.held, true);
  f.requests[1].error = storageFailure;
  f.requests[1].onerror();
  await checked;
  assert.equal(f.held, false, 'The lock releases after the final deletion request settles.');
});

test('a rejected first deletion never leaves another deletion pending after the lock is released', async t => {
  const f = fixture(t), failure = new Error('Filesystem deletion rejected');
  const resetting = resetPlayground({ storageKey: 'failed-delete' });
  const checked = assert.rejects(resetting, failure);
  await drain();
  f.requests[0].error = failure; f.requests[0].onerror();
  await checked;
  assert.equal(f.requests.length, 1);
  assert.equal(f.held, false);
});
