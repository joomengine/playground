import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';
import { nativeBuildContext, nativeProvenance, preparePhpNativeSource, nativeRoot as root } from './native-runtime.mjs';

const context = await nativeBuildContext(process.argv[2]);
const { version } = context;
const source = await preparePhpNativeSource(version);
const output = path.resolve(root, process.argv[3] || '.cache/phpdbg');
const extensionSource = path.join(root, 'native/phpdbg/jec_phpdbg_http.c');
const flags = [...context.flags, '-flto', '-DCOMPILE_DL_JEC_PHPDBG_HTTP=1'];
// Installed PHP headers supply the exact ABI. The source checkout supplies
// phpdbg's internal declarations, which are not part of PHP's installed SDK.
const includes = [...context.includes, source, path.join(source, 'sapi/phpdbg')].map(directory => `-I${directory}`);
await mkdir(output, { recursive: true });
const basename = `php${version.version}-jec-phpdbg-http`;
execFileSync('emcc', [...flags, ...includes, extensionSource, '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
const licenseFile = `${basename}.LICENSE`;
await cp(path.join(root, 'LICENSE'), path.join(output, licenseFile));
const provenance = {
  schemaVersion: 1, name: 'jec_phpdbg_http', ...nativeProvenance(context),
  sourceSha256: await hashFile(extensionSource), buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)), flags,
  licenses: [{ file: licenseFile, sha256: await hashFile(path.join(output, licenseFile)) }],
  extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
};
await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built ${basename}.so against PHP ${version.patchVersion} int64.`);
