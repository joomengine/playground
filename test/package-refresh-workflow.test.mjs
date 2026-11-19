import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/refresh-packages.yml', import.meta.url), 'utf8');
function script(step) {
  const block = workflow.split('      - name: ' + step + '\n')[1]?.split('        run: |\n')[1];
  assert.ok(block, 'Missing workflow step ' + step);
  return block.match(/^(?:          [^\n]+\n)+/)[0].replace(/^          /gm, '');
}
async function repo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'playground-refresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--quiet', '--allow-empty', '-m', 'base');
  return { dir, git };
}

test('an unchanged refresh succeeds and never generates an update patch', async t => {
  const { dir, git } = await repo(t);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'playground-refresh-step-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { ...process.env, GITHUB_OUTPUT: path.join(scratch, 'output'), GITHUB_STEP_SUMMARY: path.join(scratch, 'summary'), RUNNER_TEMP: scratch };
  const run = () => execFileSync('bash', ['-eo', 'pipefail', '-c', script('Collect the proposed changes')], { cwd: dir, env });
  run();
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^changed=false$/m);
  await assert.rejects(readFile(path.join(scratch, 'updates.patch')), { code: 'ENOENT' });
  await writeFile(path.join(dir, 'versions.json'), '{}\n');
  run();
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^changed=true$/m);
  assert.match(await readFile(path.join(scratch, 'updates.patch'), 'utf8'), /versions\.json/);
  assert.equal(git('diff', '--cached', '--name-only'), 'versions.json');
});

test('promote only the validated revision, refuse to overwrite new main work and surface transport failures', async t => {
  const { dir, git } = await repo(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'playground-refresh-origin-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const base = git('rev-parse', 'HEAD');
  git('init', '--quiet', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '--quiet', 'origin', 'HEAD:main');
  git('commit', '--quiet', '--allow-empty', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  await writeFile(path.join(dir, 'gh'), '#!/bin/sh\necho "$@" >> "$GITHUB_STEP_SUMMARY"\n');
  await chmod(path.join(dir, 'gh'), 0o755);
  const env = { ...process.env, GITHUB_SHA: base, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), PATH: dir + path.delimiter + process.env.PATH };
  const run = () => execFileSync('bash', ['-eo', 'pipefail', '-c', script('Fast-forward main to the tested candidate and publish')], { cwd: dir, env, stdio: 'pipe' });
  run();
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), candidate);
  run(); // A failure between git push and workflow dispatch can be retried.
  git('checkout', '--quiet', '--detach', base);
  git('commit', '--quiet', '--allow-empty', '-m', 'different work');
  const advanced = git('rev-parse', 'HEAD');
  git('push', '--quiet', '--force', 'origin', 'HEAD:main');
  git('checkout', '--quiet', '--detach', candidate);
  run();
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), advanced);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.equal(summary.match(/workflow run pages.yml --ref main/g)?.length, 2);
  assert.match(summary, /Main advanced/);
  git('remote', 'set-url', 'origin', path.join(dir, 'missing-origin'));
  assert.throws(run);
});
