import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBuildCanaries, canaryRepresentations, verifyPublicArtifact } from './public-artifact-security.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = path.join(root, '.cache/public-artifact-canaries.json');
const mode = process.argv[2];
if (!['build', 'snapshots', 'verify'].includes(mode)) throw new Error('Choose build, snapshots or verify.');
const environment = process.env.PLAYGROUND_DEPLOYMENT_ENV || 'production';
const canaries = mode === 'build' ? createBuildCanaries() : JSON.parse(await readFile(state, 'utf8'));
const representations = canaryRepresentations(canaries);
if (mode === 'build') {
  await mkdir(path.dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify(canaries), { mode: 0o600 });
}
if (mode !== 'verify') {
  const script = mode === 'build' ? 'build.mjs' : 'build-deploys.mjs';
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd: root, env: { ...process.env, ...canaries }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  // Even a broken builder that logs its environment cannot print canary values.
  for (const [stream, output] of [[process.stdout, result.stdout], [process.stderr, result.stderr]]) {
    let redacted = output || '';
    for (const value of representations) redacted = redacted.replaceAll(value, '[redacted build canary]');
    stream.write(redacted);
  }
  if (result.error || result.status !== 0) throw new Error(`Canary ${mode} process failed; no public artifact was accepted.`);
}
const result = await verifyPublicArtifact({ directory: path.join(root, 'dist'), canaries, environment });
console.log(`Public artifact credential check passed: ${result.files} files, ${result.snapshots} generated snapshots.`);
if (mode === 'verify') {
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/public-artifact-security.json'), `${JSON.stringify({ status: 'passed', ...result }, null, 2)}\n`);
  await rm(state);
}
