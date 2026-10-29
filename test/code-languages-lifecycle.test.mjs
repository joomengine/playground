import assert from 'node:assert/strict';
import test from 'node:test';
import { installPhpLanguageServices } from '../src/code/languages.mjs';
import { PhpProjectIndex } from '../src/code/languages-php.mjs';

function emitter() {
  const listeners = new Set();
  return { subscribe(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire(value) { for (const listener of [...listeners]) listener(value); } };
}
function fixture() {
  const workers = [], markers = new Map(), providers = {}, create = emitter(), language = emitter();
  class TestWorker {
    events = {};
    constructor() { workers.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    postMessage({ id, operation, args }) {
      queueMicrotask(() => {
        if (this.closed) return;
        try {
          let value;
          if (operation === 'configure') { this.index = new PhpProjectIndex(args); value = this.index.status(); }
          if (operation === 'update') value = { ...this.index.update(args.path, args.source, args.version), status: this.index.status() };
          if (operation === 'remove') { this.index.remove(args.path); value = this.index.status(); }
          if (operation === 'symbols') value = this.index.files.get(args.path)?.symbols || [];
          if (operation === 'definition') value = this.index.definition(args.path, args.source, args.offset);
          if (operation === 'complete') value = this.index.complete(args.path, args.source, args.offset);
          this.events.message({ data: { id, value } });
        } catch (error) { this.events.message({ data: { id, error: error.message } }); }
      });
    }
    terminate() { this.closed = true; }
  }
  const modelList = [];
  const monaco = {
    MarkerSeverity: { Error: 8 }, Uri: { from: value => value },
    languages: { CompletionItemKind: {}, SymbolKind: {},
      registerCompletionItemProvider(_name, value) { providers.completion = value; return { dispose() {} }; },
      registerDefinitionProvider(_name, value) { providers.definition = value; return { dispose() {} }; },
      registerDocumentSymbolProvider(_name, value) { providers.symbols = value; return { dispose() {} }; } },
    editor: { getModels: () => modelList, onDidCreateModel: create.subscribe, onDidChangeModelLanguage: language.subscribe,
      setModelMarkers(model, _owner, values) { markers.set(model.uri.path, values); } },
  };
  function addModel(path, initial, scheme = 'jec') {
    const content = emitter(), disposing = emitter();
    let text = initial, version = 1, closed = false;
    const model = { uri: { path, scheme, authority: 'site' }, getLanguageId: () => 'php', getValue: () => text,
      getVersionId: () => version, isDisposed: () => closed, getOffsetAt: position => position.column - 1,
      onDidChangeContent: content.subscribe, onWillDispose: disposing.subscribe,
      change(next) { text = next; version++; content.fire(); },
      dispose() { disposing.fire(); closed = true; } };
    modelList.push(model); create.fire(model); return model;
  }
  return { TestWorker, workers, monaco, markers, providers, addModel };
}

test('PHP worker starts lazily, indexes without models, removes unsupported changes, and preserves unsaved buffers', async t => {
  const f = fixture();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = f.TestWorker;
  t.after(() => { if (originalWorker) globalThis.Worker = originalWorker; else delete globalThis.Worker; });
  let listener, activeReads = 0, peakReads = 0;
  const files = new Map([['/lib.php', new TextEncoder().encode('<?php class Library {}')]]);
  const workspace = {
    subscribe(callback) { listener = callback; return () => { listener = null; }; },
    async request(operation, { path }) {
      if (operation === 'list') return [...files].map(([path, bytes]) => ({ path, name: path.slice(1), size: bytes.length, mtime: 1, type: 'file' }));
      if (operation === 'read') {
        peakReads = Math.max(peakReads, ++activeReads);
        await new Promise(resolve => setTimeout(resolve, 1));
        activeReads--;
        if (!files.has(path)) throw new Error('Missing file');
        return { bytes: files.get(path) };
      }
      if (operation === 'stat') return files.has(path) ? { type: 'file' } : null;
      throw new Error(operation);
    },
  };
  const errors = [];
  const service = installPhpLanguageServices({ monaco: f.monaco, workspace, siteId: 'site', onError: error => errors.push(error) });
  assert.equal(f.workers.length, 0);
  f.addModel('/untrusted.php', '<?php class Foreign {}', 'https');
  assert.equal(f.workers.length, 0);
  const model = f.addModel('/draft.php', '<?php class Unsaved {}');
  await service.refresh();
  assert.equal(f.workers.length, 1);
  assert.deepEqual(f.workers[0].index.allSymbols().map(item => item.name).sort(), ['Library', 'Unsaved']);
  assert.equal(f.monaco.editor.getModels().length, 2, 'Project indexing must never create editor models');
  assert.equal(service.getStatus().files, 2);

  files.set('/lib.php', new Uint8Array(1024 * 1024 + 1));
  listener({ type: 'workspace-change', changes: [{ path: '/lib.php', type: 'changed' }] });
  await service.refresh();
  assert.ok(!f.workers[0].index.allSymbols().some(item => item.name === 'Library'));
  assert.equal(service.getStatus().phase, 'partial');

  files.set('/lib.php', new TextEncoder().encode('<?php class Replaced {}'));
  await service.refresh();
  assert.equal(service.getStatus().phase, 'ready');
  files.set('/lib.php', new Uint8Array([0xff, 0xfe]));
  listener({ type: 'workspace-change', changes: [{ path: '/lib.php', type: 'changed' }] });
  await service.refresh();
  assert.ok(!f.workers[0].index.files.has('/lib.php'));

  files.set('/lib.php', new TextEncoder().encode('<?php class Replaced {}'));
  files.set('/draft.php', new TextEncoder().encode('<?php class Disk {}'));
  listener({ type: 'workspace-change', changes: [{ path: '/draft.php', type: 'changed' }] });
  await service.refresh();
  assert.ok(f.workers[0].index.allSymbols().some(item => item.name === 'Unsaved'));
  assert.ok(!f.workers[0].index.allSymbols().some(item => item.name === 'Disk'));
  files.delete('/draft.php');
  listener({ type: 'workspace-change', changes: [{ path: '/draft.php', type: 'deleted' }] });
  await service.refresh();
  assert.ok(f.workers[0].index.allSymbols().some(item => item.name === 'Unsaved'));
  listener({ type: 'workspace-invalidated' });
  assert.equal(service.getStatus().phase, 'stale');
  assert.equal(peakReads, 1);
  assert.deepEqual(errors, []);
  service.dispose();
  assert.equal(f.workers[0].closed, true);
  assert.equal(listener, null);
  assert.deepEqual(f.markers.get(model.uri.path), []);
});

test('a failed PHP worker rejects later completion requests rather than leaving them pending', async t => {
  const f = fixture();
  const originalWorker = globalThis.Worker;
  globalThis.Worker = f.TestWorker;
  t.after(() => { if (originalWorker) globalThis.Worker = originalWorker; else delete globalThis.Worker; });
  const service = installPhpLanguageServices({ monaco: f.monaco, siteId: 'site',
    workspace: { request: async () => [] }, onError: () => {} });
  const model = f.addModel('/a.php', '<?php class A {}');
  await service.refresh();
  f.workers[0].events.error({ message: 'worker crashed' });
  await assert.rejects(f.providers.definition.provideDefinition(model, { lineNumber: 1, column: 15 }, {}), /worker crashed/);
  service.dispose();
});
