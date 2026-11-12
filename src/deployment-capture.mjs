/** Read only the identity of a saved administrator record, never form values. */
export function administratorCaptureTargets(frame, baseURL) {
  if (!frame || !baseURL) return [];
  let url, document;
  try { url = new URL(frame.contentWindow.location.href); document = frame.contentDocument; }
  catch { return []; }
  const base = new URL(baseURL);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/administrator/`)) return [];
  let action;
  try {
    action = new URL(document?.querySelector('form#adminForm, form[name="adminForm"]')?.getAttribute('action') || url.href, url);
    if (action.origin !== base.origin || !action.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/administrator/`)) action = null;
  } catch { action = null; }
  const value = name => url.searchParams.get(name) || document?.querySelector(`input[name="${name}"]`)?.value || action?.searchParams.get(name) || '';
  const component = value('option');
  if (!/^com_[a-z0-9_]+$/.test(component)) return [];
  if (component === 'com_config' && /^com_[a-z0-9_]+$/.test(value('component'))) {
    return [{ kind: 'component', component: value('component') }];
  }
  const kind = component === 'com_plugins' ? 'plugin' : component === 'com_modules' ? 'module' : 'record';
  const view = value('view') || value('task').split('.')[0];
  if (kind === 'record' && !/^[a-z][a-z0-9_]*$/i.test(view)) return [];
  const selected = [...(document?.querySelectorAll('input[name="cid[]"]:checked') || [])].map(input => input.value);
  const identity = kind === 'plugin'
    ? value('extension_id') || document?.querySelector('input[name="jform[extension_id]"]')?.value || value('id')
    : value('id') || document?.querySelector('input[name="jform[id]"]')?.value;
  const ids = [...new Set((selected.length ? selected : [identity]).filter(id => /^[1-9]\d*$/.test(String(id))))];
  return ids.map(id => kind === 'record' ? { kind, component, view, id: Number(id) } : { kind, id: Number(id) });
}
