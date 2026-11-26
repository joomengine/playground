import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSiteDatabase, openSiteDatabase } from '../src/saved-site-recovery.mjs';

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

class MariaDBBridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

test('a terminated initializer opens the same database once more before handing it to the caller', async () => {
  const timeout = new MariaDBBridgeError('TIMEOUT', 'MariaDB initialize timed out; its worker was terminated');
  const options = { database: 'joomla', persistence: { key: 'existing-site' } };
  const calls = [];
  const database = { async query() { throw timeout; } };
  const bridge = { MariaDBBridgeError, async createMariaDB(received) {
    assert.equal(received, options);
    calls.push('open');
    if (calls.length === 1) throw timeout;
    return database;
  } };
  const opened = await initializeSiteDatabase(bridge, options, () => calls.push('retry'));
  assert.equal(opened, database);
  await assert.rejects(opened.query(), error => error === timeout);
  assert.deepEqual(calls, ['open', 'retry', 'open']);
});

test('lock, permission, cancellation, quota and database errors keep their original single failure', async () => {
  for (const cause of [
    new MariaDBBridgeError('PERSISTENCE_IN_USE', 'Database is in use'),
    new MariaDBBridgeError('DATABASE_ERROR', 'MariaDB could not open'),
    new DOMException('Storage quota exceeded', 'QuotaExceededError'),
    new DOMException('Permission denied', 'NotAllowedError'),
    new DOMException('Operation cancelled', 'AbortError'),
    Object.assign(new Error('An unrelated network timeout'), { code: 'TIMEOUT' }),
  ]) {
    let calls = 0;
    const bridge = { MariaDBBridgeError, async createMariaDB() { calls++; throw cause; } };
    await assert.rejects(initializeSiteDatabase(bridge, {}), error => error === cause);
    assert.equal(calls, 1);
  }
});

test('a second initialization failure retains the bridge cause and the existing saved-site recovery behavior', async () => {
  for (const recovery of [false, true]) {
    const first = new MariaDBBridgeError('TIMEOUT', 'First initializer timed out');
    const second = new MariaDBBridgeError('TIMEOUT', 'Second initializer timed out');
    let calls = 0;
    const bridge = { MariaDBBridgeError, async createMariaDB() { throw ++calls === 1 ? first : second; } };
    const opening = openSiteDatabase(() => initializeSiteDatabase(bridge, {}), { persistent: true, recovery });
    if (recovery) {
      const result = await opening;
      assert.equal(result.database, null);
      assert.equal(result.error.cause, second);
      assert.match(result.error.message, /Second initializer timed out/);
    } else {
      await assert.rejects(opening, error => error.code === 'SAVED_DATABASE_START_FAILED' && error.cause === second);
    }
    assert.equal(calls, 2);
  }
});
