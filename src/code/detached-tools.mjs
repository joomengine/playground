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
export function mountDetachedTools({ part, provider, openFile, saveAll, redock, onError, onDetachedTools, t }) {
  const message = (key, values = {}) => {
    let value = t?.(key, values);
    if (!value || value === key) value = DETACHED_MESSAGES[key];
    return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  };
  const editor = part.getContainer();
  const document = editor.ownerDocument;
  const window = document.defaultView;
  const root = document.createElement('section');
  root.setAttribute('aria-label', message('code.detached.workspace'));
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:13px system-ui;color:#ddd;z-index:5';
  const style = document.createElement('style');
  style.textContent = '.jec-detached-toolbar button,.jec-detached-nav button,.jec-detached-nav input{font:inherit;color:inherit;background:#303030;border:1px solid #666;border-radius:3px;padding:5px 7px}.jec-detached-nav button{text-align:left}.jec-detached-nav button:focus-visible,.jec-detached-toolbar button:focus-visible,.jec-detached-nav summary:focus-visible{outline:2px solid #75beff;outline-offset:1px}.jec-detached-nav summary{cursor:pointer;padding:5px}.jec-detached-nav ul{list-style:none;padding-left:12px;margin:0}.jec-detached-nav li>button{border:0;background:transparent;overflow-wrap:anywhere;width:100%}.jec-detached-nav input{box-sizing:border-box;width:100%}';
  const toolbar = document.createElement('div');
  toolbar.className = 'jec-detached-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', message('code.detached.actions'));
  toolbar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:62px;box-sizing:border-box;display:flex;align-items:center;gap:5px;padding:6px;overflow:auto;background:#202020;pointer-events:auto;border-bottom:1px solid #555';
  const sidebar = document.createElement('aside');
  sidebar.className = 'jec-detached-nav';
  sidebar.style.cssText = 'position:absolute;top:62px;bottom:24px;left:0;width:260px;box-sizing:border-box;overflow:auto;padding:8px;background:#252526;pointer-events:auto;border-right:1px solid #555';
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
  function button(parent, label, callback) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', invoke(callback)); parent.append(button); return button;
  }
  const originalLayout = part.layout.bind(part);
  let lastLayout = [window.innerWidth, window.innerHeight - 22, 0, 0];
  part.layout = (width, height, top, left) => {
    lastLayout = [width, height, top, left];
    const offset = hidden ? 0 : Math.min(260, Math.max(180, Math.floor(width * .32)));
    sidebar.style.width = `${offset}px`;
    editor.style.position = 'absolute'; editor.style.left = `${offset}px`; editor.style.top = '62px';
    originalLayout(Math.max(100, width - offset), Math.max(100, height - 62), top + 62, left + offset);
  };
  button(toolbar, message('code.detached.files'), () => { hidden = !hidden; sidebar.hidden = hidden; part.layout(...lastLayout); });
  button(toolbar, message('code.detached.saveAll'), saveAll);
  button(toolbar, message('code.detached.return'), redock);
  const heading = document.createElement('strong'); heading.textContent = 'JoomEngine Code'; sidebar.append(heading, status);
  button(sidebar, message('code.detached.refreshFiles'), () => loadTree());
  const form = document.createElement('form');
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = message('code.detached.searchText'); input.setAttribute('aria-label', message('code.detached.searchText'));
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = message('code.detached.search');
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
  root.append(style, toolbar, sidebar); editor.parentElement.append(root); part.layout(...lastLayout);
  let external;
  try { external = onDetachedTools?.({ window, toolbar, container, getActivePath, openFile }); }
  catch (error) { onError(error); }
  void loadTree().catch(onError);
  return { getActivePath, dispose() {
    disposed = true; sequence++; void cancelSearch().catch(() => {}); external?.dispose?.();
    editor.removeEventListener('focusin', editorFocus); navigation.removeEventListener('focusin', fileFocus);
    part.layout = originalLayout; root.remove();
  } };
}
