import { decorateAction } from '../icons.mjs';
import { normalizeWorkspacePath, WORKSPACE_LIMITS } from './workspace-files.mjs';

export const FILE_ACTION_MESSAGES = Object.freeze({
  'code.files.upload': 'Upload files',
  'code.files.download': 'Download file',
  'code.files.preview': 'Preview image',
  'code.files.history': 'File recovery',
  'code.files.close': 'Close',
  'code.files.directory': 'Destination folder',
  'code.files.choose': 'Choose files',
  'code.files.path': 'Workspace file',
  'code.files.uploadHelp': 'Upload into an existing workspace folder. Replacing files requires confirmation. Save or discard any affected unsaved editor changes first. Limit: 32 MiB per file, 64 MiB per upload.',
  'code.files.savedHelp': 'Downloads and previews use the bytes saved in the running site. Save editor changes first to include them.',
  'code.files.overwrite': 'Replace these saved files? Their current contents will be kept in the bounded recovery history.\n\n{paths}',
  'code.files.dirtyDownload': 'This file has unsaved editor changes. Download the saved version anyway?\n\n{path}',
  'code.files.working': 'Working…',
  'code.files.uploaded': 'Uploaded {count} file(s). Refresh the site to see saved changes.',
  'code.files.cancelled': 'No files changed.',
  'code.files.downloadCancelled': 'Download cancelled.',
  'code.files.downloaded': 'Download started for {path}.',
  'code.files.open': 'Open file in editor',
  'code.files.previewHelp': 'Safe image previews support PNG, JPEG, GIF and WebP. Other formats, including SVG, can be downloaded without executing their contents.',
  'code.files.unsupported': 'This file is not a supported raster image. Download it to inspect it with a suitable application.',
  'code.files.imageFailed': 'The browser could not decode this image. Its saved bytes are unchanged and can still be downloaded.',
  'code.files.imageAlt': 'Preview of {path}',
  'code.files.imageSize': '{width} × {height} pixels · {bytes} bytes',
  'code.files.historyHelp': 'Recent file changes can be restored while this site remains open. Up to 8 snapshots are kept within a 96 MiB budget. Old snapshots expire. Review every affected path before restoring; newly created files in that snapshot will be removed.',
  'code.files.emptyHistory': 'No recovery snapshots are available for this site.',
  'code.files.restore': 'Restore snapshot',
  'code.files.restorePrompt': 'Restore the previous saved state of every path below? This undoes that snapshot’s file changes, including removing files it created. Later disk changes or unsaved editor changes prevent restoration.\n\n{paths}',
  'code.files.restored': 'Previous saved files restored. Refresh the site to see the change.',
  'code.files.snapshot': '{time} · {bytes} bytes',
  'code.files.partial': '{count} operation(s) completed before {path} failed: {message}. No automatic retry was made. Review File recovery before changing these files again.',
  'code.files.persistence': 'Files changed in the running site, but browser storage could not be saved: {message}',
});

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function parent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function basename(path) { return path.slice(path.lastIndexOf('/') + 1); }
function checkAborted(signal) { signal?.throwIfAborted(); }
function checkDirty(paths, isDirty) {
  for (const path of paths) {
    if (isDirty(path, true)) fail('DIRTY_FILE', `Save or discard unsaved editor changes in ${path} before replacing its saved contents.`);
  }
}

function guardedFileMutation({ workspace, paths, isDirty, signal }, operation, args) {
  checkAborted(signal);
  checkDirty(paths, isDirty);
  if (typeof workspace.withBatch !== 'function') {
    fail('RESERVATION_REQUIRED', 'File changes require an exclusive workspace reservation.');
  }
  return workspace.withBatch(reserved => {
    // PHP can hold the queue while a user continues editing. Check again only
    // after the owner grants this reservation, immediately before dispatch.
    checkAborted(signal);
    checkDirty(paths, isDirty);
    return reserved.request(operation, args);
  });
}

/** The caller confirms the snapshot's affected paths before requesting restoration. */
export function recoverWorkspaceSnapshot({ workspace, snapshot, isDirty = () => false, signal }) {
  return guardedFileMutation({ workspace, paths: snapshot.paths, isDirty, signal },
    'recover', { recoveryId: snapshot.id });
}

/** Upload one reviewed batch; revisions are checked again by the authoritative worker. */
export async function uploadWorkspaceFiles({ workspace, directory = '/', files, isDirty = () => false,
  confirmOverwrite = async () => false, signal }) {
  checkAborted(signal);
  directory = normalizeWorkspacePath(directory);
  const uploads = Array.from(files || []);
  if (!uploads.length || uploads.length > WORKSPACE_LIMITS.maxChanges) {
    fail('LIMIT_EXCEEDED', `Choose between 1 and ${WORKSPACE_LIMITS.maxChanges} files for one upload.`);
  }
  const targets = new Set();
  let totalBytes = 0;
  const prepared = uploads.map(file => {
    if (typeof file?.name !== 'string' || !file.name || /[\x00-\x1f\x7f/\\]/.test(file.name)) {
      fail('INVALID_PATH', 'Upload file names cannot contain path separators or control characters.');
    }
    const path = normalizeWorkspacePath(`${directory === '/' ? '' : directory}/${file.name}`);
    if (targets.has(path)) fail('DUPLICATE_PATH', `More than one uploaded file uses the name ${file.name}.`);
    targets.add(path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > WORKSPACE_LIMITS.maxFileBytes) {
      fail('LIMIT_EXCEEDED', `The upload ${file.name} exceeds the 32 MiB file limit.`);
    }
    totalBytes += file.size;
    if (totalBytes > WORKSPACE_LIMITS.maxBatchBytes) fail('LIMIT_EXCEEDED', 'The selected files exceed the 64 MiB upload limit.');
    return { file, path };
  });
  const folder = await workspace.request('stat', { path: directory });
  checkAborted(signal);
  if (folder?.type !== 'directory') fail('ENOTDIR', 'Choose an existing workspace folder as the upload destination.');
  if (folder.readonly) fail('READ_ONLY', 'The destination folder is read-only.');
  if (typeof folder.canonicalPath !== 'string') fail('INVALID_PATH', 'The workspace did not identify the upload destination.');
  const canonicalFolder = normalizeWorkspacePath(folder.canonicalPath);
  for (const item of prepared) {
    item.canonicalPath = normalizeWorkspacePath(`${canonicalFolder === '/' ? '' : canonicalFolder}/${item.file.name}`);
    targets.add(item.canonicalPath);
  }
  checkDirty([...targets], isDirty);
  const replacements = [];
  for (const item of prepared) {
    item.existing = await workspace.request('stat', { path: item.path, revision: true });
    checkAborted(signal);
    if (item.existing && item.existing.type !== 'file') fail('NOT_A_FILE', `${item.path} is not a regular file.`);
    if (item.existing?.readonly) fail('READ_ONLY', `${item.path} is read-only.`);
    if (item.existing && item.existing.canonicalPath !== item.canonicalPath) {
      fail('CONFLICT', `The upload destination changed or is a symbolic link: ${item.path}. Select its actual folder and try again.`);
    }
    if (item.existing) replacements.push(item.path);
  }
  if (replacements.length && !await confirmOverwrite(replacements)) return { cancelled: true, changes: [], results: [] };
  checkAborted(signal);
  const changes = [];
  for (const { file, path, canonicalPath, existing } of prepared) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkAborted(signal);
    if (bytes.byteLength !== file.size) fail('INVALID_CONTENT', `The upload ${file.name} changed while it was being read. Select it again.`);
    changes.push({ operation: 'write', path, bytes, create: true, overwrite: Boolean(existing),
      expectedRevision: existing?.revision ?? null, expectedCanonicalPath: canonicalPath });
  }
  // A user can edit while file bytes are read; never replace that newly dirty document.
  return guardedFileMutation({ workspace, paths: [...targets], isDirty, signal }, 'batch', { changes });
}

/** Sniff bytes, never extensions or user-supplied MIME types. No active/vector formats. */
export function detectRasterImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const starts = value => value.every((byte, index) => bytes[index] === byte);
  const ascii = (offset, value) => [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length >= 24 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && ascii(12, 'IHDR')) return 'image/png';
  if (bytes.length >= 4 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 13 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif';
  if (bytes.length >= 16 && ascii(0, 'RIFF') && ascii(8, 'WEBP') && (ascii(12, 'VP8 ') || ascii(12, 'VP8L') || ascii(12, 'VP8X'))) return 'image/webp';
  return null;
}

/** Host actions share the existing site workspace and never read editor/provider storage. */
export function mountFileActions({ toolbar, workspace, getActivePath = () => '/', openFile,
  isDirty = () => false, onError = () => {}, t = key => key }) {
  const document = toolbar.ownerDocument;
  const window = document.defaultView;
  // Native auxiliary editor windows do not load Rocket's page stylesheet.
  // Scope these essentials to file dialogs so they stay usable in either realm.
  const style = document.createElement('style');
  style.textContent = `
.jec-file-dialog{box-sizing:border-box;font:14px/1.5 system-ui,sans-serif;color:var(--ink,#edf0ff);color-scheme:inherit;background:var(--panel,#161c3b);border:1px solid var(--control-border,#465073);border-radius:12px;padding:24px;width:min(600px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;box-shadow:0 24px 80px #0009}
.jec-file-dialog::backdrop{background:#020619b3}
.jec-file-dialog .dialog-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.jec-file-dialog h2{font-size:22px;line-height:1.3;margin:0;overflow-wrap:anywhere}
.jec-file-dialog p{font-size:13px;line-height:1.7;color:var(--muted,#acb4d0);overflow-wrap:anywhere}
.jec-file-dialog button,.jec-file-dialog input{box-sizing:border-box;font:inherit;color:var(--ink,#edf0ff);background:var(--control,#151c32);border:1px solid var(--control-border,#465073);border-radius:5px;padding:8px 12px;min-height:36px}
.jec-file-dialog button{cursor:pointer}.jec-file-dialog button:disabled,.jec-file-dialog input:disabled{opacity:.5;cursor:default}
.jec-file-dialog button:focus-visible,.jec-file-dialog input:focus-visible{outline:2px solid var(--focus,#ffc55b);outline-offset:2px}
.jec-file-dialog .dialog-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--line,#ffffff1b)}
.jec-file-dialog .dialog-error{color:var(--danger,#ffd0c3);background:var(--error-bg,#ff836012);border:1px solid var(--danger,#ff83603b);padding:10px 13px;border-radius:5px}
@media(max-width:480px){.jec-file-dialog{padding:16px}.jec-file-dialog .dialog-heading{gap:8px}.jec-file-dialog h2{font-size:19px}}
@media(forced-colors:active){.jec-file-dialog,.jec-file-dialog button,.jec-file-dialog input{border-color:ButtonText}.jec-file-dialog button:focus-visible,.jec-file-dialog input:focus-visible{outline-color:Highlight}}
`;
  document.head.append(style);
  const controls = [], dialogs = new Set(), objectURLs = new Map();
  let disposed = false, sequence = 0, pointerPath;
  const activePath = () => pointerPath ?? getActivePath() ?? '/';
  const label = (key, values = {}) => {
    const translated = t(key, values);
    return String(translated === key ? FILE_ACTION_MESSAGES[key] ?? key : translated)
      .replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
  };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const fileIcons = { 'code.files.upload': 'upload-files', 'code.files.choose': 'upload-files', 'code.files.download': 'download-file', 'code.files.preview': 'preview-image', 'code.files.history': 'file-recovery', 'code.files.close': 'cancel', 'code.files.open': 'open-file', 'code.files.restore': 'restore-snapshot' };
  const button = (key, action) => {
    const node = element('button', label(key), 'button secondary'); node.type = 'button';
    node.setAttribute('data-i18n', key);
    node.addEventListener('click', () => { if (!disposed) void Promise.resolve().then(action).catch(error => { if (!disposed) onError(error); }); });
    decorateAction(node, fileIcons[key] || 'apply');
    return node;
  };
  function revoke(url) {
    if (!objectURLs.has(url)) return;
    window.clearTimeout(objectURLs.get(url));
    objectURLs.delete(url); window.URL.revokeObjectURL(url);
  }
  function blobURL(bytes, type) {
    const url = window.URL.createObjectURL(new window.Blob([bytes], { type }));
    objectURLs.set(url, undefined); return url;
  }
  function modal(key) {
    const dialog = element('dialog', undefined, 'rocket-dialog jec-file-dialog');
    const heading = element('div', undefined, 'dialog-heading');
    const title = element('h2', label(key)); title.id = `jec-file-dialog-${++sequence}`;
    title.setAttribute('data-i18n', key);
    dialog.setAttribute('aria-labelledby', title.id);
    const state = { dialog, closed: false, pending: false, urls: new Set(), controller: new AbortController() };
    const close = button('code.files.close', () => { if (!state.pending) dialog.close(); });
    const message = element('p'); message.setAttribute('role', 'status'); message.hidden = true;
    const content = element('div');
    heading.append(title, close); dialog.append(heading, content, message);
    dialog.addEventListener('cancel', event => { if (state.pending) event.preventDefault(); });
    state.dispose = () => {
      if (state.closed) return;
      state.closed = true; state.controller.abort();
      for (const url of state.urls) revoke(url);
      if (dialog.open) dialog.close();
      dialog.remove(); dialogs.delete(state);
    };
    dialog.addEventListener('close', state.dispose);
    state.show = (text, error = false) => {
      if (state.closed || disposed) return;
      message.textContent = text; message.hidden = false; message.className = error ? 'dialog-error' : '';
      message.setAttribute('role', error ? 'alert' : 'status');
    };
    state.run = async action => {
      if (state.pending || state.closed || disposed) return;
      state.pending = true; dialog.setAttribute('aria-busy', 'true');
      const enabled = [...dialog.querySelectorAll('button,input')].filter(node => !node.disabled);
      enabled.forEach(node => { node.disabled = true; });
      state.show(label('code.files.working'));
      try { await action(); }
      catch (error) { if (error.name !== 'AbortError') state.show(error.message, true); }
      finally {
        state.pending = false; dialog.removeAttribute('aria-busy');
        enabled.forEach(node => { node.disabled = false; });
      }
    };
    dialogs.add(state); document.body.append(dialog); dialog.showModal();
    return { ...state, state, content, message };
  }
  function field(container, key, value, type = 'text') {
    const wrapper = element('label', undefined, 'field');
    wrapper.style.cssText = 'display:block;margin:16px 0';
    const input = element('input'); input.type = type; input.required = true;
    if (value !== undefined) input.value = value;
    input.style.cssText = 'display:block;box-sizing:border-box;width:100%;margin-top:6px';
    if (type === 'text') { input.spellcheck = false; input.autocomplete = 'off'; }
    const caption = element('span', label(key)); caption.setAttribute('data-i18n', key);
    wrapper.append(caption, input); container.append(wrapper); return input;
  }
  function form(container, key, submit) {
    const node = element('form');
    const action = element('button', label(key), 'button'); action.type = 'submit';
    action.setAttribute('data-i18n', key);
    decorateAction(action, fileIcons[key] || 'apply');
    const actions = element('div', undefined, 'dialog-actions'); actions.append(action);
    node.addEventListener('submit', event => { event.preventDefault(); void submit(); });
    container.append(node); return { node, actions };
  }
  function resultMessage(result, success) {
    if (result?.ok !== true) return { error: true, text: label('code.files.partial', {
      count: result?.results?.length || 0, path: result?.failed?.path || '/', message: result?.failed?.message || 'The operation did not finish.',
    }) };
    if (result.persistence?.error) return { error: true, text: label('code.files.persistence', { message: result.persistence.error }) };
    return { error: false, text: success };
  }
  async function upload() {
    const view = modal('code.files.upload');
    view.content.append(element('p', label('code.files.uploadHelp')));
    const uploadForm = form(view.content, 'code.files.upload', () => view.run(async () => {
      const result = await uploadWorkspaceFiles({ workspace, directory: destination.value, files: files.files, isDirty,
        signal: view.state.controller.signal,
        confirmOverwrite: paths => window.confirm(label('code.files.overwrite', { paths: paths.join('\n') })),
      });
      if (view.state.closed || disposed) return;
      if (result.cancelled) { view.show(label('code.files.cancelled')); return; }
      const outcome = resultMessage(result, label('code.files.uploaded', { count: result.results.length }));
      view.show(outcome.text, outcome.error);
      // Preserve the receipt after partial progress; retrying could repeat completed writes.
      uploadForm.node.remove();
      if (result.ok && result.results.length === 1 && openFile) {
        view.content.append(button('code.files.open', async () => {
          await openFile(result.results[0].path); view.state.dialog.close();
        }));
      }
      view.content.append(button('code.files.history', () => { view.state.dialog.close(); return history(); }));
    }));
    const destination = field(uploadForm.node, 'code.files.directory', '/');
    const files = field(uploadForm.node, 'code.files.choose', undefined, 'file'); files.multiple = true;
    uploadForm.node.append(uploadForm.actions);
    const selectedPath = normalizeWorkspacePath(activePath());
    try {
      const info = await workspace.request('stat', { path: selectedPath });
      if (!view.state.closed && !view.state.pending && destination.value === '/') destination.value = info?.type === 'directory' ? selectedPath : parent(selectedPath);
    } catch (error) { view.show(error.message, true); }
  }
  async function readFile(path) {
    path = normalizeWorkspacePath(path);
    const info = await workspace.request('stat', { path });
    if (info?.type !== 'file') fail('NOT_A_FILE', 'Choose an existing workspace file.');
    const result = await workspace.request('read', { path });
    if (disposed) throw new DOMException('The workspace is closed.', 'AbortError');
    return result;
  }
  async function downloadFile(path, view) {
    path = normalizeWorkspacePath(path);
    if (isDirty(path) && !window.confirm(label('code.files.dirtyDownload', { path }))) { view.show(label('code.files.downloadCancelled')); return; }
    const { bytes } = await readFile(path);
    if (view.state.closed || disposed) return;
    const url = blobURL(bytes, 'application/octet-stream');
    const link = element('a'); link.href = url; link.download = basename(path); link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    // Browsers consume downloads asynchronously. This URL is never persisted or sent elsewhere.
    objectURLs.set(url, window.setTimeout(() => revoke(url), 30_000));
    view.show(label('code.files.downloaded', { path }));
  }
  function fileDialog(preview) {
    const key = preview ? 'code.files.preview' : 'code.files.download';
    const view = modal(key);
    view.content.append(element('p', label('code.files.savedHelp')));
    if (preview) view.content.append(element('p', label('code.files.previewHelp')));
    const output = element('div');
    const pathForm = form(view.content, key, () => view.run(async () => {
      if (!preview) { await downloadFile(input.value, view); return; }
      const { bytes, path } = await readFile(input.value);
      if (view.state.closed || disposed) return;
      for (const url of view.state.urls) revoke(url);
      view.state.urls.clear(); output.replaceChildren();
      const download = button('code.files.download', () => view.run(() => downloadFile(path, view)));
      output.append(download);
      const type = detectRasterImageType(bytes);
      if (!type) { view.show(label('code.files.unsupported')); return; }
      const url = blobURL(bytes, type); view.state.urls.add(url);
      const img = element('img'); img.alt = label('code.files.imageAlt', { path });
      img.style.cssText = 'display:block;max-width:100%;max-height:55vh;object-fit:contain;margin:16px auto';
      img.onload = () => view.show(label('code.files.imageSize', { width: img.naturalWidth, height: img.naturalHeight, bytes: bytes.byteLength }));
      img.onerror = () => { revoke(url); view.state.urls.delete(url); img.remove(); view.show(label('code.files.imageFailed'), true); };
      img.src = url; output.prepend(img);
    }));
    const input = field(pathForm.node, 'code.files.path', activePath());
    pathForm.node.append(pathForm.actions); view.content.append(output);
    input.focus(); input.select();
  }
  async function history() {
    const view = modal('code.files.history');
    view.content.append(element('p', label('code.files.historyHelp')));
    const list = element('div'); view.content.append(list);
    const render = async () => {
      const entries = await workspace.request('history', {});
      if (view.state.closed || disposed) return;
      list.replaceChildren();
      if (!entries.length) { list.append(element('p', label('code.files.emptyHistory'))); return; }
      for (const entry of entries.slice().reverse()) {
        const section = element('section'); section.style.cssText = 'border-top:1px solid #465073;padding:12px 0';
        section.append(element('p', label('code.files.snapshot', { time: new Date(entry.createdAt).toLocaleString(), bytes: entry.bytes })));
        const paths = element('ul'); paths.style.cssText = 'padding-inline-start:20px;font-size:12px;overflow-wrap:anywhere';
        for (const path of entry.paths) paths.append(element('li', path));
        const restore = button('code.files.restore', () => view.run(async () => {
          checkDirty(entry.paths, isDirty);
          if (!window.confirm(label('code.files.restorePrompt', { paths: entry.paths.join('\n') }))) { view.show(label('code.files.cancelled')); return; }
          const result = await recoverWorkspaceSnapshot({ workspace, snapshot: entry, isDirty, signal: view.state.controller.signal });
          const outcome = resultMessage(result, label('code.files.restored'));
          view.show(outcome.text, outcome.error);
          await render();
        }));
        section.append(paths, restore); list.append(section);
      }
    };
    await view.run(async () => { await render(); view.message.hidden = true; });
  }
  for (const [key, action] of [
    ['code.files.upload', upload], ['code.files.download', () => fileDialog(false)],
    ['code.files.preview', () => fileDialog(true)], ['code.files.history', history],
  ]) {
    const node = button(key, async () => { try { await action(); } finally { pointerPath = undefined; } });
    // Capture Explorer selection before the host button takes focus from its iframe.
    node.addEventListener('pointerdown', () => { pointerPath = getActivePath() || '/'; });
    node.addEventListener('keydown', () => { pointerPath = undefined; });
    node.title = label(key); node.setAttribute('data-i18n-title', key); controls.push(node); toolbar.append(node);
  }
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const view of [...dialogs]) view.dispose();
      for (const url of [...objectURLs.keys()]) revoke(url);
      for (const control of controls) control.remove();
      style.remove();
    },
  });
}
