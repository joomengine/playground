import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './assets.mjs';

const originals = {
  'breakoutRequest.mjs': '7261ccd57df432cdb67b6cf0f34426a9a73b2f15f36971ea91ee5c5faf5039d9',
  'PhpCgiWebBase.mjs': '1a39e22b5cad70d8f233844024de53460ad9d48a1e1cbdccb00ff9a348c1c81e',
  'PhpCgiBase.mjs': 'edb540f958ebd7378725a28d8b780179efa703dbf3d8e7ce74f1736561a60f9e',
};

/** Preserve upstream PHP/WASM while correcting its JavaScript input and preload boundaries. */
export async function applyCgiRequestOverlay(directory) {
  const input = {};
  for (const [file, expected] of Object.entries(originals)) {
    input[file] = await readFile(path.join(directory, file), 'utf8');
    if (sha256(input[file]) !== expected) throw new Error(`Review the upstream CGI request correction for ${file}.`);
  }
  const corrections = [
    ["stdin: () => this.input\n\t\t\t\t? String(this.input.shift()).charCodeAt(0)\n\t\t\t\t: null",
      "stdin: () => this.input && this.inputOffset < this.input.length ? this.input[this.inputOffset++] : null"],
    ["this.input = ['POST', 'PUT', 'PATCH'].includes(method) ? String(post ?? '').split('') : [];",
      "this.input = post instanceof Uint8Array ? post : new Uint8Array(0);\n\t\t\tthis.inputOffset = 0;"],
    ["await Promise.all(allFiles.map(fileDef => php.FS.createPreloadedFile(\n\t\t\t\tfileDef.parent, fileDef.name, userLocateFile(fileDef.url) ?? fileDef.url, true, false\n\t\t\t)));",
      "await Promise.all(allFiles.map(fileDef => new Promise((resolve, reject) => {\n\t\t\t\tphp.FS.createPreloadedFile(fileDef.parent, fileDef.name, userLocateFile(fileDef.url) ?? fileDef.url, true, false, resolve,\n\t\t\t\t\terror => reject(new Error(`Unable to preload ${fileDef.parent}/${fileDef.name}: ${error?.message ?? error?.errno ?? 'load failed'}`)));\n\t\t\t})));"],
  ];
  let runtime = input['PhpCgiBase.mjs'];
  for (const [before, after] of corrections) {
    if (runtime.split(before).length !== 2) throw new Error('Upstream CGI structure changed; review the input and preload corrections.');
    runtime = runtime.replace(before, after);
  }
  const webBefore = "stdin: () =>  this.input\n\t\t\t\t? String(this.input.shift()).charCodeAt(0)\n\t\t\t\t: null";
  if (input['PhpCgiWebBase.mjs'].split(webBefore).length !== 2) throw new Error('Upstream browser CGI input structure changed; review the bounded-byte correction.');
  let webRuntime = input['PhpCgiWebBase.mjs'].replace(webBefore, corrections[0][1]);
  const webPreload = "await Promise.all(allFiles.map(\n\t\t\t\tfileDef => php.FS.createPreloadedFile(fileDef.parent, fileDef.name, fileDef.url, true, false)\n\t\t\t));";
  if (webRuntime.split(webPreload).length !== 2) throw new Error('Upstream browser preload structure changed; review the callback correction.');
  webRuntime = webRuntime.replace(webPreload, corrections[2][1].replace('userLocateFile(fileDef.url) ?? fileDef.url', 'fileDef.url'));
  const decoder = await readFile(new URL('../src/cgi-request.mjs', import.meta.url), 'utf8');
  const files = [];
  for (const [file, result] of [['breakoutRequest.mjs', decoder], ['PhpCgiBase.mjs', runtime], ['PhpCgiWebBase.mjs', webRuntime]]) {
    const modified = '/* Modified by JoomEngine: bounded binary CGI input and awaited file preloads; PHP/WASM unchanged. */\n' + result;
    await writeFile(path.join(directory, file), modified);
    files.push({ file, originalSha256: originals[file], sha256: sha256(modified) });
  }
  return { name: 'bounded-request-body-methods-and-preloads', upstreamVersion: '0.2.0', files };
}
