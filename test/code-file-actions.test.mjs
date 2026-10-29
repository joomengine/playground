import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceFileService } from '../src/code/workspace-files.mjs';
import { detectRasterImageType, recoverWorkspaceSnapshot, uploadWorkspaceFiles } from '../src/code/file-actions.mjs';

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jec-actions-')); temporary.push(directory);
  const root = path.join(directory, 'www'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(directory, 'secret'), 'outside workspace');
  const service = createWorkspaceFileService({
    lstat: fs.lstatSync, stat: fs.statSync, readlink: fs.readlinkSync, readdir: fs.readdirSync,
    readFile: filename => new Uint8Array(fs.readFileSync(filename)), writeFile: fs.writeFileSync,
    mkdir: fs.mkdirSync, rmdir: fs.rmdirSync, unlink: fs.unlinkSync, rename: fs.renameSync,
    symlink: fs.symlinkSync, chmod: fs.chmodSync,
    utime: (filename, atime, mtime) => fs.utimesSync(filename, new Date(atime), new Date(mtime)),
    ...overrides,
  }, root);
  const request = (operation, args) => service.handle(operation, args);
  return { root, directory, workspace: { request, withBatch: callback => Promise.resolve().then(() => callback({ request })) } };
}

function delayReservation(workspace) {
  let release, queued;
  const blocked = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { queued = resolve; });
  workspace.withBatch = async callback => { queued(); await blocked; return callback({ request: workspace.request }); };
  return { waiting, release };
}

test('binary uploads round-trip without text conversion and restore as one reviewed batch', async () => {
  const { workspace, root } = fixture();
  const original = new Uint8Array([0, 0xff, 0x80, 0x0d, 0x0a, 0xfe]);
  fs.writeFileSync(path.join(root, 'images/existing.bin'), original);
  const replacement = new Uint8Array([0xff, 0, 0xfe, 0x80]);
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1N0AAAAASUVORK5CYII=', 'base64'));
  let reviewed;
  const result = await uploadWorkspaceFiles({ workspace, directory: '/images',
    files: [new File([replacement], 'existing.bin'), new File([png], 'pixel.png')],
    confirmOverwrite: paths => { reviewed = paths; return true; },
  });
  assert.deepEqual(reviewed, ['/images/existing.bin']);
  assert.equal(result.ok, true);
  assert.deepEqual((await workspace.request('read', { path: '/images/existing.bin' })).bytes, replacement);
  assert.deepEqual((await workspace.request('read', { path: '/images/pixel.png' })).bytes, png);
  assert.equal(detectRasterImageType(png), 'image/png');
  const history = await workspace.request('history');
  assert.equal(history.length, 1);
  assert.deepEqual(new Set(history[0].paths), new Set(['/images/existing.bin', '/images/pixel.png']));
  assert.equal((await workspace.request('recover', { recoveryId: history[0].id })).ok, true);
  assert.deepEqual((await workspace.request('read', { path: '/images/existing.bin' })).bytes, original);
  assert.equal(await workspace.request('stat', { path: '/images/pixel.png' }), null);
});

test('declining replacement writes nothing, and approval cannot overwrite later disk or editor changes', async () => {
  const { workspace, root } = fixture();
  const target = path.join(root, 'images/existing.txt'); fs.writeFileSync(target, 'original');
  const files = [new File(['new'], 'first.txt'), new File(['replacement'], 'existing.txt')];
  const cancelled = await uploadWorkspaceFiles({ workspace, directory: '/images', files });
  assert.equal(cancelled.cancelled, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(root, 'images/first.txt')), false);
  assert.deepEqual(await workspace.request('history'), []);
  await assert.rejects(uploadWorkspaceFiles({ workspace, directory: '/images', files,
    confirmOverwrite: () => { fs.writeFileSync(target, 'Joomla changed it'); return true; },
  }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'Joomla changed it');
  assert.equal(fs.existsSync(path.join(root, 'images/first.txt')), false);
  let dirty = false;
  await assert.rejects(uploadWorkspaceFiles({ workspace, directory: '/images', files,
    isDirty: path => dirty && path === '/images/existing.txt',
    confirmOverwrite: () => { dirty = true; return true; },
  }), { code: 'DIRTY_FILE' });
  assert.equal(fs.existsSync(path.join(root, 'images/first.txt')), false);
});

test('new-file races, invalid file names, root escapes and cancelled reads never clobber files', async () => {
  const { workspace, directory, root } = fixture();
  await assert.rejects(uploadWorkspaceFiles({ workspace, files: [new File(['x'], '../secret')] }), { code: 'INVALID_PATH' });
  await assert.rejects(uploadWorkspaceFiles({ workspace, files: [new File(['x'], 'same'), new File(['y'], 'same')] }), { code: 'DUPLICATE_PATH' });
  fs.symlinkSync(directory, path.join(root, 'escape'));
  await assert.rejects(uploadWorkspaceFiles({ workspace, directory: '/escape', files: [new File(['x'], 'secret')] }), { code: 'PATH_OUTSIDE_WORKSPACE' });
  assert.equal(fs.readFileSync(path.join(directory, 'secret'), 'utf8'), 'outside workspace');
  await assert.rejects(uploadWorkspaceFiles({ workspace, files: [{ name: 'new.txt', size: 1, async arrayBuffer() {
    fs.writeFileSync(path.join(root, 'new.txt'), 'created by Joomla'); return new Uint8Array([120]).buffer;
  } }] }), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'created by Joomla');
  const controller = new AbortController();
  await assert.rejects(uploadWorkspaceFiles({ workspace, signal: controller.signal,
    files: [{ name: 'cancelled.txt', size: 1, async arrayBuffer() { controller.abort(); return new Uint8Array([120]).buffer; } }],
  }), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(root, 'cancelled.txt')), false);
});

test('uploads waiting behind PHP cannot overwrite a buffer edited before the reservation is granted', async () => {
  let writes = 0, dirty = false;
  const { workspace, root } = fixture({ writeFile(filename, bytes) { writes++; return fs.writeFileSync(filename, bytes); } });
  fs.writeFileSync(path.join(root, 'images/existing.txt'), 'saved before upload');
  const queue = delayReservation(workspace);
  const upload = uploadWorkspaceFiles({ workspace, directory: '/images',
    files: [new File(['new'], 'first.txt'), new File(['replacement'], 'existing.txt')],
    isDirty: path => dirty && path === '/images/existing.txt', confirmOverwrite: () => true,
  });
  await queue.waiting;
  dirty = true;
  queue.release();
  await assert.rejects(upload, { code: 'DIRTY_FILE' });
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(root, 'images/first.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'images/existing.txt'), 'utf8'), 'saved before upload');
  assert.deepEqual(await workspace.request('history'), []);
  workspace.withBatch = undefined;
  await assert.rejects(uploadWorkspaceFiles({ workspace, files: [new File(['unsafe fallback'], 'new.txt')] }), { code: 'RESERVATION_REQUIRED' });
  assert.equal(writes, 0);
});

test('queued folder recovery checks newly dirty descendants before restoring any files', async () => {
  let writes = 0, dirty = false;
  const { workspace, root } = fixture({ writeFile(filename, bytes) { writes++; return fs.writeFileSync(filename, bytes); } });
  fs.writeFileSync(path.join(root, 'images/open.txt'), 'recoverable saved bytes');
  const deleted = await workspace.request('delete', { path: '/images', recursive: true });
  assert.equal(deleted.ok, true);
  const [snapshot] = await workspace.request('history');
  assert.deepEqual(snapshot.paths, ['/images']);
  const queue = delayReservation(workspace);
  const restoring = recoverWorkspaceSnapshot({ workspace, snapshot,
    isDirty: (path, recursive) => dirty && recursive && path === '/images',
  });
  await queue.waiting;
  dirty = true;
  queue.release();
  await assert.rejects(restoring, { code: 'DIRTY_FILE' });
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(root, 'images')), false);
  assert.equal((await workspace.request('history'))[0].id, snapshot.id);
  // Refusal preserves the recovery entry; a later explicitly requested restore
  // after resolving the dirty buffer can still recover the exact saved bytes.
  dirty = false;
  assert.equal((await recoverWorkspaceSnapshot({ workspace, snapshot })).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'images/open.txt'), 'utf8'), 'recoverable saved bytes');
});

test('uploads freeze canonical destinations and reject same-byte directory alias retargeting', async () => {
  let writes = 0;
  const { workspace, root } = fixture({ writeFile(filename, bytes) { writes++; return fs.writeFileSync(filename, bytes); } });
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'images/existing.txt'), 'same saved bytes');
  fs.writeFileSync(path.join(root, 'other/existing.txt'), 'same saved bytes');
  fs.symlinkSync('images', path.join(root, 'alias'));
  const queue = delayReservation(workspace);
  const upload = uploadWorkspaceFiles({ workspace, directory: '/alias',
    files: [new File(['new'], 'first.txt'), new File(['replacement'], 'existing.txt')], confirmOverwrite: () => true,
  });
  await queue.waiting;
  fs.unlinkSync(path.join(root, 'alias')); fs.symlinkSync('other', path.join(root, 'alias'));
  queue.release();
  await assert.rejects(upload, { code: 'CONFLICT' });
  assert.equal(writes, 0);
  for (const folder of ['images', 'other']) {
    assert.equal(fs.existsSync(path.join(root, folder, 'first.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, folder, 'existing.txt'), 'utf8'), 'same saved bytes');
  }
  await assert.rejects(uploadWorkspaceFiles({ workspace, directory: '/alias',
    files: [new File(['replacement'], 'existing.txt')], confirmOverwrite: () => true,
    isDirty: path => path === '/other/existing.txt',
  }), { code: 'DIRTY_FILE' });
  assert.equal(writes, 0);
});

test('a failed binary upload reports partial progress once and retains its recovery snapshot', async () => {
  let failedWrites = 0;
  const { workspace, root } = fixture({ writeFile(filename, bytes) {
    if (filename.endsWith('/second.bin')) { failedWrites++; throw new Error('disk full'); }
    return fs.writeFileSync(filename, bytes);
  } });
  const result = await uploadWorkspaceFiles({ workspace, files: [new File([new Uint8Array([0xff])], 'first.bin'), new File([new Uint8Array([0xfe])], 'second.bin')] });
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.failed.path, '/second.bin');
  assert.equal(failedWrites, 1);
  assert.deepEqual([...fs.readFileSync(path.join(root, 'first.bin'))], [255]);
  assert.equal((await workspace.request('history')).length, 1);
  assert.equal((await workspace.request('recover', { recoveryId: result.recoveryId })).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'first.bin')), false);
});

test('preview detection rejects active content, mislabeled files, arbitrary binary and truncated signatures', () => {
  for (const content of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<html><img src=x onerror=alert(1)></html>', '<?xml version="1.0"?><svg/>', '%PDF-1.5',
    'GIF89a', 'RIFFxxxxWEBP', '\x89PNG\r\n\x1a\n',
  ]) assert.equal(detectRasterImageType(new TextEncoder().encode(content)), null);
  assert.equal(detectRasterImageType(new Uint8Array([0xff, 0xfe, 0x00, 0xff])), null);
  assert.equal(detectRasterImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectRasterImageType(new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00')), 'image/gif');
  assert.equal(detectRasterImageType(new TextEncoder().encode('RIFFxxxxWEBPVP8 ')), 'image/webp');
});
