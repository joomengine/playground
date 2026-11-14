import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installPhpRecovery } from '../src/php-recovery.mjs';

function filesystem(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joomengine-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = name => path.join(root, name);
  const writes = [], metadata = [];
  const result = {
    writes, metadata,
    analyzePath: name => ({ exists: fs.existsSync(local(name)) }),
    lstat: name => fs.lstatSync(local(name)),
    isDir: mode => (mode & 0o170000) === 0o040000,
    isLink: mode => (mode & 0o170000) === 0o120000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readdir: name => fs.readdirSync(local(name)),
    readFile: name => fs.readFileSync(local(name)),
    writeFile(name, bytes) { writes.push(name); fs.writeFileSync(local(name), bytes); },
    mkdirTree: name => fs.mkdirSync(local(name), { recursive: true }),
    chmod(name, mode) { metadata.push(name); fs.chmodSync(local(name), mode); },
    utime(name, atime, mtime) { metadata.push(name); fs.utimesSync(local(name), atime, mtime); },
    readlink: name => fs.readlinkSync(local(name)),
    symlink: (target, name) => fs.symlinkSync(target, local(name)),
    unlink: name => fs.unlinkSync(local(name)),
    rmdir: name => fs.rmdirSync(local(name)),
    syncfs() { assert.fail('Recovery must not require a successful persistent write.'); },
  };
  for (const name of ['/persist/www', '/config', '/tmp', '/internal']) result.mkdirTree(name);
  for (const [name, value] of Object.entries(files)) {
    result.mkdirTree(path.dirname(name));
    result.writeFile(name, value);
    result.utime(name, new Date(0), new Date(0));
  }
  writes.length = 0; metadata.length = 0;
  return result;
}

test('PHP recovery preserves unsaved edits and deletions over an older disk generation without flushing', async t => {
  const previous = { FS: filesystem(t, {
    '/persist/www/edited.txt': 'new', '/persist/www/unchanged.txt': 'same',
    '/persist/www/added.txt': 'new file', '/persist/www/type-change': 'now a file',
    '/config/.cookies': 'live cookie', '/tmp/inflight.txt': 'temporary work',
  }) };
  previous.FS.symlink('missing.txt', '/persist/www/dangling');
  const next = { FS: filesystem(t, {
    '/persist/www/edited.txt': 'old', '/persist/www/unchanged.txt': 'same',
    '/persist/www/deleted.txt': 'do not resurrect', '/persist/www/deleted-directory/file.txt': 'old',
    '/persist/www/type-change/old.txt': 'old directory', '/config/.cookies': 'saved cookie',
  }) };
  let current = previous;
  const php = { binary: Promise.resolve(previous), refresh() { this.binary = Promise.resolve(next); return this.binary; } };
  installPhpRecovery(php, { currentBinary: () => current, prepare() {}, restored: value => { current = value; } });
  const replacement = php.refresh();
  assert.equal(php.binary, replacement, 'Callers wait for restoration as well as runtime initialization.');
  await replacement;
  assert.equal(current, next);
  assert.equal(php.initialized, true);
  for (const name of ['/persist/www/edited.txt', '/persist/www/added.txt', '/persist/www/type-change', '/config/.cookies', '/tmp/inflight.txt']) {
    assert.deepEqual(next.FS.readFile(name), previous.FS.readFile(name), name);
  }
  assert.equal(next.FS.analyzePath('/persist/www/deleted.txt').exists, false);
  assert.equal(next.FS.analyzePath('/persist/www/deleted-directory').exists, false);
  assert.equal(next.FS.readlink('/persist/www/dangling'), 'missing.txt');
  assert.equal(next.FS.writes.includes('/persist/www/unchanged.txt'), false,
    'Recovery must not dirty every unchanged hydrated file.');
  assert.equal(next.FS.metadata.includes('/persist/www/unchanged.txt'), false);
});
