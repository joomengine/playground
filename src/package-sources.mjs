import { networkFetch } from './network-transport.mjs';

const PROVIDERS = new Set(['direct', 'github', 'gitea', 'gitlab']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'x-playground-request', 'x-playground-response']);

function invalid(key, message) {
  return Object.assign(new TypeError(message), { i18nKey: `error.${key}` });
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid('packageAuthRequired', `${label} is required.`);
  if (/[\r\n\0]/.test(value)) throw invalid('packageAuthSingleLine', `${label} contains an invalid character.`);
  return value;
}

function sourceURL(value, baseURL, label = 'Package URL') {
  let url;
  try { url = new URL(text(value, label), baseURL); }
  catch { throw invalid(label === 'Provider API URL' ? 'packageApiBase' : 'packageUrl', `${label} must be an HTTP or HTTPS URL.`); }
  if (!['https:', 'http:'].includes(url.protocol)) throw invalid(label === 'Provider API URL' ? 'packageApiBase' : 'packageUrl', `${label} must be an HTTP or HTTPS URL.`);
  if (url.username || url.password) throw invalid('packageUrlCredentials', 'Put package credentials in Authentication, not in the URL.');
  return url;
}

function headerName(value) {
  if (typeof value !== 'string' || !HEADER_NAME.test(value) || RESERVED_HEADERS.has(value.toLowerCase())) {
    throw invalid('packageHeaderName', 'Use a valid, application-level HTTP header name.');
  }
  return value.toLowerCase();
}

/** Normalize only download fields; the deployment parser owns integrity metadata. */
export function normalizePackageSource(entry, baseURL = 'https://playground.invalid/') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('packageObject', 'An extension package must be an object.');
  const result = { url: sourceURL(entry.url, baseURL).href };
  if (entry.provider !== undefined) {
    if (!PROVIDERS.has(entry.provider)) throw invalid('packageProvider', 'Choose a supported package provider.');
    result.provider = entry.provider;
  }
  if (entry.apiBase !== undefined) {
    const base = sourceURL(entry.apiBase, baseURL, 'Provider API URL');
    if (base.search || base.hash) throw invalid('packageApiBase', 'The provider API URL must not contain a query or fragment.');
    result.apiBase = base.href.replace(/\/$/, '');
  }
  if (entry.headers !== undefined) {
    if (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)) throw invalid('packageHeaders', 'Package headers must be an object of header names and values.');
    const pairs = [];
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw invalid('packageHeaders', 'Package header values must be single-line text.');
      pairs.push([headerName(name), value]);
    }
    result.headers = Object.fromEntries(pairs);
  }
  if (entry.authentication !== undefined) {
    const auth = entry.authentication;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw invalid('packageAuthObject', 'Package authentication must be an object.');
    const types = { bearer: ['token'], token: ['token'], basic: ['username', 'password'], header: ['name', 'value'] };
    const fields = Object.hasOwn(types, auth.type) ? types[auth.type] : null;
    if (!fields) throw invalid('packageAuthMethod', 'Choose a supported package authentication method.');
    if (Object.keys(auth).some(key => !['type', ...fields].includes(key))) throw invalid('packageAuthFields', 'Use only the fields required by the selected authentication method.');
    result.authentication = { type: auth.type };
    for (const field of fields) result.authentication[field] = text(auth[field], `Authentication ${field}`);
    if (auth.type === 'basic' && auth.username.includes(':')) throw invalid('packageBasicUsername', 'A Basic authentication username cannot contain a colon.');
    if (auth.type === 'header') result.authentication.name = headerName(auth.name);
  }
  return result;
}

/** Custom headers are scoped just like named credentials, including unusual token headers. */
export function hasPackageAuthentication(entry) {
  return Boolean(entry?.authentication || entry?.headers && Object.keys(entry.headers).length);
}

function providerFor(entry, url) {
  if (entry.provider) return entry.provider;
  if (['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return 'github';
  if (url.hostname === 'gitlab.com') return 'gitlab';
  return 'direct';
}

function apiURL(entry, source, provider) {
  const fallback = provider === 'github'
    ? ['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(source.hostname) ? 'https://api.github.com' : `${source.origin}/api/v3`
    : `${source.origin}${provider === 'gitea' ? '/api/v1' : '/api/v4'}`;
  return sourceURL(entry.apiBase || fallback).href.replace(/\/$/, '');
}

function authenticationHeaders(entry, provider) {
  const headers = new Headers(entry.headers);
  const auth = entry.authentication;
  if (auth?.type === 'bearer') headers.set('authorization', `Bearer ${auth.token}`);
  if (auth?.type === 'token') {
    if (provider === 'gitlab') headers.set('private-token', auth.token);
    else headers.set('authorization', `${provider === 'github' ? 'Bearer' : 'token'} ${auth.token}`);
  }
  if (auth?.type === 'header') headers.set(auth.name, auth.value);
  if (auth?.type === 'basic') {
    let binary = '';
    for (const byte of new TextEncoder().encode(`${auth.username}:${auth.password}`)) binary += String.fromCharCode(byte);
    headers.set('authorization', `Basic ${btoa(binary)}`);
  }
  return headers;
}

function failure(message, status) {
  const error = new Error(message + (status ? ` HTTP ${status}.` : ''));
  error.code = 'PACKAGE_SOURCE_FAILED';
  if (status) error.status = status;
  return error;
}

function segment(value) {
  try { return decodeURIComponent(value); }
  catch { throw failure('The package URL contains an invalid encoded path.'); }
}

/** Resolve provider web URLs to a binary download; metadata and bytes share one transport. */
export async function resolvePackageRequest(value, { fetcher = networkFetch } = {}) {
  const entry = normalizePackageSource(value);
  const source = new URL(entry.url);
  const provider = providerFor(entry, source);
  const api = provider === 'direct' ? null : apiURL(entry, source, provider);
  const headers = authenticationHeaders(entry, provider);
  const credentialHeaders = [...headers.keys()];
  const origins = new Set([source.origin, ...(api ? [new URL(api).origin] : [])]);
  const initFor = (url, accept) => {
    const outgoing = new Headers(headers);
    if (!origins.has(new URL(url).origin)) for (const name of credentialHeaders) outgoing.delete(name);
    if (accept) outgoing.set('accept', accept);
    return { method: 'GET', headers: outgoing, credentials: 'omit', cache: 'no-store',
      network: { credentialHeaders, cache: 'no-store' } };
  };
  const metadata = async url => {
    let response;
    try { response = await fetcher(url, initFor(url, 'application/json')); }
    catch { throw failure('The package provider could not be reached.'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('The package provider could not resolve this asset. Check its location and access credentials.', response.status); }
    try { return await response.json(); }
    catch { throw failure('The package provider returned invalid asset metadata.'); }
  };
  let url = source.href;
  let accept;
  const installationPath = api && new URL(api).origin === source.origin
    ? new URL(api).pathname.replace(/\/api\/v\d+\/?$/, '') : '';
  const path = installationPath && source.pathname.startsWith(`${installationPath}/`)
    ? source.pathname.slice(installationPath.length) : source.pathname;
  if (provider === 'github') {
    const webAsset = /^\/([^/]+)\/([^/]+)\/releases\/(?:download\/([^/]+)\/|latest\/download\/)(.+)$/.exec(path);
    const raw = source.hostname === 'raw.githubusercontent.com'
      ? /^\/([^/]+)\/([^/]+)\/(?:refs\/(?:heads|tags)\/)?([^/]+)\/(.+)$/.exec(path)
      : /^\/([^/]+)\/([^/]+)\/raw\/(?:refs\/(?:heads|tags)\/)?([^/]+)\/(.+)$/.exec(path);
    const archive = /^\/([^/]+)\/([^/]+)\/archive\/(?:refs\/(?:heads|tags)\/)?(.+)\.zip$/.exec(path);
    if (webAsset) {
      const [, owner, repository, tag, filename] = webAsset;
      const release = await metadata(`${api}/repos/${owner}/${repository}/releases/${tag ? `tags/${encodeURIComponent(segment(tag))}` : 'latest'}`);
      const asset = release.assets?.find(item => item.name === segment(filename));
      if (!asset || !Number.isSafeInteger(asset.id)) throw failure('The selected release does not contain that package asset.');
      url = `${api}/repos/${owner}/${repository}/releases/assets/${asset.id}`;
      accept = 'application/octet-stream';
    } else if (raw) {
      const [, owner, repository, ref, filename] = raw;
      url = `${api}/repos/${owner}/${repository}/contents/${filename}?ref=${encodeURIComponent(segment(ref))}`;
      accept = 'application/vnd.github.raw+json';
    } else if (archive) {
      const [, owner, repository, ref] = archive;
      url = `${api}/repos/${owner}/${repository}/zipball/${encodeURIComponent(segment(ref))}`;
      accept = 'application/octet-stream';
    } else if (source.href.startsWith(`${api}/`)) {
      accept = /\/contents\//.test(path) ? 'application/vnd.github.raw+json' : 'application/octet-stream';
    }
  } else if (provider === 'gitea') {
    const webAsset = /^\/(.+?)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
    if (webAsset) {
      const [, owner, repository, tag, filename] = webAsset;
      const release = await metadata(`${api}/repos/${owner}/${repository}/releases/tags/${encodeURIComponent(segment(tag))}`);
      const asset = release.assets?.find(item => item.name === segment(filename));
      if (!asset?.browser_download_url) throw failure('The selected release does not contain that package asset.');
      url = sourceURL(asset.browser_download_url, source.href).href;
    } else if (source.href.startsWith(`${api}/`) && /\/releases\/\d+\/assets\/\d+\/?$/.test(path)) {
      const asset = await metadata(source.href);
      if (!asset?.browser_download_url) throw failure('The package provider did not return an attachment download URL.');
      url = sourceURL(asset.browser_download_url, source.href).href;
    }
  } else if (provider === 'gitlab') {
    const release = /^\/(.+)\/-\/releases\/([^/]+)\/downloads\/(.+)$/.exec(path);
    const raw = /^\/(.+)\/-\/raw\/([^/]+)\/(.+)$/.exec(path);
    const archive = /^\/(.+)\/-\/archive\/([^/]+)\/[^/]+\.zip$/.exec(path);
    if (release) {
      url = `${api}/projects/${encodeURIComponent(segment(release[1]))}/releases/${encodeURIComponent(segment(release[2]))}/downloads/${release[3]}`;
    } else if (raw) {
      url = `${api}/projects/${encodeURIComponent(segment(raw[1]))}/repository/files/${encodeURIComponent(segment(raw[3]))}/raw?ref=${encodeURIComponent(segment(raw[2]))}`;
    } else if (archive) {
      url = `${api}/projects/${encodeURIComponent(segment(archive[1]))}/repository/archive.zip?sha=${encodeURIComponent(segment(archive[2]))}`;
    }
  }
  return { url, init: initFor(url, accept) };
}

/** The Joomla installer receives bytes, never provider tokens in command arguments. */
export async function downloadExtensionPackage(entry, { fetcher = networkFetch } = {}) {
  try {
    const request = await resolvePackageRequest(entry, { fetcher });
    const response = await fetcher(request.url, request.init);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('The extension package could not be downloaded. Check its location and access credentials.', response.status); }
    const type = response.headers.get('content-type') || '';
    if (/\b(?:text\/html|application\/(?:[^;]+\+)?json)\b/i.test(type)) {
      void response.body?.cancel().catch(() => {});
      throw failure('The package URL returned a web page or metadata instead of an extension archive.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) throw failure('The extension package download was empty.');
    return bytes;
  } catch (error) {
    if (error.code === 'PACKAGE_SOURCE_FAILED') throw error;
    throw failure('The extension package could not be downloaded. Check its location, connection, and access credentials.');
  }
}
