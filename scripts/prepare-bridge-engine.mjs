import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, extractTarGzip, verifyBridgeBundle } from './assets.mjs';

// Validate native PDO against the exact released engine consumed by the site.
// The database's own release pipeline is responsible for compiling that engine.
const root = fileURLToPath(new URL('../', import.meta.url));
const { bridge: pin } = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const checkout = path.resolve(root, process.argv[2] || 'external/bridge');
const cache = path.join(root, '.cache');
await mkdir(cache, { recursive: true });
const archive = await downloadVerified(pin.url, pin.sha256, path.join(cache, `mariadb-${pin.version}.tar.gz`));
const scratch = await mkdtemp(path.join(cache, 'released-engine-'));
try {
  await extractTarGzip(archive, scratch);
  const bundle = path.join(scratch, `mariadb-wasm-bridge-${pin.version}`);
  await verifyBridgeBundle(bundle, pin);
  const target = path.join(checkout, '.native-build/engine/dist');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(path.join(bundle, 'vendor/lite4mariadb'), target, { recursive: true });
  console.log(`Prepared verified MariaDB ${pin.version} release engine for native PDO validation.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
