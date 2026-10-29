import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { checkpointSource, restoreCheckpointSource } from '../src/checkpoint-program.mjs';

test('private checkpoints restore exact files and credentials and reject damaged archives before changing files', { timeout: 60_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
  t.after(() => runtime.close());
  const binary = Uint8Array.from([0, 255, 128, 13, 10, 65]);
  const privateMetadata = JSON.stringify({ administrator: { password: 'Checkpoint-only test secret' } });
  await runtime.fs.writeFile('/persist/www/proof.bin', binary);
  await runtime.fs.writeFile('/persist/www/zero0-xml.xml', '<extension version="1.0"/>');
  await runtime.fs.writeFile('/persist/meta/administrator.json', privateMetadata);
  await runtime.fs.writeFile('/persist/sessions/proof', 'session-state');
  const archive = '/tmp/rocket-checkpoint-proof.zip';
  const created = await runtime.runPhp(checkpointSource(archive));
  assert.equal(created.status, 200, created.text);
  assert.equal(JSON.parse(created.text).ok, true);
  const original = await runtime.fs.readFile(archive);
  const recoveryArchive = '/tmp/rocket-checkpoint-recovery.zip';
  const recoveryCreated = await runtime.runPhp(checkpointSource(recoveryArchive, { filesOnlyRecovery: true }));
  assert.equal(recoveryCreated.status, 200, recoveryCreated.text);
  const recoveryFiles = unzipSync(await runtime.fs.readFile(recoveryArchive));
  assert.match(new TextDecoder().decode(recoveryFiles['RECOVERY.txt']), /No database data is included/);
  assert.equal(recoveryFiles['database.sql'], undefined);
  assert.deepEqual(recoveryFiles['persist/www/proof.bin'], binary);
  assert.equal(new TextDecoder().decode(recoveryFiles['persist/meta/administrator.json']), privateMetadata);
  assert.equal(unzipSync(original)['RECOVERY.txt'], undefined, 'Ordinary private checkpoints keep their existing format.');
  await runtime.fs.writeFile('/persist/www/proof.bin', 'changed');
  await runtime.fs.writeFile('/persist/www/extra.txt', 'extra');
  await runtime.fs.writeFile('/persist/meta/administrator.json', '{}');
  const restored = await runtime.runPhp(restoreCheckpointSource(archive));
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual(await runtime.fs.readFile('/persist/www/proof.bin'), binary);
  assert.equal(await runtime.fs.readFile('/persist/meta/administrator.json', { encoding: 'utf8' }), privateMetadata);
  assert.equal(await runtime.fs.readFile('/persist/sessions/proof', { encoding: 'utf8' }), 'session-state');
  assert.equal(await runtime.fs.stat('/persist/www/extra.txt'), null);
  assert.equal(await runtime.fs.readFile('/persist/www/zero0-xml.xml', { encoding: 'utf8' }), '<extension version="1.0"/>');
  for (const damage of ['checksum', 'path']) {
    const files = unzipSync(original);
    const manifest = JSON.parse(new TextDecoder().decode(files['checkpoint.json']));
    if (damage === 'checksum') files['persist/www/proof.bin'] = Uint8Array.of(7, 7, 7, 7, 7, 7);
    else manifest.entries.find(entry => entry.path === 'persist/www/proof.bin').path = 'persist/../outside';
    files['checkpoint.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    await runtime.fs.writeFile(archive, zipSync(files));
    const source = restoreCheckpointSource(archive).replace('<?php', '<?php try {')
      + '\n} catch (Throwable $error) { http_response_code(400); echo json_encode(["error" => $error->getMessage()]); }';
    const rejected = await runtime.runPhp(source);
    assert.equal(rejected.status, 400, rejected.text);
    assert.match(rejected.text, damage === 'checksum' ? /integrity/ : /unsafe/);
    assert.deepEqual(await runtime.fs.readFile('/persist/www/proof.bin'), binary);
    assert.equal(await runtime.fs.readFile('/persist/meta/administrator.json', { encoding: 'utf8' }), privateMetadata);
  }
});
