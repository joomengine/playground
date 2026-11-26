import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventory, sha256 } from '../scripts/assets.mjs';
import { buildDeploys } from '../scripts/build-deploys.mjs';

test('prepared deploy generation rejects modified input before loading its runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-deploy-integrity-'));
  try {
    await writeFile(path.join(directory, 'asset-inventory.json'), '[]\n');
    await writeFile(path.join(directory, 'changed.mjs'), 'throw new Error("Unverified code was executed");\n');
    await assert.rejects(() => buildDeploys({ directory }), /input static artifact must match/);
    assert.equal(await readFile(path.join(directory, 'asset-inventory.json'), 'utf8'), '[]\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a downstream build reuses exact upstream snapshots and removes unselected images', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-deploy-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../src', import.meta.url), path.join(directory, 'src'), { recursive: true });
  const snapshots = path.join(directory, 'assets/snapshots');
  await mkdir(snapshots, { recursive: true });
  await mkdir(path.join(directory, 'deploys'));
  const write = (name, bytes) => writeFile(path.join(directory, name), bytes);
  const json = (name, data) => write(name, JSON.stringify(data));
  const recipe = { schemaVersion: 1, id: 'showcase', title: 'Showcase', joomla: ['6'], prebuild: true };
  const php = { version: '8.4' };
  const engineCommit = 'a'.repeat(40);
  const joomlaSha256 = 'b'.repeat(64);
  const sourceSha256 = sha256(JSON.stringify(recipe));
  const inputsSha256 = sha256(JSON.stringify({ sourceSha256, languages: [], joomlaSha256, php, engineCommit }));
  const content = Buffer.from('Verified upstream image');
  const digest = sha256(content);
  const image = { id: recipe.id, joomlaVersion: '6.2.0', phpVersion: php.version, sourceSha256, inputsSha256,
    sha256: digest, url: `snapshots/showcase-6.2.0-${digest}.zip`, size: content.length, verifiedImport: true };
  const manifest = { deployment: { canonicalUrl: 'https://example.org/fork/' }, php: [php], sourceCommit: 'c'.repeat(40),
    upstreamEngine: { sourceCommit: engineCommit }, joomla: [{ version: '6.2.0', php: ['8.4'], sha256: joomlaSha256 }],
    deploys: { url: '../deploys/catalog.json' }, prebuiltDeploys: [image] };
  await json('assets/manifest.json', manifest);
  await json('assets/version-catalog.json', {});
  await write('index.html', '<meta name="joomengine-build" content="">');
  await json('deploys/catalog.json', { schemaVersion: 1, default: 'showcase', deploys: [{ id: 'showcase', title: 'Site', file: './showcase.json' }] });
  await json('deploys/showcase.json', recipe);
  await write('assets/' + image.url, content);
  await write('assets/snapshots/not-selected.zip', 'unused');
  await json('asset-inventory.json', await inventory(directory));
  assert.deepEqual(await buildDeploys({ directory, reusePrepared: true }), [image]);
  const built = JSON.parse(await readFile(path.join(directory, 'deploys/showcase.json')));
  assert.equal(built.variants['6'].snapshot.url, '../assets/' + image.url);
  assert.deepEqual(await readdir(snapshots), [path.basename(image.url)]);
  // Even if an artifact's inventory was recomputed, the upstream image pin must still match.
  await json('deploys/showcase.json', recipe);
  await write('assets/' + image.url, 'altered');
  const inventoryPath = 'asset-inventory.json';
  await json(inventoryPath, (await inventory(directory)).filter(entry => entry.path !== inventoryPath));
  await assert.rejects(buildDeploys({ directory, reusePrepared: true }), /Upstream prepared deployment failed verification/);
});
