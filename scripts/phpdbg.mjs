import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, sha256 } from './assets.mjs';
import { matchesNativeRuntime } from './native-runtime.mjs';

const workerAssertion = 'assert(!ENVIRONMENT_IS_WORKER,"worker environment detected but not enabled at build time (add `worker` to `-sENVIRONMENT` to enable)");';

/** Complete the JS-only web/worker glue emitted by the release's Emscripten 6.0.6. */
function enableDedicatedWorker(source, manifest, file) {
  if (!source.includes(workerAssertion)) {
    if (source.includes('worker environment detected but not enabled')) throw new Error(`Review the changed debugger worker assertion: ${file}`);
    return source;
  }
  if (manifest?.emscripten?.version !== '6.0.6') throw new Error(`Review debugger worker glue for Emscripten ${manifest?.emscripten?.version}: ${file}`);
  // These are the complete generated glue differences between ENVIRONMENT=web
  // and ENVIRONMENT=web,worker for this compiler. The resulting Wasm is identical.
  // Keep the synchronous worker loader as well as the asynchronous Fetch path;
  // merely removing the environment assertion leaves that fallback unavailable.
  const changes = [
    ['{readAsync=async url=>', '{if(ENVIRONMENT_IS_WORKER){readBinary=url=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,false);xhr.responseType="arraybuffer";xhr.send(null);return new Uint8Array(xhr.response)}}readAsync=async url=>'],
    ['var domElement=specialHTMLTargets[target]||document.querySelector(target);', 'var domElement=specialHTMLTargets[target]||globalThis.document?.querySelector(target);'],
    ['targetThread>>>=0;return registerVisibilityChangeEventCallback(specialHTMLTargets[1],', 'targetThread>>>=0;if(!specialHTMLTargets[1])return-4;return registerVisibilityChangeEventCallback(specialHTMLTargets[1],'],
    [workerAssertion, ''],
  ];
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error(`Review the changed debugger worker glue: ${file}`);
    source = source.replace(before, after);
  }
  return source;
}

/** Adapt the release's web module for Playground's disposable debugger Worker. */
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
    source = enableDedicatedWorker(source, manifest, file);
    const before = 'var specialHTMLTargets=[0,document,window];';
    const after = 'var specialHTMLTargets=[0,globalThis.document??0,globalThis.window??0];';
    if (source.includes(before)) {
      if (source.split(before).length !== 2) throw new Error(`Ambiguous debugger DOM target registration: ${file}`);
      source = source.replace(before, after);
    } else if (!source.includes(after)) throw new Error(`Review the changed debugger DOM target registration: ${file}`);
    if (sha256(source) !== originalSha256) {
      source = '/* Modified by JoomEngine: Emscripten dedicated-worker loading and optional DOM targets; PHP/WASM unchanged. */\n' + source;
      await writeFile(path.join(directory, file), source);
    }
    files.push({ file, originalSha256, sha256: sha256(source) });
  }
  return { name: 'phpdbg-dedicated-worker', upstreamVersion,
    buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)), files };
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
