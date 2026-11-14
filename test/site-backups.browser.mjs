import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';
import { withPinnedCatalog } from './dynamic-catalog-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
const phpVersion = process.env.PLAYGROUND_PHP_VERSIONS?.split(',')[0] || '8.4';
const joomlaVersion = process.env.PLAYGROUND_JOOMLA_VERSIONS?.split(',')[0] || manifest.defaults.joomlaVersion;
const binary = [0, 255, 65, 0, 128, 10];

for (const browserName of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`full backups remain independent and downloadable during persistent storage failure (${browserName})`, { timeout: 900_000 }, async t => {
    const fixtures = {};
    const server = await createStaticServer({ directory, fixtures });
    let browser;
    t.after(async () => { await browser?.close(); await server.close(); });
    const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await { chromium, firefox }[browserName].launch({ headless: true,
      ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}), ...(executablePath ? { executablePath } : {}) });
    const context = await withPinnedCatalog(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto(new URL('__test__.html', server.url).href);
    await prepareBrowserEnvironment(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const seeded = await page.evaluate(async ({ phpVersion, joomlaVersion, binary }) => {
      const { createPlayground } = await import('./src/playground.mjs');
      const { parseCatalog } = await import('./src/config.mjs');
      const { resolveDeployConfiguration } = await import('./src/deploys.mjs');
      const { createSiteBackups } = await import('./src/site-backups.mjs');
      const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
      const resolved = await resolveDeployConfiguration({ deployId: 'jcb', phpVersion, joomlaVersion,
        persistence: true, storageKey: `backup-source-${crypto.randomUUID()}`, siteName: 'Backup contract JCB', initialPath: '/',
        admin: { username: 'backupcontract', name: 'Backup Contract', email: 'backup@example.test', password: 'Backup-contract-password-123!' },
      }, { catalog, baseURL: location.href });
      window.site = await createPlayground(resolved.configuration);
      window.backups = createSiteBackups({ estimate: async () => ({ quota: 10_000_000_000, usage: 0 }) });
      await window.site.fs.writeFile('/persist/www/backup-proof.txt', 'First saved version');
      await window.site.fs.writeFile('/persist/www/backup-proof.bin', Uint8Array.from(binary));
      const seed = await window.site.runPhp(`<?php
        require '/persist/www/configuration.php'; $prefix = (new JConfig())->dbprefix;
        $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        $id = $db->query('SELECT id FROM ' . $prefix . 'componentbuilder_fieldtype ORDER BY id LIMIT 1')->fetchColumn();
        if (!$id) throw new RuntimeException('The prepared JCB field types are missing.');
        $query = $db->prepare('UPDATE ' . $prefix . 'componentbuilder_fieldtype SET name=? WHERE id=?');
        $query->execute(['Backup field type edit', $id]);
        $db->exec('CREATE TABLE backup_parent (id BIGINT PRIMARY KEY, label VARCHAR(100)) ENGINE=InnoDB');
        $db->exec('CREATE TABLE backup_child (id INT PRIMARY KEY, parent_id BIGINT, nullable_value VARCHAR(100) NULL, executions INT NOT NULL, FOREIGN KEY (parent_id) REFERENCES backup_parent(id)) ENGINE=InnoDB');
        $db->exec("INSERT INTO backup_parent VALUES (9007199254740993, 'Original relationship')");
        $db->exec('INSERT INTO backup_child VALUES (1, 9007199254740993, NULL, 0)');
        echo 'seeded';`);
      if (seed.status !== 200 || seed.text !== 'seeded') throw new Error(`Could not seed the backup contract: ${seed.text}`);
      await window.site.fs.writeFile('/persist/www/backup-state.php', `<?php
        require __DIR__ . '/configuration.php'; $prefix = (new JConfig())->dbprefix;
        $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        if (isset($_GET['mutate'])) {
          $db->exec('UPDATE backup_child SET executions=executions+1 WHERE id=1');
          file_put_contents(__DIR__ . '/backup-proof.txt', 'Latest unsaved version');
        }
        $types = $db->query('SELECT id, name, guid FROM ' . $prefix . 'componentbuilder_fieldtype ORDER BY id LIMIT 5')->fetchAll(PDO::FETCH_ASSOC);
        $fields = $db->query('SELECT id, name, fieldtype FROM ' . $prefix . 'componentbuilder_field ORDER BY id LIMIT 5')->fetchAll(PDO::FETCH_ASSOC);
        $relationship = $db->query('SELECT CAST(p.id AS CHAR) AS parent_id, p.label, c.nullable_value, c.executions FROM backup_parent p JOIN backup_child c ON c.parent_id=p.id')->fetchAll(PDO::FETCH_ASSOC);
        header('Content-Type: application/json');
        echo json_encode(['types'=>$types, 'fields'=>$fields, 'relationship'=>$relationship, 'file'=>file_get_contents(__DIR__ . '/backup-proof.txt')]);`);
      await window.site.flush();
      const state = await (await window.site.request('/backup-state.php')).json();
      return { state, url: window.site.url, backups: await window.backups.list(), configuration: window.site.configuration };
    }, { phpVersion, joomlaVersion, binary });
    assert.deepEqual(seeded.backups, [], 'Starting and editing a live site never creates a backup.');
    assert.equal(seeded.state.types[0].name, 'Backup field type edit');
    assert.equal(seeded.state.relationship[0].parent_id, '9007199254740993');

    const saved = await page.evaluate(async () => {
      window.bundle = await window.site.exportSite({ format: 'bundle', includePlaygroundConfiguration: true });
      const result = await window.backups.saveArchive(window.bundle, { name: 'Deliberate backup', configuration: window.site.configuration });
      window.backupId = result.record?.id;
      return { saved: result.saved, record: result.record, size: window.bundle.bytes.byteLength, url: window.site.url };
    });
    assert.equal(saved.saved, true);
    assert.ok(saved.size > 1_000_000);
    assert.equal(saved.record.size, saved.size);
    assert.equal(saved.record.phpVersion, phpVersion);
    assert.match(saved.record.filename, /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.zip$/);
    assert.equal(saved.url, seeded.url, 'Capturing a backup must not restart the live runtime.');
    t.diagnostic(`Complete edited JCB backup: ${saved.size} bytes (${(saved.size / 1_000_000).toFixed(1)} MB).`);

    const updated = await page.evaluate(async () => {
      await window.site.fs.writeFile('/persist/www/backup-proof.txt', 'Updated saved version');
      window.bundle = await window.site.exportSite({ format: 'bundle', includePlaygroundConfiguration: true });
      const result = await window.backups.saveArchive(window.bundle, { id: window.backupId, name: 'Deliberate backup' });
      const record = await window.backups.get(window.backupId);
      window.savedBlob = record.blob;
      return { result, count: (await window.backups.list()).length, url: window.site.url };
    });
    assert.equal(updated.result.saved, true);
    assert.equal(updated.result.record.id, saved.record.id);
    assert.equal(updated.result.record.revision, 2);
    assert.equal(updated.count, 1, 'Updating a backup must not silently accumulate another archive.');
    assert.equal(updated.url, seeded.url);

    // Fail native IndexedDB after metadata has been queued, proving that a failed
    // replacement rolls back both records and keeps the previous complete archive.
    const failedReplacement = await page.evaluate(async () => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'archives' && this.transaction.db.name.startsWith('joomengine-site-backups:')) {
          throw new DOMException('', 'QuotaExceededError');
        }
        return original.apply(this, args);
      };
      let result;
      try { result = await window.backups.saveArchive(window.bundle, { id: window.backupId }); }
      finally { IDBObjectStore.prototype.put = original; }
      const previous = await window.backups.get(window.backupId);
      const digest = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))];
      return { saved: result.saved, reason: result.reason, revision: previous.revision,
        original: await digest(window.savedBlob), retained: await digest(previous.blob), count: (await window.backups.list()).length };
    });
    assert.equal(failedReplacement.saved, false);
    assert.equal(failedReplacement.reason, 'storage');
    assert.equal(failedReplacement.revision, 2);
    assert.equal(failedReplacement.count, 1);
    assert.deepEqual(failedReplacement.retained, failedReplacement.original);

    const recovery = await page.evaluate(async () => {
      const original = Worker.prototype.postMessage;
      window.restoreFlush = () => { Worker.prototype.postMessage = original; };
      window.rejectedFlushes = 0;
      Worker.prototype.postMessage = function (message, ...options) {
        if (message?.type === 'operation' && message.operation === 'flush') {
          window.rejectedFlushes++;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
            type: 'result', id: message.id, error: 'Browser storage rejected the write (QuotaExceededError).',
            name: 'QuotaExceededError', fatal: false,
          } })));
          return;
        }
        return original.call(this, message, ...options);
      };
      const response = await window.site.request('/backup-state.php?mutate=1');
      const state = await response.json();
      let failure;
      try { await window.site.flush(); } catch (error) { failure = { name: error.name, message: error.message }; }
      // Keep rejecting persistence throughout export. Re-enabling writes here
      // would conceal the quota-recovery bug that the download must solve.
      window.fallbackBundle = await window.site.exportSite({ format: 'bundle', includePlaygroundConfiguration: true });
      const { createSiteBackups } = await import('./src/site-backups.mjs');
      const constrained = createSiteBackups({ estimate: async () => ({ quota: window.fallbackBundle.bytes.byteLength, usage: 1 }) });
      const fallback = await constrained.saveArchive(window.fallbackBundle, { id: window.backupId });
      window.downloadBlob = fallback.archive.blob;
      return { status: response.status, state, failure, rejectedFlushes: window.rejectedFlushes,
        healthy: window.site.healthy, saved: fallback.saved, reason: fallback.reason,
        revision: (await window.backups.get(window.backupId)).revision, size: window.downloadBlob.size };
    });
    assert.equal(recovery.status, 200, 'Completed application writes stay successful when persistence fails.');
    assert.equal(Number(recovery.state.relationship[0].executions), 1, 'A storage retry must never replay the PHP request.');
    assert.equal(recovery.state.file, 'Latest unsaved version');
    assert.equal(recovery.failure.name, 'QuotaExceededError');
    assert.ok(recovery.rejectedFlushes > 0);
    assert.equal(recovery.healthy, true);
    assert.equal(recovery.saved, false);
    assert.equal(recovery.reason, 'space');
    assert.equal(recovery.revision, 2);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(window.downloadBlob); link.download = 'complete-quota-recovery.zip';
      document.body.append(link); link.click(); link.remove();
    });
    const download = await downloadPromise;
    const downloaded = await readFile(await download.path());
    assert.equal(downloaded.length, recovery.size);
    fixtures['complete-quota-recovery.zip'] = downloaded;

    // A genuinely clean browser context has no source IndexedDB, localStorage,
    // cookies or cache from which an incomplete archive could appear to recover.
    const fresh = await withPinnedCatalog(browser);
    const restoredPage = await fresh.newPage();
    restoredPage.setDefaultTimeout(240_000);
    await restoredPage.goto(new URL('__test__.html', server.url).href);
    await prepareBrowserEnvironment(restoredPage);
    const restored = await restoredPage.evaluate(async () => {
      const { readSiteExport, configurationForSiteExport } = await import('./src/site-import.mjs');
      const { createPlayground } = await import('./src/playground.mjs');
      const { parseCatalog } = await import('./src/config.mjs');
      const { createSiteBackups } = await import('./src/site-backups.mjs');
      const initialBackups = await createSiteBackups().list();
      const siteExport = await readSiteExport(new Uint8Array(await (await fetch('./complete-quota-recovery.zip')).arrayBuffer()));
      const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
      const configuration = configurationForSiteExport(siteExport, catalog, { baseURL: location.href });
      const requests = [], originalFetch = window.fetch;
      window.fetch = (...args) => { requests.push(String(args[0])); return originalFetch(...args); };
      try { window.site = await createPlayground(configuration, { siteExport }); }
      finally { window.fetch = originalFetch; }
      const state = await (await window.site.request('/backup-state.php')).json();
      const bytes = [...await window.site.fs.readFile('/persist/www/backup-proof.bin')];
      const administrator = window.site.installation.administrator;
      await window.site.close();
      return { state, bytes, administrator, requests, initialBackups, backups: await createSiteBackups().list() };
    });
    assert.deepEqual(restored.state, recovery.state, 'The full archive restores edited JCB records, their IDs, relationships, nullable values, and latest files.');
    assert.deepEqual(restored.bytes, binary);
    assert.equal(restored.administrator.username, seeded.configuration.admin.username);
    assert.equal(restored.administrator.password, seeded.configuration.admin.password);
    assert.deepEqual(restored.initialBackups, []);
    assert.deepEqual(restored.backups, [], 'Restoring a complete site does not create an implicit backup.');
    assert.equal(restored.requests.some(url => /\.zip(?:\?|$)/.test(url)), false, 'The restored backup needs no original deployment archive.');
    await fresh.close();

    await t.test('uploaded live site persists automatically across reload and Stop / Start without a backup', async () => {
      const uiContext = await withPinnedCatalog(browser);
      const ui = await uiContext.newPage();
      ui.setDefaultTimeout(240_000);
      try {
        await ui.goto(`${server.url}?start=0`);
        await ui.locator('#embedded-launch:enabled').waitFor();
        await ui.locator('#settings-toggle').click();
        await ui.locator('#upload-site-file').setInputFiles({ name: 'complete-quota-recovery.zip', mimeType: 'application/zip', buffer: downloaded });
        const ready = async () => {
          await ui.locator('#site-frame:not([hidden])').waitFor();
          await ui.waitForFunction(() => !document.getElementById('credentials-button').disabled);
          await ui.locator('#save-state').filter({ hasText: /^Saved locally/i }).waitFor();
        };
        const state = () => ui.evaluate(async () => {
          const base = document.getElementById('site-frame').src.match(/^(.*\/__site\/[^/]+\/[^/]+\/)/)?.[1];
          if (!base) throw new Error('The uploaded live site URL is missing.');
          return (await fetch(new URL('backup-state.php', base))).json();
        });
        await ready();
        const key = await ui.locator('#storage-key').inputValue();
        assert.deepEqual(await state(), recovery.state);
        await ui.locator('#save-state').filter({ hasText: /^Saved locally/i }).waitFor();
        await ui.reload();
        await ready();
        assert.equal(await ui.locator('#storage-key').inputValue(), key);
        assert.deepEqual(await state(), recovery.state);
        const companion = await uiContext.newPage();
        const companionWorkers = [];
        companion.on('worker', worker => companionWorkers.push(worker.url()));
        try {
          await companion.goto(server.url);
          await companion.locator('#site-frame:not([hidden])').waitFor({ timeout: 240_000 });
          await companion.waitForFunction(() => !document.getElementById('credentials-button').disabled);
          assert.equal(await companion.locator('#site-frame').getAttribute('src'), await ui.locator('#site-frame').getAttribute('src'),
            'A second Playground window attaches its toolbar to the same live site URL.');
          assert.deepEqual(companionWorkers, [], 'Opening a companion view does not start PHP or MariaDB workers.');
          assert.equal(await companion.locator('#code-button').isEnabled(), true, 'The shared view retains its Code tools.');
          assert.equal(await companion.locator('#database-button').isEnabled(), true, 'The shared view retains its database tools.');
          const shared = await companion.evaluate(async () => {
            const { readActiveRuntimeView, attachRuntimeView } = await import('./src/runtime-views.mjs');
            const view = await attachRuntimeView(readActiveRuntimeView());
            try {
              const bytes = new TextEncoder().encode('Saved through the companion editor queue');
              await view.workspace.withBatch(async workspace => {
                await workspace.request('write', { path: '/companion-proof.txt', bytes,
                  create: true, overwrite: false, expectedRevision: null, expectedCanonicalPath: '/companion-proof.txt' });
              });
              const file = await view.workspace.request('read', { path: '/companion-proof.txt' });
              return { file: new TextDecoder().decode(file.bytes), state: await (await view.request('/backup-state.php')).json(),
                database: await view.openDatabase(), baseUrl: view.baseUrl };
            } finally { view.dispose(); }
          });
          assert.equal(shared.file, 'Saved through the companion editor queue');
          assert.deepEqual(shared.state, recovery.state, 'Companion PHP requests read the same MariaDB records.');
          assert.ok(shared.database.url.startsWith(shared.baseUrl), 'The database tool belongs to the existing owner route.');
          assert.equal(await ui.evaluate(async base => (await fetch(new URL('companion-proof.txt', base))).text(), shared.baseUrl), shared.file,
            'A write through the remote editor appears immediately in the owner filesystem.');
          assert.deepEqual(companionWorkers, [], 'Using remote editor and database tools does not start a second runtime.');
          const popupPromise = uiContext.waitForEvent('page');
          await ui.locator('#nav-site').click({ modifiers: ['Control'] });
          const popup = await popupPromise;
          const popupWorkers = [];
          popup.on('worker', worker => popupWorkers.push(worker.url()));
          try {
            await popup.locator('#site-frame:not([hidden])').waitFor({ timeout: 240_000 });
            await popup.waitForFunction(() => !document.getElementById('credentials-button').disabled);
            assert.ok(new URL(popup.url()).searchParams.has('view'), 'Modified navigation opens a complete companion shell.');
            assert.equal(await popup.locator('#site-frame').getAttribute('src'), shared.baseUrl);
            assert.deepEqual(popupWorkers, [], 'An explicit companion link attaches without runtime workers.');
          } finally { await popup.close(); }
        } finally { await companion.close(); }
        if (!await ui.locator('#settings').isVisible()) await ui.locator('#settings-toggle').click();
        ui.once('dialog', dialog => dialog.accept());
        await ui.locator('#close-button').click();
        await ui.locator('#site-frame').waitFor({ state: 'detached' });
        await ui.locator('#restart-button:enabled').waitFor();
        assert.match(await ui.locator('#restart-button').textContent(), /Start/);
        await ui.locator('#restart-button').click();
        await ready();
        assert.equal(await ui.locator('#storage-key').inputValue(), key);
        assert.deepEqual(await state(), recovery.state);
        if (!await ui.locator('#settings').isVisible()) await ui.locator('#settings-toggle').click();
        await ui.locator('#backup-button').click();
        await ui.locator('#backups-panel').waitFor({ state: 'visible' });
        assert.equal(await ui.locator('#backup-list [data-backup-id]').count(), 0, 'Opening Backups, uploading, reloading and Start never create an archive.');
        assert.deepEqual(await ui.evaluate(async () => (await import('./src/site-backups.mjs')).createSiteBackups().list()), []);
      } finally { await uiContext.close(); }
    });
    await page.evaluate(async () => { window.restoreFlush(); await window.site.close(); });
    assert.deepEqual(errors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile(`test-results/site-backups-${browserName}.json`, JSON.stringify({ browser: browserName,
      archiveBytes: saved.size, updatedInPlace: true, quotaFailurePreservesPrevious: true,
      liveRequestExecutesOnce: true, downloadUnderPersistentQuotaFailure: true,
      restoredInCleanContext: true, jcbRecordsAndFilesRestored: true, automaticLivePersistence: true }, null, 2));
  });
}
