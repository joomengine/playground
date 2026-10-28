import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageDeployCatalog } from '../scripts/deploys.mjs';
import { sha256 } from '../scripts/assets.mjs';
import { normalizeDeploy, normalizeDeployCatalog } from '../src/deploys.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'playground-deploy-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, staging: path.join(root, 'dist'), assets: path.join(root, 'dist/assets'),
    cache: path.join(root, 'cache'), canonicalUrl: 'https://playground.joomengine.org/' };
  await mkdir(path.join(root, 'deploys'), { recursive: true });
  await mkdir(path.join(options.cache, 'packages'), { recursive: true });
  const bytes = Buffer.from('Pinned package fixture');
  const asset = { url: 'https://extensions.example/release.zip', sha256: sha256(bytes) };
  await writeFile(path.join(options.cache, 'packages', `${asset.sha256}.zip`), bytes);
  const snapshot = { ...asset, format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0' };
  const catalog = { schemaVersion: 1, default: 'sample', deploys: [{ id: 'sample', title: 'Sample', file: './sample.json' }],
    languages: { '6': [{ ...asset, tag: 'nl-NL' }] } };
  const deploy = { schemaVersion: 1, id: 'sample', title: 'Sample', joomla: ['6'], snapshot,
    configuration: { extensions: [asset], languages: [{ ...asset, tag: 'nl-NL' }], snapshot },
    variants: { '6': { extensions: [asset], languages: [{ ...asset, tag: 'nl-NL' }], snapshot } } };
  for (const filename of ['schema.json', 'catalog.schema.json']) {
    await writeFile(path.join(root, 'deploys', filename), '{}\n');
  }
  const save = async () => {
    await writeFile(path.join(root, 'deploys/catalog.json'), JSON.stringify(catalog));
    await writeFile(path.join(root, 'deploys/sample.json'), JSON.stringify(deploy));
  };
  await save();
  return { options, asset, bytes, catalog, deploy, save };
}

test('deploy build stages verified packages once and keeps all deployment paths relative', async t => {
  const { options, asset, bytes } = await fixture(t);
  const result = await stageDeployCatalog(options);
  assert.equal(result.packages.length, 1);
  assert.deepEqual(await readdir(path.join(options.assets, 'packages')), [`${asset.sha256}.zip`]);
  assert.deepEqual(await readFile(path.join(options.assets, 'packages', `${asset.sha256}.zip`)), bytes);
  const read = async name => JSON.parse(await readFile(path.join(options.staging, 'deploys', name), 'utf8'));
  const catalog = await read('catalog.json');
  const deploy = await read('sample.json');
  const entries = [catalog.languages['6'][0], deploy.snapshot,
    ...deploy.configuration.extensions, ...deploy.configuration.languages, deploy.configuration.snapshot,
    ...deploy.variants['6'].extensions, ...deploy.variants['6'].languages, deploy.variants['6'].snapshot];
  for (const entry of entries) {
    assert.equal(entry.url, `../assets/packages/${asset.sha256}.zip`);
    assert.equal(entry.sourceUrl, asset.url);
  }
  for (const schema of ['schema.json', 'catalog.schema.json']) assert.deepEqual(await read(schema), {});
  const baseURL = 'http://localhost:8080/nested/site/deploys/catalog.json';
  const normalized = normalizeDeployCatalog(catalog, { baseURL });
  assert.equal(normalized.languages['6'][0].url, `http://localhost:8080/nested/site/assets/packages/${asset.sha256}.zip`);
  assert.equal(normalizeDeploy(deploy, { baseURL }).variants['6'].snapshot.url,
    `http://localhost:8080/nested/site/assets/packages/${asset.sha256}.zip`);
});

test('repository deploy packages require HTTPS sources and pinned integrity', async t => {
  const { options, catalog, deploy, save } = await fixture(t);
  catalog.languages = {};
  deploy.configuration = { extensions: [{ url: 'http://localhost/package.zip', sha256: 'a'.repeat(64) }] };
  delete deploy.variants;
  delete deploy.snapshot;
  await save();
  await assert.rejects(stageDeployCatalog(options), /HTTPS/);
  deploy.configuration.extensions = [{ url: 'https://extensions.example/package.zip' }];
  await save();
  await assert.rejects(stageDeployCatalog(options), /SHA-256/);
});
