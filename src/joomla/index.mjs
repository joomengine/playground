const RESULT_MARKER = '\n__JOOMENGINE_RESULT__';
const phpSourceCache = new Map();
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;

function checkedString(value, name, { maximum = 256, minimum = 1 } = {}) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${name} must contain ${minimum}–${maximum} characters without NUL bytes.`);
  }
  return value;
}

export function validateCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
    throw new TypeError('A startup command must be an array containing a command name and its arguments.');
  }
  const result = argv.map((value, index) => checkedString(value, `Command argument ${index}`, { maximum: 8192, minimum: index ? 0 : 1 }));
  if (!/^[a-z][a-z0-9:_-]*$/i.test(result[0])) {
    throw new TypeError('Use a Joomla command name, for example cache:clean, without a PHP or shell prefix.');
  }
  return result;
}

export function validateInstallOptions(config) {
  if (!config || typeof config !== 'object') throw new TypeError('Joomla configuration is required.');
  const version = checkedString(config.joomlaVersion, 'Joomla version', { maximum: 32 });
  if (!/^[56]\.\d+\.\d+$/.test(version)) throw new TypeError('Select a supported stable Joomla 5 or Joomla 6 release.');
  const admin = config.admin ?? {};
  const result = {
    joomlaVersion: version,
    siteName: checkedString(config.siteName ?? 'Joomla Playground', 'Site name'),
    database: checkedString(config.database ?? 'joomla', 'Database name', { maximum: 64 }),
    admin: {
      name: checkedString(admin.name ?? 'Playground Administrator', 'Administrator name'),
      username: checkedString(admin.username ?? 'admin', 'Administrator username', { minimum: 2, maximum: 30 }),
      password: checkedString(admin.password, 'Administrator password', { minimum: 12, maximum: 128 }),
      email: checkedString(admin.email ?? 'admin@example.test', 'Administrator email'),
    },
    startupCommands: (config.startupCommands ?? []).map(validateCommand),
    extensions: config.extensions ?? [],
    autoLogin: config.autoLogin !== false,
  };
  if (!/^[a-zA-Z0-9_]+$/.test(result.database)) throw new TypeError('Database names may contain letters, numbers and underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.admin.email)) throw new TypeError('Enter a valid administrator email address.');
  if (/[<>"'%;()&\\]/.test(result.admin.username) || result.admin.username.includes('../')
      || result.admin.username.trim() !== result.admin.username) {
    throw new TypeError('Administrator username contains characters Joomla does not accept.');
  }
  if (!Array.isArray(result.extensions) || result.extensions.length > 32 || result.startupCommands.length > 32) {
    throw new TypeError('At most 32 extensions and 32 startup commands are supported.');
  }
  result.extensions = result.extensions.map((extension) => {
    if (!extension || typeof extension !== 'object') throw new TypeError('An extension must provide a URL.');
    const url = checkedString(extension.url, 'Extension URL', { maximum: 4096 });
    const parsed = new URL(url, globalThis.location?.href ?? 'https://playground.invalid/');
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new TypeError('Extension URLs must use HTTP or HTTPS without embedded credentials.');
    }
    if (extension.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(extension.sha256)) {
      throw new TypeError('Extension SHA-256 must contain 64 hexadecimal characters.');
    }
    return { url, sha256: extension.sha256?.toLowerCase() };
  });
  return result;
}

export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyPackage(bytes, expectedDigest) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < 4 || data.byteLength > MAX_PACKAGE_BYTES || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error('The package is not a supported ZIP archive or exceeds 128 MiB.');
  }
  if (expectedDigest !== undefined) {
    if (!/^[a-f\d]{64}$/i.test(expectedDigest)) throw new TypeError('A valid SHA-256 digest is required.');
    if (await sha256(data) !== expectedDigest.toLowerCase()) throw new Error('Package SHA-256 verification failed.');
  }
  return data;
}

async function defaultSourceLoader(name) {
  if (!phpSourceCache.has(name)) {
    phpSourceCache.set(name, fetch(new URL(`./php/${name}.php`, import.meta.url)).then(async (response) => {
      if (!response.ok) throw new Error(`Cannot load Joomla provisioning script ${name}: HTTP ${response.status}`);
      return response.text();
    }).catch((error) => { phpSourceCache.delete(name); throw error; }));
  }
  return phpSourceCache.get(name);
}

export async function buildPhpProgram(operation, payload, sourceLoader = defaultSourceLoader) {
  if (!['extract', 'install', 'console', 'status', 'health'].includes(operation)) throw new TypeError('Unknown provisioning operation.');
  const [common, script] = await Promise.all([sourceLoader('common'), sourceLoader(operation)]);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of encoded) binary += String.fromCharCode(byte);
  const input = btoa(binary);
  return `<?php\n$playground = json_decode(base64_decode('${input}'), true, 512, JSON_THROW_ON_ERROR);\n`
    + common.replace(/^<\?php\s*/, '') + '\n' + script.replace(/^<\?php\s*/, '');
}

export async function parseProvisioningResult(response) {
  const text = typeof response.text === 'function' ? await response.text()
    : typeof response.text === 'string' ? response.text
      : typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body ?? new Uint8Array());
  const start = text.lastIndexOf(RESULT_MARKER);
  if (start === -1) throw new Error(`PHP did not complete the Joomla operation (HTTP ${response.status ?? 'unknown'}): ${text.slice(0, 2000)}`);
  let result;
  try { result = JSON.parse(text.slice(start + RESULT_MARKER.length)); }
  catch { throw new Error(`Invalid PHP provisioning response: ${text.slice(start, start + 2000)}`); }
  if (result.ok !== true) {
    throw new Error(result.error || result.output || `Joomla command failed with exit status ${result.exitCode ?? 'unknown'}.`);
  }
  if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
    throw new Error(`PHP returned HTTP ${response.status} after the Joomla operation.`);
  }
  return result;
}

async function execute(runtime, operation, payload, sourceLoader) {
  return parseProvisioningResult(await runtime.runPhp(await buildPhpProgram(operation, payload, sourceLoader)));
}

function paths(runtime) {
  const root = runtime.documentRoot ?? '/persist/www';
  const marker = runtime.installMarkerPath ?? `${root.slice(0, root.lastIndexOf('/'))}/joomla-install.json`;
  return { root, marker };
}

export async function inspectJoomla(runtime, { sourceLoader } = {}) {
  return execute(runtime, 'status', paths(runtime), sourceLoader);
}

export async function checkJoomla(runtime, { sourceLoader } = {}) {
  return execute(runtime, 'health', paths(runtime), sourceLoader);
}

export async function runStartupCommand(runtime, argv, { sourceLoader } = {}) {
  return execute(runtime, 'console', { ...paths(runtime), argv: validateCommand(argv) }, sourceLoader);
}

export async function installExtension(runtime, bytes, { sha256: digest, sourceLoader } = {}) {
  const verified = await verifyPackage(bytes, digest);
  const archive = `/tmp/playground-extension-${crypto.randomUUID()}.zip`;
  await runtime.fs.writeFile(archive, verified);
  return execute(runtime, 'console', { ...paths(runtime), archive, argv: ['extension:install', `--path=${archive}`] }, sourceLoader);
}

function hiddenFields(html) {
  const fields = new Map();
  for (const tag of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = new Map();
    for (const match of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
    }
    if (attributes.get('type')?.toLowerCase() === 'hidden' && attributes.has('name')) {
      fields.set(attributes.get('name'), attributes.get('value') ?? '');
    }
  }
  return fields;
}

export async function loginAdministrator(runtime, admin) {
  const page = await runtime.request('administrator/index.php', { method: 'GET' });
  if (page.status !== 200) throw new Error(`Administrator login page returned HTTP ${page.status}.`);
  const html = await page.text();
  const fields = hiddenFields(html);
  const token = [...fields].find(([name, value]) => /^[a-f\d]{32}$/i.test(name) && value === '1');
  if (!token) throw new Error('Joomla did not provide a login form token.');
  const body = new URLSearchParams({ username: admin.username, passwd: admin.password, option: 'com_login', task: 'login', [token[0]]: '1' });
  if (fields.has('return')) body.set('return', fields.get('return'));
  const result = await runtime.request('administrator/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (result.status < 200 || result.status >= 400) throw new Error(`Joomla login returned HTTP ${result.status}.`);
  const check = await runtime.request('administrator/index.php', { method: 'GET' });
  const authenticatedHtml = await check.text();
  if (check.status !== 200 || /name\s*=\s*["']passwd["']/i.test(authenticatedHtml)
      || !/com_login[^"'<>]*(?:logout)|task=logout|task%3Dlogout/i.test(authenticatedHtml)) {
    throw new Error('Joomla administrator authentication did not complete.');
  }
  return { ok: true };
}

export async function installJoomla(runtime, config, {
  archiveBytes, sha256: digest, progress = () => {}, sourceLoader, fetchPackage = fetch,
} = {}) {
  const options = validateInstallOptions(config);
  const location = paths(runtime);
  const state = await inspectJoomla(runtime, { sourceLoader });
  if (state.marker?.state === 'complete' && state.configured && !state.installerPresent) {
    if (state.marker.joomlaVersion !== options.joomlaVersion) throw new Error('This saved site uses another Joomla release. Choose another storage key or reset it.');
    const health = await checkJoomla(runtime, { sourceLoader });
    if (health.version !== options.joomlaVersion) throw new Error('The saved Joomla files do not match the selected release.');
    progress({ stage: 'ready', message: 'Opened the saved Joomla site.' });
    return { resumed: true, version: health.version, siteName: health.siteName };
  }
  if (state.marker || state.configured || state.installerPresent) throw new Error('A previous installation is incomplete. Reset this site before trying again.');
  if (!digest) throw new TypeError('The Joomla release SHA-256 is required.');
  const archive = await verifyPackage(archiveBytes, digest);
  await runtime.fs.writeFile(location.marker, JSON.stringify({ state: 'installing', joomlaVersion: options.joomlaVersion }));
  progress({ stage: 'extracting', message: `Extracting Joomla ${options.joomlaVersion}…` });
  const archivePath = `/tmp/joomla-${crypto.randomUUID()}.zip`;
  await runtime.fs.writeFile(archivePath, archive);
  await execute(runtime, 'extract', { ...location, archive: archivePath }, sourceLoader);
  progress({ stage: 'installing', message: 'Installing Joomla and creating the administrator…' });
  const installed = await execute(runtime, 'install', { ...location, ...options }, sourceLoader);
  if (installed.version !== options.joomlaVersion) throw new Error('Installed Joomla version does not match the verified release.');
  for (const [index, extension] of options.extensions.entries()) {
    progress({ stage: 'extensions', message: `Installing extension ${index + 1} of ${options.extensions.length}…` });
    const response = await fetchPackage(extension.url);
    if (!response.ok) throw new Error(`Extension download failed: HTTP ${response.status}.`);
    const length = Number(response.headers.get('Content-Length'));
    if (length > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 128 MiB.');
    await installExtension(runtime, await response.arrayBuffer(), { sha256: extension.sha256, sourceLoader });
  }
  for (const argv of options.startupCommands) {
    progress({ stage: 'commands', message: `Running ${argv[0]}…` });
    await runStartupCommand(runtime, argv, { sourceLoader });
  }
  const health = await checkJoomla(runtime, { sourceLoader });
  if (options.autoLogin) {
    progress({ stage: 'login', message: 'Signing in to Joomla…' });
    await loginAdministrator(runtime, options.admin);
  }
  const frontend = await runtime.request('index.php', { method: 'GET' });
  await frontend.arrayBuffer();
  if (frontend.status !== 200) throw new Error(`The installed Joomla site returned HTTP ${frontend.status}.`);
  await runtime.fs.writeFile(location.marker, JSON.stringify({
    state: 'complete', joomlaVersion: options.joomlaVersion, installedAt: new Date().toISOString(),
  }));
  progress({ stage: 'ready', message: 'Joomla is ready.' });
  return { resumed: false, version: installed.version, siteName: health.siteName, output: installed.output };
}
