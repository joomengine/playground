/** Read only the identity of a saved administrator record, never form values. */
export function administratorCaptureTargets(frame, baseURL) {
  if (!frame || !baseURL) return [];
  let url, document;
  try { url = new URL(frame.contentWindow.location.href); document = frame.contentDocument; }
  catch { return []; }
  const base = new URL(baseURL);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/administrator/`)) return [];
  const value = name => url.searchParams.get(name) || document?.querySelector(`input[name="${name}"]`)?.value || '';
  const component = value('option');
  if (!/^com_[a-z0-9_]+$/.test(component)) return [];
  if (component === 'com_config' && /^com_[a-z0-9_]+$/.test(value('component'))) {
    return [{ kind: 'component', component: value('component') }];
  }
  const view = value('view') || value('task').split('.')[0];
  if (!/^[a-z][a-z0-9_]*$/i.test(view)) return [];
  const selected = [...(document?.querySelectorAll('input[name="cid[]"]:checked') || [])].map(input => input.value);
  const identity = url.searchParams.get('id') || document?.querySelector('input[name="jform[id]"], input[name="id"]')?.value;
  const ids = [...new Set((selected.length ? selected : [identity]).filter(id => /^[1-9]\d*$/.test(String(id))))];
  const kind = component === 'com_plugins' ? 'plugin' : component === 'com_modules' ? 'module' : 'record';
  return ids.map(id => ({ kind, component, view, id: Number(id) }));
}
