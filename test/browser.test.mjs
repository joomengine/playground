import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createStaticServer } from './server.mjs';
import { assertBrowserRequestBodies } from './browser-request-contract.mjs';
import { assertExternalAssets } from './external-assets-contract.mjs';
import { assertStaticAssetValidation } from './static-assets-contract.mjs';
import { assertFrameLayoutStable } from './frame-layout-contract.mjs';
import { assertJoomlaDebugConfiguration } from './joomla-debug-contract.mjs';
import { assertJcbCompiler } from './jcb-compiler-contract.mjs';
import { assertLaunchCountdown, assertFailedDeploymentRecovery } from './launch-ui-contract.mjs';
import { assertLiveFocusMode, assertInitialFocusMode } from './focus-ui-contract.mjs';
import { assertJcbHardReload } from './jcb-hard-reload-contract.mjs';
import { assertSavedSiteRecovery } from './saved-site-recovery-contract.mjs';
import { classifyAssetDiagnostics, classifyNavigationAbortDiagnostics } from './asset-diagnostics.mjs';
import { assertMcpHttp } from './mcp-http.mjs';
import { probeSyntheticRedirect, startRedirectTrace, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';
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
const selection = (name) => {
  const values = process.env[name]?.split(',').map((part) => part.trim()).filter(Boolean);
  return values?.length ? values : undefined;
};
const browserNames = selection('PLAYGROUND_BROWSERS') || ['chromium', 'firefox'];
const phpVersions = selection('PLAYGROUND_PHP_VERSIONS') || manifest.php.map((entry) => entry.version);
const joomlaVersions = selection('PLAYGROUND_JOOMLA_VERSIONS') || manifest.joomla.map((entry) => entry.version);
const browsers = { chromium, firefox };
const scenarios = selection('PLAYGROUND_SCENARIOS') || ['matrix', 'memory', 'timeout', 'static', 'ui', 'deploys', 'export', 'rocket'];
for (const scenario of scenarios) assert.ok(['matrix', 'memory', 'timeout', 'static', 'ui', 'deploys', 'export', 'rocket'].includes(scenario), `Unknown scenario: ${scenario}`);
const combinations = manifest.joomla.flatMap((joomla) => joomlaVersions.includes(joomla.version)
  ? joomla.php.filter((php) => phpVersions.includes(php)).map((phpVersion) => ({ phpVersion, joomlaVersion: joomla.version })) : []);
assert.ok(combinations.length, 'Select at least one compatible Joomla/PHP pair from the built manifest.');
for (const name of browserNames) assert.ok(browsers[name], `Unsupported browser: ${name}`);
for (const name of browserNames) await rm(path.join(root, 'test-results', `browser-${name}.json`), { force: true });
for (const php of phpVersions) assert.ok(manifest.php.some((entry) => entry.version === php), `Unknown PHP selection: ${php}`);
for (const joomla of joomlaVersions) assert.ok(manifest.joomla.some((entry) => entry.version === joomla), `Unknown Joomla selection: ${joomla}`);

const PDO = "$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);";
const requestTimeout = 240_000;
const installedAssetNonce = randomUUID();
const extensionArchive = zipSync({
  'mod_playground_contract.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><extension type="module" client="site" method="upgrade"><name>mod_playground_contract</name><author>JoomEngine</author><version>1.0.0</version><description>Browser integration fixture</description><files><filename module="mod_playground_contract">mod_playground_contract.php</filename><filename>contract.php</filename><filename>asset-proof.html</filename><folder>assets</folder></files></extension>'),
  'mod_playground_contract.php': strToU8("<?php defined('_JEXEC') or die; echo 'Playground extension fixture';"),
  'asset-proof.html': strToU8('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Installed extension assets</title><link rel="stylesheet" href="assets/proof.css"><script src="assets/proof.js"></script></head><body><img id="installed-image" src="assets/proof.svg" alt="Installed image"></body></html>'),
  'assets/proof.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="17"><path fill="#123456" d="M0 0h13v17H0z"/></svg>'),
  'assets/proof.css': strToU8('#installed-image { border-top: 3px solid rgb(18, 52, 86); }'),
  'assets/proof.js': strToU8(`window.installedAssetProof = ${JSON.stringify(installedAssetNonce)};`),
  'contract.php': strToU8(`<?php
header('Content-Type: application/json');
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$path = __DIR__ . '/saved-marker.txt';
if (($_GET['action'] ?? '') === 'settings') {
    echo json_encode(array_combine(['upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'max_input_time', 'memory_limit'], array_map('ini_get', ['upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'max_input_time', 'memory_limit'])), JSON_THROW_ON_ERROR);
    return;
}
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
  const started = Date.now();
  const frameStates = new WeakMap(), requestOrigins = new WeakMap();
  let nextFrameId = 0;
  const frameState = frame => {
    if (!frameStates.has(frame)) frameStates.set(frame, { frameId: ++nextFrameId, documentId: 0, url: frame.url() });
    return frameStates.get(frame);
  };
  Object.defineProperty(page, 'testStep', {
    get: () => step,
    set(value) {
      step = value;
      console.log(JSON.stringify({ browser: page.context().browser().browserType().name(), step: value, elapsedMs: Date.now() - started }));
    },
  });
  page.errors = [];
  page.logs = [];
  page.consoleErrors = [];
  page.knownBrowserDiagnostics = [];
  page.contentDiagnostics = [];
  page.expectedConsoleURLs = new Set();
  page.failedSiteRequests = [];
  page.failedRequests = [];
  page.responseErrors = [];
  page.pendingSiteRequests = new Map();
  page.responseChecks = new Set();
  page.frameNavigations = [];
  page.on('framenavigated', frame => {
    const previous = frameState(frame);
    const navigation = page.frameNavigations.findLast(value => value.frameId === previous.frameId
      && value.documentId === previous.documentId && value.kind === 'navigation' && value.committed === undefined);
    if (navigation) navigation.committed = Date.now();
    frameStates.set(frame, { ...previous, documentId: previous.documentId + 1, url: frame.url() });
  });
  page.on('framedetached', frame => {
    const previous = frameState(frame), time = Date.now();
    page.frameNavigations.push({ ...previous, fromURL: previous.url, kind: 'detach', started: time, committed: time });
  });
  page.on('pageerror', (error) => page.errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) page.logs.push(message.text());
    if (message.type() === 'error') {
      const location = message.location();
      const expected = [...page.expectedConsoleURLs].some((url) => location.url === url || message.text().includes(url));
      if (!expected) page.consoleErrors.push({ message: message.text(), url: location.url, step: page.testStep, time: Date.now() });
    }
  });
  page.on('request', (request) => {
    try {
      const frame = request.frame(), state = frameState(frame), time = Date.now();
      requestOrigins.set(request, { frameId: state.frameId, documentId: state.documentId, documentURL: frame.url() });
      if (request.isNavigationRequest()) page.frameNavigations.push({ ...state, fromURL: state.url,
        toURL: request.url(), kind: 'navigation', started: time });
    } catch { /* Service-worker requests have no frame and cannot qualify. */ }
    if (request.url().includes('/__site/')) page.pendingSiteRequests.set(request, {
      url: request.url(), method: request.method(), type: request.resourceType(), started: Date.now(),
    });
  });
  page.on('requestfinished', (request) => page.pendingSiteRequests.delete(request));
  page.on('requestfailed', (request) => {
    page.pendingSiteRequests.delete(request);
    page.failedRequests.push({ ...requestOrigins.get(request), url: request.url(), method: request.method(), type: request.resourceType(), error: request.failure()?.errorText, step: page.testStep, time: Date.now() });
  });
  page.on('response', (response) => {
    const origin = requestOrigins.get(response.request());
    if (origin) origin.status = response.status();
    const siteResponse = response.url().includes('/__site/');
    const staticResponse = ['image', 'script', 'stylesheet', 'font'].includes(response.request().resourceType());
    if (!siteResponse && !staticResponse) return;
    if (response.status() >= 400) page.failedSiteRequests.push({ url: response.url(), status: response.status(), resourceType: response.request().resourceType() });
    if (!siteResponse) return;
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
    const frame = document.getElementById('site-frame') || document.getElementById('site');
    return {
      url: location.href, readyState: document.readyState,
      status: text('status-message') || text('message'), loading: text('loading-message'), error: text('error-message'), feedback: text('header-feedback'), activity: text('activity-log')?.slice(-5000),
      savedSite: {
        selected: document.getElementById('saved-site')?.value, staged: document.getElementById('storage-key')?.value,
        name: document.getElementById('saved-site-name')?.value, renameDisabled: document.getElementById('rename-site-button')?.disabled,
        launchDisabled: document.getElementById('launch-button')?.disabled, saveDisabled: document.getElementById('save-button')?.disabled,
      },
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
    errors: page.errors, logs: page.logs?.slice(-30), consoleErrors: page.consoleErrors, knownBrowserDiagnostics: page.knownBrowserDiagnostics, contentDiagnostics: page.contentDiagnostics, failedSiteRequests: page.failedSiteRequests, failedRequests: page.failedRequests,
    responseErrors: page.responseErrors, frameNavigations: page.frameNavigations, pendingSiteRequests: [...(page.pendingSiteRequests?.values() || [])],
  };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', `${name}-failure.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  await page.screenshot({ path: path.join(root, 'test-results', `${name}-failure.png`), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ diagnostic: name, ...diagnostics }));
}

async function assertCleanConsole(page, { contentImages = false } = {}) {
  await bounded(Promise.allSettled([...page.responseChecks]), 'Read browser responses', 10_000);
  const navigation = classifyNavigationAbortDiagnostics(page.consoleErrors, page.failedRequests, page.frameNavigations);
  page.knownBrowserDiagnostics.push(...navigation.navigationAborts);
  let consoleErrors = navigation.consoleErrors;
  if (contentImages) {
    const diagnostics = classifyAssetDiagnostics(page.failedSiteRequests, consoleErrors);
    page.contentDiagnostics = diagnostics.missingImages;
    assert.deepEqual(diagnostics.unexpectedAssets, [], 'Installed images, scripts, styles and fonts must load successfully.');
    consoleErrors = diagnostics.consoleErrors;
  }
  assert.deepEqual(page.errors, [], 'The application must not produce uncaught browser exceptions.');
  assert.deepEqual(consoleErrors, [], 'Unexpected browser console errors must be fixed at their source.');
  assert.deepEqual(page.responseErrors, [], 'AJAX responses must not contain PHP diagnostics or malformed JSON.');
}

async function setPersistence(page, enabled) {
  if (await page.locator('#persistence').isChecked() !== enabled) await page.locator('label[for="persistence"]').click();
  await page.waitForFunction(enabled => document.getElementById('persistence').checked === enabled, enabled, { timeout: 10_000 });
}

async function showQuickSettings(page) {
  if (!(await page.locator('#settings').isVisible())) await page.locator('#settings-toggle').click();
}

async function showDeployEditor(page, { advanced = false } = {}) {
  if (!(await page.locator('#deploy-dialog').isVisible())) await page.locator('#deploy-editor-button').click();
  if (advanced && await page.locator('#advanced-settings').getAttribute('open') === null) await page.locator('#advanced-settings > summary').click();
}

async function closeDeployEditor(page) {
  if (await page.locator('#deploy-dialog').isVisible()) await page.locator('#deploy-dialog [data-close-dialog]').click();
}

async function approveFixtureLaunch(page, button, source) {
  const pending = page.waitForEvent('dialog');
  const clicked = button.click();
  const review = await pending;
  assert.equal(review.type(), 'confirm');
  assert.ok(review.message().includes(source), 'The source being installed must be visible in the launch review.');
  await review.accept();
  await clicked;
}

async function reviewFixtureLink(page, source) {
  await page.locator('#deploy-dialog[open]').waitFor();
  assert.ok((await page.locator('#extensions').inputValue()).includes(source));
  assert.equal(await page.locator('#site-frame').count(), 0, 'Shared custom packages must wait for review before execution.');
  await closeDeployEditor(page);
  await approveFixtureLaunch(page, page.locator('#embedded-launch'), source);
}

async function showSiteActions(page) {
  await showQuickSettings(page);
  assert.equal(await page.locator('#site-actions > summary').count(), 0, 'Site actions belong to the one dashboard.');
}

async function openHarness(context, url, { isolation = true } = {}) {
  const page = observePage(await context.newPage());
  page.setDefaultTimeout(30_000);
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

async function startDeploy(page, query, extra = {}) {
  return bounded(page.evaluate(async ({ query, extra }) => {
    const { readURLConfiguration, parseCatalog } = await import('./src/config.mjs');
    const { loadDeployCatalog, resolveDeployConfiguration } = await import('./src/deploys.mjs');
    const { createPlayground } = await import('./src/playground.mjs');
    const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
    const deployCatalog = await loadDeployCatalog();
    const input = { ...readURLConfiguration(new URL(`?${query}`, location.href)).config, ...extra };
    const resolved = await resolveDeployConfiguration(input, { catalog, deployCatalog, baseURL: location.href });
    window.validationProgress = [];
    window.playground = await createPlayground(resolved.configuration, { onProgress(progress) { window.validationProgress.push(progress); } });
    return { configuration: { ...resolved.configuration, admin: undefined }, installation: { ...window.playground.installation, administrator: undefined }, progress: window.validationProgress };
  }, { query, extra }), 'Deploy installation');
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
    || (document.getElementById('error-view') && !document.getElementById('error-view').hidden), undefined, { timeout: requestTimeout });
  assert.equal(await page.locator('#error-view').isVisible(), false,
    await page.locator('#error-message').textContent());
  await page.locator('#site-frame:not([hidden])').waitFor({ timeout: requestTimeout });
  const element = await page.locator('#site-frame').elementHandle();
  const expectedURL = await element.getAttribute('src');
  assert.ok(expectedURL?.includes('/__site/'), 'The preview must point to an active playground site.');
  const frame = await element.contentFrame();
  assert.ok(frame, 'The preview must have an attached browsing context.');
  await waitForSiteFrame(frame, expectedURL);
  await frame.locator('body').waitFor();
  return frame;
}

/** Launch deliberately leaves the old preview alive while validation/saving runs. */
async function launchStagedSite(page) {
  const previous = await page.locator('#site-frame').elementHandle();
  const key = await page.locator('#storage-key').inputValue();
  try {
    await page.locator('#launch-button').click();
    await page.waitForFunction(({ previous, key }) => {
      if (!document.getElementById('error-view').hidden) return true;
      const frame = document.getElementById('site-frame');
      return !document.getElementById('launch-button').disabled && frame && frame !== previous
        && new URL(location.href).searchParams.get('key') === key;
    }, { previous, key }, { timeout: requestTimeout });
    return await renderedSiteFrame(page);
  } finally { await previous?.dispose(); }
}

async function waitForSiteClosed(page) {
  await page.waitForFunction(() => !document.getElementById('site-frame')
    && !document.getElementById('launch-button').disabled, null, { timeout: requestTimeout });
}

async function stageSavedSite(page, key) {
  await page.locator('#saved-site').selectOption(key);
  await page.waitForFunction(key => document.getElementById('saved-site').value === key
    && document.getElementById('storage-key').value === key
    && !document.getElementById('rename-site-button').disabled, key);
}

async function saveRunningSite(page) {
  const previous = await page.locator('#activity-log li').last().elementHandle();
  try {
    await page.locator('#save-button').click();
    await page.waitForFunction(previous => {
      const entry = document.querySelector('#activity-log li:last-child');
      return entry !== previous && entry?.textContent.includes('Files and database saved to browser storage.')
        && !document.getElementById('save-button').disabled;
    }, previous, { timeout: requestTimeout });
  } finally { await previous?.dispose(); }
}

async function dismissAutomaticTour(page) {
  const frame = await renderedSiteFrame(page);
  // A new administrator's tour fetch can redirect after document load. Use
  // Joomla's actual Hide forever action and await its persisted acknowledgement
  // before the fixture starts navigating or saving this installation.
  const hideTour = frame.locator('[data-shepherd-step-id="tourinfo"] .shepherd-button-secondary');
  await hideTour.waitFor({ timeout: requestTimeout });
  const [acknowledged] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().frame() === frame && url.searchParams.get('option') === 'com_guidedtours'
        && url.searchParams.get('task') === 'ajax.fetchUserState' && url.searchParams.get('context') === 'tour.skip';
    }),
    hideTour.click(),
  ]);
  assert.equal(acknowledged.status(), 200);
  const payload = await acknowledged.json();
  assert.equal(payload.success, true, JSON.stringify(payload));
  assert.equal(payload.data.state, 'skipped');
  await hideTour.waitFor({ state: 'hidden' });
  assert.equal(await frame.evaluate(() => sessionStorage.getItem('tourId')), null);
}

async function previewContract(page, action = 'read', frameId = 'site-frame') {
  const response = await bounded(page.evaluate(async ({ action, frameId }) => {
    const frame = document.getElementById(frameId);
    const source = new URL(frame.src);
    const prefix = source.pathname.match(/^.*\/__site\/[^/]+\/[^/]+\//)?.[0];
    if (!prefix) throw new Error('The active preview has no site route.');
    const url = new URL(`${prefix}modules/mod_playground_contract/contract.php`, source);
    url.searchParams.set('action', action);
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
  }, { action, frameId }), `Preview data ${action}`);
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
  const failure = `Expected request failure ${randomUUID()}`;
  for (const ending of ['exit(17);', `throw new RuntimeException('${failure}');`]) {
    const fatal = ending.startsWith('throw');
    const step = fatal ? 'intentional PHP fatal request cleanup' : 'intentional PHP exit request cleanup';
    page.testStep = step;
    const source = new URL('assets/php-cgi-wasm/PhpCgiBase.mjs', page.url()).href;
    const expectedMessage = fatal
      ? new RegExp(`^\\[[^\\]\\r\\n]+\\] PHP Fatal error:  Uncaught RuntimeException: ${failure} in (/internal/operation-[a-f0-9-]+\\.php):1\\nStack trace:\\n#0 \\{main\\}\\n  thrown in \\1 on line 1\\n$`)
      : /^$/;
    const before = page.consoleErrors.length;
    const diagnostic = page.waitForEvent('console', { predicate: message => message.type() === 'error'
      && message.location().url === source && expectedMessage.test(message.text()), timeout: 10_000 });
    const response = await php(page, `<?php ${PDO} $db->beginTransaction(); $db->exec('INSERT INTO playground_contract (id) VALUES (2)'); ${ending}`);
    assert.equal(response.status, 500, 'An abnormal PHP termination must report an HTTP error.');
    assert.equal(await page.evaluate(expected => window.validationProgress.some(event =>
      event.phase === 'warning' && event.message.includes(expected)), fatal ? failure : 'PHP restarted after an application error'), true,
    'The activity channel must receive the PHP error or recovery message.');
    await diagnostic;
    const expected = page.consoleErrors.slice(before).filter(record => record.step === step && record.url === source && expectedMessage.test(record.message));
    assert.equal(expected.length, 1, 'The deliberate termination must emit exactly its own upstream stderr diagnostic.');
    page.consoleErrors.splice(page.consoleErrors.indexOf(expected[0]), 1);
    page.testStep = 'continue after deliberate PHP termination without replay or data loss';
    assert.equal(await page.evaluate(() => window.playground.healthy), true, 'An application error must not close the entire site.');
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
  test(`${name}: real Joomla, upstream PHP and native MariaDB PDO`, { timeout: 1_800_000 }, async (t) => {
    const runScenario = async (title, options, execute) => {
      let failure;
      await t.test(title, options, async context => {
        try { await execute(context); } catch (error) { failure = error; throw error; }
      });
      if (failure) throw failure;
    };
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await browsers[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}),
      env: { ...process.env } });
    const syntheticRedirectProbe = scenarios.some(value => ['rocket', 'deploys'].includes(value)) ? await probeSyntheticRedirect(browser) : null;
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
      await runScenario(`Joomla ${pair.joomlaVersion}, PHP ${pair.phpVersion}: install, PDO and persisted reload`, { timeout: 900_000 }, async () => {
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
          await assertBrowserRequestBodies(page);
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
          await assertCleanConsole(page);
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
    if (scenarios.includes('memory')) await runScenario('memory-only installation closes and does not persist data', { timeout: 900_000 }, async () => {
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
        await assertCleanConsole(page);
        await close(page);
        records.push({ ...defaultPair, memoryOnly: true });
      } finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('timeout')) await runScenario('a timed-out PHP worker fails closed and a persisted site can reopen', { timeout: 900_000 }, async () => {
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
        await assertCleanConsole(page);
        await close(page, true);
        records.push({ ...defaultPair, hardTimeout: true, reopenAfterTimeout: true });
      } finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('static')) await runScenario('plain static hosting gains isolation through the service worker', { timeout: 900_000 }, async () => {
      const plainServer = await createStaticServer({ directory, prefix: '/pages/project/', isolation: false });
      const context = await browser.newContext();
      let page;
      try {
        page = await openHarness(context, plainServer.url, { isolation: false });
        const config = configuration(defaultPair, { persistence: false });
        await start(page, config);
        await assertSite(page, config);
        const externalAssets = await assertExternalAssets(page);
        await assertStaticAssetValidation(page);
        await assertCleanConsole(page);
        await close(page);
        records.push({ ...defaultPair, staticServiceWorkerIsolation: true, externalAssets });
      } finally { if (page) await close(page).catch(() => {}); await context.close(); await plainServer.close(); }
    });
    if (scenarios.includes('deploys')) await runScenario('repository and URL recipes install actual components, languages and prepared content', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = await openHarness(context, server.url);
      const proof = [];
      let mcpHttpVerified = false;
      const setup = () => ({ admin: configuration(defaultPair).admin, persistence: false, storageKey: `deploy-${randomUUID()}` });
      try {
        const componentCases = [
          ...combinations.map((pair) => ({ id: 'jcb', version: pair.joomlaVersion, phpVersion: pair.phpVersion, element: 'com_componentbuilder' })),
          { id: 'jcb-mcp', version: manifest.defaults.joomlaVersion, phpVersion: manifest.defaults.phpVersion, element: 'com_componentbuilder' },
          { id: 'patchtester', version: defaultPair.joomlaVersion, element: 'com_patchtester' },
          { id: 'weblinks', version: defaultPair.joomlaVersion, element: 'com_weblinks' },
        ];
        for (const item of componentCases) {
          page.testStep = `${item.id} on Joomla ${item.version}, PHP ${item.phpVersion ?? defaultPair.phpVersion}`;
          const result = await startDeploy(page, new URLSearchParams({ deploy: item.id, joomla: item.version, php: item.phpVersion ?? defaultPair.phpVersion }).toString(), setup());
          const registered = await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE type='component' AND element='${item.element}'")->fetchColumn(), JSON_THROW_ON_ERROR);`);
          assert.equal(registered, 1, `${item.id} must be installed and enabled by Joomla.`);
          const component = await request(page, `/administrator/index.php?option=${item.element}`);
          assert.equal(component.status, 200, component.text.slice(0, 3000));
          assert.doesNotMatch(component.text, /name\s*=\s*["']passwd["']|Fatal error|Class .* not found|Call to undefined/i, 'The installed component must render in an authenticated administrator session.');
          assert.match(component.text, new RegExp(item.element));
          assert.ok(result.configuration.extensions.length > 0);
          if (item.id === 'jcb' || item.id === 'jcb-mcp') {
            if (item.id === 'jcb-mcp') {
              assert.equal(await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE element='com_joomengine_mcp' AND type='component'")->fetchColumn());`), 1);
              assert.equal(await phpJSON(page, `echo json_encode(extension_loaded('sodium'));`), true);
              if (!mcpHttpVerified) {
                proof.push({ id: 'jcb-mcp', ...(await assertMcpHttp(page)) });
                mcpHttpVerified = true;
              }
            }
            assert.deepEqual(dashboardErrors(component.text), [], 'JCB must not report missing requirements or fatal configuration errors.');
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
            const deniedHref = new URL('denied.json', corsServer.url).href;
            page.expectedConsoleURLs.add(deniedHref);
            const deniedURL = Buffer.from(deniedHref).toString('base64');
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
            if (item.id === 'jcb' && item.phpVersion === manifest.defaults.phpVersion) {
              proof.push({ id: 'jcb-compiler', ...(await assertJcbCompiler(page, { redirectProbe: syntheticRedirectProbe })) });
            }
          }
          proof.push({ ...item, administrator: true });
          await close(page);
        }
        page.testStep = 'Dutch URL recipe with explicit logged-out session and extension command';
        const dutch = await startDeploy(page, new URLSearchParams({
          deploy: 'blank', joomla: '5.4', php: defaultPair.phpVersion, language: 'nl-NL', login: 'no',
          extension: new URL('__test_extension.zip', server.url).href, commands: JSON.stringify([['list']]),
        }).toString(), setup());
        assert.equal(dutch.configuration.joomlaVersion, manifest.joomla.find((entry) => entry.version.startsWith('5.4.')).version);
        const frontend = await request(page, '/');
        assert.equal(frontend.status, 200, frontend.text.slice(0, 1000));
        assert.match(frontend.text, /<html[^>]+lang=["']nl-NL["']/i);
        const admin = await request(page, '/administrator/');
        assert.match(admin.text, /name\s*=\s*["']passwd["']/i, 'login=no must leave the actual administrator unauthenticated.');
        assert.equal(await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT enabled FROM jml_extensions WHERE element='mod_playground_contract'")->fetchColumn());`), 1);
        const installedAssetURL = await page.evaluate(() => new URL('modules/mod_playground_contract/asset-proof.html', window.playground.baseUrl).href);
        const installedAssetDocument = page.waitForResponse(response => response.url() === installedAssetURL);
        await page.evaluate(url => {
          const frame = document.createElement('iframe');
          frame.id = 'installed-asset-frame'; frame.src = url; document.body.append(frame);
        }, installedAssetURL);
        const installedAssetFrame = await (await page.locator('#installed-asset-frame').elementHandle()).contentFrame();
        await installedAssetFrame.waitForURL(installedAssetURL, { waitUntil: 'load' });
        assert.equal((await installedAssetDocument).status(), 200, 'Joomla must install and serve the extension proof document.');
        await installedAssetFrame.waitForFunction(() => document.querySelector('#installed-image')?.complete && window.installedAssetProof);
        const installedAssets = await installedAssetFrame.evaluate(() => {
          const image = document.querySelector('#installed-image');
          const style = getComputedStyle(image);
          return { image: [image.naturalWidth, image.naturalHeight], border: style.borderTopWidth,
            color: style.borderTopColor, script: window.installedAssetProof };
        });
        assert.deepEqual(installedAssets, { image: [13, 17], border: '3px', color: 'rgb(18, 52, 86)', script: installedAssetNonce },
          'Installed extension images, styles and classic scripts must load through their actual nested site paths.');
        await page.locator('#installed-asset-frame').evaluate(frame => frame.remove());
        proof.push({ id: 'blank', language: 'nl-NL', autoLogin: false, urlExtension: true, urlCommand: true, installedAssets });
        await close(page);
        for (const fresh of [false, true]) {
          page.testStep = `heritage ${fresh ? 'fresh recipe' : 'prepared snapshot'}`;
          const result = await startDeploy(page, new URLSearchParams({ deploy: 'heritage-demo', php: defaultPair.phpVersion, ...(fresh ? { fresh: '1' } : {}) }).toString(), setup());
          assert.equal(Boolean(result.installation.fromSnapshot), !fresh, 'fresh=1 must bypass the verified prepared archive.');
          const content = await phpJSON(page, `${PDO} echo json_encode($db->query("SELECT language, COUNT(*) AS articles FROM jml_content WHERE state=1 GROUP BY language ORDER BY language")->fetchAll(PDO::FETCH_ASSOC), JSON_THROW_ON_ERROR);`);
          for (const language of ['af-ZA', 'de-DE', 'fr-FR', 'it-IT', 'es-ES', 'zh-CN', 'nl-NL', 'en-GB']) {
            assert.ok(content.some((entry) => entry.language === language && entry.articles > 0), `${language} needs published multilingual content.`);
          }
          const consoleStart = page.consoleErrors.length;
          const traceFrom = await startRedirectTrace(page);
          const documentResponse = page.waitForResponse(response => response.status() === 200
            && response.request().resourceType() === 'document' && response.url().includes('/__site/'));
          const siteURL = await page.evaluate(() => {
            const frame = document.createElement('iframe');
            frame.id = 'site-frame'; frame.src = window.playground.url;
            document.body.append(frame);
            return frame.src;
          });
          const frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
          await waitForSiteFrame(frame, siteURL);
          assert.match(await frame.locator('html').getAttribute('lang'), /^af-ZA$/i);
          assert.match(await frame.locator('body').innerText(), /Erfenis/);
          assert.ok(await frame.locator('.mod-languages').count() > 0, 'The actual multilingual home page must offer its language switcher.');
          const loadedDocument = await documentResponse;
          await recordVerifiedRedirectDiagnostic(page, { probe: syntheticRedirectProbe, kind: 'get301', from: consoleStart, traceFrom,
            sourceURL: new URL('service-worker.mjs', server.url).href, step: page.testStep, finalURL: frame.url(), responseStatus: loadedDocument.status(), methodAfterRedirect: loadedDocument.request().method() });
          await page.locator('#site-frame').evaluate((frame) => frame.remove());
          proof.push({ id: 'heritage-demo', fresh, fromSnapshot: Boolean(result.installation.fromSnapshot), content });
          await close(page);
        }
        page.testStep = 'default domain counts down and opens prepared JCB on PHP 8.4 in English';
        await page.setViewportSize({ width: 1440, height: 1000 });
        const defaultLaunchStarted = await assertLaunchCountdown(page, server.url);
        await renderedSiteFrame(page);
        const preparedLaunchMs = Date.now() - defaultLaunchStarted;
        assert.equal(await page.locator('#deploy').inputValue(), 'jcb');
        assert.equal(await page.locator('#php-version').inputValue(), '8.4');
        assert.match(await page.frameLocator('#site-frame').locator('html').innerHTML(), /com_componentbuilder/);
        assert.equal(await page.frameLocator('#site-frame').locator('input[name="passwd"]').count(), 0);
        assert.deepEqual(dashboardErrors(await page.frameLocator('#site-frame').locator('html').innerHTML()), [],
          'The default JCB dashboard must be free of missing-runtime requirement alerts.');
        proof.push({ id: 'jcb-save-hard-reload', ...(await assertJcbHardReload(page, { redirectProbe: syntheticRedirectProbe })) });
        proof.push({ id: 'joomla-diagnostics', ...(await assertJoomlaDebugConfiguration(page, { redirectProbe: syntheticRedirectProbe })) });
        if (name === 'chromium') {
          await mkdir(path.join(root, 'test-results'), { recursive: true });
          await page.screenshot({ path: path.join(root, 'test-results/jcb-desktop.png'), fullPage: true });
        }
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        proof.push({ id: 'jcb', defaultDomainCountdown: true, preparedLaunchMs });
        await assertCleanConsole(page, { contentImages: true });
        records.push({ ...defaultPair, deploys: proof, knownBrowserDiagnostics: page.knownBrowserDiagnostics, contentDiagnostics: page.contentDiagnostics });
      } catch (error) { await saveBrowserDiagnostics(page, `deploys-${name}`, error); throw error; }
      finally { await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('rocket')) await runScenario('failed installations and database startup retain recovery access', { timeout: 600_000 }, async () => {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      try {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const focus = await assertInitialFocusMode(page, server.url);
        const recovery = await assertFailedDeploymentRecovery(page, server.url);
        const recoveryPage = await openHarness(context, server.url);
        recoveryPage.testStep = 'saved files remain recoverable after MariaDB initialization failure';
        const recoveryConfig = configuration(defaultPair);
        await start(recoveryPage, recoveryConfig);
        const filesRecovery = await assertSavedSiteRecovery(recoveryPage, {
          serverURL: server.url, configuration: recoveryConfig, manifest, fixtures,
        });
        await close(recoveryPage);
        await assertCleanConsole(recoveryPage);
        assert.deepEqual(errors, [], 'Recovery controls must not produce JavaScript exceptions.');
        records.push({ ...defaultPair, recovery, filesRecovery, focus });
      } finally { await context.close(); }
    });
    if (scenarios.includes('export')) await runScenario('portable export restores exact files, SQL values, views and triggers in a new database', { timeout: 900_000 }, async () => {
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
        await assertCleanConsole(page);
        records.push({ ...defaultPair, exportRoundTrip: true, exactSQL: true, files: true, dependentViews: true, trigger: true });
      } catch (error) { await saveBrowserDiagnostics(page, `export-${name}`, error); throw error; }
      finally { delete fixtures['__test_snapshot.zip']; await close(page).catch(() => {}); await context.close(); }
    });
    if (scenarios.includes('ui')) await runScenario('the interface preserves files and SQL across PHP changes and reloads, exports and resets', { timeout: 900_000 }, async () => {
      const context = await browser.newContext();
      const page = observePage(await context.newPage());
      page.setDefaultTimeout(30_000);
      try {
        const url = new URL(server.url);
        url.searchParams.set('joomla', defaultPair.joomlaVersion);
        url.searchParams.set('php', defaultPair.phpVersion);
        url.searchParams.set('deploy', 'blank');
        url.searchParams.set('start', '0');
        await page.goto(url.href);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        await showDeployEditor(page, { advanced: true });
        await page.locator('#site-name').fill('Interface installation');
        await page.locator('#storage-key').fill(`ui-${randomUUID()}`);
        await page.locator('#initial-path').fill('/administrator/');
        await page.locator('#extensions').fill(JSON.stringify([{ url: new URL('__test_extension.zip', server.url).href, sha256: extensionSha256 }]));
        await page.locator('#startup-commands').fill(JSON.stringify([['list']]));
        await closeDeployEditor(page);
        await showQuickSettings(page);
        page.testStep = 'launch administrator';
        await approveFixtureLaunch(page, page.locator('#launch-button'), new URL('__test_extension.zip', server.url).href);
        await renderedSiteFrame(page);
        await dismissAutomaticTour(page);
        assert.match(await page.frameLocator('#site-frame').locator('html').innerHTML(), /com_cpanel|task=logout|value=["']logout["']/i);
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'test-results', `interface-${name}.png`), fullPage: true });
        const marker = await previewContract(page, 'seed');
        assert.equal(marker.database, 'saved through real MariaDB');
        assert.equal(marker.file, 'saved through the real PHP filesystem');
        page.testStep = 'Site/Admin reuse the running runtime and existing iframe';
        const navigationWorkers = [];
        const observeNavigationWorker = worker => navigationWorkers.push(worker.url());
        page.on('worker', observeNavigationWorker);
        await page.evaluate(() => { window.__navigationFrame = document.getElementById('site-frame'); });
        await page.locator('#nav-site').click();
        await page.waitForFunction(() => document.getElementById('nav-site').getAttribute('aria-pressed') === 'true');
        await page.locator('#nav-admin').click();
        await page.waitForFunction(() => document.getElementById('nav-admin').getAttribute('aria-pressed') === 'true');
        assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.__navigationFrame), true);
        assert.deepEqual(await previewContract(page), marker);
        page.testStep = 'same-document navigation updates safe resume routes without changing Joomla URLs';
        const navigationFrame = await renderedSiteFrame(page);
        const originalNavigation = navigationFrame.url();
        const siteBase = new URL(originalNavigation);
        siteBase.pathname = siteBase.pathname.match(/^.*\/__site\/[^/]+\/[^/]+\//)[0];
        siteBase.search = ''; siteBase.hash = '';
        // Joomla's automatic guided tour can asynchronously redirect the admin
        // document after load. Exercise native history in the installed inert
        // extension page, still served by this exact runtime and preview iframe.
        await navigationFrame.goto(new URL('modules/mod_playground_contract/asset-proof.html', siteBase).href, { waitUntil: 'load' });
        await navigationFrame.evaluate(base => {
          window.__navigationDocument = document;
          window.__routePopstates = [];
          addEventListener('popstate', event => window.__routePopstates.push({ url: location.href, state: event.state, trusted: event.isTrusted }));
          for (const [id, action] of [
            ['route-admin', () => history.pushState({ routeProof: 'administrator' }, '', `${base}administrator/?option=com_content&view=articles&task=article.save&token=secret#preview-tab`)],
            ['route-hash', () => { location.hash = '#second-tab'; }],
            ['route-site', () => history.pushState({ routeProof: 'frontend' }, '', base)],
            ['route-back', () => history.back()],
          ]) {
            const button = document.createElement('button'); button.id = id; button.type = 'button'; button.textContent = id;
            button.addEventListener('click', action); document.body.append(button);
          }
        }, siteBase.href);
        await navigationFrame.locator('#route-admin').click();
        await page.waitForFunction(() => new URL(location.href).searchParams.get('path')?.endsWith('?option=com_content&view=articles#preview-tab'));
        assert.match(navigationFrame.url(), /task=article.save&token=secret/, 'Only saved resume state is sanitized; Joomla retains its current URL.');
        await navigationFrame.locator('#route-hash').click();
        await page.waitForFunction(() => new URL(location.href).searchParams.get('path')?.endsWith('#second-tab'));
        const previousHistoryEntry = await navigationFrame.evaluate(() => {
          // A native fragment navigation creates its own history entry; do not
          // assume it retains the earlier pushState entry's serialized state.
          window.__routePopstates.length = 0;
          return { url: location.href, state: history.state };
        });
        await navigationFrame.locator('#route-site').click();
        await page.waitForFunction(() => document.getElementById('nav-site').getAttribute('aria-pressed') === 'true');
        await navigationFrame.locator('#route-back').click();
        await page.waitForFunction(() => document.getElementById('nav-admin').getAttribute('aria-pressed') === 'true'
          && new URL(location.href).searchParams.get('path')?.endsWith('#second-tab'));
        assert.equal(await navigationFrame.evaluate(() => document === window.__navigationDocument), true);
        const popstates = await navigationFrame.evaluate(() => window.__routePopstates);
        const restoredEntry = popstates.find(event => event.trusted && event.url === previousHistoryEntry.url);
        assert.ok(restoredEntry, `A real browser popstate must restore the previous same-document route: ${JSON.stringify(popstates)}`);
        assert.deepEqual(restoredEntry.state, previousHistoryEntry.state, 'Back preserves the actual fragment history entry state.');
        await navigationFrame.goto(originalNavigation, { waitUntil: 'load' });
        assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.__navigationFrame), true);
        assert.deepEqual(navigationWorkers, [], 'Site/Admin never creates replacement runtime workers.');
        page.off('worker', observeNavigationWorker);
        page.testStep = 'save site';
        await saveRunningSite(page);
        const changedPHP = manifest.joomla.find((entry) => entry.version === defaultPair.joomlaVersion).php.find((version) => version !== defaultPair.phpVersion);
        assert.ok(changedPHP, 'The interface contract needs two compatible PHP versions.');
        page.testStep = 'switch PHP with saved files and database';
        const activeFrame = await renderedSiteFrame(page);
        const originalFrameURL = new URL('index.php?option=com_content&view=articles', activeFrame.url()).href;
        await activeFrame.goto(originalFrameURL, { waitUntil: 'load' });
        assert.equal(activeFrame.url(), originalFrameURL);
        await showQuickSettings(page);
        await page.locator('#php-version').selectOption(changedPHP);
        assert.deepEqual(await previewContract(page), marker, 'Staging PHP must keep the active runtime unchanged.');
        const switchedFrame = await launchStagedSite(page);
        assert.equal(new URL(switchedFrame.url()).pathname.split('/administrator/')[1], new URL(originalFrameURL).pathname.split('/administrator/')[1]);
        assert.equal(new URL(switchedFrame.url()).search, new URL(originalFrameURL).search, 'Launching a staged PHP change restores the safe Joomla route.');
        const afterSwitch = await previewContract(page);
        assert.deepEqual(afterSwitch, { ...marker, php: manifest.php.find((entry) => entry.version === changedPHP).patchVersion });
        page.testStep = 'reopen saved site from origin';
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await waitForSiteClosed(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        await page.goto(server.url);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#php-version').inputValue(), changedPHP);
        assert.equal(await page.locator('#deploy').inputValue(), 'blank');
        assert.deepEqual(await previewContract(page), afterSwitch);
        const publicPreferences = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('joomengine:launch:'))));
        assert.doesNotMatch(JSON.stringify(publicPreferences), /"(?:password|admin|administrator)"\s*:/, 'Automatic-resume preferences must not expose administrator credentials.');
        page.testStep = 'download portable files and database';
        await page.locator('#download-dialog-button').click();
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
        if (await page.locator('#download-dialog').isVisible()) await page.locator('#download-dialog [data-close-dialog]').click();
        page.testStep = 'fresh URL creates an independent saved site';
        const savedKey = await page.locator('#storage-key').inputValue();
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await waitForSiteClosed(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        const freshURL = new URL(server.url);
        for (const [key, value] of Object.entries({ deploy: 'blank', joomla: defaultPair.joomlaVersion, php: changedPHP, key: savedKey, fresh: '1', extension: new URL('__test_extension.zip', server.url).href })) freshURL.searchParams.set(key, value);
        await page.goto(freshURL.href);
        await reviewFixtureLink(page, new URL('__test_extension.zip', server.url).href);
        await renderedSiteFrame(page);
        await dismissAutomaticTour(page);
        const freshKey = await page.locator('#storage-key').inputValue();
        assert.notEqual(freshKey, savedKey, 'fresh=1 must give the new saved site its own storage key.');
        assert.equal(new URL(page.url()).searchParams.has('fresh'), false, 'Reloading the new site must resume it instead of repeatedly creating sites.');
        assert.equal((await previewContract(page)).database, null);
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await waitForSiteClosed(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        const savedURL = new URL(server.url);
        savedURL.searchParams.set('key', savedKey);
        await page.goto(savedURL.href);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#storage-key').inputValue(), savedKey);
        assert.deepEqual(await previewContract(page), afterSwitch, 'A fresh URL must leave the original saved site intact.');
        page.testStep = 'changed sources on a saved-site link still require review';
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await waitForSiteClosed(page);
        await page.locator('#embedded-launch:enabled').waitFor();
        const changedSourceURL = new URL(savedURL);
        const unreviewedSource = new URL('unreviewed-extension.zip', server.url).href;
        changedSourceURL.searchParams.set('extension', unreviewedSource);
        await page.goto(changedSourceURL.href);
        await page.locator('#deploy-dialog[open]').waitFor();
        assert.ok((await page.locator('#extensions').inputValue()).includes(unreviewedSource));
        assert.equal(await page.locator('#launch-countdown').isVisible(), false);
        assert.equal(await page.locator('#site-frame').count(), 0);
        await page.goto(savedURL.href);
        await renderedSiteFrame(page);
        assert.deepEqual(await previewContract(page), afterSwitch, 'Reviewing an altered link must preserve the original saved site.');
        page.testStep = 'new site control preserves saved sites';
        await showSiteActions(page);
        await page.locator('#new-site-button').click();
        await page.locator('#deploy-dialog').waitFor({ state: 'visible' });
        await closeDeployEditor(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        assert.notEqual(await page.locator('#storage-key').inputValue(), savedKey);
        assert.equal(await page.locator('#site-frame').count(), 1);
        assert.deepEqual(await previewContract(page), afterSwitch, 'Staging a new site leaves the running site intact.');
        await launchStagedSite(page);
        await dismissAutomaticTour(page);
        assert.equal((await previewContract(page)).database, null, 'New site must install an independent database.');
        await showQuickSettings(page);
        await stageSavedSite(page, savedKey);
        assert.equal((await previewContract(page)).database, null, 'Selecting a saved site does not launch it.');
        page.testStep = 'rename preserves an inactive name draft across route and save updates';
        await page.locator('#saved-site-name').fill('');
        await saveRunningSite(page);
        assert.equal(await page.locator('#saved-site-name').inputValue(), '', 'Catalog refresh must preserve an intentionally empty name draft.');
        await page.locator('#saved-site-name').fill('Renamed original site');
        const renameFrame = await renderedSiteFrame(page);
        await renameFrame.evaluate(() => { location.hash = '#rename-draft'; });
        await page.waitForFunction(() => new URL(location.href).searchParams.get('path')?.endsWith('#rename-draft'));
        await saveRunningSite(page);
        assert.equal(await page.locator('#saved-site-name').inputValue(), 'Renamed original site', 'Saving the running site must preserve the inactive site name draft.');
        await page.locator('#rename-site-button').click();
        await page.locator('#header-feedback').filter({ hasText: 'Saved site renamed.' }).waitFor();
        assert.equal(await page.locator('#saved-site').inputValue(), savedKey);
        assert.match(await page.locator(`#saved-site option[value="${savedKey}"]`).textContent(), /Renamed original site/);
        assert.equal(await page.evaluate(key => Object.entries(localStorage)
          .filter(([entry]) => entry.startsWith('joomengine:launch:'))
          .some(([, value]) => JSON.parse(value).sites?.[key]?.displayName === 'Renamed original site'), savedKey), true,
        'The renamed label must be persisted under the original site identity.');
        assert.equal((await previewContract(page)).database, null, 'Renaming an inactive entry does not change the running database.');
        await stageSavedSite(page, freshKey);
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#delete-site-button').click();
        await page.waitForFunction(key => !document.querySelector(`#saved-site option[value="${key}"]`), freshKey);
        assert.equal((await previewContract(page)).database, null, 'Deleting an inactive entry never launches it or deletes the running database.');
        await stageSavedSite(page, savedKey);
        await launchStagedSite(page);
        assert.deepEqual(await previewContract(page), afterSwitch, 'The saved-site selector must reopen the original files and database.');
        page.testStep = 'reset site';
        page.once('dialog', (dialog) => dialog.accept());
        await showSiteActions(page);
        await page.locator('#reset-button').click();
        await waitForSiteClosed(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        assert.equal(await page.locator('#site-frame').isVisible(), false);
        await showDeployEditor(page, { advanced: true });
        await page.locator('#site-name').fill('Interface installation after reset');
        await page.locator('#initial-path').fill('/');
        await closeDeployEditor(page);
        await showQuickSettings(page);
        page.testStep = 'launch site after reset';
        await page.locator('#launch-button').click();
        await renderedSiteFrame(page);
        assert.ok((await page.frameLocator('#site-frame').locator('html').innerHTML()).includes('Interface installation after reset'));
        const afterReset = await previewContract(page);
        assert.equal(afterReset.database, null, 'Reset must remove the previous MariaDB data.');
        assert.equal(afterReset.file, null, 'Reset must remove the previous site files.');
        page.testStep = 'close site';
        await showSiteActions(page);
        await page.locator('#close-button').click();
        await waitForSiteClosed(page);
        await showQuickSettings(page);
        await page.locator('#launch-button:enabled').waitFor();
        await bounded(Promise.allSettled([...page.responseChecks]), 'Read dashboard responses', 10_000);
        await assertCleanConsole(page);
        records.push({ ...defaultPair, interfaceLaunch: true, interfaceReset: true, phpSwitch: changedPHP, persistedAutomaticResume: true, portableDownload: true, freshPreservesOriginal: true, savedSiteSelector: true });
      } catch (error) {
        await saveBrowserDiagnostics(page, `interface-${name}`, error);
        throw error;
      } finally { await context.close(); }
    });
    if (scenarios.includes('rocket')) await runScenario('Rocket shares, translates, saves temporary sites, changes PHP and preserves its live site while hiding controls', { timeout: 600_000 }, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = observePage(await context.newPage());
      page.setDefaultTimeout(30_000);
      try {
        const url = new URL(server.url);
        for (const [key, value] of Object.entries({ deploy: 'blank', joomla: defaultPair.joomlaVersion, php: defaultPair.phpVersion,
          name: 'Rocket shared demonstration', persist: '0', extension: new URL('__test_extension.zip', server.url).href })) url.searchParams.set(key, value);
        page.testStep = 'launch temporary site in English';
        await page.goto(url.href);
        await reviewFixtureLink(page, new URL('__test_extension.zip', server.url).href);
        await page.locator('#loading-view:not([hidden])').waitFor();
        await page.locator('#loading-message').filter({ hasText: /Starting MariaDB|Loading PHP|Loading Joomla|Extracting Joomla/ }).waitFor();
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'test-results', `rocket-deploy-${name}.png`) });
        await renderedSiteFrame(page);
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
        assert.equal(await page.locator('#settings').isVisible(), false);
        assert.equal(await page.locator('#site-header').evaluate(element => ['fixed', 'sticky'].includes(getComputedStyle(element).position)), false);
        assert.match(await page.frameLocator('#site-frame').locator('html').getAttribute('lang'), /^en-GB$/i);
        const marker = await previewContract(page, 'seed');
        assert.equal(marker.database, 'saved through real MariaDB');
        page.testStep = 'share exposes the full public configuration';
        await page.locator('#share-button').click();
        await page.locator('#share-dialog').waitFor({ state: 'visible' });
        const link = await page.locator('#share-url').inputValue();
        const shared = await page.evaluate(async link => (await import('./src/config.mjs')).readURLConfiguration(link).config, link);
        assert.equal(shared.siteName, 'Rocket shared demonstration');
        assert.equal(shared.deployId, 'blank');
        assert.equal(shared.phpVersion, defaultPair.phpVersion);
        assert.equal(shared.extensions.length, 1);
        assert.equal(Object.hasOwn(shared, 'admin'), false);
        assert.equal(Object.hasOwn(shared, 'storageKey'), false);
        await page.locator('#copy-share').click();
        await page.waitForFunction(() => document.getElementById('share-feedback').textContent.trim().length > 0);
        await page.locator('#share-dialog [data-close-dialog]').click();
        page.testStep = 'interface language does not change Joomla';
        assert.ok(await page.locator('#interface-language option').count() >= 20);
        for (const [language, direction] of [['af', 'ltr'], ['he', 'rtl'], ['en', 'ltr']]) {
          await page.locator('#interface-language').selectOption(language);
          await page.waitForFunction(({ language, direction }) => document.documentElement.lang === language && document.documentElement.dir === direction, { language, direction });
          assert.match(await page.frameLocator('#site-frame').locator('html').getAttribute('lang'), /^en-GB$/i);
        }
        page.testStep = 'retain temporary files, SQL and credentials';
        await showSiteActions(page);
        await page.locator('#credentials-button').click();
        const credentials = { username: await page.locator('#credential-username').inputValue(), password: await page.locator('#credential-password').inputValue() };
        assert.ok(credentials.username && credentials.password.length >= 16);
        assert.ok(!link.includes(credentials.password));
        await page.locator('#credentials-dialog [data-close-dialog]').click();
        await showQuickSettings(page);
        assert.equal(await page.locator('#persistence').isChecked(), false);
        page.testStep = 'checkpoint temporary site into browser storage';
        await setPersistence(page, true);
        assert.deepEqual(await previewContract(page), marker, 'Keep setting is staged without replacing the temporary runtime.');
        await page.locator('#save-button').click();
        await page.locator('#save-button:enabled').waitFor({ timeout: requestTimeout });
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#persistence').isChecked(), true);
        assert.deepEqual(await previewContract(page), marker);
        await showSiteActions(page);
        await page.locator('#credentials-button').click();
        assert.equal(await page.locator('#credential-username').inputValue(), credentials.username);
        assert.equal(await page.locator('#credential-password').inputValue(), credentials.password);
        await page.locator('#credentials-dialog [data-close-dialog]').click();
        page.testStep = 'a failed save keeps the running site available';
        const savedFrameURL = await page.locator('#site-frame').getAttribute('src');
        await page.evaluate(() => {
          const original = Worker.prototype.postMessage;
          window.__flushFailureInjected = false;
          Worker.prototype.postMessage = function (message, ...options) {
            if (message?.type === 'operation' && message.operation === 'flush') {
              Worker.prototype.postMessage = original; window.__flushFailureInjected = true;
              queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: message.id, error: 'Simulated storage quota failure', fatal: false } })));
              return;
            }
            return original.call(this, message, ...options);
          };
        });
        await showSiteActions(page);
        await page.locator('#new-site-button').click();
        await closeDeployEditor(page);
        await showQuickSettings(page);
        assert.deepEqual(await previewContract(page), marker, 'Staging a new site must not flush or close the running one.');
        await page.locator('#launch-button').click();
        await page.locator('#header-feedback').filter({ hasText: 'Simulated storage quota failure' }).waitFor();
        assert.equal(await page.evaluate(() => window.__flushFailureInjected), true);
        await renderedSiteFrame(page);
        assert.equal(await page.locator('#site-frame').getAttribute('src'), savedFrameURL);
        assert.deepEqual(await previewContract(page), marker);
        assert.equal(await page.locator('#save-button').isEnabled(), true);
        assert.equal(await page.locator('#download-dialog-button').isEnabled(), true);
        page.testStep = 'apply and verify PHP settings without losing data';
        await showSiteActions(page);
        await page.locator('#php-settings-button').click();
        const serviceDirectoryProfile = await page.evaluate(async () => {
          const { parseCatalog } = await import('./src/config.mjs');
          const { loadDeployCatalog, resolveDeployConfiguration } = await import('./src/deploys.mjs');
          const catalog = parseCatalog(await (await fetch('./assets/manifest.json')).json());
          const deployCatalog = await loadDeployCatalog();
          return (await resolveDeployConfiguration({ deployId: 'servicedirectory', admin: { name: 'Runtime settings test', username: 'runtimetest', email: 'runtime@example.test', password: `Rocket!${crypto.randomUUID()}` } }, { catalog, deployCatalog, baseURL: location.href })).configuration.phpSettings;
        });
        assert.equal(serviceDirectoryProfile.max_execution_time, 180);
        await page.locator('#ini-execution').fill(String(serviceDirectoryProfile.max_execution_time));
        await page.locator('#ini-vars').fill('12000');
        await page.locator('#ini-memory').fill('640M');
        await page.locator('#php-apply-button').click();
        await page.locator('#php-dialog').waitFor({ state: 'hidden', timeout: requestTimeout });
        await renderedSiteFrame(page);
        assert.deepEqual(await previewContract(page), marker);
        const settings = await previewContract(page, 'settings');
        assert.equal(settings.max_execution_time, '180');
        assert.equal(settings.max_input_vars, '12000');
        assert.equal(settings.memory_limit, '640M');
        assert.equal(settings.upload_max_filesize, '128M');
        assert.equal(settings.post_max_size, '160M');
        page.testStep = 'native Joomla global configuration form saves through CGI';
        const configurationFrame = await renderedSiteFrame(page);
        const frontendURL = configurationFrame.url();
        await configurationFrame.goto(new URL('administrator/index.php?option=com_config', frontendURL).href);
        const originalName = await configurationFrame.locator('#jform_sitename').inputValue();
        for (const name of ['Rocket configuration form proof', originalName]) {
          await configurationFrame.locator('#jform_sitename').fill(name);
          const consoleStart = page.consoleErrors.length;
          const traceFrom = await startRedirectTrace(page);
          const [savedResponse] = await Promise.all([
            configurationFrame.waitForNavigation({ waitUntil: 'load' }),
            configurationFrame.locator('joomla-toolbar-button[task="application.apply"] button').click(),
          ]);
          assert.equal(await configurationFrame.locator('#jform_sitename').inputValue(), name);
          assert.match(await configurationFrame.locator('body').innerText(), /Configuration saved/i);
          await recordVerifiedRedirectDiagnostic(page, { probe: syntheticRedirectProbe, kind: 'post303', from: consoleStart, traceFrom, finalURL: configurationFrame.url(),
            sourceURL: new URL('service-worker.mjs', server.url).href, step: page.testStep,
            responseStatus: savedResponse.status(), methodAfterRedirect: savedResponse.request().method() });
        }
        await configurationFrame.goto(frontendURL);
        assert.deepEqual(await previewContract(page), marker);
        page.testStep = 'full width and one scrolling document';
        if (await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
        const actualFrame = await renderedSiteFrame(page);
        page.testStep = 'footer settles after responsive layout updates';
        await assertFrameLayoutStable(page, actualFrame);
        page.testStep = 'full width and one scrolling document';
        await actualFrame.locator('body').evaluate(body => {
          const block = document.createElement('div'); block.id = 'rocket-scroll-proof'; block.style.cssText = 'height:3400px;position:relative'; block.textContent = 'Long Joomla document';
          const button = document.createElement('button'); button.id = 'rocket-focus-proof'; button.textContent = 'Focus at the end of the Joomla document'; button.style.cssText = 'position:absolute;bottom:0'; block.append(button); body.append(block);
        });
        await page.waitForFunction(() => { const frame = document.getElementById('site-frame'); return frame?.clientHeight >= 3400 && frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 3; });
        await page.evaluate(() => window.scrollTo(0, 1000));
        assert.ok(await page.locator('#site-header').evaluate(header => header.getBoundingClientRect().bottom < 0));
        assert.equal(await actualFrame.evaluate(() => scrollY), 0);
        page.testStep = 'embedded focus respects preventScroll and keyboard navigation';
        await page.evaluate(() => window.scrollTo(0, 0));
        await actualFrame.locator('#rocket-focus-proof').evaluate(button => {
          // Activate the child browsing context before testing its focus request.
          button.ownerDocument.defaultView.focus();
          button.focus({ preventScroll: true });
        });
        assert.equal(await actualFrame.locator('#rocket-focus-proof').evaluate(button => button === document.activeElement), true,
          'The no-scroll focus request must actually focus its target.');
        assert.equal(await page.evaluate(() => scrollY), 0, 'An extension that requests focus without scrolling must not move the Rocket header.');
        await actualFrame.locator('#rocket-focus-proof').evaluate(button => { button.blur(); button.focus(); });
        await page.waitForFunction(() => scrollY > 1000);
        assert.equal(await actualFrame.evaluate(() => scrollY), 0, 'Native focus must scroll the outer document, not the embedded site.');
        await actualFrame.locator('#rocket-focus-proof').press('Shift+Tab');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => scrollY > 1000);
        assert.equal(await actualFrame.locator('#rocket-focus-proof').evaluate(button => button === document.activeElement), true);
        page.testStep = 'header and footer hide together without replacing the live site';
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        const focus = await assertLiveFocusMode(page, actualFrame, { capture: state => page.screenshot({
          path: path.join(root, 'test-results', `rocket-${name}-${state}.png`), fullPage: false,
        }) });
        assert.deepEqual(await previewContract(page), marker);
        await actualFrame.locator('#rocket-scroll-proof').evaluate(element => element.remove());
        await page.evaluate(() => window.scrollTo(0, 0));
        await mkdir(path.join(root, 'test-results'), { recursive: true });
        for (const width of [390, 768, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
          assert.ok(await page.locator('#site-frame').evaluate(frame => Math.abs(frame.getBoundingClientRect().width - innerWidth) <= 2));
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: path.join(root, 'test-results', `rocket-${name}-${width}.png`), fullPage: true });
        }
        page.testStep = 'component parent reload preserves the Rocket shell and runtime';
        const shellIdentity = randomUUID();
        await page.evaluate(value => { window.__rocketIdentity = value; }, shellIdentity);
        const frameURL = await page.locator('#site-frame').getAttribute('src');
        assert.equal(await actualFrame.evaluate(() => parent === window), true);
        await actualFrame.evaluate(() => {
          const nested = document.createElement('iframe'); nested.id = 'rocket-nested-proof'; nested.srcdoc = '<!doctype html><title>Nested component dialog</title>'; document.body.append(nested);
        });
        await actualFrame.waitForFunction(() => document.getElementById('rocket-nested-proof')?.contentWindow.parent === window);
        await actualFrame.locator('#rocket-nested-proof').evaluate(element => element.remove());
        const reloaded = actualFrame.waitForNavigation({ waitUntil: 'load' });
        await actualFrame.evaluate(() => { setTimeout(() => parent.location.reload(), 0); });
        await reloaded;
        await actualFrame.locator('body').waitFor();
        assert.equal(await page.evaluate(() => window.__rocketIdentity), shellIdentity);
        assert.equal(await page.locator('#site-frame').getAttribute('src'), frameURL);
        assert.deepEqual(await previewContract(page), marker);
        await bounded(Promise.allSettled([...page.responseChecks]), 'Read embedded site responses', 10_000);
        await assertCleanConsole(page);
        records.push({ ...defaultPair, rocket: true, shareLink: true, independentInterfaceLanguage: true, rtl: true,
          temporaryToSaved: true, retainedCredentials: true, effectivePhpSettings: settings, singleScroll: true, focus,
          knownBrowserDiagnostics: page.knownBrowserDiagnostics });
      } catch (error) {
        if (!page.isClosed()) await saveBrowserDiagnostics(page, `rocket-${name}`, error);
        throw error;
      }
      finally { await context.close(); }
    });
    const expectedRecords = (scenarios.includes('matrix') ? combinations.length : 0)
      + scenarios.filter((scenario) => scenario !== 'matrix').length + (scenarios.includes('rocket') ? 1 : 0);
    assert.equal(records.length, expectedRecords,
      'Every selected runtime scenario must pass before writing a receipt.');
    await checkedInventory();
    await mkdir(path.join(root, 'test-results'), { recursive: true });
    await writeFile(path.join(root, 'test-results', `browser-${name}.json`), `${JSON.stringify({ browser: name, version: browser.version(), manifestSha256, inventorySha256, scenarios, syntheticRedirectProbe, records }, null, 2)}\n`);
  });
}
