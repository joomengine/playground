import assert from 'node:assert/strict';
import { prepareBrowserEnvironment } from './server.mjs';
import { randomUUID } from 'node:crypto';

/** Fingerprint actual IDBFS records without retaining a second complete site in memory. */
async function storedFingerprint(page, configuration) {
  return page.evaluate(async storageKey => {
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const identity = (await digest(new TextEncoder().encode(`${new URL('./', location.href).href}\n${storageKey}`))).slice(0, 32);
    const normalize = async value => {
      if (value instanceof Date) return { date: value.toISOString() };
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { bytes: bytes.byteLength, sha256: await digest(bytes) };
      }
      if (Array.isArray(value)) return Promise.all(value.map(normalize));
      if (value && typeof value === 'object') {
        return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key => [key, await normalize(value[key])])));
      }
      return value;
    };
    const result = {};
    for (const name of [`/joomengine-${identity}`, `/mariadb/idb/joomengine-${identity}`]) {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error(`Missing saved store: ${name}`)); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        const stores = {};
        for (const store of [...database.objectStoreNames].sort()) {
          const rows = [];
          let after;
          for (;;) {
            const batch = await new Promise((resolve, reject) => {
              const transaction = database.transaction(store, 'readonly');
              const source = transaction.objectStore(store);
              const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
              const keys = source.getAllKeys(range, 32);
              const values = source.getAll(range, 32);
              transaction.oncomplete = () => resolve({ keys: keys.result, values: values.result });
              transaction.onabort = () => reject(transaction.error || new Error('Fingerprint read aborted.'));
              transaction.onerror = () => reject(transaction.error || new Error('Fingerprint read failed.'));
            });
            if (!batch.keys.length) break;
            for (let index = 0; index < batch.keys.length; index++) {
              rows.push([await normalize(batch.keys[index]), await normalize(batch.values[index])]);
            }
            after = batch.keys.at(-1);
          }
          stores[store] = { records: rows.length, sha256: await digest(new TextEncoder().encode(JSON.stringify(rows))) };
        }
        result[name] = stores;
      } finally { database.close(); }
    }
    return result;
  }, configuration.storageKey);
}

/** A database startup failure must leave saved bytes intact and permit independent file recovery. */
export async function assertSavedSiteRecovery(page, { serverURL, configuration, manifest, fixtures }) {
  assert.equal(configuration.persistence, true, 'The recovery contract needs a saved runtime.');
  const marker = `recovery-${randomUUID()}`;
  const file = '/persist/www/recovery-contract.bin';
  const bytes = [0, 255, 65, 0, 128, 10];
  // Deliberately noncanonical JSON catches upstream cookie-jar normalization in recovery.
  const cookies = '{\n  "version": 1, "cookies": []\n}\n';
  const manifestFixture = 'assets/manifest.json';
  const bridgeFixture = '__test_failed_bridge.mjs';
  const previous = Object.fromEntries([manifestFixture, bridgeFixture].map(key => [key, {
    exists: Object.hasOwn(fixtures, key), value: fixtures[key],
  }]));
  const restoreFixtures = () => {
    for (const [key, original] of Object.entries(previous)) {
      if (original.exists) fixtures[key] = original.value;
      else delete fixtures[key];
    }
  };
  let competitor;
  const extraPageErrors = [];
  try {
    page.testStep = 'seed a real saved site before database-failure recovery';
    const seeded = await page.evaluate(async ({ marker, file, bytes, cookies }) => {
      const runtime = window.playground;
      const response = await runtime.runPhp(`<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('CREATE TABLE IF NOT EXISTS playground_recovery_contract (id INT PRIMARY KEY, marker VARCHAR(100)) ENGINE=InnoDB');
$statement = $db->prepare('REPLACE INTO playground_recovery_contract VALUES (1, ?)');
$statement->execute([${JSON.stringify(marker)}]);
echo 'seeded';`);
      await runtime.fs.writeFile(file, Uint8Array.from(bytes));
      await runtime.fs.writeFile('/config/.cookies', cookies);
      await runtime.flush();
      // A graceful baseline separates recovery testing from live-save crash durability.
      await runtime.close();
      window.playground = undefined;
      return { status: response.status, text: response.text };
    }, { marker, file, bytes, cookies });
    assert.deepEqual(seeded, { status: 200, text: 'seeded' });
    const original = await storedFingerprint(page, configuration);

    const failedManifest = structuredClone(manifest);
    failedManifest.bridge.moduleUrl = new URL(bridgeFixture, serverURL).href;
    fixtures[manifestFixture] = JSON.stringify(failedManifest);
    fixtures[bridgeFixture] = "export async function createMariaDB() { throw new Error('lite4mariadb: l4m_open failed (1)'); }\n";
    await page.reload({ waitUntil: 'load' });
    page.testStep = 'database startup failure offers recovery without resetting saved data';
    const failed = await page.evaluate(async configuration => {
      const { createPlayground } = await import('./src/playground.mjs');
      try { window.playground = await createPlayground(configuration); return { unexpected: true }; }
      catch (error) { return { code: error.code, message: error.message }; }
    }, configuration);
    assert.equal(failed.code, 'SAVED_DATABASE_START_FAILED');
    assert.match(failed.message, /lite4mariadb: l4m_open failed \(1\)/);
    assert.match(failed.message, /not been reset|unchanged|preserved/i);
    assert.deepEqual(await storedFingerprint(page, configuration), original, 'A failed startup must preserve both saved stores.');

    page.testStep = 'files-only recovery exports original files and cookies without a database';
    const recovery = await page.evaluate(async configuration => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.playground = await createPlayground(configuration, { recovery: true });
      return window.playground.recovery;
    }, configuration);
    assert.equal(recovery.filesOnly, true);
    assert.equal(recovery.databaseAvailable, false);
    const recovered = await page.evaluate(async ({ file }) => {
      const { unzipSync, strFromU8 } = await import('./assets/fflate/browser.js');
      const result = await window.playground.exportRecoveryFiles();
      const names = [];
      const selected = new Set([file.slice(1), 'config/.cookies', 'RECOVERY.txt', 'checkpoint.json']);
      const files = unzipSync(result.bytes, { filter: entry => { names.push(entry.name); return selected.has(entry.name); } });
      return {
        mimeType: result.mimeType, filename: result.filename, names,
        file: [...files[file.slice(1)]], cookies: strFromU8(files['config/.cookies']),
        notice: strFromU8(files['RECOVERY.txt']), manifest: JSON.parse(strFromU8(files['checkpoint.json'])),
      };
    }, { file });
    assert.equal(recovered.mimeType, 'application/zip');
    assert.match(recovered.filename, /recovery.*\.zip$/);
    assert.deepEqual(recovered.file, bytes);
    assert.equal(recovered.cookies, cookies, 'Recovery must preserve saved cookie bytes, including their original formatting.');
    assert.match(recovered.notice, /No database data is included/);
    assert.equal(recovered.names.some(name => /^(?:database\.(?:sql|ndjson)|mariadb\/)/.test(name)), false);
    assert.ok(recovered.manifest.entries.some(entry => entry.path === file.slice(1)));

    const rejected = await page.evaluate(async file => {
      const runtime = window.playground;
      const operations = {
        write: () => runtime.fs.writeFile(file, 'changed'),
        mkdir: () => runtime.fs.mkdir('/persist/www/recovery-mutation'),
        unlink: () => runtime.fs.unlink(file),
        repair: () => runtime.repairConfiguration(),
        save: () => runtime.flush(),
        php: () => runtime.runPhp('<?php unlink(' + JSON.stringify(file) + ');'),
      };
      const results = {};
      for (const [name, operation] of Object.entries(operations)) {
        try { await operation(); results[name] = false; }
        catch { results[name] = true; }
      }
      return results;
    }, file);
    assert.ok(Object.values(rejected).every(Boolean), `Files-only recovery must reject mutations: ${JSON.stringify(rejected)}`);

    page.testStep = 'files-only recovery retains exclusive ownership until closed';
    competitor = await page.context().newPage();
    competitor.on('pageerror', error => extraPageErrors.push(error.message));
    await competitor.goto(new URL('__test__.html', serverURL).href);
    await prepareBrowserEnvironment(competitor);
    const collision = await competitor.evaluate(async configuration => {
      const { createPlayground } = await import('./src/playground.mjs');
      try { window.playground = await createPlayground(configuration, { recovery: true }); return 'unexpected success'; }
      catch (error) { return error.message; }
    }, configuration);
    assert.match(collision, /already open/i);
    await page.evaluate(async () => { await window.playground.close(); window.playground = undefined; });
    const reopened = await competitor.evaluate(async configuration => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.playground = await createPlayground(configuration, { recovery: true });
      const filesOnly = window.playground.recovery.filesOnly;
      await window.playground.close(); window.playground = undefined;
      return filesOnly;
    }, configuration);
    assert.equal(reopened, true, 'Closing recovery must release its site lock.');
    assert.deepEqual(await storedFingerprint(page, configuration), original,
      'Recovery initialization, export, rejected mutations and close must not change any saved file or database record.');

    restoreFixtures();
    await page.reload({ waitUntil: 'load' });
    page.testStep = 'the original database and files reopen after non-destructive recovery';
    const restored = await page.evaluate(async ({ configuration, file }) => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.playground = await createPlayground(configuration);
      const response = await window.playground.runPhp("<?php $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); echo $db->query('SELECT marker FROM playground_recovery_contract WHERE id=1')->fetchColumn();");
      return { status: response.status, marker: response.text, bytes: [...await window.playground.fs.readFile(file)] };
    }, { configuration, file });
    assert.deepEqual(restored, { status: 200, marker, bytes });
    assert.deepEqual(extraPageErrors, [], 'The competing recovery page must not emit uncaught errors.');
    return { databaseFailureRecovery: true, originalFilesAndCookies: true, savedStoresUnchanged: true, exclusiveRecoveryLock: true, originalDatabaseReopened: true };
  } finally {
    restoreFixtures();
    if (competitor && !competitor.isClosed()) {
      await competitor.evaluate(async () => { await window.playground?.close(); }).catch(() => {});
      await competitor.close();
    }
  }
}
