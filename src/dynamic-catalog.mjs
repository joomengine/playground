/** Read upstream package metadata without changing the pinned default catalog. */

const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\d*(?:-dev)?|-dev)?$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SHA512 = /^[a-f0-9]{128}$/i;
const BRANCH = /^\d+\.x$/;
const REPOSITORY = 'https://api.github.com/repos/joomengine/Joomla-Component-Builder';
const PACKAGE_TAGS = 'https://api.github.com/repos/joomengine/pkg-component-builder/tags';
const RELEASES = 'https://api.github.com/repos/joomla/joomla-cms/releases';
const NIGHTLY_FEEDS = ['next_patch', 'next_minor', 'next_major']
  .map((name) => `https://update.joomla.org/core/nightlies/${name}_extension.xml`);

function safeURL(value, origin, path) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !path.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function label(version, product) { return `${product} ${version}`; }
function prerelease(version) { return /-(?:alpha|beta|rc|dev)/i.test(version); }
function xmlText(value) { return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim(); }
function firstTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)<\\/${tag}\\s*>`, 'i'));
  return match ? xmlText(match[1]) : '';
}

/** Parse GitHub releases, using built full installer assets, never source ZIPs. */
export function parseJoomlaReleases(releases) {
  if (!Array.isArray(releases)) throw new TypeError('Joomla releases must be an array.');
  const result = [];
  for (const release of releases) {
    const version = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (!VERSION.test(version) || !Array.isArray(release.assets) || release.draft === true) continue;
    for (const asset of release.assets) {
      if (typeof asset?.name !== 'string' || !asset.name.startsWith(`Joomla_${version}-`) || !asset.name.endsWith('-Full_Package.zip')) continue;
      const tag = release.tag_name;
      const url = safeURL(asset.browser_download_url, 'https://github.com', /^\/joomla\/joomla-cms\/releases\/download\/[^/]+\/[^/]+$/);
      if (!url) continue;
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/');
      try {
        if (decodeURIComponent(parts[5]) !== tag || decodeURIComponent(parts[6]) !== asset.name) continue;
      } catch { continue; }
      const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
      result.push({ version, label: label(version, 'Joomla'), url, sha256: SHA256.test(digest) ? digest.toLowerCase() : null,
        source: 'release', prerelease: release.prerelease === true || prerelease(version) });
      break;
    }
  }
  return result;
}

/** Parse only official development full-package links; nightlies are mutable. */
export function parseJoomlaNightlies(html) {
  if (typeof html !== 'string') throw new TypeError('Joomla nightly metadata must be text.');
  const result = [];
  const seen = new Set();
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const url = safeURL(xmlText(match[1]), 'https://developer.joomla.org', /^\/nightlies\/Joomla_[\w.-]+-Development-Full_Package\.zip$/);
    if (!url || seen.has(url)) continue;
    const version = new URL(url).pathname.match(/\/Joomla_(.+)-Development-Full_Package\.zip$/)?.[1] || '';
    if (!VERSION.test(version) || !version.endsWith('-dev')) continue;
    seen.add(url);
    result.push({ version, label: label(version, 'Joomla'), url, sha256: null, source: 'nightly', prerelease: true });
  }
  return result;
}

/** The official nightly update feeds identify versions and minimum PHP. */
export function parseJoomlaNightlyUpdates(xml) {
  if (typeof xml !== 'string') throw new TypeError('Joomla nightly metadata must be text.');
  const result = [];
  for (const match of xml.matchAll(/<update(?:\s[^>]*)?>([\s\S]*?)<\/update\s*>/gi)) {
    const item = match[1];
    const version = firstTag(item, 'version');
    const phpMinimum = firstTag(item, 'php_minimum');
    if (!VERSION.test(version) || !version.endsWith('-dev') || !/^\d+\.\d+\.\d+$/.test(phpMinimum)) continue;
    const updateURL = safeURL(firstTag(item, 'downloadurl'), 'https://developer.joomla.org', /^\/nightlies\/Joomla_[\w.-]+-Development-Update_Package\.zip$/);
    if (!updateURL || new URL(updateURL).pathname !== `/nightlies/Joomla_${version}-Development-Update_Package.zip`) continue;
    const url = updateURL.replace(/-Update_Package\.zip$/, '-Full_Package.zip');
    result.push({ version, label: label(version, 'Joomla'), url, sha256: null, phpMinimum, source: 'nightly', prerelease: true });
  }
  return unique(result);
}

/** Parse JCB's update manifest; discard version/URL inconsistencies and unsigned entries. */
export function parseJcbUpdates(xml) {
  if (typeof xml !== 'string') throw new TypeError('JCB update metadata must be text.');
  const result = [];
  for (const match of xml.matchAll(/<update(?:\s[^>]*)?>([\s\S]*?)<\/update\s*>/gi)) {
    const item = match[1];
    const version = firstTag(item, 'version');
    const checksum = firstTag(item, 'sha512');
    const rawURL = firstTag(item, 'downloadurl');
    if (!VERSION.test(version) || !SHA512.test(checksum) || firstTag(item, 'element') !== 'pkg_component_builder') continue;
    const url = safeURL(rawURL, 'https://github.com', /^\/joomengine\/pkg-component-builder\/archive\/refs\/tags\/v[\w.-]+\.zip$/);
    if (!url || new URL(url).pathname !== `/joomengine/pkg-component-builder/archive/refs/tags/v${version}.zip`) continue;
    result.push({ version, label: label(version, 'JCB'), url, sha512: checksum.toLowerCase(), source: 'jcb-update', prerelease: prerelease(version) });
  }
  return result;
}

/** Tag metadata identifies source commits, but is not an archive checksum. */
export function parseJcbTags(tags) {
  if (!Array.isArray(tags)) throw new TypeError('JCB tags must be an array.');
  const result = [];
  for (const tag of tags) {
    const name = typeof tag?.name === 'string' ? tag.name : '';
    const version = name.startsWith('v') ? name.slice(1) : '';
    const commit = tag?.commit?.sha;
    if (!VERSION.test(version) || !/^[a-f0-9]{40}$/i.test(commit || '')) continue;
    result.push({ version, label: label(version, 'JCB'),
      url: `https://github.com/joomengine/pkg-component-builder/archive/refs/tags/${name}.zip`,
      sha512: null, gitCommit: commit.toLowerCase(), source: 'jcb-tag', prerelease: prerelease(version) });
  }
  return result;
}

function mergeJcb(entries) {
  const grouped = new Map();
  for (const item of entries) {
    const group = grouped.get(item.version) || [];
    group.push(item);
    grouped.set(item.version, group);
  }
  const result = [];
  for (const group of grouped.values()) {
    const trusted = group.filter((entry) => entry.source === 'jcb-update');
    const uniqueTrusted = unique(trusted);
    // A disagreement between update manifests must not silently downgrade to a tag.
    if (trusted.length && uniqueTrusted.length !== 1) continue;
    const tags = unique(group.filter((entry) => entry.source === 'jcb-tag'));
    if (trusted.length) result.push({ ...uniqueTrusted[0], ...(tags[0]?.gitCommit ? { gitCommit: tags[0].gitCommit } : {}) });
    else if (tags.length === 1) result.push(tags[0]);
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
}

function unique(entries) {
  const versions = new Map();
  for (const entry of entries) {
    const key = `${entry.source}:${entry.version}`;
    const previous = versions.get(key);
    if (previous && (previous.url !== entry.url || previous.sha256 !== entry.sha256 || previous.sha512 !== entry.sha512 || previous.gitCommit !== entry.gitCommit || previous.phpMinimum !== entry.phpMinimum)) {
      // Conflicting upstream records cannot be treated as a verified package.
      versions.set(key, null);
    } else if (!versions.has(key)) versions.set(key, entry);
  }
  return [...versions.values()].filter(Boolean).sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
}

const CACHE_PREFIX = 'joomengine.dynamic-catalog.v1:';
const DEFAULT_TTL = 5 * 60_000;
const MAX_STALE_AGE = 24 * 60 * 60_000;

function compactMetadata(value, kind) {
  if (kind === 'xml') {
    if (typeof value !== 'string' || !/<updates(?:\s[^>]*)?>[\s\S]*<\/updates\s*>/i.test(value)) throw new TypeError('Invalid XML metadata response.');
    return value;
  }
  if (!Array.isArray(value)) throw new TypeError('Invalid catalog response.');
  if (kind === 'releases') return value.map((entry) => ({
    tag_name: entry?.tag_name, prerelease: entry?.prerelease, draft: entry?.draft,
    assets: Array.isArray(entry?.assets) ? entry.assets.filter((asset) => typeof asset?.name === 'string' && asset.name.endsWith('-Full_Package.zip'))
      .map((asset) => ({ name: asset.name, browser_download_url: asset.browser_download_url, digest: asset.digest })) : [],
  }));
  if (kind === 'branches') return value.map((entry) => ({ name: entry?.name }));
  if (kind === 'tags') return value.map((entry) => ({ name: entry?.name, commit: { sha: entry?.commit?.sha } }));
  throw new TypeError('Unknown catalog response type.');
}

async function requestData(fetchImpl, url, signal, { storage, kind, ttl, now, forceRefresh, onStale }) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  const key = CACHE_PREFIX + url;
  const timestamp = now();
  let cached;
  try {
    const record = JSON.parse(storage?.getItem(key) || 'null');
    if (record && record.kind === kind && Number.isFinite(record.savedAt) && record.savedAt <= timestamp) {
      cached = { savedAt: record.savedAt, value: compactMetadata(record.value, kind) };
    }
  } catch { /* Storage may be unavailable or contain old/corrupt data. */ }
  if (!forceRefresh && cached && timestamp - cached.savedAt < ttl) return cached.value;
  try {
    const response = await fetchImpl(url, { signal, credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = compactMetadata(await (kind === 'xml' ? response.text() : response.json()), kind);
    try {
      const serialized = JSON.stringify({ kind, savedAt: timestamp, value });
      if (serialized.length <= 512_000) storage?.setItem(key, serialized);
    } catch { /* Caching is optional when the quota or storage policy prevents it. */ }
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (cached && timestamp - cached.savedAt <= MAX_STALE_AGE) {
      onStale();
      return cached.value;
    }
    throw error;
  }
}

/**
 * Discover changing sources. Keep pinned defaults separately. Optional source URLs
 * permit a same-origin publisher for CORS-restricted upstream metadata. Errors are
 * returned per source, not substituted with invented package checksums.
 */
export async function discoverDynamicCatalog({ fetchImpl = globalThis.fetch, signal, sources = {}, onJoomlaPage, onJcbPage,
  maxPages = 3, cacheStorage, cacheTtlMs = DEFAULT_TTL, forceRefresh = false, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new TypeError('Invalid page limit.');
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > MAX_STALE_AGE || typeof now !== 'function') throw new TypeError('Invalid catalog cache settings.');
  let storage = cacheStorage;
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Storage is optional. */ }
  }
  const errors = [];
  const joomla = [];
  const jcb = [];
  const collect = async (name, task) => {
    try { await task(); }
    catch (error) {
      if (signal?.aborted) throw error;
      errors.push({ source: name, message: String(error?.message || error) });
    }
  };
  const read = (name, url, kind) => requestData(fetchImpl, url, signal, { storage, kind, ttl: cacheTtlMs, now, forceRefresh,
    onStale: () => errors.push({ source: name, message: 'Live metadata is unavailable; using a cached copy.' }) });
  await Promise.all([
    collect('joomla-releases', async () => {
      for (let page = 1; page <= maxPages; page++) {
        const json = await read('joomla-releases', `${sources.releases || RELEASES}?per_page=100&page=${page}`, 'releases');
        if (!Array.isArray(json)) throw new TypeError('Invalid Joomla releases response.');
        const parsed = parseJoomlaReleases(json);
        joomla.push(...parsed);
        if (onJoomlaPage) onJoomlaPage(parsed, page);
        if (json.length < 100) return;
        if (page === maxPages) errors.push({ source: 'joomla-releases', message: 'The release catalog is partial; load more pages for older releases.' });
      }
    }),
    ...((sources.nightlyURLs || NIGHTLY_FEEDS).map((url, index) => collect(`joomla-nightlies-${index + 1}`, async () => {
      joomla.push(...parseJoomlaNightlyUpdates(await read(`joomla-nightlies-${index + 1}`, url, 'xml')));
    }))),
    collect('jcb-updates', async () => {
      const branches = await read('jcb-updates', `${sources.branches || `${REPOSITORY}/branches`}?per_page=100`, 'branches');
      if (!Array.isArray(branches)) throw new TypeError('Invalid JCB branch response.');
      const names = [...new Set(branches.map((branch) => branch?.name).filter((name) => typeof name === 'string' && BRANCH.test(name)))];
      if (!names.length) throw new Error('No versioned JCB branches were found.');
      await Promise.all(names.map((name) => collect(`jcb-${name}`, async () => {
        const base = sources.jcbRawBase || 'https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder';
        const xml = await read(`jcb-${name}`, `${base}/${name}/componentbuilder_update_server.xml`, 'xml');
        jcb.push(...parseJcbUpdates(xml));
      })));
    }),
    collect('jcb-tags', async () => {
      for (let page = 1; page <= maxPages; page++) {
        const json = await read('jcb-tags', `${sources.jcbTags || PACKAGE_TAGS}?per_page=100&page=${page}`, 'tags');
        if (!Array.isArray(json)) throw new TypeError('Invalid JCB tags response.');
        const parsed = parseJcbTags(json);
        jcb.push(...parsed);
        if (onJcbPage) onJcbPage(parsed, page);
        if (json.length < 100) return;
        if (page === maxPages) errors.push({ source: 'jcb-tags', message: 'The JCB tag catalog is partial; load more pages for older releases.' });
      }
    }),
  ]);
  return { joomla: unique(joomla), jcb: mergeJcb(jcb), errors };
}
