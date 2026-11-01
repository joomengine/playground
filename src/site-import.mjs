import { normalizeConfiguration } from './config.mjs';

export const SITE_EXPORT_FORMAT_ERROR = 'Choose a complete JoomEngine site export ZIP.';
const MAX_ARCHIVE = 512 * 1024 * 1024;
const REQUIRED = ['export.json', 'database.sql', 'database.ndjson', 'site/configuration.php', 'site/index.php',
  'site/libraries/vendor/autoload.php', 'site/administrator/manifests/files/joomla.xml'];
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

/** Read only the small metadata and Joomla manifest before starting a runtime. */
export async function readSiteExport(file, { unzip } = {}) {
  if (file?.size > MAX_ARCHIVE) throw new Error('The site export ZIP exceeds 512 MiB.');
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_ARCHIVE) throw new Error(SITE_EXPORT_FORMAT_ERROR);
  unzip ??= (await import('../assets/fflate/browser.js')).unzipSync;
  let metadata, xml;
  try {
    const names = new Set();
    let expanded = 0;
    const files = unzip(bytes, { filter(entry) {
      const name = entry.name;
      if (names.has(name) || names.size >= 100000 || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\\\0]/.test(name)
          || name.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid ZIP paths.');
      names.add(name);
      expanded += entry.originalSize;
      if (expanded > 768 * 1024 * 1024) throw new Error('The expanded site is too large.');
      const selected = name === 'export.json' || name === REQUIRED.at(-1);
      if (selected && entry.originalSize > 1024 * 1024) throw new Error('Invalid site metadata.');
      return selected;
    } });
    if (REQUIRED.some(name => !names.has(name)) || names.has('site/installation/joomla.php')) throw new Error('Incomplete export.');
    metadata = JSON.parse(new TextDecoder().decode(files['export.json']));
    xml = new TextDecoder().decode(files[REQUIRED.at(-1)]);
    if (metadata?.format !== 'joomengine-playground-export' || metadata.schemaVersion !== 1
        || metadata.archiveLayout?.files !== 'site/' || metadata.archiveLayout?.database !== 'database.sql'
        || !VERSION.test(metadata.joomlaVersion) || /<version>\s*([^<]+)\s*<\/version>/.exec(xml)?.[1]?.trim() !== metadata.joomlaVersion) throw new Error('Unsupported export.');
    if (metadata.playground && (metadata.playground.schemaVersion !== 1 || !metadata.playground.configuration
        || typeof metadata.playground.configuration !== 'object' || Array.isArray(metadata.playground.configuration))) throw new Error('Invalid configuration.');
  } catch { throw new Error(SITE_EXPORT_FORMAT_ERROR); }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { bytes, sha256, metadata, phpMinimum: /<php_minimum>\s*([^<]+)\s*<\/php_minimum>/.exec(xml)?.[1]?.trim(),
    preserveAdministrator: Boolean(metadata.playground?.configuration?.admin?.password) };
}

/** A restored site's files supply Joomla; only its PHP binary comes from the catalog. */
export function catalogForRestoredSite(catalog, input) {
  if (!input.restoredSite) return catalog;
  const { joomlaVersion, php } = input.restoredSite;
  if (!VERSION.test(joomlaVersion) || joomlaVersion !== input.joomlaVersion || !Array.isArray(php) || !php.length
      || php.some(version => !catalog.php.some(entry => entry.version === version))) throw new Error('This exported site needs a PHP runtime that is unavailable here.');
  return { ...catalog, joomla: [...catalog.joomla.filter(entry => entry.version !== joomlaVersion),
    { version: joomlaVersion, label: `Joomla ${joomlaVersion}`, php: [...php], channel: 'saved' }] };
}

export function configurationForSiteExport(siteExport, catalog, { baseURL, admin, storageKey = `import-${crypto.randomUUID()}` } = {}) {
  const { metadata, phpMinimum } = siteExport;
  const original = metadata.playground?.configuration ?? {};
  const exact = catalog.joomla.find(entry => entry.version === metadata.joomlaVersion);
  const sameMajor = catalog.joomla.filter(entry => entry.version.split('.')[0] === metadata.joomlaVersion.split('.')[0]);
  const allowed = exact?.php ?? original.joomlaPackage?.php ?? [...new Set(sameMajor.flatMap(entry => entry.php))];
  const minimum = phpMinimum?.split('.').map(Number);
  const php = catalog.php.filter(entry => {
    if (!allowed.includes(entry.version)) return false;
    if (!minimum) return true;
    const available = (entry.patchVersion || `${entry.version}.0`).split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      const difference = (available[index] || 0) - (minimum[index] || 0);
      if (difference) return difference > 0;
    }
    return true;
  }).map(entry => entry.version);
  if (!php.length) throw new Error('This exported site needs a PHP runtime that is unavailable here.');
  const preferred = original.phpVersion ?? metadata.phpVersion?.split('.').slice(0, 2).join('.');
  const input = { ...original, joomlaVersion: metadata.joomlaVersion, phpVersion: php.includes(preferred) ? preferred : php[0],
    siteName: metadata.siteName || original.siteName || 'Imported Joomla site', initialPath: original.initialPath || '/administrator/',
    admin: siteExport.preserveAdministrator ? original.admin : admin, deployId: 'blank', storageKey,
    restoredSite: { joomlaVersion: metadata.joomlaVersion, php }, persistence: true, fresh: false };
  // These packages are already installed, including edited files and database
  // state. Importing or resuming must never resolve or download the recipe again.
  for (const name of ['joomlaPackage', 'jcbPackage', 'snapshot', 'deploymentRecipe']) delete input[name];
  return normalizeConfiguration(input, { catalog: catalogForRestoredSite(catalog, input), baseURL });
}
