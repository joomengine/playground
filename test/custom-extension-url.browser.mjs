import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function start(page, configuration) {
  return page.evaluate(async configuration => {
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
    window.playground = await createPlayground(configuration, { onProgress: event => window.validationProgress.push(event) });
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
      module, commands: structuredClone(window.observedConsoleCommands), progress: window.validationProgress };
  }, configuration);
}

async function closeSite(page) {
  await page.evaluate(async () => { await window.playground?.close(); window.playground = null; });
}

test('browser Joomla CLI custom URLs and complete local image reuse', { timeout: 900000 }, async t => {
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

  await t.test('failed optional URLs and their dependencies warn without preventing site access', async st => {
    st.after(() => closeSite(page));
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
    assert.equal(downloads, 1, 'The readable cross-origin custom package is installed exactly once.');
    assert.ok(!result.progress.some(event => event.message === 'Saving the prepared image for future sites…'), 'An incomplete recipe must not become a reusable complete image.');
    await closeSite(page);
  });

  await t.test('a complete extension image creates a separate site with new identity without reinstalling', async st => {
    st.after(() => closeSite(page));
    const config = configuration(extensionURL);
    const first = await start(page, config);
    assertHealthy(first);
    assert.deepEqual(first.installation.extensionWarnings, []);
    const saved = first.progress.findIndex(event => event.message === 'Saving the prepared image for future sites…');
    const launched = first.progress.findIndex(event => event.phase === 'launch-image');
    assert.ok(saved >= 0 && launched > saved, 'The completed image is saved before launch.');
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
