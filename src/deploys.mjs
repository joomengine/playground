import { normalizePhpSettings } from './php-settings.mjs';
import {
  DEFAULTS, normalizeDeployId, normalizeConfiguration, normalizeInitialPath,
  normalizeLanguage, normalizeJcbVersion, normalizeJcbPackage, catalogWithSelectedJoomlaPackage, parseExtensions, parseUserExtensions, parseUserTemplate, normalizeDeploymentRecipe, parseStartupCommands, resolveJoomlaVersion, parseMenus, parseTemplate, parseLanguageTags, readDeploymentBytes,
} from './config.mjs';
import { validateContent } from './joomla/index.mjs';
import { deploymentRecipeMajor, deploymentRequiresJcb, deploymentPhpVersions } from './deployment-compatibility.mjs';
import { pinnedJcbPackages } from './jcb-selection.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE_DIGEST = /^[a-f\d]{64}$/i;
const defaultCatalogURL = new URL('../deploys/catalog.json', import.meta.url);

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

function normalizeRequirements(value = {}, supported = []) {
  object(value, 'Deployment requirements');
  properties(value, ['jcb', 'php', 'joomlaFallbacks'], 'Deployment requirements');
  if (value.jcb !== undefined && !['required', 'optional'].includes(value.jcb)) throw new TypeError('The JCB requirement must be required or optional.');
  if (value.php !== undefined && (!Array.isArray(value.php) || !value.php.length || value.php.some(version => !/^\d+\.\d+$/.test(version)))) throw new TypeError('Deployment PHP support must list PHP runtime versions.');
  const fallbacks = object(value.joomlaFallbacks ?? {}, 'Deployment Joomla fallbacks');
  for (const [major, fallback] of Object.entries(fallbacks)) {
    if (!/^[1-9]\d*$/.test(major) || !supported.includes(fallback) || major === fallback) throw new TypeError('A deployment fallback must name a supported Joomla recipe major.');
  }
  return { jcb: value.jcb ?? 'optional', ...(value.php ? { php: [...new Set(value.php)] } : {}),
    ...(Object.keys(fallbacks).length ? { joomlaFallbacks: { ...fallbacks } } : {}) };
}

function packageEntry(value, baseURL, requireIntegrity, allowHttp = true) {
  object(value, 'Package');
  properties(value, ['url', 'sha256', 'sha512', 'sourceUrl', 'tag'], 'Package');
  const result = parseExtensions([value], baseURL, { allowHttp })[0];
  if (requireIntegrity && !PACKAGE_DIGEST.test(result.sha256 ?? '')) throw new TypeError('Repository deploy packages require a SHA-256 digest.');
  if (value.sourceUrl !== undefined) result.sourceUrl = parseExtensions([{ url: value.sourceUrl }], baseURL, { allowHttp })[0].url;
  return result;
}

function languagePackages(value, baseURL, requireIntegrity) {
  if (!Array.isArray(value) || value.length > 30) throw new TypeError('A deploy may list at most 30 language packages.');
  const seen = new Set();
  return value.map((entry) => {
    const tag = normalizeLanguage(text(entry?.tag, 'Language package tag', 20));
    if (seen.has(tag)) throw new TypeError(`Duplicate language package: ${tag}.`);
    seen.add(tag);
    return { ...packageEntry(entry, baseURL, requireIntegrity, false), tag };
  });
}

function normalizeSnapshot(value, baseURL) {
  object(value, 'Snapshot');
  properties(value, ['url', 'sha256', 'sourceUrl', 'format', 'schemaVersion', 'joomlaVersion'], 'Snapshot');
  if (value.format !== 'joomengine-playground-export' || value.schemaVersion !== 1 || !VERSION.test(value.joomlaVersion)) {
    throw new TypeError('A snapshot must declare export format, schema version 1 and an exact Joomla version.');
  }
  const { url, sha256, sourceUrl } = value;
  return { ...packageEntry({ url, sha256, ...(sourceUrl ? { sourceUrl } : {}) }, baseURL, true, false),
    format: value.format, schemaVersion: value.schemaVersion, joomlaVersion: value.joomlaVersion };
}

function normalizeContent(value) {
  object(value, 'Deploy content');
  properties(value, ['multilingual', 'categories', 'articles'], 'Deploy content');
  if (value.multilingual !== undefined && typeof value.multilingual !== 'boolean') throw new TypeError('multilingual must be true or false.');
  if (!Array.isArray(value.categories) || value.categories.length > 50 || !Array.isArray(value.articles) || value.articles.length > 50) {
    throw new TypeError('Deploy content requires categories and articles arrays of at most 50 entries.');
  }
  const keys = new Set();
  const categories = value.categories.map((entry) => {
    object(entry, 'Category');
    properties(entry, ['key', 'title', 'alias', 'language'], 'Category');
    const key = normalizeDeployId(entry.key);
    if (keys.has(key)) throw new TypeError(`Duplicate category key: ${key}.`);
    keys.add(key);
    return { key, title: text(entry.title, 'Category title'), alias: normalizeDeployId(entry.alias), language: normalizeLanguage(text(entry.language, 'Category language', 20)) };
  });
  const articleKeys = new Set();
  const articles = value.articles.map((entry) => {
    object(entry, 'Article');
    properties(entry, ['key', 'title', 'alias', 'language', 'category', 'introtext', 'fulltext', 'featured', 'home'], 'Article');
    const key = normalizeDeployId(entry.key);
    if (articleKeys.has(key)) throw new TypeError(`Duplicate article key: ${key}.`);
    articleKeys.add(key);
    if (!keys.has(entry.category)) throw new TypeError(`Unknown article category: ${entry.category}.`);
    const result = { key, title: text(entry.title, 'Article title'), alias: normalizeDeployId(entry.alias),
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
  object(value, 'Deploy configuration');
  properties(value, ['siteName', 'initialPath', 'joomlaVersion', 'phpVersion', 'language', 'autoLogin', 'hideToolbar', 'persistence', 'extensions', 'startupCommands', 'languages', 'languageTags', 'multilingual', 'menus', 'template', 'phpSettings', 'content', 'snapshot'], 'Deploy configuration');
  const result = {};
  if (value.siteName !== undefined) result.siteName = text(value.siteName, 'Site name', 100);
  if (value.initialPath !== undefined) result.initialPath = normalizeInitialPath(value.initialPath);
  for (const name of ['joomlaVersion', 'phpVersion']) {
    if (value[name] !== undefined) {
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(value[name])) throw new TypeError(`Deploy ${name} is invalid.`);
      result[name] = value[name];
    }
  }
  if (value.language !== undefined) result.language = normalizeLanguage(value.language);
  for (const name of ['autoLogin', 'hideToolbar', 'persistence', 'multilingual']) {
    if (value[name] !== undefined) {
      if (typeof value[name] !== 'boolean') throw new TypeError(`${name} must be true or false.`);
      result[name] = value[name];
    }
  }
  if (!Array.isArray(value.extensions ?? []) || (value.extensions ?? []).length > 30) throw new TypeError('A deploy may list at most 30 extension packages.');
  result.extensions = (value.extensions ?? []).map((entry) => packageEntry(entry, baseURL, requireIntegrity));
  result.languages = languagePackages(value.languages ?? [], baseURL, requireIntegrity);
  result.startupCommands = parseStartupCommands(value.startupCommands ?? []);
  if (value.languageTags !== undefined) result.languageTags = parseLanguageTags(value.languageTags);
  if (value.menus !== undefined) result.menus = parseMenus(value.menus);
  if (value.template !== undefined) result.template = parseTemplate(value.template, baseURL);
  if (value.phpSettings !== undefined) result.phpSettings = normalizePhpSettings(value.phpSettings);
  if (value.content !== undefined) result.content = normalizeContent(value.content);
  if (value.snapshot !== undefined) result.snapshot = normalizeSnapshot(value.snapshot, baseURL);
  return result;
}

export function normalizeDeployCatalog(value, { baseURL = defaultCatalogURL.href, requireIntegrity = true } = {}) {
  object(value, 'Deploy catalog');
  properties(value, ['$schema', 'schemaVersion', 'default', 'defaultsByJoomla', 'deploys', 'languages'], 'Deploy catalog');
  if (value.schemaVersion !== 1 || !Array.isArray(value.deploys) || !value.deploys.length || value.deploys.length > 100) throw new TypeError('The deploy catalog must use schema version 1 and list 1–100 deploys.');
  const seen = new Set();
  const deploys = value.deploys.map((entry) => {
    object(entry, 'Deploy entry');
    properties(entry, ['id', 'title', 'description', 'file', 'joomla', 'requirements'], 'Deploy entry');
    const id = normalizeDeployId(entry.id);
    if (entry.id !== id || seen.has(id)) throw new TypeError(`Invalid or duplicate deploy ID: ${entry.id}.`);
    seen.add(id);
    if (entry.file !== `./${id}.json`) throw new TypeError(`Deploy ${id} must use ./${id}.json.`);
    if (entry.joomla !== undefined && (!Array.isArray(entry.joomla) || !entry.joomla.length || entry.joomla.some((major) => !['5', '6'].includes(major)))) throw new TypeError('Deploy catalog Joomla support must list supported major versions.');
    return { id, ...(entry.joomla ? { joomla: [...new Set(entry.joomla)] } : {}), requirements: normalizeRequirements(entry.requirements, entry.joomla), title: text(entry.title, 'Deploy title'), description: text(entry.description ?? '', 'Deploy description', 1000, true), file: entry.file, url: new URL(entry.file, baseURL).href };
  });
  const defaultId = normalizeDeployId(value.default);
  if (!seen.has(defaultId)) throw new TypeError('The default deploy is missing from the catalog.');
  const defaultsByJoomla = {};
  for (const [major, id] of Object.entries(object(value.defaultsByJoomla ?? {}, 'Joomla deployment defaults'))) {
    if (!['5', '6'].includes(major) || !seen.has(id)) throw new TypeError('Joomla deployment defaults must select an existing deploy.');
    const descriptor = deploys.find((entry) => entry.id === id);
    if (descriptor.joomla && !descriptor.joomla.includes(major)) throw new TypeError('A Joomla default must select a compatible deploy.');
    defaultsByJoomla[major] = id;
  }
  const languages = {};
  for (const [major, entries] of Object.entries(object(value.languages ?? {}, 'Language catalog'))) {
    if (!['5', '6'].includes(major)) throw new TypeError(`Unsupported language catalog Joomla major: ${major}.`);
    languages[major] = languagePackages(entries, baseURL, requireIntegrity);
  }
  return { schemaVersion: 1, default: defaultId, defaultsByJoomla, deploys, languages, url: new URL(baseURL).href };
}

export function normalizeDeploy(value, { baseURL = defaultCatalogURL.href, requireIntegrity = true } = {}) {
  object(value, 'Deploy');
  properties(value, ['$schema', 'schemaVersion', 'id', 'title', 'description', 'joomla', 'configuration', 'variants', 'snapshot', 'prebuild', 'requirements'], 'Deploy');
  const id = normalizeDeployId(value.id);
  if (value.schemaVersion !== 1 || id !== value.id) throw new TypeError('A deploy must declare schema version 1 and a valid ID.');
  if (!Array.isArray(value.joomla) || !value.joomla.length || value.joomla.some((major) => !['5', '6'].includes(major)) || new Set(value.joomla).size !== value.joomla.length) {
    throw new TypeError('Deploy Joomla support must list distinct supported major versions.');
  }
  const variants = {};
  if (value.prebuild !== undefined && typeof value.prebuild !== 'boolean') throw new TypeError('Deploy prebuild must be true or false.');
  for (const [major, setup] of Object.entries(object(value.variants ?? {}, 'Deploy variants'))) {
    if (!value.joomla.includes(major)) throw new TypeError(`Variant Joomla ${major} is not declared by the deploy.`);
    variants[major] = normalizeSetup(setup, baseURL, requireIntegrity);
    if (variants[major].joomlaVersion && !variants[major].joomlaVersion.startsWith(`${major}.`)) throw new TypeError(`Variant Joomla ${major} cannot select another major version.`);
  }
  return { schemaVersion: 1, id, title: text(value.title, 'Deploy title'), description: text(value.description ?? '', 'Deploy description', 1000, true),
    joomla: [...value.joomla], requirements: normalizeRequirements(value.requirements, value.joomla), prebuild: value.prebuild ?? false, configuration: normalizeSetup(value.configuration, baseURL, requireIntegrity), variants,
    ...(value.snapshot ? { snapshot: normalizeSnapshot(value.snapshot, baseURL) } : {}) };
}

async function fetchJSON(url, fetcher) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Cannot load deploy configuration: HTTP ${response.status} (${url}).`);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(await readDeploymentBytes(response));
  try { return JSON.parse(source); } catch { throw new Error(`Invalid deploy JSON: ${url}.`); }
}

export async function loadDeployCatalog({ url = defaultCatalogURL, fetcher = fetch } = {}) {
  const href = new URL(url, defaultCatalogURL).href;
  return normalizeDeployCatalog(await fetchJSON(href, fetcher), { baseURL: href });
}

function uniquePackages(entries) {
  const result = new Map();
  for (const entry of entries) {
    const existing = result.get(entry.url);
    if (existing && (existing.sha256 !== entry.sha256 || existing.sha512 !== entry.sha512)) throw new TypeError(`Conflicting checksums for package ${entry.url}.`);
    result.set(entry.url, entry);
  }
  return [...result.values()];
}

// Prepared recipes may reference a same-origin staged package. sourceUrl retains
// its upstream identity even when the staged archive has a different checksum.
function jcbRecipeVersion(entry) {
  const source = entry.sourceUrl || entry.url;
  const match = /\/(?:joomengine\/)?pkg-component-builder\/(?:archive\/refs\/tags\/|zip\/refs\/tags\/)?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\.zip)?(?:$|[?#])/i.exec(source);
  return match?.[1]?.replace(/\.zip$/i, '') ?? null;
}

async function sharedJcbPackages(registry, fetcher) {
  const descriptor = registry.deploys.find(entry => entry.id === 'jcb');
  if (!descriptor) return new Map();
  const url = descriptor.url ?? new URL(descriptor.file, registry.url ?? defaultCatalogURL).href;
  return pinnedJcbPackages(normalizeDeploy(await fetchJSON(url, fetcher), { baseURL: url }));
}

function samePackage(left, right) {
  return left?.url === right?.url && left?.sha256 === right?.sha256 && left?.sha512 === right?.sha512;
}

/** A saved clone is a complete recipe. Its editable lists replace the previous
 * lists; they are never appended to a hidden repository preset. */
async function resolveMaterializedDeployment(input, { catalog, deployCatalog, baseURL, fetcher }) {
  const document = normalizeDeploymentRecipe(input.deploymentRecipe, { baseURL });
  const source = document.configuration;
  const overrides = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'deploymentRecipe' && value !== undefined));
  const setup = { ...source, ...overrides };
  delete setup.snapshot;
  catalog = catalogWithSelectedJoomlaPackage(catalog, setup, baseURL);
  setup.joomlaVersion = resolveJoomlaVersion(setup.joomlaVersion ?? catalog.defaults.joomlaVersion, catalog);
  const deploy = { id: setup.deployId ?? 'custom', title: document.name, description: '',
    joomla: document.requirements.joomla, requirements: document.requirements, configuration: { ...source, initialPath: setup.initialPath }, variants: {} };
  const recipeMajor = deploymentRecipeMajor(deploy, setup.joomlaVersion);
  if (!recipeMajor) throw new TypeError(`${deploy.title} is not available for Joomla ${setup.joomlaVersion.split('.')[0]}.`);
  const php = deploymentPhpVersions(deploy, catalog.joomla.find(entry => entry.version === setup.joomlaVersion));
  if (!php.length || (setup.phpVersion !== undefined && !php.includes(setup.phpVersion))) throw new TypeError(`${deploy.title} does not support the selected PHP and Joomla combination.`);
  setup.phpVersion ??= php.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : php[0];
  setup.deployId = deploy.id;
  setup.sourceDeployId = source.sourceDeployId ?? source.deployId;
  const registry = deployCatalog ?? await loadDeployCatalog({ fetcher });
  // Imported provenance is a claim, not authority to stage arbitrary packages.
  // Only bytes matching the host's reviewed source recipe remain managed.
  let reviewed = { extensions: [] };
  let reviewedTarget = reviewed;
  let sourceMajor;
  const variantReplacements = [];
  const sourceDescriptor = registry.deploys.find(entry => entry.id === setup.sourceDeployId);
  if (sourceDescriptor) {
    const url = sourceDescriptor.url ?? new URL(sourceDescriptor.file, registry.url ?? defaultCatalogURL).href;
    const sourceDeploy = normalizeDeploy(await fetchJSON(url, fetcher), { baseURL: url });
    sourceMajor = deploymentRecipeMajor(sourceDeploy, source.joomlaVersion ?? setup.joomlaVersion);
    const variant = sourceMajor ? sourceDeploy.variants[sourceMajor] ?? {} : {};
    reviewed = { ...sourceDeploy.configuration, ...variant,
      extensions: [...sourceDeploy.configuration.extensions, ...(variant.extensions ?? [])] };
    const targetMajor = deploymentRecipeMajor(sourceDeploy, setup.joomlaVersion);
    const targetVariant = targetMajor ? sourceDeploy.variants[targetMajor] ?? {} : {};
    reviewedTarget = { ...sourceDeploy.configuration, ...targetVariant,
      extensions: [...sourceDeploy.configuration.extensions, ...(targetVariant.extensions ?? [])] };
    // Core variant arrays describe the same installation steps for each major.
    // Remap only unchanged, reviewed entries; edited URLs remain user additions.
    if (sourceMajor !== targetMajor && variant.extensions?.length === targetVariant.extensions?.length) {
      for (const [index, from] of (variant.extensions ?? []).entries()) variantReplacements.push({ from, to: targetVariant.extensions[index] });
    }
  }
  const originalAddons = new Set((source.addonExtensions ?? []).map(entry => entry.url));
  const managed = (source.extensions ?? []).filter(entry => !originalAddons.has(entry.url)
    && (reviewed.extensions.some(item => samePackage(item, entry)) || samePackage(source.jcbPackage, entry)));
  const supplied = setup.extensions ?? [];
  const urls = parseUserExtensions(supplied, baseURL);
  const raw = Array.isArray(supplied) ? supplied : (() => { try { return JSON.parse(supplied); } catch { return []; } })();
  setup.extensions = urls.map((entry, index) => {
    const unchanged = managed.find(candidate => samePackage(candidate, { ...raw[index], url: entry.url }));
    const replacement = unchanged && variantReplacements.find(item => samePackage(item.from, unchanged));
    return unchanged ? { ...(replacement?.to ?? unchanged) } : entry;
  });
  const unchangedManaged = setup.extensions.filter(entry => managed.some(candidate => samePackage(candidate, entry))
    || variantReplacements.some(item => samePackage(item.to, entry)));
  const major = setup.joomlaVersion.split('.')[0];
  const requestedJcb = setup.jcbVersion ?? source.jcbVersion;
  if (requestedJcb !== undefined || deploymentRequiresJcb(deploy)) {
    const pinned = await sharedJcbPackages(registry, fetcher);
    const existingJcb = unchangedManaged.filter(entry => jcbRecipeVersion(entry)
      || samePackage(entry, source.jcbPackage) || [...pinned.values()].some(item => samePackage(item.package, entry)));
    const fallback = pinned.get(major) ?? (major === '7' ? pinned.get('6') : undefined);
    const version = normalizeJcbVersion(requestedJcb ?? fallback?.version ?? 'none');
    if (version === 'none' && deploymentRequiresJcb(deploy)) throw new TypeError(`${deploy.title} requires Joomla Component Builder. Choose a compatible JCB version.`);
    const jcbMajor = version.split('.')[0];
    if (version !== 'none' && jcbMajor !== major && !(major === '7' && jcbMajor === '6')) throw new TypeError(`JCB ${version} is not a selectable package for Joomla ${major}.`);
    let selected;
    if (version !== 'none') {
      const explicit = input.jcbPackage ?? (version === source.jcbVersion ? source.jcbPackage : undefined);
      selected = explicit ? normalizeJcbPackage(explicit, baseURL)
        : [...pinned.values()].find(entry => entry.version === version)?.package;
      if (!selected) throw new TypeError(`The selected JCB ${version} package is unavailable.`);
    }
    setup.extensions = setup.extensions.filter(entry => !existingJcb.some(item => samePackage(item, entry)));
    if (selected) { setup.extensions.unshift(selected); unchangedManaged.push(selected); }
    setup.jcbVersion = version;
    if (selected) setup.jcbPackage = selected;
    else delete setup.jcbPackage;
  }
  setup.extensions = uniquePackages(setup.extensions);
  setup.addonExtensions = setup.extensions.filter(entry => !unchangedManaged.some(item => samePackage(item, entry)));
  const originalTemplate = source.template;
  const unchangedTemplate = setup.template?.url && !source.addonTemplate && samePackage(setup.template, originalTemplate) && samePackage(setup.template, reviewed.template);
  const template = unchangedTemplate && reviewedTarget.template ? reviewedTarget.template : setup.template;
  const managedTemplate = unchangedTemplate && samePackage(template, reviewedTarget.template);
  setup.template = managedTemplate ? parseTemplate(template, baseURL) : parseUserTemplate(template, baseURL);
  setup.addonTemplate = setup.template?.url && !managedTemplate ? setup.template : null;
  setup.startupCommands = parseStartupCommands(setup.startupCommands ?? []);
  setup.addonStartupCommands = setup.startupCommands;
  setup.languages = languagePackages(setup.languages ?? [], baseURL, true);
  if (sourceMajor && sourceMajor !== recipeMajor) {
    setup.languages = setup.languages.map(entry => {
      const previous = registry.languages?.[sourceMajor]?.find(item => item.tag === entry.tag && samePackage(item, entry));
      return previous ? registry.languages?.[recipeMajor]?.find(item => item.tag === entry.tag) ?? entry : entry;
    });
  }
  setup.addonLanguages = setup.languages;
  if (setup.content) setup.content = normalizeContent(setup.content);
  const tags = new Set([setup.language ?? DEFAULTS.language, ...(setup.languageTags ?? []),
    ...(setup.menus ?? []).map(entry => entry.language).filter(tag => tag && tag !== '*'),
    ...(setup.content?.categories ?? []).map(entry => entry.language), ...(setup.content?.articles ?? []).map(entry => entry.language)]);
  for (const tag of tags) {
    if (tag === 'en-GB' || setup.languages.some(entry => entry.tag === tag)) continue;
    const language = registry.languages?.[recipeMajor]?.find(entry => entry.tag === tag);
    if (!language) throw new TypeError(`No pinned ${tag} language package is configured for Joomla ${major}.`);
    setup.languages.push(language);
  }
  setup.deploymentRecipe = document;
  return { configuration: normalizeConfiguration(setup, { catalog, baseURL }), deploy, recipeMajor };
}

/** Resolve repository recipe defaults followed by explicit caller settings. */
export async function resolveDeployConfiguration(input = {}, {
  catalog, deployCatalog, baseURL = globalThis.location?.href ?? 'https://playground.joomengine.org/', fetcher = fetch,
} = {}) {
  if (!catalog) throw new TypeError('A verified runtime catalog is required to resolve a deploy.');
  if (input.deploymentRecipe) return resolveMaterializedDeployment(input, { catalog, deployCatalog, baseURL, fetcher });
  catalog = catalogWithSelectedJoomlaPackage(catalog, input, baseURL);
  const registry = deployCatalog ?? await loadDeployCatalog({ fetcher });
  const selectedMajor = resolveJoomlaVersion(input.joomlaVersion ?? catalog.defaults.joomlaVersion, catalog).split('.')[0];
  const id = normalizeDeployId(input.deployId ?? registry.defaultsByJoomla?.[selectedMajor] ?? registry.default);
  const descriptor = registry.deploys.find((entry) => entry.id === id);
  if (!descriptor) throw new TypeError(`Unknown deploy: ${id}.`);
  const manifestURL = descriptor.url ?? new URL(descriptor.file, registry.url ?? defaultCatalogURL).href;
  const deploy = normalizeDeploy(await fetchJSON(manifestURL, fetcher), { baseURL: manifestURL });
  if (deploy.id !== id) throw new TypeError(`Deploy manifest ID does not match ${id}.`);
  let release = resolveJoomlaVersion(input.joomlaVersion ?? deploy.configuration.joomlaVersion ?? catalog.defaults.joomlaVersion, catalog);
  const major = release.split('.')[0];
  const recipeMajor = deploymentRecipeMajor(deploy, release);
  if (!recipeMajor) throw new TypeError(`${deploy.title} is not available for Joomla ${major}.`);
  const common = deploy.configuration;
  const variant = deploy.variants[recipeMajor ?? major] ?? {};
  if (input.joomlaVersion === undefined && recipeMajor === major && variant.joomlaVersion !== undefined) release = resolveJoomlaVersion(variant.joomlaVersion, catalog);
  const overrides = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const setup = { ...common, ...variant, ...overrides, deployId: id, sourceDeployId: id, joomlaVersion: release };
  const supportedPhp = deploymentPhpVersions(deploy, catalog.joomla.find(entry => entry.version === release));
  if (!supportedPhp.length) throw new TypeError(`${deploy.title} has no compatible PHP runtime for Joomla ${release}.`);
  if (setup.phpVersion !== undefined && !supportedPhp.includes(setup.phpVersion)) throw new TypeError(`${deploy.title} does not support PHP ${setup.phpVersion} with Joomla ${release}.`);
  setup.phpVersion ??= supportedPhp.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : supportedPhp[0];
  if (common.phpSettings || variant.phpSettings || input.phpSettings) setup.phpSettings = normalizePhpSettings({ ...common.phpSettings, ...variant.phpSettings, ...input.phpSettings });
  if (setup.content) setup.content = normalizeContent(setup.content);
  setup.addonExtensions = parseUserExtensions(input.extensions ?? [], baseURL);
  setup.addonTemplate = input.template?.url ? parseUserTemplate(input.template, baseURL) : null;
  if (setup.addonTemplate) setup.template = setup.addonTemplate;
  setup.addonStartupCommands = parseStartupCommands(input.startupCommands ?? []);
  setup.addonLanguages = languagePackages(input.languages ?? [], baseURL, true);
  const presetExtensions = [...common.extensions, ...(variant.extensions ?? [])];
  let selectedPresetExtensions = presetExtensions;
  let snapshotCompatible = true;
  if (input.jcbVersion !== undefined) {
    const selectedVersion = normalizeJcbVersion(input.jcbVersion);
    // Only inherit the reviewed preset when no explicit package was supplied.
    // A caller who supplies a package selected those exact bytes, even if it
    // happens to use the same version string as the pinned default.
    const matching = input.jcbPackage === undefined && presetExtensions.find((entry) => jcbRecipeVersion(entry) === selectedVersion);
    let selectedPackage;
    if (selectedVersion === 'none') {
      if (deploymentRequiresJcb(deploy)) throw new TypeError(`${deploy.title} requires Joomla Component Builder. Choose a compatible JCB version.`);
      if (input.jcbPackage !== undefined) throw new TypeError('A JCB package cannot be provided when JCB is set to none.');
    } else {
      const jcbMajor = selectedVersion.split('.')[0];
      if (jcbMajor !== major && !(major === '7' && jcbMajor === '6')) throw new TypeError(`JCB ${selectedVersion} is not a selectable package for Joomla ${major}.`);
      if (matching) selectedPackage = matching;
      else {
        if (input.jcbPackage) selectedPackage = normalizeJcbPackage(input.jcbPackage, baseURL);
        else {
          // A pinned JCB package belongs to the shared package catalog, not only
          // to the JCB preset. Other recipes can opt in to the same exact bytes.
          const jcbDescriptor = registry.deploys.find(entry => entry.id === 'jcb');
          if (jcbDescriptor) {
            const url = jcbDescriptor.url ?? new URL(jcbDescriptor.file, registry.url ?? defaultCatalogURL).href;
            const jcbDeploy = id === 'jcb' ? deploy : normalizeDeploy(await fetchJSON(url, fetcher), { baseURL: url });
            selectedPackage = [...pinnedJcbPackages(jcbDeploy).values()].find(entry => entry.version === selectedVersion)?.package;
          }
          if (!selectedPackage) throw new TypeError(`The selected JCB ${selectedVersion} package is unavailable.`);
        }
      }
    }
    selectedPresetExtensions = presetExtensions.filter((entry) => !jcbRecipeVersion(entry));
    if (selectedPackage) selectedPresetExtensions.unshift(selectedPackage);
    snapshotCompatible = JSON.stringify(selectedPresetExtensions) === JSON.stringify(presetExtensions);
    setup.jcbVersion = selectedVersion;
    if (input.jcbPackage !== undefined) setup.jcbPackage = normalizeJcbPackage(input.jcbPackage, baseURL);
  }
  setup.extensions = uniquePackages([...selectedPresetExtensions, ...setup.addonExtensions]);
  setup.startupCommands = [...common.startupCommands, ...(variant.startupCommands ?? []), ...setup.addonStartupCommands];
  setup.languages = [...common.languages, ...(variant.languages ?? []), ...setup.addonLanguages];
  const requiredLanguages = new Set([setup.language ?? DEFAULTS.language, ...(setup.languageTags ?? []),
    ...(setup.menus ?? []).map((entry) => entry.language).filter((tag) => tag && tag !== '*'),
    ...(setup.content?.categories ?? []).map((entry) => entry.language), ...(setup.content?.articles ?? []).map((entry) => entry.language)]);
  for (const tag of requiredLanguages) {
    if (tag === 'en-GB' || setup.languages.some((entry) => entry.tag === tag)) continue;
    const language = registry.languages?.[recipeMajor ?? major]?.find((entry) => entry.tag === tag);
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
  const snapshot = variant.snapshot ?? common.snapshot ?? deploy.snapshot;
  delete setup.snapshot;
  if (!setup.fresh && snapshotCompatible && input.joomlaPackage === undefined && input.content === undefined && snapshot?.joomlaVersion === release) setup.snapshot = snapshot;
  const configuration = normalizeConfiguration(setup, { catalog, baseURL });
  return { configuration, deploy, recipeMajor: recipeMajor ?? major };
}
