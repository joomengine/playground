import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { normalizeNetworkConfig } from '../src/network-config.mjs';
import { createBuildCanaries, canaryRepresentations, verifyPublicArtifact } from '../scripts/public-artifact-security.mjs';

async function artifact(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'public-artifact-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canaries = createBuildCanaries();
  const config = normalizeNetworkConfig({ endpoint: null });
  const manifest = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), deployment: { environment: 'production' }, network: config };
  const put = async (name, bytes) => { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), bytes); };
  await put('assets/manifest.json', JSON.stringify(manifest));
  await put('config/network.json', JSON.stringify(config));
  return { directory, canaries, config, manifest, put, verify: () => verifyPublicArtifact({ directory, canaries }) };
}

test('the final artifact gate scans generated binary and snapshot data without unpacking upstream archives', async t => {
  const fixture = await artifact(t);
  await fixture.put('assets/native.so', Buffer.from([0, 1, 255, 4]));
  await fixture.put('assets/joomla/upstream.zip', 'Hash-pinned upstream bytes are not decompressed by this separate check.');
  await fixture.put('assets/snapshots/site.zip', zipSync({ 'site/index.php': strToU8('<?php echo "safe";') }));
  const result = await fixture.verify();
  assert.equal(result.files, 5); assert.equal(result.snapshots, 1); assert.equal(result.snapshotEntries, 1);
});

test('raw, encoded, UTF-16 and chunk-spanning server credentials fail without exposing their values', async t => {
  const fixture = await artifact(t);
  const representations = canaryRepresentations(fixture.canaries);
  const value = Object.values(fixture.canaries)[0];
  for (const bytes of [...representations.map(value => Buffer.from(value)), Buffer.from(value, 'utf16le')]) {
    await fixture.put('assets/generated.wasm', Buffer.concat([Buffer.alloc(65530), bytes, Buffer.alloc(20)]));
    await assert.rejects(fixture.verify(), error => {
      assert.match(error.message, /canary leaked/);
      assert.ok(Object.values(fixture.canaries).every(value => !error.message.includes(value)));
      return true;
    });
  }
});

test('compressed generated snapshots cannot conceal server credential canaries', async t => {
  const fixture = await artifact(t);
  const value = Object.values(fixture.canaries)[0];
  await fixture.put('assets/snapshots/site.zip', zipSync({ 'site/configuration.php': strToU8(`<?php $private = '${value}';`) }, { level: 9 }));
  await assert.rejects(fixture.verify(), /canary leaked.*snapshot entry/);
});

test('Worker source, private configuration and unselected staging configuration cannot ship publicly', async t => {
  const fixture = await artifact(t);
  for (const filename of ['services/network-worker/src/index.mjs', 'wrangler.jsonc', '.dev.vars', 'config/.env',
    'config/.env.development', 'config/.env.test', 'config/.env.production.local', 'config/network.staging.json']) {
    await fixture.put(filename, '{}');
    await assert.rejects(fixture.verify(), /Server-only file/);
    await rm(path.join(fixture.directory, filename));
    if (filename.startsWith('services/')) await rm(path.join(fixture.directory, 'services'), { recursive: true });
  }
});

test('credential-derived filenames and ZIP entry names fail with redacted constant diagnostics', async t => {
  const fixture = await artifact(t);
  const value = Object.values(fixture.canaries)[0];
  for (const name of [value, encodeURIComponent(value), Buffer.from(value).toString('hex')]) {
    const filename = `assets/leak-${name}.json`;
    await fixture.put(filename, '{}');
    await assert.rejects(fixture.verify(), error => {
      assert.equal(error.message, 'Server credential canary leaked into public artifact: public artifact pathname');
      assert.ok(!error.message.includes(value) && !error.message.includes(name)); return true;
    });
    // Raw base64 can create several directory components; remove the full test
    // payload tree so each representation is independently inspected.
    await rm(path.join(fixture.directory, 'assets'), { recursive: true });
    await fixture.put('assets/manifest.json', JSON.stringify(fixture.manifest));
    await fixture.put('assets/snapshots/site.zip', zipSync({ [`site/${name}/index.php`]: strToU8('safe') }));
    await assert.rejects(fixture.verify(), error => {
      // ZIP names are also present in its raw directory headers, so either
      // scan can reject them; neither is allowed to disclose path contents.
      assert.match(error.message, /^Server credential canary leaked into public artifact: (public artifact contents|snapshot entry pathname)$/);
      assert.ok(!error.message.includes(value) && !error.message.includes(name)); return true;
    });
    await rm(path.join(fixture.directory, 'assets/snapshots'), { recursive: true });
  }
});

test('public manifest and network config must retain the normalized production schema', async t => {
  const fixture = await artifact(t);
  for (const config of [{ ...fixture.config, privateSecret: 'not-public' }, {}]) {
    await fixture.put('config/network.json', JSON.stringify(config));
    await assert.rejects(fixture.verify(), /unsupported or non-public|normalized public schema/);
  }
  await fixture.put('config/network.json', JSON.stringify(fixture.config));
  for (const manifest of [{ ...fixture.manifest, network: {} }, { ...fixture.manifest, deployment: { environment: 'staging' } }]) {
    await fixture.put('assets/manifest.json', JSON.stringify(manifest));
    await assert.rejects(fixture.verify(), /normalized public schema|deployment identity/);
  }

});

test('the mandatory build injects harmless canaries and verifies final snapshots before publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  for (const mode of ['build', 'snapshots', 'verify']) assert.match(workflow, new RegExp(`run: node scripts/build-public-artifact\\.mjs ${mode}`));
  assert.ok(workflow.indexOf('run: node scripts/build-public-artifact.mjs verify') < workflow.indexOf('name: Retain candidate static distribution'));
  assert.doesNotMatch(workflow, /secrets\./);
});
