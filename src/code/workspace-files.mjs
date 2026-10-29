/**
 * Worker-owned filesystem boundary for JoomEngine Code.
 *
 * This service accepts workspace paths, never editor URIs or runtime paths. Its
 * caller must serialize handle() with PHP requests; a batch stays one operation
 * in that queue. Persistence belongs to the runtime owner and is intentionally
 * separate from successful writes to the live filesystem.
 */
export const WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxBatchBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
  maxChanges: 128,
  maxHistory: 8,
  maxHistoryBytes: 96 * 1024 * 1024,
});

const mutations = new Set(['write', 'mkdir', 'copy', 'rename', 'delete']);
const encoder = new TextEncoder();

export class WorkspaceFileError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkspaceFileError'; this.code = code; }
}

function error(code, message) { throw new WorkspaceFileError(code, message); }
function missing(cause) { return cause?.code === 'ENOENT' || cause?.errno === 44; }
function directory(mode) { return (mode & 0o170000) === 0o040000; }
function regular(mode) { return (mode & 0o170000) === 0o100000; }
function symbolic(mode) { return (mode & 0o170000) === 0o120000; }
function within(path, root) { return path === root || path.startsWith(`${root}/`); }
function parent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function basename(path) { return path.slice(path.lastIndexOf('/') + 1); }
function date(value) { return value instanceof Date ? value.getTime() : Number(value) || 0; }

/** A leading slash means the workspace root, not the runtime filesystem root. */
export function normalizeWorkspacePath(path = '/') {
  if (typeof path !== 'string' || path.length > 4096 || /[\0\\]/.test(path)) {
    error('INVALID_PATH', 'A workspace path must be a string without NUL or backslashes, at most 4096 characters.');
  }
  if (path === '' || path === '/') return '/';
  const parts = path.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || encoder.encode(part).length > 255)) {
    error('INVALID_PATH', 'Workspace paths cannot contain traversal, empty components or names larger than 255 bytes.');
  }
  return `/${parts.join('/')}`;
}

function absolute(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\0\\]/.test(path)) error('INVALID_PATH', 'Invalid runtime path.');
  const result = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return `/${result.join('/')}`;
}

function contents(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value)
    : value instanceof Uint8Array ? value.slice()
      : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : null;
  if (!bytes) error('INVALID_CONTENT', 'File contents must be a string, Uint8Array or ArrayBuffer.');
  return bytes;
}

async function digest(bytes) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * FS is the Emscripten FS instance; /persist may itself be the owner's IDBFS
 * symlink. Resolve that trusted root once and reject later root redirection.
 */
export function createWorkspaceFileService(FS, root = '/persist/www', options = {}) {
  const limits = { ...WORKSPACE_LIMITS, ...options };
  for (const key of Object.keys(WORKSPACE_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) error('INVALID_LIMIT', `Invalid workspace limit: ${key}.`);
  }
  const rootPath = absolute(root);
  if (rootPath === '/') error('INVALID_PATH', 'The whole runtime filesystem cannot be exposed as a workspace.');
  const history = [];
  const searches = new Map();
  let historyBytes = 0;
  let sequence = 0;

  function lstat(path) {
    try { return FS.lstat(path); }
    catch (cause) { if (missing(cause)) return null; throw cause; }
  }

  // Resolve every symlink explicitly: checking a string prefix before FS.readFile
  // is insufficient, and Emscripten analyzePath follows links implicitly.
  function canonical(path, { allowMissing = false, boundary = null, followLeaf = true } = {}) {
    let pending = absolute(path).split('/').filter(Boolean);
    let resolved = '';
    let links = 0;
    while (pending.length) {
      const part = pending.shift();
      const candidate = `${resolved}/${part}`;
      const info = lstat(candidate);
      if (!info) {
        if (!allowMissing) error('ENOENT', 'The workspace file or folder no longer exists.');
        return absolute(`${candidate}/${pending.join('/')}`);
      }
      if (symbolic(info.mode) && (followLeaf || pending.length)) {
        if (++links > 40) error('SYMLINK_LOOP', 'The workspace path contains a symbolic-link loop.');
        const target = FS.readlink(candidate);
        const destination = absolute(target.startsWith('/') ? target : `${resolved}/${target}`);
        if (boundary && !within(destination, boundary)) error('PATH_OUTSIDE_WORKSPACE', 'A symbolic link leaves the active Joomla workspace.');
        pending = [...destination.split('/').filter(Boolean), ...pending];
        resolved = '';
      } else {
        if (pending.length && !directory(info.mode)) error('ENOTDIR', 'A workspace path component is not a folder.');
        resolved = candidate;
      }
    }
    return resolved || '/';
  }

  const physicalRoot = canonical(rootPath);
  if (!directory(FS.lstat(physicalRoot).mode)) error('ENOTDIR', 'The Joomla workspace root is not a folder.');

  function assertRoot() {
    if (canonical(rootPath) !== physicalRoot) error('WORKSPACE_CHANGED', 'The Joomla workspace root changed; reopen JoomEngine Code.');
  }

  function resolve(path, settings = {}) {
    const relative = normalizeWorkspacePath(path);
    const result = canonical(`${physicalRoot}${relative === '/' ? '' : relative}`, { boundary: physicalRoot, ...settings });
    if (!within(result, physicalRoot)) error('PATH_OUTSIDE_WORKSPACE', 'The path leaves the active Joomla workspace.');
    return result;
  }

  function relative(path) { return path.slice(physicalRoot.length) || '/'; }
  function editable(path) {
    if (options.readOnly) error('READ_ONLY', 'Saved files cannot be modified in read-only recovery.');
    if (path === physicalRoot) error('PROTECTED_ROOT', 'The workspace root cannot be replaced, moved, copied or deleted.');
  }

  function metadata(path, info, actual = resolve(path)) {
    info ??= FS.stat(actual);
    return {
      path: normalizeWorkspacePath(path), canonicalPath: relative(actual),
      type: directory(info.mode) ? 'directory' : regular(info.mode) ? 'file' : 'other',
      size: info.size, mtime: date(info.mtime), ctime: date(info.ctime),
      readonly: Boolean(options.readOnly) || (info.mode & 0o222) === 0,
    };
  }

  function fileBytes(path) {
    const info = FS.stat(path);
    if (!regular(info.mode)) error('NOT_A_FILE', 'The selected workspace item is not a regular file.');
    if (info.size > limits.maxFileBytes) error('LIMIT_EXCEEDED', `The file exceeds the ${limits.maxFileBytes} byte editor limit; use the site export for larger files.`);
    return FS.readFile(path, { encoding: 'binary' }).slice();
  }

  // Snapshots never follow a link when traversing a tree. Each link target is
  // checked nonetheless, including during recursive rename/delete preflight.
  function snapshot(path, budget = { bytes: 0, entries: 0 }) {
    const actual = resolve(path, { allowMissing: true, followLeaf: false });
    const info = lstat(actual);
    if (!info) return null;
    if (++budget.entries > limits.maxEntries) error('LIMIT_EXCEEDED', 'The change affects too many entries for bounded recovery.');
    const value = { mode: info.mode, mtime: date(info.mtime) };
    if (symbolic(info.mode)) {
      resolve(path, { allowMissing: true }); // Dangling in-root links are safe to unlink; escapes are not.
      return { ...value, type: 'symlink', target: FS.readlink(actual) };
    }
    if (directory(info.mode)) {
      const children = FS.readdir(actual).filter(name => name !== '.' && name !== '..').sort();
      return { ...value, type: 'directory', children: children.map(name => [name, snapshot(`${path === '/' ? '' : path}/${name}`, budget)]) };
    }
    if (!regular(info.mode)) error('UNSUPPORTED_FILE', 'Special runtime files cannot be changed through the workspace.');
    const bytes = fileBytes(actual);
    budget.bytes += bytes.byteLength;
    if (budget.bytes > limits.maxBatchBytes) error('LIMIT_EXCEEDED', 'The change is too large for the bounded recovery snapshot.');
    return { ...value, type: 'file', bytes };
  }

  async function fingerprint(value) {
    if (!value) return null;
    if (value.type === 'file') return digest(value.bytes);
    if (value.type === 'symlink') return `link:${await digest(encoder.encode(value.target))}`;
    const children = await Promise.all(value.children.map(async ([name, item]) => [name, item.mode, await fingerprint(item)]));
    return `tree:${await digest(encoder.encode(JSON.stringify(children)))}`;
  }

  async function revision(path) {
    const actual = resolve(path, { allowMissing: true, followLeaf: false });
    const info = lstat(actual);
    if (!info) return null;
    return regular(info.mode) ? digest(fileBytes(actual)) : fingerprint(snapshot(path));
  }

  async function precondition(path, expected, expectedCanonicalPath) {
    if (expectedCanonicalPath !== undefined) {
      const canonicalPath = normalizeWorkspacePath(expectedCanonicalPath);
      if (relative(resolve(path, { allowMissing: true })) !== canonicalPath) {
        error('CONFLICT', `The workspace target changed since it was reviewed: ${normalizeWorkspacePath(path)}.`);
      }
    }
    if (expected === undefined) return;
    if (expected !== null && typeof expected !== 'string') error('INVALID_REVISION', 'A revision must be a string or null for a missing file.');
    if (await revision(path) !== expected) error('CONFLICT', `The workspace item changed since it was reviewed: ${normalizeWorkspacePath(path)}.`);
  }

  function writable(path) {
    const info = lstat(path);
    const container = FS.stat(parent(path));
    if ((container.mode & 0o222) === 0 || (info && !symbolic(info.mode) && (info.mode & 0o222) === 0)) {
      error('READ_ONLY', 'The workspace item or its parent folder is read-only.');
    }
  }

  function erase(path) {
    const info = lstat(path);
    if (!info) return;
    if (directory(info.mode)) {
      for (const name of FS.readdir(path)) if (name !== '.' && name !== '..') erase(`${path}/${name}`);
      FS.rmdir(path);
    } else FS.unlink(path);
  }

  function restore(path, value) {
    if (!value) return;
    if (value.type === 'directory') {
      FS.mkdir(path, 0o700);
      for (const [name, item] of value.children) restore(`${path}/${name}`, item);
    } else if (value.type === 'symlink') FS.symlink(value.target, path);
    else FS.writeFile(path, value.bytes);
    if (value.type !== 'symlink') {
      FS.chmod?.(path, value.mode & 0o777);
      FS.utime?.(path, value.mtime, value.mtime);
    }
  }

  function relocatedLink(source, sourceRoot, destinationRoot) {
    const target = canonical(source, { boundary: physicalRoot, allowMissing: true });
    return within(target, sourceRoot) ? `${destinationRoot}${target.slice(sourceRoot.length)}` : target;
  }

  function copyTree(source, destination, sourceRoot = source, destinationRoot = destination) {
    const info = FS.lstat(source);
    if (symbolic(info.mode)) {
      // Absolute in-workspace targets preserve meaning when the link moves.
      FS.symlink(relocatedLink(source, sourceRoot, destinationRoot), destination);
    } else if (directory(info.mode)) {
      FS.mkdir(destination, 0o700);
      for (const name of FS.readdir(source)) if (name !== '.' && name !== '..') copyTree(`${source}/${name}`, `${destination}/${name}`, sourceRoot, destinationRoot);
      FS.chmod?.(destination, info.mode & 0o777);
    } else {
      FS.writeFile(destination, fileBytes(source));
      FS.chmod?.(destination, info.mode & 0o777);
    }
  }

  function linksForMove(source, destination) {
    const links = [];
    function visit(path) {
      const info = FS.lstat(path);
      if (symbolic(info.mode)) {
        links.push({ path, target: canonical(path, { boundary: physicalRoot, allowMissing: true }),
          destination: `${destination}${path.slice(source.length)}`, relocated: relocatedLink(path, source, destination) });
      } else if (directory(info.mode)) {
        for (const name of FS.readdir(path)) if (name !== '.' && name !== '..') visit(`${path}/${name}`);
      }
    }
    visit(source);
    return links;
  }

  function remember(entry) {
    history.push(entry);
    historyBytes += entry.bytes;
    while (history.length > limits.maxHistory || historyBytes > limits.maxHistoryBytes) {
      const removed = history.shift();
      historyBytes -= removed.bytes;
    }
  }

  function publish(changes) {
    if (!changes.length) return;
    try { options.onChange?.(changes); } catch { /* A notification cannot undo completed filesystem writes. */ }
  }

  async function captureAfter(entries) {
    return Promise.all(entries.map(async ({ path }) => {
      try {
        const canonicalPath = relative(resolve(path, { allowMissing: true }));
        return { path, canonicalPath, revision: await revision(path) };
      }
      catch (cause) { return { path, error: cause.message, code: cause.code || 'READ_FAILED' }; }
    }));
  }

  async function batch(args) {
    if (options.readOnly) error('READ_ONLY', 'Saved files cannot be modified in read-only recovery.');
    if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > limits.maxChanges) {
      error('LIMIT_EXCEEDED', `A change set must contain between 1 and ${limits.maxChanges} operations.`);
    }
    let totalBytes = 0;
    const changes = args.changes.map(input => {
      if (!input || !mutations.has(input.operation)) error('INVALID_OPERATION', 'Unsupported workspace mutation.');
      const change = { ...input, path: normalizeWorkspacePath(input.path) };
      const actual = resolve(change.path, { allowMissing: true, followLeaf: false });
      editable(actual);
      if (['rename', 'copy'].includes(change.operation)) {
        change.target = normalizeWorkspacePath(change.target);
        const target = resolve(change.target, { allowMissing: true, followLeaf: false });
        editable(target);
        if (within(target, actual) || within(actual, target)) error('INVALID_TARGET', 'Source and destination must be distinct, non-overlapping workspace paths.');
      }
      if (change.operation === 'write') {
        change.bytes = contents(change.bytes);
        if (change.bytes.byteLength > limits.maxFileBytes) error('LIMIT_EXCEEDED', 'The file exceeds the workspace write limit.');
        totalBytes += change.bytes.byteLength;
      }
      if (totalBytes > limits.maxBatchBytes) error('LIMIT_EXCEEDED', 'The change set exceeds the workspace write limit.');
      return change;
    });
    if (args.preconditions !== undefined && (!Array.isArray(args.preconditions) || args.preconditions.length > limits.maxEntries)) error('INVALID_REVISION', 'Invalid change-set preconditions.');
    for (const condition of args.preconditions || []) await precondition(condition.path, condition.revision, condition.canonicalPath);
    for (const change of changes) {
      await precondition(change.path, change.expectedRevision, change.expectedCanonicalPath);
      if (change.target) await precondition(change.target, change.expectedTargetRevision, change.expectedTargetCanonicalPath);
    }
    // Snapshot canonical destinations too: two aliases must not produce separate
    // undo records for the same underlying directory or file.
    const affected = [...new Set(changes.flatMap(change => [change.path, change.target].filter(Boolean)
      .map(path => relative(resolve(path, { allowMissing: true, followLeaf: false })))))].sort((a, b) => a.length - b.length);
    const roots = affected.filter((path, index) => !affected.slice(0, index).some(ancestor => within(path, ancestor)));
    const budget = { bytes: 0, entries: 0 };
    const before = roots.map(path => ({ path, snapshot: snapshot(path, budget) }));
    if (budget.bytes > limits.maxHistoryBytes) error('LIMIT_EXCEEDED', 'The change cannot fit in the bounded recovery history.');
    const results = [];
    const notifications = [];
    let failed;
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      try {
        const actual = resolve(change.path, { allowMissing: true, followLeaf: false });
        editable(actual);
        const info = lstat(actual);
        if (info && symbolic(info.mode)) resolve(change.path, { allowMissing: true }); // Validate leaf links before unlink/rename.
        const target = change.target ? resolve(change.target, { allowMissing: true, followLeaf: false }) : null;
        writable(actual);
        switch (change.operation) {
          case 'write': {
            if (info && !regular(info.mode)) error('NOT_A_FILE', 'Only regular files can be written; replace links explicitly.');
            if (!info && change.create === false) error('ENOENT', 'The file no longer exists.');
            if (info && change.overwrite !== true) error('EEXIST', 'The file already exists; confirm overwrite before replacing it.');
            FS.writeFile(actual, change.bytes);
            notifications.push({ type: info ? 'changed' : 'created', path: change.path });
            results.push({ operation: change.operation, path: change.path, revision: await digest(change.bytes) });
            break;
          }
          case 'mkdir':
            if (info) error('EEXIST', 'A workspace item already uses that name.');
            FS.mkdir(actual, 0o755);
            notifications.push({ type: 'created', path: change.path });
            results.push({ operation: change.operation, path: change.path });
            break;
          case 'delete':
            if (!info) error('ENOENT', 'The item to delete no longer exists.');
            if (directory(info.mode) && change.recursive !== true && FS.readdir(actual).some(name => name !== '.' && name !== '..')) error('ENOTEMPTY', 'Confirm recursive deletion before removing a nonempty folder.');
            erase(actual);
            notifications.push({ type: 'deleted', path: change.path });
            results.push({ operation: change.operation, path: change.path });
            break;
          case 'copy':
          case 'rename': {
            if (!info) error('ENOENT', 'The source item no longer exists.');
            writable(target);
            const replaced = lstat(target);
            if (replaced && change.overwrite !== true) error('EEXIST', 'The destination already exists; confirm overwrite before replacing it.');
            if (replaced) erase(target);
            if (change.operation === 'copy') copyTree(actual, target);
            else {
              // Normalize every link before moving a tree. Relative links must
              // never acquire an out-of-root meaning at their new location.
              const links = linksForMove(actual, target);
              for (const link of links) { FS.unlink(link.path); FS.symlink(link.target, link.path); }
              FS.rename(actual, target);
              for (const link of links) {
                if (link.relocated !== link.target) { FS.unlink(link.destination); FS.symlink(link.relocated, link.destination); }
              }
              notifications.push({ type: 'deleted', path: change.path });
            }
            notifications.push({ type: replaced ? 'changed' : 'created', path: change.target });
            results.push({ operation: change.operation, path: change.path, target: change.target });
            break;
          }
        }
      } catch (cause) {
        failed = { index, operation: change.operation, path: change.path, message: cause.message, code: cause.code || 'WRITE_FAILED' };
        break;
      }
    }
    // A failing FS write may have modified bytes before throwing. Always retain
    // the preflight snapshot and report invalidation for every affected root.
    const after = await captureAfter(before);
    const unreadable = after.find(item => item.error);
    if (unreadable && !failed) failed = { index: results.length, operation: 'verify', path: unreadable.path,
      message: `Writes completed, but their resulting state could not be verified: ${unreadable.error}`, code: unreadable.code };
    const recoveryId = `workspace-${++sequence}`;
    remember({ id: recoveryId, createdAt: Date.now(), bytes: budget.bytes, before, after });
    if (failed) for (const path of roots) notifications.push({ type: 'changed', path });
    publish(notifications);
    return { ok: !failed, results, changes: notifications, recoveryId, ...(failed ? { failed } : {}) };
  }

  async function recover(args) {
    if (options.readOnly) error('READ_ONLY', 'Saved files cannot be modified in read-only recovery.');
    const entry = history.find(item => item.id === args.recoveryId);
    if (!entry) error('RECOVERY_EXPIRED', 'This recovery snapshot is no longer available in the bounded session history.');
    for (const item of entry.after) {
      if (item.error) error('RECOVERY_UNVERIFIED', `The post-write state of ${item.path} could not be read. Its snapshot is retained; automatic recovery cannot safely overwrite unverified changes.`);
      await precondition(item.path, item.revision, item.canonicalPath);
    }
    const results = [];
    const changes = [];
    let failed;
    for (let index = 0; index < entry.before.length; index++) {
      const item = entry.before[index];
      try {
        const actual = resolve(item.path, { allowMissing: true, followLeaf: false });
        editable(actual);
        erase(actual);
        restore(actual, item.snapshot);
        results.push({ operation: 'recover', path: item.path });
        changes.push({ type: item.snapshot ? 'changed' : 'deleted', path: item.path });
      } catch (cause) {
        failed = { index, operation: 'recover', path: item.path, message: cause.message, code: cause.code || 'WRITE_FAILED' };
        changes.push({ type: 'changed', path: item.path });
        break;
      }
    }
    if (!failed) {
      history.splice(history.indexOf(entry), 1);
      historyBytes -= entry.bytes;
    } else {
      // Keep the snapshot for explicit retry, against the state actually left by
      // the partial recovery rather than blindly repeating an old change set.
      entry.after = await captureAfter(entry.before);
    }
    publish(changes);
    return { ok: !failed, results, changes, recoveryId: entry.id, ...(failed ? { failed } : {}) };
  }

  function searchPattern(value) {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || item.length > 1024)) {
      error('INVALID_SEARCH', 'Search include/exclude patterns must be an array of at most 64 glob strings.');
    }
    return value.map(pattern => {
      let source = '';
      for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*') {
          index++;
          if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; }
          else source += '.*';
        } else if (character === '*') source += '[^/]*';
        else if (character === '?') source += '[^/]';
        else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(`^${source}$`);
    });
  }

  async function search(args) {
    const now = Date.now();
    for (const [id, state] of searches) if (now - state.touched > 300_000) searches.delete(id);
    const maxResults = args.maxResults ?? 100;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500) error('INVALID_SEARCH', 'Search pages must contain between 1 and 500 results.');
    let state;
    let cursor = args.cursor;
    if (cursor !== undefined && cursor !== null) {
      state = searches.get(cursor);
      if (!state) error('SEARCH_EXPIRED', 'The search expired or was cancelled; start it again.');
      if (args.query !== undefined && args.query !== state.query) error('INVALID_SEARCH', 'A search cursor cannot be used with a different query.');
    } else {
      if (typeof args.query !== 'string' || args.query.length > 1024) error('INVALID_SEARCH', 'A search query must be a string of at most 1024 characters.');
      if (args.isRegex === true) error('UNSUPPORTED_SEARCH', 'The worker search supports literal and whole-word text; regular expressions require the workbench search provider.');
      const kind = args.kind ?? 'files';
      if (!['files', 'text'].includes(kind) || (kind === 'text' && !args.query)) error('INVALID_SEARCH', 'Choose file search or a nonempty text query.');
      if (searches.size >= 8) error('LIMIT_EXCEEDED', 'Too many workspace searches are active; cancel an older search.');
      const start = normalizeWorkspacePath(args.path);
      resolve(start);
      state = {
        query: args.query, needle: args.caseSensitive ? args.query : args.query.toLocaleLowerCase(),
        kind, caseSensitive: args.caseSensitive === true, isWordMatch: args.isWordMatch === true,
        include: searchPattern(args.include), exclude: searchPattern(args.exclude),
        pending: [start], active: null, visited: 0, skipped: 0, touched: now,
      };
      cursor = `search-${crypto.randomUUID()}`;
      searches.set(cursor, state);
    }
    state.touched = now;
    const results = [];
    let visited = 0;
    let scannedBytes = 0;
    let truncated = false;
    const deadline = performance.now() + 25;
    const selected = path => (!state.include?.length || state.include.some(pattern => pattern.test(path.slice(1))))
      && !state.exclude?.some(pattern => pattern.test(path.slice(1)));
    while (results.length < maxResults && (state.active || state.pending.length)) {
      if (visited >= 128 || scannedBytes >= 4 * 1024 * 1024 || performance.now() >= deadline) break;
      if (state.active) {
        const active = state.active;
        const index = active.comparable.indexOf(state.needle, active.offset);
        if (index === -1) { state.active = null; continue; }
        active.offset = index + Math.max(1, state.needle.length);
        const last = index + state.needle.length;
        if (state.isWordMatch && (/[\p{L}\p{N}_]/u.test(active.text[index - 1] || '') || /[\p{L}\p{N}_]/u.test(active.text[last] || ''))) continue;
        // Lowercasing can change Unicode string length. Locate results against
        // original text only when offsets remain faithful to the source bytes.
        if (active.comparable.length !== active.text.length) { state.skipped++; state.active = null; continue; }
        while (active.lineStart < index) {
          const newline = active.text.indexOf('\n', active.lineStart);
          if (newline === -1 || newline >= index) break;
          active.lineNumber++;
          active.lineStart = newline + 1;
        }
        const lineEnd = active.text.indexOf('\n', index);
        const end = lineEnd === -1 ? active.text.length : lineEnd;
        const previewStart = Math.max(active.lineStart, index - 200);
        results.push({
          path: active.path, revision: active.revision, lineNumber: active.lineNumber,
          column: index - active.lineStart + 1, endColumn: last - active.lineStart + 1,
          preview: active.text.slice(previewStart, Math.min(end, last + 200)), previewColumn: index - previewStart + 1,
        });
        continue;
      }
      if (++state.visited > limits.maxEntries) { truncated = true; state.pending.length = 0; break; }
      visited++;
      const path = state.pending.pop();
      let actual, info;
      try { actual = resolve(path, { followLeaf: false }); info = FS.lstat(actual); }
      catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      // Do not recursively follow directory aliases: cycles and duplicate trees
      // would otherwise make searches unbounded. Users can open a link directly.
      if (symbolic(info.mode)) { state.skipped++; continue; }
      if (directory(info.mode)) {
        if (state.exclude?.some(pattern => pattern.test(`${path.slice(1)}/`))) continue;
        const names = FS.readdir(actual).filter(name => name !== '.' && name !== '..');
        if (names.length + state.pending.length > limits.maxEntries) { truncated = true; state.pending.length = 0; break; }
        for (const name of names.sort().reverse()) state.pending.push(`${path === '/' ? '' : path}/${name}`);
        continue;
      }
      if (!regular(info.mode) || !selected(path)) continue;
      if (state.kind === 'files') {
        const match = state.caseSensitive ? path : path.toLocaleLowerCase();
        if (match.includes(state.needle)) results.push({ path });
        continue;
      }
      if (info.size > Math.min(limits.maxFileBytes, 1024 * 1024)) { state.skipped++; continue; }
      const bytes = fileBytes(actual);
      scannedBytes += bytes.byteLength;
      if (bytes.includes(0)) { state.skipped++; continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { state.skipped++; continue; }
      state.active = { path, text, comparable: state.caseSensitive ? text : text.toLocaleLowerCase(),
        revision: await digest(bytes), offset: 0, lineStart: 0, lineNumber: 1 };
    }
    if (!state.active && !state.pending.length) searches.delete(cursor);
    return { results, cursor: searches.has(cursor) ? cursor : null, truncated, skipped: state.skipped, visited: state.visited };
  }

  async function handle(operation, args = {}) {
    assertRoot();
    if (!args || typeof args !== 'object') error('INVALID_ARGUMENT', 'Workspace operation arguments must be an object.');
    if (mutations.has(operation)) return batch({ changes: [{ ...args, operation }] });
    switch (operation) {
      case 'stat': {
        const path = normalizeWorkspacePath(args.path);
        const actual = resolve(path, { allowMissing: true });
        const info = lstat(actual);
        return info ? { ...metadata(path, info, actual), ...(args.revision ? { revision: await revision(path) } : {}) } : null;
      }
      case 'list': {
        const path = normalizeWorkspacePath(args.path);
        const actual = resolve(path);
        if (!directory(FS.stat(actual).mode)) error('ENOTDIR', 'The workspace item is not a folder.');
        const names = FS.readdir(actual).filter(name => name !== '.' && name !== '..');
        if (names.length > limits.maxEntries) error('LIMIT_EXCEEDED', 'This folder contains too many entries to display at once.');
        return names.sort().map(name => {
          const child = `${path === '/' ? '' : path}/${name}`;
          try { return { name, ...metadata(child) }; }
          catch (cause) {
            if (!symbolic(FS.lstat(`${actual}/${name}`).mode)) throw cause;
            return { name, path: child, type: 'symlink', size: 0, mtime: 0, ctime: 0, readonly: true, error: cause.code || 'UNREADABLE_LINK' };
          }
        });
      }
      case 'read': {
        const path = normalizeWorkspacePath(args.path);
        const actual = resolve(path);
        const bytes = fileBytes(actual);
        const stat = metadata(path, undefined, actual);
        return { path, canonicalPath: stat.canonicalPath, bytes, revision: await digest(bytes), stat };
      }
      case 'batch': return batch(args);
      case 'recover': return recover(args);
      case 'history': return history.map(({ id, createdAt, bytes, before }) => ({ id, createdAt, bytes, paths: before.map(item => item.path) }));
      case 'search': return search(args);
      case 'cancelSearch': return { cancelled: searches.delete(args.cursor) };
      default: error('INVALID_OPERATION', `Unknown workspace operation: ${operation}.`);
    }
  }

  return Object.freeze({ handle });
}
