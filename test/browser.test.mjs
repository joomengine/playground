import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { createStaticServer } from './server.mjs';
import { inventory } from '../scripts/assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifestBytes = await readFile(path.join(directory, 'assets/manifest.json'));
const manifest = JSON.parse(manifestBytes);
const guidedTourProgram = await readFile(new URL('./fixtures/guided-tour.php', import.meta.url), 'utf8');
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const inventoryBytes = await readFile(path.join(directory, 'asset-inventory.json'));
const inventorySha256 = createHash('sha256').update(inventoryBytes).digest('hex');
const declaredInventory = JSON.parse(inventoryBytes);
const checkedInventory = async () => assert.deepEqual(
  (await inventory(directory)).filter((file) => file.path !== 'asset-inventory.json'), declaredInventory,
  'The complete static artifact must match its build inventory.',
);
await checkedInventory();
const selection = (name) => process.env[name]?.split(',').map((part) => part.trim()).filter(Boolean);
const browserNames = selection('PLAYGROUND_BROWSERS') || ['chromium', 'firefox'];
const phpVersions = selection('PLAYGROUND_PHP_VERSIONS') || manifest.php.map((entry) => entry.version);
const joomlaVersions = selection('PLAYGROUND_JOOMLA_VERSIONS') || manifest.joomla.map((entry) => entry.version);
const browsers = { chromium, firefox };
const scenarios = selection('PLAYGROUND_SCENARIOS') || ['matrix', 'memory', 'timeout', 'static', 'ui'];
for (const scenario of scenarios) assert.ok(['matrix', 'memory', 'timeout', 'static', 'ui'].includes(scenario), `Unknown scenario: ${scenario}`);
const combinations = manifest.joomla.flatMap((joomla) => joomlaVersions.includes(joomla.version)
  ? joomla.php.filter((php) => phpVersions.includes(php)).map((phpVersion) => ({ phpVersion, joomlaVersion: joomla.version })) : []);
assert.ok(combinations.length, 'Select at least one compatible Joomla/PHP pair from the built manifest.');
for (const name of browserNames) assert.ok(browsers[name], `Unsupported browser: ${name}`);
for (const name of browserNames) await rm(path.join(root, 'test-results', `browser-${name}.json`), { force: true });
for (const php of phpVersions) assert.ok(manifest.php.some((entry) => entry.version === php), `Unknown PHP selection: ${php}`);
for (const joomla of joomlaVersions) assert.ok(manifest.joomla.some((entry) => entry.version === joomla), `Unknown Joomla selection: ${joomla}`);

const PDO = "$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);";
const requestTimeout = 240_000;
const extensionArchive = zipSync({
  'mod_playground_contract.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><extension type="module" client="site" method="upgrade"><name>mod_playground_contract</name><author>JoomEngine</author><version>1.0.0</version><description>Browser integration fixture</description><files><filename module="mod_playground_contract">mod_playground_contract.php</filename></files></extension>'),
  'mod_playground_contract.php': strToU8("<?php defined('_JEXEC') or die; echo 'Playground extension fixture';"),
});
const extensionSha256 = createHash('sha256').update(extensionArchive).digest('hex');

function configuration(pair, extra = {}) {
  return {
    ...pair, siteName: `Browser contract ${pair.joomlaVersion}`, initialPath: '/',
    persistence: true, storageKey: `test-${randomUUID()}`, autoLogin: true, hideToolbar: false,
    admin: { username: 'playgroundtester', name: 'Playground Test Administrator', email: 'playground@example.test', password: 'Playground-test-password-123!' },
    extensions: [], startupCommands: [], ...extra,
  };
}

async function bounded(promise, label, timeoutMs = requestTimeout) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    })]);
  } finally { clearTimeout(timeout); }
}

async function openHarness(context, url, { isolation = true } = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(requestTimeout);
  page.errors = [];
  page.logs = [];
  page.failedSiteRequests = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) page.logs.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().includes('/__site/') && response.status() >= 400) {
      page.failedSiteRequests.push({ url: response.url(), status: response.status() });
    }
  });
  await page.goto(new URL('__test__.html', url).href);
  if (!isolation) {
    assert.equal(await page.evaluate(() => crossOriginIsolated), false, 'The static host fixture must not supply isolation headers.');
    const preparation = await page.evaluate(async () => {
      const { prepareEnvironment } = await import('./src/playground.mjs');
      return prepareEnvironment();
    });
    if (preparation.reloadRequired) await page.reload();
  }
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'The fixture must enable shared memory.');
  return page;
}

async function start(page, config) {
  return bounded(page.evaluate(async (configuration) => {
    const { createPlayground } = await import('./src/playground.mjs');
    window.validationProgress = [];
    window.playground = await createPlayground(configuration, {
      onProgress(progress) { window.validationProgress.push(progress); },
    });
    return { url: window.playground.url, progress: window.validationProgress };
  }, config), 'Joomla installation');
}

async function php(page, code, options = {}) {
  return bounded(page.evaluate(async ({ code, options }) => {
    const response = await window.playground.runPhp(code, options);
    return { status: response.status, text: response.text ?? new TextDecoder().decode(response.body) };
  }, { code, options }), 'PHP request');
}

async function phpJSON(page, code) {
  const result = await php(page, `<?php ${code}`);
  assert.ok(result.status < 400, `PHP returned ${result.status}: ${result.text}`);
  try { return JSON.parse(result.text.trim()); } catch (error) {
    throw new Error(`PHP did not return JSON: ${result.text}`, { cause: error });
  }
}

async function request(page, pathname) {
  return bounded(page.evaluate(async (pathname) => {
    const response = await window.playground.request(pathname);
    return { status: response.status, headers: [...response.headers], text: await response.text() };
  }, pathname), `HTTP ${pathname}`);
}

async function waitForSiteFrame(frame, expectedURL) {
  const expected = new URL(expectedURL);
  // Joomla may navigate a directory URL to its index document during startup.
  await frame.waitForURL((actual) => actual.origin === expected.origin
    && (actual.pathname === expected.pathname || actual.pathname === `${expected.pathname}index.php`),
  { waitUntil: 'load' });
}

async function assertGuidedTour(page) {
  const result = await php(page, guidedTourProgram);
  assert.equal(result.status, 200, result.text);
  const tour = JSON.parse(result.text);
  assert.equal(tour.idType, 'int');
  assert.equal(Number.isInteger(tour.id), true);
  assert.equal(tour.uid, tour.expectedUid, 'TourModel must resolve the native integer ID to its exact UID.');
  assert.equal(typeof tour.uid, 'string');
  assert.ok(tour.uid.length > 0);
  const response = await request(page, `/administrator/index.php?option=com_ajax&plugin=guidedtours&group=system&format=json&id=${tour.id}`);
  assert.equal(response.status, 200, response.text);
  const payload = JSON.parse(response.text);
  assert.equal(payload.success, true, response.text);
  assert.equal(Number(payload.data.id), tour.id);
  assert.ok(Array.isArray(payload.data.steps) && payload.data.steps.length > 0, 'The real guided-tour AJAX response must contain its steps.');
  assert.equal(typeof payload.data.steps[0].title, 'string');
}

async function assertSite(page, config) {
  const frontend = await request(page, '/');
  assert.equal(frontend.status, 200, frontend.text.slice(-4000));
  assert.ok(frontend.text.includes(config.siteName), 'Joomla renders the configured site name.');
  assert.doesNotMatch(frontend.text, /Fatal error:|Uncaught (?:Error|Exception)|Could not connect to/i);
  const administrator = await request(page, '/administrator/');
  assert.equal(administrator.status, 200, administrator.text.slice(-4000));
  assert.match(administrator.text, /com_cpanel|task=logout|value=["']logout["']/i, 'The administrator request must use the authenticated Joomla session.');
  assert.doesNotMatch(administrator.text, /name=["']username["']/i, 'The administrator should not be at the login form.');
  await assertGuidedTour(page);
  const initialURL = await page.evaluate(() => window.playground.url);
  assert.ok(initialURL.endsWith(config.initialPath), 'The configured initial page must be reflected in the iframe URL.');
  for (const pathname of ['/', '/administrator/']) {
    const iframe = await page.evaluate((pathname) => {
      const frame = document.createElement('iframe');
      frame.id = 'site-frame';
      frame.src = new URL(pathname.slice(1), window.playground.baseUrl).href;
      document.body.append(frame);
      return frame.src;
    }, pathname);
    assert.ok(iframe.includes('/__site/'), 'The browser URL routes through the playground service worker.');
    await bounded(page.frameLocator('#site-frame').locator('body').waitFor(), `Service worker iframe ${pathname}`);
    const frame = await page.locator('#site-frame').elementHandle().then((element) => element.contentFrame());
    await waitForSiteFrame(frame, iframe);
    const html = await page.frameLocator('#site-frame').locator('html').innerHTML();
    if (pathname === '/') assert.ok(html.includes(config.siteName));
    else {
      assert.match(html, /com_cpanel|task=logout|value=["']logout["']/i, 'The administrator iframe must render the authenticated dashboard.');
      assert.doesNotMatch(html, /name=["']username["']/i);
    }
    assert.deepEqual(page.failedSiteRequests, [], 'Joomla iframe assets must be served successfully.');
    await page.locator('#site-frame').evaluate((frame) => frame.remove());
  }
}

async function assertPDO(page, pair) {
  const identity = await phpJSON(page, `echo json_encode(['php' => PHP_VERSION, 'drivers' => PDO::getAvailableDrivers(), 'native' => extension_loaded('pdo_mariadb_wasm')], JSON_THROW_ON_ERROR);`);
  assert.equal(identity.native, true, 'The real native extension must be loaded.');
  assert.ok(identity.php.startsWith(`${pair.phpVersion}.`));
  assert.ok(identity.drivers.includes('mysql'));
  const result = await phpJSON(page, `${PDO}
    $db->exec('CREATE TABLE playground_contract (id INT PRIMARY KEY, big BIGINT UNSIGNED, amount DECIMAL(24,6), payload LONGBLOB, nullable VARCHAR(20) NULL) ENGINE=InnoDB');
    $statement = $db->prepare('INSERT INTO playground_contract VALUES (?, ?, ?, ?, ?)');
    $statement->execute([1, '18446744073709551615', '123456789012345678.123456', "before\\0after", null]);
    $row = $db->query('SELECT big, amount, payload, nullable FROM playground_contract WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    $row['payload'] = base64_encode($row['payload']);
    echo json_encode($row, JSON_THROW_ON_ERROR);`);
  assert.deepEqual(result, { big: '18446744073709551615', amount: '123456789012345678.123456', payload: Buffer.from('before\0after').toString('base64'), nullable: null });
  const error = await phpJSON(page, `${PDO}
    try { $db->exec('INSERT INTO playground_contract (id) VALUES (1)'); echo json_encode(['missed' => true]); }
    catch (PDOException $exception) { echo json_encode(['state' => $exception->getCode(), 'number' => $exception->errorInfo[1]], JSON_THROW_ON_ERROR); }`);
  assert.equal(error.state, '23000');
  assert.equal(error.number, 1062);
  const duplicateNames = await phpJSON(page, `${PDO}
    $numeric = $db->query('SELECT 1 AS repeated, 2 AS repeated')->fetch(PDO::FETCH_NUM);
    $associative = $db->query('SELECT 1 AS repeated, 2 AS repeated')->fetch(PDO::FETCH_ASSOC);
    echo json_encode(['numeric' => $numeric, 'associative' => $associative], JSON_THROW_ON_ERROR);`);
  assert.deepEqual(duplicateNames, { numeric: [1, 2], associative: { repeated: 2 } },
    'Repeated SQL column names must retain all positional values and normal PDO associative semantics.');
  const typed = await phpJSON(page, `${PDO}
    $sql = "SELECT CAST(-7 AS SIGNED) AS integer_value, CAST(2147483648 AS UNSIGNED) AS wide_integer, CAST('42' AS CHAR) AS numeric_text, 1.25e0 AS approximate, CAST(1.25 AS DECIMAL(4,2)) AS exact_value";
    $row = $db->query($sql)->fetch(PDO::FETCH_ASSOC);
    $db->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, true);
    $strings = $db->query($sql)->fetch(PDO::FETCH_ASSOC);
    echo json_encode(['values' => $row, 'types' => array_map('get_debug_type', $row), 'strings' => $strings], JSON_THROW_ON_ERROR);`);
  assert.deepEqual(typed, {
    values: { integer_value: -7, wide_integer: '2147483648', numeric_text: '42', approximate: 1.25, exact_value: '1.25' },
    types: { integer_value: 'int', wide_integer: 'string', numeric_text: 'string', approximate: 'float', exact_value: 'string' },
    strings: { integer_value: '-7', wide_integer: '2147483648', numeric_text: '42', approximate: '1.25', exact_value: '1.25' },
  }, 'PDO must preserve native numeric types, string columns and out-of-range precision.');
  for (const retained of [false, true]) {
    const retain = retained ? 'final class RetainedConnection { public static PDO $connection; } RetainedConnection::$connection = $db;' : '';
    await php(page, `<?php ${PDO} ${retain} $db->beginTransaction(); $db->exec('INSERT INTO playground_contract (id) VALUES (2)'); return;`);
    const state = await phpJSON(page, `${PDO} echo json_encode(['count' => $db->query('SELECT COUNT(*) FROM playground_contract')->fetchColumn(), 'transaction' => $db->inTransaction()], JSON_THROW_ON_ERROR);`);
    assert.deepEqual(state, { count: 1, transaction: false }, `Request cleanup must roll back with a ${retained ? 'static' : 'global'} PDO reference.`);
  }
  return identity;
}

async function assertAbnormalShutdown(page, config) {
  for (const ending of ['exit(17);', "trigger_error('Expected request failure', E_USER_ERROR);"]) {
    await assert.rejects(() => php(page, `<?php ${PDO} $db->beginTransaction(); $db->exec('INSERT INTO playground_contract (id) VALUES (2)'); ${ending}`),
      'An abnormal PHP termination must fail the session explicitly.');
    await close(page);
    await start(page, config);
    const state = await phpJSON(page, `${PDO} echo json_encode(['count' => $db->query('SELECT COUNT(*) FROM playground_contract')->fetchColumn(), 'transaction' => $db->inTransaction()], JSON_THROW_ON_ERROR);`);
    assert.deepEqual(state, { count: 1, transaction: false }, `An abandoned native connection must roll back after ${ending}`);
  }
}

async function close(page, reset = false) {
  if (page.isClosed()) return;
  await bounded(page.evaluate(async (reset) => {
    if (!window.playground) return;
    try {
      if (reset) await window.playground.reset();
      else await window.playground.close();
    } finally { window.playground = null; }
  }, reset), reset ? 'Site reset' : 'Worker shutdown', 60_000);
}

for (const name of browserNames) {
  test(`${name}: real Joomla, upstream PHP and native MariaDB PDO`, { timeout: 7_200_000 }, async (t) => {
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await browsers[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}),
      env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1', MOZ_DISABLE_RDD_SANDBOX: '1' } });
    const server = await createStaticServer({ directory, prefix: '/nested/playground/', fixtures: { '__test_extension.zip': extensionArchive } });
    const records = [];
    t.after(async () => { await browser.close(); await server.close(); });
    for (const pair of scenarios.includes('matrix') ? combinations : []) {
      await t.test(`Joomla ${pair.joomlaVersion}, PHP ${pair.phpVersion}: install, PDO and persisted reload`, { timeout: 900_000 }, async () => {
        const context = await browser.newContext();
        const page = await openHarness(context, server.url);
        const config = configuration(pair, {
          initialPath: '/administrator/',
          extensions: [{ url: new URL('__test_extension.zip', server.url).href, sha256: extensionSha256 }],
          startupCommands: [['list']],
        });
        try {
          await start(page, config);
          if (pair.phpVersion === manifest.defaults.phpVersion && pair.joomlaVersion === manifest.defaults.joomlaVersion) {
            const competingPage = await openHarness(context, server.url);
            try {
              await assert.rejects(() => start(competingPage, config), /already open/i,
                'A second tab must not open the same persisted site concurrently.');
            } finally { await competingPage.close(); }
          }
          await assertSite(page, config);
          const installedExtension = await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE element='mod_playground_contract' AND type='module' AND client_id=0")->fetchColumn(), JSON_THROW_ON_ERROR);`);
          assert.equal(installedExtension, 1, 'Joomla must register the configured extension through its installer.');
          const identity = await assertPDO(page, pair);
          await assertAbnormalShutdown(page, config);
          await bounded(page.evaluate(() => window.playground.flush()), 'Durable filesystem and database flush');
          await close(page);
          await page.reload();
          const resumed = await start(page, config);
          await assertSite(page, config);
          const stored = await phpJSON(page, `${PDO} echo json_encode($db->query('SELECT big, amount FROM playground_contract WHERE id=1')->fetch(PDO::FETCH_ASSOC), JSON_THROW_ON_ERROR);`);
          assert.deepEqual(stored, { big: '18446744073709551615', amount: '123456789012345678.123456' });
          assert.deepEqual(page.errors, [], `Uncaught browser errors: ${page.errors.join('\n')}`);
          await close(page, true);
          records.push({ ...pair, php: identity.php, persistedReload: true, nativePDO: true, requestCleanup: true, iframe: true, extensionInstall: true, startupCommand: true, guidedTourModelAndAjax: true });
          console.log(JSON.stringify({ browser: name, ...pair, completed: true, resumedProgress: resumed.progress.map((item) => item.phase) }));
        } catch (error) {
          console.error(JSON.stringify({ browser: name, ...pair, error: error.message, progress: await page.evaluate(() => window.validationProgress).catch(() => null), browserLogs: page.logs.slice(-15).map((line) => line.slice(0, 4000)) }));
          throw error;
        } finally { await close(page).catch(() => {}); await context.close(); }
      });
    }
    const defaultPair = combinations.find((pair) => pair.phpVersion === manifest.defaults.phpVersion && pair.joomlaVersion === manifest.defaults.joomlaVersion) || combinations[0];
    if (scenarios.includes('memory')) await t.test('memory-only installation closes and does not persist data', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = await openHarness(context, server.url);
      const config = configuration(defaultPair, { persistence: false });
      try {
        await start(page, config);
        await assertPDO(page, defaultPair);
        const memorySite = await page.evaluate(async () => {
          await window.playground.fs.writeFile('/persist/www/memory-contract.txt', 'Memory-only file');
          const response = await window.playground.request('/memory-contract.txt');
          return { prefix: window.playground.baseUrl, status: response.status, text: await response.text() };
        });
        assert.equal(memorySite.status, 200);
        assert.equal(memorySite.text, 'Memory-only file');
        const cachedSiteFiles = () => page.evaluate(async (prefix) => {
          const matches = [];
          for (const name of await caches.keys()) {
            for (const request of await (await caches.open(name)).keys()) {
              if (request.url.startsWith(prefix)) matches.push(request.url);
            }
          }
          return matches;
        }, memorySite.prefix);
        assert.deepEqual(await cachedSiteFiles(), [], 'Memory-only files must not enter persistent CacheStorage.');
        await close(page);
        assert.deepEqual(await cachedSiteFiles(), [], 'Closing a memory-only site must leave no cached site files.');
        await start(page, config);
        const result = await phpJSON(page, `${PDO} echo json_encode($db->query("SHOW TABLES LIKE 'playground_contract'")->fetchAll(PDO::FETCH_COLUMN), JSON_THROW_ON_ERROR);`);
        assert.deepEqual(result, [], 'A new memory-only site must not retain the previous database.');
        assert.deepEqual(page.errors, []);
        await close(page);
        records.push({ ...defaultPair, memoryOnly: true });
      } finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('timeout')) await t.test('a timed-out PHP worker fails closed and a persisted site can reopen', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = await openHarness(context, server.url);
      const config = configuration(defaultPair);
      try {
        await start(page, config);
        await assertPDO(page, defaultPair);
        await page.evaluate(() => window.playground.flush());
        const outcome = await bounded(page.evaluate(async (code) => {
          const started = performance.now();
          try { await window.playground.runPhp(code, { timeoutMs: 1_000 }); return { rejected: false }; }
          catch (error) { return { rejected: true, message: error.message, elapsed: performance.now() - started }; }
        }, `<?php ${PDO} $db->beginTransaction(); $db->exec('INSERT INTO playground_contract (id) VALUES (3)'); while (true) {}`), 'Hard worker timeout', 20_000);
        assert.equal(outcome.rejected, true, 'A non-terminating PHP request must reject.');
        assert.match(outcome.message, /timed?\s*out|timeout/i);
        assert.ok(outcome.elapsed < 15_000, 'The parent watchdog must terminate an unresponsive PHP worker.');
        const closed = await page.evaluate(async () => {
          try { await window.playground.runPhp('<?php echo "unexpected";'); return false; } catch { return true; }
        });
        assert.equal(closed, true, 'A terminated runtime must not accept new requests.');
        await close(page);
        await start(page, config);
        const result = await phpJSON(page, `${PDO} echo json_encode($db->query('SELECT COUNT(*) FROM playground_contract')->fetchColumn(), JSON_THROW_ON_ERROR);`);
        assert.equal(result, 1, 'An abandoned uncommitted write must not appear after reopening.');
        await assertSite(page, config);
        assert.deepEqual(page.errors, []);
        await close(page, true);
        records.push({ ...defaultPair, hardTimeout: true, reopenAfterTimeout: true });
      } finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('static')) await t.test('plain static hosting gains isolation through the service worker', { timeout: 900_000 }, async () => {
      const plainServer = await createStaticServer({ directory, prefix: '/pages/project/', isolation: false });
      const context = await browser.newContext();
      let page;
      try {
        page = await openHarness(context, plainServer.url, { isolation: false });
        const config = configuration(defaultPair, { persistence: false });
        await start(page, config);
        await assertSite(page, config);
        assert.deepEqual(page.errors, []);
        await close(page);
        records.push({ ...defaultPair, staticServiceWorkerIsolation: true });
      } finally { if (page) await close(page).catch(() => {}); await context.close(); await plainServer.close(); }
    });
    if (scenarios.includes('ui')) await t.test('the interface launches administration, saves, resets and creates a new site', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      const responseErrors = [];
      page.on('pageerror', (error) => errors.push(error.stack || error.message));
      page.on('response', async (response) => {
        if (!response.url().includes('/__site/') || !['fetch', 'xhr'].includes(response.request().resourceType())) return;
        const text = await response.text().catch(() => '');
        const phpDiagnostic = /<(?:b|strong)>(?:Warning|Deprecated|Fatal error)<|^(?:Warning|Deprecated|Fatal error):/m.test(text);
        const malformedJSON = response.headers()['content-type']?.includes('application/json') && /^\s*</.test(text);
        if (phpDiagnostic || malformedJSON) responseErrors.push({ url: response.url(), status: response.status(), text: text.slice(0, 3000) });
      });
      page.setDefaultTimeout(requestTimeout);
      try {
        const url = new URL(server.url);
        url.searchParams.set('joomla', defaultPair.joomlaVersion);
        url.searchParams.set('php', defaultPair.phpVersion);
        await page.goto(url.href);
        await page.locator('#launch-button:enabled').waitFor();
        await page.locator('#site-name').fill('Interface installation');
        await page.locator('#advanced-settings > summary').click();
        await page.locator('#storage-key').fill(`ui-${randomUUID()}`);
        await page.locator('#initial-path').fill('/administrator/');
        await page.locator('#launch-button').click();
        await page.locator('#site-frame:not([hidden])').waitFor();
        await page.frameLocator('#site-frame').locator('body').waitFor();
        await page.locator('#site-frame').elementHandle().then(async (element) => {
          const frame = await element.contentFrame();
          await waitForSiteFrame(frame, await element.getAttribute('src'));
        });
        assert.match(await page.frameLocator('#site-frame').locator('html').innerHTML(), /com_cpanel|task=logout|value=["']logout["']/i);
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'test-results', `interface-${name}.png`), fullPage: true });
        await page.locator('#save-button').click();
        await page.locator('#status-message').filter({ hasText: /saved/i }).waitFor();
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        assert.equal(await page.locator('#site-frame').isVisible(), false);
        await page.locator('#site-name').fill('Interface installation after reset');
        await page.locator('#initial-path').fill('/');
        await page.locator('#launch-button').click();
        await page.locator('#site-frame:not([hidden])').waitFor();
        await page.frameLocator('#site-frame').locator('body').waitFor();
        await page.locator('#site-frame').elementHandle().then(async (element) => {
          const frame = await element.contentFrame();
          await waitForSiteFrame(frame, await element.getAttribute('src'));
        });
        assert.ok((await page.frameLocator('#site-frame').locator('html').innerHTML()).includes('Interface installation after reset'));
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        assert.deepEqual(errors, [], JSON.stringify(responseErrors));
        assert.deepEqual(responseErrors, [], 'Dashboard AJAX must not contain PHP diagnostics or malformed JSON.');
        records.push({ ...defaultPair, interfaceLaunch: true, interfaceReset: true });
      } finally { await context.close(); }
    });
    assert.equal(records.length, (scenarios.includes('matrix') ? combinations.length : 0) + scenarios.filter((scenario) => scenario !== 'matrix').length,
      'Every selected runtime scenario must pass before writing a receipt.');
    await checkedInventory();
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results', `browser-${name}.json`), `${JSON.stringify({ browser: name, version: browser.version(), manifestSha256, inventorySha256, scenarios, records }, null, 2)}\n`);
  });
}
