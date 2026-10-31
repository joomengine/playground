import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { pinnedJcbPackages } from '../src/jcb-selection.mjs';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
const catalog = JSON.parse(await readFile(path.join(directory, 'assets/version-catalog.json'), 'utf8'));
const pinnedJcb = pinnedJcbPackages(JSON.parse(await readFile(path.join(directory, 'deploys/jcb.json'), 'utf8')));
const engines = { chromium, firefox };
const browserNames = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',').filter(Boolean);
const requestTimeout = 300_000;

assert.equal(catalog.schemaVersion, 1);
assert.deepEqual(catalog.errors, [], 'An advertised package catalog must have completed discovery and staging.');
for (const name of browserNames) assert.ok(engines[name], `Unsupported browser: ${name}`);

// The existing browser matrix covers the pinned stable installations. Exercise
// every additional Joomla build, plus each JCB candidate absent from that matrix.
const cases = catalog.joomla
  .filter(entry => !manifest.joomla.some(pinned => pinned.version === entry.version))
  .map(entry => ({
    joomlaVersion: entry.version,
    joomlaSha256: entry.sha256,
    jcbVersion: entry.version.startsWith('7.') ? pinnedJcb.get('6')?.version : undefined,
    defaultJcb: entry.version.startsWith('7.'),
  }));
for (const entry of catalog.jcb) {
  const major = entry.version.split('.')[0];
  if (pinnedJcb.get(major)?.version === entry.version) continue;
  const release = catalog.joomla.find(item => item.version.startsWith(`${major}.`) && item.channel === 'stable')
    || manifest.joomla.find(item => item.version.startsWith(`${major}.`))
    || catalog.joomla.find(item => item.version.startsWith(`${major}.`));
  assert.ok(release, `JCB ${entry.version} must have a selectable Joomla release.`);
  cases.push({ joomlaVersion: release.version, jcbVersion: entry.version, jcbSha256: entry.sha256 });
}
assert.ok(cases.length, 'The production version catalog must exercise an additional Joomla or JCB package.');

async function bounded(promise, label, timeoutMs = requestTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function install(page, scenario) {
  return bounded(page.evaluate(async scenario => {
    const { parseCatalog } = await import('./src/config.mjs');
    const { loadVersionCatalog } = await import('./src/version-catalog.mjs');
    const { selectCatalogPackage } = await import('./src/dynamic-packages.mjs');
    const { dynamicJoomlaChoices } = await import('./src/dynamic-selection.mjs');
    const { loadDeployCatalog, resolveDeployConfiguration } = await import('./src/deploys.mjs');
    const { createPlayground } = await import('./src/playground.mjs');
    const pinned = parseCatalog(await (await fetch('./assets/manifest.json')).json());
    const staged = await loadVersionCatalog();
    const release = dynamicJoomlaChoices(pinned, staged.joomla).find(item => item.version === scenario.joomlaVersion);
    if (!release?.php.length) throw new Error(`No available PHP runtime for ${scenario.joomlaVersion}.`);
    const phpVersion = release.php.includes(pinned.defaults.phpVersion) ? pinned.defaults.phpVersion : release.php[0];
    const input = {
      deployId: scenario.defaultJcb ? 'jcb' : 'blank',
      joomlaVersion: scenario.joomlaVersion, phpVersion,
      siteName: `Version catalog ${scenario.joomlaVersion}`,
      storageKey: `version-catalog-${crypto.randomUUID()}`, persistence: true,
      autoLogin: true, fresh: true,
      admin: { name: 'Version catalog test', username: 'catalogtest', email: 'catalog@example.test', password: `Catalog!${crypto.randomUUID()}` },
    };
    if (!pinned.joomla.some(item => item.version === scenario.joomlaVersion)) {
      input.joomlaPackage = selectCatalogPackage(staged.joomla.find(item => item.version === scenario.joomlaVersion), { php: release.php });
    }
    if (!scenario.defaultJcb) {
      input.jcbVersion = scenario.jcbVersion || 'none';
      if (scenario.jcbVersion) input.jcbPackage = selectCatalogPackage(staged.jcb.find(item => item.version === scenario.jcbVersion));
    }
    const resolved = await resolveDeployConfiguration(input, { catalog: pinned, deployCatalog: await loadDeployCatalog(), baseURL: location.href });
    window.catalogConfiguration = resolved.configuration;
    window.catalogProgress = [];
    window.catalogSite = await createPlayground(resolved.configuration, {
      onProgress(value) { window.catalogProgress.push(value); },
    });
    return {
      version: window.catalogSite.installation.version, phpVersion,
      fromSnapshot: Boolean(window.catalogSite.installation.fromSnapshot),
      joomlaPackage: input.joomlaPackage,
      extensionURLs: resolved.configuration.extensions.map(item => item.url),
    };
  }, scenario), `Install Joomla ${scenario.joomlaVersion}${scenario.jcbVersion ? ` / JCB ${scenario.jcbVersion}` : ''}`);
}

async function installedState(page) {
  return bounded(page.evaluate(async () => {
    const result = await window.catalogSite.runPhp(`<?php
      require '/persist/www/configuration.php';
      $config = new JConfig();
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
      $prefix = str_replace(chr(96), chr(96) . chr(96), $config->dbprefix);
      $query = $db->prepare('SELECT manifest_cache, enabled FROM ' . chr(96) . $prefix . 'extensions' . chr(96) . ' WHERE type = ? AND element = ?');
      $query->execute(['package', 'pkg_component_builder']);
      $package = $query->fetch(PDO::FETCH_ASSOC);
      $component = $db->prepare('SELECT enabled FROM ' . chr(96) . $prefix . 'extensions' . chr(96) . ' WHERE type = ? AND element = ?');
      $component->execute(['component', 'com_componentbuilder']);
      $joomla = simplexml_load_file('/persist/www/administrator/manifests/files/joomla.xml');
      echo json_encode([
        'joomla' => (string) $joomla->version,
        'jcb' => $package ? json_decode($package['manifest_cache'], true, 512, JSON_THROW_ON_ERROR)['version'] : null,
        'jcbEnabled' => $component->fetchColumn(),
        'installerPresent' => is_dir('/persist/www/installation'),
        'marker' => is_file('/persist/www/version-catalog-proof.txt') ? file_get_contents('/persist/www/version-catalog-proof.txt') : null,
      ], JSON_THROW_ON_ERROR);
    `);
    if (result.status >= 400) throw new Error(`Version inspection returned HTTP ${result.status}: ${result.text}`);
    return JSON.parse(result.text.trim());
  }), 'Inspect installed Joomla and JCB');
}

for (const name of browserNames) {
  test(`${name}: staged versions download and install automatically`, { timeout: 1_800_000 }, async t => {
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await engines[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
      ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    const server = await createStaticServer({ directory, prefix: '/nested/playground/' });
    const receipts = [];
    let reopened = false;
    t.after(async () => { await browser.close(); await server.close(); });

    for (const scenario of cases) {
      await t.test(`Joomla ${scenario.joomlaVersion}${scenario.jcbVersion ? ` / JCB ${scenario.jcbVersion}` : ''}`, { timeout: 420_000 }, async child => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const receipt = { ...scenario, browser: name, completed: false, packageRequests: [], externalPackages: [], errors: [] };
        receipts.push(receipt);
        const cancel = () => { void context.close().catch(() => {}); };
        child.signal.addEventListener('abort', cancel, { once: true });
        context.on('request', request => {
          const url = new URL(request.url());
          if (/\.zip$/i.test(url.pathname)) receipt.packageRequests.push(url.href);
        });
        page.on('pageerror', error => receipt.errors.push(error.message));
        await context.route(/\.zip(?:\?|$)/i, async route => {
          if (new URL(route.request().url()).origin !== new URL(server.url).origin) {
            receipt.externalPackages.push(route.request().url());
            await route.abort('blockedbyclient');
          } else await route.continue();
        });
        try {
          await page.goto(new URL('__test__.html', server.url).href);
          assert.equal(await page.evaluate(() => crossOriginIsolated), true);
          const installation = await install(page, scenario);
          Object.assign(receipt, installation);
          assert.equal(installation.version, scenario.joomlaVersion);
          assert.equal(installation.fromSnapshot, false, 'Candidate packages must run their actual installers.');
          if (installation.joomlaPackage) assert.ok(receipt.packageRequests.includes(installation.joomlaPackage.url), 'The chosen Joomla ZIP must be downloaded from the staged catalog.');
          for (const url of installation.extensionURLs) assert.ok(receipt.packageRequests.includes(url), 'The selected JCB package must be downloaded automatically.');
          const state = await installedState(page);
          receipt.installed = state;
          assert.equal(state.joomla, scenario.joomlaVersion);
          assert.equal(state.installerPresent, false, 'Development installation cleanup must complete.');
          assert.equal(state.jcb, scenario.jcbVersion || null);
          if (scenario.jcbVersion) assert.equal(state.jcbEnabled, 1);
          assert.deepEqual(receipt.externalPackages, [], 'Automatic installs must not depend on cross-origin ZIP access.');
          assert.deepEqual(receipt.errors, []);

          if (!reopened && scenario.jcbVersion && !scenario.defaultJcb) {
            const marker = randomUUID();
            const configuration = await bounded(page.evaluate(async marker => {
              await window.catalogSite.fs.writeFile('/persist/www/version-catalog-proof.txt', marker);
              await window.catalogSite.flush();
              await window.catalogSite.close();
              window.catalogSite = null;
              return window.catalogConfiguration;
            }, marker), 'Save candidate site');
            const before = receipt.packageRequests.length;
            await page.reload();
            const result = await bounded(page.evaluate(async configuration => {
              const { createPlayground } = await import('./src/playground.mjs');
              window.catalogSite = await createPlayground(configuration);
              return { resumed: window.catalogSite.installation.resumed, configuration: window.catalogSite.configuration };
            }, configuration), 'Reopen the saved candidate without rediscovery');
            assert.equal(result.resumed, true);
            assert.deepEqual(result.configuration.jcbPackage, configuration.jcbPackage);
            assert.deepEqual(await installedState(page), { ...state, marker });
            assert.equal(receipt.packageRequests.length, before, 'A saved site must reopen without downloading or replacing its selected packages.');
            receipt.reopened = true;
            reopened = true;
          }
          receipt.completed = true;
          console.log(JSON.stringify({ browser: name, joomla: scenario.joomlaVersion, jcb: scenario.jcbVersion || null, completed: true }));
        } catch (error) {
          receipt.failure = error.stack || error.message;
          receipt.progress = await bounded(page.evaluate(() => window.catalogProgress), 'Read installation diagnostics', 3000).catch(() => null);
          throw error;
        } finally {
          child.signal.removeEventListener('abort', cancel);
          await bounded(page.evaluate(async () => { if (window.catalogSite) await window.catalogSite.reset(); }), 'Remove test site', 30_000).catch(() => {});
          await context.close();
          await mkdir(path.join(root, 'test-results'), { recursive: true });
          await writeFile(path.join(root, 'test-results', `version-catalog-${name}.json`), `${JSON.stringify({ generatedAt: catalog.generatedAt, receipts }, null, 2)}\n`);
        }
      });
    }
    assert.ok(receipts.every(receipt => receipt.completed), 'Every advertised candidate must complete its real installation.');
  });
}
