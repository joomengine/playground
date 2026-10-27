import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.cache', 'node_modules', 'dist', 'external', 'test-results'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(filename);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Syntax validation failed: ${filename}`);
    }
  }
}
await check(root);
console.log('JavaScript syntax checks passed.');
