import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';
import { matchesNativeRuntime } from './native-runtime.mjs';

export const curlSource = Object.freeze({
  repository: 'https://github.com/seanmorris/php-wasm-curl',
  commit: '6085917954da9682c32ebcbea27a626d2308381b',
  url: 'https://codeload.github.com/seanmorris/php-wasm-curl/tar.gz/6085917954da9682c32ebcbea27a626d2308381b',
  sha256: 'c27dbc1d9e9b1099b1db707544057bd554dc3c200cb38d2dadb249e374166203',
});

export async function stageCurl({ directory, destination, version, upstream }) {
  const basename = `php${version.version}-curl`;
  const file = `${basename}.so`;
  const provenance = JSON.parse(await readFile(path.join(directory, `${basename}.json`), 'utf8'));
  const sha256 = await hashFile(path.join(directory, file));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'curl'
    || !await matchesNativeRuntime(provenance, version, upstream)
    || provenance.nativePatchSha256 !== await hashFile(fileURLToPath(new URL('../native/curl-int64.patch', import.meta.url)))
    || Object.entries(curlSource).some(([key, value]) => provenance.curlSource?.[key] !== value)
    || provenance.extension?.file !== file || provenance.extension?.sha256 !== sha256
    || !Array.isArray(provenance.phpSourceInventory) || !Array.isArray(provenance.curlSourceInventory)
    || !/^[a-f0-9]{64}$/.test(provenance.phpSourceInventory?.find(entry => entry.path === 'interface.c')?.sha256 || '')
    || !/^[a-f0-9]{64}$/.test(provenance.curlSourceInventory?.find(entry => entry.path === 'src/fetch_js.c')?.sha256 || '')
    || provenance.httpStreams?.sourceSha256 !== await hashFile(fileURLToPath(new URL('../native/http-stream.c', import.meta.url)))
    || !/^[a-f0-9]{64}$/.test(provenance.httpStreams?.originalInterfaceSha256 || '')
    || provenance.httpStreams?.interfaceSha256 !== provenance.phpSourceInventory?.find(entry => entry.path === 'interface.c')?.sha256
    || provenance.buildScriptSha256 !== await hashFile(fileURLToPath(new URL('./build-curl.mjs', import.meta.url)))) {
    throw new Error(`Curl provenance differs from the pinned PHP runtime: ${version.version}. Rebuild the extension.`);
  }
  const expectedLicenses = ['LICENSE.php', 'LICENSE', 'LICENSE-GPL', 'COPYING.curl', 'NOTICE'].map(name => `${basename}.${name}`);
  if (JSON.stringify(provenance.licenses?.map(entry => entry.file)) !== JSON.stringify(expectedLicenses)) {
    throw new Error('Curl license inventory differs from its build inputs.');
  }
  for (const entry of provenance.licenses) {
    if (await hashFile(path.join(directory, entry.file)) !== entry.sha256) throw new Error(`Curl license checksum mismatch: ${entry.file}`);
    await cp(path.join(directory, entry.file), path.join(destination, entry.file));
  }
  await cp(path.join(directory, file), path.join(destination, file));
  await cp(path.join(directory, `${basename}.json`), path.join(destination, `${basename}.json`));
  return { url: `extensions/${file}`, sha256, provenance };
}
