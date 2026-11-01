import { normalizePhpSettings } from './php-settings.mjs';
import { parseMenus, parseTemplate, parseLanguageTags } from './site-configuration.mjs';
export { parseMenus, parseTemplate, parseLanguageTags } from './site-configuration.mjs';

const VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/;
const SHA256 = /^[a-f\d]{64}$/i;
const SHA512 = /^[a-f\d]{128}$/i;
const STORAGE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const DEPLOY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DEFAULTS = Object.freeze({
  phpVersion: '8.4',
  joomlaVersion: '6.2.0',
  siteName: 'Joomla Playground',
  initialPath: '/',
  persistence: true,
  storageKey: 'default',
  autoLogin: true,
  hideToolbar: false,
  language: 'en-GB',
  fresh: false,
  admin: Object.freeze({
    name: 'Playground Administrator',
    username: 'admin',
    email: 'admin@example.test',
  }),
});

function requireText(value, name, maxLength, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be ${empty ? 'a' : 'a nonempty'} text value of at most ${maxLength} characters.`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be true or false.`);
  return value;
}

export function normalizeInitialPath(value = '/') {
  requireText(value, 'Initial page', 2048);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new TypeError('Initial page must be a local path such as / or /administrator/.');
  }
  let decoded;
  try { decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]); } catch {
    throw new TypeError('Initial page contains invalid URL encoding.');
  }
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some((part) => part === '..' || part === '.')) {
    throw new TypeError('Initial page must stay inside the playground site.');
  }
  return value;
}

/** Resolve a local Joomla path without interpreting its first segment as a URL scheme. */
export function resolveSiteURL(path, baseURL) {
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || !base.pathname.endsWith('/')) {
    throw new TypeError('The site base must be an HTTP URL ending in a slash.');
  }
  const target = new URL(`.${normalizeInitialPath(path)}`, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new TypeError('The page must stay inside the playground site.');
  }
  return target.href;
}

function parseJSONList(value, name) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a JSON array.`);
  try {
    const result = JSON.parse(value.trim() || '[]');
    if (!Array.isArray(result)) throw new TypeError();
    return result;
  } catch {
    throw new TypeError(`${name} must be a valid JSON array.`);
  }
}

export function parseExtensions(value = [], baseURL = 'https://playground.invalid/', { allowHttp = true } = {}) {
  const entries = parseJSONList(value, 'Extensions');
  if (entries.length > 30) throw new TypeError('Choose at most 30 extension packages.');
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`Extension ${index + 1} must be an object containing a url, for example {"url":"https://example.org/extension.zip"}.`);
    const raw = requireText(entry.url, `Extension ${index + 1} URL`, 2048);
    let url;
    try { url = new URL(raw, baseURL); } catch { throw new TypeError(`Extension ${index + 1} has an invalid URL.`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowHttp || local))) || url.username || url.password || url.hash) {
      throw new TypeError(`Extension ${index + 1} needs ${allowHttp ? 'an HTTP or HTTPS' : 'an HTTPS'} URL without credentials or a fragment.`);
    }
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))) {
      throw new TypeError(`Extension ${index + 1} SHA-256 must contain 64 hexadecimal characters.`);
    }
    if (entry.sha512 !== undefined && (typeof entry.sha512 !== 'string' || !SHA512.test(entry.sha512))) {
      throw new TypeError(`Extension ${index + 1} SHA-512 must contain 128 hexadecimal characters.`);
    }
    return { url: url.href, ...(entry.sha256 ? { sha256: entry.sha256.toLowerCase() } : {}),
      ...(entry.sha512 ? { sha512: entry.sha512.toLowerCase() } : {}) };
  });
}

/** User URLs are installed by Joomla's normal installer; only managed packages
 * use the reviewed integrity metadata supplied by the deployment catalog. */
export function parseUserExtensions(value = [], baseURL = 'https://playground.invalid/', options = {}) {
  const entries = parseJSONList(value, 'Extensions').map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const { sha256, sha512, ...packageEntry } = entry;
    return packageEntry;
  });
  return parseExtensions(entries, baseURL, options);
}

export function parseUserTemplate(value, baseURL = 'https://playground.invalid/') {
  if (typeof value === 'string' && value.trim()) {
    try { value = JSON.parse(value); } catch { throw new TypeError('Template must be a JSON object.'); }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { sha256, sha512, ...template } = value;
    value = template;
  }
  return parseTemplate(value, baseURL);
}

export function parseStartupCommands(value = []) {
  const commands = parseJSONList(value, 'Startup commands');
  if (commands.length > 30) throw new TypeError('Choose at most 30 startup commands.');
  return commands.map((argv, index) => {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
      throw new TypeError(`Startup command ${index + 1} must be a nonempty array of arguments.`);
    }
    const result = argv.map((argument, argumentIndex) => requireText(argument, argumentIndex === 0 ? 'Command name' : 'Command argument', 4096, { empty: argumentIndex > 0 }));
    if (!/^[a-z][a-z0-9:_-]*$/i.test(result[0])) throw new TypeError('Use a Joomla command name without a PHP or shell prefix.');
    return result;
  });
}

export function parseCatalog(manifest, { baseURL } = {}) {
  if (!manifest || !Array.isArray(manifest.php) || !Array.isArray(manifest.joomla)) {
    throw new TypeError('The runtime manifest must list available PHP and Joomla versions.');
  }
  const php = manifest.php.map((entry) => {
    const item = typeof entry === 'string' ? { version: entry } : entry;
    if (!item || !VERSION.test(item.version)) throw new TypeError('The runtime manifest contains an invalid PHP version.');
    return { ...item, label: item.label || `PHP ${item.version}` };
  });
  const joomla = manifest.joomla.map((entry) => {
    if (!entry || !VERSION.test(entry.version) || !Array.isArray(entry.php) || entry.php.length === 0 || entry.php.some((version) => !php.some((item) => item.version === version))) {
      throw new TypeError('The runtime manifest contains an invalid Joomla compatibility entry.');
    }
    return { ...entry, ...(baseURL && entry.url ? { url: new URL(entry.url, baseURL).href } : {}),
      label: entry.label || `Joomla ${entry.version}` };
  });
  if (!php.length || !joomla.length) throw new TypeError('No tested runtime versions are available.');
  const defaults = {
    phpVersion: manifest.defaults?.phpVersion || php[0].version,
    joomlaVersion: manifest.defaults?.joomlaVersion || joomla[0].version,
  };
  if (!joomla.some((item) => item.version === defaults.joomlaVersion && item.php.includes(defaults.phpVersion))) {
    throw new TypeError('The runtime manifest default versions are incompatible.');
  }
  return { php, joomla, defaults };
}

export function normalizeLanguage(value = 'en-GB') {
  if (typeof value !== 'string' || !LANGUAGE.test(value)) throw new TypeError('Use a Joomla language tag such as en-GB or nl-NL.');
  return value;
}

export function normalizeDeployId(value) {
  if (typeof value !== 'string' || !DEPLOY_ID.test(value)) throw new TypeError('Deploy names must use lowercase letters, numbers or hyphens.');
  return value;
}

export function resolveJoomlaVersion(value, catalog) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new TypeError('Select a valid Joomla version.');
  if (!catalog) return value;
  const exact = catalog.joomla.find((entry) => entry.version === value);
  if (exact) return exact.version;
  const releases = catalog.joomla.filter((entry) => entry.version.startsWith(`${value}.`))
    // A shorthand such as 6.2 must not silently switch an existing stable
    // configuration to a newer nightly when the dynamic catalogue updates.
    .sort((a, b) => Number(a.version.includes('-')) - Number(b.version.includes('-'))
      || b.version.localeCompare(a.version, 'en', { numeric: true }));
  if (!releases.length) throw new TypeError(`Joomla ${value} is not available in the tested runtime catalog.`);
  return releases[0].version;
}

export function normalizeConfiguration(input = {}, { catalog, baseURL = 'https://playground.invalid/' } = {}) {
  const config = { ...DEFAULTS, ...catalog?.defaults, ...input, admin: { ...DEFAULTS.admin, ...input.admin } };
  config.joomlaVersion = resolveJoomlaVersion(config.joomlaVersion, catalog);
  if (typeof config.phpVersion !== 'string' || !VERSION.test(config.phpVersion) || typeof config.joomlaVersion !== 'string' || !VERSION.test(config.joomlaVersion)) {
    throw new TypeError('Select a valid PHP and Joomla version.');
  }
  if (catalog && !catalog.joomla.some((item) => item.version === config.joomlaVersion && item.php.includes(config.phpVersion))) {
    throw new TypeError('This PHP and Joomla combination is not available in the tested runtime catalog.');
  }
  config.siteName = requireText(config.siteName, 'Site name', 100);
  config.initialPath = normalizeInitialPath(config.initialPath);
  if (typeof config.storageKey !== 'string' || !STORAGE_KEY.test(config.storageKey)) throw new TypeError('Site key must use 1–64 letters, numbers, dots, underscores or hyphens.');
  for (const key of ['persistence', 'autoLogin', 'hideToolbar', 'fresh']) config[key] = requireBoolean(config[key], key);
  config.language = normalizeLanguage(config.language);
  if (config.deployId !== undefined) config.deployId = normalizeDeployId(config.deployId);
  if (config.joomlaPackage !== undefined) {
    if (typeof input.joomlaVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.joomlaVersion)) {
      throw new TypeError('A Joomla package requires an exact Joomla version.');
    }
    config.joomlaPackage = normalizeJoomlaPackage(config.joomlaPackage, baseURL,
      catalog?.joomla.find(entry => entry.version === config.joomlaVersion));
    if (!config.joomlaPackage.php.includes(config.phpVersion)) throw new TypeError('The Joomla package does not support the selected PHP runtime.');
  }
  if (config.jcbVersion !== undefined) config.jcbVersion = normalizeJcbVersion(config.jcbVersion);
  if (config.jcbPackage !== undefined) {
    if (!config.jcbVersion || config.jcbVersion === 'none') throw new TypeError('A JCB package requires a selected JCB version.');
    config.jcbPackage = normalizeJcbPackage(config.jcbPackage, baseURL);
  }
  config.admin.name = requireText(config.admin.name, 'Administrator name', 100);
  config.admin.username = requireText(config.admin.username, 'Administrator username', 100);
  config.admin.email = requireText(config.admin.email, 'Administrator email', 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.admin.email)) throw new TypeError('Enter a valid administrator email address.');
  config.admin.password = requireText(config.admin.password ?? '', 'Administrator password', 128);
  if (config.admin.password.length < 12) throw new TypeError('Administrator password must contain at least 12 characters.');
  config.phpSettings = normalizePhpSettings(config.phpSettings ?? {});
  config.menus = parseMenus(config.menus ?? []);
  const hasTemplateProvenance = config.addonTemplate !== undefined;
  const addonTemplate = parseUserTemplate(hasTemplateProvenance ? config.addonTemplate : config.template, baseURL);
  const userTemplate = !hasTemplateProvenance || addonTemplate?.url ? parseUserTemplate(config.template, baseURL) : null;
  config.template = !hasTemplateProvenance || (addonTemplate?.url && addonTemplate.url === userTemplate?.url)
    ? userTemplate : parseTemplate(config.template, baseURL);
  config.addonTemplate = addonTemplate?.url ? addonTemplate : null;
  config.languageTags = parseLanguageTags(config.languageTags ?? []);
  config.multilingual = requireBoolean(config.content?.multilingual === true ? true : (config.multilingual ?? false), 'multilingual');
  // Direct callers supply custom URLs unless a resolved recipe explicitly
  // separates managed packages from additions. Strip custom checksum metadata
  // before strict managed-package validation at this runtime boundary.
  config.addonExtensions = parseUserExtensions(config.addonExtensions ?? config.extensions ?? [], baseURL);
  const addonURLs = new Set(config.addonExtensions.map(entry => entry.url));
  const extensions = parseJSONList(config.extensions ?? [], 'Extensions').map(entry => {
    if (!addonURLs.size) return entry;
    const custom = parseUserExtensions([entry], baseURL)[0];
    return addonURLs.has(custom.url) ? custom : entry;
  });
  config.extensions = parseExtensions(extensions, baseURL);
  config.startupCommands = parseStartupCommands(config.startupCommands ?? []);
  if (!Array.isArray(config.languages ?? []) || (config.languages ?? []).length > 30) throw new TypeError('Language packages must be an array of at most 30 entries.');
  config.languages = (config.languages ?? []).map((entry) => ({ ...parseExtensions([entry], baseURL, { allowHttp: false })[0], tag: normalizeLanguage(requireText(entry.tag, 'Language package tag', 20)) }));
  return config;
}

export function normalizeJcbVersion(value) {
  if (value === 'none') return value;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)) throw new TypeError('Select a valid JCB version or none.');
  return value;
}

export function normalizeJcbPackage(value, baseURL = 'https://playground.invalid/') {
  const result = parseExtensions([value], baseURL, { allowHttp: false })[0];
  if (!result.sha256 && !result.sha512) throw new TypeError('The JCB package requires a SHA-256 or SHA-512 checksum.');
  return result;
}

export function normalizeJoomlaPackage(value, baseURL = 'https://playground.invalid/', published) {
  const result = parseExtensions([value], baseURL, { allowHttp: false })[0];
  if (!result.sha256) throw new TypeError('The Joomla package requires a SHA-256 checksum.');
  if (!Array.isArray(value.php) || !value.php.length || value.php.length > 30 || value.php.some(version => typeof version !== 'string' || !/^\d+\.\d+$/.test(version))) {
    throw new TypeError('The Joomla package must list its available PHP versions.');
  }
  // Older profile switches resolved a manifest-relative ZIP against the page,
  // dropping its assets/ prefix. Repair only that exact URL for the same bytes.
  if (published?.url && published.sha256?.toLowerCase() === result.sha256) {
    const assets = new URL('assets/', baseURL);
    const canonical = new URL(published.url, assets);
    if (canonical.origin === assets.origin && canonical.pathname.startsWith(assets.pathname)) {
      const misplaced = new URL(canonical.pathname.slice(assets.pathname.length) + canonical.search, baseURL);
      if (result.url === misplaced.href) result.url = canonical.href;
    }
  }
  return { url: result.url, sha256: result.sha256, php: [...new Set(value.php)] };
}

/** Reconstruct an explicitly selected, integrity-pinned release when a shared
 * configuration or saved site is opened without the online discovery catalog.
 * Runtime binaries still come exclusively from the local catalog. */
export function catalogWithSelectedJoomlaPackage(catalog, input, baseURL = 'https://playground.invalid/') {
  if (input.joomlaPackage === undefined) return catalog;
  if (typeof input.joomlaVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.joomlaVersion)) {
    throw new TypeError('A Joomla package requires an exact Joomla version.');
  }
  const current = catalog.joomla.find(entry => entry.version === input.joomlaVersion);
  const selected = normalizeJoomlaPackage(input.joomlaPackage, baseURL, current);
  // A nightly can publish different bytes and PHP requirements under the same
  // dev version. An older saved archive retains its own compatibility; stable
  // releases and the exact currently published bytes retain the catalog limits.
  const replacedNightly = /-dev$/i.test(input.joomlaVersion)
    && /^[a-f0-9]{64}$/i.test(current?.sha256 || '') && current.sha256.toLowerCase() !== selected.sha256;
  for (const version of selected.php) {
    if (!catalog.php.some(entry => entry.version === version) || (current && !replacedNightly && !current.php.includes(version))) {
      throw new TypeError(`PHP ${version} is not available for the selected Joomla release in this runtime catalog.`);
    }
  }
  return { ...catalog, joomla: [...catalog.joomla.filter(entry => entry.version !== input.joomlaVersion),
    { ...selected, version: input.joomlaVersion, label: `Joomla ${input.joomlaVersion}` }] };
}

export function readURLConfiguration(url) {
  const location = new URL(url);
  if (location.href.length > 65_536) throw new TypeError('The playground configuration link is too long.');
  const params = location.searchParams;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const config = fragment.has('deploy') ? parseDeploymentDocument(decodeDocument(fragment.get('deploy')), { baseURL: location.href, publicOnly: true }) : {};
  const boolean = (name) => {
    const value = params.get(name).toLowerCase();
    if (['1', 'true', 'yes'].includes(value)) return true;
    if (['0', 'false', 'no'].includes(value)) return false;
    throw new TypeError(`${name} must be yes/no, true/false or 1/0.`);
  };
  if (params.has('deploy')) config.deployId = normalizeDeployId(params.get('deploy'));
  if (params.has('php')) config.phpVersion = params.get('php');
  if (params.has('joomla')) config.joomlaVersion = params.get('joomla');
  if (params.has('jcb')) config.jcbVersion = normalizeJcbVersion(params.get('jcb'));
  if (params.has('name')) config.siteName = requireText(params.get('name'), 'Site name', 100);
  if (params.has('language')) config.language = normalizeLanguage(params.get('language'));
  if (params.has('login')) config.autoLogin = boolean('login');
  if (params.has('fresh')) config.fresh = boolean('fresh');
  if (params.has('path') || params.has('initialPath')) config.initialPath = normalizeInitialPath(params.get('path') ?? params.get('initialPath'));
  if (params.has('toolbar')) config.hideToolbar = !boolean('toolbar');
  if (params.has('hideToolbar')) config.hideToolbar = boolean('hideToolbar');
  if (params.has('persist')) config.persistence = boolean('persist');
  if (params.has('key')) {
    config.storageKey = params.get('key');
    if (!STORAGE_KEY.test(config.storageKey)) throw new TypeError('The saved-site key contains invalid characters.');
  }
  if (params.has('extensions')) config.extensions = parseUserExtensions(params.get('extensions'), location.href);
  if (params.has('extension')) config.extensions = parseUserExtensions([...(config.extensions ?? []), ...params.getAll('extension').map((value) => ({ url: value }))], location.href);
  if (params.has('commands') || params.has('startupCommands')) config.startupCommands = parseStartupCommands(params.get('commands') ?? params.get('startupCommands'));
  const deploymentOptions = ['name', 'deploy', 'php', 'joomla', 'jcb', 'language', 'login', 'fresh', 'extensions', 'extension', 'commands', 'startupCommands'];
  const document = params.has('config') ? parseExtensions([{ url: params.get('config'), ...(params.has('sha256') ? { sha256: params.get('sha256') } : {}) }], location.href, { allowHttp: false })[0] : null;
  return { config, autostart: params.has('start') ? boolean('start') : !!document || fragment.has('deploy') || deploymentOptions.some((name) => params.has(name)), ...(document ? { document } : {}) };
}

export function createShareURL(location, config) {
  const url = new URL(location);
  const document = createDeploymentDocument(config, { baseURL: url.href });
  config = document.configuration;
  url.search = '';
  url.hash = '';
  if (config.siteName && config.siteName !== DEFAULTS.siteName) url.searchParams.set('name', requireText(config.siteName, 'Site name', 100));
  if (config.deployId) url.searchParams.set('deploy', normalizeDeployId(config.deployId));
  if (config.joomlaVersion) url.searchParams.set('joomla', config.joomlaVersion);
  if (config.jcbVersion) url.searchParams.set('jcb', normalizeJcbVersion(config.jcbVersion));
  if (config.phpVersion) url.searchParams.set('php', config.phpVersion);
  if (config.initialPath && config.initialPath !== '/') url.searchParams.set('path', config.initialPath);
  if (config.hideToolbar) url.searchParams.set('toolbar', '0');
  if (config.persistence === false) url.searchParams.set('persist', '0');
  if (config.language && config.language !== 'en-GB') url.searchParams.set('language', normalizeLanguage(config.language));
  if (config.autoLogin === false) url.searchParams.set('login', 'no');
  if (config.fresh) url.searchParams.set('fresh', '1');
  if (config.extensions?.length) url.searchParams.set('extensions', JSON.stringify(parseExtensions(config.extensions, url.href)));
  if (config.startupCommands?.length) url.searchParams.set('commands', JSON.stringify(parseStartupCommands(config.startupCommands)));
  const advanced = config.deploymentRecipe || config.joomlaPackage || config.jcbPackage || config.template || config.menus?.length || config.languageTags?.length || config.multilingual || config.content || config.phpSettings;
  if (advanced) {
    url.search = '';
    url.searchParams.set('start', '1');
    url.hash = `deploy=${encodeDocument(document)}`;
  } else url.searchParams.set('start', '1');
  if (url.href.length > MAX_SHARE_URL_LENGTH) throw new RangeError('This deployment is too large for a reliable share link. Export the deployment JSON, or host it and share its configuration URL.');
  return url.href;
}

export const MAX_DEPLOYMENT_BYTES = 1_048_576;
export const MAX_SHARE_URL_LENGTH = 16_384;
const DEPLOYMENT_FIELDS = ['deployId', 'joomlaVersion', 'joomlaPackage', 'jcbVersion', 'jcbPackage', 'phpVersion', 'siteName', 'initialPath', 'language', 'languageTags', 'multilingual', 'autoLogin', 'hideToolbar', 'persistence', 'fresh', 'extensions', 'startupCommands', 'languages', 'menus', 'template', 'phpSettings', 'content'];
const PROVENANCE_FIELDS = ['sourceDeployId', 'addonExtensions', 'addonStartupCommands', 'addonLanguages', 'addonTemplate'];

function assertDocumentSize(value) {
  if (new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength > MAX_DEPLOYMENT_BYTES) throw new RangeError('Deployment JSON exceeds 1 MiB.');
}

function assertSafeData(value, depth = 0) {
  if (depth > 40) throw new TypeError('Deployment JSON is nested too deeply.');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError(`Deployment JSON contains invalid property ${key}.`);
    assertSafeData(item, depth + 1);
  }
}

function readDocument(input) {
  assertDocumentSize(input);
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new TypeError('Deployment JSON is invalid.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Use a deployment document with a configuration object.');
  assertSafeData(input);
  return input;
}

export function normalizeDeploymentRequirements(input = {}, { joomlaVersion = DEFAULTS.joomlaVersion } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Deployment requirements must be an object.');
  for (const key of Object.keys(input)) if (!['joomla', 'jcb', 'php', 'joomlaFallbacks'].includes(key)) throw new TypeError(`Deployment requirements contain unsupported property ${key}.`);
  const joomla = input.joomla ?? [String(joomlaVersion).split('.')[0]];
  if (!Array.isArray(joomla) || !joomla.length || joomla.length > 30 || joomla.some(major => typeof major !== 'string' || !/^[1-9]\d*$/.test(major) || Number(major) < 5)) throw new TypeError('Deployment Joomla support must list supported major versions.');
  if (input.jcb !== undefined && !['required', 'optional'].includes(input.jcb)) throw new TypeError('The JCB requirement must be required or optional.');
  if (input.php !== undefined && (!Array.isArray(input.php) || !input.php.length || input.php.length > 30 || input.php.some(version => typeof version !== 'string' || !/^\d+\.\d+$/.test(version)))) throw new TypeError('Deployment PHP support must list PHP runtime versions.');
  const fallbacks = input.joomlaFallbacks ?? {};
  if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(fallbacks)) throw new TypeError('Deployment Joomla fallbacks must be an object.');
  for (const [major, target] of Object.entries(fallbacks)) if (!/^[1-9]\d*$/.test(major) || Number(major) < 5 || !joomla.includes(target) || major === target) throw new TypeError('A deployment fallback must name a supported Joomla recipe major.');
  return { joomla: [...new Set(joomla)], jcb: input.jcb ?? 'optional', ...(input.php ? { php: [...new Set(input.php)] } : {}), ...(Object.keys(fallbacks).length ? { joomlaFallbacks: { ...fallbacks } } : {}) };
}

function assertPublic(value, path = 'configuration') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || /(?:password|passwd|secret|token|authorization|api[_-]?key|credentials)/i.test(key)) throw new TypeError(`Do not include secrets in a shared deployment (${path}.${key}).`);
    if (['url', 'initialPath'].includes(key) && typeof item === 'string') {
      const url = new URL(item, 'https://playground.invalid/');
      for (const name of url.searchParams.keys()) if (/(?:password|passwd|secret|token|authorization|api[_-]?key|signature)/i.test(name)) throw new TypeError('Shared package URLs must not contain private access credentials.');
    }
    if (['startupCommands', 'addonStartupCommands'].includes(key) && Array.isArray(item)) {
      for (const argv of item) for (const argument of argv.slice(1)) {
        const option = argument.split('=', 1)[0];
        if ((argument.startsWith('-') || argument.includes('=')) && /(?:password|passwd|secret|token|authorization|api[_-]?key|credentials)/i.test(option)) throw new TypeError('Do not include secrets in shared startup commands.');
      }
    }
    assertPublic(item, `${path}.${key}`);
  }
}

/** Public deployment instructions never contain a local site key or administrator. */
export function createDeploymentDocument(config, { baseURL = 'https://playground.joomengine.org/', includePrivate = false, name, requirements } = {}) {
  if (includePrivate) return createFullDeploymentDocument(config, { baseURL, name, requirements });
  const selected = Object.fromEntries(DEPLOYMENT_FIELDS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
  if (config.deploymentRecipe) {
    const full = createFullDeploymentDocument(config, { baseURL, name, requirements });
    delete full.configuration.admin;
    selected.deploymentRecipe = normalizeDeploymentRecipe(full, { baseURL, publicOnly: true });
    // The materialized recipe carries its complete arrays and provenance.
    for (const key of ['extensions', 'startupCommands', 'languages', 'template']) delete selected[key];
  }
  // Resolved packages from a named preset are not user-added instructions.
  if (!config.deploymentRecipe) {
    if (config.addonExtensions !== undefined) selected.extensions = config.addonExtensions;
    if (config.addonStartupCommands !== undefined) selected.startupCommands = config.addonStartupCommands;
    if (config.addonLanguages !== undefined) selected.languages = config.addonLanguages;
  }
  const configuration = parseDeploymentDocument({ schemaVersion: 1, configuration: selected }, { baseURL });
  assertPublic(configuration);
  const document = { schemaVersion: 1, configuration };
  assertDocumentSize(document);
  return document;
}

/** A saved recipe is complete and portable; private downloads may include its administrator. */
export function createFullDeploymentDocument(config, { name, requirements, baseURL = 'https://playground.joomengine.org/' } = {}) {
  const existing = config.deploymentRecipe ? normalizeDeploymentRecipe(config.deploymentRecipe, { baseURL }) : undefined;
  const merged = { ...existing?.configuration, ...config };
  const configuration = Object.fromEntries([...DEPLOYMENT_FIELDS, ...PROVENANCE_FIELDS, 'admin'].filter(key => merged[key] !== undefined).map(key => [key, merged[key]]));
  return normalizeDeploymentRecipe({ schemaVersion: 2,
    name: name ?? existing?.name ?? config.siteName ?? 'Custom deployment',
    requirements: requirements ?? existing?.requirements ?? { joomla: [String(config.joomlaVersion ?? DEFAULTS.joomlaVersion).split('.')[0]], jcb: 'optional' },
    configuration }, { baseURL });
}

export function normalizeDeploymentRecipe(input, { baseURL = 'https://playground.joomengine.org/', publicOnly = false } = {}) {
  input = readDocument(input);
  if (input.schemaVersion !== 2) throw new TypeError('A complete deployment recipe must use schemaVersion 2.');
  for (const key of Object.keys(input)) if (!['$schema', 'schemaVersion', 'name', 'requirements', 'configuration'].includes(key)) throw new TypeError(`Deployment document contains unsupported property ${key}.`);
  const name = requireText(input.name, 'Deployment name', 160);
  if (input.requirements === undefined) throw new TypeError('A complete deployment recipe must declare its requirements.');
  const requirements = normalizeDeploymentRequirements(input.requirements, { joomlaVersion: input.configuration?.joomlaVersion });
  const configuration = parseDocumentConfiguration(input.configuration, { baseURL, full: true, publicOnly });
  const result = { schemaVersion: 2, name, requirements, configuration };
  assertDocumentSize(result);
  return result;
}

export function parseDeploymentDocument(input, { baseURL = 'https://playground.joomengine.org/', publicOnly = false } = {}) {
  input = readDocument(input);
  if (input.schemaVersion === 2) {
    const deploymentRecipe = normalizeDeploymentRecipe(input, { baseURL, publicOnly });
    return { ...deploymentRecipe.configuration, deploymentRecipe };
  }
  if (input.schemaVersion !== 1) throw new TypeError('Use a deployment document with schemaVersion 1 or 2 and a configuration object.');
  for (const key of Object.keys(input)) if (!['$schema', 'schemaVersion', 'configuration'].includes(key)) throw new TypeError(`Deployment document contains unsupported property ${key}.`);
  return parseDocumentConfiguration(input.configuration, { baseURL, full: false, publicOnly: true });
}

function parseDocumentConfiguration(value, { baseURL, full, publicOnly }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Deployment configuration must be an object.');
  const allowed = [...DEPLOYMENT_FIELDS, ...(full ? [...PROVENANCE_FIELDS, ...(!publicOnly ? ['admin'] : [])] : ['deploymentRecipe'])];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Deployment configuration contains unsupported property ${key}.`);
  const result = {};
  for (const key of ['joomlaVersion', 'phpVersion']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !VERSION.test(value[key])) throw new TypeError(`Deployment ${key} is invalid.`);
    result[key] = value[key];
  }
  if (value.deployId !== undefined) result.deployId = normalizeDeployId(value.deployId);
  if (value.sourceDeployId !== undefined) result.sourceDeployId = normalizeDeployId(value.sourceDeployId);
  if (value.joomlaPackage !== undefined) result.joomlaPackage = normalizeJoomlaPackage(value.joomlaPackage, baseURL);
  if (value.jcbVersion !== undefined) result.jcbVersion = normalizeJcbVersion(value.jcbVersion);
  if (value.jcbPackage !== undefined) result.jcbPackage = normalizeJcbPackage(value.jcbPackage, baseURL);
  if (result.joomlaPackage && (!result.joomlaVersion || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(result.joomlaVersion))) throw new TypeError('A Joomla package requires an exact Joomla version.');
  if (result.jcbPackage && (!result.jcbVersion || result.jcbVersion === 'none')) throw new TypeError('A JCB package requires a selected JCB version.');
  if (value.siteName !== undefined) result.siteName = requireText(value.siteName, 'Site name', 100);
  if (value.initialPath !== undefined) result.initialPath = normalizeInitialPath(value.initialPath);
  if (value.language !== undefined) result.language = normalizeLanguage(value.language);
  if (value.languageTags !== undefined) result.languageTags = parseLanguageTags(value.languageTags);
  for (const key of ['autoLogin', 'hideToolbar', 'persistence', 'fresh', 'multilingual']) if (value[key] !== undefined) result[key] = requireBoolean(value[key], key);
  if (full) {
    result.addonExtensions = parseUserExtensions(value.addonExtensions ?? value.extensions ?? [], baseURL);
    const addonURLs = new Set(result.addonExtensions.map(entry => entry.url));
    result.extensions = parseJSONList(value.extensions ?? [], 'Extensions').map(entry => {
      const userEntry = parseUserExtensions([entry], baseURL)[0];
      // Imported provenance is only a claim. The resolver checks it against the
      // repository before using managed transport; malformed user hashes must
      // not prevent that classification or the ordinary Joomla installer.
      return addonURLs.has(userEntry.url) ? userEntry : { ...userEntry,
        ...(typeof entry.sha256 === 'string' && SHA256.test(entry.sha256) ? { sha256: entry.sha256.toLowerCase() } : {}),
        ...(typeof entry.sha512 === 'string' && SHA512.test(entry.sha512) ? { sha512: entry.sha512.toLowerCase() } : {}) };
    });
    if (result.extensions.length > 30) throw new TypeError('Choose at most 30 extension packages.');
    result.addonStartupCommands = parseStartupCommands(value.addonStartupCommands ?? value.startupCommands ?? []);
    if (value.addonTemplate !== undefined) result.addonTemplate = parseUserTemplate(value.addonTemplate, baseURL);
  } else if (value.extensions !== undefined) result.extensions = parseUserExtensions(value.extensions, baseURL);
  if (value.startupCommands !== undefined) result.startupCommands = parseStartupCommands(value.startupCommands);
  if (value.languages !== undefined) {
    if (!Array.isArray(value.languages) || value.languages.length > 30) throw new TypeError('Language packages must be an array of at most 30 entries.');
    result.languages = value.languages.map((entry) => ({ ...parseExtensions([entry], baseURL, { allowHttp: false })[0], tag: normalizeLanguage(entry.tag) }));
  }
  if (full) {
    const languages = value.addonLanguages ?? value.languages ?? [];
    if (!Array.isArray(languages) || languages.length > 30) throw new TypeError('Language packages must be an array of at most 30 entries.');
    result.addonLanguages = languages.map(entry => ({ ...parseExtensions([entry], baseURL, { allowHttp: false })[0], tag: normalizeLanguage(entry.tag) }));
    result.startupCommands ??= [];
    result.languages ??= [];
  }
  if (value.menus !== undefined) result.menus = parseMenus(value.menus);
  if (value.template !== undefined) {
    result.template = parseUserTemplate(value.template, baseURL);
    const template = typeof value.template === 'string' && value.template.trim() ? JSON.parse(value.template) : value.template;
    if (full && !value.addonTemplate && result.template?.url && typeof template?.sha256 === 'string' && SHA256.test(template.sha256)) result.template.sha256 = template.sha256.toLowerCase();
  }
  if (value.phpSettings !== undefined) result.phpSettings = normalizePhpSettings(value.phpSettings);
  if (value.content !== undefined) {
    // Detailed category/article validation occurs when resolving the selected deploy.
    if (!value.content || typeof value.content !== 'object' || Array.isArray(value.content)) throw new TypeError('Deployment content must be an object.');
    result.content = JSON.parse(JSON.stringify(value.content));
  }
  if (value.admin !== undefined) {
    if (!value.admin || typeof value.admin !== 'object' || Array.isArray(value.admin)) throw new TypeError('Deployment administrator must be an object.');
    for (const key of Object.keys(value.admin)) if (!['name', 'username', 'email', 'password'].includes(key)) throw new TypeError(`Deployment administrator contains unsupported property ${key}.`);
    result.admin = {};
    for (const [key, limit] of Object.entries({ name: 100, username: 100, email: 254, password: 128 })) if (value.admin[key] !== undefined) result.admin[key] = requireText(value.admin[key], `Administrator ${key}`, limit);
    if (result.admin.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.admin.email)) throw new TypeError('Enter a valid administrator email address.');
    if (result.admin.password !== undefined && result.admin.password.length < 12) throw new TypeError('Administrator password must contain at least 12 characters.');
  }
  if (!full && value.deploymentRecipe !== undefined) result.deploymentRecipe = normalizeDeploymentRecipe(value.deploymentRecipe, { baseURL, publicOnly: true });
  if (publicOnly) assertPublic(result);
  assertDocumentSize(result);
  return result;
}

function encodeDocument(document) {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  let data = '';
  for (const byte of bytes) data += String.fromCharCode(byte);
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeDocument(encoded) {
  if (!/^[a-zA-Z0-9_-]+$/.test(encoded) || encoded.length > MAX_SHARE_URL_LENGTH) throw new TypeError('The encoded deployment is invalid or too large.');
  try {
    const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
  } catch { throw new TypeError('The encoded deployment is invalid.'); }
}

/** Fetch public setup JSON when it is too large to place directly in a link. */
export async function loadDeploymentDocument(url, { sha256, fetcher = fetch, baseURL = 'https://playground.joomengine.org/' } = {}) {
  const source = parseExtensions([{ url, ...(sha256 ? { sha256 } : {}) }], baseURL, { allowHttp: false })[0];
  const response = await fetcher(source.url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Deployment configuration download failed: HTTP ${response.status}.`);
  if (Number(response.headers.get('Content-Length')) > MAX_DEPLOYMENT_BYTES) throw new RangeError('Deployment JSON exceeds 1 MiB.');
  const bytes = await readDeploymentBytes(response);
  if (source.sha256) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== source.sha256) throw new Error('Deployment configuration checksum does not match.');
  }
  return parseDeploymentDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { baseURL: source.url, publicOnly: true });
}

export function createDeploymentSourceURL(location, source) {
  const url = new URL(location); const item = parseExtensions([source], url.href, { allowHttp: false })[0];
  assertPublic(item);
  url.search = ''; url.hash = ''; url.searchParams.set('config', item.url);
  if (item.sha256) url.searchParams.set('sha256', item.sha256);
  url.searchParams.set('start', '1');
  return url.href;
}


export async function readDeploymentBytes(response) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DEPLOYMENT_BYTES) throw new RangeError('Deployment JSON exceeds 1 MiB.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DEPLOYMENT_BYTES) {
        await reader.cancel();
        throw new RangeError('Deployment JSON exceeds 1 MiB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
