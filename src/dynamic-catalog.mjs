/** Discover the current and forward official packages for build-time staging. */

const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\d*(?:-dev)?|-dev)?$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SHA512 = /^[a-f0-9]{128}$/i;
const RELEASES = 'https://api.github.com/repos/joomla/joomla-cms/releases';
const NIGHTLY_FEEDS = ['next_patch', 'next_minor', 'next_major']
  .map((name) => `https://update.joomla.org/core/nightlies/${name}_list.xml`);
const JCB_RAW = 'https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads';
const JCB_FEEDS = ['5.x', '6.x'].map(branch => `${JCB_RAW}/${branch}/componentbuilder_update_server.xml`);

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

function newestVersionFirst(a, b) {
  const parts = (version) => {
    const [core, stage = '', development = ''] = version.toLowerCase().split('-');
    const match = /^(alpha|beta|rc)(\d*)$/.exec(stage);
    return [...core.split('.').map(Number), stage === '' ? 4 : match ? { alpha: 1, beta: 2, rc: 3 }[match[1]] : 0,
      Number(match?.[2] || 0), development === 'dev' ? 0 : 1];
  };
  const left = parts(a.version);
  const right = parts(b.version);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

/** One current stable per major, one nightly per active minor, and the newest
 * preview of each future release. Historical releases are never menu options.
 * Package metadata stays intact so staging and the UI share the same policy. */
export function selectCurrentForwardVersions(entries, { allowedMajors = ['5', '6', '7'], minimumMajor = 5, defaultMajor = '6' } = {}) {
  const allowed = allowedMajors === null ? null : new Set(allowedMajors.map(String));
  const candidates = entries.filter(entry => VERSION.test(entry?.version || '')
    && Number(entry.version.split('.')[0]) >= minimumMajor
    && (!allowed || allowed.has(entry.version.split('.')[0]))).map(entry => ({ ...entry,
    channel: entry.source === 'nightly' || entry.version.endsWith('-dev') ? 'nightly'
      : entry.prerelease === true || prerelease(entry.version) ? 'preview' : 'stable',
  })).sort(newestVersionFirst);
  const stable = new Map();
  for (const entry of candidates) {
    const major = entry.version.split('.')[0];
    if (entry.channel === 'stable' && !stable.has(major)) stable.set(major, entry);
  }
  const forward = new Map();
  for (const entry of candidates) {
    if (entry.channel === 'stable') continue;
    const floor = stable.get(entry.version.split('.')[0]);
    if (floor && newestVersionFirst(entry, floor) >= 0) continue;
    const target = entry.channel === 'nightly' ? entry.version.split('.').slice(0, 2).join('.') : entry.version.split('-')[0];
    const key = `${entry.channel}:${target}`;
    if (!forward.has(key)) forward.set(key, entry);
  }
  const channelOrder = { stable: 0, nightly: 1, preview: 2 };
  return [...stable.values(), ...forward.values()].sort((a, b) => {
    const channelDifference = channelOrder[a.channel] - channelOrder[b.channel];
    if (channelDifference) return channelDifference;
    if (a.channel === 'stable') {
      const preferred = Number(b.version.split('.')[0] === String(defaultMajor)) - Number(a.version.split('.')[0] === String(defaultMajor));
      if (preferred) return preferred;
    }
    return newestVersionFirst(a, b);
  });
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
export function parseJoomlaNightlyList(xml) {
  if (typeof xml !== 'string') throw new TypeError('Joomla nightly metadata must be text.');
  const urls = new Set();
  for (const match of xml.matchAll(/<extension\b([^>]*)\/?\s*>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
      .map((attribute) => [attribute[1].toLowerCase(), xmlText(attribute[3])]));
    if (attributes.element !== 'joomla' || attributes.type !== 'file') continue;
    const url = safeURL(attributes.detailsurl, 'https://update.joomla.org', /^\/core\/nightlies\/[a-z_]+_extension\.xml$/);
    if (url) urls.add(url);
  }
  return [...urls];
}

/** Choose fresh-install archives, not the update-only ZIPs in update feeds. */
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
    // Any checksum in this update record describes the update ZIP, not the full
    // installer. Never attach it to the different archive selected here.
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
    const platform = item.match(/<targetplatform\b[^>]*\bversion\s*=\s*(["'])(.*?)\1/i)?.[2];
    result.push({ version, label: label(version, 'JCB'), url, sha512: checksum.toLowerCase(), source: 'jcb-update', prerelease: prerelease(version),
      ...(platform ? { targetPlatform: xmlText(platform) } : {}) });
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

function unique(entries) {
  const versions = new Map();
  for (const entry of entries) {
    const key = `${entry.source}:${entry.version}`;
    const previous = versions.get(key);
    if (previous && (previous.url !== entry.url || previous.sha256 !== entry.sha256 || previous.sha512 !== entry.sha512 || previous.gitCommit !== entry.gitCommit || previous.phpMinimum !== entry.phpMinimum || previous.targetPlatform !== entry.targetPlatform)) {
      // Conflicting upstream records cannot be treated as a verified package.
      versions.set(key, null);
    } else if (!versions.has(key)) versions.set(key, entry);
  }
  return [...versions.values()].filter(Boolean).sort(newestVersionFirst);
}

const CACHE_PREFIX = 'joomengine.dynamic-catalog.v2:';
const DEFAULT_TTL = 5 * 60_000;
const MAX_STALE_AGE = 24 * 60 * 60_000;

function compactMetadata(value, kind) {
  if (kind === 'xml') {
    if (typeof value !== 'string' || !/<(updates|extensionset)(?:\s[^>]*)?>[\s\S]*<\/\1\s*>/i.test(value)) throw new TypeError('Invalid XML metadata response.');
    return value;
  }
  if (!Array.isArray(value)) throw new TypeError('Invalid catalog response.');
  if (kind === 'releases') return value.map((entry) => ({
    tag_name: entry?.tag_name, prerelease: entry?.prerelease, draft: entry?.draft,
    assets: Array.isArray(entry?.assets) ? entry.assets.filter((asset) => typeof asset?.name === 'string' && asset.name.endsWith('-Full_Package.zip'))
      .map((asset) => ({ name: asset.name, browser_download_url: asset.browser_download_url, digest: asset.digest })) : [],
  }));
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
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: 'omit', cache: 'no-store', redirect: 'follow' });
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
 * Read the three official Joomla nightly channels and the two JCB manifests.
 * One bounded recent Joomla release request supplies stable/published previews;
 * it never walks release history, branch lists, or the package tag archive.
 * Pinned inputs remain a safe baseline when an upstream feed is unavailable.
 */
export async function discoverDynamicCatalog({ fetchImpl = globalThis.fetch, signal, sources = {},
  pinnedJoomla = [], pinnedJcb = [], cacheStorage, cacheTtlMs = DEFAULT_TTL,
  forceRefresh = false, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
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
  const nightlyReads = new Map();
  const readNightly = (name, url) => {
    if (!nightlyReads.has(url)) nightlyReads.set(url, collect(name, async () => {
      joomla.push(...parseJoomlaNightlyUpdates(await read(name, url, 'xml')));
    }));
    return nightlyReads.get(url);
  };
  await Promise.all([
    collect('joomla-releases', async () => {
      const url = new URL(sources.releases || RELEASES);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', '1');
      joomla.push(...parseJoomlaReleases(await read('joomla-releases', url.href, 'releases')));
    }),
    ...[...new Set(sources.nightlyURLs || NIGHTLY_FEEDS)].map((url, index) => collect(`joomla-nightlies-${index + 1}`, async () => {
      const name = `joomla-nightlies-${index + 1}`;
      const xml = await read(name, url, 'xml');
      if (/<extensionset\b/i.test(xml)) {
        const details = parseJoomlaNightlyList(xml);
        if (!details.length) throw new Error('No Joomla nightly update feeds were found.');
        await Promise.all(details.map(detailsURL => readNightly(name, detailsURL)));
      } else joomla.push(...parseJoomlaNightlyUpdates(xml));
    })),
    ...[...new Set(sources.jcbURLs || JCB_FEEDS)].map((url, index) => collect(`jcb-updates-${index + 1}`, async () => {
      jcb.push(...parseJcbUpdates(await read(`jcb-updates-${index + 1}`, url, 'xml')));
    })),
  ]);
  const withPinned = (entries, pinned) => {
    const result = new Map(unique(entries).map(entry => [entry.version, entry]));
    for (const entry of pinned) result.set(entry.version, { ...result.get(entry.version), ...entry });
    return [...result.values()];
  };
  return {
    joomla: selectCurrentForwardVersions(withPinned(joomla, pinnedJoomla)),
    jcb: selectCurrentForwardVersions(withPinned(jcb, pinnedJcb), { allowedMajors: null }),
    errors,
  };
}
