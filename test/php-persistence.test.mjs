import assert from 'node:assert/strict';
import test from 'node:test';
import { flushPhpFilesystem } from '../src/php-persistence.mjs';

test('a closing IDBFS handle is reopened once without discarding the dirty files', async () => {
  const pending = new Map([['/site/changed.php', 'new content']]);
  const committed = new Map();
  let closes = 0, attempts = 0;
  const backend = { DB_STORE_NAME: 'FILE_DATA', dbs: { '/site': { close() { closes++; } } } };
  const fs = {
    root: { mount: {} },
    getMounts: () => [{ mountpoint: '/site', type: backend }],
    syncfs(populate, callback) {
      assert.equal(populate, false, 'Retry must never hydrate stale disk state over dirty memory.');
      attempts++;
      if (backend.dbs['/site']) { callback(new DOMException('The database connection is closing.', 'InvalidStateError')); return; }
      for (const [path, bytes] of pending) committed.set(path, bytes);
      pending.clear();
      callback(null);
    },
  };
  await flushPhpFilesystem(fs);
  assert.equal(attempts, 2);
  assert.equal(closes, 1);
  assert.equal(committed.get('/site/changed.php'), 'new content');
  assert.equal(pending.size, 0);
});

test('quota failures remain rejected and dirty until a later explicit retry succeeds', async () => {
  const quota = new DOMException('', 'QuotaExceededError');
  let available = false, dirty = true, attempts = 0;
  const fs = { syncfs(populate, callback) {
    assert.equal(populate, false);
    attempts++;
    if (!available) { callback(quota); return; }
    dirty = false;
    callback(null);
  } };
  await assert.rejects(flushPhpFilesystem(fs), error => error === quota);
  assert.equal(attempts, 1, 'Do not repeat an identical write while quota is unavailable.');
  assert.equal(dirty, true);
  available = true;
  await flushPhpFilesystem(fs);
  assert.equal(attempts, 2);
  assert.equal(dirty, false);
});

test('a failed reopened connection is reported without an unbounded retry loop', async () => {
  let attempts = 0;
  const backend = { DB_STORE_NAME: 'FILE_DATA', dbs: { '/site': { close() {} } } };
  const failure = new DOMException('', 'InvalidStateError');
  const fs = { root: { mount: {} }, getMounts: () => [{ mountpoint: '/site', type: backend }],
    syncfs(populate, callback) { attempts++; callback(failure); } };
  await assert.rejects(flushPhpFilesystem(fs), error => error === failure);
  assert.equal(attempts, 2);
});
