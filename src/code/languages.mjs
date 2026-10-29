// All parsing and symbol queries run in languages-worker. Files never become
// editor models just because the Joomla project index visits them.
const MAX_FILES = 12000;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const PHP_FILE = /\.(?:php\d?|phtml|inc)$/i;
const EXCLUDED = new Set(['.git', 'node_modules', 'cache', 'tmp', 'logs']);
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

export function installPhpLanguageServices({ monaco, workspace, siteId, phpVersion = '8.3',
  onError = () => {}, onStatus = () => {} }) {
  let worker, ready, failed, disposed = false, sequence = 0, revision = 0, scanning = null, generation = 0;
  let initialScan = false, invalidation = 0;
  let changesPending = Promise.resolve();
  const pending = new Map(), models = new Map(), indexed = new Map(), subscriptions = [];
  let status = { phase: 'idle', files: 0, bytes: 0, skipped: 0, phpVersion };
  function report(change) { status = { ...status, ...change }; onStatus(status); }
  function request(operation, args = {}) {
    if (disposed) return Promise.reject(new Error('PHP language service is closed.'));
    if (failed) return Promise.reject(failed);
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, args }); });
  }
  function start() {
    if (ready) return ready;
    const filename = './languages-worker.js';
    worker = new Worker(new URL(filename, import.meta.url), { type: 'module', name: 'JoomEngine Code PHP and HTML' });
    worker.addEventListener('message', ({ data }) => {
      const call = pending.get(data.id);
      if (!call) return;
      pending.delete(data.id);
      if (data.error) call.reject(new Error(data.error)); else call.resolve(data.value);
    });
    worker.addEventListener('error', error => {
      const failure = new Error(error.message || 'PHP language worker failed.');
      failed = failure;
      for (const call of pending.values()) call.reject(failure);
      pending.clear();
      report({ phase: 'failed' });
      onError(failure);
    });
    ready = request('configure', { phpVersion });
    return ready;
  }
  const belongs = model => model.uri.scheme === 'jec' && model.uri.authority === siteId && model.getLanguageId() === 'php';
  function mark(model, diagnostics) {
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'joomengine-php', diagnostics.map(item => ({ ...item, severity: monaco.MarkerSeverity.Error })));
  }
  async function updateModel(model) {
    if (disposed || !belongs(model) || model.isDisposed()) return;
    const state = models.get(model);
    if (!state) return;
    clearTimeout(state.timer);
    const version = model.getVersionId();
    if (state.version === version) return state.pending;
    state.version = version;
    state.pending = (async () => {
      await start();
      const result = await request('update', { path: model.uri.path, source: model.getValue(), version: ++revision });
      if (!disposed) report(result.status);
      if (disposed || model.isDisposed() || model.getVersionId() !== version) return;
      mark(model, result.diagnostics || []);
      if (result.limited) report({ phase: 'partial', reason: 'PHP language indexing limits reached; this document was not analyzed.' });
      return result;
    })();
    return state.pending;
  }
  function track(model) {
    if (!belongs(model) || models.has(model) || disposed) return;
    const state = { version: -1, timer: null, subscriptions: [] };
    models.set(model, state);
    state.subscriptions.push(model.onDidChangeContent(() => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => void updateModel(model).catch(onError), 200);
    }), model.onWillDispose(() => untrack(model)));
    void updateModel(model).then(() => { if (!initialScan) return scan(); }).catch(onError);
  }
  function untrack(model) {
    const state = models.get(model);
    if (!state) return;
    clearTimeout(state.timer);
    for (const subscription of state.subscriptions) subscription.dispose();
    models.delete(model);
    mark(model, []);
    // A discarded unsaved buffer must not remain the project's indexed version.
    if (!disposed) void indexFile(model.uri.path, true).catch(onError);
  }
  function isOpen(path) { return [...models.keys()].some(model => model.uri.path === path); }
  async function forget(path) {
    const next = await request('remove', { path });
    for (const name of indexed.keys()) if (name === path || name.startsWith(`${path}/`)) {
      indexed.delete(name);
    }
    report(next);
    // Open buffers remain authoritative, including unsaved buffers whose on-disk
    // file was removed. Native editor conflict handling decides their fate.
    for (const [model, state] of models) if (model.uri.path === path || model.uri.path.startsWith(`${path}/`)) {
      state.version = -1;
      await updateModel(model);
    }
  }
  async function indexFile(path, force = false, metadata) {
    if (disposed || !worker || isOpen(path) || !PHP_FILE.test(path)) return;
    const previous = indexed.get(path);
    if (metadata?.size > MAX_FILE_BYTES) { await forget(path); report({ skipped: status.skipped + 1 }); return; }
    if (!force && previous && metadata && previous.size === metadata.size && previous.mtime === metadata.mtime) return;
    if (!previous && (indexed.size >= MAX_FILES || status.bytes >= MAX_BYTES)) { report({ phase: 'partial', reason: 'Project indexing limit reached.' }); return; }
    let file;
    try { file = await workspace.request('read', { path }); }
    catch (error) {
      await forget(path);
      if (['ENOENT', 'NOT_FOUND'].includes(error.code)) return;
      throw error;
    }
    if (disposed || isOpen(path)) return;
    if (file.bytes.byteLength > MAX_FILE_BYTES) { await forget(path); report({ skipped: status.skipped + 1 }); return; }
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { await forget(path); report({ skipped: status.skipped + 1 }); return; }
    let result;
    try { result = await request('update', { path, source, version: ++revision }); }
    catch (error) { await forget(path); throw error; }
    if (result.limited) { await forget(path); report({ phase: 'partial', reason: 'Project indexing limit reached.' }); return; }
    indexed.set(path, { size: file.bytes.byteLength, mtime: metadata?.mtime ?? file.stat?.mtime });
    report(result.status);
  }
  function scan({ force = false } = {}) {
    if (disposed || !worker) return Promise.resolve();
    if (scanning) return scanning;
    initialScan = true;
    const token = ++generation;
    const currentInvalidation = invalidation;
    scanning = (async () => {
      await ready;
      report({ phase: 'indexing', reason: '' });
      const directories = ['/'], seen = new Set();
      let count = 0;
      while (!disposed && token === generation && directories.length && count++ < MAX_FILES) {
        const path = directories.shift();
        let entries;
        try { entries = await workspace.request('list', { path }); }
        catch { report({ skipped: status.skipped + 1 }); continue; }
        // Joomla's public API is useful first; third-party libraries remain indexed.
        entries.sort((a, b) => (a.name === 'libraries' ? -1 : b.name === 'libraries' ? 1 : a.name.localeCompare(b.name)));
        for (const entry of entries) {
          if (disposed || token !== generation) return;
          if (entry.type === 'directory' && !EXCLUDED.has(entry.name)) directories.push(entry.path);
          else if (entry.type === 'file' && PHP_FILE.test(entry.name)) {
            seen.add(entry.path);
            try { await indexFile(entry.path, force, entry); }
            catch { report({ skipped: status.skipped + 1 }); }
          }
          if (indexed.size >= MAX_FILES || status.bytes >= MAX_BYTES) {
            report({ phase: 'partial', reason: 'Project indexing limit reached.' });
            directories.length = 0; break;
          }
        }
        await delay();
      }
      if (disposed || token !== generation) return;
      // Remove vanished files only after an untruncated, successful traversal.
      if (status.phase !== 'partial' && status.skipped === 0 && count < MAX_FILES) {
        for (const path of indexed.keys()) if (!seen.has(path) && !isOpen(path)) {
          await forget(path);
        }
      }
      const partial = status.phase === 'partial' || status.skipped || count >= MAX_FILES;
      report({ phase: currentInvalidation !== invalidation ? 'stale' : partial ? 'partial' : 'ready',
        reason: currentInvalidation !== invalidation ? 'A PHP request may have changed project files. Refresh PHP project index to rescan.'
          : partial ? status.reason || 'Some files could not be indexed because of size, encoding, read errors or project limits.' : '' });
    })().finally(() => { scanning = null; });
    return scanning;
  }
  async function query(model, position, token, operation) {
    if (!belongs(model) || token?.isCancellationRequested) return [];
    track(model);
    await updateModel(model);
    if (disposed || token?.isCancellationRequested || model.isDisposed()) return [];
    const version = model.getVersionId();
    const result = await request(operation, { path: model.uri.path, source: model.getValue(), offset: model.getOffsetAt(position) });
    return token?.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version ? [] : result;
  }
  const kinds = { class: 'Class', interface: 'Interface', trait: 'Class', enum: 'Enum', function: 'Function',
    method: 'Method', property: 'Property', constant: 'Constant', variable: 'Variable', keyword: 'Keyword', html: 'Property' };
  subscriptions.push(monaco.languages.registerCompletionItemProvider('php', {
    triggerCharacters: ['$', '>', ':', '\\', '<', ' ', '"', "'", '/'],
    async provideCompletionItems(model, position, _context, token) {
      const items = await query(model, position, token, 'complete');
      const word = model.getWordUntilPosition(position);
      let startColumn = word.startColumn;
      // PHP variables include '$'; Monaco's PHP word range omits that prefix.
      if (startColumn > 1 && model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: startColumn - 1,
        endLineNumber: position.lineNumber, endColumn: startColumn }) === '$') startColumn--;
      return { suggestions: items.map(item => {
        const start = Number.isInteger(item.replaceStart) ? model.getPositionAt(item.replaceStart) : { lineNumber: position.lineNumber, column: startColumn };
        const end = Number.isInteger(item.replaceEnd) ? model.getPositionAt(item.replaceEnd) : { lineNumber: position.lineNumber, column: word.endColumn };
        return { label: item.label, insertText: item.insertText,
        kind: monaco.languages.CompletionItemKind[kinds[item.kind] || 'Text'], detail: item.detail,
        documentation: item.documentation ? { value: item.documentation, isTrusted: false } : undefined,
        insertTextRules: item.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range: item.editRange ? { startLineNumber: item.editRange.start.line + 1, startColumn: item.editRange.start.character + 1,
          endLineNumber: item.editRange.end.line + 1, endColumn: item.editRange.end.character + 1 }
          : { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } };
      }) };
    },
  }), monaco.languages.registerDefinitionProvider('php', {
    async provideDefinition(model, position, token) {
      return (await query(model, position, token, 'definition')).map(item => ({ uri: monaco.Uri.from({ scheme: 'jec', authority: siteId, path: item.path }), range: item.selectionRange }));
    },
  }), monaco.languages.registerDocumentSymbolProvider('php', {
    displayName: 'JoomEngine Code PHP',
    async provideDocumentSymbols(model, token) {
      const items = await query(model, { lineNumber: 1, column: 1 }, token, 'symbols');
      const convert = item => ({ name: item.name, detail: item.signature || '', tags: [],
        kind: monaco.languages.SymbolKind[kinds[item.kind] || 'Variable'], range: item.range, selectionRange: item.selectionRange,
        children: items.filter(child => child.container === item.qualifiedName).map(convert) });
      return items.filter(item => !item.container).map(convert);
    },
  }), monaco.editor.onDidCreateModel(track), monaco.editor.onDidChangeModelLanguage(({ model }) => {
    if (belongs(model)) track(model); else untrack(model);
  }));
  const unsubscribe = workspace.subscribe?.(event => {
    if (!worker || disposed) return;
    if (event.type === 'workspace-invalidated') {
      invalidation++;
      // HTTP may alter arbitrary files. Do not reread a whole installation after
      // each request; native file notifications and explicit refresh revalidate it.
      report({ phase: 'stale', reason: 'A PHP request may have changed project files. Refresh PHP project index to rescan.' });
      return;
    }
    // A multi-file save/copy can emit hundreds of paths. Keep indexing reads
    // sequential so they cannot exhaust the active site's request queue.
    changesPending = changesPending.then(async () => {
      for (const change of event.changes || []) {
        if (disposed) return;
        if (change.type === 'deleted') await forget(change.path);
        else if (PHP_FILE.test(change.path)) await indexFile(change.path, true);
        else if (change.type === 'created') {
          const entry = await workspace.request('stat', { path: change.path });
          if (entry?.type === 'directory') { if (scanning) await scanning; await scan(); }
        }
      }
    }).catch(error => { if (!disposed) onError(error); });
  });
  for (const model of monaco.editor.getModels()) track(model);
  return {
    getStatus: () => ({ ...status }),
    async refresh() { await start(); await changesPending; if (scanning) await scanning; status.skipped = 0; await scan({ force: true }); return { ...status }; },
    dispose() {
      disposed = true; generation++;
      unsubscribe?.();
      for (const subscription of subscriptions) subscription.dispose();
      for (const model of models.keys()) untrack(model);
      worker?.terminate();
      for (const call of pending.values()) call.reject(new Error('PHP language service is closed.'));
      pending.clear();
    },
  };
}
