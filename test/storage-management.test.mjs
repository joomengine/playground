import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStorageManagement, createRuntimeStorageAdapter, runtimeStorageIdentity,
  rememberRuntimeStorage, forgetRuntimeStorage } from '../src/storage-management.mjs';

const baseURL = 'https://playground.example/project/';
const nativeNames = id => [`/joomengine-${id}`, `/mariadb/idb/joomengine-${id}`];
function memoryRegistry() {
  const data = new Map();
  return { get length() { return data.size; }, key(index) { return [...data.keys()][index]; },
    getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function fixture() {
  const databases = new Set(), drafts = new Set(), removed = [], held = new Set();
  let beforeLock = () => {};
  const locks = {
    async query() { return { held: [...held].map(name => ({ name })) }; },
    async request(name, options, callback) {
      await beforeLock();
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
  const databaseStorage = { supported: true,
    async listDatabases() { return [...databases]; }, async listDraftIds() { return [...drafts]; },
    async removeDatabase(name) { removed.push(name); databases.delete(name); },
    async removeDraft(id) { removed.push(`draft:${id}`); drafts.delete(id); },
  };
  return { databases, drafts, removed, held, locks, databaseStorage, storage: memoryRegistry(),
    beforeLock: callback => { beforeLock = callback; },
    add(id) { nativeNames(id).forEach(name => databases.add(name)); drafts.add(id); } };
}

test('inventory groups native stores and draft records without exposing unrelated databases or another registered path', async () => {
  const f = fixture();
  const known = await runtimeStorageIdentity(baseURL, 'saved');
  const owned = await runtimeStorageIdentity(baseURL, 'orphan');
  const foreignBase = 'https://playground.example/other/';
  const foreign = await runtimeStorageIdentity(foreignBase, 'saved');
  const unassigned = 'e'.repeat(32);
  [known, owned, foreign, unassigned].forEach(id => f.add(id));
  f.databases.add('unrelated-app'); f.databases.add('/joomengine-not-an-identity'); f.drafts.add('unrelated-draft');
  rememberRuntimeStorage({ baseURL, storageKey: 'orphan', identity: owned, storage: f.storage });
  rememberRuntimeStorage({ baseURL: foreignBase, storageKey: 'saved', identity: foreign, storage: f.storage });
  const manager = createStorageManagement({ baseURL, ...f, getKnownSites: () => ({ saved: { storageKey: 'saved', displayName: 'My saved site' } }) });
  const entries = await manager.list();
  assert.equal(entries.length, 3);
  assert.equal(entries.find(item => item.id === known).title, 'My saved site');
  assert.equal(entries.find(item => item.id === owned).manualOnly, false);
  assert.equal(entries.find(item => item.id === unassigned).manualOnly, true);
  assert.equal(entries.find(item => item.id === unassigned).removable, true);
  assert.deepEqual(entries.find(item => item.id === known).databases, nativeNames(known));
  assert.equal(entries.every(item => item.hasDrafts), true);
  assert.deepEqual(f.removed, []);
});

test('manual orphan removal deletes only its complete native pair and its own editor record', async () => {
  const f = fixture(), id = 'a'.repeat(32), other = 'b'.repeat(32);
  f.add(id); f.add(other); f.databases.add('unrelated-app');
  const manager = createStorageManagement({ baseURL, ...f });
  await assert.rejects(manager.remove(id), /individual confirmation/);
  assert.deepEqual(f.removed, []);
  await manager.remove(id, { allowUnassigned: true });
  assert.deepEqual(f.removed, [...nativeNames(id), `draft:${id}`]);
  assert.deepEqual([...f.drafts], [other]);
  assert.deepEqual([...f.databases], [...nativeNames(other), 'unrelated-app']);
});

test('live identity and another tab owner are protected even with explicit orphan confirmation', async () => {
  const f = fixture(), live = await runtimeStorageIdentity(baseURL, 'live'), elsewhere = 'b'.repeat(32);
  f.add(live); f.add(elsewhere); f.held.add(`joomengine-playground:${elsewhere}`);
  const manager = createStorageManagement({ baseURL, ...f, getProtectedKeys: () => ['live'] });
  assert.equal((await manager.list()).every(item => item.protected && !item.removable), true);
  await assert.rejects(manager.remove(live, { allowUnassigned: true }), /current live site/);
  await assert.rejects(manager.remove(elsewhere, { allowUnassigned: true }), /running in another tab/);
  assert.deepEqual(f.removed, []);
});

test('deletion refreshes protection after panel inventory and lock acquisition', async () => {
  const f = fixture(), id = await runtimeStorageIdentity(baseURL, 'changing');
  f.add(id); let protectedKeys = [];
  const manager = createStorageManagement({ baseURL, ...f, getProtectedKeys: () => protectedKeys,
    getKnownSites: () => ({ changing: { storageKey: 'changing' } }) });
  assert.equal((await manager.list())[0].removable, true);
  f.beforeLock(() => { protectedKeys = ['changing']; });
  await assert.rejects(manager.remove(id), /current live site/);
  assert.deepEqual(f.removed, []);
});

test('registry removal is scoped and follows successful deletion, including draft-only leftovers', async () => {
  const f = fixture(), id = await runtimeStorageIdentity(baseURL, 'drafts');
  f.drafts.add(id);
  rememberRuntimeStorage({ baseURL, storageKey: 'drafts', identity: id, storage: f.storage });
  const manager = createStorageManagement({ baseURL, ...f });
  assert.equal((await manager.list())[0].scope, 'current');
  await manager.remove(id);
  assert.deepEqual(f.removed, [`draft:${id}`]);
  assert.equal(f.storage.length, 0);
  assert.deepEqual(await manager.list(), []);
});

test('failure retains ownership for recovery, and missing Web Locks never authorizes deletion', async () => {
  const f = fixture(), id = await runtimeStorageIdentity(baseURL, 'saved');
  f.add(id); rememberRuntimeStorage({ baseURL, storageKey: 'saved', identity: id, storage: f.storage });
  f.databaseStorage.removeDatabase = async () => { throw new Error('Storage unavailable'); };
  const manager = createStorageManagement({ baseURL, ...f });
  await assert.rejects(manager.remove(id), /Storage unavailable/);
  assert.equal((await manager.list())[0].scope, 'current');
  const withoutLocks = createStorageManagement({ baseURL, ...f, locks: null });
  assert.equal((await withoutLocks.list())[0].removable, false);
  await assert.rejects(withoutLocks.remove(id), /Web Locks/);
  assert.deepEqual(f.removed, []);
});

test('ownership metadata cannot break start/reset when localStorage quota is unavailable', () => {
  const storage = { getItem() { throw new DOMException('', 'QuotaExceededError'); },
    setItem() { throw new DOMException('', 'QuotaExceededError'); }, removeItem() { throw new DOMException('', 'QuotaExceededError'); } };
  assert.equal(rememberRuntimeStorage({ baseURL, storageKey: 'live', identity: 'c'.repeat(32), storage }), false);
  assert.equal(forgetRuntimeStorage({ baseURL, identity: 'c'.repeat(32), storage }), false);
});

test('draft enumeration/removal does not create a recovery database when none exists', async () => {
  let opened = 0;
  const adapter = createRuntimeStorageAdapter({ async databases() { return []; }, open() { opened++; throw new Error('Should not open'); } });
  assert.deepEqual(await adapter.listDraftIds(), []);
  await adapter.removeDraft('c'.repeat(32));
  assert.equal(opened, 0);
});

test('native database deletion holds the caller until a blocked deletion actually settles', async () => {
  const request = {}, blocked = [];
  const adapter = createRuntimeStorageAdapter({ deleteDatabase() { return request; } }, { onBlocked: name => blocked.push(name) });
  let settled = false;
  const deleting = adapter.removeDatabase('/joomengine-' + 'c'.repeat(32)).then(() => { settled = true; });
  request.onblocked(); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(blocked.length, 1);
  request.onsuccess(); await deleting;
  assert.equal(settled, true);
});
