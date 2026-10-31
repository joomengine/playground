import { createCodeLayout } from './layout.mjs';
import { createRefreshController } from './refresh.mjs';
import { mountFileActions } from './file-actions.mjs';
import { decorateAction, decorateIcons, createIcon } from '../icons.mjs';
import { syncThemeDocument } from '../theme.mjs';
import { ownedClientURL } from '../isolation.mjs';

const mutations = new Set(['write', 'batch', 'mkdir', 'copy', 'rename', 'delete', 'recover']);
let stylesheet;

function loadStyles() {
  return stylesheet ??= new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./styles.css', import.meta.url).href;
    link.onload = resolve;
    link.onerror = () => { link.remove(); stylesheet = undefined; reject(new Error('JoomEngine Code styles could not load. Retry opening the editor.')); };
    document.head.append(link);
  });
}

/** One view realm per active site; the Playground retains all runtime ownership. */
export async function createCodeHost({ runtime, host, preview, refreshSite, getPreviewURL = () => runtime.url,
  onError = () => {}, onState = () => {}, t = key => key, storage }) {
  await loadStyles();
  if (!runtime.healthy) throw new Error('Open a healthy Joomla site before opening JoomEngine Code.');
  let workbench, opening, disposed = false, aiPanel, aiLoading, disposal, fileActions, cancelFrameLoad;
  let aiServices, transferring = false, aiGeneration = 0, clearAiSession;
  const aiSessionOwner = crypto.randomUUID();
  const workspaceListeners = new Set();
  const auxiliaryTools = new Set();
  const auxiliaryDocuments = new Set();
  let currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const ownedAsset = value => runtime.isolation?.ownerId
    ? ownedClientURL(value, { ...runtime.isolation, baseURL: new URL('../../', import.meta.url).href }) : value.href;
  const shellStylesheet = ownedAsset(new URL('./styles.css', import.meta.url));
  const applyTheme = event => {
    currentTheme = event?.detail?.resolved || event?.detail?.theme || document.documentElement.dataset.theme || 'dark';
    for (const doc of auxiliaryDocuments) syncThemeDocument(doc, { resolved: currentTheme, theme: currentTheme });
    for (const panel of aiPanels) panel.setTheme?.(currentTheme);
    if (frame.contentDocument) syncThemeDocument(frame.contentDocument, { resolved: currentTheme, theme: currentTheme });
    void workbench?.setTheme?.(currentTheme)?.catch(report);
  };
  document.addEventListener('joomengine:themechange', applyTheme);
  const aiPanels = new Set();
  const editor = document.createElement('div');
  const frame = document.createElement('iframe');
  frame.title = 'JoomEngine Code';
  frame.className = 'jec-workbench-frame';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  const loading = document.createElement('p'); loading.textContent = t('code.loading');
  editor.append(loading);
  const report = error => { if (!disposed) onError(error); };
  const refresh = createRefreshController({
    refresh: refreshSite, onError: report, t,
    onState(state) {
      status.textContent = state.saving ? t(state.paused ? 'code.savesQueued' : 'code.saving') : state.savedChanges ? t('code.savedChanges') : '';
      onState({ ...state, visible: layout?.state.visible ?? true });
    },
  });
  function trackRequest(target, operation, args) {
      if (disposed) return Promise.reject(new Error('This JoomEngine Code workspace is closed.'));
      if (transferring) return Promise.reject(new Error(t('status.saving')));
      const pending = target.request(operation, args);
      if (!mutations.has(operation)) return pending;
      return refresh.trackSave(pending, { changed: result => result?.ok === true && Boolean(result.changes?.length) }).then(result => {
        if (result?.ok === false && result.changes?.length) refresh.markSaved({ automatic: false });
        if (result?.persistence?.error) report(new Error(`Files changed in the running site, but browser storage could not be saved: ${result.persistence.error}`));
        return result;
      });
  }
  const workspace = {
    ...runtime.workspace,
    get storageId() { return runtime.workspace.storageId; },
    subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
    request(operation, args) { return trackRequest(runtime.workspace, operation, args); },
    withBatch(callback) {
      if (transferring) return Promise.reject(new Error(t('status.saving')));
      return refresh.trackSave(runtime.workspace.withBatch(batch => callback({
        ...batch, request: (operation, args) => trackRequest(batch, operation, args),
      })), { changed: false });
    },
  };
  const layout = createCodeLayout({
    host, preview, editor, storage, t,
    onError: report,
    onLayout: () => workbench?.layout?.(),
    onState: state => onState({ ...refresh.state, visible: state.visible, detached: state.detached }),
    detachView: options => {
      if (!workbench) throw new Error('Wait for JoomEngine Code to finish opening before detaching.');
      return workbench.detach(options);
    },
  });
  const button = (key, action, doc = document, onFailure = report) => {
    const element = doc.createElement('button'); element.type = 'button';
    element.textContent = t(key); element.title = t(key); element.setAttribute('aria-label', t(key));
    element.setAttribute('data-i18n', key); element.setAttribute('data-i18n-title', key); element.setAttribute('data-i18n-aria-label', key);
    const icons = { 'code.saveAll': 'save-all', 'code.refresh': 'refresh-site', 'code.cacheClear': 'clear-cache',
      'code.debugRefresh': 'debug-refresh', 'code.debugArm': 'arm-php', 'code.ai': 'ai-assistant',
      'code.accounts': 'accounts', 'code.debugContinue': 'debug-continue', 'code.debugPause': 'debug-pause',
      'code.debugStepOver': 'debug-step-over', 'code.debugStepInto': 'debug-step-into',
      'code.debugStepOut': 'debug-step-out', 'code.debugStop': 'debug-stop', 'code.retry': 'retry' };
    if (icons[key]) decorateAction(element, icons[key], { iconOnly: key === 'code.ai' });
    element.addEventListener('click', () => { void Promise.resolve().then(action).catch(onFailure); });
    return element;
  };
  async function clearJoomlaCache() {
    if (runtime.debugger.state === 'paused') throw new Error(t('code.pausedRefresh'));
    await refresh.waitForSaves();
    await runtime.clearJoomlaCache();
  }
  async function armRequest(win = window) {
    const input = win.prompt(t('code.debugURL'), getPreviewURL());
    if (input === null) return;
    const method = win.prompt(t('code.debugMethod'), 'GET')?.trim().toUpperCase();
    if (!method) return;
    const url = new URL(input, runtime.baseUrl).href;
    await workbench.startDebugging({ url, method, refresh: false });
    status.textContent = t('code.debugArmed');
  }
  async function createAiPanel(container) {
    const generation = aiGeneration, owner = runtime.workspace;
    const [{ createAiReview, createAiWorkspaceTools }, { createIsolatedAiPanel, clearIsolatedAiSession }] = await Promise.all([
      import('./ai-review.mjs'), import('./ai-panel.mjs'),
    ]);
    if (disposed || generation !== aiGeneration || owner !== runtime.workspace) return;
    clearAiSession = clearIsolatedAiSession;
    if (!aiServices) {
      const current = () => {
        if (disposed || transferring || generation !== aiGeneration || owner !== runtime.workspace) {
          throw new DOMException(t('code.aiPanel.scopeChanged'), 'AbortError');
        }
      };
      // Reviews retain the runtime that produced their revisions. Every queued
      // reservation is checked again before it can write, including recovery.
      const boundWorkspace = { ...owner,
        request(operation, args) { current(); return trackRequest(owner, operation, args); },
        withBatch(callback) {
          current();
          return refresh.trackSave(owner.withBatch(batch => {
            current();
            return callback({ ...batch, request(operation, args) { current(); return trackRequest(batch, operation, args); } });
          }), { changed: false });
        },
      };
      const review = createAiReview({ workspace: boundWorkspace,
        isDirty: (path, recursive) => { current(); return workbench.isDirty(path, recursive); },
        onApplied: result => { current(); return workbench.reconcileApplied(result); } });
      aiServices = { review, workspace: boundWorkspace, current,
        sessionKey: `${owner.id}:${aiSessionOwner}:${generation}`, scope: { mode: 'current', paths: [], excluded: [] } };
    }
    const services = aiServices, { review } = services;
    // Each isolated view owns its scope. A second window must never broaden an
    // in-flight conversation's tool permissions by changing a shared mutable service.
    const tools = createAiWorkspaceTools({ workspace: services.workspace, review, scope: services.scope });
    let contextQueue = Promise.resolve();
    const isolated = createIsolatedAiPanel({ container, tools, review, t, sessionKey: services.sessionKey,
      locale: document.documentElement.lang, direction: document.documentElement.dir,
      getContext: ({ signal, scope }) => {
        services.current();
        const snapshot = workbench.getContext();
        const task = contextQueue.catch(() => {}).then(async () => {
          services.current();
          const context = await tools.context({ ...snapshot, scope, signal });
          services.current();
          services.scope = tools.getScope();
          return context;
        });
        contextQueue = task; return task;
      } });
    // Register before returning through an async boundary: disposal can run
    // before the requesting main or auxiliary view receives this value.
    const panel = Object.freeze({ element: isolated.element, showSettings: isolated.showSettings, setTheme: isolated.setTheme, dispose() {
      aiPanels.delete(panel); return isolated.dispose();
    } });
    aiPanels.add(panel);
    return panel;
  }
  const save = button('code.saveAll', () => workbench?.saveAll());
  const reload = button('code.refresh', () => refresh.refresh());
  const clearCache = button('code.cacheClear', async () => {
    clearCache.disabled = true;
    try {
      await clearJoomlaCache();
      status.textContent = t('code.cacheCleared');
    } finally { clearCache.disabled = false; }
  });
  const debug = button('code.debugRefresh', () => workbench?.startDebugging({ url: getPreviewURL(), method: 'GET', refresh: true }));
  const arm = button('code.debugArm', () => armRequest());
  const aiContainer = document.createElement('section');
  aiContainer.className = 'jec-ai-panel'; aiContainer.hidden = true;
  async function toggleAi() {
    if (!workbench) throw new Error('Wait for JoomEngine Code to finish opening.');
    if (aiPanel) { aiContainer.hidden = !aiContainer.hidden; ai.setAttribute('aria-expanded', String(!aiContainer.hidden)); return; }
    if (aiLoading) return aiLoading;
    const generation = aiGeneration;
    const loadingPanel = (async () => {
      const panel = await createAiPanel(aiContainer);
      if (disposed || generation !== aiGeneration || !panel) { await panel?.dispose(); return; }
      aiPanel = panel;
      editor.append(aiContainer);
      aiContainer.hidden = false;
      ai.setAttribute('aria-expanded', 'true');
    })().finally(() => { if (aiLoading === loadingPanel) aiLoading = undefined; });
    aiLoading = loadingPanel;
    return aiLoading;
  }
  const ai = button('code.ai', toggleAi);
  ai.setAttribute('aria-expanded', 'false');
  const accounts = button('code.accounts', async () => {
    if (!aiPanel) await toggleAi();
    if (!aiPanel) return;
    aiContainer.hidden = false; ai.setAttribute('aria-expanded', 'true'); aiPanel.showSettings();
  });
  const autoLabel = document.createElement('label');
  const auto = document.createElement('input'); auto.type = 'checkbox';
  auto.addEventListener('change', () => refresh.setAutomatic(auto.checked));
  autoLabel.title = t('code.autoRefresh');
  auto.setAttribute('aria-label', t('code.autoRefresh')); auto.setAttribute('data-i18n-aria-label', 'code.autoRefresh');
  const autoText = document.createElement('span'); autoText.className = 'je-action-label';
  autoText.textContent = t('code.autoRefresh'); autoText.setAttribute('data-i18n', 'code.autoRefresh');
  autoLabel.append(auto, createIcon('auto-refresh', document), autoText);
  layout.toolbar.append(save, reload, clearCache, debug, arm, ai, accounts, autoLabel, status);
  layout.show();

  function mountDetachedTools({ window: win, toolbar, container, getActivePath, openFile }) {
    const doc = win.document;
    auxiliaryDocuments.add(doc);
    syncThemeDocument(doc, { resolved: currentTheme, theme: currentTheme });
    const output = doc.createElement('span'); output.setAttribute('role', 'status');
    const notify = error => { output.textContent = error.message; report(error); };
    const add = (key, action) => { const control = button(key, action, doc, notify); toolbar.append(control); return control; };
    add('code.refresh', () => refresh.refresh());
    add('code.cacheClear', async () => { await clearJoomlaCache(); output.textContent = t('code.cacheCleared'); });
    add('code.debugRefresh', () => workbench.startDebugging({ url: getPreviewURL(), method: 'GET', refresh: true }));
    add('code.debugArm', () => armRequest(win));
    const debugControls = [
      ['code.debugContinue', 'continue', 'stopped'], ['code.debugPause', 'pause', 'running'],
      ['code.debugStepOver', 'stepOver', 'stopped'], ['code.debugStepInto', 'stepInto', 'stopped'],
      ['code.debugStepOut', 'stepOut', 'stopped'], ['code.debugStop', 'stop', 'active'],
    ].map(([key, command, state]) => ({ state, control: add(key, () => workbench.command(`workbench.action.debug.${command}`)) }));
    const debugStatus = workbench.subscribeDebugState(state => {
      for (const entry of debugControls) entry.control.disabled = entry.state === 'active' ? state === 'inactive' : state !== entry.state;
    });
    const aiMount = doc.createElement('section'); aiMount.hidden = true;
    aiMount.style.cssText = 'height:600px;max-height:75vh;width:100%;overflow:auto';
    container.append(aiMount);
    let panel, loadingPanel, closed = false;
    async function toggleDetachedAi() {
      if (panel) { aiMount.hidden = !aiMount.hidden; aiButton.setAttribute('aria-expanded', String(!aiMount.hidden)); return; }
      if (loadingPanel) return loadingPanel;
      const generation = aiGeneration;
      const pending = createAiPanel(aiMount).then(value => {
        if (closed || generation !== aiGeneration || !value) { return value?.dispose(); }
        panel = value; aiMount.hidden = false; aiButton.setAttribute('aria-expanded', 'true');
      }).finally(() => { if (loadingPanel === pending) loadingPanel = undefined; });
      loadingPanel = pending;
      return loadingPanel;
    }
    const aiButton = add('code.ai', toggleDetachedAi);

    aiButton.setAttribute('aria-expanded', 'false');
    add('code.accounts', async () => { if (!panel) await toggleDetachedAi(); if (panel) { aiMount.hidden = false; aiButton.setAttribute('aria-expanded', 'true'); panel.showSettings(); } });
    const files = mountFileActions({ toolbar, workspace, getActivePath, openFile,
      isDirty: (path, recursive) => workbench.isDirty(path, recursive), onError: notify, t });
    toolbar.append(output);
    decorateIcons(toolbar);
    const stopStatus = refresh.subscribe(state => {
      output.textContent = state.saving ? t(state.paused ? 'code.savesQueued' : 'code.saving') : state.savedChanges ? t('code.savedChanges') : '';
    });
    const tools = { resetAi() { panel?.dispose(); panel = undefined; loadingPanel = undefined; aiMount.hidden = true; aiButton.setAttribute('aria-expanded', 'false'); }, dispose() {
      if (closed) return; closed = true;
      auxiliaryDocuments.delete(doc);
      stopStatus(); debugStatus?.dispose(); panel?.dispose(); files.dispose(); aiMount.remove(); auxiliaryTools.delete(tools);
    } };
    auxiliaryTools.add(tools);
    return tools;
  }

  function open() {
    if (disposed) return Promise.reject(new Error('This JoomEngine Code workspace is closed.'));
    layout.show();
    if (opening) return opening;
    opening = (async () => {
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); frame.onload = frame.onerror = null; cancelFrameLoad = undefined; };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('JoomEngine Code did not load. Close and retry the editor.')); }, 60_000);
        cancelFrameLoad = () => { cleanup(); resolve(); };
        frame.onload = () => { cleanup(); resolve(); };
        frame.onerror = () => { cleanup(); reject(new Error('JoomEngine Code assets could not load. Retry opening the editor.')); };
        const editorURL = new URL('../../assets/code/editor.html', import.meta.url);
        frame.src = runtime.isolation?.ownerId
          ? ownedClientURL(editorURL, { ...runtime.isolation, baseURL: new URL('../../', import.meta.url).href })
          : editorURL.href;
        editor.replaceChildren(frame);
      });
      if (disposed) return;
      if (!frame.contentWindow.JoomEngineCode?.mount) throw new Error('JoomEngine Code assets are missing or incompatible. Rebuild the Playground distribution.');
      workbench = await frame.contentWindow.JoomEngineCode.mount({
        workspace, siteId: runtime.workspace.id, storageId: runtime.workspace.storageId,
        phpVersion: runtime.configuration.phpVersion,
        onError: report, t, theme: currentTheme, shellStylesheet, favicon: ownedAsset(new URL('../brand/favicon.svg?v=pearl-20261030', import.meta.url)),
        onDetachedTools: mountDetachedTools,
        debuggerBackend: {
          ...Object.fromEntries(['stop', 'setBreakpoints', 'continue', 'next', 'stepIn', 'stepOut', 'pause',
            'stackTrace', 'scopes', 'variables', 'evaluate', 'subscribe'].map(name => [name, (...args) => runtime.debugger[name](...args)])),
          async start(config) {
            if (transferring) throw new Error(t('status.saving'));
            await runtime.debugger.start(config);
            if (config.refresh) await refresh.refresh();
          },
        },
        getDebugConfiguration: () => ({ url: getPreviewURL(), method: 'GET', refresh: false }),
      });
      if (disposed) { await workbench?.dispose?.(); return; }
      fileActions = mountFileActions({ toolbar: layout.toolbar, workspace,
        getActivePath: () => workbench.getActivePath(), openFile: path => workbench.openFile(path),
        isDirty: (path, recursive) => workbench.isDirty(path, recursive), onError: report, t });
      decorateIcons(layout.toolbar);
      applyTheme();
      workbench.layout?.();
    })().catch(error => {
      opening = undefined;
      if (!disposed) {
        const message = document.createElement('p'); message.textContent = error.message;
        editor.replaceChildren(message, button('code.retry', open));
      }
      throw error;
    });
    return opening;
  }
  function resetAi() {
    const previous = aiServices;
    aiGeneration++; aiServices = undefined; aiPanel = undefined; aiLoading = undefined;
    previous?.review.clear();
    const closing = [...aiPanels].map(panel => panel.dispose());
    aiContainer.hidden = true; ai.setAttribute('aria-expanded', 'false');
    for (const tools of auxiliaryTools) tools.resetAi?.();
    // Clear before closing to cancel sibling work, then after checkpointed
    // disposal so an old view cannot leave a stale transcript in the vault.
    const clear = () => previous && clearAiSession?.(previous.sessionKey);
    return Promise.all([clear(), ...closing]).then(clear);
  }
  const receiveWorkspaceEvent = event => {
    // Saving a temporary site creates a verified replacement runtime. That
    // specific close must not destroy the native editor models we are moving.
    if (transferring && event.type === 'workspace-closed') return;
    if (event.type === 'workspace-invalidated') void resetAi().catch(report);
    for (const listener of workspaceListeners) { try { listener(event); } catch (error) { report(error); } }
    if (event.type === 'workspace-closed') void dispose();
    if (event.type === 'debug-state' && !disposed) refresh.setPaused(event.state === 'paused');
  };
  let unsubscribe = runtime.workspace.subscribe(receiveWorkspaceEvent);
  async function keepSite() {
    if (disposed || transferring) throw new Error(t('code.loading'));
    await opening;
    await refresh.waitForSaves();
    await workbench?.stopDebugging?.();
    transferring = true;
    try {
      const replacement = await runtime.keep();
      if (replacement === runtime) return runtime;
      unsubscribe(); runtime = replacement;
      unsubscribe = runtime.workspace.subscribe(receiveWorkspaceEvent);
      transferring = false;
      // Editor models remain continuous; old review snapshots/session state do
      // not follow the replacement runtime. The isolated credentials survive.
      await resetAi().catch(report);
      try { await workbench?.rebindStorage?.(runtime.workspace.storageId); }
      catch (error) { report(error); }
      for (const listener of workspaceListeners) { try { listener({ type: 'workspace-invalidated' }); } catch (error) { report(error); } }
      return runtime;
    } finally { transferring = false; }
  }
  const beforeUnload = event => {
    if (workbench?.hasDirty?.()) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  function dispose() {
    if (disposed) return disposal;
    disposed = true;
    cancelFrameLoad?.();
    unsubscribe();
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('joomengine:themechange', applyTheme);
    refresh.dispose(); workspaceListeners.clear();
    const aiCleanup = resetAi();
    fileActions?.dispose();
    for (const tools of auxiliaryTools) tools.dispose();
    // Return auxiliary editor parts before disposing their owner realm.
    disposal = (async () => {
      const failures = [];
      for (const cleanup of [() => aiCleanup, () => layout.redock(), () => workbench?.dispose?.(), () => layout.dispose()]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
    })();
    disposal.catch(error => { try { onError(error); } catch { /* Cleanup reporting cannot retain the editor realm. */ } });
    onState({ closed: true, visible: false });
    return disposal;
  }
  return {
    open, keepSite,
    async toggle() {
      if (disposed) throw new Error('This JoomEngine Code workspace is closed.');
      if (layout.state.visible) await layout.hide();
      else await open();
    },
    hide: () => layout.hide(),
    get visible() { return layout.state.visible; },
    get detached() { return layout.state.detached; },
    refresh: () => refresh.refresh(),
    get closed() { return disposed; },
    async beforeClose() {
      await refresh.waitForSaves();
      if (!workbench?.hasDirty?.()) return true;
      if (window.confirm(t('code.closePrompt'))) {
        await workbench.saveAll();
        return !workbench.hasDirty();
      }
      if (!window.confirm(t('code.discardPrompt'))) return false;
      await workbench.discardAll();
      return true;
    },
    dispose,
  };
}
