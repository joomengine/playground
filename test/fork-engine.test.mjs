import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventory, sha256 } from '../scripts/assets.mjs';
import { fetchEngine, publishedEngine } from '../scripts/fork-engine.mjs';

async function engineFixture(t, { stale = false, link = false } = {}) {
  const work = await mkdtemp(path.join(tmpdir(), 'fork-engine-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const seed = path.join(work, 'seed');
  await mkdir(path.join(seed, 'assets'), { recursive: true });
  const expected = { buildId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), runId: '123' };
  const base = 'https://upstream.example.org/';
  const files = {
    'build.json': JSON.stringify({ schemaVersion: 1, id: expected.buildId }),
    'assets/manifest.json': JSON.stringify({ schemaVersion: 1, sourceCommit: expected.sourceCommit, engineBuild: { runId: expected.runId },
      deployment: { canonicalUrl: base, environment: 'production' }, runtime: { kind: 'release' } }),
    'index.html': 'test site', 'assets/version-catalog.json': '{}', LICENSE: 'license', NOTICE: 'notice', '.nojekyll': '',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(seed, name), content);
  files['asset-inventory.json'] = JSON.stringify(await inventory(seed));
  await writeFile(path.join(seed, 'asset-inventory.json'), files['asset-inventory.json']);
  if (stale) await writeFile(path.join(seed, 'index.html'), 'changed after inventory');
  if (link) await symlink('../outside', path.join(seed, 'forbidden'));
  const archive = execFileSync('tar', ['-czf', '-', '-C', seed, '.']);
  const archiveName = `engine-${expected.buildId}.tar.gz`;
  const requests = [];
  const fetcher = async url => {
    const location = new URL(url); requests.push(location);
    if (location.origin === new URL(base).origin) return new Response(files[location.pathname.slice(1)]);
    assert.equal(location.hostname, 'github.com');
    assert.equal(path.posix.dirname(location.pathname), `/joomengine/playground/releases/download/playground-engine-v1-${expected.buildId}`);
    if (location.pathname.endsWith('/' + archiveName)) return new Response(archive);
    assert.ok(location.pathname.endsWith('/' + archiveName + '.sha256'));
    return new Response(`${sha256(archive)}  ${archiveName}\n`);
  };
  return { directory: path.join(work, 'dist'), archiveName, expected, base, fetcher, requests, retryMs: 0, attempts: 2 };
}

test('a fork consumes one verified engine archive selected by the production deployment, ignoring CI artifact retention', async t => {
  const input = await engineFixture(t);
  assert.deepEqual(await publishedEngine(input), input.expected);
  await fetchEngine(input);
  assert.equal(await readFile(path.join(input.directory, 'index.html'), 'utf8'), 'test site');
  assert.equal(input.requests.filter(url => url.pathname.endsWith('.tar.gz')).length, 1);
  assert.ok(input.requests.filter(url => url.origin === new URL(input.base).origin)
    .every(url => ['/build.json', '/assets/manifest.json', '/asset-inventory.json'].includes(url.pathname)));
  await assert.rejects(fetchEngine(input), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(input.directory, 'index.html'), 'utf8'), 'test site');
});

test('a fork rejects an incorrect archive checksum, inventory or unsafe entry before publishing', async t => {
  const first = await engineFixture(t);
  await assert.rejects(fetchEngine({ ...first, fetcher: url => new URL(url).pathname.endsWith('.sha256')
    ? new Response(`${'0'.repeat(64)}  ${first.archiveName}\n`) : first.fetcher(url) }), /SHA-256 mismatch/);
  const second = await engineFixture(t, { stale: true });
  await assert.rejects(fetchEngine(second), /differ from the published inventory/);
  await assert.rejects(readFile(path.join(second.directory, 'index.html')), { code: 'ENOENT' });
  const mismatch = await engineFixture(t);
  await assert.rejects(fetchEngine({ ...mismatch, fetcher: url => new URL(url).pathname === '/asset-inventory.json'
    ? new Response('[]') : mismatch.fetcher(url) }), /actual upstream Pages publication/);
  const third = await engineFixture(t, { link: true });
  await assert.rejects(fetchEngine(third), /unsupported entry/);
});

test('the readiness sidecar can arrive shortly after Pages; changed upstream identity stops publication', async t => {
  const input = await engineFixture(t);
  let checks = 0;
  await fetchEngine({ ...input, fetcher: url => new URL(url).pathname.endsWith('.sha256') && checks++ === 0
    ? new Response('', { status: 404 }) : input.fetcher(url) });
  assert.equal(checks, 2);
  const other = await engineFixture(t);
  let markerReads = 0;
  await assert.rejects(fetchEngine({ ...other, fetcher: url => new URL(url).pathname === '/build.json' && ++markerReads === 2
    ? new Response(JSON.stringify({ schemaVersion: 1, id: 'c'.repeat(64) })) : other.fetcher(url) }), /switched releases/);
  await assert.rejects(readFile(path.join(other.directory, 'index.html')), { code: 'ENOENT' });
});
