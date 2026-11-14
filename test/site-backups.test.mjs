import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSiteBackups, backupStorageCapacity, BACKUP_STORAGE_MARGIN, backupFilename, archiveBlob } from '../src/site-backups.mjs';

const archive = (value = 'complete site') => ({ bytes: new TextEncoder().encode(value), metadata: {
  format: 'joomengine-playground-export', createdAt: '2026-11-14T10:23:45+00:00', siteName: 'Authoring site', joomlaVersion: '6.2.0',
  playground: { configuration: { phpVersion: '8.4', jcbVersion: '6.2.0', deployId: 'jcb',
    admin: { username: 'author', password: 'private-password' }, overlays: [{ component: 'com_example' }] } },
} });
function memoryStorage() {
  const records = new Map();
  return {
    records, writes: 0, fail: false,
    async list() { return [...records.values()].map(({ blob, ...record }) => structuredClone(record)); },
    async get(id) { const record = records.get(id); return record && { ...structuredClone(record), blob: record.blob }; },
    async put(record, blob, expectedRevision) {
      this.writes++;
      if (this.fail) throw new DOMException('', 'QuotaExceededError');
      if ((records.get(record.id)?.revision ?? null) !== expectedRevision) {
        const error = new Error('Concurrent backup change'); error.name = 'BackupConflictError'; throw error;
      }
      records.set(record.id, { ...structuredClone(record), blob });
    },
    async remove(id) { records.delete(id); }, async clear() { records.clear(); },
  };
}
const available = () => ({ usage: 100, quota: 100_000_000 });

test('capacity uses the actual archive plus metadata allowance, without doubling', () => {
  assert.deepEqual(backupStorageCapacity(200, { usage: 100, quota: 310 }, 10), {
    known: true, usage: 100, quota: 310, available: 210, required: 210, fits: true,
  });
  assert.equal(backupStorageCapacity(200, { usage: 100, quota: 309 }, 10).fits, false);
  assert.equal(backupStorageCapacity(200, { usage: 400, quota: 100 }, 10).available, 0);
  assert.equal(backupStorageCapacity(200, null).known, false);
  assert.equal(backupStorageCapacity(200, null).required, 200 + BACKUP_STORAGE_MARGIN);
  assert.throws(() => backupStorageCapacity(0, available()), /Invalid/);
});

test('creating storage or listing never creates an automatic backup', async () => {
  const storage = memoryStorage(), backups = createSiteBackups({ storage, estimate: available });
  assert.deepEqual(await backups.list(), []);
  assert.equal(storage.writes, 0);
});

test('a complete backup retains private configuration and timestamps without a base dependency', async () => {
  const storage = memoryStorage();
  const backups = createSiteBackups({ storage, estimate: available, makeId: () => 'first', now: () => '2026-11-14T12:00:00Z' });
  const input = archive();
  const result = await backups.saveArchive(input, { name: 'My work', sourceSiteKey: 'live' });
  assert.equal(result.saved, true);
  assert.equal(result.record.id, 'first');
  assert.equal(result.record.size, input.bytes.length);
  assert.equal(result.record.createdAt, '2026-11-14T12:00:00.000Z');
  assert.equal(result.record.capturedAt, '2026-11-14T10:23:45+00:00');
  assert.equal(result.record.phpVersion, '8.4');
  assert.equal(result.record.jcbVersion, '6.2.0');
  assert.equal(result.record.configuration.admin.password, 'private-password');
  assert.deepEqual(result.record.configuration.overlays, input.metadata.playground.configuration.overlays);
  assert.equal(result.record.sourceSiteKey, 'live');
  assert.equal('base' in result.record, false);
  input.bytes.fill(0);
  assert.equal(await (await backups.get('first')).blob.text(), 'complete site');
  assert.equal('blob' in (await backups.list())[0], false, 'Listing does not load archive bytes.');
});

test('updating keeps one backup identity and creation time while new backup is explicit', async () => {
  const storage = memoryStorage(); let sequence = 0, clock = '2026-11-14T12:00:00Z';
  const backups = createSiteBackups({ storage, estimate: available, makeId: () => `id-${++sequence}`, now: () => clock });
  const initial = await backups.saveArchive(archive('first version'), { name: 'Work' });
  clock = '2026-11-14T13:00:00Z';
  const updated = await backups.saveArchive(archive('second version'), { id: initial.record.id });
  assert.equal(updated.saved, true);
  assert.equal(updated.record.revision, 2);
  assert.equal(updated.record.createdAt, initial.record.createdAt);
  assert.equal(updated.record.updatedAt, '2026-11-14T13:00:00.000Z');
  assert.equal((await backups.list()).length, 1);
  assert.equal(await (await backups.get(initial.record.id)).blob.text(), 'second version');
  const next = await backups.saveArchive(archive('separate snapshot'), { name: 'Separate' });
  assert.notEqual(next.record.id, initial.record.id);
  assert.equal((await backups.list()).length, 2);
});

test('insufficient capacity retains downloadable bytes and never starts a storage write', async () => {
  const storage = memoryStorage();
  const backups = createSiteBackups({ storage, estimate: () => ({ usage: 9, quota: 10 }), margin: 10 });
  const result = await backups.saveArchive(archive());
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'space');
  assert.equal(storage.writes, 0);
  assert.equal(await result.archive.blob.text(), 'complete site');
  assert.deepEqual(await backups.list(), []);
});

test('quota rejection while replacing preserves the previous backup and offers the captured new archive', async () => {
  const storage = memoryStorage();
  const backups = createSiteBackups({ storage, estimate: available, makeId: () => 'same' });
  const original = await backups.saveArchive(archive('original'));
  storage.fail = true;
  const result = await backups.saveArchive(archive('newest'), { id: 'same' });
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'storage');
  assert.equal(result.error.name, 'QuotaExceededError');
  assert.equal(result.previous.updatedAt, original.record.updatedAt);
  assert.equal(await result.archive.blob.text(), 'newest');
  assert.equal(await (await backups.get('same')).blob.text(), 'original');
  assert.equal((await backups.list()).length, 1);
});

test('an unavailable estimate does not prevent a valid write and never claims guaranteed capacity', async () => {
  const storage = memoryStorage();
  const backups = createSiteBackups({ storage, estimate: () => { throw new Error('Unavailable'); } });
  const result = await backups.saveArchive(archive());
  assert.equal(result.saved, true);
  assert.equal(result.capacity.known, false);
  assert.equal(await backups.usage(), null);
});

test('deleted update targets do not silently create an additional backup', async () => {
  const storage = memoryStorage(), backups = createSiteBackups({ storage, estimate: available });
  const result = await backups.saveArchive(archive(), { id: 'removed' });
  assert.equal(result.saved, false);
  assert.match(result.error.message, /no longer available/);
  assert.equal(storage.writes, 0);
  assert.equal(await result.archive.blob.text(), 'complete site');
});

test('storage revision conflict preserves concurrent backup and falls back to download', async () => {
  const storage = memoryStorage(), backups = createSiteBackups({ storage, estimate: available, makeId: () => 'same' });
  await backups.saveArchive(archive('original'));
  const originalPut = storage.put.bind(storage);
  storage.put = (record, blob, revision) => {
    storage.records.get(record.id).revision++;
    return originalPut(record, blob, revision);
  };
  const result = await backups.saveArchive(archive('mine'), { id: 'same' });
  assert.equal(result.reason, 'conflict');
  assert.equal(result.saved, false);
  assert.equal(await (await backups.get('same')).blob.text(), 'original');
  assert.equal(await result.archive.blob.text(), 'mine');
});

test('a backup changed while the archive was being prepared is not overwritten', async () => {
  const storage = memoryStorage(), backups = createSiteBackups({ storage, estimate: available, makeId: () => 'same' });
  const selected = await backups.saveArchive(archive('original'));
  await backups.saveArchive(archive('another window'), { id: 'same' });
  const result = await backups.saveArchive(archive('mine'), { id: 'same', expectedRevision: selected.record.revision });
  assert.equal(result.reason, 'conflict');
  assert.equal(result.saved, false);
  assert.equal(storage.writes, 2, 'A stale selection must be rejected before another storage write.');
  assert.equal(await (await backups.get('same')).blob.text(), 'another window');
  assert.equal(await result.archive.blob.text(), 'mine');
});

test('remove and clear operate only on the dedicated backup store', async () => {
  const storage = memoryStorage(); let id = 0;
  const backups = createSiteBackups({ storage, estimate: available, makeId: () => String(++id) });
  await backups.saveArchive(archive()); await backups.saveArchive(archive());
  await backups.remove('1'); assert.deepEqual((await backups.list()).map(record => record.id), ['2']);
  await backups.clear(); assert.deepEqual(await backups.list(), []);
  await assert.rejects(backups.get('1'), /no longer available/);
});

test('incomplete stored blobs are rejected and timestamps in filenames are explicitly UTC', async () => {
  const storage = memoryStorage(), backups = createSiteBackups({ storage, estimate: available, makeId: () => 'bad' });
  await backups.saveArchive(archive());
  storage.records.get('bad').blob = new Blob([]);
  await assert.rejects(backups.get('bad'), /incomplete/);
  assert.equal(backupFilename('My Site', '2026-11-14T12:30:45+02:00'), 'my-site-backup-2026-11-14T10-30-45Z.zip');
  assert.throws(() => archiveBlob({ bytes: new Uint8Array() }), /nonempty/);
});
