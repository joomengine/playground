import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { safeArchivePath } from './assets.mjs';

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

async function receiveFile(entry, { base, directory, fetcher }) {
  const destination = path.join(directory, entry.path);
  await mkdir(path.dirname(destination), { recursive: true });
  // Pages does not promise to serve its publishing control files.
  const local = entry.path === '.nojekyll' ? '' : entry.path === 'CNAME' ? `${new URL(base).hostname}\n` : undefined;
  const source = local === undefined ? (await responseFor(base, entry.path, fetcher)).body : [Buffer.from(local)];
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(source, async function* checkBytes(chunks) {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > entry.size) throw new Error(`Published size exceeded for ${entry.path}`);
      hash.update(chunk);
      yield chunk;
    }
  }, createWriteStream(destination));
  assert.ok(size === entry.size && hash.digest('hex') === entry.sha256, `Published asset differs from inventory: ${entry.path}`);
}

/** Reuse the files actually serving upstream, without expiring CI artifacts or cross-repo credentials. */
export async function fetchEngine({ directory, expected, base = upstreamURL, fetcher = fetch, retryMs = 1000 }) {
  const current = () => publishedEngine({ base, fetcher });
  assert.deepEqual(await current(), expected, 'Upstream changed since the fork selected its engine. Retry this build.');
  const entries = checkedInventory(await metadata(base, 'asset-inventory.json', fetcher));
  // Never write into an existing checkout, old distribution, or directory containing links.
  await mkdir(directory);
  let next = 0;
  let failure;
  async function receive() {
    while (!failure && next < entries.length) {
      const entry = entries[next++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await receiveFile(entry, { base, directory, fetcher }); break; }
        catch (error) {
          if (attempt === 2) { failure = error; return; }
          await delay(retryMs * (attempt + 1));
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, receive));
    if (failure) throw failure;
    const [marker, manifest, final] = await Promise.all([
      readFile(path.join(directory, 'build.json'), 'utf8').then(JSON.parse),
      readFile(path.join(directory, 'assets/manifest.json'), 'utf8').then(JSON.parse), current(),
    ]);
    assert.deepEqual(final, expected, 'Upstream switched releases during transfer. Retry this build.');
    assert.equal(marker.id, expected.buildId);
    assert.equal(manifest.sourceCommit, expected.sourceCommit);
    assert.equal(String(manifest.engineBuild?.runId), expected.runId);
    await writeFile(path.join(directory, 'asset-inventory.json'), JSON.stringify(entries, null, 2) + '\n');
    console.log(`Verified ${entries.length} published files for upstream build ${expected.buildId}.`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
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
  } else throw new Error('Choose select or compose.');
}
