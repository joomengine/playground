import { archiveBlob, backupFilename } from './site-backups.mjs';

const messages = {
  'backups.empty': 'No backups yet.',
  'backups.storage': 'Backups: {count} · {size}. Browser storage: {used} used of approximately {quota}.',
  'backups.storageUnknown': 'Backups: {count} · {size}. Browser storage estimate is unavailable.',
  'backups.created': 'Backup saved at {time}.', 'backups.updated': 'Backup updated at {time}.',
  'backups.preparing': 'Preparing a complete site backup…',
  'backups.noSpace': 'There is not enough browser storage to keep this backup. No new backup was saved. Download the complete site to preserve this version.',
  'backups.writeFailed': 'The browser could not store this backup. No new backup was saved. Download the complete site to preserve this version.',
  'backups.previousKept': 'The previous backup remains unchanged.',
  'backups.namePrompt': 'Name this backup:', 'backups.updateChoice': 'Update “{name}” or create a new backup?',
  'backups.update': 'Update this backup', 'backups.createNew': 'Create a new backup', 'backups.cancel': 'Cancel',
  'backups.deleteConfirm': 'Delete backup “{name}”? This cannot be undone.', 'backups.deleted': 'Backup deleted.',
  'backups.restore': 'Restore', 'backups.download': 'Download', 'backups.delete': 'Delete',
  'backups.details': '{size} · {time} · Joomla {joomla} · JCB {jcb} · PHP {php}',
  'backups.managedEmpty': 'No other removable stored data.', 'backups.removeData': 'Remove',
  'backups.removeDataConfirm': 'Remove “{name}” from browser storage? This cannot be undone.',
  'backups.clearConfirm': 'Delete all backups and other eligible stored data? The current live site and entries requiring individual removal will be kept. This cannot be undone.',
  'backups.cleared': 'Backups and eligible stored data cleared. The current live site and entries requiring individual removal were kept.',
  'backups.downloadReady': 'The complete site archive is ready to download.',
  'backups.unavailable': 'Start a site before creating a backup.',
  'backups.fallbackDownload': 'Download this backup',
  'backups.storageError': 'Some stored data could not be listed: {message}',
  'backups.changed': 'The backup changed in another window. The previous backup was not replaced. Download this version or try again.',
  'backups.none': 'None', 'backups.removeSuccess': 'Stored data removed.', 'backups.retained': 'Current live site — retained',
};

export function formatBackupBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** The panel owns archive actions; the application owns the live runtime lifecycle. */
export function createBackupPanel({ element, backups, getRuntime, createArchive,
  onRestore, onBackupSaved = () => {}, getSourceBackupId = () => null,
  getManagedEntries = async () => [], removeManagedEntry = async () => {},
  onDownload, onError = () => {}, onBusy = () => {}, isBlocked = () => false, t = key => key } = {}) {
  if (!element || !backups || typeof createArchive !== 'function') throw new TypeError('A backup panel, storage and exporter are required.');
  const doc = element.ownerDocument, win = doc.defaultView;
  const find = id => element.querySelector(`#${id}`);
  const list = find('backup-list'), managedList = find('backup-storage-list'), summary = find('backups-storage-summary');
  const notice = find('backups-message'), capture = find('backup-current-button'), clear = find('backups-clear-button');
  const fallbackButton = find('backups-download-fallback'), collapse = find('close-backups-panel');
  if ([list, managedList, summary, notice, capture, clear, fallbackButton, collapse].some(value => !value)) throw new Error('The backup panel is incomplete.');
  let busy = false, disposed = false, records = [], managedEntries = [], fallback, refreshing = null;
  const listeners = [];
  const text = (key, parameters = {}) => {
    const translated = t(key, parameters);
    const value = typeof translated === 'string' && translated !== key ? translated : messages[key] || key;
    return value.replace(/\{([^}]+)\}/g, (match, name) => String(parameters[name] ?? match));
  };
  const listen = (node, event, handler) => { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); };
  const report = error => { show(error?.message || String(error), true); try { onError(error); } catch { /* Reporting cannot discard the archive. */ } };
  function show(value, error = false) { notice.hidden = false; notice.textContent = value; notice.dataset.error = String(error); }
  function expanded(value) {
    element.hidden = !value;
    for (const id of ['backup-button', 'local-images-button']) doc.getElementById(id)?.setAttribute('aria-expanded', String(value));
  }
  function updateState() {
    const current = getRuntime?.();
    const available = Boolean(current?.healthy && !current.recovery);
    const blocked = busy || isBlocked();
    for (const button of element.querySelectorAll('button[data-backup-action]')) button.disabled = blocked;
    capture.disabled = blocked || !available;
    clear.disabled = blocked || (!records.length && !managedEntries.some(entry => entry.removable && !entry.active && !entry.manualOnly));
    fallbackButton.disabled = blocked || !fallback;
  }
  async function action(operation) {
    // Only an action that acquired the application busy state may release it.
    if (busy || disposed || isBlocked()) return;
    busy = true; updateState();
    try { onBusy(true); await operation(); }
    catch (error) { report(error); }
    finally { busy = false; try { onBusy(false); } finally { if (!disposed) updateState(); } }
  }
  const button = (label, name, callback) => {
    const control = doc.createElement('button'); control.type = 'button';
    control.className = 'button button-secondary'; control.dataset.backupAction = name;
    control.textContent = text(label); control.addEventListener('click', () => { void action(callback); });
    return control;
  };
  function description(name, details) {
    const content = doc.createElement('div'); content.className = 'backup-description';
    const title = doc.createElement('strong'); title.textContent = name;
    const sub = doc.createElement('small'); sub.textContent = details;
    content.append(title, sub); return content;
  }
  async function download(archive, name) {
    const blob = archiveBlob(archive), filename = backupFilename(name || archive.metadata?.siteName || 'joomla-site');
    if (onDownload) await onDownload({ blob, filename, mimeType: 'application/zip', metadata: archive.metadata });
    else {
      const url = URL.createObjectURL(blob), link = doc.createElement('a');
      link.href = url; link.download = filename; doc.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    show(text('backups.downloadReady'));
  }
  function render() {
    list.replaceChildren();
    for (const record of records) {
      const row = doc.createElement('li'); row.className = 'backup-card'; row.dataset.backupId = record.id;
      row.append(description(record.name, text('backups.details', {
        size: formatBackupBytes(record.size), time: record.updatedAt,
        joomla: record.joomlaVersion || '—', jcb: record.jcbVersion || text('backups.none'), php: record.phpVersion || '—',
      })));
      const controls = doc.createElement('div'); controls.className = 'backup-actions';
      controls.append(button('backups.restore', 'restore', async () => {
        const saved = await backups.get(record.id);
        await onRestore?.(saved.blob, saved);
        await refresh();
      }), button('backups.download', 'download', async () => download(await backups.get(record.id), record.name)),
      button('backups.delete', 'delete', async () => {
        if (!win.confirm(text('backups.deleteConfirm', { name: record.name }))) return;
        await backups.remove(record.id); show(text('backups.deleted')); await refresh();
      }));
      row.append(controls); list.append(row);
    }
    if (!records.length) { const empty = doc.createElement('li'); empty.textContent = text('backups.empty'); list.append(empty); }
    managedList.replaceChildren();
    for (const entry of managedEntries) {
      const row = doc.createElement('li'); row.className = 'backup-card'; row.dataset.storageId = entry.id;
      row.append(description(entry.name, [entry.description || entry.kind, entry.size === undefined ? '' : formatBackupBytes(entry.size), entry.active ? text('backups.retained') : ''].filter(Boolean).join(' · ')));
      if (entry.removable && !entry.active) row.append(button('backups.removeData', 'remove-data', async () => {
        if (!win.confirm(text('backups.removeDataConfirm', { name: entry.name }))) return;
        await removeManagedEntry(entry); show(text('backups.removeSuccess')); await refresh();
      }));
      managedList.append(row);
    }
    if (!managedEntries.length) { const empty = doc.createElement('li'); empty.textContent = text('backups.managedEmpty'); managedList.append(empty); }
    updateState();
  }
  function refresh() {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const [archiveResult, managedResult, usageResult] = await Promise.allSettled([backups.list(), getManagedEntries(), backups.usage()]);
      if (disposed) return;
      records = archiveResult.status === 'fulfilled' ? archiveResult.value : [];
      managedEntries = managedResult.status === 'fulfilled' ? managedResult.value : [];
      const estimate = usageResult.status === 'fulfilled' ? usageResult.value : null;
      const values = { count: records.length, size: formatBackupBytes(records.reduce((total, record) => total + record.size, 0)),
        used: formatBackupBytes(estimate?.usage), quota: formatBackupBytes(estimate?.quota) };
      summary.textContent = text(Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) ? 'backups.storage' : 'backups.storageUnknown', values);
      const failure = [archiveResult, managedResult].find(result => result.status === 'rejected');
      if (failure) show(text('backups.storageError', { message: failure.reason?.message || String(failure.reason) }), true);
      render();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function chooseUpdate(previous) {
    return new Promise(resolve => {
      const dialog = doc.createElement('dialog'); dialog.className = 'rocket-dialog backup-choice-dialog';
      dialog.dataset.backupChoice = 'true';
      const heading = doc.createElement('h2'); heading.id = 'backup-update-choice-title';
      heading.textContent = text('backups.updateChoice', { name: previous.name });
      dialog.setAttribute('aria-labelledby', heading.id);
      const choices = doc.createElement('div'); choices.className = 'dialog-actions';
      const finish = value => { dialog.close(); dialog.remove(); capture.focus(); resolve(value); };
      for (const [key, value] of [['backups.cancel', null], ['backups.createNew', 'new'], ['backups.update', 'update']]) {
        const control = doc.createElement('button'); control.type = 'button'; control.className = 'button button-secondary';
        control.dataset.backupChoice = value || 'cancel'; control.textContent = text(key);
        control.addEventListener('click', () => finish(value)); choices.append(control);
      }
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.append(heading, choices); doc.body.append(dialog); dialog.showModal();
    });
  }
  async function create() {
    const runtime = getRuntime?.();
    if (!runtime?.healthy || runtime.recovery) { show(text('backups.unavailable'), true); return; }
    await refresh();
    const previous = records.find(record => record.id === getSourceBackupId());
    const choice = previous ? await chooseUpdate(previous) : 'new';
    if (!choice) return;
    const defaultName = runtime.configuration?.siteName || previous?.name || 'Joomla site';
    const name = choice === 'update' ? previous.name : win.prompt(text('backups.namePrompt'), defaultName);
    if (name === null) return;
    fallback = null; fallbackButton.hidden = true;
    show(text('backups.preparing'));
    const archive = await createArchive();
    const outcome = await backups.saveArchive(archive, { id: choice === 'update' ? previous.id : undefined,
      expectedRevision: choice === 'update' ? previous.revision : undefined,
      name, configuration: archive.metadata?.playground?.configuration ?? runtime.configuration,
      sourceSiteKey: runtime.configuration?.storageKey });
    await refresh();
    if (outcome.saved) {
      await onBackupSaved(outcome.record);
      show(text(choice === 'update' ? 'backups.updated' : 'backups.created', { time: outcome.record.updatedAt }));
    } else {
      fallback = { archive: outcome.archive, name: name || defaultName };
      fallbackButton.hidden = false;
      fallbackButton.textContent = text('backups.fallbackDownload');
      const key = outcome.reason === 'space' ? 'backups.noSpace' : outcome.reason === 'conflict' ? 'backups.changed' : 'backups.writeFailed';
      show(`${text(key)}${outcome.previous ? ` ${text('backups.previousKept')}` : ''}`, true);
    }
  }
  listen(capture, 'click', () => { void action(create); });
  listen(fallbackButton, 'click', () => { void action(async () => { if (fallback) await download(fallback.archive, fallback.name); }); });
  listen(collapse, 'click', () => { expanded(false); doc.getElementById('backup-button')?.focus(); });
  listen(clear, 'click', () => { void action(async () => {
    if (!win.confirm(text('backups.clearConfirm'))) return;
    try {
      await backups.clear();
      // Re-read at deletion time: the active live site may have changed since render.
      for (const entry of await getManagedEntries()) if (entry.removable && !entry.active && !entry.manualOnly) await removeManagedEntry(entry);
      fallback = null; fallbackButton.hidden = true;
      show(text('backups.cleared'));
    } finally { await refresh(); }
  }); });
  return {
    async open() { expanded(true); await refresh(); element.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); },
    close() { expanded(false); }, refresh, updateState,
    get busy() { return busy; },
    get isOpen() { return !element.hidden; },
    dispose() { disposed = true; for (const remove of listeners) remove(); fallback = null; },
  };
}
