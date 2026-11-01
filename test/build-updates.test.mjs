import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeBuildIdentity } from '../scripts/build-identity.mjs';
import { createBuildUpdateMonitor } from '../src/build-updates.mjs';

const oldId = 'a'.repeat(64);
const newId = 'b'.repeat(64);
const baseURL = 'https://example.test/nested/playground/';
const marker = id => new Response(JSON.stringify({ schemaVersion: 1, id }));

test('published build identity follows catalogs, runtime and prepared images even with the same source commit', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'index.html'), '<html><head><meta name="joomengine-build" content=""></head></html>');
  await writeFile(path.join(directory, 'assets/version-catalog.json'), '{"packages":["first"]}');
  const manifest = { sourceCommit: 'same', runtime: { release: 'first' } };
  const first = await writeBuildIdentity(directory, manifest);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await writeBuildIdentity(directory, manifest), first);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'build.json'), 'utf8')), { schemaVersion: 1, id: first });
  assert.match(await readFile(path.join(directory, 'index.html'), 'utf8'), new RegExp(`content="${first}"`));

  await writeFile(path.join(directory, 'assets/version-catalog.json'), '{"packages":["second"]}');
  const catalogChange = await writeBuildIdentity(directory, manifest);
  assert.notEqual(catalogChange, first);
  manifest.runtime.release = 'second';
  const runtimeChange = await writeBuildIdentity(directory, manifest);
  assert.notEqual(runtimeChange, catalogChange);
  manifest.prebuiltDeploys = [{ sha256: 'prepared-image' }];
  const preparedChange = await writeBuildIdentity(directory, manifest);
  assert.notEqual(preparedChange, runtimeChange);
  assert.match(await readFile(path.join(directory, 'index.html'), 'utf8'), new RegExp(`content="${preparedChange}"`));
});

test('a changed build reports once and refreshes only this deployment’s replaceable catalogs', async () => {
  const calls = [];
  const consumed = [];
  let updates = 0;
  const monitor = createBuildUpdateMonitor({ baseURL, loadedId: oldId,
    onUpdate: () => updates++,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      if (url.pathname.endsWith('/build.json')) return marker(newId);
      return { ok: true, async arrayBuffer() { consumed.push(url.href); return new ArrayBuffer(0); } };
    },
  });
  assert.equal(await monitor.check(), true);
  assert.equal(monitor.pending, true);
  assert.equal(updates, 1);
  assert.deepEqual(calls.map(({ url }) => url), [
    `${baseURL}build.json`, `${baseURL}assets/manifest.json`, `${baseURL}assets/version-catalog.json`,
  ]);
  assert.deepEqual(consumed.sort(), calls.slice(1).map(({ url }) => url).sort());
  assert.deepEqual(calls.map(({ options }) => options.cache), ['no-store', 'reload', 'reload']);
  assert.ok(calls.every(({ options }) => options.credentials === 'same-origin' && options.redirect === 'error'));
  assert.equal(await monitor.check({ force: true }), true);
  assert.equal(calls.length, 3);
  assert.equal(updates, 1);
});

test('focus checks are coalesced and throttled; a launch check still verifies the current build', async () => {
  let clock = 0;
  let reads = 0;
  let release;
  const monitor = createBuildUpdateMonitor({ baseURL, loadedId: oldId, now: () => clock,
    fetchImpl: async () => {
      reads++;
      if (reads === 1) await new Promise(resolve => { release = resolve; });
      return marker(oldId);
    },
  });
  const first = monitor.check();
  assert.equal(monitor.check({ force: true }), first);
  release();
  assert.equal(await first, false);
  assert.equal(await monitor.check(), false);
  assert.equal(reads, 1);
  assert.equal(await monitor.check({ force: true }), false);
  assert.equal(reads, 2);
  clock += 30_001;
  assert.equal(await monitor.check(), false);
  assert.equal(reads, 3);
});

test('source previews, unavailable markers and invalid markers do not prevent ordinary launches', async () => {
  const preview = createBuildUpdateMonitor({ baseURL, loadedId: '', fetchImpl: () => { throw new Error('Preview must not request a build marker'); } });
  assert.equal(await preview.check({ force: true }), false);
  const responses = [
    () => Promise.reject(new Error('Offline')),
    () => new Response('Missing', { status: 404 }),
    () => new Response('<html>redirected page</html>'),
    () => new Response(JSON.stringify({ schemaVersion: 2, id: newId })),
    () => new Response(JSON.stringify({ schemaVersion: 1, id: 'invalid' })),
    () => new Response('x'.repeat(1025)),
    () => new Response('{}', { headers: { 'content-length': '2048' } }),
  ];
  for (const response of responses) {
    const monitor = createBuildUpdateMonitor({ baseURL, loadedId: oldId, fetchImpl: response,
      onUpdate() { assert.fail('Invalid/unavailable markers cannot announce a new build'); },
    });
    assert.equal(await monitor.check({ force: true }), false);
    assert.equal(monitor.pending, false);
  }
});

test('a catalog refresh failure keeps the new-build notice available for an explicit reload', async () => {
  let updates = 0;
  const monitor = createBuildUpdateMonitor({ baseURL, loadedId: oldId, onUpdate: () => updates++,
    fetchImpl: async url => {
      if (url.pathname.endsWith('/build.json')) return marker(newId);
      throw new Error('Network interrupted');
    },
  });
  assert.equal(await monitor.check(), true);
  assert.equal(monitor.pending, true);
  assert.equal(updates, 1);
});
