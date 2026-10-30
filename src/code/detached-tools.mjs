import { fitToolbarActions } from './toolbar-layout.mjs';
import { createIcon, decorateAction, decorateIcons } from '../icons.mjs';

export const DETACHED_MESSAGES = Object.freeze({
  'code.detached.workspace': 'JoomEngine Code detached workspace',
  'code.detached.actions': 'Detached workspace actions',
  'code.detached.owner': 'Keep the owner tab open.',
  'code.detached.files': 'Files',
  'code.detached.saveAll': 'Save all',
  'code.detached.return': 'Return to owner tab',
  'code.detached.refreshFiles': 'Refresh files',
  'code.detached.searchText': 'Search project text',
  'code.detached.search': 'Search',
  'code.detached.searching': 'Searching…',
  'code.detached.matchCount': '{count} matches',
  'code.detached.limit': 'limit reached',
  'code.detached.skipped': '{count} files skipped',
});

/** Companion navigation around a supported native auxiliary editor part.
 * The native part keeps ownership of every text model, undo stack and tab.
 */
export function mountDetachedTools({ part, provider, openFile, saveAll, redock, onError, onDetachedTools, shellStylesheet, t }) {
  const message = (key, values = {}) => {
    let value = t?.(key, values);
    if (!value || value === key) value = DETACHED_MESSAGES[key];
    return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  };
  const editor = part.getContainer();
  const document = editor.ownerDocument;
  const window = document.defaultView;
  const root = document.createElement('section');
  root.className = 'jec-detached-root';
  root.setAttribute('aria-label', message('code.detached.workspace'));
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:13px system-ui;color:var(--jec-text,#ddd);z-index:5';
  // Keep companion browser scrolling out of native workbench wheel/keybinding
  // handlers without cancelling the browser's default action or save shortcuts.
  const allowCompanionScroll = event => event.stopPropagation();
  const allowCompanionKeyboardScroll = event => {
    if (!event.ctrlKey && !event.metaKey && !event.altKey
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.stopPropagation();
  };
  root.addEventListener('wheel', allowCompanionScroll, { passive: true });
  root.addEventListener('keydown', allowCompanionKeyboardScroll);
  const sharedStyle = document.createElement('link'); sharedStyle.rel = 'stylesheet';
  if (shellStylesheet) { sharedStyle.href = shellStylesheet; document.head.append(sharedStyle); }
  const style = document.createElement('style');
  style.textContent = `
:root[data-theme=light]{--jec-bg:#f8fafc;--jec-surface:#edf1f7;--jec-text:#202b3e;--jec-border:#b4bfce;--jec-control-bg:#fff;--jec-focus:#146d9e}
:root[data-theme=dark]{--jec-bg:#10152b;--jec-surface:#141a36;--jec-text:#e6e9f3;--jec-border:#3b4464;--jec-control-bg:#1c243c;--jec-focus:#edc56b}
:root[data-theme]{--ink:var(--jec-text);--muted:var(--jec-text);--panel:var(--jec-bg);--paper:var(--jec-bg);--control:var(--jec-control-bg);--control-border:var(--jec-border);--line:var(--jec-border);--focus:var(--jec-focus)}
:root[data-theme=light]{--danger:#9b2727;--error-bg:#fff0ed}:root[data-theme=dark]{--danger:#ffd0c3;--error-bg:#ff836012}
.jec-detached-root button,.jec-detached-nav input{font:inherit;color:inherit;background:var(--jec-control-bg,#303030);border:1px solid var(--jec-border,#666);border-radius:4px;padding:5px 7px;min-height:32px}
.jec-detached-root button{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer}
.jec-detached-root .je-icon-only .je-action-label{display:none}
.jec-detached-root button svg{width:20px;height:20px;flex:none}.jec-detached-root [hidden]{display:none!important}
.jec-detached-header{position:absolute;top:0;left:0;right:0;box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:'identity actions windows';align-items:center;gap:6px;padding:6px;background:var(--jec-surface,#202020);pointer-events:auto;border-bottom:1px solid var(--jec-border,#555)}
.jec-detached-identity{grid-area:identity;justify-self:start;padding:0 4px}.jec-detached-window-controls{grid-area:windows;flex:none}
.jec-detached-toolbar{grid-area:actions;display:flex;align-items:center;gap:4px;min-width:0}
.jec-detached-toolbar>*{flex:none}.jec-detached-toolbar>[role=status]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.jec-detached-toolbar .jec-action-icon .je-action-label,.jec-detached-root[data-actions=icons] .jec-detached-toolbar .je-action-label,.jec-detached-root[data-actions=strip] .jec-detached-toolbar .je-action-label{display:none}
@media(max-width:600px){.jec-detached-window-controls .je-action-label{display:none}}
.jec-detached-root[data-actions=strip] .jec-detached-header{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'identity windows' 'actions actions'}
.jec-detached-root[data-actions=strip] .jec-detached-toolbar{overflow:auto;overscroll-behavior-inline:contain;scrollbar-width:thin;padding-bottom:2px}
.jec-detached-nav{position:absolute;bottom:24px;left:0;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;padding:8px;background:var(--jec-bg,#252526);pointer-events:auto;border-right:1px solid var(--jec-border,#555);scrollbar-width:thin}
.jec-detached-nav button{text-align:left}.jec-detached-root button:focus-visible,.jec-detached-nav:focus-visible,.jec-detached-nav summary:focus-visible{outline:2px solid var(--jec-focus,#75beff);outline-offset:1px}
.jec-detached-nav summary{cursor:pointer;padding:5px}.jec-detached-nav ul{list-style:none;padding-left:12px;margin:0}.jec-detached-nav li>button{display:block;border:0;background:transparent;overflow-wrap:anywhere;white-space:normal;width:100%}.jec-detached-nav input{box-sizing:border-box;width:100%}
@media(forced-colors:active){.jec-detached-header,.jec-detached-nav,.jec-detached-root button,.jec-detached-nav input{border-color:ButtonText}.jec-detached-root button:focus-visible{outline-color:Highlight}}
`;
  const header = document.createElement('header'); header.className = 'jec-detached-header';
  const identity = document.createElement('strong'); identity.className = 'jec-detached-identity'; identity.textContent = 'Code';
  const toolbar = document.createElement('div');
  toolbar.className = 'jec-detached-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', message('code.detached.actions'));
  const windowControls = document.createElement('div'); windowControls.className = 'jec-detached-window-controls';
  header.append(identity, toolbar, windowControls);
  const sidebar = document.createElement('aside');
  sidebar.className = 'jec-detached-nav';
  sidebar.tabIndex = 0;
  sidebar.setAttribute('aria-label', message('code.detached.files'));
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = message('code.detached.owner');
  const navigation = document.createElement('div');
  const container = document.createElement('div');
  container.style.cssText = 'pointer-events:auto';
  let hidden = false, disposed = false, sequence = 0, cursor = null, activePath = '/', lastArea = 'editor';
  const fileFocus = () => { lastArea = 'files'; };
  const editorFocus = () => { lastArea = 'editor'; };
  navigation.addEventListener('focusin', fileFocus);
  editor.addEventListener('focusin', editorFocus);
  const getActivePath = () => {
    const resource = part.activeGroup?.activeEditor?.resource;
    return lastArea === 'editor' && resource?.scheme === 'jec' && resource.authority === provider.siteId ? resource.path : activePath;
  };
  const invoke = callback => () => Promise.resolve().then(callback).catch(error => { status.textContent = error.message; onError(error); });
  function button(parent, label, callback, icon) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.title = label; button.setAttribute('aria-label', label);
    if (icon) decorateAction(button, icon);
    button.addEventListener('click', invoke(callback)); parent.append(button); return button;
  }
  const originalLayout = part.layout.bind(part);
  let lastLayout = [window.innerWidth, window.innerHeight - 22, 0, 0];
  part.layout = (width, height, top, left) => {
    lastLayout = [width, height, top, left];
    fitToolbarActions(root, toolbar);
    const toolbarHeight = Math.ceil(header.getBoundingClientRect().height);
    const offset = hidden ? 0 : Math.min(260, Math.max(width < 500 ? 140 : 180, Math.floor(width * .32)));
    sidebar.style.width = `${offset}px`; sidebar.style.top = `${toolbarHeight}px`;
    editor.style.position = 'absolute'; editor.style.left = `${offset}px`; editor.style.top = `${toolbarHeight}px`;
    originalLayout(Math.max(80, width - offset), Math.max(80, height - toolbarHeight), top + toolbarHeight, left + offset);
  };
  const filesButton = button(toolbar, message('code.detached.files'), () => {
    hidden = !hidden; sidebar.hidden = hidden; filesButton.setAttribute('aria-expanded', String(!hidden)); part.layout(...lastLayout);
  }, 'files');
  filesButton.setAttribute('aria-expanded', 'true');
  button(toolbar, message('code.detached.saveAll'), saveAll, 'save-all');
  button(windowControls, message('code.detached.return'), redock, 'redock');
  sidebar.append(status);
  button(sidebar, message('code.detached.refreshFiles'), () => loadTree(), 'refresh-files');
  const form = document.createElement('form');
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = message('code.detached.searchText'); input.setAttribute('aria-label', message('code.detached.searchText'));
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = message('code.detached.search'); decorateAction(submit, 'search-project');
  form.append(input, submit); sidebar.append(form, navigation, container);
  form.addEventListener('submit', event => { event.preventDefault(); void invoke(search)(); });
  const isCurrent = token => !disposed && token === sequence;
  async function cancelSearch() { if (cursor) { const current = cursor; cursor = null; await provider.request('cancelSearch', { cursor: current }); } }
  async function list(path, target, token) {
    const entries = await provider.request('list', { path });
    if (!isCurrent(token)) return;
    const ul = document.createElement('ul');
    for (const entry of entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))) {
      const li = document.createElement('li');
      if (entry.type === 'directory') {
        const details = document.createElement('details'), summary = document.createElement('summary'), children = document.createElement('div');
        summary.textContent = entry.name; details.append(summary, children);
        let loaded = false;
        details.addEventListener('toggle', () => {
          if (!details.open) return;
          activePath = entry.path; lastArea = 'files';
          if (!loaded) { loaded = true; void list(entry.path, children, token).catch(error => { loaded = false; status.textContent = error.message; onError(error); }); }
        });
        summary.addEventListener('focus', () => { activePath = entry.path; });
        li.append(details);
      } else button(li, entry.name, () => { activePath = entry.path; return openFile(entry.path); });
      ul.append(li);
    }
    target.replaceChildren(ul);
  }
  async function loadTree() {
    const token = ++sequence; await cancelSearch(); navigation.replaceChildren(); status.textContent = message('code.detached.owner');
    await list('/', navigation, token);
  }
  async function search() {
    const token = ++sequence; await cancelSearch(); navigation.replaceChildren();
    if (!input.value) return loadTree();
    status.textContent = message('code.detached.searching');
    let count = 0, skipped = 0, truncated = false;
    const list = document.createElement('ul'); navigation.append(list);
    do {
      const page = await provider.request('search', cursor ? { cursor, maxResults: 100 } : { kind: 'text', query: input.value, path: '/', maxResults: 100 });
      if (!isCurrent(token)) { if (page.cursor) await provider.request('cancelSearch', { cursor: page.cursor }); return; }
      cursor = page.cursor; skipped = page.skipped; truncated ||= page.truncated;
      for (const item of page.results) {
        const li = document.createElement('li');
        button(li, `${item.path}:${item.lineNumber} — ${item.preview}`, () => { activePath = item.path; return openFile(item.path, item.lineNumber, item.column); }); list.append(li); count++;
      }
      status.textContent = `${message('code.detached.matchCount', { count })}${cursor ? '…' : ''}`;
    } while (cursor && count < 1000 && isCurrent(token));
    if (cursor) { truncated = true; await cancelSearch(); }
    status.textContent = `${message('code.detached.matchCount', { count })}${truncated ? ` (${message('code.detached.limit')})` : ''}${skipped ? `; ${message('code.detached.skipped', { count: skipped })}` : ''}.`;
  }
  // The native auxiliary container disables touch panning for its editor.
  // Mount the companion beside it so its scrollable areas retain browser touch
  // gestures, while the native pane keeps its own event/gesture handling.
  root.append(style, header, sidebar); document.body.append(root); part.layout(...lastLayout);
  let external;
  try { external = onDetachedTools?.({ window, toolbar, container, getActivePath, openFile }); }
  catch (error) { onError(error); }
  decorateIcons(toolbar);
  const toolbarObserver = new window.ResizeObserver(() => { if (!disposed) part.layout(...lastLayout); });
  toolbarObserver.observe(header);
  const labelsObserver = new window.MutationObserver(() => { if (!disposed) part.layout(...lastLayout); });
  labelsObserver.observe(toolbar, { childList: true, subtree: true, characterData: true });
  part.layout(...lastLayout);
  void loadTree().catch(onError);
  return { getActivePath, dispose() {
    disposed = true; sequence++; void cancelSearch().catch(() => {}); external?.dispose?.();
    editor.removeEventListener('focusin', editorFocus); navigation.removeEventListener('focusin', fileFocus);
    toolbarObserver.disconnect(); labelsObserver.disconnect(); sharedStyle.remove();
    root.removeEventListener('wheel', allowCompanionScroll);
    root.removeEventListener('keydown', allowCompanionKeyboardScroll);
    part.layout = originalLayout; root.remove();
  } };
}
