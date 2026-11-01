import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { checkMcpRuntime, getMcpConnection, discoverJoomlaConfiguration, installJoomla, requestJoomlaPage } from '../src/joomla/index.mjs';
import { createMcpClient } from '../src/mcp.mjs';

const sourceLoader = (name) => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
const pairs = [ ['servicedirectory', '5'], ['servicedirectory', '6'], ['jcb-mcp', '6'] ];

for (const [deployId, major] of pairs) {
  test(`${deployId}: real Joomla ${major} installation and administrator/frontend health`, { timeout: 300_000 }, async () => {
    let runtime;
    try {
      const recipe = JSON.parse(await readFile(new URL(`../deploys/${deployId}.json`, import.meta.url), 'utf8'));
      runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4',
        phpSettings: recipe.configuration.phpSettings });
      const catalog = parseCatalog(runtime.manifest);
      const release = catalog.joomla.find((item) => item.version.startsWith(`${major}.`));
      const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
      const deployCatalog = await loadDeployCatalog({ url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset });
      const { configuration } = await resolveDeployConfiguration({ deployId, joomlaVersion: release.version,
        phpVersion: '8.4', persistence: false, fresh: true,
        admin: { name: 'Package Administrator', username: 'admin', email: 'admin@example.test', password: `Package-${crypto.randomUUID()}!` },
      }, { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
      assert.equal(configuration.language, 'en-GB');
      assert.deepEqual(configuration.phpSettings, runtime.phpSettings);
      assert.deepEqual(configuration.languages, [], 'Ordinary deployments must not fetch Joomla language packs.');
      const archive = await runtime.fetchAsset(new URL(release.url, manifestURL));
      const installed = await installJoomla(runtime, configuration, { archiveBytes: await archive.arrayBuffer(), sha256: release.sha256,
        sourceLoader, fetchPackage: runtime.fetchAsset });
      const component = deployId === 'servicedirectory' ? 'com_servicedirectory' : 'com_joomengine_mcp';
      const response = await requestJoomlaPage(runtime, `administrator/index.php?option=${component}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.doesNotMatch(html, /name=["']passwd["']|Fatal error|Uncaught (?:Error|Exception)|Call to undefined function|Missing PHP extension/i);
      assert.match(html, new RegExp(component));
      if (deployId === 'servicedirectory') {
        const discovered = await discoverJoomlaConfiguration(runtime, { sourceLoader });
        const home = discovered.menus.find((item) => Number(item.home) === 1 && item.language === '*');
        assert.ok(home && home.link.includes('option=com_servicedirectory') && home.link.includes('view=directory'));
        const page = await requestJoomlaPage(runtime, 'index.php');
        assert.equal(page.status, 200);
        assert.doesNotMatch(await page.text(), /Fatal error|Uncaught (?:Error|Exception)|Call to undefined function/i);
      } else {
        const health = await runtime.runPhp('<?php echo json_encode(["sodium" => extension_loaded("sodium"), "sodiumRoundTrip" => sodium_bin2hex(sodium_hex2bin("00ff80"))], JSON_THROW_ON_ERROR);');
        assert.deepEqual(JSON.parse(health.text), { sodium: true, sodiumRoundTrip: '00ff80' });
        assert.equal(installed.mcp?.installed, true);
        assert.equal(installed.mcp.version, '1.0.10');
        assert.equal(installed.mcp.protocolVersion, '2025-11-25');
        assert.ok(installed.mcp.toolCount > 0);
        assert.equal(installed.mcp.describedAction, 'content.categories.list');
        assert.equal(Object.hasOwn(installed.mcp, 'token'), false, 'Installation diagnostics never expose API credentials.');
        const invalid = createMcpClient({ request: runtime.request.bind(runtime), token: 'invalid-test-token' });
        await assert.rejects(invalid.initialize(), /HTTP 401/);
        const connection = await getMcpConnection(runtime, { sourceLoader, admin: configuration.admin });
        const client = createMcpClient({ request: runtime.request.bind(runtime), token: connection.token });
        try {
          await client.initialize();
          const result = await client.request('ping');
          assert.deepEqual(result, {});
        } finally { await client.close(); }
        await assert.rejects(checkMcpRuntime(runtime, { sourceLoader,
          admin: { ...configuration.admin, password: `Wrong-${crypto.randomUUID()}!` } }), /authentication failed/i);
      }
    } finally { await runtime?.close(); }
  });
}

test('manual Service Directory package keeps normal PHP settings and installs every seeded city', { timeout: 360_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
  try {
    assert.equal(runtime.phpSettings.max_execution_time, 60);
    const catalog = parseCatalog(runtime.manifest);
    const release = catalog.joomla.find(item => item.version.startsWith('6.'));
    assert.ok(release, 'The candidate must stage Joomla 6.');
    const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
    const deployCatalog = await loadDeployCatalog({ url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset });
    const shared = { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset };
    const administrator = { name: 'Manual Package Administrator', username: 'admin', email: 'admin@example.test', password: `Manual-${crypto.randomUUID()}!` };
    const { configuration: preset } = await resolveDeployConfiguration({ deployId: 'servicedirectory',
      joomlaVersion: release.version, phpVersion: '8.4', admin: administrator }, shared);
    const packageResponse = await runtime.fetchAsset(preset.extensions[0].url);
    assert.equal(packageResponse.status, 200, 'The fixture uses the staged Service Directory package.');
    const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { 'Content-Type': 'application/zip' });
      response.end(packageBytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const packageURL = `http://127.0.0.1:${server.address().port}/servicedirectory.zip`;
    const { configuration } = await resolveDeployConfiguration({ deployId: 'blank', joomlaVersion: release.version,
      phpVersion: '8.4', persistence: false, fresh: true, extensions: [{ url: packageURL }],
      admin: administrator,
    }, shared);
    assert.equal(configuration.phpSettings.max_execution_time, 60, 'Entering a package URL must not import the preset PHP settings.');
    assert.equal(configuration.menus.length, 0, 'This exercises manual package entry, not the Service Directory preset.');
    assert.deepEqual(configuration.extensions, [{ url: packageURL }], 'Manual package URLs belong to Joomla, without wrapper checksums.');
    assert.deepEqual(configuration.addonExtensions, configuration.extensions);
    const packageChecks = [];
    const commands = [];
    const instrumented = { ...runtime, runPhp: async (source, options) => {
      if (source.includes('manual-package-execution-budget')) {
        packageChecks.push(options?.timeoutMs);
        const payload = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(source)[1], 'base64'));
        commands.push(payload.argv);
        assert.equal(payload.archive, undefined, 'The wrapper must not stage the custom URL package.');
      }
      return runtime.runPhp(source, options);
    } };
    const checkedSourceLoader = async name => {
      const source = await sourceLoader(name);
      if (name !== 'console') return source;
      // Observe the real PHP setting immediately after the production helper applies it.
      const setup = 'playgroundInstallationAllowance($playground);';
      assert.ok(source.includes(setup));
      return source.replace(setup, `${setup}\n    if ((int) ini_get('max_execution_time') !== 180) throw new RuntimeException('manual-package-execution-budget');`);
    };
    const archive = await runtime.fetchAsset(new URL(release.url, manifestURL));
    assert.equal(archive.status, 200);
    const archiveBytes = await archive.arrayBuffer();
    const installed = await installJoomla(instrumented, configuration, { archiveBytes, sha256: release.sha256,
      sourceLoader: checkedSourceLoader, fetchPackage: async () => assert.fail('Joomla CLI must download the custom URL itself.') });
    assert.deepEqual(installed.extensionWarnings, []);
    assert.deepEqual(commands, [['extension:install', `--url=${packageURL}`]]);
    assert.deepEqual(requests, [{ method: 'GET', url: '/servicedirectory.zip' }]);
    assert.equal(packageChecks.length, 1, 'The package installer runs once without automatic replay.');
    assert.ok(packageChecks[0] >= 210_000, 'The host deadline must allow PHP its full 180 seconds and cleanup grace.');
    const result = await runtime.runPhp(`<?php
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
      $tables = $db->query("SHOW TABLES LIKE 'jml\\_servicedirectory\\_%'")->fetchAll(PDO::FETCH_COLUMN);
      $rows = 0; foreach ($tables as $table) $rows += (int) $db->query('SELECT COUNT(*) FROM ' . chr(96) . str_replace(chr(96), chr(96) . chr(96), $table) . chr(96))->fetchColumn();
      echo json_encode(['cities' => (int) $db->query('SELECT COUNT(*) FROM jml_servicedirectory_city')->fetchColumn(),
        'states' => (int) $db->query('SELECT COUNT(*) FROM jml_servicedirectory_state')->fetchColumn(),
        'tables' => count($tables), 'rows' => $rows, 'executionTime' => (int) ini_get('max_execution_time'),
        'marker' => json_decode(file_get_contents('/persist/meta/joomla-install.json'), true)['state']], JSON_THROW_ON_ERROR);
    `);
    assert.equal(result.status, 200, result.text);
    const proof = JSON.parse(result.text);
    assert.equal(proof.cities, 151233);
    assert.equal(proof.states, 5073);
    assert.equal(proof.tables, 24);
    assert.ok(proof.rows >= 157847, 'Every supplied seed row must remain installed.');
    assert.equal(proof.executionTime, 60, 'The installation allowance must not leak into subsequent PHP requests.');
    assert.equal(proof.marker, 'complete');
    const response = await requestJoomlaPage(runtime, 'administrator/index.php?option=com_servicedirectory&view=cities');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /com_servicedirectory/);
    assert.doesNotMatch(html, /name=["']passwd["']|Fatal error|Uncaught (?:Error|Exception)|Call to undefined function/i);
    await runtime.close();

    // A fatal exit after writes must remain incomplete and must not replay the installer.
    const failedRuntime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
    try {
      let attempts = 0;
      const fatalSourceLoader = async name => {
        const source = await sourceLoader(name);
        if (name !== 'console') return source;
        attempts++;
        const entry = '$exitCode = playgroundRunConsole($application);';
        assert.ok(source.includes(entry));
        return source.replace(entry, `file_put_contents('/persist/meta/installer-attempts.txt', 'attempt\\n', FILE_APPEND);
    register_shutdown_function(static function (): void { echo '<!DOCTYPE html><html><style>fatal-report</style></html>'; });
    exit(97);`);
      };
      await assert.rejects(installJoomla(failedRuntime, configuration, { archiveBytes, sha256: release.sha256,
        sourceLoader: fatalSourceLoader, fetchPackage: failedRuntime.fetchAsset }), error => {
        assert.equal(error.incomplete, true);
        assert.doesNotMatch(error.message, /<!DOCTYPE|<style>|Invalid PHP provisioning response/i);
        assert.match(error.technicalDetails, /fatal-report/);
        return true;
      });
      const marker = JSON.parse(await failedRuntime.fs.readFile(failedRuntime.installMarkerPath, { encoding: 'utf8' }));
      assert.equal(marker.state, 'installing');
      assert.equal(attempts, 1);
      assert.equal(await failedRuntime.fs.readFile('/persist/meta/installer-attempts.txt', { encoding: 'utf8' }), 'attempt\\n');
      await assert.rejects(installJoomla(failedRuntime, configuration, { sourceLoader }), /installation is incomplete/i);
      assert.equal(attempts, 1, 'Reopening the partial deployment must never replay its installer.');
    } finally { await failedRuntime.close(); }
  } finally { await runtime.close(); }
});
