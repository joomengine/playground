import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
const phpVersion = process.env.PLAYGROUND_PHP_VERSIONS?.split(',')[0] || '8.4';
const joomlaVersion = process.env.PLAYGROUND_JOOMLA_VERSIONS?.split(',')[0] || manifest.defaults.joomlaVersion;
const archive = zipSync({
  'mod_playground_url_contract.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><extension type="module" client="site" method="upgrade"><name>mod_playground_url_contract</name><author>JoomEngine</author><version>1.0.0</version><description>Custom URL browser contract</description><files><filename module="mod_playground_url_contract">mod_playground_url_contract.php</filename></files></extension>'),
  'mod_playground_url_contract.php': strToU8("<?php defined('_JEXEC') or die; echo 'Custom URL browser contract';"),
});

function configuration(extensionURL, extra = {}) {
  const extension = { url: extensionURL, sha256: 'Custom URL checksums are ignored.' };
  return { phpVersion, joomlaVersion, deployId: 'blank', persistence: false,
    siteName: 'URL contract first site', initialPath: '/administrator/',
    admin: { username: 'urlcontract', name: 'URL Contract Administrator', email: 'url@example.test', password: 'URL-contract-password-123!' },
    extensions: [extension], addonExtensions: [extension], startupCommands: [], ...extra };
}

async function start(page, configuration, options = {}) {
  return page.evaluate(async ({ configuration, options }) => {
    const { createPlayground, PhpSession } = await import('./src/playground.mjs');
    if (!window.observedConsoleCommands) {
      window.observedConsoleCommands = [];
      const send = PhpSession.prototype.send;
      PhpSession.prototype.send = function (operation, args, ...rest) {
        if (operation === 'runPhp') {
          const encoded = /base64_decode\('([^']+)'\)/.exec(args.source)?.[1];
          if (encoded) {
            const payload = JSON.parse(atob(encoded));
            if (payload.argv) window.observedConsoleCommands.push(payload.argv);
          }
        }
        return send.call(this, operation, args, ...rest);
      };
    }
    window.validationProgress = [];
    window.playground = await createPlayground(configuration, { ...options, onProgress: event => window.validationProgress.push(event) });
    const frontend = await window.playground.request('/');
    const administrator = await window.playground.request('/administrator/');
    const marker = JSON.parse(new TextDecoder().decode(await window.playground.fs.readFile('/persist/meta/joomla-install.json')));
    const module = new TextDecoder().decode(await window.playground.fs.readFile('/persist/www/modules/mod_playground_url_contract/mod_playground_url_contract.php'));
    const { administrator: identity, ...installation } = window.playground.installation;
    const credentials = btoa(JSON.stringify({ username: configuration.admin.username, password: configuration.admin.password }));
    const response = await window.playground.runPhp(`<?php
      require '/persist/www/configuration.php';
      $config = new JConfig();
      $credentials = json_decode(base64_decode('${credentials}'), true);
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
      $query = $db->prepare('SELECT password FROM ' . $config->dbprefix . 'users WHERE username = ?');
      $query->execute([$credentials['username']]);
      echo json_encode(['siteName' => $config->sitename, 'passwordMatches' => password_verify($credentials['password'], $query->fetchColumn())]);
    `);
    const account = JSON.parse(response.text ?? new TextDecoder().decode(response.body));
    return { installation, identity: { username: identity.username, name: identity.name, email: identity.email }, account,
      frontendStatus: frontend.status, administratorStatus: administrator.status, markerWarnings: marker.extensionWarnings,
      module, commands: structuredClone(window.observedConsoleCommands), progress: window.validationProgress,
      lastSavedAt: window.playground.lastSavedAt };
  }, { configuration, options });
}

async function closeSite(page) {
  await page.evaluate(async () => { await window.playground?.close(); window.playground = null; });
}

// Seed an image as an earlier build did. New launches must still read compatible
// cached images, but must not pay this full export cost before opening the site.
async function cacheInstalledImage(page) {
  return page.evaluate(async () => {
    const started = performance.now();
    const { deploymentImages } = await import('./src/deployment-images.mjs');
    const manifest = await (await fetch('./assets/manifest.json')).json();
    const exported = await window.playground.exportSite({ format: 'bundle' });
    await deploymentImages.saveCustom(window.playground.configuration, manifest, exported.bytes);
    return { durationMs: Math.round(performance.now() - started), images: await deploymentImages.list() };
  });
}

test('browser Joomla CLI custom URLs launch directly and retain compatible local images', { timeout: 900000 }, async t => {
  let downloads = 0;
  const server = await createStaticServer({ directory });
  const cors = await createStaticServer({ directory, prefix: '/addons/', corsOrigin: new URL(server.url).origin,
    fixtures: { 'module.zip': () => { downloads++; return archive; } } });
  const executablePath = process.env.PLAYGROUND_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  t.after(async () => { await browser.close(); await server.close(); await cors.close(); });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  await page.goto(new URL('__test__.html', server.url).href);
  await prepareBrowserEnvironment(page);
  const extensionURL = new URL('module.zip', cors.url).href;
  const assertHealthy = result => {
    assert.equal(result.frontendStatus, 200);
    assert.equal(result.administratorStatus, 200);
    assert.match(result.module, /Custom URL browser contract/);
    assert.equal(result.account.passwordMatches, true);
  };

  await t.test('deferred first persistence exposes a usable site and an awaited checkpoint can resume it', async st => {
    st.after(() => closeSite(page));
    const config = configuration(extensionURL, { persistence: true, storageKey: 'deferred-save-contract' });
    const first = await start(page, config, { deferInitialSave: true });
    assertHealthy(first);
    assert.equal(first.lastSavedAt, null, 'Ready must not claim storage completion before the background checkpoint.');
    const savedAt = await page.evaluate(async () => { await window.playground.flush(); return window.playground.lastSavedAt; });
    assert.ok(Number.isFinite(Date.parse(savedAt)));
    const before = downloads;
    await closeSite(page);
    const resumed = await start(page, config);
    assertHealthy(resumed);
    assert.equal(resumed.installation.resumed, true);
    assert.ok(Number.isFinite(Date.parse(resumed.lastSavedAt)), 'The default API still awaits initial persistence.');
    assert.equal(downloads, before, 'Saved-site resume must not reinstall the extension.');
    await closeSite(page);
  });

  await t.test('failed optional URLs and their dependencies warn without preventing site access', async st => {
    st.after(() => closeSite(page));
    const before = downloads;
    const config = configuration(extensionURL);
    const missing = { url: new URL('missing.zip', cors.url).href };
    config.extensions.push(missing);
    config.addonExtensions.push(missing);
    const template = { element: 'missing_template', url: new URL('missing-template.zip', cors.url).href };
    Object.assign(config, { template, addonTemplate: template,
      menus: [{ key: 'missing-addon', title: 'Missing addon', alias: 'missing-addon', component: 'com_missing_url_contract', view: 'items' }],
      startupCommands: [['missing-addon:prepare']], addonStartupCommands: [['missing-addon:prepare']] });
    const result = await start(page, config);
    assertHealthy(result);
    assert.deepEqual(result.installation.extensionWarnings.map(warning => warning.package), ['Extension 2', 'Template', 'Menu', 'Command 1']);
    assert.deepEqual(result.markerWarnings, result.installation.extensionWarnings);
    assert.equal(downloads, before + 1, 'The readable cross-origin custom package is installed exactly once.');
    assert.ok(!result.progress.some(event => event.message === 'Saving the prepared image for future sites…'), 'An incomplete recipe must not become a reusable complete image.');
    await closeSite(page);
  });

  await t.test('a complete extension image creates a separate site with new identity without reinstalling', async st => {
    st.after(() => closeSite(page));
    const config = configuration(extensionURL);
    const first = await start(page, config);
    assertHealthy(first);
    assert.deepEqual(first.installation.extensionWarnings, []);
    assert.ok(!first.progress.some(event => /Preparing the image for reuse|Saving the prepared image/.test(event.message)),
      'A custom site must open before any optional archive export.');
    await cacheInstalledImage(page);
    const before = downloads;
    await closeSite(page);
    const second = await start(page, { ...config, siteName: 'A separate second site',
      admin: { username: 'secondadmin', name: 'Second Administrator', email: 'second@example.test', password: 'Different-password-456!' } });
    assertHealthy(second);
    assert.equal(second.installation.fromSnapshot, true);
    assert.equal(second.account.siteName, 'A separate second site');
    assert.equal(second.identity.username, 'secondadmin');
    assert.equal(second.identity.email, 'second@example.test');
    assert.equal(downloads, before, 'A reused image must not fetch the custom extension again.');
    assert.deepEqual(second.commands, first.commands, 'A complete image must not replay extension CLI installation.');
    assert.ok(!second.progress.some(event => event.phase === 'build-image'));
    await closeSite(page);
  });

  await t.test('a complete command recipe is reused without replay and rotates the administrator password', async st => {
    st.after(() => closeSite(page));
    const config = configuration(extensionURL, { startupCommands: [['list']], addonStartupCommands: [['list']] });
    const first = await start(page, config);
    assertHealthy(first);
    assert.equal(first.commands.filter(argv => argv[0] === 'list').length, 1);
    await cacheInstalledImage(page);
    const before = downloads;
    await closeSite(page);
    const second = await start(page, { ...config, admin: { ...config.admin, password: 'Rotated-password-789!' } });
    assertHealthy(second);
    assert.equal(second.installation.fromSnapshot, true);
    assert.equal(downloads, before);
    assert.deepEqual(second.commands, first.commands, 'Neither the extension install nor the command may be replayed.');
    await closeSite(page);
  });
});

test('large custom Service Directory launches without export and still reads a compatible cached image', { timeout: 900000 }, async t => {
  const recipe = JSON.parse(await readFile(new URL('../deploys/servicedirectory.json', import.meta.url), 'utf8'));
  const sourceURL = recipe.variants['6'].extensions[0].url;
  const maintainedPackage = manifest.deploys.packages.find(entry => entry.sourceUrl === sourceURL);
  assert.ok(maintainedPackage, 'The built catalog must contain the Service Directory fixture.');
  const serviceArchive = await readFile(path.join(directory, 'assets', maintainedPackage.url));
  let downloads = 0;
  const server = await createStaticServer({ directory, fixtures: {
    'manual-servicedirectory.zip': () => { downloads++; return serviceArchive; },
  } });
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await server.close(); } });
  const executablePath = process.env.PLAYGROUND_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto(new URL('__test__.html', server.url).href);
  await prepareBrowserEnvironment(page);
  const config = configuration(new URL('manual-servicedirectory.zip', server.url).href, {
    phpVersion: '8.4', joomlaVersion: manifest.joomla.find(entry => entry.version.startsWith('6.')).version,
  });
  // Exercise the public configuration boundary: URL-only addons do not inherit
  // the maintained Service Directory preset's longer normal request timeout.
  delete config.addonExtensions;
  const launch = configuration => page.evaluate(async configuration => {
    const { createPlayground, PhpSession } = await import('./src/playground.mjs');
    if (!window.largeImageCalls) {
      window.largeImageCalls = { commands: [], exports: [] };
      window.largeImageDatabase = { pending: null, lastCompleted: null };
      const receive = PhpSession.prototype.receive;
      PhpSession.prototype.receive = async function (message) {
        if (message?.type !== 'database-call') return receive.call(this, message);
        const payload = JSON.parse(message.payload);
        const summary = { operation: payload.op, sql: payload.sql?.match(/^(?:[A-Za-z_]+|\s|`[A-Za-z_]+`)+/)?.[0]?.slice(0, 100) };
        window.largeImageDatabase.pending = summary;
        const started = performance.now();
        try { return await receive.call(this, message); }
        finally {
          window.largeImageDatabase.lastCompleted = { ...summary, durationMs: performance.now() - started };
          window.largeImageDatabase.pending = null;
        }
      };
      const send = PhpSession.prototype.send;
      PhpSession.prototype.send = function (operation, args, ...rest) {
        if (operation === 'runPhp') {
          const encoded = /base64_decode\('([^']+)'\)/.exec(args.source)?.[1];
          if (encoded) {
            const payload = JSON.parse(atob(encoded));
            if (payload.argv) window.largeImageCalls.commands.push(payload.argv);
            if (payload.operation === 'create') window.largeImageCalls.exports.push(payload.executionTimeSeconds);
          }
        }
        return send.call(this, operation, args, ...rest);
      };
    }
    const progress = window.largeImageProgress = [];
    try {
      window.playground = await createPlayground(configuration, { onProgress: event => progress.push(event) });
    } catch (error) {
      window.largeImageFailure = { message: error.message, technicalDetails: error.technicalDetails };
      throw error;
    }
    const result = await window.playground.runPhp(`<?php
      require '/persist/www/configuration.php';
      $config = new JConfig();
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
      echo json_encode(['cities'=>(int)$db->query('SELECT COUNT(*) FROM jml_servicedirectory_city')->fetchColumn(),
        'states'=>(int)$db->query('SELECT COUNT(*) FROM jml_servicedirectory_state')->fetchColumn(),
        'executionTime'=>(int)ini_get('max_execution_time'), 'siteName'=>$config->sitename]);
    `);
    const data = JSON.parse(result.text ?? new TextDecoder().decode(result.body));
    const administrator = await window.playground.request('/administrator/index.php?option=com_servicedirectory&view=cities');
    const planResult = await window.playground.runPhp(`<?php
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
      echo json_encode($db->query('EXPLAIN SELECT a.*,g.name AS state_name,g.id AS state_id,ag.title AS access_level
        FROM jml_servicedirectory_city a LEFT JOIN jml_servicedirectory_state g ON a.state=g.guid
        LEFT JOIN jml_viewlevels ag ON ag.id=a.access WHERE a.published=0 OR a.published=1
        ORDER BY a.id DESC LIMIT 20')->fetchAll(PDO::FETCH_ASSOC));
    `);
    const plan = JSON.parse(planResult.text ?? new TextDecoder().decode(planResult.body));
    const { deploymentImages } = await import('./src/deployment-images.mjs');
    return { data, plan, administratorStatus: administrator.status,
      warnings: window.playground.installation.extensionWarnings,
      fromSnapshot: window.playground.installation.fromSnapshot,
      configuredExecutionTime: window.playground.configuration.phpSettings.max_execution_time,
      images: await deploymentImages.list(), calls: structuredClone(window.largeImageCalls), progress };
  }, configuration);
  const buildStarted = performance.now();
  let first;
  try { first = await launch(config); }
  catch (error) {
    t.diagnostic(JSON.stringify({ consoleErrors, state: await page.evaluate(() => ({
      failure: window.largeImageFailure, progress: window.largeImageProgress, database: window.largeImageDatabase,
    })) }));
    throw error;
  }
  assert.deepEqual(first.data, { cities: 151233, states: 5073, executionTime: 60, siteName: config.siteName });
  assert.equal(first.configuredExecutionTime, 60);
  assert.equal(first.administratorStatus, 200);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.calls.exports, [], 'Launching must not dump and compress all 151233 cities into an optional image.');
  assert.equal(first.images.filter(image => image.kind === 'custom').length, 0);
  assert.equal(downloads, 1);
  assert.ok(!first.progress.some(event => /Preparing the image for reuse|Saving the prepared image/.test(event.message)));
  assert.ok(!first.progress.some(event => event.phase === 'warning'));
  const buildMs = Math.round(performance.now() - buildStarted);
  const cached = await cacheInstalledImage(page);
  const callsAfterExport = await page.evaluate(() => structuredClone(window.largeImageCalls));
  assert.deepEqual(callsAfterExport.exports, [570], 'An explicitly requested export retains its full allowance.');
  if (process.env.PLAYGROUND_LARGE_IMAGE_ARTIFACT) {
    const encoded = await page.evaluate(async key => {
      const { deploymentImages } = await import('./src/deployment-images.mjs');
      const { bytes } = await deploymentImages.getCustom(key.slice('custom:'.length));
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return btoa(binary);
    }, cached.images.find(image => image.kind === 'custom').key);
    await writeFile(process.env.PLAYGROUND_LARGE_IMAGE_ARTIFACT, Buffer.from(encoded, 'base64'));
  }
  t.diagnostic(`Site opened in ${buildMs} ms with ${first.data.cities} cities. The optional export/cache cost removed from launch was ${cached.durationMs} ms.`);
  await closeSite(page);
  const restoreStarted = performance.now();
  let second;
  try {
    second = await launch({ ...config, siteName: 'Separate cached directory',
      admin: { username: 'directoryowner', name: 'Directory Owner', email: 'directory@example.test', password: 'Directory-password-456!' } });
  } catch (error) {
    t.diagnostic(JSON.stringify({ consoleErrors, state: await page.evaluate(() => ({
      progress: window.largeImageProgress, database: window.largeImageDatabase,
    })) }));
    throw error;
  }
  assert.equal(second.fromSnapshot, true);
  assert.deepEqual(second.data, { cities: 151233, states: 5073, executionTime: 60, siteName: 'Separate cached directory' });
  assert.equal(second.administratorStatus, 200);
  assert.equal(second.plan.find(row => row.table === 'g').key, 'idx_guid', 'The restored state lookup must use its index rather than scan thousands of states for every city.');
  assert.deepEqual(second.warnings, []);
  assert.equal(second.configuredExecutionTime, 60);
  assert.equal(downloads, 1, 'The complete large image must not download the extension again.');
  assert.deepEqual(second.calls, callsAfterExport, 'Reuse must not reinstall the extension or rebuild/export the image.');
  assert.ok(!second.progress.some(event => event.phase === 'build-image'));
  assert.deepEqual(consoleErrors, [], 'Both building and reusing the image must leave a clean browser console.');
  t.diagnostic(`The separate site reused the large image in ${Math.round(performance.now() - restoreStarted)} ms without an extension download or CLI install.`);
  await closeSite(page);
});
