import { createCodeLayout } from './layout.mjs';
import { createRefreshController } from './refresh.mjs';

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
  let workbench, opening, disposed = false, aiPanel, aiLoading, disposal;
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
      status.textContent = state.saving ? t('code.saving') : state.savedChanges ? t('code.savedChanges') : '';
      onState({ ...state, visible: layout?.state.visible ?? true });
    },
  });
  function trackRequest(target, operation, args) {
      if (disposed) return Promise.reject(new Error('This JoomEngine Code workspace is closed.'));
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
    request(operation, args) { return trackRequest(runtime.workspace, operation, args); },
    withBatch(callback) {
      return refresh.trackSave(runtime.workspace.withBatch(batch => callback({
        ...batch, request: (operation, args) => trackRequest(batch, operation, args),
      })), { changed: false });
    },
  };
  const layout = createCodeLayout({
    host, preview, editor, storage, t,
    onError: report,
    onLayout: () => workbench?.layout?.(),
    onState: state => onState({ ...refresh.state, visible: state.visible }),
    detachView: options => {
      if (!workbench) throw new Error('Wait for JoomEngine Code to finish opening before detaching.');
      return workbench.detach(options);
    },
  });
  const button = (key, action) => {
    const element = document.createElement('button'); element.type = 'button';
    element.textContent = t(key); element.title = t(key);
    element.addEventListener('click', () => { void Promise.resolve().then(action).catch(report); });
    return element;
  };
  const save = button('code.saveAll', () => workbench?.saveAll());
  const reload = button('code.refresh', () => refresh.refresh());
  const debug = button('code.debugRefresh', () => workbench?.startDebugging({ url: getPreviewURL(), method: 'GET', refresh: true }));
  const aiContainer = document.createElement('section');
  aiContainer.className = 'jec-ai-panel'; aiContainer.hidden = true;
  const ai = button('code.ai', async () => {
    if (!workbench) throw new Error('Wait for JoomEngine Code to finish opening.');
    if (aiPanel) { aiContainer.hidden = !aiContainer.hidden; ai.setAttribute('aria-expanded', String(!aiContainer.hidden)); return; }
    if (aiLoading) return aiLoading;
    aiLoading = (async () => {
      const [{ createAiReview, createAiWorkspaceTools }, { createIsolatedAiPanel }] = await Promise.all([
        import('./ai-review.mjs'), import('./ai-panel.mjs'),
      ]);
      if (disposed) return;
      const review = createAiReview({ workspace, isDirty: (path, recursive) => workbench.isDirty(path, recursive) });
      const tools = createAiWorkspaceTools({ workspace, review });
      aiPanel = createIsolatedAiPanel({ container: aiContainer, tools, review,
        getContext: ({ signal }) => tools.context({ ...workbench.getContext(), signal }),
      });
      editor.append(aiContainer);
      aiContainer.hidden = false;
      ai.setAttribute('aria-expanded', 'true');
    })().finally(() => { aiLoading = undefined; });
    return aiLoading;
  });
  ai.setAttribute('aria-expanded', 'false');
  const autoLabel = document.createElement('label');
  const auto = document.createElement('input'); auto.type = 'checkbox';
  auto.addEventListener('change', () => refresh.setAutomatic(auto.checked));
  autoLabel.append(auto, document.createTextNode(t('code.autoRefresh')));
  layout.toolbar.append(save, reload, debug, ai, autoLabel, status);
  layout.show();

  function open() {
    if (disposed) return Promise.reject(new Error('This JoomEngine Code workspace is closed.'));
    layout.show();
    if (opening) return opening;
    opening = (async () => {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('JoomEngine Code did not load. Close and retry the editor.')), 60_000);
        frame.onload = () => { clearTimeout(timeout); resolve(); };
        frame.onerror = () => { clearTimeout(timeout); reject(new Error('JoomEngine Code assets could not load. Retry opening the editor.')); };
        frame.src = new URL('../../assets/code/editor.html', import.meta.url).href;
        editor.replaceChildren(frame);
      });
      if (disposed) return;
      if (!frame.contentWindow.JoomEngineCode?.mount) throw new Error('JoomEngine Code assets are missing or incompatible. Rebuild the Playground distribution.');
      workbench = await frame.contentWindow.JoomEngineCode.mount({
        workspace, siteId: runtime.workspace.id, storageId: runtime.workspace.storageId,
        onError: report,
        debuggerBackend: { ...runtime.debugger, async start(config) {
          await runtime.debugger.start(config);
          if (config.refresh) await refresh.refresh();
        } },
        getDebugConfiguration: () => ({ url: getPreviewURL(), method: 'GET', refresh: false }),
      });
      if (disposed) { workbench?.dispose?.(); return; }
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
  const unsubscribe = runtime.workspace.subscribe(event => {
    if (event.type === 'workspace-closed') dispose();
    if (event.type === 'debug-state' && !disposed) refresh.setPaused(event.state === 'paused');
  });
  const beforeUnload = event => {
    if (workbench?.hasDirty?.()) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  function dispose() {
    if (disposed) return disposal;
    disposed = true;
    unsubscribe();
    window.removeEventListener('beforeunload', beforeUnload);
    refresh.dispose();
    aiPanel?.dispose();
    // Return auxiliary editor parts before disposing their owner realm.
    disposal = (async () => {
      try { await layout.redock(); await workbench?.dispose?.(); }
      finally { layout.dispose(); }
    })();
    disposal.catch(report);
    onState({ closed: true, visible: false });
    return disposal;
  }
  return {
    open, refresh: () => refresh.refresh(),
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
