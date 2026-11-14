import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './assets.mjs';

const constructorBefore = "constructor(code, message, { errno = 0, sqlstate = 'HY000', cause } = {})";
const constructorAfter = "constructor(code, message, { errno = 0, sqlstate = 'HY000', cause, name = 'MariaDBBridgeError', originalCode } = {})";
const identityBefore = "    this.name = 'MariaDBBridgeError';\n    this.code = code;";
const identityAfter = "    this.name = name;\n    this.code = code;\n    if (originalCode !== undefined) this.originalCode = originalCode;";
const recordBefore = `export function errorRecord(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'DATABASE_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Database operation failed',`;
const recordAfter = `export function errorRecord(error) {
  const name = typeof error?.name === 'string' && error.name.trim() ? error.name : 'MariaDBBridgeError';
  const originalCode = error?.originalCode ?? error?.code;
  return {
    name,
    ...(typeof originalCode === 'string' || Number.isSafeInteger(originalCode) ? { originalCode } : {}),
    code: typeof error?.code === 'string' ? error.code : 'DATABASE_ERROR',
    message: typeof error?.message === 'string' && error.message.trim() ? error.message
      : name === 'QuotaExceededError' ? 'Browser storage rejected the database save because its storage limit was reached.'
        : 'Database operation failed (' + name + ').',`;

const timeoutBefore = "      const timer = setTimeout(() => {\n        this.#kill(new MariaDBBridgeError('TIMEOUT', `MariaDB ${operation} timed out after ${timeout} ms; its worker was terminated`));\n      }, timeout);";
const timeoutAfter = "      const timer = setTimeout(() => {\n        if (operation === 'flush') {\n          // A pending IndexedDB commit cannot be cancelled by killing its\n          // owner. Retain the worker and queue until the save actually settles.\n          console.warn('MariaDB saving is taking longer than expected; its worker and pending changes have been retained.');\n          return;\n        }\n        this.#kill(new MariaDBBridgeError('TIMEOUT', `MariaDB ${operation} timed out after ${timeout} ms; its worker was terminated`));\n      }, timeout);";

/** Preserve storage error identities and keep slow saves from destroying the live database. */
export async function applyBridgeErrorOverlay(directory, { manifest, upstreamVersion } = {}) {
  const originals = {};
  const input = {};
  for (const file of ['src/errors.mjs', 'src/index.mjs']) {
    input[file] = await readFile(path.join(directory, file), 'utf8');
    originals[file] = sha256(input[file]);
    if (manifest?.files?.[file]?.sha256 !== originals[file]) {
      throw new Error(`MariaDB error source differs from its verified release: ${file}.`);
    }
  }
  // The receiver normalizes the serialized record a second time and passes
  // all its fields to this constructor. Verify that boundary before patching.
  const receive = 'const record = errorRecord(message.error);\n      const error = new MariaDBBridgeError(record.code, record.message, record);';
  if (input['src/index.mjs'].split(receive).length !== 2) {
    throw new Error('MariaDB error receiver changed; review storage error reconstruction.');
  }
  let result = input['src/errors.mjs'];
  for (const [before, after] of [[constructorBefore, constructorAfter], [identityBefore, identityAfter], [recordBefore, recordAfter]]) {
    if (result.split(before).length !== 2) throw new Error('MariaDB error structure changed; review storage error preservation.');
    result = result.replace(before, after);
  }
  if (input['src/index.mjs'].split(timeoutBefore).length !== 2) {
    throw new Error('MariaDB timeout structure changed; review persistence lifetime.');
  }
  const outputs = {
    'src/errors.mjs': result,
    'src/index.mjs': input['src/index.mjs'].replace(timeoutBefore, timeoutAfter),
  };
  const files = [];
  for (const [file, output] of Object.entries(outputs)) {
    const modified = '/* Modified by JoomEngine: preserve browser storage errors and pending saves; protocol and WASM unchanged. */\n' + output;
    await writeFile(path.join(directory, file), modified);
    files.push({ file, originalSha256: originals[file], sha256: sha256(modified) });
  }
  return {
    name: 'browser-storage-errors-and-save-lifetime', upstreamVersion,
    verifiedSources: originals,
    files,
  };
}

/** Changed bridge JavaScript needs a distinct URL for its entire relative-import graph. */
export function bridgeRuntimeAssetPath(version, archiveSha256, overlay) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || !/^[a-f0-9]{64}$/.test(archiveSha256)) {
    throw new Error('Invalid MariaDB runtime asset identity.');
  }
  if (!Array.isArray(overlay?.files) || !overlay.files.length) throw new Error('Missing MariaDB overlay outputs.');
  const files = overlay.files.map(({ file, sha256: digest }) => {
    if (typeof file !== 'string' || !/^src\/[A-Za-z0-9._-]+\.mjs$/.test(file) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Invalid MariaDB overlay output.');
    }
    return [file, digest];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(files.map(([file]) => file)).size !== files.length) throw new Error('MariaDB overlay outputs must be unique.');
  return `mariadb/${version}/${sha256(JSON.stringify({ archiveSha256, files }))}`;
}
