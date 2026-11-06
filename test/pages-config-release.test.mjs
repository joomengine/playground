import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../scripts/assets.mjs';
import { writeBuildIdentity } from '../scripts/build-identity.mjs';
import { configurationOnlyChanges, selectConfigurationArtifact, prepareConfigurationRelease } from '../scripts/pages-config-release.mjs';

const sourceCommit = 'a'.repeat(40);
const headCommit = 'b'.repeat(40);
const network = { schemaVersion: 1, enabled: true, endpoint: 'https://relay.example.com', protocolVersion: 1,
  turnstileSiteKey: '0x4AAAAAAAAAAAAAAAAAAAAA', proxyOrigins: [], credentialGrants: [], maxRedirects: 5 };
const allowedChanges = ['config/network.json', '.github/workflows/pages.yml', 'test/network-setup.test.mjs',
  'services/network-worker/test/worker.test.mjs', 'scripts/network-deployment-check.mjs', 'scripts/pages-config-release.mjs'];

function evidence() {
  const run = { status: 'completed', conclusion: 'success', path: '.github/workflows/pages.yml', head_branch: 'main',
    head_sha: sourceCommit, repository: { full_name: 'owner/project' }, head_repository: { full_name: 'owner/project' } };
  const artifact = { id: 1234, name: 'playground-static', expired: false, size_in_bytes: 123,
    workflow_run: { head_sha: sourceCommit } };
  let calls = 0;
  const options = { repository: 'owner/project', sourceRunId: '123', sourceCommit, headCommit,
    changes: () => allowedChanges,
    fetcher: async url => { calls++; return Response.json(url.includes('/artifacts?') ? { artifacts: [artifact] } : run); } };
  return { run, artifact, options, calls: () => calls };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pages-config-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'dist');
  const manifest = { schemaVersion: 1, sourceCommit, deployment: { environment: 'production',
    canonicalUrl: 'https://playground.example.com/', domain: 'playground.example.com' },
  network: { ...network, enabled: false, endpoint: null, turnstileSiteKey: null } };
  const entries = {
    'assets/manifest.json': JSON.stringify(manifest), 'assets/version-catalog.json': '{}',
    'assets/runtime.wasm': Buffer.from([0, 97, 115, 109, 255]), 'config/network.json': JSON.stringify(manifest.network),
    'index.html': '<html><meta name="joomengine-build" content=""></html>',
  };
  for (const [name, value] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), value);
  }
  const originalBuildId = await writeBuildIdentity(directory, manifest);
  const inventoryPath = path.join(directory, 'asset-inventory.json');
  const refreshInventory = async () => writeFile(inventoryPath, JSON.stringify((await inventory(directory))
    .filter(file => file.path !== 'asset-inventory.json')));
  await refreshInventory();
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config/network.json'), JSON.stringify(network));
  return { root, directory, manifest, originalBuildId, refreshInventory,
    options: { root, directory, sourceCommit, headCommit, sourceRunId: '123', artifactId: '1234', changes: () => allowedChanges } };
}

test('configuration reuse accepts operations changes but requires unchanged runtime and build inputs', () => {
  assert.equal(configurationOnlyChanges(allowedChanges), true);
  assert.equal(configurationOnlyChanges(['docs/network.md']), false);
  for (const file of ['src/network-transport.mjs', 'index.html', 'network-verify.html', 'native/curl-network.patch',
    'versions.json', 'package-lock.json', '.node-version', 'CNAME', 'NOTICE', 'deploys/jcb.json',
    'dependencies/joomla.json', 'config/browser-compatibility.json', 'scripts/build.mjs', 'scripts/build-identity.mjs']) {
    assert.equal(configurationOnlyChanges([...allowedChanges, file]), false, file);
  }
});

test('only a successful main Pages run with one retained matching artifact can be reused', async () => {
  const f = evidence();
  assert.deepEqual(await selectConfigurationArtifact(f.options), { reuse: true, sourceRunId: '123', sourceCommit, artifactId: '1234' });
  assert.equal(f.calls(), 2);
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_branch: 'unreviewed' },
    { head_sha: headCommit }, { path: '.github/workflows/validate.yml' }, { head_repository: { full_name: 'other/project' } }]) {
    const f = evidence(); Object.assign(f.run, change);
    assert.deepEqual(await selectConfigurationArtifact(f.options), { reuse: false });
  }
});

test('expired artifacts, unavailable evidence and changed runtime sources select the full-build path', async () => {
  for (const change of [{ expired: true }, { workflow_run: { head_sha: headCommit } }, { size_in_bytes: 0 }]) {
    const f = evidence(); Object.assign(f.artifact, change);
    assert.deepEqual(await selectConfigurationArtifact(f.options), { reuse: false });
  }
  const f = evidence();
  assert.deepEqual(await selectConfigurationArtifact({ ...f.options, fetcher: async () => { throw new Error('offline'); } }), { reuse: false });
  assert.deepEqual(await selectConfigurationArtifact({ ...f.options, changes: () => ['config/network.json', 'src/app.mjs'] }), { reuse: false });
  assert.equal(f.calls(), 0);
});

test('a configuration publication preserves runtime bytes and refreshes manifest, shell identity and inventory', async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.directory, 'assets/runtime.wasm'));
  const result = await prepareConfigurationRelease(f.options);
  const manifest = JSON.parse(await readFile(path.join(f.directory, 'assets/manifest.json'), 'utf8'));
  assert.equal(manifest.sourceCommit, headCommit);
  assert.deepEqual(manifest.network, network);
  assert.deepEqual(manifest.configurationRelease, { sourceCommit, sourceRunId: '123', artifactId: '1234' });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'config/network.json'), 'utf8')), network);
  assert.notEqual(result.buildId, f.originalBuildId);
  assert.ok((await readFile(path.join(f.directory, 'index.html'), 'utf8')).includes(result.buildId));
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'build.json'), 'utf8')).id, result.buildId);
  assert.deepEqual(await readFile(path.join(f.directory, 'assets/runtime.wasm')), before);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'asset-inventory.json'), 'utf8')),
    (await inventory(f.directory)).filter(file => file.path !== 'asset-inventory.json'));
});

test('corrupt retained bytes and unexpected artifact provenance fail before configuration mutation', async t => {
  const f = await fixture(t);
  const configBefore = await readFile(path.join(f.directory, 'config/network.json'));
  await writeFile(path.join(f.directory, 'assets/runtime.wasm'), 'tampered');
  await assert.rejects(prepareConfigurationRelease(f.options), /recorded file hash/);
  assert.deepEqual(await readFile(path.join(f.directory, 'config/network.json')), configBefore);
  await f.refreshInventory();
  await assert.rejects(prepareConfigurationRelease({ ...f.options, sourceCommit: 'c'.repeat(40) }));
  await assert.rejects(prepareConfigurationRelease({ ...f.options, changes: () => ['config/network.json', 'src/app.mjs'] }), /fresh build/);
});

test('enabled production publication rejects test widget keys and non-public configuration fields', async t => {
  const f = await fixture(t);
  for (const config of [{ ...network, turnstileSiteKey: '1x00000000000000000000AA' },
    { ...network, TURNSTILE_SECRET_KEY: 'must-not-publish' }]) {
    await writeFile(path.join(f.root, 'config/network.json'), JSON.stringify(config));
    await assert.rejects(prepareConfigurationRelease(f.options));
  }
});
