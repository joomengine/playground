import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCatalog } from '../src/config.mjs';
import { loadBlueprintCatalog, normalizeBlueprint, normalizeBlueprintCatalog, resolveBlueprintConfiguration } from '../src/blueprints.mjs';

const root = new URL('../blueprints/', import.meta.url);
const baseURL = 'https://playground.joomengine.org/blueprints/catalog.json';
const sourceCatalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
const catalog = parseCatalog({
  php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4', '8.5'] }, { version: '6.2.0', php: ['8.3', '8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
});
const admin = { password: 'Blueprint-contract-password-123!' };
const files = new Map(await Promise.all(['catalog', ...sourceCatalog.blueprints.map((entry) => entry.id)].map(async (name) => [
  `https://playground.joomengine.org/blueprints/${name}.json`, await readFile(new URL(`${name}.json`, root), 'utf8'),
])));
const fetcher = async (url) => new Response(files.get(String(url)) ?? '', { status: files.has(String(url)) ? 200 : 404 });
const blueprintCatalog = normalizeBlueprintCatalog(sourceCatalog, { baseURL });
const options = { catalog, blueprintCatalog, baseURL: 'https://playground.joomengine.org/', fetcher };

test('repository catalog and every manifest validate with required integrity pins', async () => {
  const loaded = await loadBlueprintCatalog({ url: baseURL, fetcher });
  assert.equal(loaded.default, 'jcb');
  assert.deepEqual(loaded.blueprints.map((entry) => entry.id), ['jcb', 'blank', 'heritage-demo', 'patchtester', 'weblinks']);
  for (const entry of loaded.blueprints) {
    const blueprint = normalizeBlueprint(JSON.parse(files.get(entry.url)), { baseURL: entry.url });
    assert.equal(blueprint.id, entry.id);
  }
});

test('default JCB chooses the complete package matching the exact Joomla release', async () => {
  for (const [requested, expected, packageVersion] of [['5.4', '5.4.10', '5.2.0'], ['6.2', '6.2.0', '6.2.0']]) {
    const { configuration } = await resolveBlueprintConfiguration({ admin, joomlaVersion: requested }, options);
    assert.equal(configuration.blueprintId, 'jcb');
    assert.equal(configuration.joomlaVersion, expected);
    assert.equal(configuration.extensions.length, 1);
    assert.ok(configuration.extensions[0].url.endsWith(`/v${packageVersion}.zip`));
    assert.match(configuration.extensions[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(configuration.initialPath, '/administrator/index.php?option=com_componentbuilder');
    assert.deepEqual(configuration.addonExtensions, []);
  }
});

test('blank and none select Joomla without JCB; explicit URL additions stay separate', async () => {
  const additions = [{ url: 'https://example.test/extension.zip' }];
  const { configuration } = await resolveBlueprintConfiguration({ admin, blueprintId: 'none', extensions: additions, startupCommands: [['cache:clean']], autoLogin: false }, options);
  assert.equal(configuration.blueprintId, 'blank');
  assert.equal(configuration.autoLogin, false);
  assert.deepEqual(configuration.extensions, additions);
  assert.deepEqual(configuration.addonExtensions, additions);
  assert.deepEqual(configuration.startupCommands, [['cache:clean']]);
  assert.deepEqual(configuration.addonStartupCommands, [['cache:clean']]);
});

test('extension and CLI overrides append after a selected recipe', async () => {
  const { configuration } = await resolveBlueprintConfiguration({ admin, blueprintId: 'weblinks', phpVersion: '8.5',
    extensions: [{ url: 'https://example.test/extra.zip' }], startupCommands: [['cache:clean']], initialPath: '/' }, options);
  assert.equal(configuration.phpVersion, '8.5');
  assert.equal(configuration.initialPath, '/');
  assert.equal(configuration.extensions.length, 2);
  assert.ok(configuration.extensions[0].url.includes('pkg-weblinks-5.2.0.zip'));
  assert.deepEqual(configuration.addonExtensions, [{ url: 'https://example.test/extra.zip' }]);
});

test('language selection requires a pinned pack for the selected Joomla major', async () => {
  const { configuration } = await resolveBlueprintConfiguration({ admin, blueprintId: 'blank', language: 'nl-NL' }, options);
  assert.deepEqual(configuration.languages, blueprintCatalog.languages['6']);
  await assert.rejects(() => resolveBlueprintConfiguration({ admin, blueprintId: 'blank', language: 'fr-FR' }, options), /No pinned fr-FR/);
});

test('heritage content requires both languages and is marked for real prebuilding', async () => {
  const { configuration, blueprint } = await resolveBlueprintConfiguration({ admin, blueprintId: 'heritage-demo' }, options);
  assert.equal(blueprint.prebuild, true);
  assert.equal(configuration.content.multilingual, true);
  assert.deepEqual(configuration.content.articles.filter((entry) => entry.home).map((entry) => entry.language), ['en-GB', 'nl-NL']);
  assert.deepEqual(configuration.languages, blueprintCatalog.languages['6']);
  assert.deepEqual(configuration.startupCommands, [['cache:clean']]);
  assert.equal(configuration.snapshot, undefined);
});

test('snapshots require exact Joomla compatibility and fresh bypasses them', async () => {
  const blueprint = JSON.parse(files.get('https://playground.joomengine.org/blueprints/blank.json'));
  blueprint.snapshot = { format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0',
    url: './blank-6.2.0.zip', sha256: 'c'.repeat(64) };
  const snapshotFetcher = async (url) => String(url).endsWith('/blank.json') ? new Response(JSON.stringify(blueprint)) : fetcher(url);
  const prepared = await resolveBlueprintConfiguration({ admin, blueprintId: 'blank' }, { ...options, fetcher: snapshotFetcher });
  assert.equal(prepared.configuration.snapshot.url, 'https://playground.joomengine.org/blueprints/blank-6.2.0.zip');
  const fresh = await resolveBlueprintConfiguration({ admin, blueprintId: 'blank', fresh: true }, { ...options, fetcher: snapshotFetcher });
  assert.equal(fresh.configuration.snapshot, undefined);
  const different = await resolveBlueprintConfiguration({ admin, blueprintId: 'blank', joomlaVersion: '5.4' }, { ...options, fetcher: snapshotFetcher });
  assert.equal(different.configuration.snapshot, undefined);
  const customized = await resolveBlueprintConfiguration({ admin, blueprintId: 'blank', content: { categories: [], articles: [] } }, { ...options, fetcher: snapshotFetcher });
  assert.equal(customized.configuration.snapshot, undefined, 'Caller content must be provisioned instead of silently reusing the original snapshot.');
  delete blueprint.snapshot.joomlaVersion;
  assert.throws(() => normalizeBlueprint(blueprint, { baseURL }), /exact Joomla version/);
});

test('malformed registry paths, credentials, package pins and content references fail explicitly', async () => {
  assert.throws(() => normalizeBlueprintCatalog({ ...sourceCatalog, blueprints: [{ ...sourceCatalog.blueprints[0], file: '../outside.json' }] }, { baseURL }), /must use/);
  const blueprint = JSON.parse(files.get('https://playground.joomengine.org/blueprints/blank.json'));
  assert.throws(() => normalizeBlueprint({ ...blueprint, configuration: { admin: { password: 'public-secret' } } }), /unsupported property admin/);
  assert.throws(() => normalizeBlueprint({ ...blueprint, configuration: { extensions: [{ url: 'https://example.test/file.zip' }] } }), /SHA-256/);
  assert.throws(() => normalizeBlueprint({ ...blueprint, configuration: { extensions: [{ url: 'https://name:password@example.test/file.zip', sha256: 'd'.repeat(64) }] } }), /credentials/);
  assert.throws(() => normalizeBlueprint({ ...blueprint, variants: { '7': {} } }), /not declared/);
  const heritage = JSON.parse(files.get('https://playground.joomengine.org/blueprints/heritage-demo.json'));
  heritage.configuration.content.articles[1].language = 'en-GB';
  assert.throws(() => normalizeBlueprint(heritage, { baseURL }), /category in its own language/);
  await assert.rejects(() => resolveBlueprintConfiguration({ admin, blueprintId: 'blank', languages: [{ tag: 'fr-FR', url: 'https://example.test/fr.zip' }] }, options), /SHA-256/);
  await assert.rejects(() => resolveBlueprintConfiguration({ admin, blueprintId: 'missing' }, options), /Unknown blueprint/);
});
