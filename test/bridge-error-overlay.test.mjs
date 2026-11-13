import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { sha256 } from '../scripts/assets.mjs';
import { applyBridgeErrorOverlay, bridgeRuntimeAssetPath } from '../scripts/bridge-error-overlay.mjs';
import { isStorageQuotaError, withStorageRecovery } from '../src/storage-recovery.mjs';

const pins = {
  'errors.mjs': '27a25610082b7cf34894a8066457fa46da40555ffc2e5cda7cbbfaa11673e217',
  'index.mjs': '2d555f80891ce28f520893e85d493e78cd0215757b4962f2cf2f48562792ba1f',
};
async function fixture(t, worker = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-error-overlay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'src'));
  const manifest = { files: {} };
  for (const [file, digest] of Object.entries(pins)) {
    const source = await readFile(new URL(`./fixtures/bridge-0.1.8/${file}`, import.meta.url), 'utf8');
    assert.equal(sha256(source), digest, 'The fixture must be the pinned upstream source.');
    await writeFile(path.join(directory, 'src', file), source);
    manifest.files[`src/${file}`] = { sha256: digest };
  }
  // Only the worker boundary is simulated. The client, error serializer and
  // reconstructed Error are the actual pinned sources with the build overlay.
  await writeFile(path.join(directory, 'src/protocol.mjs'),
    "export const HOST_CALL = 'mariadb.v1'; export const PROTOCOL_VERSION = 1; export function identifier(value) { return value; }\n");
  await writeFile(path.join(directory, 'src/worker.mjs'), worker);
  return { directory, manifest };
}

test('real bridge worker error roundtrip retains empty-message quota identity and enables one safe retry', async t => {
  const { directory, manifest } = await fixture(t, `
    import { parentPort } from 'node:worker_threads';
    import { errorRecord } from './errors.mjs';
    let writes = 0;
    parentPort.on('message', ({ id, operation }) => {
      if (operation === 'flush' && ++writes === 1) {
        parentPort.postMessage({ id, ok: false, error: errorRecord(new DOMException('', 'QuotaExceededError')) });
      } else parentPort.postMessage({ id, ok: true, value: operation === 'initialize' ? { serverVersion: 'fixture' } : writes });
    });
  `);
  const overlay = await applyBridgeErrorOverlay(directory, { manifest, upstreamVersion: '0.1.8' });
  const { createMariaDB } = await import(pathToFileURL(path.join(directory, 'src/index.mjs')));
  const database = await createMariaDB();
  t.after(() => database.close());
  let reclaimed = 0, observed;
  assert.equal(await withStorageRecovery(() => database.flush(), {
    reclaim: async () => { reclaimed++; return { removed: 1, bytes: 1024 }; },
    storage: null,
    onRecovery: details => { observed = details; },
  }), 2);
  assert.equal(reclaimed, 1);
  assert.equal(observed.originalError.name, 'QuotaExceededError');
  assert.equal(observed.originalError.originalCode, 22);
  assert.equal(observed.originalError.code, 'DATABASE_ERROR', 'The native protocol keeps its existing string error code.');
  assert.match(observed.originalError.message, /storage limit/);
  assert.equal(isStorageQuotaError(observed.originalError), true);
  assert.equal(database.state, 'ready');
  assert.equal(overlay.files.length, 2);
  for (const file of overlay.files) assert.equal(file.sha256, sha256(await readFile(path.join(directory, file.file))));
});

test('a slow database flush retains its worker and serialized queue until persistence settles', async t => {
  const { directory, manifest } = await fixture(t, `
    import { parentPort } from 'node:worker_threads';
    let flushed = false;
    parentPort.on('message', ({ id, operation }) => {
      if (operation === 'flush') {
        setTimeout(() => { flushed = true; parentPort.postMessage({ id, ok: true }); }, 200);
      } else parentPort.postMessage({ id, ok: true, value: operation === 'initialize' ? { serverVersion: 'fixture' } : flushed });
    });
  `);
  await applyBridgeErrorOverlay(directory, { manifest, upstreamVersion: '0.1.8' });
  const { createMariaDB } = await import(pathToFileURL(path.join(directory, 'src/index.mjs')));
  const database = await createMariaDB({ timeoutMs: 50 });
  t.after(() => database.close());
  const originalWarn = console.warn, warnings = [];
  console.warn = message => warnings.push(message);
  try {
    const saving = database.flush();
    const later = database.reset();
    await saving;
    assert.equal(await later, true, 'Later operations must wait for the actual flush result.');
    assert.equal(database.state, 'ready');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pending changes have been retained/);
  } finally { console.warn = originalWarn; }
});

test('ordinary database operations retain their existing destructive timeout policy', async t => {
  const { directory, manifest } = await fixture(t, `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({ id, operation }) => {
      if (operation === 'initialize') parentPort.postMessage({ id, ok: true, value: { serverVersion: 'fixture' } });
    });
  `);
  await applyBridgeErrorOverlay(directory, { manifest, upstreamVersion: '0.1.8' });
  const { createMariaDB } = await import(pathToFileURL(path.join(directory, 'src/index.mjs')));
  const database = await createMariaDB({ timeoutMs: 50 });
  await assert.rejects(database.reset(), error => error.code === 'TIMEOUT');
  assert.equal(database.state, 'closed');
  await database.close();
});

test('unexpected bridge source fails verification before either file is overwritten', async t => {
  const { directory, manifest } = await fixture(t);
  const errors = await readFile(path.join(directory, 'src/errors.mjs'), 'utf8');
  await writeFile(path.join(directory, 'src/index.mjs'), '// unexpected source\n');
  await assert.rejects(applyBridgeErrorOverlay(directory, { manifest }), /differs from its verified release/);
  assert.equal(await readFile(path.join(directory, 'src/errors.mjs'), 'utf8'), errors);
});

test('bridge URLs depend on release and emitted overlay bytes, including relative imports', () => {
  const archive = 'a'.repeat(64);
  const overlay = { files: [{ file: 'src/errors.mjs', sha256: 'b'.repeat(64) }, { file: 'src/index.mjs', sha256: 'c'.repeat(64) }] };
  const first = bridgeRuntimeAssetPath('0.1.8', archive, overlay);
  assert.match(first, /^mariadb\/0\.1\.8\/[a-f0-9]{64}$/);
  assert.equal(first, bridgeRuntimeAssetPath('0.1.8', archive, { files: [...overlay.files].reverse() }));
  const changed = bridgeRuntimeAssetPath('0.1.8', archive,
    { files: [overlay.files[0], { file: 'src/index.mjs', sha256: 'd'.repeat(64) }] });
  assert.notEqual(new URL('worker.mjs', `https://example.test/assets/${first}/src/index.mjs`).href,
    new URL('worker.mjs', `https://example.test/assets/${changed}/src/index.mjs`).href);
  assert.notEqual(first, bridgeRuntimeAssetPath('0.1.8', 'f'.repeat(64), overlay));
  assert.throws(() => bridgeRuntimeAssetPath('0.1.8', archive, { files: [] }), /Missing/);
});
