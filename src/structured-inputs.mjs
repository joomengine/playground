import { t as translate } from './i18n.mjs';
import { deploymentFormSchema, builtinConfigurationTargets, builtinMenuTypes } from './deployment-form-schema.mjs';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const labelOf = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object || {}, key);
const identifier = prefix => `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
const targetKey = target => JSON.stringify(['kind', 'component', 'view', 'folder', 'element', 'clientId'].map(name => target?.[name] ?? null));
const slug = text => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
let sequence = 0;

/** Preserve valid JSON values, including advanced fields the form does not know. */
export function structuredValue(input) {
  let count = 0;
  function visit(value, depth) {
    if (++count > 5000 || depth > 16) throw new TypeError('This configuration is too complex for the form editor.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (RESERVED.has(key)) throw new TypeError('This configuration contains an invalid property.');
        result[key] = visit(item, depth + 1);
      }
      return result;
    }
    throw new TypeError('Use valid JSON values.');
  }
  return visit(input, 0);
}

/** Schema fields and Advanced JSON edit the same data; unfinished JSON stays intact. */
export function createStructuredInputs({ textarea, container, advanced, errorElement,
  kind = 'parameters', onChange = () => {}, validate = value => value,
  schema = deploymentFormSchema(kind), context = {}, t = translate, onSchemaRequest,
}) {
  const document = textarea.ownerDocument;
  const fallback = ['commands', 'menus', 'overlays'].includes(kind) ? [] : {};
  let value;
  let jsonError;
  let fieldErrors = new Map();
  let formSchema = schema;
  let discovery = context;
  const recordSchemas = new Map();
  const pendingSchemas = new Set();
  const capturedKeys = new Map();
  const openCards = new Map();
  const message = (key, values) => key?.startsWith('deploymentForm.') ? t(key, values) : key;
  const label = (field, name) => message(field?.ui?.label) || field?.title || labelOf(name);

  function showError(error) {
    if (!errorElement) return;
    errorElement.textContent = error?.message || '';
    errorElement.hidden = !error;
  }
  function lock(error) {
    jsonError = error;
    textarea.setAttribute('aria-invalid', String(Boolean(error)));
    textarea.setCustomValidity(error ? t('deploymentForm.invalidJson') : '');
    for (const control of container.querySelectorAll('input,textarea,select,button')) control.disabled = Boolean(error) || control.dataset.schemaDisabled === 'true';
    showError(error ? new Error(t('deploymentForm.invalidJson')) : null);
  }
  function fieldError(control, text) {
    control.setCustomValidity(text || '');
    control.setAttribute('aria-invalid', String(Boolean(text)));
    if (text) fieldErrors.set(control, new TypeError(text)); else fieldErrors.delete(control);
    showError(fieldErrors.values().next().value);
  }
  function changed() {
    textarea.value = JSON.stringify(value, null, 2);
    lock(null);
    showError(fieldErrors.values().next().value);
    onChange();
  }
  function notice(key) {
    const p = document.createElement('p'); p.className = 'deployment-form-notice'; p.textContent = t(key); return p;
  }
  function button(text, action, ariaLabel = text) {
    const control = document.createElement('button'); control.type = 'button';
    control.className = 'button button-secondary'; control.textContent = text; control.setAttribute('aria-label', ariaLabel);
    control.addEventListener('click', () => { if (!jsonError) action(); });
    return control;
  }
  function helpText(schema, caption) {
    const text = message(schema?.ui?.help) || schema?.description;
    if (!text) return null;
    const details = document.createElement('details'); details.className = 'deployment-field-help';
    const summary = document.createElement('summary'); summary.textContent = '?'; summary.setAttribute('aria-label', caption);
    const body = document.createElement('p'); body.textContent = text; details.append(summary, body); return details;
  }
  function optionsFor(field, path, current) {
    if (Array.isArray(field.oneOf) && field.oneOf.every(option => own(option, 'const'))) {
      return field.oneOf.map(option => ({ value: option.const, title: message(option.ui?.label) || option.title || String(option.const) }));
    }
    if (field.enum) return field.enum.map(item => ({ value: item, title: String(item) }));
    if (kind === 'overlays' && field.type === 'boolean') return [{ value: true, title: t('deploymentForm.field.enabled') }, { value: false, title: t('deploymentForm.disabled') }];
    if (path.at(-1) === 'category' && kind === 'content') {
      return (value.categories || []).map(item => ({ value: item.key, title: item.title || item.key }));
    }
    if (path.at(-1) === 'templateStyle' && discovery.templates?.length) {
      return [{ value: 0, title: '—' }, ...discovery.templates.map(item => ({ value: Number(item.id), title: item.title || item.template }))];
    }
    return null;
  }
  function scalar(current, field, replace, path, caption, required = false) {
    const wrapper = document.createElement('div'); wrapper.className = 'structured-field deployment-field';
    const id = `deployment-field-${++sequence}`;
    const heading = document.createElement('div'); heading.className = 'deployment-field-label';
    const title = document.createElement('label'); title.htmlFor = id; title.textContent = caption;
    heading.append(title); const info = helpText(field, caption); if (info) heading.append(info);
    const choices = optionsFor(field, path, current);
    let type = Array.isArray(field.type) ? field.type.find(item => item !== 'null') : field.type;
    type ||= typeof current === 'number' ? 'number' : typeof current === 'boolean' ? 'boolean' : 'string';
    const isNumber = type === 'integer' || type === 'number';
    let control;
    if (choices) {
      control = document.createElement('select');
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = t('deploymentForm.choose'); control.append(empty);
      for (const choice of choices) { const option = document.createElement('option'); option.value = JSON.stringify(choice.value); option.textContent = choice.title; control.append(option); }
      const displayed = current ?? (kind === 'overlays' ? undefined : field.default);
      if (displayed !== undefined && !choices.some(choice => choice.value === displayed)) {
        const option = document.createElement('option'); option.value = JSON.stringify(displayed); option.textContent = String(displayed); control.append(option);
      }
      control.value = displayed === undefined ? '' : JSON.stringify(displayed);
    } else if (type === 'boolean') {
      control = document.createElement('input'); control.type = 'checkbox'; control.checked = current ?? field.default ?? false;
    } else {
      control = document.createElement(field.ui?.widget === 'textarea' || field.format === 'textarea' ? 'textarea' : 'input');
      if (control.tagName === 'TEXTAREA') control.rows = path.at(-1) === 'introtext' || path.at(-1) === 'fulltext' ? 5 : 3;
      else control.type = field.ui?.widget === 'password' || field.format === 'password' || /(?:password|token|secret|private_key)/i.test(path.at(-1)) ? 'password'
        : isNumber ? 'number' : field.format === 'email' ? 'email' : 'text';
      control.value = current ?? (kind === 'overlays' ? undefined : field.default) ?? '';
      if (isNumber) { control.step = type === 'integer' ? '1' : 'any'; if (field.minimum !== undefined) control.min = String(field.minimum); if (field.maximum !== undefined) control.max = String(field.maximum); }
      if (field.maxLength) control.maxLength = field.maxLength;
      if (field.pattern && control.tagName === 'INPUT') control.pattern = field.pattern;
      if (field.ui?.placeholder) control.placeholder = field.ui.placeholder;
      const name = path.at(-1);
      let suggestions;
      if (name === 'component') suggestions = [...new Set([...(discovery.menuTypes || []).map(item => item.component), ...(discovery.configurationTargets || []).map(item => item.component)].filter(Boolean))];
      if (name === 'view') suggestions = [...new Set((discovery.menuTypes || []).map(item => item.view))];
      if (name === 'language') suggestions = ['*', discovery.language || 'en-GB', ...(discovery.languageTags || [])];
      if (suggestions?.length) {
        const list = document.createElement('datalist'); list.id = `${id}-choices`;
        for (const item of new Set(suggestions)) { const option = document.createElement('option'); option.value = item; list.append(option); }
        control.setAttribute('list', list.id); wrapper.append(list);
      }
    }
    control.id = id; control.dataset.fieldPath = JSON.stringify(path); control.setAttribute('aria-label', caption); control.autocomplete = 'off';
    control.required = required && type !== 'boolean' && !(kind === 'content' && ['introtext', 'fulltext'].includes(path.at(-1)));
    if (field.readOnly) { control.disabled = true; control.dataset.schemaDisabled = 'true'; }
    control.addEventListener(choices || type === 'boolean' ? 'change' : 'input', () => {
      if (jsonError) return;
      let next;
      if (choices) next = control.value === '' ? undefined : JSON.parse(control.value);
      else if (type === 'boolean') next = control.checked;
      else if (isNumber) {
        if (control.validity?.badInput) { fieldError(control, t('deploymentForm.invalidValue')); return; }
        if (control.value === '') next = undefined;
        else if (!Number.isFinite(Number(control.value)) || (type === 'integer' && !Number.isInteger(Number(control.value)))) {
          fieldError(control, t('deploymentForm.invalidValue')); return;
        } else next = Number(control.value);
      } else next = control.value;
      fieldError(control); replace(next); changed();
      if (field.ui?.rerender || choices && path.at(-1) === 'type' || choices && path.at(-1) === 'access_repo') render();
    });
    if (control.tagName === 'INPUT' && control.type !== 'checkbox') control.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    wrapper.prepend(heading); wrapper.append(control);
    if (kind === 'content' && path.at(-1) === 'category' && !choices?.length) wrapper.append(notice('deploymentForm.noCategories'));
    return wrapper;
  }
  function schemaForValue(current) {
    if (typeof current === 'boolean') return { type: 'boolean' };
    if (typeof current === 'number') return { type: Number.isInteger(current) ? 'integer' : 'number' };
    if (typeof current === 'string') return { type: 'string', ...(current.includes('\n') ? { ui: { widget: 'textarea' } } : {}) };
    return null;
  }
  function linkedChoices(field = {}, path = []) {
    const link = field['x-joomla-link'];
    return (Array.isArray(value) ? value : []).filter((entry, index) => index !== path[1] && (!link || entry.kind === 'record' && entry.component === link.component && entry.view === link.entity))
      .map(entry => ({ const: entry.key, title: entry.fields?.title || entry.fields?.system_name || entry.key }));
  }
  function reference(current, replace, caption, field, path) {
    const wrapper = document.createElement('div'); wrapper.className = 'deployment-reference';
    const choices = linkedChoices(field, path);
    wrapper.append(scalar(current.$ref, { type: 'string', oneOf: choices }, next => { if (next) replace({ ...current, $ref: next }); }, [], `${caption} · ${t('deploymentForm.reference')}`));
    wrapper.append(scalar(current.field || 'id', { type: 'string', enum: ['id', 'guid'] }, next => { if (next) replace({ ...current, field: next }); }, [], t('deploymentForm.referenceField')));
    return wrapper;
  }
  function objectFields(current, descriptor, replace, path = []) {
    const object = record(current) ? current : {};
    const wrapper = document.createElement('div'); wrapper.className = 'deployment-form-grid';
    const extra = document.createElement('details'); extra.className = 'deployment-more-options';
    const summary = document.createElement('summary'); summary.textContent = t('deploymentForm.more'); extra.append(summary);
    const properties = { ...(descriptor.properties || {}) };
    // Known saved scalar settings remain editable even if an extension supplies no schema.
    for (const [name, existing] of Object.entries(object)) {
      if (descriptor.additionalProperties !== false && !own(properties, name) && schemaForValue(existing)) properties[name] = schemaForValue(existing);
    }
    let preserved = false;
    for (const [name, field] of Object.entries(properties)) {
      if (RESERVED.has(name) || field.ui?.hidden || name === 'key' || name === 'schema') continue;
      if (field.ui?.showWhen && !Object.entries(field.ui.showWhen).every(([key, expected]) => (object[key] ?? properties[key]?.default) === expected)) continue;
      const caption = label(field, name);
      const update = next => {
        const old = object[name];
        if (next === undefined) delete object[name]; else object[name] = next;
        if (name === 'title' && own(properties, 'alias') && (!object.alias || object.alias === slug(old))) {
          object.alias = slug(next) || object.key || '';
          const aliasPath = JSON.stringify([...path, 'alias']);
          const alias = [...wrapper.querySelectorAll('input')].find(control => control.dataset.fieldPath === aliasPath);
          if (alias) alias.value = object.alias;
        }
        if (kind === 'content' && name === 'title' && path[0] === 'categories') {
          for (const option of container.querySelectorAll('option')) if (option.value === JSON.stringify(object.key)) option.textContent = next || object.key;
        }
        replace(object);
      };
      let rendered;
      if (record(object[name]) && typeof object[name].$ref === 'string') rendered = reference(object[name], update, caption, field, path);
      else if (field.type === 'array') rendered = list(object[name] ?? [], field, update, [...path, name], caption);
      else if (field.type === 'object' || field.properties || record(object[name])) {
        if (!field.properties && !record(object[name])) continue;
        const section = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = caption;
        section.append(legend, objectFields(object[name], field, update, [...path, name])); rendered = section;
      } else if (object[name] === null || Array.isArray(object[name])) { preserved = true; continue; }
      else rendered = scalar(object[name], field, update, [...path, name], caption, descriptor.required?.includes(name));
      if (kind === 'overlays' && field['x-joomla-link'] && !record(object[name])) {
        const choices = linkedChoices(field, path);
        if (choices.length) rendered.append(scalar(undefined, { type: 'string', oneOf: choices, ui: { rerender: true } }, next => {
          if (next) update({ $ref: next, field: field['x-joomla-link'].key === 'guid' ? 'guid' : 'id' });
        }, [...path, name, '$ref'], `${caption} · ${t('deploymentForm.reference')}`));
      }
      (field.ui?.advanced ? extra : wrapper).append(rendered);
    }
    for (const name of Object.keys(object)) if (!own(properties, name) && name !== 'key' && name !== 'schema') preserved = true;
    if (extra.childElementCount > 1) wrapper.append(extra);
    if (preserved) wrapper.append(notice('deploymentForm.savedAdvanced'));
    if (!wrapper.childElementCount) wrapper.append(notice('deploymentForm.noSchema'));
    return wrapper;
  }
  function freshItem(path, descriptor) {
    const name = path.at(-1) || kind;
    if (name === 'menus') return { key: identifier('menu'), title: '', component: 'com_content', view: 'featured', menuType: 'mainmenu', language: '*', published: true };
    if (name === 'categories') return { key: identifier('category'), title: '', alias: '', language: discovery.language || 'en-GB' };
    if (name === 'articles') return { key: identifier('article'), title: '', alias: '', language: value.categories?.[0]?.language || discovery.language || 'en-GB', category: value.categories?.[0]?.key || '', introtext: '' };
    if (descriptor.type === 'object' || descriptor.properties) return Object.fromEntries(Object.entries(descriptor.properties || {}).filter(([, field]) => field.default !== undefined).map(([key, field]) => [key, structuredClone(field.default)]));
    return descriptor.default ?? (descriptor.type === 'boolean' ? false : descriptor.type === 'integer' || descriptor.type === 'number' ? 0 : '');
  }
  function card(title, key, initiallyOpen = false) {
    const details = document.createElement('details'); details.className = 'structured-entry deployment-card';
    details.open = openCards.get(key) ?? initiallyOpen;
    const summary = document.createElement('summary'); summary.textContent = title; details.append(summary);
    details.addEventListener('toggle', () => openCards.set(key, details.open));
    return details;
  }
  function menuTypes() {
    const key = target => JSON.stringify([target.component, target.view, target.layout || 'default']);
    const types = new Map(builtinMenuTypes().map(target => [key(target), { ...target, title: message(target.ui.label) }]));
    for (const target of discovery.menuTypes || []) types.set(key(target), { ...types.get(key(target)), ...target });
    for (const entry of value) {
      if (!entry.component || !entry.view) continue;
      const target = { component: entry.component, view: entry.view, layout: entry.query?.layout || 'default' };
      if (!types.has(key(target))) types.set(key(target), { ...target,
        title: `${labelOf(entry.component.replace(/^com_/, ''))} · ${labelOf(entry.view)}${target.layout !== 'default' ? ` · ${labelOf(target.layout)}` : ''}`,
      });
    }
    return [...types.values()];
  }
  function menuSchema(entry, descriptor) {
    const available = menuTypes();
    const native = available.find(item => item.component === entry.component && item.view === entry.view && item.layout === (entry.query?.layout || 'default'))
      || available.find(item => item.component === entry.component && item.view === entry.view);
    const properties = { ...descriptor.properties };
    for (const name of ['component', 'view']) properties[name] = { ...properties[name], ui: { ...properties[name]?.ui, advanced: true } };
    if (!native) return { ...descriptor, properties };
    for (const group of ['query', 'params']) {
      const fields = (native.fields || []).filter(field => field.group === group || group === 'query' && field.group === 'request');
      const nativeSchema = native[`${group}Schema`];
      if (!nativeSchema && !fields.length) continue;
      properties[group] = { ...properties[group], ...(nativeSchema || {
        type: 'object', properties: Object.fromEntries(fields.map(field => [field.name, {
          type: /^(?:integer|number)$/.test(field.type) ? 'integer' : 'string', title: field.label || labelOf(field.name), description: field.description,
          ...(field.options?.length ? { oneOf: field.options.map(option => ({ const: option.value, title: option.title })) } : {}),
          ...(field.type === 'textarea' || field.type === 'editor' ? { ui: { widget: 'textarea' } } : {}),
        }])), required: fields.filter(field => field.required).map(field => field.name),
      }), ui: { ...properties[group]?.ui, advanced: group !== 'query' } };
    }
    return { ...descriptor, properties };
  }
  function list(current, descriptor, replace, path, caption) {
    if (!Array.isArray(current)) return notice('deploymentForm.invalidValue');
    const wrapper = document.createElement('div'); wrapper.className = 'deployment-list';
    if (caption) { const heading = document.createElement('h3'); heading.textContent = caption; wrapper.append(heading); }
    if (!current.length && descriptor.ui?.empty) wrapper.append(notice(descriptor.ui.empty));
    current.forEach((entry, index) => {
      const title = entry?.title || entry?.system_name || `${message(descriptor.ui?.item) || caption || t('deploymentForm.setting')} ${index + 1}`;
      const item = card(title, entry?.key || `${path.join('.')}.${index}`, current.length === 1);
      if (kind === 'menus') {
        const available = menuTypes();
        const selected = available.findIndex(target => target.component === entry.component && target.view === entry.view && (target.layout || 'default') === (entry.query?.layout || 'default'));
        item.append(scalar(selected < 0 ? undefined : selected, { type: 'integer',
          oneOf: available.map((target, number) => ({ const: number, title: target.title })),
          ui: { help: 'deploymentForm.help.pageType', rerender: true },
        }, choice => {
          if (choice === undefined) return;
          const target = available[choice]; entry.component = target.component; entry.view = target.view;
          if (target.layout && target.layout !== 'default') { entry.query ||= {}; entry.query.layout = target.layout; }
          else if (entry.query) delete entry.query.layout;
          replace(current);
        }, [...path, index, 'pageType'], t('deploymentForm.field.pageType'), true));
      }
      const itemSchema = kind === 'menus' ? menuSchema(entry, descriptor.items || {}) : descriptor.items || {};
      const child = record(entry) ? objectFields(entry, itemSchema, next => { current[index] = next; replace(current); item.querySelector('summary').textContent = next.title || title; }, [...path, index])
        : scalar(entry, descriptor.items || {}, next => { current[index] = next; replace(current); }, [...path, index], title);
      item.append(child);
      const actions = document.createElement('div'); actions.className = 'structured-actions';
      actions.append(button(t('deploymentForm.remove'), () => { current.splice(index, 1); replace(current); changed(); render(); }, `${t('deploymentForm.remove')} ${title}`));
      if (index > 0) actions.append(button('↑', () => { [current[index - 1], current[index]] = [current[index], current[index - 1]]; replace(current); changed(); render(); }, t('deploymentForm.moveUp')));
      if (index < current.length - 1) actions.append(button('↓', () => { [current[index + 1], current[index]] = [current[index], current[index + 1]]; replace(current); changed(); render(); }, t('deploymentForm.moveDown')));
      item.append(actions); wrapper.append(item);
    });
    const add = button(message(descriptor.ui?.add) || t('deploymentForm.addSetting'), () => {
      const entry = freshItem(path, descriptor.items || {}); current.push(entry); replace(current);
      openCards.set(entry?.key || `${path.join('.')}.${current.length - 1}`, true); changed(); render();
    });
    if (descriptor.maxItems !== undefined && current.length >= descriptor.maxItems) { add.disabled = true; add.dataset.schemaDisabled = 'true'; }
    wrapper.append(add); return wrapper;
  }
  function targets() {
    const result = new Map(builtinConfigurationTargets().map(target => [targetKey(target), { ...target, title: `JCB · ${t('deploymentForm.field.repository')}` }]));
    for (const target of discovery.configurationTargets || []) result.set(targetKey(target), { ...result.get(targetKey(target)), ...target });
    return [...result.values()].filter(target => target.view !== 'server');
  }
  async function requestRecordSchema(entry) {
    if (typeof onSchemaRequest !== 'function') return;
    const key = targetKey(entry);
    if (pendingSchemas.has(key)) return;
    pendingSchemas.add(key);
    try {
      const result = await onSchemaRequest(structuredValue(entry));
      if (!result || targetKey(entry) !== key || !value.includes(entry)) return;
      const next = result.schema || result.configurationTargets?.find(target => targetKey(target) === key)?.schema || (result.properties ? result : null);
      if (next) { recordSchemas.set(key, structuredValue(next)); entry.schema = structuredValue(next); if (!jsonError && !fieldErrors.size) { changed(); render(); } }
    } catch { showError(new Error(t('deploymentForm.schemaUnavailable'))); }
    finally { pendingSchemas.delete(key); }
  }
  function overlayFields(entry) {
    const target = targets().find(item => targetKey(item) === targetKey(entry));
    const schema = recordSchemas.get(targetKey(entry)) || entry.schema || target?.schema;
    const optional = node => {
      if (!record(node)) return node;
      const result = { ...node, required: [] };
      if (node.properties) result.properties = Object.fromEntries(Object.entries(node.properties).map(([name, field]) => [name, optional(field)]));
      if (node.items) result.items = optional(node.items);
      return result;
    };
    return schema ? optional(schema) : { type: 'object', properties: {} };
  }
  function overlays() {
    const wrapper = document.createElement('div'); wrapper.className = 'deployment-list';
    if (!value.length) wrapper.append(notice('deploymentForm.emptySettings'));
    value.forEach((entry, index) => {
      const nativeTarget = targets().find(target => targetKey(target) === targetKey(entry));
      const title = entry.fields?.system_name || entry.fields?.title || nativeTarget?.title || `${entry.component || entry.element || t('deploymentForm.setting')}${entry.view ? ` · ${entry.view}` : ''}`;
      const section = card(title, entry.key || `overlay.${index}`, value.length === 1);
      const common = { type: 'object', properties: {
        kind: { type: 'string', oneOf: ['record', 'component', 'plugin', 'module'].map(kind => ({ const: kind, ui: { label: `deploymentForm.kind.${kind}` } })), ui: { label: 'deploymentForm.field.kind', rerender: true } },
      } };
      section.append(objectFields({ kind: entry.kind }, common, next => {
        entry.kind = next.kind;
        delete entry.schema;
        for (const key of ['component', 'view', 'element', 'folder', 'clientId']) delete entry[key];
      }, ['overlays', index, 'target']));
      // Render the target separately so record fields never become raw structural controls.
      const targetProperties = {};
      if (entry.kind === 'record' || entry.kind === 'component') targetProperties.component = { type: 'string', ui: { label: 'deploymentForm.field.component' } };
      if (entry.kind === 'record') targetProperties.view = { type: 'string', ui: { label: 'deploymentForm.field.view' } };
      if (entry.kind === 'plugin') targetProperties.folder = { type: 'string', ui: { label: 'deploymentForm.field.folder' } };
      if (entry.kind === 'plugin' || entry.kind === 'module') targetProperties.element = { type: 'string', ui: { label: 'deploymentForm.field.element' } };
      if (entry.kind === 'module') targetProperties.clientId = { type: 'integer', oneOf: [{ const: 0, ui: { label: 'deploymentForm.location.site' } }, { const: 1, ui: { label: 'deploymentForm.location.administrator' } }], default: 0, ui: { label: 'deploymentForm.field.clientId' } };
      const targetValues = Object.fromEntries(Object.keys(targetProperties).filter(name => own(entry, name)).map(name => [name, entry[name]]));
      const targetFields = objectFields(targetValues, { type: 'object', properties: targetProperties }, next => {
        for (const key of Object.keys(targetProperties)) { if (own(next, key)) entry[key] = next[key]; else delete entry[key]; }
        delete entry.schema;
      }, ['overlays', index]);
      targetFields.addEventListener('change', () => { void requestRecordSchema(entry); });
      const choices = targets().filter(target => target.kind === entry.kind);
      if (choices.length) {
        const picker = document.createElement('select'); picker.setAttribute('aria-label', t('deploymentForm.field.component'));
        const blank = document.createElement('option'); blank.value = ''; blank.textContent = t('deploymentForm.choose'); picker.append(blank);
        choices.forEach((target, number) => { const option = document.createElement('option'); option.value = String(number); option.textContent = target.title || `${target.component || target.element} · ${target.view || ''}`; picker.append(option); });
        const selected = choices.findIndex(target => targetKey(target) === targetKey(entry)); picker.value = selected < 0 ? '' : String(selected);
        picker.addEventListener('change', () => {
          if (picker.value === '') return;
          const target = choices[Number(picker.value)];
          for (const key of ['component', 'view', 'element', 'folder', 'clientId']) { if (target[key] !== undefined) entry[key] = target[key]; else delete entry[key]; }
          if (target.schema) entry.schema = structuredClone(target.schema); else delete entry.schema;
          changed(); render(); void requestRecordSchema(entry);
        });
        section.append(picker);
      }
      if (entry.kind === 'record') section.append(scalar(entry.guid, { type: 'string', ui: { help: 'deploymentForm.help.guid' } }, next => { if (next) entry.guid = next; else delete entry.guid; }, ['overlays', index, 'guid'], t('deploymentForm.field.guid')));
      // Native names stay available for extensions which are not installed yet.
      // The primary workflow is choosing the translated target above.
      if (nativeTarget || choices.length) {
        const technical = document.createElement('details'); technical.className = 'deployment-more-options';
        const heading = document.createElement('summary'); heading.textContent = t('deploymentForm.more'); technical.append(heading, targetFields); section.append(technical);
      } else section.append(targetFields);
      const fieldset = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = t('deploymentForm.field.fields'); fieldset.append(legend);
      fieldset.append(notice('deploymentForm.help.settings'), objectFields(entry.fields || {}, overlayFields(entry), next => { entry.fields = next; }, ['overlays', index, 'fields']));
      section.append(fieldset);
      const identity = document.createElement('details'); const identityTitle = document.createElement('summary'); identityTitle.textContent = t('deploymentForm.more'); identity.append(identityTitle);
      const matchSchema = { type: 'object', properties: Object.fromEntries(Object.entries(overlayFields(entry).properties || {}).filter(([name, field]) => !['object', 'array'].includes(field.type) && name !== 'id' && !/(?:password|secret|token)/i.test(name))) };
      if (entry.match && Object.keys(entry.match).length) identity.append(objectFields(entry.match, { type: 'object' }, next => { entry.match = next; }, ['overlays', index, 'match']));
      const matchKeys = Object.keys(matchSchema.properties);
      if (matchKeys.length && !entry.guid) {
        const matchPicker = document.createElement('select'); matchPicker.setAttribute('aria-label', t('deploymentForm.field.match'));
        const none = document.createElement('option'); none.value = ''; none.textContent = t('deploymentForm.addMatch'); matchPicker.append(none);
        for (const name of matchKeys) { const option = document.createElement('option'); option.value = name; option.textContent = label(matchSchema.properties[name], name); matchPicker.append(option); }
        matchPicker.addEventListener('change', () => { if (!matchPicker.value) return; entry.match ||= {}; entry.match[matchPicker.value] = entry.fields?.[matchPicker.value] ?? ''; changed(); render(); });
        identity.append(matchPicker);
      }
      if (entry.kind === 'record') identity.append(objectFields(entry.source || {}, { type: 'object', properties: {
        repository: { type: 'string', ui: { label: 'deploymentForm.field.repository', help: 'deploymentForm.help.source' } },
        refresh: { type: 'boolean', ui: { label: 'deploymentForm.field.refresh' } },
      } }, next => { entry.source = next; }, ['overlays', index, 'source']));
      section.append(identity, button(t('deploymentForm.remove'), () => { value.splice(index, 1); changed(); render(); })); wrapper.append(section);
    });
    wrapper.append(button(t('deploymentForm.addSetting'), () => {
      const entry = { key: identifier('configuration'), kind: 'record', component: 'com_componentbuilder', view: 'repository', fields: {} };
      value.push(entry); openCards.set(entry.key, true); changed(); render(); void requestRecordSchema(entry);
    }));
    return wrapper;
  }
  function commands() {
    const wrapper = document.createElement('div'); wrapper.append(notice('deploymentForm.help.commands'));
    value.forEach((command, index) => {
      const row = card(`${t('deploymentForm.command')} ${index + 1}${command[0] ? ` · ${command[0]}` : ''}`, `command.${index}`, true);
      row.append(scalar(command[0] ?? '', { type: 'string' }, next => { command[0] = next; }, [index, 0], t('deploymentForm.command'), true));
      command.slice(1).forEach((argument, number) => {
        const field = document.createElement('div'); field.className = 'structured-actions';
        field.append(scalar(argument, { type: 'string', ui: { widget: 'textarea' } }, next => { command[number + 1] = next; }, [index, number + 1], `${t('deploymentForm.argument')} ${number + 1}`),
          button(t('deploymentForm.remove'), () => { command.splice(number + 1, 1); changed(); render(); })); row.append(field);
      });
      row.append(button(t('deploymentForm.addArgument'), () => { command.push(''); changed(); render(); }), button(t('deploymentForm.remove'), () => { value.splice(index, 1); changed(); render(); })); wrapper.append(row);
    });
    wrapper.append(button(t('deploymentForm.addCommand'), () => { value.push(['']); changed(); render(); })); return wrapper;
  }
  function checkShape(next) {
    if (['commands', 'menus', 'overlays'].includes(kind) && !Array.isArray(next)) throw new TypeError(t('deploymentForm.invalidValue'));
    if (kind === 'commands' && next.some(command => !Array.isArray(command) || command.some(argument => typeof argument !== 'string'))) throw new TypeError(t('deploymentForm.invalidValue'));
    if (['menus', 'overlays'].includes(kind) && next.some(entry => !record(entry))) throw new TypeError(t('deploymentForm.invalidValue'));
    if (kind === 'content' && next !== null && (!record(next) || ['categories', 'articles'].some(name => next[name] !== undefined && (!Array.isArray(next[name]) || next[name].some(entry => !record(entry)))))) throw new TypeError(t('deploymentForm.invalidValue'));
    if (kind === 'parameters' && !record(next)) throw new TypeError(t('deploymentForm.invalidValue'));
    return next;
  }
  function render() {
    fieldErrors = new Map(); container.classList.add('structured-editor', 'deployment-schema-editor');
    let body;
    if (kind === 'commands') body = commands();
    else if (kind === 'overlays') body = overlays();
    else if (kind === 'menus') body = formSchema ? list(value, formSchema, next => { value = next; }, ['menus']) : notice(discovery.schemaUnavailable ? 'deployment.schemaFailure' : 'deploymentForm.schemaLoading');
    else if (kind === 'content' && !formSchema) body = notice(discovery.schemaUnavailable ? 'deployment.schemaFailure' : 'deploymentForm.schemaLoading');
    else body = objectFields(kind === 'content' ? { categories: [], articles: [], ...value } : value, formSchema || { type: 'object' }, next => { value = next; });
    container.replaceChildren(body); lock(jsonError);
  }
  function setValue(next) {
    const parsed = checkShape(structuredValue(typeof next === 'string' ? JSON.parse(next) : next));
    value = parsed; jsonError = null; fieldErrors = new Map(); capturedKeys.clear(); textarea.value = JSON.stringify(value, null, 2); render(); showError(null);
  }
  function read() {
    if (jsonError) { if (advanced) advanced.open = true; textarea.focus(); throw jsonError; }
    const first = fieldErrors.entries().next().value;
    if (first) { first[0].focus(); showError(first[1]); throw first[1]; }
    const invalid = [...container.querySelectorAll('input,select,textarea')].find(control => !control.disabled && !control.checkValidity());
    if (invalid) {
      for (let parent = invalid.parentElement; parent && parent !== container; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      invalid.focus(); const error = new TypeError(invalid.validationMessage || t('deploymentForm.invalidValue')); showError(error); throw error;
    }
    try { return structuredValue(validate(structuredValue(value))); } catch (error) { showError(error); throw error; }
  }
  textarea.addEventListener('input', () => {
    try { const parsed = checkShape(structuredValue(JSON.parse(textarea.value))); value = parsed; jsonError = null; render(); }
    catch (error) { lock(error); }
    onChange();
  });
  advanced?.addEventListener('toggle', () => { if (!advanced.open && jsonError) advanced.open = true; });
  setValue(textarea.value.trim() ? JSON.parse(textarea.value) : fallback);
  return {
    setValue, read,
    refresh() { if (!fieldErrors.size) render(); },
    setSchema(next) { formSchema = next; if (!jsonError && !fieldErrors.size) render(); },
    setContext(next) { discovery = { ...discovery, ...next }; if (!jsonError && !fieldErrors.size) render(); },
    setRecordSchema(target, next) { recordSchemas.set(targetKey(target), next); if (!jsonError && !fieldErrors.size) render(); },
    append(entry, { schema } = {}) {
      if (!Array.isArray(value) || jsonError) throw jsonError || new TypeError(t('deploymentForm.invalidValue'));
      const next = structuredValue(entry);
      if (schema) next.schema = structuredValue(schema);
      const remap = node => {
        if (Array.isArray(node)) node.forEach(remap);
        else if (record(node)) {
          if (capturedKeys.has(node.$ref)) node.$ref = capturedKeys.get(node.$ref);
          if (Array.isArray(node.dependsOn)) node.dependsOn = node.dependsOn.map(key => capturedKeys.get(key) || key);
          for (const [name, child] of Object.entries(node)) if (name !== 'schema') remap(child);
        }
      };
      remap(next);
      const sameRecord = item => targetKey(item) === targetKey(next) && (
        next.guid && item.guid === next.guid || next.match && Object.keys(next.match).length && item.match && JSON.stringify(Object.entries(item.match).sort()) === JSON.stringify(Object.entries(next.match).sort())
      );
      const index = value.findIndex(item => next.key && item.key === next.key || sameRecord(item));
      if (index >= 0) {
        const previousKey = value[index].key;
        value[index] = { ...value[index], ...next, key: previousKey, fields: { ...value[index].fields, ...next.fields } };
        // Captured dependencies refer to the incoming key. Keep the existing key stable
        // and remap those references when two captures identify the same record.
        if (next.key !== previousKey) {
          capturedKeys.set(next.key, previousKey);
          value.forEach(remap);
        }
        openCards.set(previousKey, true);
      } else { value.push(next); openCards.set(next.key, true); }
      changed(); render();
    },
  };
}
