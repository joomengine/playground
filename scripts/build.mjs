import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { downloadVerified, extractTarGzip, hashFile, inventory, verifyBridgeBundle } from './assets.mjs';
import { stageDeployCatalog } from './deploys.mjs';
import { stageVersionCatalog } from './version-catalog.mjs';
import { stageFileinfo } from './fileinfo.mjs';
import { stageCurl } from './curl.mjs';
import { stageSodium } from './sodium.mjs';
import { applyCgiRequestOverlay } from './cgi-request-overlay.mjs';
import { stageCodeAssets } from './code-assets.mjs';
import { stageAdminer } from './prepare-adminer.mjs';
import { validatePublicAssetRegistry, validatePublicAssetConfiguration } from '../src/public-assets.mjs';
import { validateCompatibilityConfiguration } from '../src/isolation-bootstrap.mjs';
import { stagePhpDebugHttp, applyPhpDebugWorkerOverlay } from './phpdbg.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const approvedImages = validatePublicAssetRegistry(JSON.parse(await readFile(path.join(root, 'config/public-assets.json'), 'utf8')));
const imageDelivery = validatePublicAssetConfiguration(JSON.parse(await readFile(path.join(root, 'config/public-assets-config.json'), 'utf8')));
const browserCompatibility = validateCompatibilityConfiguration(JSON.parse(await readFile(path.join(root, 'config/browser-compatibility.json'), 'utf8')));
if (!imageDelivery.registryVersions.includes(approvedImages.version)) throw new Error('The image relay configuration must support the staged registry version.');
if (browserCompatibility.fallbackEnabled && !imageDelivery.enabled) {
  throw new Error('Deploy and configure the approved-image relay before enabling the compatibility release.');
}
const domain = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim();
if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  throw new Error('CNAME must contain one valid deployment hostname.');
}
const canonicalUrl = `https://${domain}/`;
const cache = path.join(root, '.cache');
const destination = path.join(root, 'dist');
const driverDirectory = path.resolve(root, process.env.MARIADB_DRIVER_DIR || '../mariadb-wasm-bridge/.native-build/upstream');
const fileinfoDirectory = path.resolve(root, process.env.FILEINFO_EXTENSION_DIR || '.cache/fileinfo');
const sodiumDirectory = path.resolve(root, process.env.SODIUM_EXTENSION_DIR || '.cache/sodium');
const curlDirectory = path.resolve(root, process.env.CURL_EXTENSION_DIR || '.cache/curl');
const phpdbgDirectory = path.resolve(root, process.env.PHPDBG_EXTENSION_DIR || '.cache/phpdbg');
const extensionPackages = [
  'php-wasm-zlib', 'php-wasm-libxml', 'php-wasm-xml', 'php-wasm-dom',
  'php-wasm-simplexml', 'php-wasm-xmlreader', 'php-wasm-xmlwriter',
  'php-wasm-iconv', 'php-wasm-mbstring', 'php-wasm-intl',
  'php-wasm-libzip', 'php-wasm-gd', 'php-wasm-openssl',
];
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(path.join(cache, 'site-'));
const assets = path.join(staging, 'assets');
const bridgeAssetPath = `mariadb/${versions.bridge.version}`;

async function versionNativeArtifact(artifact) {
  const original = artifact.url;
  artifact.url = `extensions/${artifact.sha256}/${path.posix.basename(original)}`;
  await mkdir(path.dirname(path.join(assets, artifact.url)), { recursive: true });
  await rename(path.join(assets, original), path.join(assets, artifact.url));
  return artifact;
}

async function copyPackage(name) {
  const directory = path.join(root, 'node_modules', name);
  const installed = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const pinned = lock.packages[`node_modules/${name}`];
  if (!pinned?.integrity || installed.version !== pkg.dependencies[name] || installed.version !== pinned.version) {
    throw new Error(`Installed package differs from lock: ${name}. Run npm ci --ignore-scripts.`);
  }
  if (name.startsWith('php-') && installed.version !== versions.upstream.version) throw new Error(`Upstream package version mismatch: ${name}`);
  const target = path.join(assets, name);
  await mkdir(target, { recursive: true });
  for (const filename of await readdir(directory)) {
    if (!/\.(?:m?js|wasm|data|so|dat)$/.test(filename) && !/^(?:LICENSE(?:-GPL)?|NOTICE|package\.json)$/.test(filename)) continue;
    const source = path.join(directory, filename);
    if (!(await stat(source)).isFile()) throw new Error(`Unexpected package asset: ${name}/${filename}`);
    await cp(source, path.join(target, filename));
  }
  return { name, version: installed.version, integrity: pinned.integrity, url: pinned.resolved };
}

async function relativeLibraryFile(url) {
  const filename = fileURLToPath(url);
  const relative = path.relative(path.join(root, 'node_modules'), filename).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`Package asset outside node_modules: ${url}`);
  await stat(path.join(assets, relative));
  return relative;
}

try {
  console.log('Staging pinned upstream PHP runtime and extensions…');
  await mkdir(assets, { recursive: true });
  await stageAdminer(path.join(assets, 'adminer'));
  console.log('Bundling the lazy-loaded JoomEngine Code workbench…');
  const code = await stageCodeAssets({ root, assets });
  const packages = [];
  for (const name of ['php-cgi-wasm', 'php-dbg-wasm', ...extensionPackages]) packages.push(await copyPackage(name));
  const cgiRequestOverlay = await applyCgiRequestOverlay(path.join(assets, 'php-cgi-wasm'));
  const debuggerWorkerOverlay = await applyPhpDebugWorkerOverlay(path.join(assets, 'php-dbg-wasm'));
  const fflatePin = lock.packages['node_modules/fflate'];
  if (fflatePin?.version !== pkg.dependencies.fflate) throw new Error('fflate lock mismatch');
  await mkdir(path.join(assets, 'fflate'));
  await cp(path.join(root, 'node_modules/fflate/esm/browser.js'), path.join(assets, 'fflate/browser.js'));
  await cp(path.join(root, 'node_modules/fflate/LICENSE'), path.join(assets, 'fflate/LICENSE'));
  packages.push({ name: 'fflate', version: fflatePin.version, integrity: fflatePin.integrity, url: fflatePin.resolved });

  console.log('Verifying MariaDB release archive and every bundled file…');
  const archive = await downloadVerified(versions.bridge.url, versions.bridge.sha256,
    path.join(cache, `mariadb-${versions.bridge.version}.tar.gz`));
  const bridgeStaging = path.join(staging, 'bridge-release');
  await extractTarGzip(archive, bridgeStaging);
  const bridgeDirectory = path.join(bridgeStaging, `mariadb-wasm-bridge-${versions.bridge.version}`);
  const bridgeManifest = await verifyBridgeBundle(bridgeDirectory, versions.bridge);
  if (versions.nativeDriver.sourceCommit !== versions.bridge.sourceCommit) {
    throw new Error('Native driver sources must belong to the selected bridge release.');
  }
  for (const [filename, expected] of Object.entries(versions.nativeDriver.nativeSources)) {
    if (bridgeManifest.files[`native/${filename}`]?.sha256 !== expected) {
      throw new Error(`Bridge release source differs from the native driver pin: ${filename}`);
    }
  }
  const bridgeTarget = path.join(assets, bridgeAssetPath);
  await mkdir(bridgeTarget, { recursive: true });
  for (const filename of ['vendor', 'patches', 'LICENSE', 'NOTICE']) {
    await cp(path.join(bridgeDirectory, filename), path.join(bridgeTarget, filename), { recursive: true });
  }
  await cp(path.join(bridgeDirectory, 'bridge-manifest.json'), path.join(bridgeTarget, 'release-manifest.json'));
  for (const [directory, sourcePins] of [['src', versions.nativeDriver.runtimeSources], ['adapters', versions.nativeDriver.adapterSources]]) {
    for (const [filename, expected] of Object.entries(sourcePins)) {
      if (bridgeManifest.files[`${directory}/${filename}`]?.sha256 !== expected) {
        throw new Error(`Bridge release source differs from the native adapter pin: ${directory}/${filename}`);
      }
    }
    await cp(path.join(bridgeDirectory, directory), path.join(bridgeTarget, directory), { recursive: true });
  }
  await rm(bridgeStaging, { recursive: true });

  const php = [];
  await mkdir(path.join(assets, 'extensions'));
  for (const version of versions.php) {
    console.log(`Checking PHP ${version.version} native driver…`);
    const basename = `php${version.version}-pdo-mariadb-wasm`;
    const driver = path.join(driverDirectory, `${basename}.so`);
    const provenance = JSON.parse(await readFile(path.join(driverDirectory, `${basename}.json`), 'utf8'));
    const driverHash = await hashFile(driver);
    if (provenance.schemaVersion !== 1 || provenance.protocolVersion !== versions.bridge.protocolVersion
      || provenance.phpMinor !== version.version || provenance.phpVersion !== version.patchVersion
      || provenance.emscriptenVersion !== versions.upstream.emscripten
      || provenance.upstream?.commit !== versions.upstream.commit
      || provenance.upstream?.runtimeVersion !== versions.upstream.version
      || provenance.phpSource?.sha256 !== version.sourceSha256
      || provenance.extension?.file !== `${basename}.so` || provenance.extension?.sha256 !== driverHash) {
      throw new Error(`Native driver provenance does not match the pinned PHP runtime: ${version.version}`);
    }
    for (const filename of ['pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h', 'config.m4']) {
      if (provenance.nativeSources?.[filename] !== versions.nativeDriver.nativeSources?.[filename]) {
        throw new Error(`Native driver source differs from its pinned build source: ${filename}`);
      }
    }
    const sharedLibs = [];
    const files = [];
    for (const name of extensionPackages) {
      const helper = await import(pathToFileURL(path.join(root, 'node_modules', name, 'index.mjs')));
      for (const library of helper.getLibs({ phpVersion: version.version })) {
        sharedLibs.push({ name: library.name, url: await relativeLibraryFile(library.url), ini: library.ini === true });
      }
      for (const file of helper.getFiles?.({ phpVersion: version.version }) || []) {
        files.push({ name: file.name, parent: file.parent || path.posix.dirname(file.path || `/preload/${file.name}`), url: await relativeLibraryFile(file.url) });
      }
    }
    await cp(driver, path.join(assets, 'extensions', `${basename}.so`));
    await cp(path.join(driverDirectory, `${basename}.json`), path.join(assets, 'extensions', `${basename}.json`));
    const driverArtifact = await versionNativeArtifact({ url: `extensions/${basename}.so`, sha256: driverHash, provenance });
    sharedLibs.push({ name: `${basename}.so`, url: driverArtifact.url, ini: true });
    const fileinfo = await versionNativeArtifact(await stageFileinfo({ directory: fileinfoDirectory, destination: path.join(assets, 'extensions'), version, upstream: versions.upstream }));
    sharedLibs.push({ name: `php${version.version}-fileinfo.so`, url: fileinfo.url, ini: true });
    const curl = await versionNativeArtifact(await stageCurl({ directory: curlDirectory, destination: path.join(assets, 'extensions'), version, upstream: versions.upstream }));
    sharedLibs.push({ name: `php${version.version}-curl.so`, url: curl.url, ini: true });
    const sodium = await versionNativeArtifact(await stageSodium({ directory: sodiumDirectory, destination: path.join(assets, 'extensions'), version, upstream: versions.upstream }));
    sharedLibs.push({ name: `php${version.version}-sodium.so`, url: sodium.url, ini: true });
    const debugHttp = await versionNativeArtifact(await stagePhpDebugHttp({ directory: phpdbgDirectory, destination: path.join(assets, 'extensions'), version, upstream: versions.upstream }));
    php.push({ ...version, label: `PHP ${version.patchVersion}`, moduleUrl: 'php-cgi-wasm/PhpCgiWorker.mjs', sharedLibs, files,
      fileinfo, curl, sodium,
      debugger: { moduleUrl: 'php-dbg-wasm/PhpDbgWeb.mjs', http: debugHttp,
        sharedLibs: [...sharedLibs, { name: `php${version.version}-jec-phpdbg-http.so`, url: debugHttp.url, ini: true }] },
      driver: driverArtifact });
  }

  const joomla = [];
  await mkdir(path.join(assets, 'joomla'));
  for (const release of versions.joomla) {
    console.log(`Verifying Joomla ${release.version} distribution…`);
    const filename = `Joomla_${release.version}.zip`;
    const archive = await downloadVerified(release.url, release.sha256, path.join(cache, filename));
    await cp(archive, path.join(assets, 'joomla', filename));
    joomla.push({ ...release, sourceUrl: release.url, url: `joomla/${filename}` });
  }
  const deploys = await stageDeployCatalog({ root, staging, assets, cache, canonicalUrl });
  console.log('Staging current and forward Joomla/JCB packages…');
  const versionCatalog = await stageVersionCatalog({ assets, cache, pinnedJoomla: versions.joomla,
    stagedJoomla: joomla, deployPackages: deploys.packages });
  for (const name of ['index.html', 'src', 'config', 'service-worker.mjs', 'LICENSE', 'NOTICE', 'CNAME']) {
    await cp(path.join(root, name), path.join(staging, name), { recursive: true });
  }
  await writeFile(path.join(staging, '.nojekyll'), '');
  let sourceCommit;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { throw new Error('Build requires a Git checkout to record source provenance'); }
  const manifest = {
    schemaVersion: 1, projectVersion: pkg.version, sourceCommit, code,
    deployment: { canonicalUrl, domain },
    browserCompatibility, publicAssets: { registryVersion: approvedImages.version, enabled: imageDelivery.enabled },
    upstream: { ...versions.upstream, cgiRequestOverlay, debuggerWorkerOverlay }, nativeDriver: versions.nativeDriver, packages, php, joomla, deploys, versionCatalog,
    bridge: {
      protocolVersion: versions.bridge.protocolVersion,
      sourceCommit: versions.nativeDriver.sourceCommit,
      moduleUrl: `${bridgeAssetPath}/src/index.mjs`,
      adapterUrl: `${bridgeAssetPath}/adapters/php-wasm.mjs`,
      release: { ...versions.bridge, manifestUrl: `${bridgeAssetPath}/release-manifest.json` },
      engine: bridgeManifest.engine,
    },
    defaults: versions.defaults,
  };
  await writeFile(path.join(assets, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(staging, 'asset-inventory.json'), `${JSON.stringify(await inventory(staging), null, 2)}\n`);
  await chmod(staging, 0o755);
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  console.log(`Built ${destination} with ${php.length} PHP runtimes and ${joomla.length} Joomla distributions.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
