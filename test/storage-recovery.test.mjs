import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateStorage, isStorageQuotaError, withStorageRecovery } from '../src/storage-recovery.mjs';

const quotaError = () => new DOMException('', 'QuotaExceededError');

test('successful storage writes need neither eviction nor a quota estimate', async () => {
  const result = { saved: true };
  let evictions = 0, estimates = 0;
  assert.equal(await withStorageRecovery(async () => result, {
    reclaim: async () => { evictions++; },
    storage: { estimate: async () => { estimates++; } },
  }), result);
  assert.equal(evictions, 0);
  assert.equal(estimates, 0);
});

test('an empty-message quota rejection retries persistence after disposable cache space is released', async () => {
  const order = [], observations = [], failure = quotaError();
  let writes = 0, usage = 900;
  const result = await withStorageRecovery(async () => {
    order.push('write');
    if (++writes === 1) throw failure;
    return { revision: 3 };
  }, {
    reclaim: async () => { order.push('reclaim'); usage -= 200; return { removed: 2, bytes: 200 }; },
    storage: { estimate: async () => { order.push('estimate'); return { usage, quota: 1000 }; } },
    onRecovery: details => observations.push(details),
  });
  assert.deepEqual(result, { revision: 3 });
  assert.deepEqual(order, ['write', 'estimate', 'reclaim', 'estimate', 'write']);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].originalError, failure);
  assert.equal(observations[0].recovered, true);
  assert.deepEqual(observations[0].before, { usage: 900, quota: 1000, available: 100 });
  assert.deepEqual(observations[0].after, { usage: 700, quota: 1000, available: 300 });
});

test('unrelated failures do not trigger eviction or replay based on their message', async () => {
  const failure = new Error('QuotaExceededError: storage is full');
  let writes = 0, evictions = 0;
  await assert.rejects(withStorageRecovery(async () => { writes++; throw failure; }, {
    reclaim: async () => { evictions++; return { removed: 1 }; },
  }), error => error === failure);
  assert.equal(writes, 1);
  assert.equal(evictions, 0);
});

test('quota recognition follows causes and accepts browser names without requiring a message', () => {
  assert.equal(isStorageQuotaError(new Error('Storage write failed', { cause: quotaError() })), true);
  assert.equal(isStorageQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
  assert.equal(isStorageQuotaError({ code: 'QuotaExceededError' }), true);
  assert.equal(isStorageQuotaError({ name: 'AbortError', code: 22 }), false);
  const cyclic = new Error('Unavailable'); cyclic.cause = cyclic;
  assert.equal(isStorageQuotaError(cyclic), false);
});

test('nothing reclaimable preserves the original failure and does not repeat the write', async () => {
  const failure = quotaError(), observations = [];
  let writes = 0;
  await assert.rejects(withStorageRecovery(async () => { writes++; throw failure; }, {
    reclaim: async () => ({ removed: 0, bytes: 0 }),
    storage: null,
    onRecovery: value => observations.push(value),
  }), error => error === failure);
  assert.equal(writes, 1);
  assert.equal(observations[0].retried, false);
});

test('failed cleanup preserves the initial quota failure and does not repeat the write', async () => {
  const failure = quotaError(), cleanupFailure = new Error('Cache unavailable'), observations = [];
  let writes = 0;
  await assert.rejects(withStorageRecovery(async () => { writes++; throw failure; }, {
    reclaim: async () => { throw cleanupFailure; },
    storage: null,
    onRecovery: value => observations.push(value),
  }), error => error === failure);
  assert.equal(writes, 1);
  assert.equal(observations[0].recoveryError, cleanupFailure);
});

test('recovery is bounded to one retry and returns the actual retry failure', async () => {
  const initial = quotaError(), repeated = quotaError(), observations = [];
  let writes = 0, evictions = 0;
  await assert.rejects(withStorageRecovery(async () => { throw ++writes === 1 ? initial : repeated; }, {
    reclaim: async () => { evictions++; return { removed: 1, bytes: 40 }; },
    storage: null,
    onRecovery: value => observations.push(value),
  }), error => error === repeated);
  assert.equal(writes, 2);
  assert.equal(evictions, 1);
  assert.equal(observations[0].originalError, initial);
  assert.equal(observations[0].error, repeated);
  assert.equal(observations[0].recovered, false);
  assert.equal(observations[0].retried, true);
});

test('unavailable storage estimates and failing observers cannot interrupt recovery', async () => {
  let writes = 0;
  assert.equal(await withStorageRecovery(async () => {
    if (++writes === 1) throw quotaError();
    return 'saved';
  }, {
    reclaim: async () => ({ removed: 1 }),
    storage: { estimate: async () => { throw new Error('Unavailable'); } },
    onRecovery: async () => { throw new Error('Diagnostic failed'); },
  }), 'saved');
});

test('storage estimates preserve missing values and never claim negative available space', async () => {
  assert.equal(await estimateStorage(null), null);
  assert.equal(await estimateStorage({ estimate: async () => ({ usage: NaN, quota: -1 }) }), null);
  assert.deepEqual(await estimateStorage({ estimate: async () => ({ usage: 5 }) }),
    { usage: 5, quota: null, available: null });
  assert.deepEqual(await estimateStorage({ estimate: async () => ({ usage: 12, quota: 10 }) }),
    { usage: 12, quota: 10, available: 0 });
});
