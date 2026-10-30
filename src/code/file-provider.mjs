import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event';
import { FileChangeType, FilePermission, FileSystemProviderCapabilities, FileSystemProviderError,
  FileSystemProviderErrorCode, FileType, FileOperationError, FileOperationResult } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files';

const errors = {
  ENOENT: FileSystemProviderErrorCode.FileNotFound,
  EEXIST: FileSystemProviderErrorCode.FileExists,
  ENOTDIR: FileSystemProviderErrorCode.FileNotADirectory,
  EISDIR: FileSystemProviderErrorCode.FileIsADirectory,
  PATH_OUTSIDE_WORKSPACE: FileSystemProviderErrorCode.NoPermissions,
  ROOT_PROTECTED: FileSystemProviderErrorCode.NoPermissions,
  NOT_FOUND: FileSystemProviderErrorCode.FileNotFound,
  EXISTS: FileSystemProviderErrorCode.FileExists,
  NOT_DIRECTORY: FileSystemProviderErrorCode.FileNotADirectory,
  IS_DIRECTORY: FileSystemProviderErrorCode.FileIsADirectory,
  FORBIDDEN: FileSystemProviderErrorCode.NoPermissions,
  READ_ONLY: FileSystemProviderErrorCode.NoPermissions,
};
const types = { file: FileType.File, directory: FileType.Directory, symlink: FileType.SymbolicLink };
const sourceReads = new Set(['stat', 'list', 'read', 'search', 'cancelSearch']);

/** The editor uses site-relative URIs; only the worker knows the PHP document root. */
export function workspaceUri(siteId, path = '/') {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(siteId)) throw new TypeError('Invalid JoomEngine Code site identity.');
  validatePath(path);
  return URI.from({ scheme: 'jec', authority: siteId, path });
}

function validatePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\0\\]/.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) {
    throw new TypeError('The file must be inside the active JoomEngine Code workspace.');
  }
}

export function workspacePath(uri, siteId) {
  if (uri.scheme !== 'jec' || uri.authority !== siteId || uri.query || uri.fragment) {
    throw new TypeError('The file belongs to a different JoomEngine Code workspace.');
  }
  validatePath(uri.path);
  return uri.path;
}

/** A lazy VS Code provider backed by authoritative worker operations, never a mirrored tree. */
export class JoomlaFileSystemProvider {
  capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
    | FileSystemProviderCapabilities.FileFolderCopy;
  onDidChangeCapabilities = Event.None;
  saves = new Emitter();
  onDidWriteFile = this.saves.event;
  changes = new Emitter();
  onDidChangeFile = this.changes.event;
  revisions = new Map();
  readRevisions = new Map();
  canonicalPaths = new Map();
  readCanonicalPaths = new Map();
  isDirty = () => false;

  constructor(workspace, siteId, { onSave = () => {}, onError = () => {} } = {}) {
    this.workspace = workspace;
    this.siteId = siteId;
    this.onSave = onSave;
    this.onError = onError;
    this.listed = new Set();
    this.observed = new Map();
    this.waiting = [];
    this.activeRequests = 0;
    this.activeReads = 0;
    this.inflight = new Map();
    this.subscription = workspace.subscribe?.(event => {
      if (event.type === 'workspace-invalidated' || (event.type === 'debug-state' && event.state === 'paused')) {
        void this.revalidate().catch(onError);
      }
      else this.notify(event.changes || event);
    });
  }

  uri(path) { return workspaceUri(this.siteId, path); }
  path(uri) { return workspacePath(uri, this.siteId); }
  async request(operation, args) {
    // Explorer resolves sibling metadata concurrently. Bound source reads
    // independently so queued saves cannot prevent opening a paused stack frame.
    const key = ['stat', 'list'].includes(operation) ? `${operation}:${JSON.stringify(args)}` : null;
    if (key && this.inflight.has(key)) return this.inflight.get(key);
    const pending = new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('This JoomEngine Code file service is closed.')); return; }
      this.waiting.push({ operation, args, resolve, reject });
      this.drain();
    });
    const translated = pending.catch(error => {
      const failure = error.code === 'CONFLICT'
        ? new FileOperationError(error.message, FileOperationResult.FILE_MODIFIED_SINCE)
        : new FileSystemProviderError(error.message, errors[error.code] || FileSystemProviderErrorCode.Unknown);
      // Keep VS Code's public code while allowing workspace clients to handle
      // recoverable protocol errors such as a cursor from another PHP runtime.
      failure.cause = error;
      failure.workspaceCode = error.code;
      throw failure;
    }).finally(() => { if (key && this.inflight.get(key) === translated) this.inflight.delete(key); });
    if (key) this.inflight.set(key, translated);
    return translated;
  }
  drain() {
    while (!this.disposed && this.waiting.length) {
      const index = this.waiting.findIndex(({ operation }) => sourceReads.has(operation)
        ? this.activeReads < 4 : this.activeRequests < 4);
      if (index < 0) break;
      const { operation, args, resolve, reject } = this.waiting.splice(index, 1)[0];
      const active = sourceReads.has(operation) ? 'activeReads' : 'activeRequests';
      this[active]++;
      Promise.resolve().then(() => (this.batchWorkspace || this.workspace).request(operation, args))
        .then(resolve, reject).finally(() => { this[active]--; this.drain(); });
    }
  }
  notify(changes) {
    if (!Array.isArray(changes)) return;
    const events = changes.map(change => ({ resource: this.uri(change.path), type: {
      created: FileChangeType.ADDED, changed: FileChangeType.UPDATED, deleted: FileChangeType.DELETED,
    }[change.type] })).filter(change => change.type !== undefined);
    if (events.length) this.changes.fire(events);
  }
  async mutation(operation, args) {
    const result = await this.request(operation, args);
    // A durability failure does not undo a successful live write. Remember exactly
    // those revisions so retrying that save cannot conflict with our own write.
    for (const entry of result.results || []) {
      if (entry.operation === 'write' && entry.revision) {
        this.revisions.set(entry.path, entry.revision);
        this.observed.set(entry.path, entry.revision);
      }
    }
    if (!this.subscription) this.notify(result.changes);
    if (result.ok === false) {
      const message = result.failed?.error?.message || result.failed?.message || 'Some file changes could not be applied. Review recovery before retrying.';
      this.onError({ ...result, message });
      throw new FileSystemProviderError(message, FileSystemProviderErrorCode.Unknown);
    }
    await this.onSave(result);
    if (result.persistence?.enabled && result.persistence.saved === false) {
      const message = `Files changed in the running site, but durable storage failed: ${result.persistence.error || 'storage unavailable'}. Keep this tab open and save the site again.`;
      this.onError({ ...result, message });
      throw new FileSystemProviderError(message, FileSystemProviderErrorCode.Unavailable);
    }
    return result;
  }
  async stat(uri) {
    const value = await this.request('stat', { path: this.path(uri) });
    if (!value) throw new FileSystemProviderError('File does not exist.', FileSystemProviderErrorCode.FileNotFound);
    return { type: types[value.type] || FileType.Unknown, size: value.size, mtime: value.mtime,
      ctime: value.ctime, permissions: value.readonly ? FilePermission.Readonly : undefined };
  }
  async readdir(uri) {
    const path = this.path(uri);
    const entries = await this.request('list', { path });
    this.listed.add(path);
    return entries.map(entry => [entry.name, types[entry.type] || FileType.Unknown]);
  }
  async readFile(uri) {
    const path = this.path(uri);
    const result = await this.request('read', { path });
    if (!this.isDirty(path) || !this.revisions.has(path)) this.revisions.set(path, result.revision);
    if (!this.isDirty(path) || !this.canonicalPaths.has(path)) this.canonicalPaths.set(path, result.canonicalPath || path);
    this.readCanonicalPaths.set(path, result.canonicalPath || path);
    this.readRevisions.set(path, result.revision);
    this.observed.set(path, result.revision);
    return new Uint8Array(result.bytes);
  }
  acceptReadRevision(path) {
    if (this.readRevisions.has(path)) this.revisions.set(path, this.readRevisions.get(path));
    if (this.readCanonicalPaths.has(path)) this.canonicalPaths.set(path, this.readCanonicalPaths.get(path));
  }
  async currentIdentity(path) {
    const current = await this.request('stat', { path, revision: true });
    if (current) return { revision: current.revision, canonicalPath: current.canonicalPath || path };
    const separator = path.lastIndexOf('/');
    const parent = await this.request('stat', { path: path.slice(0, separator) || '/' });
    return { revision: null, canonicalPath: `${(parent?.canonicalPath || path.slice(0, separator) || '/').replace(/\/$/, '')}/${path.slice(separator + 1)}` };
  }
  async authorizeOverwrite(path) {
    const current = await this.currentIdentity(path);
    this.revisions.set(path, current.revision);
    this.canonicalPaths.set(path, current.canonicalPath);
  }
  async writeFile(uri, bytes, options) {
    const path = this.path(uri);
    let expectedRevision = this.revisions.get(path);
    if (expectedRevision === undefined) {
      // Save As and new files may not have been read by this provider. Capture
      // their current state too, so an intervening PHP write cannot go unnoticed.
      const current = await this.currentIdentity(path);
      expectedRevision = current.revision;
      this.canonicalPaths.set(path, current.canonicalPath);
    }
    const result = await this.mutation('write', { path, bytes: new Uint8Array(bytes), create: options.create,
      overwrite: options.overwrite, expectedRevision, expectedCanonicalPath: this.canonicalPaths.get(path) || path });
    // Do not cache a post-write read: a Joomla request may already have changed it again.
    const written = result.results?.find(entry => entry.path === path && entry.operation === 'write');
    if (written?.revision) this.revisions.set(path, written.revision);
    this.saves.fire({ path, bytes: new Uint8Array(bytes) });
  }
  mkdir(uri) { return this.mutation('mkdir', { path: this.path(uri) }); }
  delete(uri, options) { return this.mutation('delete', { path: this.path(uri), recursive: options.recursive }); }
  rename(from, to, options) {
    return this.mutation('rename', { path: this.path(from), target: this.path(to), overwrite: options.overwrite });
  }
  copy(from, to, options) {
    return this.mutation('copy', { path: this.path(from), target: this.path(to), overwrite: options.overwrite });
  }
  watch() { return { dispose() {} }; }
  async withBatch(callback) {
    if (!this.workspace.withBatch) throw new Error('This runtime does not support coordinated Save All. Save files individually or reload the updated Playground.');
    return this.workspace.withBatch(async workspace => {
      this.batchWorkspace = workspace;
      try { return await callback(); }
      finally { this.batchWorkspace = null; }
    });
  }
  revalidate() {
    if (this.disposed) return Promise.resolve();
    if (this.revalidating) { this.checkAgain = true; return this.revalidating; }
    this.revalidating = (async () => {
      do {
        this.checkAgain = false;
        const changes = [];
        for (const [path, previous] of [...this.observed]) {
          if (this.disposed) return;
          const current = await this.request('stat', { path, revision: true });
          if (current?.revision !== previous) {
            this.observed.set(path, current?.revision);
            changes.push({ path, type: current ? 'changed' : 'deleted' });
          }
        }
        // Only already-expanded directories are refreshed; no eager tree walk.
        for (const path of this.listed) changes.push({ path, type: 'changed' });
        this.notify(changes);
      } while (this.checkAgain && !this.disposed);
    })().finally(() => { this.revalidating = null; });
    return this.revalidating;
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.waiting.splice(0)) pending.reject(new Error('This JoomEngine Code file service is closed.'));
    if (typeof this.subscription === 'function') this.subscription();
    else this.subscription?.dispose();
    this.changes.dispose();
    this.saves.dispose();
    this.revisions.clear();
    this.readRevisions.clear();
    this.canonicalPaths.clear();
    this.readCanonicalPaths.clear();
    this.observed.clear();
    this.listed.clear();
  }
}
