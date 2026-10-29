import assert from 'node:assert/strict';
import test from 'node:test';
import { openSiteDatabase } from '../src/saved-site-recovery.mjs';

test('a saved database startup failure preserves its cause and offers recovery without retrying', async () => {
  const cause = Object.assign(new Error('lite4mariadb: l4m_open failed (1)'), { code: 'DATABASE_ERROR' });
  let attempts = 0;
  await assert.rejects(openSiteDatabase(async () => { attempts++; throw cause; }, { persistent: true }), error => {
    assert.equal(error.code, 'SAVED_DATABASE_START_FAILED');
    assert.equal(error.cause, cause);
    assert.match(error.message, /has not been reset/);
    assert.match(error.message, /Open recovery/);
    assert.match(error.message, /lite4mariadb: l4m_open failed \(1\)/);
    return true;
  });
  assert.equal(attempts, 1, 'A failed database must not be silently recreated or opened again.');
});

test('explicit saved-site recovery can continue with no database after failed initialization', async () => {
  const cause = new Error('lite4mariadb: l4m_open failed (1)');
  const result = await openSiteDatabase(async () => { throw cause; }, { persistent: true, recovery: true });
  assert.equal(result.database, null);
  assert.equal(result.error.cause, cause);
  assert.equal(result.error.code, 'SAVED_DATABASE_START_FAILED');
});

test('successful recovery keeps the real database for complete exports and repair', async () => {
  const database = { state: 'ready' };
  assert.deepEqual(await openSiteDatabase(async () => database, { persistent: true, recovery: true }), { database, error: null });
});

test('temporary database failures cannot be disguised as saved-file recovery', async () => {
  const cause = new Error('The browser could not allocate the database.');
  for (const recovery of [false, true]) {
    await assert.rejects(openSiteDatabase(async () => { throw cause; }, { persistent: false, recovery }), error => error === cause);
  }
});

test('unexpected startup rejection values still produce readable saved-site diagnostics', async () => {
  const result = await openSiteDatabase(async () => { throw 'Database startup was interrupted'; }, { persistent: true, recovery: true });
  assert.match(result.error.message, /Database startup was interrupted/);
  assert.equal(result.error.cause, 'Database startup was interrupted');
});
