/** Public, restartable PHP settings shared by browser and build runtimes. */
export const PHP_SETTING_FIELDS = Object.freeze([
  { name: 'upload_max_filesize', label: 'Maximum upload', min: 1, max: 256, unit: 'MiB' },
  { name: 'post_max_size', label: 'Maximum POST body', min: 2, max: 320, unit: 'MiB' },
  { name: 'max_execution_time', label: 'Execution time', min: 5, max: 300, unit: 'seconds' },
  { name: 'max_input_time', label: 'Input time', min: 5, max: 300, unit: 'seconds' },
  { name: 'max_input_vars', label: 'Input variables', min: 1000, max: 50000, unit: 'variables' },
  { name: 'memory_limit', label: 'PHP memory', min: 128, max: 1024, unit: 'MiB' },
].map(field => Object.freeze(field)));

// JCB's 128 MiB upload guideline needs room for multipart boundaries and fields.
// Retain the already tested memory and form-variable headroom for larger packages.
export const DEFAULT_PHP_SETTINGS = Object.freeze({
  upload_max_filesize: '128M',
  post_max_size: '160M',
  max_execution_time: 60,
  max_input_time: 60,
  max_input_vars: 10000,
  memory_limit: '512M',
});

export const MAX_HTTP_BODY_BYTES = 320 * 1024 * 1024;

export function normalizePhpSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('PHP settings must be an object.');
  const allowed = new Set(PHP_SETTING_FIELDS.map(field => field.name));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new TypeError(`Unsupported PHP setting: ${key}`);
  const settings = {};
  for (const field of PHP_SETTING_FIELDS) {
    const value = input[field.name] ?? DEFAULT_PHP_SETTINGS[field.name];
    const text = String(value);
    const match = field.unit === 'MiB' ? /^(\d+)(?:M|MiB)?$/i.exec(text) : /^(\d+)$/.exec(text);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(number) || number < field.min || number > field.max) {
      throw new RangeError(`${field.name} must be ${field.min}–${field.max} ${field.unit}.`);
    }
    settings[field.name] = field.unit === 'MiB' ? `${number}M` : number;
  }
  const upload = Number.parseInt(settings.upload_max_filesize, 10);
  const post = Number.parseInt(settings.post_max_size, 10);
  const memory = Number.parseInt(settings.memory_limit, 10);
  if (post <= upload) throw new RangeError('post_max_size must exceed upload_max_filesize to allow multipart form overhead.');
  if (memory < post + 64) throw new RangeError('memory_limit must leave at least 64 MiB above post_max_size for PHP processing.');
  return settings;
}

export function phpRequestBodyLimit(settings = {}) {
  return Number.parseInt(normalizePhpSettings(settings).post_max_size, 10) * 1024 * 1024;
}

export function phpRequestTimeoutMs(settings = {}) {
  const value = normalizePhpSettings(settings);
  return Math.min(600_000, Math.max(180_000, (value.max_execution_time + value.max_input_time + 30) * 1000));
}

export function phpIni(settings = {}) {
  const values = normalizePhpSettings(settings);
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`
    + 'session.save_path=/persist/sessions\nsession.cookie_httponly=1\nsession.cookie_samesite=Lax\nsession.use_strict_mode=1\n'
    + 'expose_php=0\ndisplay_errors=0\ndisplay_startup_errors=0\nhtml_errors=0\nlog_errors=1\nerror_log=/dev/stderr\n';
}

/** Effective values come from PHP itself, not the requested configuration. */
export function runtimeHealthSource() {
  const names = PHP_SETTING_FIELDS.map(field => `'${field.name}'`).join(',');
  return `<?php
    header('Content-Type: application/json');
    $settings = []; foreach ([${names}] as $name) { $settings[$name] = ini_get($name); }
    $extensions = get_loaded_extensions(); sort($extensions);
    $functions = []; foreach (['curl_init','finfo_open','mb_strlen','imagecreatefromstring','json_encode','openssl_encrypt','sodium_crypto_secretbox','proc_open','pcntl_fork','posix_setsid'] as $name) { $functions[$name] = function_exists($name); }
    echo json_encode(['phpVersion' => PHP_VERSION, 'intSize' => PHP_INT_SIZE,
      'extensions' => $extensions, 'pdoDrivers' => PDO::getAvailableDrivers(),
      'effectivePhpSettings' => $settings, 'functions' => $functions,
      'gd' => function_exists('gd_info') ? gd_info() : null], JSON_THROW_ON_ERROR);
  `;
}

/** Supply libsodium's documented Emscripten RNG hook from Web Crypto in both hosts. */
export function runtimeRandomValue() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('A cryptographically secure random generator is required.');
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}
