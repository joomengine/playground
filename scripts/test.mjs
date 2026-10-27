import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(path.join(root, 'test')))
  .filter(name => name.endsWith('.test.mjs') && name !== 'browser.test.mjs').sort();
if (!tests.length) throw new Error('No unit/integration test files found');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => `test/${name}`)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
