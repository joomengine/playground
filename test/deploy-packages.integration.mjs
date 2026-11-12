import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { getMcpConnection, discoverJoomlaConfiguration, installJoomla, requestJoomlaPage, applyJoomlaOverlays, captureJoomlaData, readJoomlaMetadata, reconcileJcbVersion } from '../src/joomla/index.mjs';
import { createMcpClient } from '../src/mcp.mjs';
import { normalizeDeploymentOverlays } from '../src/deployment-overlays.mjs';

/** Use real installed Joomla/JCB models; no doubles for validation, storage or capture. */
async function checkDeploymentOverlays(runtime, options) {
  const guid = crypto.randomUUID();
  const secondGuid = crypto.randomUUID();
  const token = `deployment-token-${crypto.randomUUID()}`;
  const repository = { system_name: 'Deployment repository', organisation: 'joomengine', repository: 'deployment-fixture',
    target: 4, type: 1, base: 'https://git.vdm.dev', access_repo: 1, token, read_branch: 'main', write_branch: 'main', published: 1 };
  const entries = normalizeDeploymentOverlays([
    { key: '2:Related.repo', kind: 'record', component: 'com_componentbuilder', view: 'repository', guid: secondGuid,
      fields: { ...repository, system_name: 'Related deployment repository', author_name: { $ref: '1:Primary.repo', field: 'guid' } } },
    { key: 'Missing:component', kind: 'record', component: 'com_absent_deployment_fixture', view: 'record', fields: { token } },
    { key: '1:Primary.repo', kind: 'record', component: 'com_componentbuilder', view: 'repository', guid, fields: repository },
    { key: 'Content:options', kind: 'component', component: 'com_content', fields: { params: { show_title: 0, show_author: 1 } } },
    { key: 'Debug:plugin', kind: 'plugin', folder: 'system', element: 'debug', fields: { enabled: 0 } },
    { key: 'Custom:module', kind: 'module', element: 'mod_custom', clientId: 0,
      fields: { title: 'Deployment overlay module', content: '<p>Native module content</p>', published: 0, position: 'debug', params: { layout: '_:default' } } },
    { key: 'Content:category', kind: 'record', component: 'com_categories', view: 'category',
      fields: { title: 'Deployment overlay category', alias: 'deployment-overlay-category', extension: 'com_content', parent_id: 1,
        published: 1, access: 1, language: '*', description: '' } },
  ]);
  const first = await applyJoomlaOverlays(runtime, entries, options);
  const result = Object.fromEntries(first.results.map(item => [item.key, item]));
  assert.equal(result['Missing:component'].status, 'skipped');
  for (const entry of entries.filter(item => item.key !== 'Missing:component')) {
    assert.equal(result[entry.key].status, 'applied', JSON.stringify(first.warnings));
    assert.ok(result[entry.key].id > 0);
  }
  assert.ok(first.results.findIndex(item => item.key === '1:Primary.repo') < first.results.findIndex(item => item.key === '2:Related.repo'), 'References order native saves even when declared first.');
  assert.equal(first.warnings.length, 1, JSON.stringify(first.warnings));
  assert.doesNotMatch(JSON.stringify(first.warnings), new RegExp(token));

  const again = await applyJoomlaOverlays(runtime, entries.filter(item => item.key !== 'Missing:component'), options);
  assert.deepEqual(again.warnings, []);
  for (const item of again.results) assert.equal(item.id, result[item.key].id, `${item.key} must update its existing native record.`);
  const captured = await captureJoomlaData(runtime, { component: 'com_componentbuilder', view: 'repositories', id: result['1:Primary.repo'].id, key: 'Capture:Primary.repo', uiLanguage: 'en' }, options);
  assert.equal(captured.overlay.view, 'repository', 'Native Table metadata resolves the list view to its editable entity.');
  assert.equal(captured.overlay.guid, guid);
  assert.equal(captured.overlay.key, 'Capture:Primary.repo');
  assert.doesNotMatch(captured.schema.properties.token.title, /^COM_COMPONENTBUILDER_/);
  assert.equal(captured.overlay.fields.token, token, 'The explicit portable deployment includes the actual repository token.');
  assert.equal(captured.overlay.fields.read_branch, 'main');
  assert.equal(captured.schema.properties.token.format, 'password');
  assert.ok(captured.schema.properties.target.oneOf.some(option => option.const === 4));
  assert.equal(captured.schema.properties.addplaceholders.type, 'array');
  assert.ok(captured.schema.properties.addplaceholders.items.properties.target);
  assert.equal(captured.schema.properties.addplaceholders.items.properties.value.default, 'default text');
  assert.equal(Object.hasOwn(captured.overlay.fields, 'id'), false);
  assert.equal(Object.hasOwn(captured.overlay.fields, 'asset_id'), false);
  assert.deepEqual(normalizeDeploymentOverlays([JSON.parse(JSON.stringify(captured.overlay))])[0].schema, captured.schema);
  const cloned = await applyJoomlaOverlays(runtime, normalizeDeploymentOverlays([JSON.parse(JSON.stringify(captured.overlay))]), options);
  assert.deepEqual(cloned.warnings, [], 'Captured saved data can be reapplied through the native adapter.');
  assert.equal(cloned.results[0].id, result['1:Primary.repo'].id);

  const related = await captureJoomlaData(runtime, { component: 'com_componentbuilder', view: 'repository', id: result['2:Related.repo'].id }, options);
  assert.equal(related.overlay.fields.author_name, guid);
  const changed = await applyJoomlaOverlays(runtime, [{ ...entries[0], fields: { author_name: { $ref: '1:Primary.repo', field: 'id' } } }], options);
  assert.deepEqual(changed.warnings, [], 'A changed entry can reference an unchanged persisted deployment record.');
  assert.equal(changed.results[0].id, result['2:Related.repo'].id);
  const component = await captureJoomlaData(runtime, { kind: 'component', component: 'com_content' }, options);
  assert.equal(Number(component.overlay.fields.params.show_title), 0);
  assert.equal(Number(component.overlay.fields.params.show_author), 1);
  const module = await captureJoomlaData(runtime, { kind: 'module', id: result['Custom:module'].id }, options);
  assert.equal(module.overlay.element, 'mod_custom');
  assert.match(module.overlay.fields.content, /Native module content/);
  assert.ok(module.schema.properties.content);
  assert.ok(module.schema.properties.params.properties.layout.oneOf.some(option => option.const === '_:default'));
  const discovered = await discoverJoomlaConfiguration(runtime, { ...options, kind: 'record', component: 'com_componentbuilder', view: 'repository', uiLanguage: 'de' });
  assert.equal(discovered.schema.properties.token.format, 'password');
  assert.equal(discovered.schema.properties.token.title, captured.schema.properties.token.title, 'Unavailable interface languages retain the installed-language fallback.');
  const targets = await discoverJoomlaConfiguration(runtime, { ...options, uiLanguage: 'en' });
  assert.equal(targets.configurationTargets.find(item => item.kind === 'module' && item.element === 'mod_custom' && item.clientId === 0).title, 'Custom');
  assert.equal(targets.configurationTargets.find(item => item.kind === 'plugin' && item.folder === 'system' && item.element === 'debug').title, 'System - Debug');

  const administratorPath = '/persist/meta/administrator.json';
  const original = await runtime.fs.readFile(administratorPath, { encoding: 'utf8' });
  const invalid = JSON.parse(original);
  invalid.administrator.password = `invalid-${crypto.randomUUID()}`;
  try {
    await runtime.fs.writeFile(administratorPath, JSON.stringify(invalid));
    await assert.rejects(captureJoomlaData(runtime, { kind: 'component', component: 'com_content' }, options), /authenticated|Super User/i);
    const refused = await applyJoomlaOverlays(runtime, [entries[2]], options);
    assert.equal(refused.results[0].status, 'skipped');
    assert.doesNotMatch(JSON.stringify(refused), new RegExp(invalid.administrator.password));
  } finally { await runtime.fs.writeFile(administratorPath, original); }
  const finalCapture = await captureJoomlaData(runtime, { component: 'com_componentbuilder', view: 'repository', id: result['1:Primary.repo'].id }, options);
  assert.equal(finalCapture.overlay.fields.token, token);
}

/** Exercise the unchanged component through its real token-authenticated HTTP transport. */
async function checkMcpRuntime(runtime, { sourceLoader, admin, initialize = false } = {}) {
  const connection = await getMcpConnection(runtime, { sourceLoader, admin, initialize });
  if (!connection.installed) return { installed: false };
  const client = createMcpClient({ request: runtime.request.bind(runtime), token: connection.token });
  try {
    const initialized = await client.initialize();
    const { tools } = await client.request('tools/list');
    if (!Array.isArray(tools) || !tools.some(tool => tool.name === 'joomla_action_describe')) {
      throw new Error('The installed MCP endpoint did not expose its action catalogue.');
    }
    const description = await client.callTool('joomla_action_describe', { action: 'content.categories.list' });
    if (description.action?.id !== 'content.categories.list') throw new Error('MCP did not describe the installed Joomla action.');
    return { installed: true, version: connection.version, endpoint: connection.endpoint,
      protocolVersion: initialized.protocolVersion, toolCount: tools.length, describedAction: description.action.id };
  } finally { await client.close(); }
}

const sourceLoader = (name) => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
const pairs = [ ['servicedirectory', '5'], ['servicedirectory', '6'], ['jcb-mcp', '6'] ];

for (const [deployId, major] of pairs) {
  test(`${deployId}: real Joomla ${major} installation and administrator/frontend health`, { timeout: 420_000 }, async () => {
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
        const mcp = await checkMcpRuntime(runtime, { sourceLoader, admin: configuration.admin });
        assert.equal(mcp.installed, true);
        assert.equal(mcp.version, '1.0.10');
        assert.equal(mcp.protocolVersion, '2025-11-25');
        assert.ok(mcp.toolCount > 0);
        assert.equal(mcp.describedAction, 'content.categories.list');
        assert.equal(Object.hasOwn(mcp, 'token'), false, 'Installation diagnostics never expose API credentials.');
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
        const actual = await readJoomlaMetadata(runtime, { sourceLoader });
        assert.equal(actual.jcbInstalled, true);
        assert.match(actual.jcbVersion, /^6\./);
        await reconcileJcbVersion(runtime, { version: actual.jcbVersion }, { sourceLoader,
          fetchPackage: () => assert.fail('An equal JCB version must not download a package.') });
        await assert.rejects(reconcileJcbVersion(runtime, { version: '0.0.0' }, { sourceLoader,
          fetchPackage: () => assert.fail('A JCB downgrade must be refused before download.') }), /cannot be downgraded/);
        await checkDeploymentOverlays(runtime, { sourceLoader, admin: configuration.admin });
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
