import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from './assets.mjs';
import { readReleaseMetadata } from './release-metadata.mjs';

const repository = 'joomengine/mariadb-wasm-bridge';
const digest = /^[0-9a-f]{64}$/;

function asset(release, name) {
  const matches = release.assets.filter(item => item.name === name && item.state === 'uploaded');
  const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
  if (matches.length !== 1 || matches[0].browser_download_url !== expected || !/^sha256:[0-9a-f]{64}$/.test(matches[0].digest)) {
    throw new Error(`Bridge release lacks a verified ${name}`);
  }
  return { url: expected, sha256: matches[0].digest.slice(7) };
}

export function selectBridge(pins, release, manifestBytes) {
  if (release.draft || release.prerelease || !release.published_at || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
      || !/^[a-f0-9]{40}$/.test(release.target_commitish) || pins.nativeDriver.repository !== repository) {
    throw new Error('Expected a published stable MariaDB bridge release with an immutable source commit.');
  }
  const version = release.tag_name.slice(1);
  const old = pins.bridge.version.split('.').map(Number);
  const change = version.split('.').map((part, index) => Number(part) - old[index]).find(Boolean) ?? 0;
  if (change < 0) throw new Error(`Refusing bridge downgrade from ${pins.bridge.version} to ${version}`);
  const archive = asset(release, `mariadb-wasm-bridge-${version}.tar.gz`);
  const declaration = asset(release, 'bridge-manifest.json');
  if (sha256(manifestBytes) !== declaration.sha256) throw new Error('Bridge manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || manifest.bridgeVersion !== version || manifest.sourceCommit !== release.target_commitish
      || manifest.protocolVersion !== pins.bridge.protocolVersion) throw new Error('Incompatible bridge manifest identity or protocol');
  const nativeDriver = { ...pins.nativeDriver, sourceCommit: manifest.sourceCommit };
  for (const [key, directory] of [['nativeSources', 'native'], ['adapterSources', 'adapters'], ['runtimeSources', 'src']]) {
    nativeDriver[key] = Object.fromEntries(Object.keys(pins.nativeDriver[key]).map(name => {
      const hash = manifest.files?.[`${directory}/${name}`]?.sha256;
      if (!digest.test(hash)) throw new Error(`Invalid bridge source hash for ${directory}/${name}`);
      return [name, hash];
    }));
  }
  const bridge = { ...pins.bridge, version, sourceCommit: manifest.sourceCommit, ...archive };
  if (!change && (JSON.stringify(pins.bridge) !== JSON.stringify(bridge)
      || JSON.stringify(pins.nativeDriver) !== JSON.stringify(nativeDriver))) throw new Error('Published bridge version changed in place');
  return { ...pins, bridge, nativeDriver };
}

async function manifestBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Bridge download returned HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../versions.json', import.meta.url));
  const before = await readFile(file, 'utf8');
  const release = JSON.parse(await readReleaseMetadata(`https://api.github.com/repos/${repository}/releases/latest`, fetch, process.env.GITHUB_TOKEN));
  const bytes = await manifestBytes(asset(release, 'bridge-manifest.json').url);
  const pins = selectBridge(JSON.parse(before), release, bytes);
  const after = JSON.stringify(pins, null, 2) + '\n';
  if (before !== after) {
    const temporary = file + '.tmp';
    await writeFile(temporary, after);
    await rename(temporary, file);
  }
  console.log(`MariaDB bridge ${pins.bridge.version} ${before === after ? 'is current' : 'selected for validation'}.`);
}
