import { createCodeLayout } from '../code/layout.mjs';
import { createIcon, decorateAction, observeIcons } from '../icons.mjs';
import { syncThemeDocument } from '../theme.mjs';
import { applyTranslations } from '../i18n.mjs';
import { ownedClientURL } from '../isolation.mjs';
import { captureDatabaseView, restoreDatabaseView, hasDatabaseDraft } from './view-state.mjs';

let styles;
function loadStyles(doc) {
  return styles ??= new Promise((resolve, reject) => {
    const link = doc.createElement('link'); link.rel = 'stylesheet';
    link.href = new URL('../code/styles.css', import.meta.url).href;
    link.onload = resolve;
    link.onerror = () => { link.remove(); styles = undefined; reject(new Error('Database panel styles could not load.')); };
    doc.head.append(link);
  });
}
const labelKeys = Object.fromEntries(['title', 'actions', 'hide', 'move', 'resize', 'detachedNotice', 'detach', 'redock', 'maximize', 'restore'].map(key => [`code.${key}`, `database.${key}`]));

/** A view of the active site's database. All PHP and database ownership stays in the owner tab. */
export async function createDatabaseHost({ runtime, host, preview, refreshSite, onError = () => {}, onState = () => {}, t, storage }) {
  const doc = host.ownerDocument, win = doc.defaultView;
  await loadStyles(doc);
  let disposed = false, opening, databaseURL, auxiliary, transferring = false, transferSnapshot;
  const frames = new Set(), pendingLoads = new Set();
  const report = error => { if (!disposed) onError(error); };
  const editor = doc.createElement('div');
  editor.style.cssText = 'display:flex;flex:1;min-height:0';
  const embedded = makeFrame(doc); editor.append(embedded);
  function theme() { return doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
  function syncFrame(frame) { frame.contentWindow?.postMessage({ type: 'joomengine-database-theme', theme: theme() }, win.location.origin); }
  function makeFrame(target) {
    const frame = target.createElement('iframe'); frame.title = t('database.title');
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;flex:1;min-height:0';
    frame.addEventListener('load', () => syncFrame(frame)); frames.add(frame); return frame;
  }
  function currentView(frame = auxiliary?.frame || embedded) {
    const url = frame.contentWindow?.location.href;
    if (!databaseURL || !url || url === 'about:blank') return null;
    const expected = new URL(databaseURL), actual = new URL(url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw new Error('The database view navigated outside its tool route. Reopen Database from the playground.');
    return captureDatabaseView(frame.contentDocument, actual.href);
  }
  function dirty() {
    try { return hasDatabaseDraft((auxiliary?.frame || embedded).contentDocument); }
    catch { return false; }
  }
  function loadFrame(frame, url, snapshot) {
    return new Promise((resolve, reject) => {
      const cancel = () => done(new Error('The database view was closed.'));
      const timer = win.setTimeout(() => done(new Error('The database page did not load. The site remains open; retry Database.')), 60000);
      function done(error) {
        win.clearTimeout(timer); pendingLoads.delete(cancel);
        frame.removeEventListener('load', loaded);
        error ? reject(error) : resolve();
      }
      function loaded() {
        try {
          const actual = frame.contentWindow.location.href;
          if (actual === 'about:blank') return;
          if (snapshot) restoreDatabaseView(frame.contentDocument, snapshot);
          syncFrame(frame); done();
        } catch (error) { done(error); }
      }
      pendingLoads.add(cancel); frame.addEventListener('load', loaded);
      frame.src = url;
    });
  }
  const layout = createCodeLayout({ host, preview, editor, storage, storageKey: 'joomengine-database-layout',
    titleText: 'DB', labelKeys, t, onError: report, onState,
    detachView: detachDatabase,
  });
  const icon = createIcon('database', doc); icon.style.marginInlineEnd = '5px';
  layout.panel.querySelector('.jec-panel-title').prepend(icon);
  function action(target, key, callback, iconId) {
    const button = target.createElement('button'); button.type = 'button'; button.textContent = t(key);
    button.setAttribute('data-i18n', key); button.setAttribute('data-i18n-title', key); button.setAttribute('data-i18n-aria-label', key);
    if (iconId) decorateAction(button, iconId);
    button.addEventListener('click', () => { void Promise.resolve().then(callback).catch(report); });
    return button;
  }
  layout.toolbar.append(action(doc, 'code.refresh', refreshSite, 'refresh-site'));
  const stopIcons = observeIcons(layout.panel);
  function applyTheme() {
    for (const frame of frames) syncFrame(frame);
    if (auxiliary && !auxiliary.window.closed) syncThemeDocument(auxiliary.window.document, { resolved: theme(), theme: theme() });
  }
  function applyLanguage() {
    for (const frame of frames) frame.title = t('database.title');
    if (auxiliary && !auxiliary.window.closed) applyTranslations(auxiliary.window.document);
  }
  doc.addEventListener('joomengine:themechange', applyTheme);
  doc.addEventListener('rocket:languagechange', applyLanguage);
  function ownerBeforeUnload(event) { if (dirty()) { event.preventDefault(); event.returnValue = ''; } }
  win.addEventListener('beforeunload', ownerBeforeUnload);
  function subscribe() {
    return runtime.workspace.subscribe(event => {
      if (event.type === 'workspace-closed' && !transferring) void dispose();
    });
  }
  let unsubscribe = subscribe();

  async function open() {
    if (disposed) throw new Error('This database viewer is closed.');
    layout.show();
    return opening ??= (async () => {
      const { url } = await runtime.openDatabase();
      if (disposed) return;
      if (databaseURL === url) return;
      databaseURL = url;
      await loadFrame(embedded, url);
    })().catch(error => { databaseURL = undefined; throw error; }).finally(() => { opening = undefined; });
  }
  function detachDatabase({ onClose }) {
    if (!databaseURL || opening) throw new Error(t('database.loading'));
    const snapshot = currentView();
    const url = ownedClientURL(new URL('./window.html', import.meta.url), { ...runtime.isolation, baseURL: new URL('../../', import.meta.url).href });
    const child = win.open(url, '', 'popup,width=1100,height=760');
    if (!child) throw new Error(t('code.popupBlocked'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = win.setTimeout(() => fail(new Error('The detached database window could not load.')), 20000);
      function cleanup() { win.clearTimeout(timer); win.removeEventListener('message', ready); }
      function fail(error) { if (settled) return; settled = true; cleanup(); child.close(); reject(error); }
      async function ready(event) {
        if (event.source !== child || event.origin !== win.location.origin || event.data?.type !== 'joomengine-database-window-ready') return;
        cleanup();
        try {
          if (disposed) throw new Error('The database viewer was closed.');
          const target = child.document, frame = makeFrame(target);
          const mount = target.querySelector('#database-window-content'), toolbar = target.querySelector('#database-window-tools');
          if (!mount || !toolbar) throw new Error('The detached database window is incompatible.');
          mount.append(frame); syncThemeDocument(target, { resolved: theme(), theme: theme() });
          let last = snapshot, returning, closedResolve;
          const closed = new Promise(resolveClosed => { closedResolve = resolveClosed; });
          const companion = { window: child, frame, close: () => child.close(), async redock() {
            if (returning) return returning;
            returning = (async () => {
              try { if (!child.closed) last = currentView(frame) || last; } catch (error) { report(error); }
              if (!disposed && last) {
                const current = embedded.contentWindow?.location.href;
                if (current === last.url) restoreDatabaseView(embedded.contentDocument, last);
                else await loadFrame(embedded, last.url, last);
              }
              win.clearInterval(poll); frames.delete(frame); auxiliary = undefined;
              if (!child.closed) child.close();
              closedResolve(); onClose();
            })();
            return returning;
          }, closed, focus: () => child.focus() };
          toolbar.append(action(target, 'code.detached.return', () => companion.redock(), 'redock'), action(target, 'code.refresh', refreshSite, 'refresh-site'));
          child.addEventListener('pagehide', () => { try { last = currentView(frame) || last; } catch {} });
          const poll = win.setInterval(() => { if (child.closed) void companion.redock().catch(report); }, 250);
          auxiliary = companion;
          await loadFrame(frame, snapshot?.url || databaseURL, snapshot);
          if (disposed || child.closed) throw new Error('The detached database window was closed.');
          settled = true; resolve(companion);
        } catch (error) { fail(error); }
      }
      win.addEventListener('message', ready);
    });
  }
  function beginRuntimeTransfer() { transferSnapshot = currentView(); transferring = true; }
  async function rebindRuntime(nextRuntime) {
    unsubscribe(); runtime = nextRuntime; unsubscribe = subscribe();
    const { url } = await runtime.openDatabase();
    const old = databaseURL; databaseURL = url;
    const snapshot = transferSnapshot;
    if (snapshot) snapshot.url = snapshot.url.replace(old, url);
    await loadFrame(embedded, snapshot?.url || url, snapshot);
    if (auxiliary && !auxiliary.window.closed) await loadFrame(auxiliary.frame, snapshot?.url || url, snapshot);
    transferSnapshot = undefined; transferring = false;
  }
  function cancelRuntimeTransfer() { transferSnapshot = undefined; transferring = false; }
  async function dispose() {
    if (disposed) return; disposed = true;
    unsubscribe(); stopIcons();
    for (const cancel of [...pendingLoads]) cancel();
    doc.removeEventListener('joomengine:themechange', applyTheme);
    doc.removeEventListener('rocket:languagechange', applyLanguage);
    win.removeEventListener('beforeunload', ownerBeforeUnload);
    auxiliary?.close(); layout.dispose(); frames.clear();
    onState({ visible: false, detached: false, closed: true });
  }
  return { open, hide: () => layout.hide(), dispose, beginRuntimeTransfer, rebindRuntime, cancelRuntimeTransfer,
    get closed() { return disposed; }, get visible() { return layout.state.visible; }, get detached() { return layout.state.detached; },
    async toggle() { if (layout.state.visible) await layout.hide(); else await open(); },
    async beforeClose() { return !dirty() || win.confirm(t('database.closePrompt')); },
  };
}
