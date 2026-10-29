import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, sha256 } from './assets.mjs';

const workerOriginals = {
  'php8.3-dbg-web.mjs': 'ef7ff06e6ee4c3569ae80da8fbc6558b734e9b5d426747b22105ab2451102f49',
  'php8.4-dbg-web.mjs': 'fae40f998ac8df21b5a9af0b7524e0dfb6d4963a0e240d0298739dc6ad865842',
  'php8.5-dbg-web.mjs': 'b4ad4a4c70bd8d5794641cf94fd5710487453704f100ba9e03b9c04d0ca5f8c3',
};

/** The pinned web build eagerly registers DOM targets even in a worker. */
export async function applyPhpDebugWorkerOverlay(directory) {
  const prepared = [];
  for (const [file, expected] of Object.entries(workerOriginals)) {
    let source = await readFile(path.join(directory, file), 'utf8');
    if (sha256(source) !== expected) throw new Error(`Review the upstream debugger worker correction for ${file}.`);
    for (const [before, after] of [
      ['var ENVIRONMENT_IS_WEB=true;var ENVIRONMENT_IS_WORKER=false;',
        'var ENVIRONMENT_IS_WEB=typeof window!=="undefined";var ENVIRONMENT_IS_WORKER=typeof WorkerGlobalScope!=="undefined";'],
      ['var specialHTMLTargets=[0,document,window];', 'var specialHTMLTargets=[0,globalThis.document,globalThis.window];'],
    ]) {
      if (source.split(before).length !== 2) throw new Error(`Upstream debugger worker structure changed in ${file}.`);
      source = source.replace(before, after);
    }
    prepared.push({ file, source: `/* Modified by JoomEngine: worker environment and optional DOM target registration; PHP/WASM unchanged. */\n${source}` });
  }
  const files = [];
  for (const { file, source } of prepared) {
    await writeFile(path.join(directory, file), source);
    files.push({ file, originalSha256: workerOriginals[file], sha256: sha256(source) });
  }
  return { name: 'phpdbg-dedicated-worker', upstreamVersion: '0.2.0', files };
}

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
