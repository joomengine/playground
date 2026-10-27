const VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/;
const SHA256 = /^[a-f\d]{64}$/i;
const STORAGE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const DEFAULTS = Object.freeze({
  phpVersion: '8.4',
  joomlaVersion: '6.2.0',
  siteName: 'Joomla Playground',
  initialPath: '/',
  persistence: true,
  storageKey: 'default',
  autoLogin: true,
  hideToolbar: false,
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

export function parseExtensions(value = [], baseURL = 'https://playground.invalid/') {
  const entries = parseJSONList(value, 'Extensions');
  if (entries.length > 30) throw new TypeError('Choose at most 30 extension packages.');
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`Extension ${index + 1} must contain a URL.`);
    const raw = requireText(entry.url, `Extension ${index + 1} URL`, 2048);
    let url;
    try { url = new URL(raw, baseURL); } catch { throw new TypeError(`Extension ${index + 1} has an invalid URL.`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) {
      throw new TypeError(`Extension ${index + 1} needs an HTTPS URL without credentials or a fragment.`);
    }
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))) {
      throw new TypeError(`Extension ${index + 1} SHA-256 must contain 64 hexadecimal characters.`);
    }
    return { url: url.href, ...(entry.sha256 ? { sha256: entry.sha256.toLowerCase() } : {}) };
  });
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

export function parseCatalog(manifest) {
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
    return { ...entry, label: entry.label || `Joomla ${entry.version}` };
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

export function normalizeConfiguration(input = {}, { catalog, baseURL = 'https://playground.invalid/' } = {}) {
  const config = { ...DEFAULTS, ...catalog?.defaults, ...input, admin: { ...DEFAULTS.admin, ...input.admin } };
  if (typeof config.phpVersion !== 'string' || !VERSION.test(config.phpVersion) || typeof config.joomlaVersion !== 'string' || !VERSION.test(config.joomlaVersion)) {
    throw new TypeError('Select a valid PHP and Joomla version.');
  }
  if (catalog && !catalog.joomla.some((item) => item.version === config.joomlaVersion && item.php.includes(config.phpVersion))) {
    throw new TypeError('This PHP and Joomla combination is not available in the tested runtime catalog.');
  }
  config.siteName = requireText(config.siteName, 'Site name', 100);
  config.initialPath = normalizeInitialPath(config.initialPath);
  if (typeof config.storageKey !== 'string' || !STORAGE_KEY.test(config.storageKey)) throw new TypeError('Site key must use 1–64 letters, numbers, dots, underscores or hyphens.');
  for (const key of ['persistence', 'autoLogin', 'hideToolbar']) config[key] = requireBoolean(config[key], key);
  config.admin.name = requireText(config.admin.name, 'Administrator name', 100);
  config.admin.username = requireText(config.admin.username, 'Administrator username', 100);
  config.admin.email = requireText(config.admin.email, 'Administrator email', 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.admin.email)) throw new TypeError('Enter a valid administrator email address.');
  config.admin.password = requireText(config.admin.password ?? '', 'Administrator password', 128);
  if (config.admin.password.length < 12) throw new TypeError('Administrator password must contain at least 12 characters.');
  config.extensions = parseExtensions(config.extensions ?? [], baseURL);
  config.startupCommands = parseStartupCommands(config.startupCommands ?? []);
  return config;
}

export function readURLConfiguration(url) {
  const params = new URL(url).searchParams;
  const config = {};
  if (params.has('php')) config.phpVersion = params.get('php');
  if (params.has('joomla')) config.joomlaVersion = params.get('joomla');
  if (params.has('path') || params.has('initialPath')) config.initialPath = normalizeInitialPath(params.get('path') ?? params.get('initialPath'));
  if (params.has('toolbar')) config.hideToolbar = params.get('toolbar') === '0';
  if (params.has('hideToolbar')) config.hideToolbar = ['1', 'true'].includes(params.get('hideToolbar'));
  if (params.has('persist')) config.persistence = params.get('persist') !== '0';
  return { config, autostart: params.get('start') === '1' };
}

export function createShareURL(location, config) {
  const url = new URL(location);
  url.search = '';
  url.hash = '';
  url.searchParams.set('joomla', config.joomlaVersion);
  url.searchParams.set('php', config.phpVersion);
  if (config.initialPath !== '/') url.searchParams.set('path', config.initialPath);
  if (config.hideToolbar) url.searchParams.set('toolbar', '0');
  if (!config.persistence) url.searchParams.set('persist', '0');
  url.searchParams.set('start', '1');
  return url.href;
}
