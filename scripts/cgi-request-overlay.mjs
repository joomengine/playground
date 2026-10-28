import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './assets.mjs';

const originals = {
  'breakoutRequest.mjs': '7261ccd57df432cdb67b6cf0f34426a9a73b2f15f36971ea91ee5c5faf5039d9',
  'PhpCgiBase.mjs': 'edb540f958ebd7378725a28d8b780179efa703dbf3d8e7ce74f1736561a60f9e',
};

/** Preserve upstream PHP/WASM while correcting its published JavaScript input boundary. */
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
  ];
  let runtime = input['PhpCgiBase.mjs'];
  for (const [before, after] of corrections) {
    if (runtime.split(before).length !== 2) throw new Error('Upstream CGI input structure changed; review the bounded-byte correction.');
    runtime = runtime.replace(before, after);
  }
  const decoder = await readFile(new URL('../src/cgi-request.mjs', import.meta.url), 'utf8');
  const files = [];
  for (const [file, result] of [['breakoutRequest.mjs', decoder], ['PhpCgiBase.mjs', runtime]]) {
    await writeFile(path.join(directory, file), result);
    files.push({ file, originalSha256: originals[file], sha256: sha256(result) });
  }
  return { name: 'bounded-request-body-methods', upstreamVersion: '0.2.0', files };
}
