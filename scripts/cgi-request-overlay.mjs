import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './assets.mjs';

/** Preserve binary request bodies while using the int64 runtime's preload handling. */
export async function applyCgiRequestOverlay(directory, { manifest, upstreamVersion } = {}) {
  const input = {};
  const originals = {};
  for (const file of ['breakoutRequest.mjs', 'PhpCgiWebBase.mjs', 'PhpCgiBase.mjs']) {
    input[file] = await readFile(path.join(directory, file), 'utf8');
    originals[file] = sha256(input[file]);
    if (manifest && manifest.files[`packages/php-cgi-wasm/${file}`]?.sha256 !== originals[file]) {
      throw new Error(`CGI source differs from its verified release: ${file}.`);
    }
  }
  const replace = (source, before, after) => {
    if (source.includes(after) && !source.includes(before)) return source;
    if (source.split(before).length !== 2) throw new Error('CGI input structure changed; review the bounded-byte correction.');
    return source.replace(before, after);
  };
  const boundedInput = 'stdin: () => this.input && this.inputOffset < this.input.length ? this.input[this.inputOffset++] : null';
  let runtime = replace(input['PhpCgiBase.mjs'],
    "stdin: () => this.input\n\t\t\t\t? String(this.input.shift()).charCodeAt(0)\n\t\t\t\t: null", boundedInput);
  runtime = replace(runtime,
    "this.input = ['POST', 'PUT', 'PATCH'].includes(method) ? String(post ?? '').split('') : [];",
    'this.input = post instanceof Uint8Array ? post : new Uint8Array(0);\n\t\t\tthis.inputOffset = 0;');
  const webRuntime = replace(input['PhpCgiWebBase.mjs'],
    "stdin: () =>  this.input\n\t\t\t\t? String(this.input.shift()).charCodeAt(0)\n\t\t\t\t: null", boundedInput);
  const decoder = await readFile(new URL('../src/cgi-request.mjs', import.meta.url), 'utf8');
  const files = [];
  for (const [file, result] of [['breakoutRequest.mjs', decoder], ['PhpCgiBase.mjs', runtime], ['PhpCgiWebBase.mjs', webRuntime]]) {
    const modified = '/* Modified by JoomEngine: bounded binary CGI request input; PHP/WASM unchanged. */\n' + result;
    await writeFile(path.join(directory, file), modified);
    files.push({ file, originalSha256: originals[file], sha256: sha256(modified) });
  }
  return { name: 'bounded-request-body-methods', upstreamVersion: upstreamVersion ?? manifest?.version, files };
}
