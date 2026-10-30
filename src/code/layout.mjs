import english from '../locales/en.mjs';
import { createIcon } from '../icons.mjs';

const MODES = new Set(['left', 'right', 'bottom', 'full', 'floating']);
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/** Validate preference storage and keep floating controls inside the viewport. */
export function normalizeCodeLayout(input = {}, viewport = {}) {
  if (!input || typeof input !== 'object') input = {};
  const width = Math.max(1, finite(viewport.width, 1280));
  const height = Math.max(1, finite(viewport.height, 800));
  const gap = Math.min(12, width / 8, height / 8);
  const floatingWidth = clamp(finite(input.width, 800), Math.min(320, width - gap * 2), width - gap * 2);
  const floatingHeight = clamp(finite(input.height, 580), Math.min(240, height - gap * 2), height - gap * 2);
  return {
    mode: MODES.has(input.mode) ? input.mode : 'right',
    dock: clamp(finite(input.dock, 50), Math.max(20, Math.min(40, 320 / width * 100)), Math.min(80, Math.max(60, 100 - 320 / width * 100))),
    bottom: clamp(finite(input.bottom, 420), Math.min(240, height - gap * 2), height - gap * 2),
    width: floatingWidth,
    height: floatingHeight,
    x: clamp(finite(input.x, width - floatingWidth - gap), gap, width - floatingWidth - gap),
    y: clamp(finite(input.y, 80), gap, height - floatingHeight - gap),
  };
}

/**
 * Changes CSS placement without moving the preview iframe or recreating editors.
 * Native detached editor parts are delegated to the workbench; DOM adoption across
 * windows is deliberately not used because it breaks VS Code's window services.
 */
export function createCodeLayout({
  host, preview, editor,
  onLayout = () => {},
  onError = () => {},
  onState = () => {},
  storage,
  storageKey = 'joomengine-code-layout',
  detachView,
  t = key => english[key] ?? key,
} = {}) {
  if (!host?.ownerDocument || !preview || !editor) throw new TypeError('A host, site preview and editor element are required.');
  if (preview.parentNode !== host) throw new Error('The preview must already belong to the layout host; moving a running iframe is not safe.');
  if (editor.parentNode) throw new Error('Mount the editor in its layout before initializing the workbench.');
  const doc = host.ownerDocument, win = doc.defaultView;
  const viewport = () => ({ width: win.innerWidth, height: win.innerHeight });
  let saved;
  try { saved = JSON.parse(storage?.getItem(storageKey) || 'null'); } catch { /* Storage is optional for temporary use. */ }
  let preferences = normalizeCodeLayout(saved, viewport());
  let visible = false, restoreMode = preferences.mode === 'full' ? 'right' : preferences.mode;
  let disposed = false, detached = null, detaching = false, detachOperation, hiding = false, hidingOperation, resizing = null, frame = 0;
  const listeners = new Set([onState]);
  const cleanups = [];
  const create = (tag, className, text) => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (key, text) => {
    const label = t(key);
    const element = create('button', 'jec-control', text);
    element.type = 'button'; element.title = label; element.setAttribute('aria-label', label);
    element.setAttribute('data-i18n-title', key); element.setAttribute('data-i18n-aria-label', key);
    return element;
  };
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };
  const report = error => { try { onError(error); } catch { /* Failure reporting must not replace site UI. */ } };
  const panel = create('section', 'jec-panel');
  panel.setAttribute('aria-label', t('code.title')); panel.setAttribute('data-i18n-aria-label', 'code.title');
  const titlebar = create('div', 'jec-titlebar');
  const title = button('code.move', t('code.title'));
  title.classList.add('jec-panel-title');
  title.textContent = 'Code';
  const windowControls = create('div', 'jec-window-controls');
  const modeLabel = create('label', 'jec-mode-label');
  const label = create('span', 'jec-visually-hidden', t('code.layout'));
  label.setAttribute('data-i18n', 'code.layout');
  const modeSelect = create('select', 'jec-mode');
  for (const [value, text] of [['left', 'code.dockLeft'], ['right', 'code.dockRight'], ['bottom', 'code.dockBottom'], ['floating', 'code.floating'], ['full', 'code.full']]) {
    const option = create('option', '', t(text)); option.setAttribute('data-i18n', text); option.value = value; modeSelect.append(option);
  }
  modeLabel.append(label, modeSelect);
  const detachButton = button('code.detach', '↗');
  detachButton.hidden = typeof detachView !== 'function';
  const maximize = button('code.maximize', '□');
  const hideButton = button('code.hide');
  hideButton.append(createIcon('hide-editor', doc));
  windowControls.append(modeLabel, detachButton, maximize, hideButton);
  const toolbar = create('div', 'jec-toolbar');
  toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', t('code.actions')); toolbar.setAttribute('data-i18n-aria-label', 'code.actions');
  const notice = create('p', 'jec-detached-notice', t('code.detachedNotice'));
  notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('data-i18n', 'code.detachedNotice');
  editor.classList.add('jec-editor-mount');
  const resize = button('code.resize');
  resize.append(createIcon('resize-editor', doc));
  resize.classList.add('jec-resize-corner');
  titlebar.append(title, toolbar, windowControls);
  panel.append(titlebar, notice, editor, resize);
  const divider = create('div', 'jec-divider');
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', t('code.resize')); divider.setAttribute('data-i18n-aria-label', 'code.resize');
  divider.setAttribute('aria-valuemin', '20'); divider.setAttribute('aria-valuemax', '80');
  host.classList.add('jec-layout-host'); preview.classList.add('jec-preview');
  host.append(divider, panel);

  const state = () => Object.freeze({ ...preferences, visible, detached: Boolean(detached), detaching });
  function emit() {
    for (const listener of listeners) { try { listener(state()); } catch { /* Keep workspace operations independent of labels. */ } }
  }
  function remember() {
    try { storage?.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Keep current layout when preference storage is unavailable. */ }
  }
  function scheduleLayout() {
    if (frame || disposed) return;
    frame = win.requestAnimationFrame(() => { frame = 0; if (!disposed) onLayout(); });
  }
  function render({ persist = true } = {}) {
    preferences = normalizeCodeLayout(preferences, viewport());
    const mode = preferences.mode;
    // Collapse side-by-side on narrow screens without overwriting the chosen mode.
    const effectiveMode = win.innerWidth < 720 && ['left', 'right'].includes(mode) ? 'bottom' : mode;
    // The owner realm remains mounted, but a confirmed auxiliary window owns
    // the visible editor. Release all embedded grid space until it returns.
    const embedded = visible && !detached;
    host.dataset.jecMode = embedded ? effectiveMode : 'hidden';
    host.dataset.jecDetached = String(Boolean(detached));
    panel.hidden = !embedded;
    divider.hidden = !embedded || !['left', 'right', 'bottom'].includes(effectiveMode);
    resize.hidden = mode !== 'floating';
    title.disabled = mode !== 'floating';
    host.style.setProperty('--jec-dock', `${preferences.dock}%`);
    host.style.setProperty('--jec-bottom', `${preferences.bottom}px`);
    for (const key of ['x', 'y', 'width', 'height']) panel.style.setProperty(`--jec-${key}`, `${preferences[key]}px`);
    modeSelect.value = mode;
    maximize.replaceChildren(createIcon(mode === 'full' ? 'restore-workspace' : 'full-workspace', doc));
    const maximizeKey = mode === 'full' ? 'code.restore' : 'code.maximize';
    maximize.title = t(maximizeKey);
    maximize.setAttribute('data-i18n-title', maximizeKey); maximize.setAttribute('data-i18n-aria-label', maximizeKey);
    maximize.setAttribute('aria-label', maximize.title);
    notice.hidden = !detached;
    detachButton.disabled = detaching;
    detachButton.replaceChildren(createIcon(detached ? 'redock' : 'detach', doc));
    const detachKey = detached ? 'code.redock' : 'code.detach';
    detachButton.title = t(detachKey);
    detachButton.setAttribute('data-i18n-title', detachKey); detachButton.setAttribute('data-i18n-aria-label', detachKey);
    detachButton.setAttribute('aria-label', detachButton.title);
    divider.setAttribute('aria-orientation', effectiveMode === 'bottom' ? 'horizontal' : 'vertical');
    divider.setAttribute('aria-valuemin', String(effectiveMode === 'bottom' ? Math.round(Math.min(240, win.innerHeight - 24) / win.innerHeight * 100) : 20));
    divider.setAttribute('aria-valuemax', String(effectiveMode === 'bottom' ? Math.round((win.innerHeight - 24) / win.innerHeight * 100) : 80));
    divider.setAttribute('aria-valuenow', String(effectiveMode === 'bottom' ? Math.round(preferences.bottom / win.innerHeight * 100) : Math.round(preferences.dock)));
    if (persist) remember();
    emit(); scheduleLayout();
  }
  function assertActive() { if (disposed) throw new Error(t('code.layoutClosed')); }
  function setMode(mode) {
    assertActive();
    if (!MODES.has(mode)) throw new TypeError('Unknown JoomEngine Code layout.');
    if (mode === 'full' && preferences.mode !== 'full') restoreMode = preferences.mode;
    preferences.mode = mode; visible = true; render();
  }
  function restore() { setMode(restoreMode); }
  async function redock() {
    assertActive();
    if (!detached) return;
    const current = detached;
    await current.redock();
    if (detached === current) detached = null;
    render();
  }
  function detach() {
    assertActive();
    if (detached) { detached.focus?.(); return Promise.resolve(detached); }
    if (detachOperation) return detachOperation;
    if (typeof detachView !== 'function') return Promise.reject(new Error(t('code.detachUnavailable')));
    detaching = true; render({ persist: false });
    // Invoke in the actual click's activation context; awaiting first can cause
    // a browser to reject the popup and must never hide the embedded workspace.
    let pending;
    try { pending = detachView({ onClose() { detached = null; if (!disposed) { if (!hiding) visible = true; render(); } } }); }
    catch (error) { detaching = false; render({ persist: false }); return Promise.reject(error); }
    detachOperation = Promise.resolve(pending).then(async result => {
      if (!result || typeof result.redock !== 'function') throw new Error(t('code.popupBlocked'));
      if (disposed) { await result.redock(); return; }
      detached = result;
      result.closed?.then(() => {
        if (detached === result) detached = null;
        if (!disposed) { if (!hiding) visible = true; render(); }
      }, report);
      return result;
    }).finally(() => { detachOperation = undefined; detaching = false; if (!disposed) render(); });
    return detachOperation;
  }
  function hide() {
    assertActive();
    if (hidingOperation) return hidingOperation;
    const wasVisible = visible;
    hiding = true; visible = false; render();
    hidingOperation = (async () => {
      // A toggle during popup creation takes ownership after that creation
      // settles, preventing a late detached window from surviving a hide.
      try { await detachOperation; } catch { /* Detach failure already leaves the owner available. */ }
      try { await redock(); }
      catch (error) { visible = wasVisible; throw error; }
    })().finally(() => { hiding = false; hidingOperation = undefined; if (!disposed) render(); });
    return hidingOperation;
  }
  function pointerStart(event, kind) {
    if (event.button !== 0 || disposed) return;
    if (kind !== 'divider' && preferences.mode !== 'floating') return;
    event.preventDefault();
    const element = event.currentTarget;
    resizing = { kind, x: event.clientX, y: event.clientY, start: { ...preferences }, element, pointerId: event.pointerId };
    element.setPointerCapture(event.pointerId);
    host.classList.add('jec-interacting');
  }
  function pointerMove(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    const dx = event.clientX - resizing.x, dy = event.clientY - resizing.y, start = resizing.start;
    if (resizing.kind === 'move') { preferences.x = start.x + dx; preferences.y = start.y + dy; }
    else if (resizing.kind === 'size') { preferences.width = start.width + dx; preferences.height = start.height + dy; }
    else if (host.dataset.jecMode === 'bottom') preferences.bottom = start.bottom - dy;
    else preferences.dock = start.dock + (host.dataset.jecMode === 'left' ? dx : -dx) / Math.max(host.clientWidth, 1) * 100;
    render({ persist: false });
  }
  function pointerEnd(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    if (resizing.element.hasPointerCapture(event.pointerId)) resizing.element.releasePointerCapture(event.pointerId);
    resizing = null; host.classList.remove('jec-interacting'); remember();
  }
  function keyboardResize(event, kind) {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const movement = directions[event.key];
    if (!movement) return;
    event.preventDefault();
    const [dx, dy] = movement, step = event.shiftKey ? 50 : 20;
    if (kind === 'move') { preferences.x += dx * step; preferences.y += dy * step; }
    else if (kind === 'size') { preferences.width += dx * step; preferences.height += dy * step; }
    else if (host.dataset.jecMode === 'bottom') preferences.bottom -= dy * step;
    else preferences.dock += dx * (host.dataset.jecMode === 'left' ? 1 : -1) * (event.shiftKey ? 10 : 2);
    render();
  }
  listen(modeSelect, 'change', () => setMode(modeSelect.value));
  listen(maximize, 'click', () => preferences.mode === 'full' ? restore() : setMode('full'));
  listen(hideButton, 'click', () => { void hide().catch(report); });
  listen(detachButton, 'click', () => { void (detached ? redock() : detach()).catch(report); });
  for (const [element, kind] of [[divider, 'divider'], [title, 'move'], [resize, 'size']]) {
    listen(element, 'pointerdown', event => pointerStart(event, kind));
    listen(element, 'pointermove', pointerMove);
    listen(element, 'pointerup', pointerEnd);
    listen(element, 'pointercancel', pointerEnd);
    listen(element, 'lostpointercapture', pointerEnd);
    listen(element, 'keydown', event => keyboardResize(event, kind));
  }
  listen(win, 'resize', () => render({ persist: false }));
  listen(doc, 'rocket:languagechange', () => render({ persist: false }));
  const fitActions = () => {
    if (!panel.clientWidth) return;
    // Size against the editor container, including a narrow dock inside a wide
    // browser. Only the action area may move down; window controls stay put.
    // Measure actual translated controls, including labels/checkboxes, against
    // the grid space left by protected window controls. Reset the candidate
    // before measuring so expanding can always leave a collapsed strip.
    panel.dataset.actions = 'labels';
    if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
      panel.dataset.actions = 'icons';
      if (toolbar.scrollWidth > toolbar.clientWidth + 1) panel.dataset.actions = 'strip';
    }
    scheduleLayout();
  };
  const observer = new win.ResizeObserver(fitActions);
  observer.observe(panel);
  observer.observe(editor);
  const toolbarObserver = new win.MutationObserver(fitActions);
  toolbarObserver.observe(toolbar, { childList: true, subtree: true, characterData: true });
  render({ persist: false });
  return {
    panel, toolbar, editor,
    get state() { return state(); },
    show() { assertActive(); visible = true; render(); if (detached) detached.focus?.(); },
    hide, setMode, maximize() { setMode('full'); }, restore, detach, redock,
    subscribe(listener) { assertActive(); listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) win.cancelAnimationFrame(frame);
      observer.disconnect(); toolbarObserver.disconnect();
      for (const cleanup of cleanups) cleanup();
      listeners.clear();
      if (detached) void detached.redock().catch(report);
      panel.remove(); divider.remove();
      host.classList.remove('jec-layout-host', 'jec-interacting');
      preview.classList.remove('jec-preview');
      delete host.dataset.jecMode; delete host.dataset.jecDetached;
      host.style.removeProperty('--jec-dock'); host.style.removeProperty('--jec-bottom');
    },
  };
}
