import {
  DEFAULTS, normalizeBlueprintId, normalizeConfiguration, normalizeInitialPath,
  normalizeLanguage, parseExtensions, parseStartupCommands, resolveJoomlaVersion,
} from './config.mjs';
import { validateContent } from './joomla/index.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE_DIGEST = /^[a-f\d]{64}$/i;
const defaultCatalogURL = new URL('../blueprints/catalog.json', import.meta.url);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function text(value, name, maximum = 160, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must contain ${empty ? '0' : '1'}–${maximum} text characters.`);
  }
  return value;
}

function properties(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported property ${key}.`);
}

function packageEntry(value, baseURL, requireIntegrity) {
  object(value, 'Package');
  properties(value, ['url', 'sha256', 'sourceUrl', 'tag'], 'Package');
  const result = parseExtensions([value], baseURL)[0];
  if (requireIntegrity && !PACKAGE_DIGEST.test(result.sha256 ?? '')) throw new TypeError('Repository blueprint packages require a SHA-256 digest.');
  if (value.sourceUrl !== undefined) result.sourceUrl = parseExtensions([{ url: value.sourceUrl }], baseURL)[0].url;
  return result;
}

function languagePackages(value, baseURL, requireIntegrity) {
  if (!Array.isArray(value) || value.length > 30) throw new TypeError('A blueprint may list at most 30 language packages.');
  const seen = new Set();
  return value.map((entry) => {
    const tag = normalizeLanguage(text(entry?.tag, 'Language package tag', 20));
    if (seen.has(tag)) throw new TypeError(`Duplicate language package: ${tag}.`);
    seen.add(tag);
    return { ...packageEntry(entry, baseURL, requireIntegrity), tag };
  });
}

function normalizeSnapshot(value, baseURL) {
  object(value, 'Snapshot');
  properties(value, ['url', 'sha256', 'sourceUrl', 'format', 'schemaVersion', 'joomlaVersion'], 'Snapshot');
  if (value.format !== 'joomengine-playground-export' || value.schemaVersion !== 1 || !VERSION.test(value.joomlaVersion)) {
    throw new TypeError('A snapshot must declare export format, schema version 1 and an exact Joomla version.');
  }
  const { url, sha256, sourceUrl } = value;
  return { ...packageEntry({ url, sha256, ...(sourceUrl ? { sourceUrl } : {}) }, baseURL, true),
    format: value.format, schemaVersion: value.schemaVersion, joomlaVersion: value.joomlaVersion };
}

function normalizeContent(value) {
  object(value, 'Blueprint content');
  properties(value, ['multilingual', 'categories', 'articles'], 'Blueprint content');
  if (value.multilingual !== undefined && typeof value.multilingual !== 'boolean') throw new TypeError('multilingual must be true or false.');
  if (!Array.isArray(value.categories) || value.categories.length > 50 || !Array.isArray(value.articles) || value.articles.length > 50) {
    throw new TypeError('Blueprint content requires categories and articles arrays of at most 50 entries.');
  }
  const keys = new Set();
  const categories = value.categories.map((entry) => {
    object(entry, 'Category');
    properties(entry, ['key', 'title', 'alias', 'language'], 'Category');
    const key = normalizeBlueprintId(entry.key);
    if (keys.has(key)) throw new TypeError(`Duplicate category key: ${key}.`);
    keys.add(key);
    return { key, title: text(entry.title, 'Category title'), alias: normalizeBlueprintId(entry.alias), language: normalizeLanguage(text(entry.language, 'Category language', 20)) };
  });
  const articleKeys = new Set();
  const articles = value.articles.map((entry) => {
    object(entry, 'Article');
    properties(entry, ['key', 'title', 'alias', 'language', 'category', 'introtext', 'fulltext', 'featured', 'home'], 'Article');
    const key = normalizeBlueprintId(entry.key);
    if (articleKeys.has(key)) throw new TypeError(`Duplicate article key: ${key}.`);
    articleKeys.add(key);
    if (!keys.has(entry.category)) throw new TypeError(`Unknown article category: ${entry.category}.`);
    const result = { key, title: text(entry.title, 'Article title'), alias: normalizeBlueprintId(entry.alias),
      language: normalizeLanguage(text(entry.language, 'Article language', 20)), category: entry.category };
    for (const field of ['introtext', 'fulltext']) {
      if (field === 'introtext' || entry[field] !== undefined) {
        if (typeof entry[field] !== 'string' || entry[field].length > 32_768 || entry[field].includes('\0')) throw new TypeError(`Article ${field} must be text of at most 32768 characters.`);
        result[field] = entry[field];
      }
    }
    for (const field of ['featured', 'home']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'boolean') throw new TypeError(`Article ${field} must be true or false.`);
      if (entry[field] !== undefined) result[field] = entry[field];
    }
    return result;
  });
  return validateContent({ multilingual: value.multilingual ?? false, categories, articles });
}

function normalizeSetup(value = {}, baseURL, requireIntegrity) {
  object(value, 'Blueprint configuration');
  properties(value, ['siteName', 'initialPath', 'joomlaVersion', 'phpVersion', 'language', 'autoLogin', 'hideToolbar', 'persistence', 'extensions', 'startupCommands', 'languages', 'content', 'snapshot'], 'Blueprint configuration');
  const result = {};
  if (value.siteName !== undefined) result.siteName = text(value.siteName, 'Site name', 100);
  if (value.initialPath !== undefined) result.initialPath = normalizeInitialPath(value.initialPath);
  for (const name of ['joomlaVersion', 'phpVersion']) {
    if (value[name] !== undefined) {
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(value[name])) throw new TypeError(`Blueprint ${name} is invalid.`);
      result[name] = value[name];
    }
  }
  if (value.language !== undefined) result.language = normalizeLanguage(value.language);
  for (const name of ['autoLogin', 'hideToolbar', 'persistence']) {
    if (value[name] !== undefined) {
      if (typeof value[name] !== 'boolean') throw new TypeError(`${name} must be true or false.`);
      result[name] = value[name];
    }
  }
  if (!Array.isArray(value.extensions ?? []) || (value.extensions ?? []).length > 30) throw new TypeError('A blueprint may list at most 30 extension packages.');
  result.extensions = (value.extensions ?? []).map((entry) => packageEntry(entry, baseURL, requireIntegrity));
  result.languages = languagePackages(value.languages ?? [], baseURL, requireIntegrity);
  result.startupCommands = parseStartupCommands(value.startupCommands ?? []);
  if (value.content !== undefined) result.content = normalizeContent(value.content);
  if (value.snapshot !== undefined) result.snapshot = normalizeSnapshot(value.snapshot, baseURL);
  return result;
}

export function normalizeBlueprintCatalog(value, { baseURL = defaultCatalogURL.href, requireIntegrity = true } = {}) {
  object(value, 'Blueprint catalog');
  properties(value, ['$schema', 'schemaVersion', 'default', 'blueprints', 'languages'], 'Blueprint catalog');
  if (value.schemaVersion !== 1 || !Array.isArray(value.blueprints) || !value.blueprints.length || value.blueprints.length > 100) throw new TypeError('The blueprint catalog must use schema version 1 and list 1–100 blueprints.');
  const seen = new Set();
  const blueprints = value.blueprints.map((entry) => {
    object(entry, 'Blueprint entry');
    properties(entry, ['id', 'title', 'description', 'file'], 'Blueprint entry');
    const id = normalizeBlueprintId(entry.id);
    if (entry.id !== id || seen.has(id)) throw new TypeError(`Invalid or duplicate blueprint ID: ${entry.id}.`);
    seen.add(id);
    if (entry.file !== `./${id}.json`) throw new TypeError(`Blueprint ${id} must use ./${id}.json.`);
    return { id, title: text(entry.title, 'Blueprint title'), description: text(entry.description ?? '', 'Blueprint description', 1000, true), file: entry.file, url: new URL(entry.file, baseURL).href };
  });
  const defaultId = normalizeBlueprintId(value.default);
  if (!seen.has(defaultId)) throw new TypeError('The default blueprint is missing from the catalog.');
  const languages = {};
  for (const [major, entries] of Object.entries(object(value.languages ?? {}, 'Language catalog'))) {
    if (!['5', '6'].includes(major)) throw new TypeError(`Unsupported language catalog Joomla major: ${major}.`);
    languages[major] = languagePackages(entries, baseURL, requireIntegrity);
  }
  return { schemaVersion: 1, default: defaultId, blueprints, languages, url: new URL(baseURL).href };
}

export function normalizeBlueprint(value, { baseURL = defaultCatalogURL.href, requireIntegrity = true } = {}) {
  object(value, 'Blueprint');
  properties(value, ['$schema', 'schemaVersion', 'id', 'title', 'description', 'joomla', 'configuration', 'variants', 'snapshot', 'prebuild'], 'Blueprint');
  const id = normalizeBlueprintId(value.id);
  if (value.schemaVersion !== 1 || id !== value.id) throw new TypeError('A blueprint must declare schema version 1 and a valid ID.');
  if (!Array.isArray(value.joomla) || !value.joomla.length || value.joomla.some((major) => !['5', '6'].includes(major)) || new Set(value.joomla).size !== value.joomla.length) {
    throw new TypeError('Blueprint Joomla support must list distinct supported major versions.');
  }
  const variants = {};
  if (value.prebuild !== undefined && typeof value.prebuild !== 'boolean') throw new TypeError('Blueprint prebuild must be true or false.');
  for (const [major, setup] of Object.entries(object(value.variants ?? {}, 'Blueprint variants'))) {
    if (!value.joomla.includes(major)) throw new TypeError(`Variant Joomla ${major} is not declared by the blueprint.`);
    variants[major] = normalizeSetup(setup, baseURL, requireIntegrity);
    if (variants[major].joomlaVersion && !variants[major].joomlaVersion.startsWith(`${major}.`)) throw new TypeError(`Variant Joomla ${major} cannot select another major version.`);
  }
  return { schemaVersion: 1, id, title: text(value.title, 'Blueprint title'), description: text(value.description ?? '', 'Blueprint description', 1000, true),
    joomla: [...value.joomla], prebuild: value.prebuild ?? false, configuration: normalizeSetup(value.configuration, baseURL, requireIntegrity), variants,
    ...(value.snapshot ? { snapshot: normalizeSnapshot(value.snapshot, baseURL) } : {}) };
}

async function fetchJSON(url, fetcher) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Cannot load blueprint configuration: HTTP ${response.status} (${url}).`);
  const source = await response.text();
  if (source.length > 1_048_576) throw new Error('Blueprint configuration exceeds 1 MiB.');
  try { return JSON.parse(source); } catch { throw new Error(`Invalid blueprint JSON: ${url}.`); }
}

export async function loadBlueprintCatalog({ url = defaultCatalogURL, fetcher = fetch } = {}) {
  const href = new URL(url, defaultCatalogURL).href;
  return normalizeBlueprintCatalog(await fetchJSON(href, fetcher), { baseURL: href });
}

function uniquePackages(entries) {
  const result = new Map();
  for (const entry of entries) {
    const existing = result.get(entry.url);
    if (existing && existing.sha256 !== entry.sha256) throw new TypeError(`Conflicting checksums for package ${entry.url}.`);
    result.set(entry.url, entry);
  }
  return [...result.values()];
}

/** Resolve repository recipe defaults followed by explicit caller settings. */
export async function resolveBlueprintConfiguration(input = {}, {
  catalog, blueprintCatalog, baseURL = globalThis.location?.href ?? 'https://playground.joomengine.org/', fetcher = fetch,
} = {}) {
  if (!catalog) throw new TypeError('A verified runtime catalog is required to resolve a blueprint.');
  const registry = blueprintCatalog ?? await loadBlueprintCatalog({ fetcher });
  const id = normalizeBlueprintId(input.blueprintId ?? registry.default);
  const descriptor = registry.blueprints.find((entry) => entry.id === id);
  if (!descriptor) throw new TypeError(`Unknown blueprint: ${id}.`);
  const manifestURL = descriptor.url ?? new URL(descriptor.file, registry.url ?? defaultCatalogURL).href;
  const blueprint = normalizeBlueprint(await fetchJSON(manifestURL, fetcher), { baseURL: manifestURL });
  if (blueprint.id !== id) throw new TypeError(`Blueprint manifest ID does not match ${id}.`);
  let release = resolveJoomlaVersion(input.joomlaVersion ?? blueprint.configuration.joomlaVersion ?? catalog.defaults.joomlaVersion, catalog);
  const major = release.split('.')[0];
  if (!blueprint.joomla.includes(major)) throw new TypeError(`${blueprint.title} is not available for Joomla ${major}.`);
  const common = blueprint.configuration;
  const variant = blueprint.variants[major] ?? {};
  if (input.joomlaVersion === undefined && variant.joomlaVersion !== undefined) release = resolveJoomlaVersion(variant.joomlaVersion, catalog);
  const overrides = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const setup = { ...common, ...variant, ...overrides, blueprintId: id, joomlaVersion: release };
  if (setup.content) setup.content = normalizeContent(setup.content);
  setup.addonExtensions = parseExtensions(input.extensions ?? [], baseURL);
  setup.addonStartupCommands = parseStartupCommands(input.startupCommands ?? []);
  setup.addonLanguages = languagePackages(input.languages ?? [], baseURL, true);
  setup.extensions = uniquePackages([...common.extensions, ...(variant.extensions ?? []), ...setup.addonExtensions]);
  setup.startupCommands = [...common.startupCommands, ...(variant.startupCommands ?? []), ...setup.addonStartupCommands];
  setup.languages = [...common.languages, ...(variant.languages ?? []), ...setup.addonLanguages];
  const requiredLanguages = new Set([setup.language ?? DEFAULTS.language,
    ...(setup.content?.categories ?? []).map((entry) => entry.language), ...(setup.content?.articles ?? []).map((entry) => entry.language)]);
  for (const tag of requiredLanguages) {
    if (tag === 'en-GB' || setup.languages.some((entry) => entry.tag === tag)) continue;
    const language = registry.languages?.[major]?.find((entry) => entry.tag === tag);
    if (!language) throw new TypeError(`No pinned ${tag} language package is configured for Joomla ${major}.`);
    setup.languages.push(language);
  }
  const languages = new Map();
  for (const language of setup.languages) {
    const previous = languages.get(language.tag);
    if (previous && (previous.url !== language.url || previous.sha256 !== language.sha256)) throw new TypeError(`Conflicting language packages for ${language.tag}.`);
    languages.set(language.tag, language);
  }
  setup.languages = [...languages.values()];
  const snapshot = variant.snapshot ?? common.snapshot ?? blueprint.snapshot;
  delete setup.snapshot;
  if (!setup.fresh && input.content === undefined && snapshot?.joomlaVersion === release) setup.snapshot = snapshot;
  const configuration = normalizeConfiguration(setup, { catalog, baseURL });
  return { configuration, blueprint };
}
