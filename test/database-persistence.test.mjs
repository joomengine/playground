import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointAndPersist } from '../src/database-persistence.mjs';

function fixture({ fail, failClose = false } = {}) {
  const calls = [];
  const database = {
    hostCalls: {
      'mariadb.v1': async input => {
        const payload = JSON.parse(input);
        calls.push(payload);
        assert.equal(payload.version, 1);
        if (payload.op === fail || (failClose && payload.op === 'close')) {
          return JSON.stringify({ version: 1, ok: false, error: { code: 'DATABASE_ERROR', message: `${payload.op} failed` } });
        }
        return JSON.stringify({ version: 1, ok: true, result: payload.op === 'connect' ? { connection: 'checkpoint-session' } : {} });
      },
    },
    async flush() {
      calls.push({ op: 'persist' });
      if (fail === 'persist') throw new Error('IndexedDB storage quota exceeded');
    },
  };
  return { database, calls };
}

test('saving checkpoints InnoDB and closes its SQL connection before syncing browser storage', async () => {
  const { database, calls } = fixture();
  await checkpointAndPersist(database);
  assert.deepEqual(calls.map(call => call.op), ['connect', 'query', 'close', 'persist']);
  assert.deepEqual(calls[1], { version: 1, op: 'query', connection: 'checkpoint-session', sql: 'SET GLOBAL innodb_log_checkpoint_now=ON' });
  assert.equal(calls[2].connection, calls[1].connection);
});

test('failed checkpoints release their connection and never persist incomplete database pages', async () => {
  const { database, calls } = fixture({ fail: 'query' });
  await assert.rejects(checkpointAndPersist(database), /query failed/);
  assert.deepEqual(calls.map(call => call.op), ['connect', 'query', 'close']);
});

test('connection or cleanup failures cannot be acknowledged as saved', async () => {
  for (const fail of ['connect', 'close']) {
    const { database, calls } = fixture({ fail });
    await assert.rejects(checkpointAndPersist(database), new RegExp(`${fail} failed`));
    assert.equal(calls.some(call => call.op === 'persist'), false);
  }
});

test('checkpoint failure retains its original diagnostic when connection cleanup also fails', async () => {
  const { database } = fixture({ fail: 'query', failClose: true });
  await assert.rejects(checkpointAndPersist(database), /query failed.*cleanup also failed.*close failed/);
});

test('a completed checkpoint does not hide a failed IndexedDB sync', async () => {
  const { database, calls } = fixture({ fail: 'persist' });
  await assert.rejects(checkpointAndPersist(database), /storage quota exceeded/);
  assert.deepEqual(calls.map(call => call.op), ['connect', 'query', 'close', 'persist']);
});

test('temporary sites do not checkpoint an in-memory database unnecessarily', async () => {
  const { database, calls } = fixture();
  await checkpointAndPersist(database, { persistent: false });
  assert.deepEqual(calls, [{ op: 'persist' }]);
});
