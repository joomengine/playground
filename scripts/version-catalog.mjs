import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { discoverDynamicCatalog } from '../src/dynamic-catalog.mjs';

const MAX_BYTES = 128 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; JoomEnginePlayground/1.0)';
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

/** Read the runtime and installer requirements from the actual full package, without executing its PHP. */
export function joomlaPackagePhpMinimum(bytes, feedMinimum) {
  const expected = new Set(['index.php', 'installation/index.php']);
  const seen = new Set();
  const files = unzipSync(bytes, { filter(entry) {
    if (!expected.has(entry.name)) return false;
    if (seen.has(entry.name) || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > 64 * 1024) {
      throw new Error('The Joomla PHP requirement files are duplicated or exceed their size limit.');
    }
    seen.add(entry.name);
    return true;
  } });
  const versions = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const filename of expected) {
    if (!(files[filename] instanceof Uint8Array)) throw new Error(`The Joomla full package is missing ${filename}.`);
    const declarations = [...decoder.decode(files[filename]).matchAll(/^\s*\\?define\s*\(\s*(['"])JOOMLA_MINIMUM_PHP\1\s*,\s*(['"])(\d+\.\d+\.\d+)\2\s*\)\s*;/gm)];
    if (declarations.length !== 1) throw new Error(`The Joomla PHP minimum in ${filename} is missing or ambiguous.`);
    versions.push(declarations[0][3]);
  }
  if (versions[0] !== versions[1]) throw new Error('The Joomla runtime and installer disagree about the minimum PHP version.');
  if (feedMinimum !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(feedMinimum)) throw new Error('The Joomla feed PHP minimum is invalid.');
    versions.push(feedMinimum);
  }
  // Metadata can be more restrictive than a bootstrap check. Never relax either requirement.
  return versions.sort((left, right) => {
    const a = left.split('.').map(Number), b = right.split('.').map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  })[0];
}

function sourceURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Catalog packages require a public HTTPS source URL.');
  return url.href;
}

function verify(bytes, entry, limit) {
  if (bytes.length > limit) throw new Error('The catalog package exceeds 128 MiB.');
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('The catalog package is not a ZIP archive.');
  const sha256 = hash('sha256', bytes);
  for (const [algorithm, length] of [['sha256', 64], ['sha512', 128]]) {
    if (entry[algorithm] == null) continue;
    if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(entry[algorithm])) throw new Error(`Invalid published ${algorithm} checksum.`);
    const actual = algorithm === 'sha256' ? sha256 : hash(algorithm, bytes);
    if (actual !== entry[algorithm].toLowerCase()) throw new Error(`The catalog package failed its published ${algorithm} checksum.`);
  }
  return sha256;
}

async function download(entry, fetchImpl, limit) {
  const response = await fetchImpl(sourceURL(entry.url), {
    credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(180_000),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`Package download failed: HTTP ${response.status}.`);
  if (Number(response.headers.get('Content-Length')) > limit) {
    await response.body?.cancel();
    throw new Error('The catalog package exceeds 128 MiB.');
  }
  if (!response.body) throw new Error('The catalog package response has no body.');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('The catalog package exceeds 128 MiB.');
      parts.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}

/** Publish only verified, automatically downloadable choices; a failed refresh never replaces the catalog. */
export async function stageVersionCatalog({ assets, cache, pinnedJoomla = [], stagedJoomla = [], deployPackages = [],
  discover = discoverDynamicCatalog, fetchImpl = fetch, now = Date.now,
  maxPackageBytes = MAX_BYTES }) {
  if (!Number.isSafeInteger(maxPackageBytes) || maxPackageBytes < 4 || maxPackageBytes > MAX_BYTES) throw new Error('Invalid catalog package limit.');
  const upstreamFetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
    return fetchImpl(url, { ...init, headers });
  };
  const discovered = await discover({ fetchImpl: upstreamFetch, pinnedJoomla, cacheStorage: null, forceRefresh: true });
  if (!Array.isArray(discovered?.joomla) || !Array.isArray(discovered.jcb) || !Array.isArray(discovered.errors)) throw new Error('Invalid discovered version catalog.');
  if (discovered.errors.length) throw new Error(`Cannot publish an incomplete version catalog: ${discovered.errors.map(error => `${error.source}: ${error.message}`).join('; ')}`);
  if (!discovered.joomla.length || !discovered.jcb.length) throw new Error('The version catalog must contain Joomla and JCB packages.');
  await mkdir(path.join(assets, 'packages'), { recursive: true });
  await mkdir(path.join(cache, 'packages'), { recursive: true });
  const catalog = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), joomla: [], jcb: [], errors: [] };

  for (const product of ['joomla', 'jcb']) {
    for (const discoveredEntry of discovered[product]) {
      const url = sourceURL(discoveredEntry.url);
      const pinned = [...stagedJoomla, ...deployPackages].find(item => item.sourceUrl === url);
      const entry = { ...discoveredEntry, url, sha256: discoveredEntry.sha256 || pinned?.sourceSha256 || pinned?.sha256 || null };
      let bytes;
      const expected = entry.sha256 || entry.sha512;
      if (expected && !/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i.test(expected)) throw new Error('Invalid published package checksum.');
      const pinnedJoomlaURL = product === 'joomla' && entry.channel === 'stable' && entry.source !== 'nightly' && pinned?.sha256 === entry.sha256
        && pinned.url === `joomla/Joomla_${entry.version}.zip` ? pinned.url : null;
      // A moving nightly must always be fetched again, even if an old caller supplied a fingerprint.
      const cacheFile = expected && entry.source !== 'nightly' ? path.join(cache, 'packages', `${expected.toLowerCase()}.zip`) : null;
      if (cacheFile) {
        try { const cached = await readFile(cacheFile); verify(cached, entry, maxPackageBytes); bytes = cached; }
        catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
      }
      try {
        // Verify the exact already-staged file before referencing it, even when a valid cache also exists.
        if (pinnedJoomlaURL) bytes = await readFile(path.join(assets, pinnedJoomlaURL));
        bytes ??= await download(entry, upstreamFetch, maxPackageBytes);
        const sha256 = verify(bytes, entry, maxPackageBytes);
        if (product === 'joomla') entry.phpMinimum = joomlaPackagePhpMinimum(bytes, entry.phpMinimum);
        const packageURL = pinnedJoomlaURL || `packages/${sha256}.zip`;
        if (!pinnedJoomlaURL) await writeFile(path.join(assets, packageURL), bytes);
        if (cacheFile) {
          const temporary = `${cacheFile}.${randomUUID()}.tmp`;
          await writeFile(temporary, bytes);
          await rename(temporary, cacheFile);
        }
        catalog[product].push({ ...entry, sourceUrl: url, url: packageURL, sha256,
          ...(entry.sha512 ? { sha512: entry.sha512.toLowerCase() } : {}) });
      } catch (error) { throw new Error(`Cannot stage ${product} ${entry.version}: ${error.message}`, { cause: error }); }
    }
  }
  const destination = path.join(assets, 'version-catalog.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  await rename(temporary, destination);
  return { url: 'version-catalog.json', generatedAt: catalog.generatedAt };
}
