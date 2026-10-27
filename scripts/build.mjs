import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { downloadVerified, extractTarGzip, hashFile, inventory, verifyBridgeBundle } from './assets.mjs';
import { stageBlueprintCatalog } from './blueprints.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const domain = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim();
if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  throw new Error('CNAME must contain one valid deployment hostname.');
}
const canonicalUrl = `https://${domain}/`;
const cache = path.join(root, '.cache');
const destination = path.join(root, 'dist');
const driverDirectory = path.resolve(root, process.env.MARIADB_DRIVER_DIR || '../mariadb-wasm-bridge/.native-build/upstream');
const bridgeSourceDirectory = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || '../mariadb-wasm-bridge');
const extensionPackages = [
  'php-wasm-zlib', 'php-wasm-libxml', 'php-wasm-xml', 'php-wasm-dom',
  'php-wasm-simplexml', 'php-wasm-xmlreader', 'php-wasm-xmlwriter',
  'php-wasm-iconv', 'php-wasm-mbstring', 'php-wasm-intl',
  'php-wasm-libzip', 'php-wasm-gd', 'php-wasm-openssl',
];
await mkdir(cache, { recursive: true });
const staging = await mkdtemp(path.join(cache, 'site-'));
const assets = path.join(staging, 'assets');

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
  const packages = [];
  for (const name of ['php-cgi-wasm', ...extensionPackages]) packages.push(await copyPackage(name));
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
  const bridgeTarget = path.join(assets, 'mariadb');
  await mkdir(bridgeTarget);
  for (const filename of ['vendor', 'patches', 'LICENSE', 'NOTICE']) {
    await cp(path.join(bridgeDirectory, filename), path.join(bridgeTarget, filename), { recursive: true });
  }
  await cp(path.join(bridgeDirectory, 'bridge-manifest.json'), path.join(bridgeTarget, 'release-manifest.json'));
  const runtimeFiles = await inventory(path.join(bridgeSourceDirectory, 'src'));
  const runtimePins = versions.nativeDriver.runtimeSources;
  if (!runtimePins || Object.keys(runtimePins).length !== runtimeFiles.length) {
    throw new Error('Bridge runtime source inventory differs from its pinned source');
  }
  for (const file of runtimeFiles) {
    if (runtimePins[file.path] !== file.sha256) throw new Error(`Bridge runtime differs from its pinned source: ${file.path}`);
    const target = path.join(bridgeTarget, 'src', file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(bridgeSourceDirectory, 'src', file.path), target);
  }
  await mkdir(path.join(bridgeTarget, 'adapters'));
  for (const filename of ['php-wasm.mjs', 'php-wasm.php']) {
    const source = path.join(bridgeSourceDirectory, 'adapters', filename);
    if (await hashFile(source) !== versions.nativeDriver.adapterSources?.[filename]) {
      throw new Error(`Bridge adapter differs from its pinned source: ${filename}`);
    }
    await cp(source, path.join(bridgeTarget, 'adapters', filename));
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
    sharedLibs.push({ name: `${basename}.so`, url: `extensions/${basename}.so`, ini: true });
    php.push({ ...version, label: `PHP ${version.patchVersion}`, moduleUrl: 'php-cgi-wasm/PhpCgiWorker.mjs', sharedLibs, files,
      driver: { url: `extensions/${basename}.so`, sha256: driverHash, provenance } });
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
  const blueprints = await stageBlueprintCatalog({ root, staging, assets, cache, canonicalUrl });
  for (const name of ['index.html', 'src', 'service-worker.mjs', 'LICENSE', 'NOTICE', 'CNAME']) {
    await cp(path.join(root, name), path.join(staging, name), { recursive: true });
  }
  await writeFile(path.join(staging, '.nojekyll'), '');
  let sourceCommit;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { throw new Error('Build requires a Git checkout to record source provenance'); }
  const manifest = {
    schemaVersion: 1, projectVersion: pkg.version, sourceCommit,
    deployment: { canonicalUrl, domain },
    upstream: versions.upstream, nativeDriver: versions.nativeDriver, packages, php, joomla, blueprints,
    bridge: {
      protocolVersion: versions.bridge.protocolVersion,
      sourceCommit: versions.nativeDriver.sourceCommit,
      moduleUrl: 'mariadb/src/index.mjs',
      adapterUrl: 'mariadb/adapters/php-wasm.mjs',
      release: { ...versions.bridge, manifestUrl: 'mariadb/release-manifest.json' },
      overlay: {
        sourceCommit: versions.nativeDriver.sourceCommit,
        runtimeSources: versions.nativeDriver.runtimeSources,
        adapterSources: versions.nativeDriver.adapterSources,
      },
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
