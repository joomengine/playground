import { ensureManagedDatabaseConfiguration } from './managed-database.mjs';
import { parseMenus, parseTemplate, parseLanguageTags } from '../site-configuration.mjs';
import { createMcpClient } from '../mcp.mjs';
import { installationBudget } from '../php-settings.mjs';
import { conciseFailure, packageLabel, provisioningError } from '../provisioning-errors.mjs';
const RESULT_MARKER = '\n__JOOMENGINE_RESULT__';
const phpSourceCache = new Map();
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-[A-Z]{2}$/;

function languageTag(value, name = 'Language') {
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) throw new TypeError(`${name} must be a Joomla language tag such as en-GB or nl-NL.`);
  return value;
}

export function validateContent(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Deploy content must contain category and article arrays.');
  const result = { multilingual: input.multilingual === true, categories: [], articles: [] };
  for (const kind of ['categories', 'articles']) {
    if (!Array.isArray(input[kind]) || input[kind].length > 50) throw new TypeError(`Deploy ${kind} must contain at most 50 entries.`);
    const keys = new Set();
    result[kind] = input[kind].map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Each content entry must be an object.');
      const key = checkedString(entry.key, 'Content key', { maximum: 64 });
      if (!/^[a-z][a-z0-9_-]*$/.test(key) || keys.has(key)) throw new TypeError('Content keys must be unique identifiers.');
      keys.add(key);
      const value = {
        key, title: checkedString(entry.title, 'Content title', { maximum: 255 }),
        alias: checkedString(entry.alias ?? key, 'Content alias', { maximum: 200 }),
        language: languageTag(entry.language ?? 'en-GB', 'Content language'),
      };
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value.alias)) throw new TypeError('Content aliases must contain lowercase letters, numbers and hyphens.');
      if (kind === 'articles') Object.assign(value, {
        category: checkedString(entry.category, 'Article category', { maximum: 64 }),
        introtext: checkedString(entry.introtext ?? '', 'Article introduction', { maximum: 32768, minimum: 0 }),
        fulltext: checkedString(entry.fulltext ?? '', 'Article body', { maximum: 32768, minimum: 0 }),
        featured: entry.featured === true, home: entry.home === true,
      });
      return value;
    });
  }
  const categories = new Map(result.categories.map(category => [category.key, category]));
  const homes = new Set();
  for (const article of result.articles) {
    if (categories.get(article.category)?.language !== article.language) throw new TypeError('Each article must reference a category in its own language.');
    if (article.home && homes.has(article.language)) throw new TypeError('Choose at most one home article per language.');
    if (article.home) homes.add(article.language);
  }
  if (result.multilingual && (homes.size < 2 || result.articles.some(article => !homes.has(article.language)))) {
    throw new TypeError('A multilingual deploy needs a home article for each of at least two languages.');
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024) throw new TypeError('Deploy content exceeds 1 MiB.');
  return result;
}

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
    language: languageTag(config.language ?? 'en-GB'),
    languages: config.languages ?? [],
    languageTags: parseLanguageTags(config.languageTags ?? []),
    multilingual: config.content?.multilingual === true ? true : (config.multilingual ?? false),
    content: validateContent(config.content),
    menus: parseMenus(config.menus ?? []),
    template: parseTemplate(config.template),
    autoLogin: config.autoLogin !== false,
    deployId: config.deployId,
  };
  if (typeof result.multilingual !== 'boolean') throw new TypeError('multilingual must be true or false.');
  if (!/^[a-zA-Z0-9_]+$/.test(result.database)) throw new TypeError('Database names may contain letters, numbers and underscores.');
  if (result.deployId !== undefined && (typeof result.deployId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(result.deployId))) throw new TypeError('Deploy identity must be a named repository recipe.');
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
  if (!Array.isArray(result.languages) || result.languages.length > 30) throw new TypeError('At most 30 language packages are supported.');
  result.languages = result.languages.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('Each language package must provide a tag and URL.');
    const tag = languageTag(entry.tag);
    const url = checkedString(entry.url, 'Language package URL', { maximum: 4096 });
    const parsed = new URL(url, globalThis.location?.href ?? 'https://playground.invalid/');
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Language URLs must use HTTP or HTTPS without embedded credentials.');
    if (typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)) throw new TypeError('Language packages require a SHA-256 checksum.');
    return { tag, url, sha256: entry.sha256.toLowerCase() };
  });
  return result;
}

export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyPackage(bytes, expectedDigest) {
  return verifyArchive(bytes, expectedDigest, MAX_PACKAGE_BYTES);
}

async function verifyArchive(bytes, expectedDigest, maximum) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < 4 || data.byteLength > maximum || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error(`The package is not a supported ZIP archive or exceeds ${maximum / 1024 / 1024} MiB.`);
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
  if (!['extract', 'install', 'console', 'status', 'health', 'customize', 'administrator', 'import', 'configure', 'discover', 'mcp', 'recovery'].includes(operation)) throw new TypeError('Unknown provisioning operation.');
  const [common, script] = await Promise.all([sourceLoader('common'), sourceLoader(operation)]);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of encoded) binary += String.fromCharCode(byte);
  const input = btoa(binary);
  return `<?php\n$playground = json_decode(base64_decode('${input}'), true, 512, JSON_THROW_ON_ERROR);\n`
    + common.replace(/^<\?php\s*/, '') + '\n' + script.replace(/^<\?php\s*/, '');
}

/** Locate a complete JSON object without treating braces or markers in strings as frames. */
function resultFrameEnd(text, start) {
  let depth = 0, quoted = false, escaped = false;
  if (text[start] !== '{') return -1;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      if (--depth === 0) return index + 1;
    }
  }
  return -1;
}

export async function parseProvisioningResult(response) {
  const text = typeof response.text === 'function' ? await response.text()
    : typeof response.text === 'string' ? response.text
      : typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body ?? new Uint8Array());
  const start = text.indexOf(RESULT_MARKER);
  const diagnostic = { technicalDetails: text, phase: 'installation' };
  if (start === -1) throw provisioningError(`PHP did not complete the Joomla operation (HTTP ${response.status ?? 'unknown'}).`, diagnostic);
  const bodyStart = start + RESULT_MARKER.length;
  const end = resultFrameEnd(text, bodyStart);
  let result;
  try {
    if (end === -1) throw new Error('Incomplete result');
    result = JSON.parse(text.slice(bodyStart, end));
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error('Invalid envelope');
  } catch { throw provisioningError('Invalid PHP provisioning response. The operation did not complete safely.', diagnostic); }
  const tail = text.slice(end).trim();
  // A second frame is ambiguous even if one frame claims success. Failure tails
  // from Joomla's shutdown handlers remain diagnostics, never a success signal.
  if (tail.includes('__JOOMENGINE_RESULT__') || (result.ok && tail)) {
    throw provisioningError('Invalid PHP provisioning response. The operation did not complete safely.', diagnostic);
  }
  if (!result.ok) {
    throw provisioningError(conciseFailure(result.error || result.output,
      `Joomla command failed with exit status ${result.exitCode ?? 'unknown'}.`), diagnostic);
  }
  if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
    throw provisioningError(`PHP returned HTTP ${response.status} after the Joomla operation.`, diagnostic);
  }
  if (response.fatal || response.error || response.failed || /PHP restarted after an application error|Fatal error|Uncaught (?:Error|Exception)/i.test(String(response.diagnostic ?? ''))) {
    throw provisioningError('PHP failed while completing the Joomla operation.', diagnostic);
  }
  return result;
}

async function execute(runtime, operation, payload, sourceLoader, options) {
  return parseProvisioningResult(await runtime.runPhp(await buildPhpProgram(operation, payload, sourceLoader), options));
}

function paths(runtime) {
  const root = runtime.documentRoot ?? '/persist/www';
  const marker = runtime.installMarkerPath ?? `${root.slice(0, root.lastIndexOf('/'))}/joomla-install.json`;
  return { root, marker };
}

export async function inspectJoomla(runtime, { sourceLoader, recovery = false } = {}) {
  return execute(runtime, 'status', { ...paths(runtime), recovery }, sourceLoader);
}

/** Read the private saved login without loading Joomla or its plugins. */
export async function readJoomlaAdministrator(runtime, { sourceLoader } = {}) {
  const result = await execute(runtime, 'administrator', { ...paths(runtime), mode: 'read' }, sourceLoader);
  return result.administrator;
}

/** Restore conservative diagnostic settings without bootstrapping a broken site. */
export async function repairJoomlaConfiguration(runtime, { sourceLoader } = {}) {
  return execute(runtime, 'recovery', paths(runtime), sourceLoader);
}

export async function checkJoomla(runtime, { sourceLoader } = {}) {
  return execute(runtime, 'health', paths(runtime), sourceLoader);
}

/** Return a private native Joomla token for a client running in this browser. */
export async function getMcpConnection(runtime, { sourceLoader, admin, initialize = false } = {}) {
  return execute(runtime, 'mcp', { ...paths(runtime), admin, initialize,
    apiBase: new URL('api/index.php', runtime.baseUrl).href }, sourceLoader);
}

/** Exercise the unchanged component through its real token-authenticated HTTP transport. */
export async function checkMcpRuntime(runtime, { sourceLoader, admin, initialize = false } = {}) {
  const connection = await getMcpConnection(runtime, { sourceLoader, admin, initialize });
  if (!connection.installed) return { installed: false };
  const client = createMcpClient({ request: runtime.request.bind(runtime), token: connection.token });
  try {
    const initialized = await client.initialize();
    const { tools } = await client.request('tools/list');
    if (!Array.isArray(tools) || !tools.some(tool => tool.name === 'joomla_action_describe')) {
      throw new Error('The installed MCP endpoint did not expose its action catalogue.');
    }
    const description = await client.callTool('joomla_action_describe', { action: 'content.categories.list' });
    if (description.action?.id !== 'content.categories.list') throw new Error('MCP did not describe the installed Joomla action.');
    return { installed: true, version: connection.version, endpoint: connection.endpoint,
      protocolVersion: initialized.protocolVersion, toolCount: tools.length, describedAction: description.action.id };
  } finally { await client.close(); }
}

export async function runStartupCommand(runtime, argv, { sourceLoader, executionTimeSeconds, timeoutMs } = {}) {
  const command = validateCommand(argv);
  const budget = command[0] === 'extension:install' ? installationBudget({ executionTimeSeconds, timeoutMs }) : null;
  return execute(runtime, 'console', { ...paths(runtime), argv: command,
    ...(budget ? { installationExecutionTimeSeconds: budget.executionTimeSeconds } : {}),
  }, sourceLoader, budget ? { timeoutMs: budget.timeoutMs } : undefined);
}

export async function installExtension(runtime, bytes, {
  sha256: digest, sourceLoader, executionTimeSeconds, timeoutMs, packageUrl, progress = () => {},
} = {}) {
  // Reject contradictory limits before writing the archive or invoking PHP.
  const budget = installationBudget({ executionTimeSeconds, timeoutMs });
  const context = { packageUrl: packageUrl ? packageLabel(packageUrl) : undefined, ...budget };
  let phase = 'verification';
  try {
    const verified = await verifyPackage(bytes, digest);
    const archive = `/tmp/playground-extension-${crypto.randomUUID()}.zip`;
    phase = 'installation';
    progress({ stage: 'extensions', phase, message: `Installing ${packageLabel(packageUrl)}…` });
    await runtime.fs.writeFile(archive, verified);
    return await execute(runtime, 'console', { ...paths(runtime), archive,
      argv: ['extension:install', `--path=${archive}`], installationExecutionTimeSeconds: budget.executionTimeSeconds,
    }, sourceLoader, { timeoutMs: budget.timeoutMs });
  } catch (error) {
    const phpTimeout = /Maximum execution time of \d+ seconds exceeded/i.test(error.message);
    const hostTimeout = error.code === 'TIMEOUT';
    const summary = phpTimeout
      ? `${packageLabel(packageUrl)} installation exceeded PHP's ${budget.executionTimeSeconds}-second limit.`
      : hostTimeout ? `${packageLabel(packageUrl)} installation exceeded the ${budget.timeoutMs / 1000}-second runtime deadline.`
        : `${packageLabel(packageUrl)} ${phase} failed: ${conciseFailure(error.message)}`;
    throw provisioningError(summary, { ...context, phase, code: error.code,
      incomplete: phase === 'installation',
      technicalDetails: error.technicalDetails || error.message,
    });
  }
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

export async function loginAdministrator(runtime, admin, { language } = {}) {
  const page = await runtime.request('administrator/index.php', { method: 'GET' });
  if (page.status !== 200) throw new Error(`Administrator login page returned HTTP ${page.status}.`);
  const html = await page.text();
  if (isAdministratorPage(html)) return { ok: true, alreadyAuthenticated: true };
  const fields = hiddenFields(html);
  const token = [...fields].find(([name, value]) => /^[a-f\d]{32}$/i.test(name) && value === '1');
  if (!token) throw new Error('Joomla did not provide a login form token.');
  const body = new URLSearchParams({ username: admin.username, passwd: admin.password, option: 'com_login', task: 'login', [token[0]]: '1' });
  if (language) body.set('lang', languageTag(language));
  if (fields.has('return')) body.set('return', fields.get('return'));
  const result = await runtime.request('administrator/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (result.status < 200 || result.status >= 400) throw new Error(`Joomla login returned HTTP ${result.status}.`);
  const check = await runtime.request('administrator/index.php', { method: 'GET' });
  const authenticatedHtml = await check.text();
  if (check.status !== 200 || !isAdministratorPage(authenticatedHtml)) {
    throw new Error('Joomla administrator authentication did not complete.');
  }
  return { ok: true };
}

function isAdministratorPage(html) {
  return !/name\s*=\s*["']passwd["']/i.test(html)
    && /com_login[^"'<>]*(?:logout)|task=logout|task%3Dlogout/i.test(html);
}

function tokenFromPage(html) {
  const hidden = [...hiddenFields(html)].find(([name, value]) => /^[a-f\d]{32}$/i.test(name) && value === '1');
  if (hidden) return hidden[0];
  const option = html.match(/["']csrf\.token["']\s*:\s*["']([a-f\d]{32})["']/i);
  if (option) return option[1];
  return html.match(/[?&](?:amp;)?([a-f\d]{32})=1\b/i)?.[1];
}

export async function logoutAdministrator(runtime) {
  const page = await runtime.request('administrator/index.php');
  const html = await page.text();
  if (page.status !== 200) throw new Error(`Administrator page returned HTTP ${page.status} while signing out.`);
  if (!isAdministratorPage(html)) return { ok: true, alreadyLoggedOut: true };
  const token = tokenFromPage(html);
  if (!token) throw new Error('Joomla did not provide a logout token.');
  const response = await runtime.request(`administrator/index.php?option=com_login&task=logout&${token}=1`);
  await response.arrayBuffer();
  if (response.status < 200 || response.status >= 400) throw new Error(`Joomla logout returned HTTP ${response.status}.`);
  const check = await runtime.request('administrator/index.php');
  const result = await check.text();
  if (check.status !== 200 || isAdministratorPage(result) || !/name\s*=\s*["']passwd["']/i.test(result)) {
    throw new Error('Joomla administrator logout did not complete.');
  }
  return { ok: true };
}

export async function logoutSite(runtime) {
  const loginPath = 'index.php?option=com_users&view=login';
  const page = await requestJoomlaPage(runtime, loginPath);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`The site login page returned HTTP ${page.status} while signing out.`);
  if (!/user\.logout/.test(html)) return { ok: true, alreadyLoggedOut: true };
  const token = tokenFromPage(html);
  if (!token) throw new Error('Joomla did not provide a site logout token.');
  const response = await requestJoomlaPage(runtime, `index.php?option=com_users&task=user.logout&${token}=1`);
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`Joomla site logout returned HTTP ${response.status}.`);
  const check = await requestJoomlaPage(runtime, loginPath);
  const result = await check.text();
  if (check.status !== 200 || /user\.logout/.test(result) || !/name\s*=\s*["']password["']/i.test(result)) {
    throw new Error('Joomla site logout did not complete.');
  }
  return { ok: true };
}

/** Restore authentication through Joomla's regular login/logout endpoints. */
export async function restoreJoomlaSession(runtime, config, { sourceLoader, rotateAdministrator = false } = {}) {
  const result = await execute(runtime, 'administrator', {
    ...paths(runtime), mode: rotateAdministrator ? 'replace' : 'read',
    ...(rotateAdministrator ? { admin: validateInstallOptions(config).admin } : {}),
  }, sourceLoader);
  let administrator = result.administrator ?? validateInstallOptions(config).admin;
  if (config.autoLogin !== false) {
    try { await loginAdministrator(runtime, administrator, { language: config.language }); }
    catch (error) {
      const supplied = validateInstallOptions(config).admin;
      if (!/authentication did not complete/.test(error.message) || (supplied.username === administrator.username && supplied.password === administrator.password)) throw error;
      await loginAdministrator(runtime, supplied, { language: config.language });
      await execute(runtime, 'administrator', { ...paths(runtime), mode: 'write', admin: supplied }, sourceLoader);
      administrator = supplied;
    }
  }
  else {
    await logoutAdministrator(runtime);
    await logoutSite(runtime);
  }
  return administrator;
}

async function downloadAndInstall(runtime, item, fetchPackage, sourceLoader, progress = () => {}) {
  const label = packageLabel(item.url);
  progress({ stage: 'extensions', phase: 'download', message: `Downloading ${label}…` });
  let bytes;
  try {
    const response = await fetchPackage(item.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}.`);
    const length = Number(response.headers.get('Content-Length'));
    if (length > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 128 MiB.');
    bytes = await response.arrayBuffer();
  } catch (error) {
    const reason = error instanceof TypeError
      ? 'The browser could not read this download. Check the URL, your connection, and whether the host permits cross-origin downloads.'
      : conciseFailure(error.message);
    throw provisioningError(`${label} download failed. ${reason}`, {
      phase: 'download', packageUrl: label, technicalDetails: error.message,
    });
  }
  progress({ stage: 'extensions', phase: 'verification', message: `Verifying ${label}…` });
  return installExtension(runtime, bytes, { sha256: item.sha256, sourceLoader, packageUrl: item.url, progress });
}

async function installMissingLanguages(runtime, languages, fetchPackage, sourceLoader, progress = () => {}) {
  for (const pack of languages) {
    const root = paths(runtime).root;
    const metadata = await runtime.fs.stat(`${root}/language/${pack.tag}/langmetadata.xml`);
    const administratorMetadata = await runtime.fs.stat(`${root}/administrator/language/${pack.tag}/langmetadata.xml`);
    if (!metadata?.isFile || !administratorMetadata?.isFile) await downloadAndInstall(runtime, pack, fetchPackage, sourceLoader, progress);
  }
}

/** Follow Joomla's local language/home redirects without leaving this site. */
export async function requestJoomlaPage(runtime, path = 'index.php') {
  const base = new URL(runtime.baseUrl ?? 'http://localhost/');
  let current = new URL(path, base);
  for (let redirects = 0; redirects < 10; redirects++) {
    if (current.origin !== base.origin || !current.pathname.startsWith(base.pathname)) throw new Error('Joomla redirected outside its playground site.');
    const response = await runtime.request(current.pathname.slice(base.pathname.length) + current.search, { method: 'GET' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const target = response.headers.get('Location');
    await response.arrayBuffer();
    if (!target) throw new Error('Joomla returned a redirect without a destination.');
    current = new URL(target, current);
  }
  throw new Error('Joomla exceeded the local redirect limit.');
}

export async function installJoomla(runtime, config, {
  archiveBytes, sha256: digest, progress = () => {}, sourceLoader, fetchPackage = fetch,
} = {}) {
  const options = validateInstallOptions(config);
  const location = paths(runtime);
  const state = await inspectJoomla(runtime, { sourceLoader });
  if (state.marker?.state === 'complete' && state.configured && !state.installerPresent) {
    if (state.marker.joomlaVersion !== options.joomlaVersion) throw new Error('This saved site uses another Joomla release. Choose another storage key or reset it.');
    await ensureManagedDatabaseConfiguration(runtime, options.joomlaVersion);
    let health = await checkJoomla(runtime, { sourceLoader });
    if (health.version !== options.joomlaVersion) throw new Error('The saved Joomla files do not match the selected release.');
    if (health.language !== options.language) {
      progress({ stage: 'languages', message: `Changing the saved site language to ${options.language}…` });
      await installMissingLanguages(runtime, options.languages, fetchPackage, sourceLoader, progress);
      await execute(runtime, 'customize', { ...location, language: options.language, content: null }, sourceLoader);
      await logoutAdministrator(runtime);
      health = await checkJoomla(runtime, { sourceLoader });
      await runtime.fs.writeFile(location.marker, JSON.stringify({ ...state.marker, language: health.language }));
    }
    const administrator = await restoreJoomlaSession(runtime, options, { sourceLoader });
    progress({ stage: 'ready', message: 'Opened the saved Joomla site.' });
    return { resumed: true, version: health.version, siteName: health.siteName, language: health.language, deployId: state.marker.deployId, administrator };
  }
  if (state.marker || state.configured || state.installerPresent) throw new Error('This installation is incomplete. Recover your saved files, or reset and launch it again.');
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
  await ensureManagedDatabaseConfiguration(runtime, options.joomlaVersion);
  await execute(runtime, 'administrator', { ...location, mode: 'write', admin: options.admin }, sourceLoader);
  for (const pack of options.languages) {
    progress({ stage: 'languages', message: `Installing ${pack.tag}…` });
    await downloadAndInstall(runtime, pack, fetchPackage, sourceLoader, progress);
  }
  for (const [index, extension] of options.extensions.entries()) {
    progress({ stage: 'extensions', message: `Installing extension ${index + 1} of ${options.extensions.length}…` });
    await downloadAndInstall(runtime, extension, fetchPackage, sourceLoader, progress);
  }
  if (options.template?.url) {
    progress({ stage: 'extensions', message: 'Installing the site template…' });
    await downloadAndInstall(runtime, options.template, fetchPackage, sourceLoader, progress);
  }
  progress({ stage: 'configure', message: options.content ? 'Preparing the deploy content and languages…' : 'Applying the site language…' });
  await execute(runtime, 'customize', { ...location, language: options.language, content: options.content, admin: options.admin, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  if (options.menus.length || options.template) await execute(runtime, 'configure', { ...location, menus: options.menus, template: options.template, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  for (const argv of options.startupCommands) {
    progress({ stage: 'commands', message: `Running ${argv[0]}…` });
    await runStartupCommand(runtime, argv, { sourceLoader });
  }
  const health = await checkJoomla(runtime, { sourceLoader });
  progress({ stage: 'login', message: options.autoLogin ? 'Signing in to Joomla…' : 'Starting without an administrator session…' });
  const administrator = await restoreJoomlaSession(runtime, options, { sourceLoader });
  const mcp = options.deployId === 'jcb-mcp' ? await checkMcpRuntime(runtime, { sourceLoader, admin: administrator, initialize: true }) : undefined;
  const frontend = await requestJoomlaPage(runtime);
  await frontend.arrayBuffer();
  if (frontend.status !== 200) throw new Error(`The installed Joomla site returned HTTP ${frontend.status}.`);
  await runtime.fs.writeFile(location.marker, JSON.stringify({
    state: 'complete', joomlaVersion: options.joomlaVersion, language: health.language, deployId: options.deployId, installedAt: new Date().toISOString(),
  }));
  progress({ stage: 'ready', message: 'Joomla is ready.' });
  return { resumed: false, version: installed.version, siteName: health.siteName, language: health.language, deployId: options.deployId, administrator, ...(mcp ? { mcp } : {}), output: installed.output };
}

/** Import a verified portable site bundle into an empty playground instance. */
export async function importJoomlaSnapshot(runtime, config, {
  archiveBytes, sha256: digest, progress = () => {}, sourceLoader, fetchPackage = fetch,
} = {}) {
  const options = validateInstallOptions(config);
  const location = paths(runtime);
  const state = await inspectJoomla(runtime, { sourceLoader });
  if (state.marker || state.configured || state.installerPresent) throw new Error('Import a prebuilt site only into a fresh playground. Reset this site or choose another key.');
  if (!digest) throw new TypeError('The prebuilt site SHA-256 is required.');
  const verified = await verifyPackage(archiveBytes, digest);
  await runtime.fs.writeFile(location.marker, JSON.stringify({ state: 'importing', joomlaVersion: options.joomlaVersion, deployId: options.deployId }));
  const archive = `/tmp/joomla-snapshot-${crypto.randomUUID()}.zip`;
  await runtime.fs.writeFile(archive, verified);
  progress({ stage: 'importing', message: 'Restoring the verified deploy files and database…' });
  await execute(runtime, 'import', { ...location, archive, joomlaVersion: options.joomlaVersion, siteName: options.siteName, database: options.database }, sourceLoader);
  await ensureManagedDatabaseConfiguration(runtime, options.joomlaVersion);
  const administrator = await restoreJoomlaSession(runtime, { ...options, autoLogin: false }, { sourceLoader, rotateAdministrator: true });
  await installMissingLanguages(runtime, options.languages, fetchPackage, sourceLoader, progress);
  const additions = validateInstallOptions({
    ...options, extensions: config.addonExtensions ?? [], startupCommands: config.addonStartupCommands ?? [], content: null,
  });
  for (const extension of additions.extensions) {
    progress({ stage: 'extensions', message: 'Installing an additional extension…' });
    await downloadAndInstall(runtime, extension, fetchPackage, sourceLoader, progress);
  }
  if (options.template?.url) await downloadAndInstall(runtime, options.template, fetchPackage, sourceLoader, progress);
  await execute(runtime, 'customize', { ...location, language: options.language, content: null, admin: administrator, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  if (options.menus.length || options.template) await execute(runtime, 'configure', { ...location, menus: options.menus, template: options.template, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  for (const argv of additions.startupCommands) {
    progress({ stage: 'commands', message: `Running ${argv[0]}…` });
    await runStartupCommand(runtime, argv, { sourceLoader });
  }
  const health = await checkJoomla(runtime, { sourceLoader });
  if (health.version !== options.joomlaVersion) throw new Error('The restored Joomla version does not match the selected release.');
  await restoreJoomlaSession(runtime, options, { sourceLoader });
  const mcp = options.deployId === 'jcb-mcp' ? await checkMcpRuntime(runtime, { sourceLoader, admin: administrator, initialize: true }) : undefined;
  const frontend = await requestJoomlaPage(runtime);
  await frontend.arrayBuffer();
  if (frontend.status !== 200) throw new Error(`The restored Joomla site returned HTTP ${frontend.status}.`);
  await runtime.fs.writeFile(location.marker, JSON.stringify({
    state: 'complete', joomlaVersion: options.joomlaVersion, language: health.language,
    deployId: options.deployId, importedAt: new Date().toISOString(),
  }));
  progress({ stage: 'ready', message: 'The prepared Joomla site is ready.' });
  return { resumed: false, fromSnapshot: true, version: health.version, siteName: health.siteName, language: health.language, deployId: options.deployId, administrator, ...(mcp ? { mcp } : {}) };
}

/** Restore only the verified bundle database/files; the caller restores its private filesystem next. */
export async function importJoomlaCheckpoint(runtime, config, {
  archiveBytes, sha256: digest, sourceLoader, progress = () => {},
} = {}) {
  const options = validateInstallOptions(config);
  const location = paths(runtime);
  const state = await inspectJoomla(runtime, { sourceLoader });
  if (state.marker || state.configured || state.installerPresent) throw new Error('Restore a private checkpoint only into a fresh playground.');
  if (!digest) throw new TypeError('The private checkpoint bundle SHA-256 is required.');
  const verified = await verifyArchive(archiveBytes, digest, MAX_CHECKPOINT_BYTES);
  const archive = `/tmp/joomla-checkpoint-${crypto.randomUUID()}.zip`;
  await runtime.fs.writeFile(archive, verified);
  progress({ stage: 'importing', message: 'Restoring the saved site database…' });
  await execute(runtime, 'import', { ...location, archive, joomlaVersion: options.joomlaVersion, siteName: options.siteName, database: options.database }, sourceLoader);
  return { resumed: true, fromCheckpoint: true, version: options.joomlaVersion, deployId: options.deployId };
}

/** Inspect actual installed menu types and site template styles for the editor. */
export async function discoverJoomlaConfiguration(runtime, { sourceLoader } = {}) {
  return execute(runtime, 'discover', paths(runtime), sourceLoader);
}

/** Apply explicitly selected changes to a running installation after a caller checkpoint. */
export async function applyJoomlaConfiguration(runtime, config, {
  sourceLoader, fetchPackage = fetch, progress = () => {}, installPackages = true,
} = {}) {
  const options = validateInstallOptions(config);
  const location = paths(runtime);
  const state = await inspectJoomla(runtime, { sourceLoader });
  if (state.marker?.state !== 'complete' || !state.configured || state.installerPresent) throw new Error('Open a completed Joomla installation before applying deployment changes.');
  if (state.marker.joomlaVersion !== options.joomlaVersion) throw new Error('Changing Joomla releases requires a new installation.');
  await installMissingLanguages(runtime, options.languages, fetchPackage, sourceLoader, progress);
  if (installPackages) {
    for (const extension of options.extensions) {
      progress({ stage: 'extensions', message: 'Installing the selected extension…' });
      await downloadAndInstall(runtime, extension, fetchPackage, sourceLoader, progress);
    }
    if (options.template?.url) await downloadAndInstall(runtime, options.template, fetchPackage, sourceLoader, progress);
  }
  progress({ stage: 'configure', message: 'Applying the site settings, menus and template…' });
  const identity = await execute(runtime, 'administrator', { ...location, mode: 'read' }, sourceLoader);
  await execute(runtime, 'customize', { ...location, language: options.language, content: null, admin: identity.administrator, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  const configured = await execute(runtime, 'configure', { ...location, siteName: options.siteName, menus: options.menus, template: options.template, languageTags: options.languageTags, multilingual: options.multilingual }, sourceLoader);
  for (const argv of options.startupCommands) await runStartupCommand(runtime, argv, { sourceLoader });
  const health = await checkJoomla(runtime, { sourceLoader });
  await runtime.fs.writeFile(location.marker, JSON.stringify({ ...state.marker, language: health.language, updatedAt: new Date().toISOString() }));
  const administrator = await restoreJoomlaSession(runtime, { ...options, admin: identity.administrator ?? options.admin }, { sourceLoader });
  progress({ stage: 'ready', message: 'The site changes have been applied.' });
  return { ...configured, ...health, administrator };
}
