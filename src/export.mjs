import { parseProvisioningResult } from './joomla/index.mjs';
import { createFullDeploymentDocument } from './config.mjs';

const FORMATS = new Set(['bundle', 'files', 'database']);
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
let sourcePromise;

async function source() {
  sourcePromise ??= fetch(new URL('./export/site.php', import.meta.url)).then(async (response) => {
    if (!response.ok) throw new Error(`Cannot load the site exporter: HTTP ${response.status}.`);
    return response.text();
  }).catch((error) => { sourcePromise = undefined; throw error; });
  return sourcePromise;
}

export function normalizeExportOptions(options = {}) {
  const format = options.format ?? 'bundle';
  if (!FORMATS.has(format)) throw new TypeError('Export format must be bundle, files, or database.');
  if (options.includePlaygroundConfiguration !== undefined && typeof options.includePlaygroundConfiguration !== 'boolean') {
    throw new TypeError('The playground configuration export option must be a boolean.');
  }
  const database = {};
  if (options.database !== undefined) {
    if (!options.database || typeof options.database !== 'object' || Array.isArray(options.database)) throw new TypeError('Export database settings must be an object.');
    for (const [name, value] of Object.entries(options.database)) {
      if (!['host', 'user', 'password', 'name'].includes(name)) throw new TypeError(`Unknown export database setting: ${name}.`);
      if (typeof value !== 'string' || value.length > 1024 || /[\0\r\n]/.test(value) || (name !== 'password' && value.length === 0)) {
        throw new TypeError(`Invalid export database ${name}.`);
      }
      database[name] = value;
    }
  }
  return { format, database, ...(format === 'bundle' && options.includePlaygroundConfiguration ? { includePlaygroundConfiguration: true } : {}) };
}

/** User-downloaded complete bundles can reopen the same sandbox configuration. */
export function exportPlaygroundConfiguration(runtime) {
  const configuration = runtime.configuration;
  if (!configuration || typeof configuration !== 'object') throw new Error('The running site configuration is unavailable for a complete export.');
  const admin = runtime.installation?.administrator ?? configuration.admin;
  const complete = createFullDeploymentDocument({ ...configuration, admin, fresh: false }, {
    baseURL: runtime.baseUrl ?? globalThis.location?.href ?? 'https://playground.joomengine.org/',
  });
  if (!complete.configuration.admin?.password) throw new Error('The running site administrator is unavailable for a complete export.');
  return { schemaVersion: 1, configuration: complete.configuration };
}

function program(php, options) {
  const input = new TextEncoder().encode(JSON.stringify(options));
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return `<?php\n$exportOptions = json_decode(base64_decode('${btoa(binary)}'), true, 512, JSON_THROW_ON_ERROR);\n${php.replace(/^<\?php\s*/, '')}`;
}

/** Produce an immutable portable archive while PHP serializes the site's requests. */
export async function exportSite(runtime, options = {}, { sourceLoader = source } = {}) {
  if (!runtime || typeof runtime.runPhp !== 'function' || typeof runtime.fs?.readFile !== 'function') throw new TypeError('An open playground runtime is required to export a site.');
  const settings = normalizeExportOptions(options);
  const id = crypto.randomUUID();
  const directory = `/tmp/joomengine-export-${id}`;
  const php = await sourceLoader();
  const payload = { ...settings, root: runtime.documentRoot ?? '/persist/www', directory };
  if (settings.includePlaygroundConfiguration) payload.playground = exportPlaygroundConfiguration(runtime);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  try {
    progress({ phase: 'export', message: settings.format === 'database' ? 'Exporting the database…' : 'Preparing the portable Joomla export…' });
    const result = await parseProvisioningResult(await runtime.runPhp(program(php, { ...payload, operation: 'create' }), { timeoutMs: 600_000 }));
    const expectedName = settings.format === 'database' ? 'database.sql' : 'site.zip';
    if (result.path !== `${directory}/${expectedName}` || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > MAX_DOWNLOAD_BYTES
        || typeof result.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(result.sha256)) {
      throw new Error('The exporter returned invalid file metadata.');
    }
    const contents = await runtime.fs.readFile(result.path);
    const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
    if (bytes.byteLength !== result.size) throw new Error('The exported file is incomplete.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== result.sha256) throw new Error('The exported file failed its integrity check.');
    progress({ phase: 'export', message: 'The export is ready to download.' });
    return { bytes, filename: result.filename, mimeType: settings.format === 'database' ? 'application/sql' : 'application/zip', metadata: result.metadata };
  } finally {
    // The generated archive is independent of subsequent site requests.
    await runtime.runPhp(program(php, { directory, operation: 'cleanup' })).catch(() => {});
  }
}
