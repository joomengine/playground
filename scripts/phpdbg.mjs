import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';

/** Stage only the debugger extension built from this checkout and runtime pin. */
export async function stagePhpDebugHttp({ directory, destination, version, upstream }) {
  const basename = `php${version.version}-jec-phpdbg-http`;
  const file = `${basename}.so`;
  const provenance = JSON.parse(await readFile(path.join(directory, `${basename}.json`), 'utf8'));
  const sha256 = await hashFile(path.join(directory, file));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'jec_phpdbg_http'
    || provenance.phpMinor !== version.version || provenance.phpVersion !== version.patchVersion
    || provenance.upstream?.commit !== upstream.commit || provenance.upstream?.runtimeVersion !== upstream.version
    || provenance.emscriptenVersion !== upstream.emscripten || provenance.phpSource?.sha256 !== version.sourceSha256
    || provenance.extension?.file !== file || provenance.extension?.sha256 !== sha256
    || provenance.sourceSha256 !== await hashFile(fileURLToPath(new URL('../native/phpdbg/jec_phpdbg_http.c', import.meta.url)))
    || provenance.buildScriptSha256 !== await hashFile(fileURLToPath(new URL('./phpdbg-build.mjs', import.meta.url)))) {
    throw new Error(`PHP debugger HTTP extension differs from the pinned sources: ${version.version}. Rebuild the extension.`);
  }
  const licenseFile = `${basename}.LICENSE`;
  if (provenance.licenses?.length !== 1 || provenance.licenses[0].file !== licenseFile
    || await hashFile(path.join(directory, licenseFile)) !== provenance.licenses[0].sha256
    || await hashFile(fileURLToPath(new URL('../LICENSE', import.meta.url))) !== provenance.licenses[0].sha256) {
    throw new Error('PHP debugger HTTP extension license differs from its build inputs.');
  }
  for (const name of [file, `${basename}.json`, licenseFile]) await cp(path.join(directory, name), path.join(destination, name));
  return { url: `extensions/${file}`, sha256, provenance };
}
