import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inventory, safeArchivePath } from './assets.mjs';

const exec = promisify(execFile);

const upstreamURL = 'https://playground.joomengine.org/';
const sha256 = /^[a-f0-9]{64}$/;
const gitSHA = /^[a-f0-9]{40}$/;

async function responseFor(base, file, fetcher) {
  const pathname = file === 'index.html' ? './' : file.split('/').map(encodeURIComponent).join('/');
  const response = await fetcher(new URL(pathname, base), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(180_000),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Could not fetch published ${file} (HTTP ${response.status}).`);
  }
  return response;
}

async function metadata(base, file, fetcher) {
  const response = await responseFor(base, file, fetcher);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error(`Published metadata is too large: ${file}`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The deployed ID changes on same-commit nightly rebuilds. The source SHA selects its matching build tools. */
export async function publishedEngine({ base = upstreamURL, fetcher = fetch } = {}) {
  const [build, manifest] = await Promise.all([
    metadata(base, 'build.json', fetcher), metadata(base, 'assets/manifest.json', fetcher),
  ]);
  if (build.schemaVersion !== 1 || !sha256.test(build.id) || manifest.schemaVersion !== 1
    || !gitSHA.test(manifest.sourceCommit) || manifest.deployment?.canonicalUrl !== base
    || manifest.deployment.environment !== 'production' || manifest.runtime?.kind !== 'release'
    || !/^[1-9][0-9]*$/.test(manifest.engineBuild?.runId)) {
    throw new Error('The official deployment has not published a compatible, released engine build.');
  }
  return { buildId: build.id, sourceCommit: manifest.sourceCommit, runId: String(manifest.engineBuild.runId) };
}

function checkedInventory(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0, 'Missing published asset inventory.');
  const names = new Set();
  for (const entry of entries) {
    assert.equal(safeArchivePath(entry.path), entry.path);
    assert.ok(entry.path !== 'asset-inventory.json' && !names.has(entry.path) && sha256.test(entry.sha256)
      && Number.isSafeInteger(entry.size) && entry.size >= 0, `Invalid published inventory record: ${entry.path}`);
    names.add(entry.path);
  }
  for (const required of ['assets/manifest.json', 'assets/version-catalog.json', 'build.json', 'index.html', 'LICENSE', 'NOTICE']) {
    assert.ok(names.has(required), `Published inventory is missing ${required}`);
  }
  return entries;
}

const releaseURL = 'https://github.com/joomengine/playground/releases/download/';

async function releaseFile(url, fetcher) {
  // GitHub issues a temporary HTTPS redirect to its public release-asset storage.
  const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(300_000) });
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('An engine asset requires HTTPS.');
  return response;
}

/** Receive one public release asset. No GH token, Actions artifact retention or per-file CDN requests. */
export async function fetchEngine({ directory, expected, base = upstreamURL, fetcher = fetch, retryMs = 15_000, attempts = 32 }) {
  assert.deepEqual(await publishedEngine({ base, fetcher }), expected, 'Upstream changed since the fork selected its engine. Retry this build.');
  const name = `engine-${expected.buildId}.tar.gz`;
  const archiveURL = new URL(`playground-engine-v1-${expected.buildId}/${name}`, releaseURL);
  let checksum;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await releaseFile(`${archiveURL}.sha256`, fetcher);
    if (response.status === 200) {
      const record = (await response.text()).trim().split(/\s+/);
      assert.ok(record.length === 2 && sha256.test(record[0]) && record[1] === name, 'Invalid engine release checksum.');
      checksum = record[0];
      break;
    }
    await response.body?.cancel();
    if (response.status !== 404 && response.status < 500) throw new Error(`Engine release checksum returned HTTP ${response.status}.`);
    if (attempt < attempts) await delay(retryMs);
  }
  if (!checksum) throw new Error('The selected engine archive has not finished publishing. Retry or wait for the next fork check.');
  const scratch = await mkdtemp(path.join(tmpdir(), 'playground-engine-'));
  const archive = path.join(scratch, name);
  let created = false;
  try {
    const response = await releaseFile(archiveURL, fetcher);
    assert.equal(response.status, 200, 'Could not download the published engine archive.');
    const hash = createHash('sha256');
    await pipeline(response.body, async function* inspect(chunks) {
      for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
    }, createWriteStream(archive, { flags: 'wx' }));
    assert.equal(hash.digest('hex'), checksum, 'Engine archive SHA-256 mismatch.');
    // Accept only regular files/directories beneath a new empty directory. Reject links, devices,
    // traversal and duplicate names before extracting even a correctly checksummed archive.
    const { stdout } = await exec('tar', ['--list', '--verbose', '--numeric-owner', '--utc', '--quoting-style=escape', '-zf', archive],
      { env: { ...process.env, LC_ALL: 'C.UTF-8' }, maxBuffer: 32 * 1024 * 1024 });
    const names = new Set();
    for (const line of stdout.trimEnd().split('\n')) {
      const match = /^([-d])\S+\s+\d+\/\d+\s+\d+\s+[\d-]+\s+[\d:]+ (\.\/.*)$/.exec(line);
      if (!match) throw new Error('The engine archive contains an unsupported entry.');
      if (match[1] === 'd' && match[2] === './') continue;
      const relative = safeArchivePath(match[2].slice(2));
      assert.ok(!names.has(relative), 'Duplicate engine archive entry.');
      names.add(relative);
    }
    await mkdir(directory);
    created = true;
    await exec('tar', ['--extract', '--no-same-owner', '--no-same-permissions', '--keep-old-files', '-zf', archive, '-C', directory]);
    const [actual, declared, marker, manifest] = await Promise.all([
      inventory(directory),
      readFile(path.join(directory, 'asset-inventory.json'), 'utf8').then(JSON.parse),
      readFile(path.join(directory, 'build.json'), 'utf8').then(JSON.parse),
      readFile(path.join(directory, 'assets/manifest.json'), 'utf8').then(JSON.parse),
    ]);
    assert.deepEqual(actual.filter(entry => entry.path !== 'asset-inventory.json'), checkedInventory(declared),
      'The engine files differ from the published inventory.');
    assert.equal(marker.id, expected.buildId);
    assert.equal(manifest.sourceCommit, expected.sourceCommit);
    assert.equal(String(manifest.engineBuild?.runId), expected.runId);
    const publishedFiles = await metadata(base, 'asset-inventory.json', fetcher);
    assert.deepEqual(await publishedEngine({ base, fetcher }), expected, 'Upstream switched releases during transfer. Retry this build.');
    assert.deepEqual(declared, publishedFiles, 'The release archive inventory differs from the actual upstream Pages publication.');
    console.log(`Verified ${declared.length} files from upstream engine archive ${name}.`);
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function select() {
  const engine = await publishedEngine();
  const profilePath = path.join(process.env.PLAYGROUND_SITE_DIR, 'playground.json');
  let profile;
  try { profile = JSON.parse(await readFile(profilePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const canonical = new URL(profile?.publicUrl ?? process.env.PAGES_URL);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.hash || canonical.search) {
    throw new Error('A public HTTPS Pages address is required.');
  }
  if (!canonical.pathname.endsWith('/')) canonical.pathname += '/';
  let unchanged = false;
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    // First publication (HTTP 404) and an old/incompatible site both require a build.
    try {
      const deployed = await metadata(canonical, 'assets/manifest.json', fetch);
      unchanged = deployed.sourceCommit === process.env.GITHUB_SHA && deployed.upstreamEngine?.buildId === engine.buildId
        && deployed.deployment?.canonicalUrl === canonical.href;
    } catch { /* Publish and verify the current candidate. */ }
  }
  await appendFile(process.env.GITHUB_OUTPUT, `build=${!unchanged}\nsha=${engine.sourceCommit}\nid=${engine.buildId}\nrun_id=${engine.runId}\nurl=${canonical.href}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'select') await select();
  else if (process.argv[2] === 'compose') {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const directory = path.join(root, 'dist');
    const upstream = { buildId: process.env.ENGINE_BUILD_ID, sourceCommit: process.env.ENGINE_SHA, runId: process.env.ENGINE_RUN_ID };
    await fetchEngine({ directory, expected: upstream });
    const { applySiteBuild } = await import('./site-build.mjs');
    await applySiteBuild({ root, directory, siteDirectory: process.env.PLAYGROUND_SITE_DIR,
      canonicalUrl: process.env.PAGES_URL, sourceCommit: process.env.GITHUB_SHA, upstream });
  } else if (process.argv[2] === 'smoke-files') {
    const { publicationFiles } = await import('./pages-smoke.mjs');
    for (const file of publicationFiles) {
      const target = path.join('smoke-files', file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join('dist', file), target);
    }
  } else throw new Error('Choose select, compose or smoke-files.');
}
