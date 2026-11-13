import assert from 'node:assert/strict';
import test from 'node:test';
import { PhpSession, validateCheckpointBytes } from '../src/playground.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, database = {}, diagnostic) {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    messages = [];
    terminated = false;
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  const session = new PhpSession({ reset: async () => {}, flush: async () => {}, ...database }, undefined, diagnostic);
  t.after(() => {
    session.fail(new Error('Test complete'));
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
  });
  return {
    session,
    async result(value = null, extra = {}) {
      await drain();
      const operation = session.worker.messages.at(-1);
      assert.ok(operation?.id);
      await session.receive({ type: 'result', id: operation.id, value, ...extra });
      return operation;
    },
  };
}

test('adjacent saves share one checkpoint, but a later mutation gets its own FIFO save', async t => {
  let writes = 0;
  const { session, result } = fixture(t, { flush: async () => { writes++; } });
  const first = session.flushTogether();
  assert.equal(session.flushTogether(), first);
  const mutation = session.send('fs.writeFile', { path: '/site', data: 'changed' });
  const second = session.flushTogether();
  assert.notEqual(second, first);
  assert.equal(session.flushTogether(), second);
  assert.equal((await result()).operation, 'flush');
  await first;
  assert.equal((await result()).operation, 'fs.writeFile');
  await mutation;
  assert.equal((await result()).operation, 'flush');
  const receipt = await second;
  assert.equal(writes, 2);
  assert.equal(receipt.savedAt, session.savedAt);
  await session.flushTogether();
  assert.equal(session.worker.messages.length, 3, 'An unchanged successful save is already durable.');
  assert.equal(session.idle, true);
});

test('empty named worker errors reject persistence and leave the live queue usable', async t => {
  let databaseWrites = 0;
  const { session, result } = fixture(t, { flush: async () => { databaseWrites++; } });
  const saving = session.flushTogether();
  const rejected = assert.rejects(saving, error => error.name === 'QuotaExceededError' && error.message.includes('QuotaExceededError'));
  await result(undefined, { error: '', name: 'QuotaExceededError', code: 22 });
  await rejected;
  assert.equal(databaseWrites, 0);
  assert.equal(session.savedAt, null);
  assert.equal(session.failure, null);
  assert.equal(session.worker.terminated, false);
  const request = session.send('request', { url: '/administrator/' });
  await result({ status: 200, databaseUsed: false });
  assert.equal((await request).status, 200);
});

test('a rejected database save releases the queue and a retry persists both stores', async t => {
  let attempts = 0;
  const error = new Error('Database storage write failed');
  const { session, result } = fixture(t, { flush: async () => { if (++attempts === 1) throw error; } });
  const failed = session.flushTogether();
  const rejected = assert.rejects(failed, error);
  await result(); await rejected;
  assert.equal(session.persistenceError, error);
  assert.equal(session.failure, null);
  const retry = session.flushTogether();
  await result(); await retry;
  assert.equal(attempts, 2);
  assert.equal(session.persistenceError, null);
  assert.ok(session.savedAt);
});

test('workspace batches persist files and database once before allowing later HTTP requests', async t => {
  let databaseDone;
  const { session, result } = fixture(t, { flush: () => new Promise(resolve => { databaseDone = resolve; }) });
  const batch = session.withWorkspaceBatch(async request => [
    await request('write', { path: '/one' }), await request('write', { path: '/two' }),
  ]);
  const saving = session.flushTogether();
  const later = session.send('request', { url: '/' });
  const live = () => ({ ok: true, changes: [{ type: 'updated' }], persistence: { enabled: true, saved: false, pending: true } });
  assert.equal((await result(live())).args.path, '/one');
  assert.equal((await result(live())).args.path, '/two');
  assert.equal((await result()).operation, 'flush');
  await drain();
  assert.equal(session.worker.messages.length, 3);
  assert.equal(session.idle, false);
  databaseDone();
  const changed = await batch;
  await saving;
  assert.ok(changed.every(value => value.persistence.saved && !value.persistence.pending));
  assert.equal((await result({ status: 200, databaseUsed: false })).operation, 'request');
  await later;
  assert.equal(session.worker.messages.filter(value => value.operation === 'flush').length, 1);
});

test('editor storage failure preserves completed live writes and reports a pending retry', async t => {
  const diagnostics = [];
  const { session, result } = fixture(t, { flush: async () => { throw new Error('Storage unavailable'); } }, value => diagnostics.push(value));
  const editing = session.workspaceRequest('write', { path: '/one' });
  await result({ ok: true, changes: [{ type: 'updated' }], persistence: { enabled: true, saved: false, pending: true } });
  await result();
  const changed = await editing;
  assert.equal(changed.ok, true);
  assert.equal(changed.persistence.saved, false);
  assert.match(changed.persistence.error, /Storage unavailable/);
  assert.match(diagnostics[0], /Files changed in the running site/);
  assert.equal(session.failure, null);
});

test('PHP database callbacks bypass a waiting save reservation without replaying the request', async t => {
  const payload = { query: 'UPDATE example SET value = 1' };
  let calls = 0;
  const { session, result } = fixture(t, { hostCalls: { 'mariadb.v1': async value => { assert.deepEqual(value, payload); calls++; return { ok: true }; } } });
  const request = session.send('request', { url: '/' });
  const saving = session.flushTogether();
  await drain();
  const requestId = session.worker.messages.at(-1).id;
  await session.receive({ type: 'database-call', id: 100, payload });
  assert.equal(session.worker.messages.at(-1).type, 'database-result');
  assert.equal(calls, 1);
  await session.receive({ type: 'result', id: requestId, value: { status: 200 } });
  await request;
  assert.equal((await result()).operation, 'flush');
  await saving;
  assert.equal(calls, 1);
});

test('a slow persistence callback keeps the live worker and reservation until completion', async t => {
  const diagnostics = [];
  const { session, result } = fixture(t, {}, value => diagnostics.push(value));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saving = session.flushTogether();
  await drain();
  const later = session.send('fs.writeFile', { path: '/later' });
  t.mock.timers.tick(180_000);
  assert.equal(session.failure, null);
  assert.equal(session.worker.terminated, false);
  assert.equal(session.worker.messages.length, 1);
  assert.match(diagnostics[0], /taking longer/);
  await result(); await saving;
  assert.equal((await result()).operation, 'fs.writeFile');
  await later;
});

test('checkpoint validation distinguishes missing bytes from invalid archives', () => {
  assert.throws(() => validateCheckpointBytes(undefined), /missing or empty/);
  assert.throws(() => validateCheckpointBytes(new Uint8Array()), /missing or empty/);
  assert.throws(() => validateCheckpointBytes(new Uint8Array(22)), /not a valid ZIP/);
  const emptyZip = new Uint8Array(22);
  emptyZip.set([0x50, 0x4b, 0x05, 0x06]);
  assert.equal(validateCheckpointBytes(emptyZip), emptyZip);
  assert.equal(validateCheckpointBytes(emptyZip.buffer).byteLength, 22);
});
