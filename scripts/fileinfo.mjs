import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';

export async function stageFileinfo({ directory, destination, version, upstream }) {
  const basename = `php${version.version}-fileinfo`;
  const file = `${basename}.so`;
  const provenance = JSON.parse(await readFile(path.join(directory, `${basename}.json`), 'utf8'));
  const sha256 = await hashFile(path.join(directory, file));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'fileinfo'
    || provenance.phpMinor !== version.version || provenance.phpVersion !== version.patchVersion
    || provenance.upstream?.commit !== upstream.commit || provenance.upstream?.runtimeVersion !== upstream.version
    || provenance.emscriptenVersion !== upstream.emscripten || provenance.phpSource?.sha256 !== version.sourceSha256
    || provenance.extension?.file !== file || provenance.extension?.sha256 !== sha256
    || provenance.magicDatabase?.embedded !== true
    || provenance.magicDatabase?.source !== 'ext/fileinfo/data_file.c'
    || !/^[a-f0-9]{64}$/.test(provenance.magicDatabase?.sha256 || '')
    || !Array.isArray(provenance.sourceInventory)
    || provenance.sourceInventory.find(entry => entry.path === 'data_file.c')?.sha256 !== provenance.magicDatabase.sha256
    || provenance.buildScriptSha256 !== await hashFile(fileURLToPath(new URL('./build-fileinfo.mjs', import.meta.url)))) {
    throw new Error(`Fileinfo provenance differs from the pinned PHP runtime: ${version.version}. Rebuild the extension.`);
  }
  const expectedLicenses = [`${basename}.LICENSE.php`, `${basename}.LICENSE.libmagic`, `${basename}.NOTICES`];
  if (JSON.stringify(provenance.licenses?.map(entry => entry.file)) !== JSON.stringify(expectedLicenses)) {
    throw new Error('Fileinfo license inventory differs from its build inputs.');
  }
  for (const entry of provenance.licenses) {
    if (await hashFile(path.join(directory, entry.file)) !== entry.sha256) throw new Error(`Fileinfo license checksum mismatch: ${entry.file}`);
    await cp(path.join(directory, entry.file), path.join(destination, entry.file));
  }
  await cp(path.join(directory, file), path.join(destination, file));
  await cp(path.join(directory, `${basename}.json`), path.join(destination, `${basename}.json`));
  return { url: `extensions/${file}`, sha256, provenance };
}
