import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { discoverDynamicCatalog } from '../src/dynamic-catalog.mjs';

const MAX_BYTES = 128 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; JoomEnginePlayground/1.0)';
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const isZip = bytes => bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;

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
  if (!isZip(bytes)) throw new Error('The catalog package is not a ZIP archive.');
  const sha256 = hash('sha256', bytes);
  for (const [algorithm, length] of [['sha256', 64], ['sha512', 128]]) {
    if (entry[algorithm] == null) continue;
    if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(entry[algorithm])) throw new Error(`Invalid published ${algorithm} checksum.`);
    const actual = algorithm === 'sha256' ? sha256 : hash(algorithm, bytes);
    if (actual !== entry[algorithm].toLowerCase()) throw new Error(`The catalog package failed its published ${algorithm} checksum.`);
  }
  return sha256;
}

// Only upstream delivery failures may fall back. Verification, archive limits,
// incompatible packages and filesystem errors still stop publication.
class PackageUnavailable extends Error {}

export async function downloadCatalogZip(entry, fetchImpl, limit = MAX_BYTES) {
  const url = sourceURL(entry.url);
  const signal = AbortSignal.timeout(180_000);
  const failures = [];
  // These build-time requests are GETs. Retry transient delivery failures within
  // one deadline, without accepting a different checksum or publishing a partial catalog.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    let retryable = true;
    let unavailable = true;
    let length = 0;
    let prefix = Buffer.alloc(0);
    try {
      signal.throwIfAborted();
      response = await fetchImpl(url, {
        credentials: 'omit', cache: 'no-store', redirect: 'follow', signal,
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) {
        retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        unavailable = retryable || [403, 404, 410].includes(response.status);
        throw new Error(`Package download failed: HTTP ${response.status}.`);
      }
      if (Number(response.headers.get('Content-Length')) > limit) {
        retryable = unavailable = false;
        throw new Error('The catalog package exceeds 128 MiB.');
      }
      if (!response.body) throw new Error('The catalog package response has no body.');
      const reader = response.body.getReader();
      const parts = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (prefix.length < 16) prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 16 - prefix.length)]);
          if (length > limit) {
            retryable = unavailable = false;
            throw new Error('The catalog package exceeds 128 MiB.');
          }
          parts.push(Buffer.from(value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const bytes = Buffer.concat(parts, length);
      // A gateway can return an HTML error with HTTP 200. Retry that response,
      // but never treat a published checksum mismatch as a temporary success.
      retryable = !isZip(bytes);
      unavailable = retryable && (length === 0 || /^\s*(?:<!doctype html|<html)/i.test(bytes.toString('ascii', 0, 128)));
      return { bytes, sha256: verify(bytes, entry, limit) };
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      // Redirected release URLs can contain signed query strings; retain the
      // origin/path and response signature without logging temporary credentials.
      const finalURL = response?.url ? new URL(response.url) : new URL(url);
      const details = { attempt, source: url, finalURL: `${finalURL.origin}${finalURL.pathname}`,
        status: response?.status ?? null, contentType: response?.headers.get('Content-Type') ?? null,
        contentLength: response?.headers.get('Content-Length') ?? null, receivedBytes: length,
        firstBytes: prefix.toString('hex') };
      failures.push(`${error.message} ${JSON.stringify(details)}`);
      if (!retryable || signal.aborted || attempt === 3) {
        const Failure = unavailable ? PackageUnavailable : Error;
        throw new Failure(`Package retrieval failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${failures.join('; ')}`, { cause: error });
      }
      try { await delay(500 * attempt, undefined, { signal }); }
      catch (error) {
        throw new PackageUnavailable(`Package retrieval deadline expired after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${failures.join('; ')}`, { cause: error });
      }
    }
  }
}

const MAX_RETAINED_NIGHTLY_AGE = 72 * 60 * 60 * 1000;

async function readPublishedCatalog(url, fetchImpl) {
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  let length = 0;
  const parts = [];
  for await (const part of response.body) {
    length += part.byteLength;
    if (length > 256 * 1024) throw new Error('The previously published catalog exceeds 256 KiB.');
    parts.push(part);
  }
  const catalog = JSON.parse(Buffer.concat(parts, length));
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.joomla) || catalog.joomla.length > 50) {
    throw new Error('The previously published catalog is invalid.');
  }
  return catalog;
}

async function retainPublishedNightly({ entry, catalog, catalogURL, fetchImpl, now, limit }) {
  // A moving version string alone cannot establish freshness. Keep the original
  // retrieval time through every subsequent outage, including legacy catalogs
  // which only published generatedAt and always retrieved each nightly live.
  const previous = catalog?.joomla.find(item => item?.version === entry.version && item.sourceUrl === entry.url
    && item.source === 'nightly' && item.channel === 'nightly');
  if (!previous || !/^[a-f0-9]{64}$/.test(previous.sha256) || previous.url !== `packages/${previous.sha256}.zip`) return null;
  if (entry.sha256 && previous.sha256 !== entry.sha256.toLowerCase()) return null;
  const verifiedAt = previous.verifiedAt ?? (previous.nightlyStatus ? null : catalog.generatedAt);
  const age = now - Date.parse(verifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_RETAINED_NIGHTLY_AGE) return null;
  const url = new URL(previous.url, catalogURL).href;
  let download;
  try {
    download = await downloadCatalogZip({ url, sha256: previous.sha256, sha512: entry.sha512 }, fetchImpl, limit);
  } catch (error) {
    if (error instanceof PackageUnavailable) return null;
    throw error;
  }
  return { ...download, verifiedAt: new Date(verifiedAt).toISOString() };
}

/** Publish only verified, automatically downloadable choices; a failed refresh never replaces the catalog. */
export async function stageVersionCatalog({ assets, cache, pinnedJoomla = [], stagedJoomla = [], deployPackages = [],
  discover = discoverDynamicCatalog, fetchImpl = fetch, now = Date.now,
  maxPackageBytes = MAX_BYTES, githubToken = '', previousCatalogURL, onNightlyWarning = console.warn }) {
  if (!Number.isSafeInteger(maxPackageBytes) || maxPackageBytes < 4 || maxPackageBytes > MAX_BYTES) throw new Error('Invalid catalog package limit.');
  const upstreamFetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
    return fetchImpl(url, { ...init, headers });
  };
  // A transient gateway failure should not force another full build. Keep each
  // metadata GET within its original deadline and never replay other methods.
  const metadataFetch = async (url, init = {}) => {
    const target = new URL(url);
    // Build credentials belong only to this GitHub metadata request, never to
    // package downloads, other feeds, redirects or the generated browser app.
    if (githubToken && (init.method || 'GET').toUpperCase() === 'GET'
      && target.origin === 'https://api.github.com' && !target.username && !target.password
      && target.pathname === '/repos/joomla/joomla-cms/releases') {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${githubToken}`);
      init = { ...init, headers, redirect: 'error' };
    }
    const attempts = (init.method || 'GET').toUpperCase() === 'GET' ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      init.signal?.throwIfAborted();
      const response = await upstreamFetch(url, init);
      if (attempt === attempts || ![502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel().catch(() => {});
      await delay(500 * attempt, undefined, { signal: init.signal });
    }
  };
  const discovered = await discover({ fetchImpl: metadataFetch, pinnedJoomla, cacheStorage: null, forceRefresh: true });
  if (!Array.isArray(discovered?.joomla) || !Array.isArray(discovered.jcb) || !Array.isArray(discovered.errors)) throw new Error('Invalid discovered version catalog.');
  const nightlyFeedUnavailable = error => previousCatalogURL && error.code === 'NIGHTLY_FEED_UNAVAILABLE'
    && /^joomla-nightlies-\d+$/.test(error.source) && discovered.joomla.some(entry => entry.channel === 'stable');
  const fatalErrors = discovered.errors.filter(error => !nightlyFeedUnavailable(error));
  if (fatalErrors.length) throw new Error(`Cannot publish an incomplete version catalog: ${fatalErrors.map(error => `${error.source}: ${error.message}`).join('; ')}`);
  if (!discovered.joomla.length || !discovered.jcb.length) throw new Error('The version catalog must contain Joomla and JCB packages.');
  await mkdir(path.join(assets, 'packages'), { recursive: true });
  await mkdir(path.join(cache, 'packages'), { recursive: true });
  const catalog = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), joomla: [], jcb: [], errors: [] };

  const warn = async message => {
    (catalog.warnings ??= []).push(message);
    await onNightlyWarning(message);
  };
  for (const error of discovered.errors) await warn(`${error.message} Only nightlies confirmed by available feeds will be listed.`);

  // Read the previous deployment only after an actual delivery outage. Multiple
  // affected channels in this build share the same catalog snapshot.
  let previousCatalog;
  const fetchPackage = async (product, entry) => {
    try {
      const download = await downloadCatalogZip(entry, upstreamFetch, maxPackageBytes);
      if (entry.source === 'nightly') entry.verifiedAt = catalog.generatedAt;
      return download;
    } catch (error) {
      if (!(error instanceof PackageUnavailable) || !previousCatalogURL || product !== 'joomla'
        || entry.source !== 'nightly' || entry.channel !== 'nightly'
        || !discovered.joomla.some(item => item.channel === 'stable')) throw error;
      console.warn(error.message);
    }
    previousCatalog ??= readPublishedCatalog(previousCatalogURL, upstreamFetch).catch(error => {
      console.warn(`Previous deployment catalog unavailable: ${error.message}`);
      return null;
    });
    const retained = await retainPublishedNightly({ entry, catalog: await previousCatalog,
      catalogURL: previousCatalogURL, fetchImpl: upstreamFetch, now: now(), limit: maxPackageBytes });
    const message = retained
      ? `Joomla ${entry.version} nightly unavailable upstream. Serving the verified package from ${retained.verifiedAt}.`
      : `Joomla ${entry.version} nightly unavailable upstream. Omitted because no verified copy from the past 72 hours was available.`;
    await warn(message);
    if (retained) {
      entry.verifiedAt = retained.verifiedAt;
      entry.nightlyStatus = 'retained';
      entry.label = `${entry.label} (last verified ${entry.verifiedAt.slice(0, 10)} UTC)`;
    }
    return retained;
  };
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
        let sha256;
        if (bytes) sha256 = verify(bytes, entry, maxPackageBytes);
        else {
          const download = await fetchPackage(product, entry);
          if (!download) continue;
          ({ bytes, sha256 } = download);
        }
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
