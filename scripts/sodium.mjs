import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';

export const sodiumSource = Object.freeze({
  version: '1.0.22',
  url: 'https://github.com/jedisct1/libsodium/releases/download/1.0.22-RELEASE/libsodium-1.0.22.tar.gz',
  sha256: 'adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349',
});

export async function stageSodium({ directory, destination, version, upstream }) {
  const basename = `php${version.version}-sodium`;
  const file = `${basename}.so`;
  const provenance = JSON.parse(await readFile(path.join(directory, `${basename}.json`), 'utf8'));
  const sha256 = await hashFile(path.join(directory, file));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'sodium'
    || provenance.phpMinor !== version.version || provenance.phpVersion !== version.patchVersion
    || provenance.upstream?.commit !== upstream.commit || provenance.upstream?.runtimeVersion !== upstream.version
    || provenance.emscriptenVersion !== upstream.emscripten || provenance.phpSource?.sha256 !== version.sourceSha256
    || provenance.extension?.file !== file || provenance.extension?.sha256 !== sha256
    || JSON.stringify(provenance.sodiumSource) !== JSON.stringify(sodiumSource)
    || provenance.buildScriptSha256 !== await hashFile(fileURLToPath(new URL('./build-sodium.mjs', import.meta.url)))) {
    throw new Error(`Sodium provenance differs from the pinned PHP runtime: ${version.version}. Rebuild the extension.`);
  }
  const licenses = [`${basename}.LICENSE.php`, `${basename}.LICENSE.libsodium`];
  if (JSON.stringify(provenance.licenses?.map(entry => entry.file)) !== JSON.stringify(licenses)) throw new Error('Sodium license inventory differs from its build inputs.');
  for (const entry of provenance.licenses) {
    if (await hashFile(path.join(directory, entry.file)) !== entry.sha256) throw new Error(`Sodium license checksum mismatch: ${entry.file}`);
    await cp(path.join(directory, entry.file), path.join(destination, entry.file));
  }
  await cp(path.join(directory, file), path.join(destination, file));
  await cp(path.join(directory, `${basename}.json`), path.join(destination, `${basename}.json`));
  return { url: `extensions/${file}`, sha256, provenance };
}
