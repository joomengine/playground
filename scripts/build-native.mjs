import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhpRuntime } from './php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = await loadPhpRuntime({ root });
for (const { version } of pins.php) {
  for (const script of ['build-mariadb.mjs', 'build-curl.mjs', 'build-sodium.mjs', 'phpdbg-build.mjs']) {
    execFileSync(process.execPath, [path.join(root, 'scripts', script), version], { cwd: root, stdio: 'inherit' });
  }
}
