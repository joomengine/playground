import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';
import { withPinnedCatalog } from './dynamic-catalog-fixture.mjs';

const directory = path.resolve(process.env.PLAYGROUND_DIST || 'dist');
const engines = { chromium, firefox };
const names = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',').map(value => value.trim());
const probePath = 'modules/mod_persistence_contract/probe.php';
const probeSource = `<?php
header('Content-Type: application/json');
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('CREATE TABLE IF NOT EXISTS persistence_contract (id INT PRIMARY KEY, writes INT NOT NULL) ENGINE=InnoDB');
$db->exec('INSERT IGNORE INTO persistence_contract VALUES (1, 0)');
$file = __DIR__ . '/saved.txt';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $db->exec('UPDATE persistence_contract SET writes=writes+1 WHERE id=1');
    file_put_contents($file, 'saved-file-' . $db->query('SELECT writes FROM persistence_contract WHERE id=1')->fetchColumn());
}
echo json_encode(['writes' => (int) $db->query('SELECT writes FROM persistence_contract WHERE id=1')->fetchColumn(),
    'file' => is_file($file) ? file_get_contents($file) : null], JSON_THROW_ON_ERROR);
`;
const archive = zipSync({
  'mod_persistence_contract.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><extension type="module" client="site" method="upgrade"><name>mod_persistence_contract</name><author>JoomEngine</author><version>1.0.0</version><description>Persistence browser contract</description><files><filename module="mod_persistence_contract">mod_persistence_contract.php</filename><filename>probe.php</filename></files></extension>'),
  'mod_persistence_contract.php': strToU8("<?php defined('_JEXEC') or die; echo 'Persistence browser contract';"),
  'probe.php': strToU8(probeSource),
});

async function preview(page) {
  await page.waitForFunction(() => document.getElementById('site-frame')
    || (document.getElementById('error-view') && !document.getElementById('error-view').hidden), undefined, { timeout: 240_000 });
  if (await page.locator('#error-view').isVisible()) {
    throw new Error(`Site launch failed: ${(await page.locator('#error-message').textContent()).slice(0, 1000)}`);
  }
  await page.locator('#site-frame').waitFor({ timeout: 240_000 });
  const frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
  await frame.waitForURL(url => url.pathname.includes('/__site/'), { timeout: 240_000 });
  await frame.locator('body').waitFor();
  return frame;
}

async function previewProbe(page, method = 'GET') {
  const frame = await preview(page);
  return frame.evaluate(async ({ probePath, method }) => {
    const base = location.href.match(/^.*\/__site\/[^/]+\/[^/]+\//)[0];
    const response = await fetch(new URL(probePath, base), { method });
    return { status: response.status, body: await response.json() };
  }, { probePath, method });
}

async function savedStores(page) {
  return page.evaluate(async () => (await indexedDB.databases()).map(entry => entry.name)
    .filter(name => /^\/(?:joomengine-|mariadb\/idb\/joomengine-)/.test(name)).sort());
}

async function openHarness(page, url) {
  await page.goto(new URL('__test__.html', url).href);
  await prepareBrowserEnvironment(page);
}

async function recordFailure(page, name, phase) {
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/site-persistence-${name}-failure.png`, fullPage: true }).catch(() => {});
  const status = await page.locator('#status-message').textContent({ timeout: 1000 }).catch(() => null);
  const error = await page.locator('#error-message').textContent({ timeout: 1000 }).catch(() => null);
  console.error(JSON.stringify({ browser: name, persistencePhase: phase, status, error }));
}

for (const name of names) {
  assert.ok(engines[name], `Unknown persistence-test browser: ${name}`);
  test(`${name}: temporary default, visible saved site and recoverable storage failure`, { timeout: 900_000 }, async t => {
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await engines[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    t.after(() => browser.close());

    await t.test('header Save makes temporary files and SQL visible in Local images and reopens them', { timeout: 420_000 }, async () => {
      const server = await createStaticServer({ directory, fixtures: { '__persistence_module.zip': archive } });
      const context = await withPinnedCatalog(browser);
      const page = await context.newPage();
      page.setDefaultTimeout(240_000);
      const errors = [];
      let phase;
      const step = value => { phase = value; console.log(`${name}: persistence: ${value}`); };
      page.on('pageerror', error => { errors.push(error.message); console.error(`${name}: persistence page error: ${error.message}`); });
      try {
        step('open temporary deployment');
        const url = new URL(server.url);
        for (const [key, value] of Object.entries({ deploy: 'blank', start: '0', name: 'Persistence browser proof',
          key: `temporary-${randomUUID()}`, extension: new URL('__persistence_module.zip', server.url).href })) url.searchParams.set(key, value);
        await page.goto(url.href);
        await page.locator('#embedded-launch:enabled').waitFor({ timeout: 30_000 });
        assert.equal(await page.locator('#persistence').isChecked(), false);
        step('launch temporary Joomla');
        await page.locator('#embedded-launch').click();
        await preview(page);
        assert.match(await page.locator('#save-state').textContent(), /temporary/i);
        await mkdir('test-results', { recursive: true });
        await page.screenshot({ path: `test-results/site-persistence-${name}-temporary.png`, fullPage: true });
        const marker = await previewProbe(page, 'POST');
        assert.deepEqual(marker, { status: 200, body: { writes: 1, file: 'saved-file-1' } });
        assert.deepEqual(await savedStores(page), [], 'A fresh temporary site creates neither native persistent store.');
        await page.locator('#local-images-button').click();
        assert.equal(await page.locator('#images-dialog [data-kind="site"]').count(), 0);
        await page.locator('#images-dialog [data-close-dialog]').click();

        step('save files and database through header');
        await page.locator('#header-save-button').click();
        await page.locator('#header-save-button:enabled').waitFor();
        await preview(page);
        assert.equal(await page.locator('#persistence').isChecked(), true);
        assert.match(await page.locator('#save-state').textContent(), /saved locally/i);
        assert.deepEqual(await previewProbe(page), marker);
        const savedKey = await page.locator('#storage-key').inputValue();
        assert.equal((await savedStores(page)).length, 2, 'One saved site has one PHP and one MariaDB store.');
        await page.locator('#local-images-button').click();
        const row = page.locator(`#images-dialog [data-kind="site"][data-site-key="${savedKey}"]`);
        await row.waitFor();
        assert.match(await row.innerText(), /Persistence browser proof/);
        await page.screenshot({ path: `test-results/site-persistence-${name}-saved.png`, fullPage: true });
        await page.locator('#images-dialog [data-close-dialog]').click();

        // A reload without Close proves durability, not a graceful-shutdown save.
        step('hard reload saved site');
        await page.reload();
        await preview(page);
        assert.equal(await page.locator('#persistence').isChecked(), true);
        assert.equal(await page.locator('#storage-key').inputValue(), savedKey);
        assert.deepEqual(await previewProbe(page), marker);
        if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
        await page.locator('#close-button').click();
        await page.locator('#site-frame').waitFor({ state: 'detached' });
        await page.locator('#local-images-button').click();
        step('reopen saved Local images entry');
        await page.locator(`#images-dialog [data-site-key="${savedKey}"]`).getByRole('button', { name: /^Open saved site:/ }).click();
        await preview(page);
        assert.deepEqual(await previewProbe(page), marker, 'Opening the saved entry restores the same files and database.');
        assert.equal((await savedStores(page)).length, 2, 'Reopening must not allocate another saved-site copy.');
        assert.deepEqual(errors, []);
      } catch (error) {
        await recordFailure(page, name, phase); throw error;
      } finally { await context.close(); await server.close(); }
    });

    await t.test('a worker sync quota failure never replaces a successful PHP response and can be retried', { timeout: 420_000 }, async () => {
      // Inject at the real worker filesystem boundary, rather than fabricating
      // an outer Worker response. No production fault-injection hook is needed.
      const worker = await readFile(path.join(directory, 'src/php-worker.mjs'), 'utf8');
      const initialization = '  binary = await php.binary;';
      assert.equal(worker.split(initialization).length, 2, 'The worker initialization must be instrumented exactly once.');
      const instrumented = worker.replace(initialization, `${initialization}
  const originalSync = binary.FS.syncfs.bind(binary.FS);
  binary.FS.syncfs = (populate, callback) => {
    if (!populate && binary.FS.analyzePath('/tmp/__test_reject_persistence').exists) {
      if (binary.FS.readFile('/tmp/__test_reject_persistence', { encoding: 'utf8' }) === 'once') {
        binary.FS.unlink('/tmp/__test_reject_persistence');
      }
      queueMicrotask(() => callback(new DOMException('', 'QuotaExceededError')));
      return;
    }
    return originalSync(populate, callback);
  };`);
      const server = await createStaticServer({ directory, fixtures: { 'src/php-worker.mjs': instrumented, '__persistence_module.zip': archive } });
      const context = await withPinnedCatalog(browser);
      const page = await context.newPage();
      page.setDefaultTimeout(240_000);
      let phase;
      const step = value => { phase = value; console.log(`${name}: persistence: ${value}`); };
      const config = { deployId: 'blank', persistence: true, storageKey: `quota-${randomUUID()}`, phpVersion: '8.4',
        admin: { username: 'persisttester', name: 'Persistence Test', email: 'persistence@example.test', password: 'Persistence-test-password-123!' },
        extensions: [{ url: new URL('__persistence_module.zip', server.url).href }] };
      const start = () => page.evaluate(async config => {
        const { createPlayground } = await import('./src/playground.mjs');
        window.playground = await createPlayground(config);
      }, config);
      const request = method => page.evaluate(async ({ probePath, method }) => {
        const response = await window.playground.request(`/${probePath}`, { method });
        return { status: response.status, body: await response.json() };
      }, { probePath, method });
      try {
        step('launch saved quota fixture');
        await openHarness(page, server.url);
        await start();
        assert.deepEqual(await request('POST'), { status: 200, body: { writes: 1, file: 'saved-file-1' } });
        step('recover one empty-message quota failure by reclaiming maintained cache');
        await page.evaluate(async () => {
          const { createIndexedDBImageStorage } = await import('./src/deployment-images.mjs');
          window.quotaCache = createIndexedDBImageStorage();
          const bytes = new Uint8Array([1, 2, 3]);
          const record = { sha256: 'a'.repeat(64), size: bytes.byteLength, createdAt: new Date().toISOString() };
          await window.quotaCache.put({ ...record, key: 'server:persistence-quota-test:0', kind: 'server' }, bytes);
          await window.quotaCache.put({ ...record, key: 'custom:persistence-quota-test', kind: 'custom' }, bytes);
          await window.playground.fs.writeFile('/tmp/__test_reject_persistence', 'once');
          await window.playground.flush();
        });
        assert.deepEqual(await page.evaluate(async () => (await window.quotaCache.list()).map(entry => entry.key)),
          ['custom:persistence-quota-test'], 'A quota retry reclaims only replaceable maintained images.');
        assert.deepEqual(await request('GET'), { status: 200, body: { writes: 1, file: 'saved-file-1' } },
          'Storage recovery must not execute the application request again.');
        const savedAt = await page.evaluate(async () => {
          await window.playground.flush();
          await window.playground.fs.writeFile('/tmp/__test_reject_persistence', 'reject durable writes');
          return window.playground.lastSavedAt;
        });
        const marker = { status: 200, body: { writes: 2, file: 'saved-file-2' } };
        step('keep PHP response and live site healthy during persistent quota failure');
        assert.deepEqual(await request('POST'), marker, 'A completed application write returns HTTP 200 despite unavailable storage.');
        const failure = await page.evaluate(async () => {
          let error = null;
          try { await window.playground.flush(); } catch (failure) { error = failure.message; }
          return { error, healthy: window.playground.healthy, lastSavedAt: window.playground.lastSavedAt };
        });
        assert.match(failure.error, /quota/i);
        assert.equal(failure.healthy, true, 'A durability failure must leave the runtime available for recovery.');
        assert.equal(failure.lastSavedAt, savedAt, 'A rejected save must not advance the successful-save receipt.');
        assert.deepEqual(await request('GET'), marker, 'The failed save must neither replay nor roll back the completed PHP request.');
        step('retry save then hard reload exact file and SQL state');
        await page.evaluate(async () => {
          await window.playground.fs.unlink('/tmp/__test_reject_persistence');
          await window.playground.flush();
        });
        await page.reload();
        await prepareBrowserEnvironment(page);
        await start();
        assert.deepEqual(await request('GET'), marker, 'Retrying Save must durably retain the exact file and committed SQL state.');
      } catch (error) {
        await recordFailure(page, `${name}-quota`, phase); throw error;
      } finally { await context.close(); await server.close(); }
    });
  });
}
