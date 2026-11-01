import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, sha256 } from './assets.mjs';
import { matchesNativeRuntime } from './native-runtime.mjs';

/** Emscripten's web build still references optional DOM targets in a worker. */
export async function applyPhpDebugWorkerOverlay(directory, { minor, upstreamVersion, manifest } = {}) {
  const selected = minor ? [`php${minor}-dbg-web.mjs`]
    : (await readdir(directory)).filter(file => /^php\d+\.\d+-dbg-web\.mjs$/.test(file));
  if (!selected.length) throw new Error('No PHP debugger web module was supplied.');
  const files = [];
  for (const file of selected) {
    let source = await readFile(path.join(directory, file), 'utf8');
    const originalSha256 = sha256(source);
    const declared = manifest?.files?.[`packages/php-dbg-wasm/${file}`]?.sha256;
    if (manifest && declared !== originalSha256) throw new Error(`Debugger source differs from its release manifest: ${file}`);
    const legacyEnvironment = 'var ENVIRONMENT_IS_WEB=true;var ENVIRONMENT_IS_WORKER=false;';
    const environment = 'var ENVIRONMENT_IS_WEB=!!globalThis.window;var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;';
    if (source.includes(legacyEnvironment)) {
      if (source.split(legacyEnvironment).length !== 2) throw new Error(`Ambiguous debugger worker environment: ${file}`);
      source = source.replace(legacyEnvironment, environment);
    } else if (!source.includes(environment)) throw new Error(`Review the changed debugger worker environment: ${file}`);
    const before = 'var specialHTMLTargets=[0,document,window];';
    const after = 'var specialHTMLTargets=[0,globalThis.document,globalThis.window];';
    if (source.includes(before)) {
      if (source.split(before).length !== 2) throw new Error(`Ambiguous debugger DOM target registration: ${file}`);
      source = source.replace(before, after);
    } else if (!source.includes(after)) throw new Error(`Review the changed debugger DOM target registration: ${file}`);
    if (sha256(source) !== originalSha256) {
      source = '/* Modified by JoomEngine: optional DOM targets for a dedicated worker; PHP/WASM unchanged. */\n' + source;
      await writeFile(path.join(directory, file), source);
    }
    files.push({ file, originalSha256, sha256: sha256(source) });
  }
  return { name: 'phpdbg-dedicated-worker', upstreamVersion, files };
}

/** Stage only the debugger extension built from this checkout and runtime pin. */
export async function stagePhpDebugHttp({ directory, destination, version, upstream }) {
  const basename = `php${version.version}-jec-phpdbg-http`;
  const file = `${basename}.so`;
  const provenance = JSON.parse(await readFile(path.join(directory, `${basename}.json`), 'utf8'));
  const sha256 = await hashFile(path.join(directory, file));
  if (provenance.schemaVersion !== 1 || provenance.name !== 'jec_phpdbg_http'
    || !await matchesNativeRuntime(provenance, version, upstream)
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
