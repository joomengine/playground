import { cp, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hashFile, sha256 } from './assets.mjs';

/** Stage reviewed bridge source changes separately from the immutable engine release. */
export async function stageBridgeOverlay({ source, destination, pins, release, engine }) {
  if (pins.sourceCommit === release.sourceCommit) return null;
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== pins.sourceCommit) {
    throw new Error('Bridge source checkout differs from its pinned commit.');
  }
  for (const [name, expected] of Object.entries(pins.nativeSources)) {
    const filename = `native/${name}`;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)
      || await hashFile(path.join(source, filename)) !== expected
      || sha256(execFileSync('git', ['show', `${pins.sourceCommit}:${filename}`], { cwd: source })) !== expected) {
      throw new Error(`Native driver source differs from its recorded bridge commit: ${name}`);
    }
  }
  const files = {
    ...Object.fromEntries(Object.entries(pins.runtimeSources).map(([name, hash]) => [`src/${name}`, hash])),
    ...Object.fromEntries(Object.entries(pins.adapterSources).map(([name, hash]) => [`adapters/${name}`, hash])),
    ...(pins.engineOverlaySources || {}),
  };
  for (const [name, expected] of Object.entries(files)) {
    if (!/^(?:src|adapters|patches|vendor\/lite4mariadb)\/[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Invalid bridge overlay path: ${name}`);
    const filename = path.join(source, name);
    if (await hashFile(filename) !== expected) throw new Error(`Bridge overlay checksum mismatch: ${name}`);
    if (!name.startsWith('vendor/')) {
      const committed = execFileSync('git', ['show', `${pins.sourceCommit}:${name}`], { cwd: source });
      if (sha256(committed) !== expected) throw new Error(`Bridge overlay differs from its recorded commit: ${name}`);
    }
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await cp(filename, path.join(destination, name));
  }
  let threadingPatch = engine.threadingPatch;
  if (pins.engineOverlaySources) {
    const wasm = path.join(destination, 'vendor/lite4mariadb/lite4mariadb.wasm');
    threadingPatch = JSON.parse(await readFile(path.join(destination, 'vendor/lite4mariadb/joomengine-patches.json'), 'utf8'));
    if (threadingPatch.originalSha256 !== engine.threadingPatch.originalSha256
      || threadingPatch.upstreamSourceCommit !== engine.threadingPatch.upstreamSourceCommit
      || threadingPatch.wasmSha256 !== await hashFile(wasm)
      || threadingPatch.patchedSha256 !== await hashFile(path.join(destination, 'vendor/lite4mariadb/lite4mariadb.js'))) {
      throw new Error('Bridge engine overlay provenance does not preserve the reviewed upstream binary.');
    }
  }
  return { sourceCommit: pins.sourceCommit, files, engine: { ...engine, threadingPatch } };
}
