// Forks can opt out of these parts of the surrounding Playground. A required
// entry remains available in every supported profile, including a chromeless one.
const features = {
  header: '#site-header, #focus-restore-top',
  footer: '#site-footer, #focus-restore-bottom',
  focusMode: '.chrome-toggle, .focus-restore',
  settings: '#settings, #settings-toggle, #editor-runtime-button',
  deployments: '.deploy-field, #deploy-editor-button, #deploy-dialog, #welcome-configure, #error-configure, #capture-deployment-data, #save-button, #deploy-description, #share-export-config',
  editor: '#code-button, #code-refresh-button',
  database: '#database-button',
  mail: '#mail-button, #mail-dialog',
  phpSettings: '#php-settings-button, #php-dialog',
  phpVersion: '.field:has(> #php-version)',
  joomlaVersion: '.field:has(> #joomla-version)',
  jcbVersion: '.field:has(> #jcb-version)',
  siteLanguage: '.field:has(#language)',
  share: '#share-button, #share-dialog',
  backups: '#backup-button, #local-images-button, #backups-panel',
  savedSites: '#legacy-sites, #recover-button',
  upload: '#upload-site-button',
  download: '#download-dialog-button, #download-dialog, #backups-download-fallback, [data-backup-action="download"]',
  navigation: '.site-navigation, #go-administrator',
  credentials: '#credentials-button, #credentials-dialog',
  lifecycle: '#reset-button, #restart-button, #close-button, #error-reset-button, #repair-button',
  activity: '#activity-dock, #error-technical-details',
  autoLaunch: '#launch-countdown, #dashboard-countdown',
  launchMedia: '.launch-scene .rocket-window',
  theme: '#theme-toggle',
  interfaceLanguage: '.interface-language',
  repositoryLinks: '.repository-links',
  guides: '.footer-tools a',
  credits: { required: true },
};

function settingsObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

export function normalizeSiteFeatures(input = {}) {
  const result = {};
  for (const [key, value] of Object.entries(settingsObject(input, 'Site features'))) {
    if (!Object.hasOwn(features, key)) throw new TypeError(`Unknown site feature: ${key}.`);
    if (typeof value !== 'boolean') throw new TypeError(`Site feature ${key} must be true or false.`);
    if (features[key].required && !value) throw new TypeError(`The ${key} feature is required.`);
    result[key] = value;
  }
  return result;
}

export function normalizeSiteDefaults(input = {}) {
  settingsObject(input, 'Site defaults');
  for (const key of Object.keys(input)) {
    if (key !== 'phpVersion') throw new TypeError(`Unknown site default: ${key}.`);
  }
  if (input.phpVersion === undefined) return {};
  if (typeof input.phpVersion !== 'string' || !/^\d+\.\d+$/.test(input.phpVersion)) throw new TypeError('defaults.phpVersion must be a PHP minor version such as "8.4".');
  return { phpVersion: input.phpVersion };
}

/** Emitted in the document head: no loading flash and dynamic controls stay hidden. */
export function siteFeatureStyles(config = {}) {
  const hidden = Object.entries(normalizeSiteFeatures(config)).filter(([, enabled]) => !enabled).map(([key]) => features[key]);
  return hidden.length ? `${hidden.join(',\n')} { display: none !important; }` : '';
}

/** Strip unavailable URL inputs before parsing or fetching any external recipe. */
export function siteLaunchURL(value, config) {
  const url = new URL(value);
  if (config.deployments === false) {
    url.hash = '';
    const allowed = ['start', 'immediate', 'toolbar', 'hideToolbar', 'view', 'php', 'joomla', 'jcb', 'language'];
    for (const name of [...url.searchParams.keys()]) if (!allowed.includes(name)) url.searchParams.delete(name);
  }
  for (const [feature, names] of Object.entries({
    phpVersion: ['php'], joomlaVersion: ['joomla'], jcbVersion: ['jcb'], siteLanguage: ['language'], focusMode: ['toolbar', 'hideToolbar'],
  })) {
    if (config[feature] === false) for (const name of names) url.searchParams.delete(name);
  }
  return url;
}

/** A shared document inherits the site's locked runtime and settings. */
export function siteSharedConfiguration(input, config) {
  const disabledFields = {
    joomlaVersion: ['joomlaVersion', 'joomlaPackage'], phpVersion: ['phpVersion'],
    jcbVersion: ['jcbVersion', 'jcbPackage'], phpSettings: ['phpSettings'], siteLanguage: ['language'], focusMode: ['hideToolbar'],
  };
  const omit = Object.entries(disabledFields).filter(([feature]) => config[feature] === false).flatMap(([, names]) => names);
  if (!omit.length) return input;
  const filtered = { ...input };
  for (const key of omit) delete filtered[key];
  if (filtered.deploymentRecipe) {
    const configuration = { ...filtered.deploymentRecipe.configuration };
    for (const key of omit) delete configuration[key];
    filtered.deploymentRecipe = { ...filtered.deploymentRecipe, configuration };
  }
  return filtered;
}

/** An older or differently branded live site must stay in its own saved slot. */
export function allowedSiteSelection(site, config, defaults, deployCatalog) {
  if (!site) return false;
  if (config.phpVersion === false && site.phpVersion !== defaults.phpVersion) return false;
  if (config.joomlaVersion === false && site.joomlaVersion !== defaults.joomlaVersion) return false;
  if (config.deployments === false) {
    const major = site.joomlaVersion?.split('.')[0];
    const selected = deployCatalog.defaultsByJoomla?.[major] ?? deployCatalog.default;
    if (site.deployId !== selected || site.deploymentRecipe || site.restoredSite) return false;
  }
  return true;
}
