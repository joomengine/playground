import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';
import { nativeBuildContext, nativeProvenance, nativeRoot as root } from './native-runtime.mjs';

const context = await nativeBuildContext(process.argv[2]);
const { pins, version } = context;
const bridge = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || 'external/bridge');
const native = path.join(bridge, 'native');
const output = path.resolve(root, process.argv[3] || '.cache/native');
const nativeSources = {};
for (const [name, expected] of Object.entries(pins.nativeDriver.nativeSources)) {
  nativeSources[name] = await hashFile(path.join(native, name));
  if (nativeSources[name] !== expected) throw new Error(`MariaDB native source differs from its pinned input: ${name}`);
}
const basename = `php${version.version}-pdo-mariadb-wasm`;
const flags = [...context.flags, '-flto', '-DCOMPILE_DL_PDO_MARIADB_WASM=1'];
await mkdir(output, { recursive: true });
execFileSync('emcc', [...flags, ...[...context.includes, native].map(directory => `-I${directory}`),
  path.join(native, 'pdo_mariadb_wasm.c'), '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
const license = `${basename}.LICENSE`;
await cp(path.join(bridge, 'LICENSE'), path.join(output, license));
const provenance = {
  schemaVersion: 1, protocolVersion: pins.bridge.protocolVersion, ...nativeProvenance(context), nativeSources, flags,
  buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
  licenses: [{ file: license, sha256: await hashFile(path.join(output, license)) }],
  extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
};
await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built ${basename}.so against PHP ${version.patchVersion} int64.`);
