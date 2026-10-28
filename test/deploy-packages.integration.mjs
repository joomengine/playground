import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { discoverJoomlaConfiguration, installJoomla, requestJoomlaPage } from '../src/joomla/index.mjs';

const sourceLoader = (name) => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
const pairs = [ ['servicedirectory', '5'], ['servicedirectory', '6'], ['jcb-mcp', '6'] ];

for (const [deployId, major] of pairs) {
  test(`${deployId}: real Joomla ${major} installation and administrator/frontend health`, { timeout: 300_000 }, async () => {
    let runtime;
    try {
      runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
      const catalog = parseCatalog(runtime.manifest);
      const release = catalog.joomla.find((item) => item.version.startsWith(`${major}.`));
      const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
      const deployCatalog = await loadDeployCatalog({ url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset });
      const { configuration } = await resolveDeployConfiguration({ deployId, joomlaVersion: release.version,
        phpVersion: '8.4', persistence: false, fresh: true,
        admin: { name: 'Package Administrator', username: 'admin', email: 'admin@example.test', password: `Package-${crypto.randomUUID()}!` },
      }, { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
      assert.equal(configuration.language, 'en-GB');
      assert.deepEqual(configuration.languages, [], 'Ordinary deployments must not fetch Joomla language packs.');
      const archive = await runtime.fetchAsset(new URL(release.url, manifestURL));
      await installJoomla(runtime, configuration, { archiveBytes: await archive.arrayBuffer(), sha256: release.sha256,
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
      }
    } finally { await runtime?.close(); }
  });
}
