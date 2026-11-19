import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import manifest from '../package.json' with { type: 'json' };
import { updateEditorPins, verifiedArchive } from '../scripts/update-editor.mjs';

const target = '@codingame/monaco-vscode-api';
const releases = Object.fromEntries([target, 'php-parser', 'vscode-html-languageservice', 'vscode-languageserver-textdocument'].map(name => [name, { version: '99.1.2' }]));

test('editor updates keep synchronized direct packages and both npm aliases on one stable release', () => {
  const next = updateEditorPins(manifest, releases);
  for (const name of Object.keys(next.dependencies)) {
    if (name.startsWith('@codingame/') || name in releases) assert.equal(next.dependencies[name], '99.1.2');
  }
  assert.equal(next.dependencies.vscode, 'npm:@codingame/monaco-vscode-extension-api@99.1.2');
  assert.equal(next.dependencies['monaco-editor'], 'npm:@codingame/monaco-vscode-editor-api@99.1.2');
  assert.equal(next.dependencies.fflate, manifest.dependencies.fflate);
  assert.deepEqual(next.devDependencies, manifest.devDependencies);
  const rollback = updateEditorPins(manifest, { ...releases, [target]: { version: '0.0.1' } });
  assert.equal(rollback.dependencies[target], manifest.dependencies[target]);
  assert.equal(rollback.dependencies['monaco-editor'], manifest.dependencies['monaco-editor']);
  assert.throws(() => updateEditorPins(manifest, { ...releases, [target]: { version: '99.2.0-beta.1' } }), /stable release/);
  assert.throws(() => updateEditorPins({ dependencies: { vscode: '1.2.3' } }, releases), /alias/);
});

test('embedded notices and binary evidence must come from an integrity-matched npm archive', () => {
  const bytes = Buffer.from('fixture');
  const pin = { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  assert.equal(typeof verifiedArchive(bytes, pin), 'function');
  assert.throws(() => verifiedArchive(Buffer.from('changed'), pin), /integrity mismatch/);
  assert.throws(() => verifiedArchive(bytes, { ...pin, resolved: 'https://example.org/archive' }));
});
