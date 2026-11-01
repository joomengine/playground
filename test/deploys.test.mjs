import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, normalizeDeploy, normalizeDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';

const root = new URL('../deploys/', import.meta.url);
const baseURL = 'https://playground.joomengine.org/deploys/catalog.json';
const sourceCatalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
const catalog = parseCatalog({
  php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4', '8.5'] }, { version: '6.2.0', php: ['8.3', '8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
});
const admin = { password: 'Deploy-contract-password-123!' };
const files = new Map(await Promise.all(['catalog', ...sourceCatalog.deploys.map((entry) => entry.id)].map(async (name) => [
  `https://playground.joomengine.org/deploys/${name}.json`, await readFile(new URL(`${name}.json`, root), 'utf8'),
])));
const fetcher = async (url) => new Response(files.get(String(url)) ?? '', { status: files.has(String(url)) ? 200 : 404 });
const deployCatalog = normalizeDeployCatalog(sourceCatalog, { baseURL });
const options = { catalog, deployCatalog, baseURL: 'https://playground.joomengine.org/', fetcher };

test('repository catalog and every manifest validate with required integrity pins', async () => {
  const loaded = await loadDeployCatalog({ url: baseURL, fetcher });
  assert.equal(loaded.default, 'jcb');
  assert.deepEqual(loaded.defaultsByJoomla, { '5': 'jcb', '6': 'jcb' });
  assert.deepEqual(loaded.deploys.map((entry) => entry.id), ['jcb', 'jcb-mcp', 'servicedirectory', 'blank', 'heritage-demo', 'patchtester', 'weblinks']);
  for (const entry of loaded.deploys) {
    const deploy = normalizeDeploy(JSON.parse(files.get(entry.url)), { baseURL: entry.url });
    assert.equal(deploy.id, entry.id);
    assert.deepEqual(deploy.requirements, entry.requirements, 'Catalog availability and launch requirements must agree.');
  }
});

test('defaults select prepared JCB on PHP 8.4 for Joomla 5 and 6', async () => {
  for (const [requested, expected, packageVersion] of [['5.4', '5.4.10', '5.2.0'], ['6.2', '6.2.0', '6.2.0']]) {
    const { configuration, deploy } = await resolveDeployConfiguration({ admin, joomlaVersion: requested }, options);
    assert.equal(configuration.deployId, 'jcb');
    assert.equal(configuration.phpVersion, '8.4');
    assert.equal(deploy.prebuild, true);
    assert.equal(configuration.joomlaVersion, expected);
    assert.equal(configuration.extensions.length, 1);
    assert.ok(configuration.extensions[0].url.endsWith(`/v${packageVersion}.zip`));
    assert.match(configuration.extensions[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(configuration.initialPath, '/administrator/index.php?option=com_componentbuilder');
    assert.deepEqual(configuration.addonExtensions, []);
  }
});

test('blank selects Joomla without JCB; explicit URL additions stay separate', async () => {
  const additions = [{ url: 'https://example.test/extension.zip' }];
  const { configuration } = await resolveDeployConfiguration({ admin, deployId: 'blank', extensions: additions, startupCommands: [['cache:clean']], autoLogin: false }, options);
  assert.equal(configuration.deployId, 'blank');
  assert.equal(configuration.autoLogin, false);
  assert.deepEqual(configuration.extensions, additions);
  assert.deepEqual(configuration.addonExtensions, additions);
  assert.deepEqual(configuration.startupCommands, [['cache:clean']]);
  assert.deepEqual(configuration.addonStartupCommands, [['cache:clean']]);
});

test('extension and CLI overrides append after a selected recipe', async () => {
  const { configuration } = await resolveDeployConfiguration({ admin, deployId: 'weblinks', phpVersion: '8.5',
    extensions: [{ url: 'https://example.test/extra.zip' }], startupCommands: [['cache:clean']], initialPath: '/' }, options);
  assert.equal(configuration.phpVersion, '8.5');
  assert.equal(configuration.initialPath, '/');
  assert.equal(configuration.extensions.length, 2);
  assert.ok(configuration.extensions[0].url.includes('pkg-weblinks-5.2.0.zip'));
  assert.deepEqual(configuration.addonExtensions, [{ url: 'https://example.test/extra.zip' }]);
});

test('language selection requires a pinned pack for the selected Joomla major', async () => {
  const { configuration } = await resolveDeployConfiguration({ admin, deployId: 'blank', language: 'nl-NL' }, options);
  assert.deepEqual(configuration.languages, deployCatalog.languages['6'].filter((entry) => entry.tag === 'nl-NL'));
  await assert.rejects(() => resolveDeployConfiguration({ admin, deployId: 'blank', language: 'xx-XX' }, options), /No pinned xx-XX/);
});

test('heritage includes all requested languages with Afrikaans first and default', async () => {
  const { configuration, deploy } = await resolveDeployConfiguration({ admin, deployId: 'heritage-demo' }, options);
  assert.equal(deploy.prebuild, true);
  assert.equal(configuration.content.multilingual, true);
  const languages = configuration.content.articles.filter((entry) => entry.home).map((entry) => entry.language);
  assert.equal(configuration.language, 'af-ZA');
  assert.equal(languages[0], 'af-ZA');
  assert.deepEqual(new Set(languages), new Set(['af-ZA', 'de-DE', 'fr-FR', 'it-IT', 'es-ES', 'zh-CN', 'nl-NL', 'en-GB']));
  assert.deepEqual(new Set(configuration.languages.map((entry) => entry.tag)), new Set(deployCatalog.languages['6'].map((entry) => entry.tag)));
  assert.deepEqual(configuration.startupCommands, [['cache:clean']]);
  assert.equal(configuration.snapshot, undefined);
});

test('snapshots require exact Joomla compatibility and fresh bypasses them', async () => {
  const deploy = JSON.parse(files.get('https://playground.joomengine.org/deploys/blank.json'));
  deploy.snapshot = { format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0',
    url: './blank-6.2.0.zip', sha256: 'c'.repeat(64) };
  const snapshotFetcher = async (url) => String(url).endsWith('/blank.json') ? new Response(JSON.stringify(deploy)) : fetcher(url);
  const prepared = await resolveDeployConfiguration({ admin, deployId: 'blank' }, { ...options, fetcher: snapshotFetcher });
  assert.equal(prepared.configuration.snapshot.url, 'https://playground.joomengine.org/deploys/blank-6.2.0.zip');
  const customizedPHP = await resolveDeployConfiguration({ admin, deployId: 'blank', phpVersion: '8.3', phpSettings: { memory_limit: '768M' } }, { ...options, fetcher: snapshotFetcher });
  assert.equal(customizedPHP.configuration.snapshot.sha256, deploy.snapshot.sha256);
  assert.equal(customizedPHP.configuration.phpVersion, '8.3');
  assert.equal(customizedPHP.configuration.phpSettings.memory_limit, '768M');
  const fresh = await resolveDeployConfiguration({ admin, deployId: 'blank', fresh: true }, { ...options, fetcher: snapshotFetcher });
  assert.equal(fresh.configuration.snapshot, undefined);
  const different = await resolveDeployConfiguration({ admin, deployId: 'blank', joomlaVersion: '5.4' }, { ...options, fetcher: snapshotFetcher });
  assert.equal(different.configuration.snapshot, undefined);
  const customized = await resolveDeployConfiguration({ admin, deployId: 'blank', content: { categories: [], articles: [] } }, { ...options, fetcher: snapshotFetcher });
  assert.equal(customized.configuration.snapshot, undefined, 'Caller content must be provisioned instead of silently reusing the original snapshot.');
  delete deploy.snapshot.joomlaVersion;
  assert.throws(() => normalizeDeploy(deploy, { baseURL }), /exact Joomla version/);
});

test('malformed registry paths, credentials, package pins and content references fail explicitly', async () => {
  assert.throws(() => normalizeDeployCatalog({ ...sourceCatalog, deploys: [{ ...sourceCatalog.deploys[0], file: '../outside.json' }] }, { baseURL }), /must use/);
  const deploy = JSON.parse(files.get('https://playground.joomengine.org/deploys/blank.json'));
  assert.throws(() => normalizeDeploy({ ...deploy, configuration: { admin: { password: 'public-secret' } } }), /unsupported property admin/);
  assert.throws(() => normalizeDeploy({ ...deploy, configuration: { extensions: [{ url: 'https://example.test/file.zip' }] } }), /SHA-256/);
  assert.throws(() => normalizeDeploy({ ...deploy, configuration: { extensions: [{ url: 'https://name:password@example.test/file.zip', sha256: 'd'.repeat(64) }] } }), /credentials/);
  assert.throws(() => normalizeDeploy({ ...deploy, variants: { '7': {} } }), /not declared/);
  const heritage = JSON.parse(files.get('https://playground.joomengine.org/deploys/heritage-demo.json'));
  heritage.configuration.content.articles[1].language = 'en-GB';
  assert.throws(() => normalizeDeploy(heritage, { baseURL }), /category in its own language/);
  await assert.rejects(() => resolveDeployConfiguration({ admin, deployId: 'blank', languages: [{ tag: 'fr-FR', url: 'https://example.test/fr.zip' }] }, options), /SHA-256/);
  await assert.rejects(() => resolveDeployConfiguration({ admin, deployId: 'missing' }, options), /Unknown deploy/);
});

test('explicit MCP on Joomla 5 fails instead of silently changing the requested deployment', async () => {
  await assert.rejects(resolveDeployConfiguration({ admin, deployId: 'jcb-mcp', joomlaVersion: '5.4' }, options), /not available for Joomla 5/);
  const { configuration } = await resolveDeployConfiguration({ admin, deployId: 'jcb', joomlaVersion: '6.2' }, options);
  assert.equal(configuration.extensions.length, 1);
  assert.equal(configuration.language, 'en-GB');
});

test('MCP remains an explicit Joomla 6 choice with both pinned packages', async () => {
  const { configuration } = await resolveDeployConfiguration({ admin, deployId: 'jcb-mcp' }, options);
  assert.equal(configuration.deployId, 'jcb-mcp');
  assert.equal(configuration.extensions.length, 2);
  assert.equal(configuration.language, 'en-GB');
});
