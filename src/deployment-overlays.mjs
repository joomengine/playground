const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const COLUMN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMPONENT = /^com_[a-z0-9_]+$/;
const NAME = /^[a-z][a-z0-9_]*$/;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (RESERVED.has(key)) throw new TypeError(`${label} contains an invalid field.`);
  return value;
}
function identifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
function data(value, depth = 0, references = true) {
  if (depth > 30) throw new TypeError('Component configuration is nested too deeply.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && !value.includes('\0')) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => data(item, depth + 1, references));
  record(value, 'Component configuration');
  if (references && Object.hasOwn(value, '$ref')) {
    if (Object.keys(value).some(key => !['$ref', 'field'].includes(key))) throw new TypeError('A record reference accepts only its key and field.');
    return { $ref: identifier(value.$ref, KEY, 'Referenced configuration key'),
      field: identifier(value.field ?? 'id', /^(?:id|guid)$/, 'Referenced identity field') };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, data(item, depth + 1, references)]));
}

/** Validate portable instructions, leaving component availability and native rules to Joomla. */
export function normalizeDeploymentOverlays(value = []) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value.trim() || '[]'); }
    catch { throw new TypeError('Component configuration JSON is invalid.'); }
  }
  if (!Array.isArray(value)) throw new TypeError('Component configuration must be a list.');
  const keys = new Set();
  return value.map((entry, index) => {
    record(entry, `Configuration ${index + 1}`);
    const allowed = ['key', 'kind', 'component', 'view', 'guid', 'match', 'fields', 'source', 'dependsOn', 'element', 'folder', 'clientId', 'schema'];
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) throw new TypeError(`Component configuration contains unsupported property ${key}.`);
    const key = identifier(entry.key, KEY, 'Configuration key');
    if (keys.has(key)) throw new TypeError(`Duplicate configuration key: ${key}.`);
    keys.add(key);
    const kind = identifier(entry.kind, /^(?:record|component|plugin|module)$/, 'Configuration kind');
    const result = { key, kind };
    if (kind === 'record' || kind === 'component') result.component = identifier(entry.component, COMPONENT, 'Component');
    else if (entry.component !== undefined) throw new TypeError('Plugins and modules use an extension name rather than a component.');
    if (kind === 'record') result.view = identifier(entry.view, NAME, 'Administrator view');
    else if (entry.view !== undefined) throw new TypeError('Only administrator records have a view.');
    if (entry.guid !== undefined) result.guid = identifier(entry.guid, GUID, 'Record GUID').toLowerCase();
    if (kind === 'plugin' || kind === 'module') result.element = identifier(entry.element, kind === 'module' ? /^mod_[a-z0-9_]+$/ : NAME, 'Extension name');
    else if (entry.element !== undefined) throw new TypeError('Only plugins and modules have an extension name.');
    if (kind === 'plugin') result.folder = identifier(entry.folder, NAME, 'Plugin group');
    else if (entry.folder !== undefined) throw new TypeError('Only plugins have a plugin group.');
    if (kind === 'module') {
      if (![0, 1].includes(entry.clientId ?? 0)) throw new TypeError('Choose site or administrator for the module.');
      result.clientId = entry.clientId ?? 0;
    } else if (entry.clientId !== undefined) throw new TypeError('Only modules have a site or administrator location.');
    if (entry.match !== undefined) {
      record(entry.match, 'Record match');
      result.match = Object.fromEntries(Object.entries(entry.match).map(([name, item]) => {
        identifier(name, COLUMN, 'Record match field');
        if (item === null || typeof item === 'object') throw new TypeError('Record match values must be text, numbers or true/false.');
        return [name, data(item)];
      }));
    }
    record(entry.fields ?? {}, 'Record values');
    for (const name of Object.keys(entry.fields ?? {})) {
      identifier(name, COLUMN, 'Record field');
      if (['id', 'guid', 'asset_id', 'checked_out', 'checked_out_time'].includes(name)) throw new TypeError(`Use the record identity instead of supplying ${name} as a field.`);
    }
    result.fields = data(entry.fields ?? {});
    if (entry.source !== undefined) {
      record(entry.source, 'Remote source');
      if (Object.keys(entry.source).some(name => !['repository', 'refresh'].includes(name))) throw new TypeError('Remote source accepts a repository and refresh choice.');
      if (entry.source.refresh !== undefined && typeof entry.source.refresh !== 'boolean') throw new TypeError('Remote refresh must be true or false.');
      result.source = {};
      if (entry.source.repository !== undefined) {
        if (typeof entry.source.repository !== 'string') record(entry.source.repository, 'Remote repository');
        result.source.repository = data(entry.source.repository);
      }
      if (entry.source.refresh !== undefined) result.source.refresh = entry.source.refresh;
    }
    if (entry.dependsOn !== undefined) {
      if (!Array.isArray(entry.dependsOn)) throw new TypeError('Configuration dependencies must be a list.');
      result.dependsOn = [...new Set(entry.dependsOn.map(item => identifier(item, KEY, 'Configuration dependency')))];
    }
    if (entry.schema !== undefined) {
      record(entry.schema, 'Configuration form schema');
      // Native form metadata is presentation only, never execution authority.
      result.schema = data(entry.schema, 0, false);
    }
    return result;
  });
}

/** Stable structural identity for comparisons without leaking values in diagnostics. */
export function sameDeploymentValue(left, right) {
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(left ?? null)) === JSON.stringify(stable(right ?? null));
}
