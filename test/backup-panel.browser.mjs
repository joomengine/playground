import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));

for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`intentional full backups update atomically and retain download fallback (${name})`, { timeout: 60_000 }, async () => {
    const server = await createStaticServer({ directory }); let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'Saved work' : undefined));
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const [{ createSiteBackups }, { createBackupPanel }] = await Promise.all([import('./src/site-backups.mjs'), import('./src/backup-panel.mjs')]);
        const source = new DOMParser().parseFromString(await (await fetch('./index.html')).text(), 'text/html');
        document.querySelector('main').replaceChildren(document.importNode(source.getElementById('backups-panel'), true));
        window.availableBackupBytes = 1_000_000_000;
        window.backupService = createSiteBackups({ baseURL: location.href,
          estimate: () => ({ usage: 100, quota: window.availableBackupBytes + 100 }) });
        window.backupSource = null; window.archiveNumber = 0; window.downloaded = []; window.removedData = [];
        window.rootBusy = true; window.busyChanges = [];
        window.managed = [{ id: 'live', name: 'Live site', active: true, removable: true },
          { id: 'unidentified-runtime', name: 'Unidentified runtime data', kind: 'runtime', manualOnly: true, removable: true },
          { id: 'old-cache', name: 'Old installation archive', kind: 'cache', size: 123, removable: true }];
        window.backupRuntime = { healthy: true, configuration: { siteName: 'Authoring', storageKey: 'live',
          phpVersion: '8.4', joomlaVersion: '6.2.0', jcbVersion: '6.2.0' } };
        window.panel = createBackupPanel({ element: document.getElementById('backups-panel'), backups: window.backupService,
          getRuntime: () => window.backupRuntime, getSourceBackupId: () => window.backupSource,
          isBlocked: () => window.rootBusy,
          onBusy: value => { window.rootBusy = value; window.busyChanges.push(value); },
          createArchive: async () => ({ bytes: new TextEncoder().encode(`Complete site ${++window.archiveNumber}`),
            metadata: { siteName: 'Authoring', createdAt: new Date().toISOString(), playground: { configuration: window.backupRuntime.configuration } } }),
          onBackupSaved: record => { window.backupSource = record.id; },
          onRestore: async (blob, record) => { window.restored = { contents: await blob.text(), id: record.id }; },
          onDownload: async ({ blob, filename }) => { window.downloaded.push({ contents: await blob.text(), filename }); },
          getManagedEntries: () => window.managed,
          removeManagedEntry: entry => { window.removedData.push(entry.id); window.managed = window.managed.filter(value => value.id !== entry.id); },
        });
        await window.panel.open();
      });
      const rows = page.locator('#backup-list [data-backup-id]');
      assert.equal(await rows.count(), 0);
      assert.equal(await page.evaluate(() => window.archiveNumber), 0, 'Opening the panel never backs up automatically.');
      assert.equal(await page.locator('#backup-current-button').isDisabled(), true);
      await page.evaluate(() => document.getElementById('backup-current-button').dispatchEvent(new Event('click')));
      assert.deepEqual(await page.evaluate(() => window.busyChanges), [], 'A blocked action must not release another operation’s busy state.');
      assert.equal(await page.evaluate(() => window.rootBusy), true);
      await page.evaluate(() => { window.rootBusy = false; window.panel.updateState(); });
      await page.locator('#backup-current-button').click();
      await page.waitForFunction(() => !window.panel.busy && document.querySelectorAll('#backup-list [data-backup-id]').length === 1);
      const id = await rows.first().getAttribute('data-backup-id');
      assert.equal(await page.locator('#backups-message').isVisible(), true);
      assert.match(await page.locator('#backups-message').textContent(), /Backup saved at/);
      assert.match(await rows.first().textContent(), /Joomla 6\.2\.0.*JCB 6\.2\.0.*PHP 8\.4/);
      await page.evaluate(() => { window.rootBusy = true; window.panel.updateState(); });
      assert.equal(await page.locator('#backups-clear-button').isDisabled(), true);
      for (const action of await rows.first().locator('[data-backup-action]').all()) assert.equal(await action.isDisabled(), true);
      await page.evaluate(() => { window.rootBusy = false; window.panel.updateState(); });

      await page.locator('#backup-current-button').click();
      await page.locator('button[data-backup-choice="update"]').click();
      await page.waitForFunction(() => !window.panel.busy && window.archiveNumber === 2);
      assert.equal(await rows.count(), 1);
      assert.equal(await rows.first().getAttribute('data-backup-id'), id);
      assert.equal(await page.evaluate(async id => (await window.backupService.get(id)).blob.text(), id), 'Complete site 2');

      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        window.restoreBackupPut = () => { IDBObjectStore.prototype.put = original; };
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'archives') throw new DOMException('', 'QuotaExceededError');
          return original.apply(this, args);
        };
      });
      await page.locator('#backup-current-button').click();
      await page.locator('button[data-backup-choice="update"]').click();
      await page.waitForFunction(() => !window.panel.busy && window.archiveNumber === 3);
      assert.equal(await rows.count(), 1);
      assert.match(await page.locator('#backups-message').textContent(), /could not store.*previous backup remains unchanged/);
      assert.equal(await page.evaluate(async id => (await window.backupService.get(id)).blob.text(), id), 'Complete site 2', 'A native transaction abort retains the original archive.');
      await page.locator('#backups-download-fallback').click();
      await page.waitForFunction(() => window.downloaded.length === 1);
      const fallback = await page.evaluate(() => window.downloaded[0]);
      assert.equal(fallback.contents, 'Complete site 3');
      assert.match(fallback.filename, /-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.zip$/);
      await page.evaluate(() => window.restoreBackupPut());

      await page.evaluate(() => { window.availableBackupBytes = 1; });
      await page.locator('#backup-current-button').click();
      await page.locator('button[data-backup-choice="new"]').click();
      await page.waitForFunction(() => !window.panel.busy && window.archiveNumber === 4);
      assert.match(await page.locator('#backups-message').textContent(), /not enough browser storage/);
      assert.equal(await rows.count(), 1, 'An insufficient-space new backup adds no false success entry.');

      await page.evaluate(() => { window.availableBackupBytes = 1_000_000_000; });
      await page.locator('#backup-current-button').click();
      await page.locator('button[data-backup-choice="new"]').click();
      await page.waitForFunction(() => !window.panel.busy && document.querySelectorAll('#backup-list [data-backup-id]').length === 2);
      assert.equal(await rows.count(), 2);
      await rows.first().locator('[data-backup-action="restore"]').click();
      await page.waitForFunction(() => Boolean(window.restored));
      assert.equal(await page.evaluate(() => window.restored.contents), 'Complete site 5');

      await page.locator('#backups-clear-button').click();
      await page.waitForFunction(() => !window.panel.busy && document.querySelectorAll('#backup-list [data-backup-id]').length === 0);
      assert.deepEqual(await page.evaluate(() => window.removedData), ['old-cache']);
      assert.deepEqual(await page.evaluate(() => window.managed.map(value => value.id)), ['live', 'unidentified-runtime']);
      assert.equal(await page.locator('#backups-clear-button').isDisabled(), true);
      await page.locator('[data-storage-id="unidentified-runtime"] [data-backup-action="remove-data"]').click();
      await page.waitForFunction(() => !window.panel.busy && window.managed.length === 1);
      assert.deepEqual(await page.evaluate(() => window.removedData), ['old-cache', 'unidentified-runtime']);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
