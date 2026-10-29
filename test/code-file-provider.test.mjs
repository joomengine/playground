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
