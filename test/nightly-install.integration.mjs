import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { checkJoomla, installJoomla, requestJoomlaPage, sha256 } from '../src/joomla/index.mjs';

const sourceLoader = name => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');

test('development Joomla installs finish cleanup and open administrator and frontend', { timeout: 300_000 }, async () => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
  try {
    const catalog = parseCatalog(runtime.manifest);
    const release = catalog.joomla.find(entry => entry.version === catalog.defaults.joomlaVersion);
    assert.ok(release, 'The built default Joomla package must be available.');
    assert.match(release.version, /^\d+\.\d+\.\d+$/, 'Derive this fixture from the pinned stable default.');
    const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
    const response = await runtime.fetchAsset(new URL(release.url, manifestURL));
    assert.equal(response.status, 200);
    const originalBytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(await sha256(originalBytes), release.sha256, 'Verify the built package before constructing the fixture.');

    // This is a deterministic development-state fixture, not a claim to test a
    // published nightly. Only the version metadata changes. Joomla's real CLI
    // installer remains untouched, including its decision to retain
    // installation/ for dev builds. DEV_STATUS is what
    // isInDevelopmentState() actually checks.
    const files = unzipSync(originalBytes);
    const versionPath = 'libraries/src/Version.php';
    const versionSource = strFromU8(files[versionPath]);
    const extra = /public const EXTRA_VERSION\s*=\s*'';/g;
    const status = /public const DEV_STATUS\s*=\s*'Stable';/g;
    assert.equal([...versionSource.matchAll(extra)].length, 1);
    assert.equal([...versionSource.matchAll(status)].length, 1);
    files[versionPath] = strToU8(versionSource.replace(extra, "public const EXTRA_VERSION = 'dev';")
      .replace(status, "public const DEV_STATUS = 'Development';"));
    const fixtureVersion = `${release.version}-dev`;
    const packageManifestPath = 'administrator/manifests/files/joomla.xml';
    const packageManifest = strFromU8(files[packageManifestPath]);
    const versionTag = `<version>${release.version}</version>`;
    assert.equal(packageManifest.split(versionTag).length, 2);
    files[packageManifestPath] = strToU8(packageManifest.replace(versionTag, `<version>${fixtureVersion}</version>`));
    const archiveBytes = zipSync(files, { level: 1, mtime: new Date(1980, 0, 1) });

    const deployCatalog = await loadDeployCatalog({ url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset });
    const { configuration } = await resolveDeployConfiguration({ deployId: 'blank', joomlaVersion: release.version,
      phpVersion: '8.4', persistence: false, fresh: true, jcbVersion: 'none',
      admin: { name: 'Development Administrator', username: 'admin', email: 'admin@example.test', password: `Development-${crypto.randomUUID()}!` },
    }, { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
    configuration.joomlaVersion = fixtureVersion;
    const installed = await installJoomla(runtime, configuration, { archiveBytes, sha256: await sha256(archiveBytes),
      sourceLoader, fetchPackage: runtime.fetchAsset });
    assert.equal(installed.version, fixtureVersion);
    assert.equal((await checkJoomla(runtime, { sourceLoader })).version, fixtureVersion);
    assert.equal(await runtime.fs.stat(`${runtime.documentRoot}/installation`), null,
      'A successful development installation must remove its installer directory.');
    const marker = JSON.parse(new TextDecoder().decode(await runtime.fs.readFile('/persist/meta/joomla-install.json')));
    assert.equal(marker.state, 'complete');
    assert.equal(marker.joomlaVersion, fixtureVersion);

    const frontend = await requestJoomlaPage(runtime, 'index.php');
    assert.equal(frontend.status, 200);
    assert.doesNotMatch(await frontend.text(), /Fatal error|Uncaught (?:Error|Exception)|Call to undefined function/i);
    const administrator = await requestJoomlaPage(runtime, 'administrator/index.php');
    assert.equal(administrator.status, 200);
    const adminHTML = await administrator.text();
    assert.doesNotMatch(adminHTML, /name=["']passwd["']|Fatal error|Uncaught (?:Error|Exception)|Call to undefined function/i);
    assert.match(adminHTML, /com_cpanel/);
  } finally { await runtime.close(); }
});
