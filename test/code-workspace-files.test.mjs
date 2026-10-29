import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceFileService, normalizeWorkspacePath } from '../src/code/workspace-files.mjs';

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(options = {}, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jec-files-'));
  temporary.push(directory);
  const root = path.join(directory, 'www');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'index.php'), '<?php echo "Joomla";');
  fs.mkdirSync(path.join(root, 'templates'));
  fs.writeFileSync(path.join(root, 'templates/site.css'), 'body { color: red; }\r\n');
  fs.writeFileSync(path.join(directory, 'secret'), 'runtime secret');
  const adapter = {
    lstat: fs.lstatSync, stat: fs.statSync, readlink: fs.readlinkSync, readdir: fs.readdirSync,
    readFile: filename => new Uint8Array(fs.readFileSync(filename)),
    writeFile: fs.writeFileSync, mkdir: fs.mkdirSync, rmdir: fs.rmdirSync,
    unlink: fs.unlinkSync, rename: fs.renameSync, symlink: fs.symlinkSync,
    chmod: fs.chmodSync, utime: (filename, atime, mtime) => fs.utimesSync(filename, new Date(atime), new Date(mtime)),
    ...overrides,
  };
  return { directory, root, adapter, service: createWorkspaceFileService(adapter, root, options) };
}

test('workspace paths reject traversal and distinguish URI adaptation from filesystem access', () => {
  for (const value of ['/../secret', 'templates/../../secret', '/a/./b', '/a//b', '/a\\b', '/x\0y', '//tmp', 'x'.repeat(256)]) {
    assert.throws(() => normalizeWorkspacePath(value), { code: 'INVALID_PATH' });
  }
  assert.equal(normalizeWorkspacePath('templates/site.css'), '/templates/site.css');
  assert.equal(normalizeWorkspacePath('/'), '/');
});

test('list is lazy, read preserves bytes and revisions detect external content changes', async () => {
  const { service, root } = fixture();
  const entries = await service.handle('list', { path: '/' });
  assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [['index.php', 'file'], ['templates', 'directory']]);
  const read = await service.handle('read', { path: '/templates/site.css' });
  assert.equal(new TextDecoder().decode(read.bytes), 'body { color: red; }\r\n');
  assert.match(read.revision, /^[a-f0-9]{64}$/);
  assert.equal(await service.handle('stat', { path: '/missing' }), null);
  fs.writeFileSync(path.join(root, 'templates/site.css'), 'changed by Joomla');
  await assert.rejects(service.handle('write', { path: '/templates/site.css', bytes: 'editor', overwrite: true, expectedRevision: read.revision }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'templates/site.css'), 'utf8'), 'changed by Joomla');
});

test('reads, writes and recursive mutations cannot follow links outside the root', async () => {
  const { service, root, directory } = fixture();
  fs.symlinkSync(directory, path.join(root, 'escape'));
  fs.symlinkSync(path.join(directory, 'secret'), path.join(root, 'secret-link'));
  for (const operation of ['read', 'stat']) await assert.rejects(service.handle(operation, { path: '/escape/secret' }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  await assert.rejects(service.handle('write', { path: '/escape/new', bytes: 'bad' }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  await assert.rejects(service.handle('delete', { path: '/secret-link' }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  fs.symlinkSync(directory, path.join(root, 'templates/outside'));
  for (const operation of ['copy', 'rename', 'delete']) {
    await assert.rejects(service.handle(operation, { path: '/templates', target: '/renamed', recursive: true }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  }
  assert.equal(fs.readFileSync(path.join(directory, 'secret'), 'utf8'), 'runtime secret');
  assert.equal(fs.existsSync(path.join(directory, 'new')), false);
  const link = (await service.handle('list', { path: '/' })).find(item => item.name === 'escape');
  assert.equal(link.type, 'symlink');
  assert.equal(link.readonly, true);
  assert.equal(link.canonicalPath, undefined, 'An escaped link must not disclose its physical target.');
});

test('canonical metadata exposes only workspace-relative targets for file and directory aliases', async () => {
  const { service, root } = fixture();
  fs.symlinkSync('index.php', path.join(root, 'alias.php'));
  fs.symlinkSync('templates', path.join(root, 'theme'));
  const stat = await service.handle('stat', { path: '/alias.php' });
  assert.equal(stat.path, '/alias.php');
  assert.equal(stat.canonicalPath, '/index.php');
  const listed = (await service.handle('list', { path: '/' })).find(entry => entry.name === 'theme');
  assert.equal(listed.canonicalPath, '/templates');
  const read = await service.handle('read', { path: '/theme/site.css' });
  assert.equal(read.path, '/theme/site.css');
  assert.equal(read.canonicalPath, '/templates/site.css');
  assert.equal(read.stat.canonicalPath, read.canonicalPath);
  assert.equal(JSON.stringify([stat, listed, read.stat]).includes(root), false);
});

test('reviewed canonical targets cannot be exchanged through an equal-content directory alias', async () => {
  const { service, root } = fixture();
  fs.mkdirSync(path.join(root, 'other'));
  fs.copyFileSync(path.join(root, 'templates/site.css'), path.join(root, 'other/site.css'));
  fs.symlinkSync('templates', path.join(root, 'alias'));
  const original = await service.handle('stat', { path: '/alias/site.css', revision: true });
  fs.unlinkSync(path.join(root, 'alias'));
  fs.symlinkSync('other', path.join(root, 'alias'));
  await assert.rejects(service.handle('write', { path: '/alias/site.css', bytes: 'unreviewed write', overwrite: true,
    expectedRevision: original.revision, expectedCanonicalPath: original.canonicalPath }), { code: 'CONFLICT' });
  await assert.rejects(service.handle('write', { path: '/alias/new.txt', bytes: 'unreviewed create',
    expectedRevision: null, expectedCanonicalPath: '/templates/new.txt' }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'other/site.css'), 'utf8'), 'body { color: red; }\r\n');
  assert.equal(fs.existsSync(path.join(root, 'other/new.txt')), false);
});

test('recovery rejects a snapshot parent replaced by an equal-content directory alias', async () => {
  const { service, root } = fixture();
  const saved = await service.handle('write', { path: '/templates/site.css', bytes: 'saved change', overwrite: true });
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other/site.css'), 'saved change');
  fs.renameSync(path.join(root, 'templates'), path.join(root, 'original-templates'));
  fs.symlinkSync('other', path.join(root, 'templates'));
  await assert.rejects(service.handle('recover', { recoveryId: saved.recoveryId }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'other/site.css'), 'utf8'), 'saved change');
  assert.equal(fs.readFileSync(path.join(root, 'original-templates/site.css'), 'utf8'), 'saved change');
  fs.unlinkSync(path.join(root, 'templates'));
  fs.renameSync(path.join(root, 'original-templates'), path.join(root, 'templates'));
  assert.equal((await service.handle('recover', { recoveryId: saved.recoveryId })).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'templates/site.css'), 'utf8'), 'body { color: red; }\r\n');
});

test('trusted persistence root symlink works but later root redirection is rejected', async () => {
  const { adapter, directory, root } = fixture();
  const alias = path.join(directory, 'persist');
  fs.symlinkSync(root, alias);
  const service = createWorkspaceFileService(adapter, alias);
  assert.equal((await service.handle('stat', { path: '/index.php' })).type, 'file');
  fs.unlinkSync(alias);
  fs.symlinkSync(directory, alias);
  await assert.rejects(service.handle('read', { path: '/secret' }), { code: 'WORKSPACE_CHANGED' });
});

test('root protections, explicit overwrites and nonrecursive deletion prevent accidental destruction', async () => {
  const { service, root } = fixture();
  for (const operation of ['write', 'mkdir', 'copy', 'rename', 'delete']) {
    await assert.rejects(service.handle(operation, { path: '/', target: '/other', bytes: 'bad', recursive: true, overwrite: true }), { code: 'PROTECTED_ROOT' });
  }
  const overwrite = await service.handle('write', { path: '/index.php', bytes: 'bad' });
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.failed.code, 'EEXIST');
  assert.equal(fs.readFileSync(path.join(root, 'index.php'), 'utf8'), '<?php echo "Joomla";');
  const deletion = await service.handle('delete', { path: '/templates' });
  assert.equal(deletion.failed.code, 'ENOTEMPTY');
  await assert.rejects(service.handle('rename', { path: '/templates', target: '/templates/child' }), { code: 'INVALID_TARGET' });
});

test('Save All uses one recoverable batch and undo refuses later disk changes', async () => {
  const changes = [];
  const { service, root } = fixture({ onChange: events => changes.push(events) });
  const old = await service.handle('read', { path: '/index.php' });
  const result = await service.handle('batch', { changes: [
    { operation: 'write', path: '/index.php', bytes: '<?php echo "edited";', overwrite: true, expectedRevision: old.revision },
    { operation: 'mkdir', path: '/new' },
    { operation: 'write', path: '/new/file.txt', bytes: new Uint8Array([0xff, 0, 0xfe]), expectedRevision: null },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 3);
  assert.equal(changes.length, 1);
  assert.deepEqual([...fs.readFileSync(path.join(root, 'new/file.txt'))], [255, 0, 254]);
  fs.writeFileSync(path.join(root, 'index.php'), 'later disk change');
  await assert.rejects(service.handle('recover', { recoveryId: result.recoveryId }), { code: 'CONFLICT' });
  fs.writeFileSync(path.join(root, 'index.php'), '<?php echo "edited";');
  const undo = await service.handle('recover', { recoveryId: result.recoveryId });
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'index.php'), 'utf8'), '<?php echo "Joomla";');
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
});

test('all batch preconditions are checked before the first mutation, including new directory children', async () => {
  const { service, root } = fixture();
  const folder = await service.handle('stat', { path: '/templates', revision: true });
  fs.writeFileSync(path.join(root, 'templates/new.txt'), 'unreviewed');
  await assert.rejects(service.handle('batch', {
    preconditions: [{ path: '/templates', revision: folder.revision }],
    changes: [{ operation: 'write', path: '/first.txt', bytes: 'first' }, { operation: 'delete', path: '/templates', recursive: true }],
  }), { code: 'CONFLICT' });
  assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'templates/new.txt')), true);
});

test('failed writes report exact partial progress and preserve a usable recovery snapshot', async () => {
  const { service, root } = fixture({}, {
    writeFile(filename, data) {
      fs.writeFileSync(filename, data);
      if (filename.endsWith('/failure.txt')) throw Object.assign(new Error('disk full after partial write'), { code: 'ENOSPC' });
    },
  });
  const result = await service.handle('batch', { changes: [
    { operation: 'write', path: '/first.txt', bytes: 'first' },
    { operation: 'write', path: '/failure.txt', bytes: 'partly written' },
    { operation: 'write', path: '/never.txt', bytes: 'never written' },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.failed.index, 1);
  assert.equal(result.failed.code, 'ENOSPC');
  assert.equal(fs.existsSync(path.join(root, 'never.txt')), false);
  assert.equal((await service.handle('recover', { recoveryId: result.recoveryId })).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'first.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'failure.txt')), false);
});

test('copy, rename and recursive delete preserve independent bytes and recover deleted trees', async () => {
  const { service, root } = fixture();
  assert.equal((await service.handle('copy', { path: '/templates', target: '/copy' })).ok, true);
  assert.equal((await service.handle('rename', { path: '/copy', target: '/moved' })).ok, true);
  fs.writeFileSync(path.join(root, 'moved/site.css'), 'independent');
  assert.equal(fs.readFileSync(path.join(root, 'templates/site.css'), 'utf8'), 'body { color: red; }\r\n');
  const deleted = await service.handle('delete', { path: '/moved', recursive: true });
  assert.equal(deleted.ok, true);
  assert.equal((await service.handle('recover', { recoveryId: deleted.recoveryId })).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'moved/site.css'), 'utf8'), 'independent');
});

test('moving and copying trees keep relative links inside the workspace with their original meaning', async () => {
  const { service, root } = fixture();
  fs.mkdirSync(path.join(root, 'deep'));
  fs.mkdirSync(path.join(root, 'deep/folder'));
  fs.writeFileSync(path.join(root, 'deep/folder/file.txt'), 'internal');
  fs.symlinkSync('../../index.php', path.join(root, 'deep/folder/ancestor.php'));
  fs.symlinkSync('file.txt', path.join(root, 'deep/folder/internal.txt'));
  const moved = await service.handle('rename', { path: '/deep/folder', target: '/shallow' });
  assert.equal(moved.ok, true);
  assert.equal(new TextDecoder().decode((await service.handle('read', { path: '/shallow/ancestor.php' })).bytes), '<?php echo "Joomla";');
  assert.equal(new TextDecoder().decode((await service.handle('read', { path: '/shallow/internal.txt' })).bytes), 'internal');
  const copied = await service.handle('copy', { path: '/shallow', target: '/copy' });
  assert.equal(copied.ok, true);
  fs.writeFileSync(path.join(root, 'copy/file.txt'), 'copied');
  assert.equal(new TextDecoder().decode((await service.handle('read', { path: '/copy/internal.txt' })).bytes), 'copied');
  assert.equal(new TextDecoder().decode((await service.handle('read', { path: '/shallow/internal.txt' })).bytes), 'internal');
});

test('read-only state, file limits and bounded history remain enforced by the worker service', async () => {
  const readOnly = fixture({ readOnly: true });
  assert.equal((await readOnly.service.handle('stat', { path: '/index.php' })).readonly, true);
  await assert.rejects(readOnly.service.handle('write', { path: '/index.php', bytes: 'bad', overwrite: true }), { code: 'READ_ONLY' });
  const { service } = fixture({ maxFileBytes: 32, maxBatchBytes: 64, maxHistory: 1 });
  await assert.rejects(service.handle('write', { path: '/large', bytes: 'x'.repeat(33) }), { code: 'LIMIT_EXCEEDED' });
  const first = await service.handle('write', { path: '/first', bytes: 'first' });
  const second = await service.handle('write', { path: '/second', bytes: 'second' });
  assert.equal((await service.handle('history')).length, 1);
  await assert.rejects(service.handle('recover', { recoveryId: first.recoveryId }), { code: 'RECOVERY_EXPIRED' });
  assert.equal((await service.handle('recover', { recoveryId: second.recoveryId })).ok, true);
});

test('paged search confines results, preserves source positions and cancels between bounded pages', async () => {
  const { service, root, directory } = fixture();
  fs.writeFileSync(path.join(root, 'templates/text.txt'), 'Joomla one\nJOOMLA two\nJoomla three\n');
  fs.writeFileSync(path.join(root, 'templates/binary.dat'), new Uint8Array([0, 65, 66]));
  fs.symlinkSync(directory, path.join(root, 'outside'));
  const files = await service.handle('search', { query: 'text', kind: 'files', maxResults: 1 });
  assert.deepEqual(files.results, [{ path: '/templates/text.txt' }]);
  let page = await service.handle('search', { query: 'joomla', kind: 'text', include: ['**/*.txt'], maxResults: 1 });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].lineNumber, 1);
  assert.equal(page.results[0].column, 1);
  assert.equal(page.results[0].endColumn, 7);
  assert.match(page.results[0].revision, /^[a-f0-9]{64}$/);
  assert.ok(page.cursor);
  page = await service.handle('search', { cursor: page.cursor, maxResults: 1 });
  assert.equal(page.results[0].lineNumber, 2);
  assert.equal(page.results[0].preview, 'JOOMLA two');
  const cursor = page.cursor;
  assert.equal((await service.handle('cancelSearch', { cursor })).cancelled, true);
  await assert.rejects(service.handle('search', { cursor }), { code: 'SEARCH_EXPIRED' });
  await assert.rejects(service.handle('search', { query: 'a.*', kind: 'text', isRegex: true }), { code: 'UNSUPPORTED_SEARCH' });
});

test('search entry and file-size limits report incomplete coverage without escaping or hanging', async () => {
  const { service, root } = fixture({ maxEntries: 4, maxFileBytes: 100 });
  for (let index = 0; index < 6; index++) fs.writeFileSync(path.join(root, `file-${index}.txt`), 'Joomla');
  const limited = await service.handle('search', { kind: 'files', query: '' });
  assert.equal(limited.truncated, true);
  assert.equal(limited.cursor, null);
});
