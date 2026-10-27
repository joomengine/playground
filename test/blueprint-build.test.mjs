import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageBlueprintCatalog } from '../scripts/blueprints.mjs';
import { sha256 } from '../scripts/assets.mjs';
import { normalizeBlueprint, normalizeBlueprintCatalog } from '../src/blueprints.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'playground-blueprint-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, staging: path.join(root, 'dist'), assets: path.join(root, 'dist/assets'),
    cache: path.join(root, 'cache'), canonicalUrl: 'https://playground.joomengine.org/' };
  await mkdir(path.join(root, 'blueprints'), { recursive: true });
  await mkdir(path.join(options.cache, 'packages'), { recursive: true });
  const bytes = Buffer.from('Pinned package fixture');
  const asset = { url: 'https://extensions.example/release.zip', sha256: sha256(bytes) };
  await writeFile(path.join(options.cache, 'packages', `${asset.sha256}.zip`), bytes);
  const snapshot = { ...asset, format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0' };
  const catalog = { schemaVersion: 1, default: 'sample', blueprints: [{ id: 'sample', title: 'Sample', file: './sample.json' }],
    languages: { '6': [{ ...asset, tag: 'nl-NL' }] } };
  const blueprint = { schemaVersion: 1, id: 'sample', title: 'Sample', joomla: ['6'], snapshot,
    configuration: { extensions: [asset], languages: [{ ...asset, tag: 'nl-NL' }], snapshot },
    variants: { '6': { extensions: [asset], languages: [{ ...asset, tag: 'nl-NL' }], snapshot } } };
  for (const filename of ['schema.json', 'catalog.schema.json']) {
    await writeFile(path.join(root, 'blueprints', filename), '{}\n');
  }
  const save = async () => {
    await writeFile(path.join(root, 'blueprints/catalog.json'), JSON.stringify(catalog));
    await writeFile(path.join(root, 'blueprints/sample.json'), JSON.stringify(blueprint));
  };
  await save();
  return { options, asset, bytes, catalog, blueprint, save };
}

test('blueprint build stages verified packages once and keeps all deployment paths relative', async t => {
  const { options, asset, bytes } = await fixture(t);
  const result = await stageBlueprintCatalog(options);
  assert.equal(result.packages.length, 1);
  assert.deepEqual(await readdir(path.join(options.assets, 'packages')), [`${asset.sha256}.zip`]);
  assert.deepEqual(await readFile(path.join(options.assets, 'packages', `${asset.sha256}.zip`)), bytes);
  const read = async name => JSON.parse(await readFile(path.join(options.staging, 'blueprints', name), 'utf8'));
  const catalog = await read('catalog.json');
  const blueprint = await read('sample.json');
  const entries = [catalog.languages['6'][0], blueprint.snapshot,
    ...blueprint.configuration.extensions, ...blueprint.configuration.languages, blueprint.configuration.snapshot,
    ...blueprint.variants['6'].extensions, ...blueprint.variants['6'].languages, blueprint.variants['6'].snapshot];
  for (const entry of entries) {
    assert.equal(entry.url, `../assets/packages/${asset.sha256}.zip`);
    assert.equal(entry.sourceUrl, asset.url);
  }
  for (const schema of ['schema.json', 'catalog.schema.json']) assert.deepEqual(await read(schema), {});
  const baseURL = 'http://localhost:8080/nested/site/blueprints/catalog.json';
  const normalized = normalizeBlueprintCatalog(catalog, { baseURL });
  assert.equal(normalized.languages['6'][0].url, `http://localhost:8080/nested/site/assets/packages/${asset.sha256}.zip`);
  assert.equal(normalizeBlueprint(blueprint, { baseURL }).variants['6'].snapshot.url,
    `http://localhost:8080/nested/site/assets/packages/${asset.sha256}.zip`);
});

test('repository blueprint packages require HTTPS sources and pinned integrity', async t => {
  const { options, catalog, blueprint, save } = await fixture(t);
  catalog.languages = {};
  blueprint.configuration = { extensions: [{ url: 'http://localhost/package.zip', sha256: 'a'.repeat(64) }] };
  delete blueprint.variants;
  delete blueprint.snapshot;
  await save();
  await assert.rejects(stageBlueprintCatalog(options), /HTTPS/);
  blueprint.configuration.extensions = [{ url: 'https://extensions.example/package.zip' }];
  await save();
  await assert.rejects(stageBlueprintCatalog(options), /SHA-256/);
});
