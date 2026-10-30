import assert from 'node:assert/strict';
import test from 'node:test';
import { FileOperationResult } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files';
import { JoomlaFileSystemProvider, workspacePath, workspaceUri } from '../src/code/file-provider.mjs';

test('editor URIs bind every request to the expected site and preserve literal filenames', () => {
  assert.equal(workspacePath(workspaceUri('site-a', '/a #%.php'), 'site-a'), '/a #%.php');
  for (const path of ['/../secret', '/x/./secret', '/bad\\name', '/bad\0name']) assert.throws(() => workspaceUri('site-a', path));
  assert.throws(() => workspacePath(workspaceUri('site-b', '/x'), 'site-a'));
  assert.throws(() => workspacePath({ scheme: 'file', authority: 'site-a', path: '/x' }, 'site-a'));
});

test('a durable-save failure retains the successful live revision for safe retry', async () => {
  const writes = [];
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'read') return { bytes: new Uint8Array([1]), revision: 'initial' };
    writes.push(args);
    return { ok: true, results: [{ operation: 'write', path: args.path, revision: 'written' }], changes: [],
      persistence: { enabled: true, saved: writes.length > 1, error: 'quota' } };
  } }, 'test');
  const uri = provider.uri('/file.php');
  await provider.readFile(uri);
  await assert.rejects(provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true }), /durable storage failed/);
  await provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true });
  assert.equal(writes[0].expectedRevision, 'initial');
  assert.equal(writes[1].expectedRevision, 'written');
  provider.dispose();
});

test('external change notification never authorizes overwriting the previous read revision', async () => {
  let listener, revision = 'original', attempted;
  const provider = new JoomlaFileSystemProvider({
    subscribe(callback) { listener = callback; return () => {}; },
    async request(operation, args) {
      if (operation === 'read') return { bytes: new Uint8Array([1]), revision };
      if (operation === 'stat') return { type: 'file', revision };
      if (operation === 'write') { attempted = args.expectedRevision; const error = new Error('Changed on disk'); error.code = 'CONFLICT'; throw error; }
    },
  }, 'test');
  const notifications = [];
  provider.onDidChangeFile(changes => notifications.push(...changes));
  const uri = provider.uri('/file.php');
  await provider.readFile(uri);
  revision = 'external';
  listener({ type: 'workspace-invalidated' });
  await provider.revalidating;
  assert.equal(notifications[0].resource.path, '/file.php');
  await assert.rejects(provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true }),
    error => error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE);
  assert.equal(attempted, 'original');
  provider.dispose();
});

test('Save All uses the reserved transport and releases it on failure', async () => {
  const calls = [];
  const provider = new JoomlaFileSystemProvider({
    request: async () => calls.push('ordinary'),
    withBatch: async callback => callback({ request: async () => calls.push('reserved') }),
  }, 'test');
  await assert.rejects(provider.withBatch(async () => { await provider.request('stat', { path: '/' }); throw Error('save failed'); }), /save failed/);
  await provider.request('stat', { path: '/' });
  assert.deepEqual(calls, ['reserved', 'ordinary']);
  provider.dispose();
});

test('Explorer bursts remain bounded and duplicate metadata failures retain VS Code error codes', async () => {
  let active = 0, maximum = 0, requests = 0;
  const provider = new JoomlaFileSystemProvider({ async request(_operation, args) {
    requests++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (args.path === '/missing') { const error = new Error('Missing'); error.code = 'ENOENT'; throw error; }
    return { type: 'file', size: 0, mtime: 1, ctime: 1 };
  } }, 'test');
  const values = await Promise.all(Array.from({ length: 160 }, (_, index) => provider.request('stat', { path: `/file-${index % 80}` })));
  assert.equal(values.length, 160);
  assert.equal(requests, 80);
  assert.ok(maximum <= 4, `Only four calls may reach the PHP owner queue, observed ${maximum}.`);
  const failures = await Promise.allSettled([provider.request('stat', { path: '/missing' }), provider.request('stat', { path: '/missing' })]);
  assert.equal(requests, 81);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.code === 'EntryNotFound'));
  provider.dispose();
});

test('four queued saves cannot block paused source reads or change a dirty model baseline', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const writes = [];
  let dirty = false, revision = 'original', canonicalPath = '/original.php';
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'read') return { bytes: new Uint8Array([7]), revision, canonicalPath };
    if (operation === 'stat') return { type: 'file', size: 1, mtime: 1, ctime: 1 };
    if (operation === 'list') return [{ name: 'other.php', type: 'file' }];
    writes.push(args.path);
    await held;
    return { ok: true, results: [], changes: [] };
  } }, 'test');
  provider.isDirty = () => dirty;
  const uri = provider.uri('/alias.php');
  await provider.readFile(uri);
  dirty = true; revision = 'changed-during-request'; canonicalPath = '/changed.php';
  const pending = Array.from({ length: 5 }, (_, index) => provider.request('write', { path: `/save-${index}.php` }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, ['/save-0.php', '/save-1.php', '/save-2.php', '/save-3.php']);
    const reading = Promise.all([provider.readFile(uri), provider.stat(uri), provider.readdir(provider.uri('/'))]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.readRevisions.get('/alias.php'), revision, 'A stack-frame source read must finish while every mutation slot is held.');
    assert.equal(provider.readCanonicalPaths.get('/alias.php'), canonicalPath);
    assert.equal(provider.revisions.get('/alias.php'), 'original');
    assert.equal(provider.canonicalPaths.get('/alias.php'), '/original.php');
    assert.deepEqual((await reading)[0], new Uint8Array([7]));
    assert.equal(writes.length, 4, 'Reading must not start a fifth queued mutation.');
  } finally {
    release();
    await Promise.all(pending);
    provider.dispose();
  }
  assert.deepEqual(writes, Array.from({ length: 5 }, (_, index) => `/save-${index}.php`));
});

test('source backpressure remains bounded independently from mutation dispatch', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const reads = [], writes = [];
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'stat') {
      reads.push(args.path);
      await held;
      return { type: 'file', size: 1, mtime: 1, ctime: 1 };
    }
    writes.push(args.path);
    return { ok: true, results: [], changes: [] };
  } }, 'test');
  const pending = Array.from({ length: 8 }, (_, index) => provider.request('stat', { path: `/read-${index}.php` }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, ['/read-0.php', '/read-1.php', '/read-2.php', '/read-3.php']);
    const writing = provider.request('write', { path: '/save.php' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, ['/save.php'], 'Four held source reads must not occupy mutation slots.');
    await writing;
    assert.equal(reads.length, 4);
  } finally {
    release();
    await Promise.all(pending);
    provider.dispose();
  }
  assert.deepEqual(reads, Array.from({ length: 8 }, (_, index) => `/read-${index}.php`));
});

test('paused workspace search and cancellation use source slots while four writes wait', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const reads = [];
  const provider = new JoomlaFileSystemProvider({ async request(operation) {
    if (operation === 'write') { await held; return {}; }
    reads.push(operation);
    return operation === 'search' ? { results: [], cursor: 'search-cursor' } : { cancelled: true };
  } }, 'test');
  const pending = Array.from({ length: 4 }, (_, index) => provider.request('write', { path: `/save-${index}.php` }));
  try {
    const searching = provider.request('search', { query: 'Joomla' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, ['search']);
    const { cursor } = await searching;
    const cancelling = provider.request('cancelSearch', { cursor });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, ['search', 'cancelSearch']);
    assert.deepEqual(await cancelling, { cancelled: true });
  } finally {
    release();
    await Promise.all(pending);
    provider.dispose();
  }
});

test('pausing revalidates open files and reloads clean revisions without accepting dirty disk changes', async () => {
  let listener, changed = false;
  const provider = new JoomlaFileSystemProvider({
    subscribe(callback) { listener = callback; return () => {}; },
    async request(operation, args) {
      const revision = `${changed ? 'paused' : 'initial'}:${args.path}`;
      const canonicalPath = `${changed ? '/paused' : '/initial'}${args.path}`;
      if (operation === 'read') return { bytes: new Uint8Array([changed ? 2 : 1]), revision, canonicalPath };
      if (operation === 'stat') return { type: 'file', revision, canonicalPath };
    },
  }, 'test');
  const notifications = [];
  provider.onDidChangeFile(changes => notifications.push(...changes));
  await provider.readFile(provider.uri('/clean.php'));
  await provider.readFile(provider.uri('/dirty.php'));
  provider.isDirty = path => path === '/dirty.php';
  changed = true;
  listener({ type: 'debug-state', state: 'running' });
  assert.equal(provider.revalidating, undefined);
  listener({ type: 'debug-state', state: 'paused' });
  await provider.revalidating;
  assert.deepEqual(notifications.map(({ resource }) => resource.path), ['/clean.php', '/dirty.php']);
  assert.equal(provider.revisions.get('/dirty.php'), 'initial:/dirty.php');
  // File change notifications ask VS Code to refresh clean models. A comparison
  // read of an already-dirty model still cannot accept its new disk baseline.
  assert.deepEqual(await provider.readFile(provider.uri('/clean.php')), new Uint8Array([2]));
  await provider.readFile(provider.uri('/dirty.php'));
  assert.equal(provider.revisions.get('/clean.php'), 'paused:/clean.php');
  assert.equal(provider.canonicalPaths.get('/clean.php'), '/paused/clean.php');
  assert.equal(provider.readRevisions.get('/dirty.php'), 'paused:/dirty.php');
  assert.equal(provider.readCanonicalPaths.get('/dirty.php'), '/paused/dirty.php');
  assert.equal(provider.revisions.get('/dirty.php'), 'initial:/dirty.php');
  assert.equal(provider.canonicalPaths.get('/dirty.php'), '/initial/dirty.php');
  provider.dispose();
});

test('disk comparison reads cannot authorize overwriting a dirty editor buffer baseline', async () => {
  let revision = 'original', dirty = false, attempted;
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'read') return { bytes: new Uint8Array([1]), revision };
    if (operation === 'write') {
      attempted = args.expectedRevision;
      if (attempted !== revision) throw Object.assign(new Error('Changed on disk'), { code: 'CONFLICT' });
      return { ok: true, results: [{ operation, path: args.path, revision }], changes: [] };
    }
  } }, 'test');
  provider.isDirty = () => dirty;
  const uri = provider.uri('/file.php');
  await provider.readFile(uri);
  dirty = true;
  revision = 'external';
  await provider.readFile(uri); // Native compare view reads the saved file.
  assert.equal(provider.readRevisions.get('/file.php'), 'external');
  assert.equal(provider.revisions.get('/file.php'), 'original');
  await assert.rejects(provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true }),
    error => error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE);
  assert.equal(attempted, 'original');
  // Only resolution of the primary text model accepts the new disk baseline.
  provider.acceptReadRevision('/file.php');
  await provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true });
  assert.equal(attempted, 'external');
  provider.dispose();
});

test('explicit overwrite authorizes exactly the reviewed current revision and still rejects a later disk change', async () => {
  let revision = 'original', attempted;
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'read') return { bytes: new Uint8Array([1]), revision };
    if (operation === 'stat') { assert.equal(args.revision, true); return { type: 'file', revision }; }
    if (operation === 'write') {
      attempted = args.expectedRevision;
      if (attempted !== revision) throw Object.assign(new Error('Changed on disk'), { code: 'CONFLICT' });
      return { ok: true, results: [{ operation, path: args.path, revision: 'saved' }], changes: [] };
    }
  } }, 'test');
  const uri = provider.uri('/file.php');
  await provider.readFile(uri);
  revision = 'first-external';
  await provider.authorizeOverwrite('/file.php');
  revision = 'second-external';
  await assert.rejects(provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true }),
    error => error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE);
  assert.equal(attempted, 'first-external');
  await provider.authorizeOverwrite('/file.php');
  await provider.writeFile(uri, new Uint8Array([2]), { create: false, overwrite: true });
  assert.equal(attempted, 'second-external');
  assert.equal(provider.revisions.get('/file.php'), 'saved');
  provider.dispose();
});

test('saving an unread path checks missing or existing disk state before its write', async () => {
  let revision = null, changeAfterStat = false;
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'stat') {
      const result = revision === null ? null : { type: 'file', revision };
      if (changeAfterStat) revision = 'concurrent';
      return result;
    }
    if (operation === 'write') {
      if (args.expectedRevision !== revision) throw Object.assign(new Error('Changed on disk'), { code: 'CONFLICT' });
      return { ok: true, results: [{ operation, path: args.path, revision: 'saved' }], changes: [] };
    }
  } }, 'test');
  const uri = provider.uri('/new.php');
  changeAfterStat = true;
  await assert.rejects(provider.writeFile(uri, new Uint8Array([2]), { create: true, overwrite: true }),
    error => error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE);
  changeAfterStat = false;
  await provider.writeFile(uri, new Uint8Array([2]), { create: true, overwrite: true });
  assert.equal(provider.revisions.get('/new.php'), 'saved');
  provider.dispose();
});

test('content-identical alias retarget cannot bypass the editor canonical baseline', async () => {
  let canonicalPath = '/original.php', written;
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    if (operation === 'read') return { bytes: new Uint8Array([1]), revision: 'same-content', canonicalPath };
    if (operation === 'stat') return { type: 'file', revision: 'same-content', canonicalPath };
    if (operation === 'write') {
      written = args;
      if (args.expectedCanonicalPath !== canonicalPath) { const error = Error('Alias changed'); error.code = 'CONFLICT'; throw error; }
      return { ok: true, results: [], changes: [] };
    }
  } }, 'test');
  await provider.readFile(provider.uri('/alias.php'));
  provider.isDirty = () => true;
  canonicalPath = '/different.php';
  await provider.readFile(provider.uri('/alias.php'));
  await assert.rejects(provider.writeFile(provider.uri('/alias.php'), new Uint8Array([2]), { create: true, overwrite: true }),
    error => error.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE);
  assert.equal(written.expectedCanonicalPath, '/original.php');
  await provider.authorizeOverwrite('/alias.php');
  await provider.writeFile(provider.uri('/alias.php'), new Uint8Array([2]), { create: true, overwrite: true });
  assert.equal(written.expectedCanonicalPath, '/different.php');
  provider.dispose();
});
