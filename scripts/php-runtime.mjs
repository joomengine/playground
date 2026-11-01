import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, extractTarGzip, inventory, sha256 } from './assets.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = 'joomengine/php-wasm-int64';
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const packageNames = ['php-wasm', 'php-cgi-wasm', 'php-cli-wasm', 'php-dbg-wasm',
  'zlib', 'libxml', 'xml', 'dom', 'simplexml', 'xmlreader', 'xmlwriter', 'iconv', 'mbstring', 'intl', 'libzip', 'gd', 'openssl', 'phar', 'sqlite'];

export const phpRuntimeSelectionPath = root => path.join(root, '.cache/php-int64/resolved.json');
export const phpRuntimeDirectory = (root, archive) => path.join(root, '.cache/php-int64', archive.sha256, `php-${archive.minor}`);

function requireConfiguration(versions) {
  if (versions.runtime?.repository !== repository || versions.runtime?.release !== 'latest') {
    throw new Error('PHP runtime configuration must select the latest stable JoomEngine int64 release.');
  }
  const minors = versions.php?.map(item => item.version);
  if (!minors?.length || new Set(minors).size !== minors.length || minors.some(minor => !/^8\.\d+$/.test(minor))) {
    throw new Error('PHP runtime configuration requires distinct supported PHP minor versions.');
  }
  return minors;
}

/** Validate release metadata before trusting any executable package in its archive. */
export function validatePhpRuntimeManifest(manifest, { minor, version }) {
  if (manifest.schemaVersion !== 1 || manifest.name !== 'php-wasm-int64' || manifest.version !== version
    || manifest.php?.minor !== minor || !new RegExp(`^${minor.replace('.', '\\.')}\\.\\d+$`).test(manifest.php?.version ?? '')
    || !commitPattern.test(manifest.php?.commit ?? '') || !commitPattern.test(manifest.upstream?.commit ?? '')
    || !hashPattern.test(manifest.fingerprint ?? '') || manifest.build?.fingerprint !== manifest.fingerprint
    || manifest.abi?.integerBits !== 64 || manifest.abi?.pointerBits !== 32 || manifest.abi?.define !== 'ZEND_WASM_INT64=1'
    || !/^\d+\.\d+\.\d+$/.test(manifest.emscripten?.version ?? '')
    || !/@sha256:[a-f0-9]{64}$/.test(manifest.emscripten?.image ?? '')) {
    throw new Error(`PHP ${minor} release manifest has an incompatible runtime identity.`);
  }
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('PHP release has no file inventory.');
  for (const [name, file] of Object.entries(files)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')
      || !hashPattern.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Invalid PHP release inventory entry: ${name}`);
    }
  }
  for (const name of ['LICENSE', 'NOTICE', 'include/main/php_config.h', 'include/Zend/zend_long.h',
    'build-inputs/versions.json', ...packageNames.map(pkg => `packages/${pkg}/package.json`)]) {
    if (!Object.hasOwn(files, name)) throw new Error(`PHP release is missing ${name}.`);
  }
  return manifest;
}

export async function verifyPhpRuntimeArchive(directory, expected) {
  const bytes = await readFile(path.join(directory, 'manifest.json'));
  if (expected.manifestSha256 && sha256(bytes) !== expected.manifestSha256) throw new Error('PHP release manifest changed after resolution.');
  const manifest = validatePhpRuntimeManifest(JSON.parse(bytes), expected);
  const actual = (await inventory(directory)).filter(file => file.path !== 'manifest.json');
  if (actual.length !== Object.keys(manifest.files).length) throw new Error('PHP release inventory differs from its manifest.');
  for (const file of actual) {
    const expected = manifest.files[file.path];
    if (!expected || expected.size !== file.size || expected.sha256 !== file.sha256) {
      throw new Error(`PHP release file differs from its manifest: ${file.path}`);
    }
  }
  const config = await readFile(path.join(directory, 'include/main/php_config.h'), 'utf8');
  if (!/^#define ZEND_WASM_INT64 1$/m.test(config)) throw new Error('PHP SDK headers are missing the int64 ABI marker.');
  return { manifest, manifestSha256: sha256(bytes) };
}

async function prepareArchive(root, archive, version) {
  const directory = phpRuntimeDirectory(root, archive);
  const expected = { ...archive, version };
  try { return { directory, ...await verifyPhpRuntimeArchive(directory, expected) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cache = path.join(root, '.cache/php-int64');
  const filename = await downloadVerified(archive.url, archive.sha256, path.join(cache, `${archive.sha256}.tar.gz`));
  const staging = await mkdtemp(path.join(cache, 'extract-'));
  try {
    await extractTarGzip(filename, staging, { maxOutputLength: 512 * 1024 * 1024 });
    const prepared = await verifyPhpRuntimeArchive(path.join(staging, `php-${archive.minor}`), expected);
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(path.join(staging, `php-${archive.minor}`), directory);
    return { directory, ...prepared };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function validateSelection(selection, versions) {
  const minors = requireConfiguration(versions);
  if (selection.schemaVersion !== 1 || selection.repository !== repository || !/^\d+\.\d+\.\d+$/.test(selection.version ?? '')
    || selection.tag !== `v${selection.version}` || !commitPattern.test(selection.commit ?? '')
    || selection.url !== `https://github.com/${repository}/releases/tag/${selection.tag}`
    || !Array.isArray(selection.archives) || selection.archives.length !== minors.length) {
    throw new Error('Invalid resolved PHP release. Run npm run prepare:php before rebuilding native extensions.');
  }
  for (const minor of minors) {
    const records = selection.archives.filter(archive => archive.minor === minor);
    const archive = records[0];
    const name = `php-wasm-int64-${selection.version}-php${minor}.tar.gz`;
    if (records.length !== 1 || archive.name !== name || !hashPattern.test(archive.sha256 ?? '')
      || !hashPattern.test(archive.manifestSha256 ?? '') || !hashPattern.test(archive.fingerprint ?? '')
      || archive.url !== `https://github.com/${repository}/releases/download/${selection.tag}/${name}`) {
      throw new Error(`Resolved PHP ${minor} archive is missing or inconsistent.`);
    }
  }
  return selection;
}

/** Resolve once at the beginning of a build; all later stages consume this selection. */
export async function resolvePhpRuntime({ root = projectRoot, versions, fetchImpl = fetch } = {}) {
  versions ??= JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
  const minors = requireConfiguration(versions);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Unable to resolve the stable PHP int64 release (${response.status}).`);
  const release = await response.json();
  if (release.draft || release.prerelease || !release.published_at || !/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')
    || !commitPattern.test(release.target_commitish ?? '')) throw new Error('Latest PHP int64 release is not a published stable version with an exact source commit.');
  const version = release.tag_name.slice(1);
  const selection = { schemaVersion: 1, repository, version, tag: release.tag_name, commit: release.target_commitish,
    url: `https://github.com/${repository}/releases/tag/${release.tag_name}`, archives: [] };
  for (const minor of minors) {
    const name = `php-wasm-int64-${version}-php${minor}.tar.gz`;
    const matching = release.assets?.filter(asset => asset.name === name) ?? [];
    const asset = matching[0];
    const url = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
    if (matching.length !== 1 || asset.state !== 'uploaded' || asset.browser_download_url !== url
      || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error(`Stable PHP release lacks a verified archive for ${minor}.`);
    const archive = { minor, name, url, sha256: asset.digest.slice(7) };
    const { manifest, manifestSha256 } = await prepareArchive(root, archive, version);
    selection.archives.push({ ...archive, manifestSha256, php: manifest.php, fingerprint: manifest.fingerprint,
      upstream: manifest.upstream, emscripten: manifest.emscripten, abi: manifest.abi });
  }
  validateSelection(selection, versions);
  const filename = phpRuntimeSelectionPath(root);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`);
  await rename(temporary, filename);
  return selection;
}

/** Load the existing build selection; never resolve another release midway through a build. */
export async function loadPhpRuntime({ root = projectRoot, versions, minor } = {}) {
  versions ??= JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
  let selection;
  try { selection = validateSelection(JSON.parse(await readFile(phpRuntimeSelectionPath(root), 'utf8')), versions); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('PHP runtime is not prepared. Run npm run prepare:php before compiling native extensions.', { cause: error });
    throw error;
  }
  if (minor && !selection.archives.some(archive => archive.minor === minor)) throw new Error(`Unsupported PHP ${minor}.`);
  const first = selection.archives[0];
  const php = [];
  for (const archive of selection.archives) {
    const directory = phpRuntimeDirectory(root, archive);
    let manifest;
    if (!minor || archive.minor === minor) {
      ({ manifest } = await prepareArchive(root, archive, selection.version));
      if (JSON.stringify(manifest.php) !== JSON.stringify(archive.php) || manifest.fingerprint !== archive.fingerprint
        || JSON.stringify(manifest.upstream) !== JSON.stringify(archive.upstream)
        || JSON.stringify(manifest.emscripten) !== JSON.stringify(archive.emscripten)) throw new Error('Resolved PHP identity differs from its verified archive.');
    }
    if (JSON.stringify(archive.upstream) !== JSON.stringify(first.upstream)
      || JSON.stringify(archive.emscripten) !== JSON.stringify(first.emscripten)) throw new Error('PHP release mixes incompatible upstream builds or compilers.');
    php.push({ version: archive.minor, patchVersion: archive.php.version, sourceCommit: archive.php.commit,
      runtimeFingerprint: archive.fingerprint, runtimeArchiveSha256: archive.sha256,
      runtimeVersion: selection.version, runtimeDirectory: directory, sdkDirectory: path.join(directory, 'include'), manifest });
  }
  return { ...versions, runtime: selection,
    upstream: { ...first.upstream, emscripten: first.emscripten.version, emscriptenImage: first.emscripten.image }, php };
}

export async function runtimePackage(minor, packageName, { root = projectRoot } = {}) {
  if (!packageNames.includes(packageName)) throw new Error(`Unknown PHP runtime package: ${packageName}`);
  const runtime = await loadPhpRuntime({ root, minor });
  return path.join(runtime.php.find(entry => entry.version === minor).runtimeDirectory, 'packages', packageName);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'resolve') throw new Error('Usage: node scripts/php-runtime.mjs resolve');
  const selection = await resolvePhpRuntime();
  console.log(`Prepared PHP int64 ${selection.version}: ${selection.archives.map(archive => archive.php.version).join(', ')}`);
}
