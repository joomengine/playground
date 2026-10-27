import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createStaticServer } from './server.mjs';
import { inventory } from '../scripts/assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifestBytes = await readFile(path.join(directory, 'assets/manifest.json'));
const manifest = JSON.parse(manifestBytes);
const guidedTourProgram = await readFile(new URL('./fixtures/guided-tour.php', import.meta.url), 'utf8');
const bannerAssets = JSON.parse(await readFile(new URL('../dependencies/jcb-banners/assets.json', import.meta.url), 'utf8')).assets;
assert.equal(bannerAssets.length, 7, 'The complete set of JCB sponsor artwork must be audited.');
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
const scenarios = selection('PLAYGROUND_SCENARIOS') || ['matrix', 'memory', 'timeout', 'static', 'ui', 'blueprints', 'export'];
for (const scenario of scenarios) assert.ok(['matrix', 'memory', 'timeout', 'static', 'ui', 'blueprints', 'export'].includes(scenario), `Unknown scenario: ${scenario}`);
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
  'mod_playground_contract.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><extension type="module" client="site" method="upgrade"><name>mod_playground_contract</name><author>JoomEngine</author><version>1.0.0</version><description>Browser integration fixture</description><files><filename module="mod_playground_contract">mod_playground_contract.php</filename><filename>contract.php</filename></files></extension>'),
  'mod_playground_contract.php': strToU8("<?php defined('_JEXEC') or die; echo 'Playground extension fixture';"),
  'contract.php': strToU8(`<?php
header('Content-Type: application/json');
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$path = __DIR__ . '/saved-marker.txt';
if (($_GET['action'] ?? '') === 'seed') {
    $db->exec('CREATE TABLE IF NOT EXISTS playground_ui_contract (id INT PRIMARY KEY, marker VARCHAR(100)) ENGINE=InnoDB');
    $db->exec("REPLACE INTO playground_ui_contract VALUES (1, 'saved through real MariaDB')");
    file_put_contents($path, 'saved through the real PHP filesystem');
}
$exists = (bool) $db->query("SHOW TABLES LIKE 'playground_ui_contract'")->fetchColumn();
echo json_encode(['php' => PHP_VERSION,
    'database' => $exists ? $db->query('SELECT marker FROM playground_ui_contract WHERE id=1')->fetchColumn() : null,
    'file' => is_file($path) ? file_get_contents($path) : null,
], JSON_THROW_ON_ERROR);
`),
});
const extensionSha256 = createHash('sha256').update(extensionArchive).digest('hex');
const curlProof = { proof: 'Native PHP cURL through browser HTTP', nonce: randomUUID() };
const curlCorsProof = { proof: 'Native PHP cURL with browser CORS', nonce: randomUUID() };

function dashboardErrors(html) {
  return [...html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => JSON.parse(match[1])['joomla.messages'] ?? [])
    .flatMap((message) => [...(message.danger ?? []), ...(message.error ?? [])]);
}

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

function observePage(page) {
  let step;
  Object.defineProperty(page, 'testStep', {
    get: () => step,
    set(value) {
      step = value;
      console.log(JSON.stringify({ browser: page.context().browser().browserType().name(), step: value }));
    },
  });
  page.errors = [];
  page.logs = [];
  page.failedSiteRequests = [];
  page.responseErrors = [];
  page.pendingSiteRequests = new Map();
  page.responseChecks = new Set();
  page.on('pageerror', (error) => page.errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) page.logs.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().includes('/__site/')) page.pendingSiteRequests.set(request, {
      url: request.url(), method: request.method(), type: request.resourceType(), started: Date.now(),
    });
  });
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, (request) => page.pendingSiteRequests.delete(request));
  page.on('response', (response) => {
    if (!response.url().includes('/__site/')) return;
    if (response.status() >= 400) page.failedSiteRequests.push({ url: response.url(), status: response.status() });
    if (!['fetch', 'xhr'].includes(response.request().resourceType())) return;
    const checked = (async () => {
      const text = await response.text().catch(() => '');
      const phpDiagnostic = /<(?:b|strong)>(?:Warning|Deprecated|Fatal error)<|^(?:Warning|Deprecated|Fatal error):/m.test(text);
      const malformedJSON = response.headers()['content-type']?.includes('application/json') && /^\s*</.test(text);
      if (phpDiagnostic || malformedJSON) page.responseErrors.push({ url: response.url(), status: response.status(), text: text.slice(0, 3000) });
    })();
    page.responseChecks.add(checked);
    checked.finally(() => page.responseChecks.delete(checked));
  });
  return page;
}

async function saveBrowserDiagnostics(page, name, error) {
  const state = await page.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent;
    const frame = document.getElementById('site-frame');
    return {
      url: location.href, readyState: document.readyState,
      status: text('status-message'), loading: text('loading-message'), error: text('error-message'),
      iframe: frame ? { src: frame.getAttribute('src'), hidden: frame.hidden, connected: frame.isConnected } : null,
      progress: window.validationProgress,
    };
  }).catch((failure) => ({ unavailable: failure.message }));
  const frames = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(), state: await frame.evaluate(() => ({ readyState: document.readyState,
      body: document.body?.innerText.slice(0, 2000), title: document.title,
    })).catch((failure) => ({ unavailable: failure.message })),
  })));
  const diagnostics = {
    message: error.stack || error.message, step: page.testStep, state, frames,
    errors: page.errors, logs: page.logs?.slice(-30), failedSiteRequests: page.failedSiteRequests,
    responseErrors: page.responseErrors, pendingSiteRequests: [...(page.pendingSiteRequests?.values() || [])],
  };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', `${name}-failure.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  await page.screenshot({ path: path.join(root, 'test-results', `${name}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ diagnostic: name, ...diagnostics }));
}

async function openHarness(context, url, { isolation = true } = {}) {
  const page = observePage(await context.newPage());
  page.setDefaultTimeout(requestTimeout);
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

async function startBlueprint(page, query, extra = {}) {
  return bounded(page.evaluate(async ({ query, extra }) => {
    const { readURLConfiguration, parseCatalog } = await import('./src/config.mjs');
    const { loadBlueprintCatalog, resolveBlueprintConfiguration } = await import('./src/blueprints.mjs');
    const { createPlayground } = await import('./src/playground.mjs');
    const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
    const blueprintCatalog = await loadBlueprintCatalog();
    const input = { ...readURLConfiguration(new URL(`?${query}`, location.href)).config, ...extra };
    const resolved = await resolveBlueprintConfiguration(input, { catalog, blueprintCatalog, baseURL: location.href });
    window.validationProgress = [];
    window.playground = await createPlayground(resolved.configuration, { onProgress(progress) { window.validationProgress.push(progress); } });
    return { configuration: { ...resolved.configuration, admin: undefined }, installation: { ...window.playground.installation, administrator: undefined }, progress: window.validationProgress };
  }, { query, extra }), 'Blueprint installation');
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
  const sitePrefix = expected.pathname.match(/^.*\/__site\/[^/]+\/[^/]+\//)?.[0];
  assert.ok(sitePrefix, 'A preview must belong to a running playground instance.');
  // Joomla may redirect to its index document or a language-specific home page.
  await frame.waitForURL((actual) => actual.origin === expected.origin
    && actual.pathname.startsWith(sitePrefix),
  { waitUntil: 'load' });
}

async function renderedSiteFrame(page) {
  await page.waitForFunction(() => document.getElementById('site-frame')
    || (document.getElementById('error-view') && !document.getElementById('error-view').hidden));
  assert.equal(await page.locator('#error-view').isVisible(), false,
    await page.locator('#error-message').textContent());
  await page.locator('#site-frame:not([hidden])').waitFor();
  const element = await page.locator('#site-frame').elementHandle();
  const expectedURL = await element.getAttribute('src');
  assert.ok(expectedURL?.includes('/__site/'), 'The preview must point to an active playground site.');
  const frame = await element.contentFrame();
  assert.ok(frame, 'The preview must have an attached browsing context.');
  await waitForSiteFrame(frame, expectedURL);
  await frame.locator('body').waitFor();
  return frame;
}

async function previewContract(page, action = 'read') {
  const response = await bounded(page.evaluate(async (action) => {
    const frame = document.getElementById('site-frame');
    const source = new URL(frame.src);
    const prefix = source.pathname.match(/^.*\/__site\/[^/]+\/[^/]+\//)?.[0];
    if (!prefix) throw new Error('The active preview has no site route.');
    const url = new URL(`${prefix}modules/mod_playground_contract/contract.php`, source);
    url.searchParams.set('action', action);
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
  }, action), `Preview data ${action}`);
  assert.equal(response.status, 200, response.text);
  return JSON.parse(response.text);
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
    const frame = await page.locator('#site-frame').elementHandle().then((element) => element.contentFrame());
    await waitForSiteFrame(frame, iframe);
    await bounded(frame.locator('body').waitFor(), `Service worker iframe ${pathname}`);
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
    const fixtures = { '__test_extension.zip': extensionArchive, '__test_curl.json': JSON.stringify(curlProof) };
    const server = await createStaticServer({ directory, prefix: '/nested/playground/', fixtures });
    const corsServer = await createStaticServer({ directory, prefix: '/cors/', corsOrigin: new URL(server.url).origin,
      corsPaths: ['allowed.json'], fixtures: {
        'allowed.json': (request) => JSON.stringify({ ...curlCorsProof, header: request.headers['x-playground-proof'] ?? null }),
        'denied.json': JSON.stringify({ confidential: randomUUID() }),
      } });
    const records = [];
    t.after(async () => { await browser.close(); await server.close(); await corsServer.close(); });
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
          await saveBrowserDiagnostics(page, `${name}-${pair.joomlaVersion}-${pair.phpVersion}`, error);
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
    if (scenarios.includes('blueprints')) await t.test('repository and URL recipes install actual components, languages and prepared content', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = await openHarness(context, server.url);
      const proof = [];
      const setup = () => ({ admin: configuration(defaultPair).admin, persistence: false, storageKey: `blueprint-${randomUUID()}` });
      try {
        const componentCases = [
          ...combinations.map((pair) => ({ id: 'jcb', version: pair.joomlaVersion, phpVersion: pair.phpVersion, element: 'com_componentbuilder' })),
          { id: 'patchtester', version: defaultPair.joomlaVersion, element: 'com_patchtester' },
          { id: 'weblinks', version: defaultPair.joomlaVersion, element: 'com_weblinks' },
        ];
        for (const item of componentCases) {
          page.testStep = `${item.id} on Joomla ${item.version}, PHP ${item.phpVersion ?? defaultPair.phpVersion}`;
          const result = await startBlueprint(page, new URLSearchParams({ blueprint: item.id, joomla: item.version, php: item.phpVersion ?? defaultPair.phpVersion }).toString(), setup());
          const registered = await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE type='component' AND element='${item.element}'")->fetchColumn(), JSON_THROW_ON_ERROR);`);
          assert.equal(registered, 1, `${item.id} must be installed and enabled by Joomla.`);
          const component = await request(page, `/administrator/index.php?option=${item.element}`);
          assert.equal(component.status, 200, component.text.slice(0, 3000));
          assert.doesNotMatch(component.text, /name\s*=\s*["']passwd["']|Fatal error|Class .* not found|Call to undefined/i, 'The installed component must render in an authenticated administrator session.');
          assert.match(component.text, new RegExp(item.element));
          assert.ok(result.configuration.extensions.length > 0);
          if (item.id === 'jcb') {
            assert.deepEqual(dashboardErrors(component.text), [], 'JCB must not report missing requirements or fatal configuration errors.');
            const installedArtwork = await bounded(page.evaluate(async (assets) => {
              const results = [];
              for (const asset of assets) {
                const relative = `administrator/components/com_componentbuilder/assets/images/banner/${asset.name}`;
                const response = await fetch(new URL(relative, window.playground.baseUrl), { cache: 'no-store' });
                const bytes = await response.arrayBuffer();
                const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
                results.push({ name: asset.name, status: response.status, mime: response.headers.get('Content-Type'), size: bytes.byteLength, sha256: digest });
              }
              return results;
            }, bannerAssets), 'Installed JCB artwork');
            for (const [index, image] of installedArtwork.entries()) {
              assert.equal(image.status, 200, `${image.name} must be served by the installed site.`);
              assert.match(image.mime, /^image\//);
              assert.equal(image.size, bannerAssets[index].size, image.name);
              assert.equal(image.sha256, bannerAssets[index].sha256, image.name);
            }
            const curlURL = Buffer.from(new URL('__test_curl.json', server.url).href).toString('base64');
            const http = await phpJSON(page, `
              if (!extension_loaded('curl')) { echo json_encode(['loaded'=>false]); return; }
              $http = curl_init(base64_decode('${curlURL}'));
              curl_setopt_array($http, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>15]);
              $body = curl_exec($http);
              echo json_encode(['loaded'=>true, 'status'=>curl_getinfo($http, CURLINFO_RESPONSE_CODE),
                'body'=>$body, 'error'=>curl_error($http)], JSON_THROW_ON_ERROR);`);
            assert.equal(http.loaded, true, 'JCB requires the real native cURL extension.');
            assert.equal(http.status, 200, http.error);
            assert.equal(http.error, '');
            assert.deepEqual(JSON.parse(http.body), curlProof, 'Native PHP cURL must receive the actual HTTP fixture response.');
            const corsURL = Buffer.from(new URL('allowed.json', corsServer.url).href).toString('base64');
            const cors = await phpJSON(page, `
              $http = curl_init(base64_decode('${corsURL}'));
              curl_setopt_array($http, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>15,
                CURLOPT_HTTPHEADER=>['X-Playground-Proof: cors-check']]);
              $body = curl_exec($http);
              echo json_encode(['status'=>curl_getinfo($http, CURLINFO_RESPONSE_CODE), 'body'=>$body,
                'error'=>curl_error($http)], JSON_THROW_ON_ERROR);`);
            assert.equal(cors.status, 200, cors.error);
            assert.equal(cors.error, '');
            assert.deepEqual(JSON.parse(cors.body), { ...curlCorsProof, header: 'cors-check' }, 'PHP cURL must honor a real CORS preflight and preserve its request headers.');
            const deniedURL = Buffer.from(new URL('denied.json', corsServer.url).href).toString('base64');
            const denied = await phpJSON(page, `
              $http = curl_init(base64_decode('${deniedURL}'));
              curl_setopt_array($http, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>15]);
              $body = curl_exec($http);
              echo json_encode(['body'=>$body, 'error'=>curl_error($http), 'errno'=>curl_errno($http)], JSON_THROW_ON_ERROR);`);
            assert.equal(denied.body, false, 'A response without CORS permission must remain inaccessible to PHP.');
            assert.ok(denied.errno > 0 && denied.error.length > 0, 'CORS rejection must be a visible cURL transport error.');
            const spreadsheet = await phpJSON(page, `
              require '/persist/www/libraries/phpspreadsheet/vendor/autoload.php';
              $book = new \\PhpOffice\\PhpSpreadsheet\\Spreadsheet();
              $book->getActiveSheet()->setCellValue('A1', 'JoomEngine browser spreadsheet');
              $book->getActiveSheet()->setCellValue('B2', 42);
              (new \\PhpOffice\\PhpSpreadsheet\\Writer\\Xlsx($book))->save('/tmp/browser-spreadsheet.xlsx');
              $restored = \\PhpOffice\\PhpSpreadsheet\\IOFactory::load('/tmp/browser-spreadsheet.xlsx');
              echo json_encode(['text'=>$restored->getActiveSheet()->getCell('A1')->getValue(),
                'number'=>$restored->getActiveSheet()->getCell('B2')->getValue(),
                'bytes'=>filesize('/tmp/browser-spreadsheet.xlsx'), 'integerSize'=>PHP_INT_SIZE], JSON_THROW_ON_ERROR);
              unlink('/tmp/browser-spreadsheet.xlsx');`);
            assert.equal(spreadsheet.text, 'JoomEngine browser spreadsheet');
            assert.equal(spreadsheet.number, 42);
            assert.ok(spreadsheet.bytes > 0);
            assert.equal(spreadsheet.integerSize, 4, 'The official dependency solution must actually operate on upstream wasm32 PHP.');
          }
          proof.push({ ...item, administrator: true });
          await close(page);
        }
        page.testStep = 'Dutch URL recipe with explicit logged-out session and extension command';
        const dutch = await startBlueprint(page, new URLSearchParams({
          blueprint: 'blank', joomla: '5.4', php: defaultPair.phpVersion, language: 'nl-NL', login: 'no',
          extension: new URL('__test_extension.zip', server.url).href, commands: JSON.stringify([['list']]),
        }).toString(), setup());
        assert.equal(dutch.configuration.joomlaVersion, manifest.joomla.find((entry) => entry.version.startsWith('5.4.')).version);
        const frontend = await request(page, '/');
        assert.equal(frontend.status, 200, frontend.text.slice(0, 1000));
        assert.match(frontend.text, /<html[^>]+lang=["']nl-NL["']/i);
        const admin = await request(page, '/administrator/');
        assert.match(admin.text, /name\s*=\s*["']passwd["']/i, 'login=no must leave the actual administrator unauthenticated.');
        assert.equal(await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE element='mod_playground_contract'")->fetchColumn());`), 1);
        proof.push({ id: 'blank', language: 'nl-NL', autoLogin: false, urlExtension: true, urlCommand: true });
        await close(page);
        for (const fresh of [false, true]) {
          page.testStep = `heritage ${fresh ? 'fresh recipe' : 'prepared snapshot'}`;
          const result = await startBlueprint(page, new URLSearchParams({ blueprint: 'heritage-demo', php: defaultPair.phpVersion, ...(fresh ? { fresh: '1' } : {}) }).toString(), setup());
          assert.equal(Boolean(result.installation.fromSnapshot), !fresh, 'fresh=1 must bypass the verified prepared archive.');
          const content = await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT language, COUNT(*) AS articles FROM jml_content WHERE state=1 GROUP BY language ORDER BY language")->fetchAll(PDO::FETCH_ASSOC), JSON_THROW_ON_ERROR);`);
          assert.ok(content.some((entry) => entry.language === 'en-GB' && entry.articles > 0));
          assert.ok(content.some((entry) => entry.language === 'nl-NL' && entry.articles > 0));
          const siteURL = await page.evaluate(() => {
            const frame = document.createElement('iframe');
            frame.id = 'site-frame'; frame.src = window.playground.url;
            document.body.append(frame);
            return frame.src;
          });
          const frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
          await waitForSiteFrame(frame, siteURL);
          assert.match(await frame.locator('body').innerText(), /Stories connect generations/);
          assert.ok(await frame.locator('.mod-languages').count() > 0, 'The actual multilingual home page must offer its language switcher.');
          await page.locator('#site-frame').evaluate((frame) => frame.remove());
          proof.push({ id: 'heritage-demo', fresh, fromSnapshot: Boolean(result.installation.fromSnapshot), content });
          await close(page);
        }
        page.testStep = 'default domain automatically opens JCB';
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(server.url);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#blueprint').inputValue(), 'jcb');
        assert.match(await page.frameLocator('#site-frame').locator('html').innerHTML(), /com_componentbuilder/);
        assert.equal(await page.frameLocator('#site-frame').locator('input[name="passwd"]').count(), 0);
        assert.deepEqual(dashboardErrors(await page.frameLocator('#site-frame').locator('html').innerHTML()), [],
          'The default JCB dashboard must be free of missing-runtime requirement alerts.');
        assert.deepEqual(page.failedSiteRequests.filter((item) => /\.(?:css|m?js|svg|png|gif|jpe?g|webp|woff2?|ttf)$/i.test(new URL(item.url).pathname)), [],
          'The actual JCB interface and heritage pages must load their local scripts, styles, fonts and images.');
        if (name === 'chromium') {
          await mkdir(path.join(root, 'test-results'), { recursive: true });
          await page.screenshot({ path: path.join(root, 'test-results/jcb-desktop.png'), fullPage: true });
        }
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        proof.push({ id: 'jcb', defaultDomainAutostart: true });
        assert.deepEqual(page.errors, []);
        records.push({ ...defaultPair, blueprints: proof });
      } catch (error) { await saveBrowserDiagnostics(page, `blueprints-${name}`, error); throw error; }
      finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('export')) await t.test('portable export restores exact files, SQL values, views and triggers in a new database', { timeout: 900_000 }, async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await openHarness(context, server.url);
      const config = configuration(defaultPair, { persistence: false });
      try {
        page.testStep = 'install export source';
        await start(page, config);
        await assertPDO(page, defaultPair);
        const ddl = await php(page, `<?php ${PDO}
          $db->exec('CREATE TABLE export_trigger (id INT PRIMARY KEY, value VARCHAR(100), audit VARCHAR(100)) ENGINE=InnoDB');
          $db->exec("CREATE TRIGGER export_before_insert BEFORE INSERT ON export_trigger FOR EACH ROW SET NEW.audit=CONCAT('checked:', NEW.value)");
          $db->exec("INSERT INTO export_trigger (id,value) VALUES (1,'before export')");
          $insert = $db->prepare('INSERT INTO export_trigger (id,value) VALUES (?,?)');
          for ($i=2; $i<=275; $i++) $insert->execute([$i, 'pagination-'.$i]);
          $db->exec('CREATE VIEW export_view_first AS SELECT id,value,audit FROM export_trigger');
          $db->exec('CREATE VIEW export_view_second AS SELECT id,value,audit FROM export_view_first');
          file_put_contents('/persist/www/export-proof.bin', hex2bin('0001ff5c273b0a'));
          echo 'created';`);
        assert.equal(ddl.status, 200, ddl.text);
        const expected = await phpJSON(page, `${PDO} echo json_encode(['numbers'=>$db->query('SELECT big,amount,HEX(payload) AS payload,nullable FROM playground_contract WHERE id=1')->fetch(PDO::FETCH_ASSOC),'view'=>$db->query('SELECT * FROM export_view_second')->fetchAll(PDO::FETCH_ASSOC)], JSON_THROW_ON_ERROR);`);
        page.testStep = 'download export';
        const downloading = page.waitForEvent('download');
        await bounded(page.evaluate(async () => {
          const result = await window.playground.exportSite({ format: 'bundle' });
          const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
          const link = Object.assign(document.createElement('a'), { href: url, download: result.filename });
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }), 'Portable bundle export');
        const bytes = await readFile(await (await downloading).path());
        const archive = unzipSync(bytes);
        const metadata = JSON.parse(strFromU8(archive['export.json']));
        assert.equal(metadata.joomlaVersion, defaultPair.joomlaVersion);
        assert.doesNotMatch(strFromU8(archive['site/configuration.php']), /\/persist\/|\/__site\//, 'The deployment configuration must use ordinary server paths.');
        assert.deepEqual(archive['site/export-proof.bin'], new Uint8Array([0, 1, 255, 92, 39, 59, 10]));
        assert.match(strFromU8(archive['database.sql']), /CREATE.*TRIGGER/s);
        fixtures['__test_snapshot.zip'] = bytes;
        await close(page);
        page.testStep = 'restore export into a fresh runtime';
        await start(page, { ...configuration(defaultPair, { persistence: false }), snapshot: {
          url: new URL('__test_snapshot.zip', server.url).href, sha256: createHash('sha256').update(bytes).digest('hex'), joomlaVersion: defaultPair.joomlaVersion,
        } });
        assert.equal(await page.evaluate(() => window.playground.installation.fromSnapshot), true);
        const actual = await phpJSON(page, `${PDO} echo json_encode(['numbers'=>$db->query('SELECT big,amount,HEX(payload) AS payload,nullable FROM playground_contract WHERE id=1')->fetch(PDO::FETCH_ASSOC),'view'=>$db->query('SELECT * FROM export_view_second')->fetchAll(PDO::FETCH_ASSOC)], JSON_THROW_ON_ERROR);`);
        assert.deepEqual(actual, expected, 'A portable restore must preserve exact SQL values and dependent views.');
        const triggered = await phpJSON(page, `${PDO} $db->exec("INSERT INTO export_trigger (id,value) VALUES (276,'after restore')"); echo json_encode($db->query('SELECT audit FROM export_trigger WHERE id=276')->fetchColumn());`);
        assert.equal(triggered, 'checked:after restore', 'The restored trigger must execute against the new database.');
        const file = await page.evaluate(async () => [...await window.playground.fs.readFile('/persist/www/export-proof.bin')]);
        assert.deepEqual(file, [0, 1, 255, 92, 39, 59, 10]);
        await assertSite(page, config);
        assert.deepEqual(page.errors, []);
        records.push({ ...defaultPair, exportRoundTrip: true, exactSQL: true, files: true, dependentViews: true, trigger: true });
      } catch (error) { await saveBrowserDiagnostics(page, `export-${name}`, error); throw error; }
      finally { delete fixtures['__test_snapshot.zip']; await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('ui')) await t.test('the interface preserves files and SQL across PHP changes and reloads, exports and resets', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = observePage(await context.newPage());
      page.setDefaultTimeout(requestTimeout);
      try {
        const url = new URL(server.url);
        url.searchParams.set('joomla', defaultPair.joomlaVersion);
        url.searchParams.set('php', defaultPair.phpVersion);
        url.searchParams.set('blueprint', 'blank');
        url.searchParams.set('start', '0');
        await page.goto(url.href);
        await page.locator('#launch-button:enabled').waitFor();
        await page.locator('#site-name').fill('Interface installation');
        await page.locator('#advanced-settings > summary').click();
        await page.locator('#storage-key').fill(`ui-${randomUUID()}`);
        await page.locator('#initial-path').fill('/administrator/');
        await page.locator('#extensions').fill(JSON.stringify([{ url: new URL('__test_extension.zip', server.url).href, sha256: extensionSha256 }]));
        await page.locator('#startup-commands').fill(JSON.stringify([['list']]));
        page.testStep = 'launch administrator';
        await page.locator('#launch-button').click();
        await renderedSiteFrame(page);
        assert.match(await page.frameLocator('#site-frame').locator('html').innerHTML(), /com_cpanel|task=logout|value=["']logout["']/i);
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'test-results', `interface-${name}.png`), fullPage: true });
        const marker = await previewContract(page, 'seed');
        assert.equal(marker.database, 'saved through real MariaDB');
        assert.equal(marker.file, 'saved through the real PHP filesystem');
        page.testStep = 'save site';
        await page.locator('#save-button').click();
        await page.locator('#status-message').filter({ hasText: /saved/i }).waitFor();
        const changedPHP = manifest.joomla.find((entry) => entry.version === defaultPair.joomlaVersion).php.find((version) => version !== defaultPair.phpVersion);
        assert.ok(changedPHP, 'The interface contract needs two compatible PHP versions.');
        page.testStep = 'switch PHP with saved files and database';
        const originalFrame = await page.locator('#site-frame').getAttribute('src');
        await page.locator('#php-version').selectOption(changedPHP);
        await page.waitForFunction((previous) => {
          const frame = document.getElementById('site-frame');
          return frame && frame.getAttribute('src') !== previous;
        }, originalFrame);
        await renderedSiteFrame(page);
        const afterSwitch = await previewContract(page);
        assert.deepEqual(afterSwitch, { ...marker, php: manifest.php.find((entry) => entry.version === changedPHP).patchVersion });
        page.testStep = 'reopen saved site from origin';
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        await page.goto(server.url);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#php-version').inputValue(), changedPHP);
        assert.equal(await page.locator('#blueprint').inputValue(), 'blank');
        assert.deepEqual(await previewContract(page), afterSwitch);
        const publicPreferences = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('joomengine:launch:'))));
        assert.doesNotMatch(JSON.stringify(publicPreferences), /"(?:password|admin|administrator)"\s*:/, 'Automatic-resume preferences must not expose administrator credentials.');
        page.testStep = 'download portable files and database';
        await page.locator('#export-format').selectOption('bundle');
        const downloaded = page.waitForEvent('download');
        await page.locator('#export-button').click();
        const download = await downloaded;
        const exported = unzipSync(await readFile(await download.path()));
        for (const filename of ['site/configuration.php', 'database.sql', 'database.ndjson', 'DEPLOYMENT.md', 'export.json']) assert.ok(exported[filename], `The deployment bundle must include ${filename}.`);
        assert.equal(strFromU8(exported['site/modules/mod_playground_contract/saved-marker.txt']), marker.file);
        assert.match(strFromU8(exported['database.sql']), /playground_ui_contract/);
        assert.equal(JSON.parse(strFromU8(exported['export.json'])).joomlaVersion, defaultPair.joomlaVersion);
        assert.ok(!Object.keys(exported).some((filename) => /(?:^|\/)administrator\.json$/.test(filename)), 'Private browser administrator metadata must stay out of the deployment bundle.');
        await page.locator('#export-button:enabled').waitFor();
        page.testStep = 'fresh URL creates an independent saved site';
        const savedKey = await page.locator('#storage-key').inputValue();
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        const freshURL = new URL(server.url);
        for (const [key, value] of Object.entries({ blueprint: 'blank', joomla: defaultPair.joomlaVersion, php: changedPHP, key: savedKey, fresh: '1', extension: new URL('__test_extension.zip', server.url).href })) freshURL.searchParams.set(key, value);
        await page.goto(freshURL.href);
        await renderedSiteFrame(page);
        const freshKey = await page.locator('#storage-key').inputValue();
        assert.notEqual(freshKey, savedKey, 'fresh=1 must give the new saved site its own storage key.');
        assert.equal(new URL(page.url()).searchParams.has('fresh'), false, 'Reloading the new site must resume it instead of repeatedly creating sites.');
        assert.equal((await previewContract(page)).database, null);
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        const savedURL = new URL(server.url);
        savedURL.searchParams.set('key', savedKey);
        await page.goto(savedURL.href);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#storage-key').inputValue(), savedKey);
        assert.deepEqual(await previewContract(page), afterSwitch, 'A fresh URL must leave the original saved site intact.');
        page.testStep = 'new site control preserves saved sites';
        await page.locator('#new-site-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        assert.notEqual(await page.locator('#storage-key').inputValue(), savedKey);
        assert.equal(await page.locator('#site-frame').count(), 0);
        await page.locator('#launch-button').click();
        await renderedSiteFrame(page);
        assert.equal((await previewContract(page)).database, null, 'New site must install an independent database.');
        await page.locator('#saved-site').selectOption(savedKey);
        await renderedSiteFrame(page);
        assert.deepEqual(await previewContract(page), afterSwitch, 'The saved-site selector must reopen the original files and database.');
        page.testStep = 'reset site';
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('#reset-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        assert.equal(await page.locator('#site-frame').isVisible(), false);
        await page.locator('#site-name').fill('Interface installation after reset');
        if (await page.locator('#advanced-settings').getAttribute('open') === null) await page.locator('#advanced-settings > summary').click();
        await page.locator('#initial-path').fill('/');
        page.testStep = 'launch site after reset';
        await page.locator('#launch-button').click();
        await renderedSiteFrame(page);
        assert.ok((await page.frameLocator('#site-frame').locator('html').innerHTML()).includes('Interface installation after reset'));
        const afterReset = await previewContract(page);
        assert.equal(afterReset.database, null, 'Reset must remove the previous MariaDB data.');
        assert.equal(afterReset.file, null, 'Reset must remove the previous site files.');
        page.testStep = 'close site';
        await page.locator('#close-button').click();
        await page.locator('#launch-button:enabled').waitFor();
        await bounded(Promise.allSettled([...page.responseChecks]), 'Read dashboard responses', 10_000);
        assert.deepEqual(page.errors, [], JSON.stringify(page.responseErrors));
        assert.deepEqual(page.responseErrors, [], 'Dashboard AJAX must not contain PHP diagnostics or malformed JSON.');
        records.push({ ...defaultPair, interfaceLaunch: true, interfaceReset: true, phpSwitch: changedPHP, persistedAutomaticResume: true, portableDownload: true, freshPreservesOriginal: true, savedSiteSelector: true });
      } catch (error) {
        await saveBrowserDiagnostics(page, `interface-${name}`, error);
        throw error;
      } finally { await context.close(); }
    });
    assert.equal(records.length, (scenarios.includes('matrix') ? combinations.length : 0) + scenarios.filter((scenario) => scenario !== 'matrix').length,
      'Every selected runtime scenario must pass before writing a receipt.');
    await checkedInventory();
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results', `browser-${name}.json`), `${JSON.stringify({ browser: name, version: browser.version(), manifestSha256, inventorySha256, scenarios, records }, null, 2)}\n`);
  });
}
