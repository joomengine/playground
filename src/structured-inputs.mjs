const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const TYPES = ['string', 'number', 'boolean', 'null', 'object', 'array'];
const kindOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const initialValue = type => ({ string: '', number: 0, boolean: false, null: null, object: {}, array: [] })[type];
const labelOf = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());

/** Reject non-JSON or excessively deep data before constructing form controls. */
export function structuredValue(input) {
  let count = 0;
  function visit(value, depth) {
    if (++count > 2000 || depth > 10) throw new TypeError('This configuration is too complex for the basic editor.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (RESERVED.has(key)) throw new TypeError('This configuration contains an invalid property.');
        result[key] = visit(item, depth + 1);
      }
      return result;
    }
    throw new TypeError('Use JSON text, numbers, true, false, null, lists or objects.');
  }
  return visit(input, 0);
}

/** Basic controls and advanced JSON edit one value without overwriting invalid drafts. */
export function createStructuredInputs({ textarea, container, advanced, errorElement,
  kind = 'parameters', onChange = () => {}, validate = value => value,
}) {
  const document = textarea.ownerDocument;
  let value;
  let jsonError;
  let fieldErrors = new Map();
  const fallback = kind === 'commands' || kind === 'menus' ? [] : {};

  function showError(error) {
    if (!errorElement) return;
    errorElement.textContent = error?.message || '';
    errorElement.hidden = !error;
  }
  function lock(error) {
    jsonError = error;
    textarea.setAttribute('aria-invalid', String(Boolean(error)));
    textarea.setCustomValidity(error?.message || '');
    for (const control of container.querySelectorAll('input,textarea,select,button')) control.disabled = Boolean(error);
    showError(error);
  }
  function fieldError(control, message) {
    control.setCustomValidity(message || '');
    control.setAttribute('aria-invalid', String(Boolean(message)));
    if (message) fieldErrors.set(control, new TypeError(message));
    else fieldErrors.delete(control);
    showError(fieldErrors.values().next().value);
  }
  function changed() {
    textarea.value = JSON.stringify(value, null, 2);
    lock(null);
    showError(fieldErrors.values().next().value);
    onChange();
  }
  function button(text, action, ariaLabel = text) {
    const control = document.createElement('button');
    control.type = 'button'; control.className = 'button button-secondary';
    control.textContent = text; control.setAttribute('aria-label', ariaLabel);
    control.addEventListener('click', () => {
      const invalid = fieldErrors.entries().next().value;
      if (invalid) { invalid[0].focus(); showError(invalid[1]); return; }
      if (!jsonError) action();
    });
    return control;
  }
  function input(label, current, change, multiline = false) {
    const field = document.createElement('label'); field.className = 'structured-field';
    const caption = document.createElement('span'); caption.textContent = label;
    const control = document.createElement(multiline ? 'textarea' : 'input');
    if (multiline) control.rows = 1; else control.type = 'text';
    control.value = String(current); control.autocomplete = 'off'; control.spellcheck = false;
    control.setAttribute('aria-label', label);
    control.addEventListener('input', () => { if (!jsonError) change(control.value, control); });
    if (!multiline) control.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    field.append(caption, control);
    return { field, control };
  }

  function node(current, replace, label, depth = 0) {
    const wrapper = document.createElement('div'); wrapper.className = 'structured-row';
    const heading = document.createElement('div'); heading.className = 'structured-actions';
    const caption = document.createElement('span'); caption.textContent = label;
    const type = document.createElement('select'); type.setAttribute('aria-label', `${label} type`);
    for (const name of TYPES) {
      const option = document.createElement('option'); option.value = name; option.textContent = labelOf(name);
      type.append(option);
    }
    type.value = kindOf(current);
    type.addEventListener('change', () => {
      const invalid = fieldErrors.entries().next().value;
      if (invalid) { type.value = kindOf(current); invalid[0].focus(); showError(invalid[1]); return; }
      replace(initialValue(type.value)); changed(); render();
    });
    heading.append(caption, type); wrapper.append(heading);
    const selected = kindOf(current);
    if (selected === 'object' || selected === 'array') {
      const children = document.createElement('div'); children.className = 'structured-children';
      for (const [key, child] of Object.entries(current)) {
        let activeKey = key;
        const entry = document.createElement('div'); entry.className = 'structured-entry';
        if (selected === 'object') {
          const name = input(`${label} field name`, key, (next, control) => {
            if (!next.trim() || RESERVED.has(next) || (next !== activeKey && Object.hasOwn(current, next))) {
              fieldError(control, 'Use a distinct nonempty field name.'); return;
            }
            if (next !== activeKey) {
              const reordered = Object.fromEntries(Object.entries(current).map(([name, item]) => [name === activeKey ? next : name, item]));
              for (const name of Object.keys(current)) delete current[name];
              Object.assign(current, reordered); activeKey = next;
            }
            fieldError(control); changed();
          });
          entry.append(name.field);
        }
        const childLabel = selected === 'array' ? `${label} ${Number(key) + 1}` : `${label}: ${labelOf(key)}`;
        entry.append(node(child, next => { current[activeKey] = next; }, childLabel, depth + 1));
        entry.append(button('Remove', () => {
          if (selected === 'array') current.splice(Number(activeKey), 1); else delete current[activeKey];
          changed(); render();
        }, `Remove ${childLabel}`));
        children.append(entry);
      }
      wrapper.append(children);
      if (depth < 10) wrapper.append(button(selected === 'array' ? 'Add item' : 'Add field', () => {
        if (selected === 'array') current.push('');
        else {
          let key = 'field', number = 2;
          while (Object.hasOwn(current, key)) key = `field${number++}`;
          current[key] = '';
        }
        changed(); render();
      }, selected === 'array' ? `Add item to ${label}` : `Add field to ${label}`));
    } else if (selected === 'boolean') {
      const control = document.createElement('input'); control.type = 'checkbox'; control.checked = current;
      control.setAttribute('aria-label', label);
      control.addEventListener('change', () => { replace(control.checked); changed(); });
      wrapper.append(control);
    } else if (selected !== 'null') {
      const field = input(`${label} value`, current, (next, control) => {
        if (selected === 'number' && (!next.trim() || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(next) || !Number.isFinite(Number(next)))) {
          fieldError(control, 'Enter a finite number.'); return;
        }
        replace(selected === 'number' ? Number(next) : next); fieldError(control); changed();
      }, selected === 'string');
      wrapper.append(field.field);
    }
    return wrapper;
  }

  function commands() {
    if (!Array.isArray(value) || value.some(command => !Array.isArray(command) || command.some(argument => typeof argument !== 'string'))) {
      throw new TypeError('Console commands must be lists of text arguments.');
    }
    const fragment = document.createDocumentFragment();
    value.forEach((command, index) => {
      const row = document.createElement('div'); row.className = 'command-row';
      const name = input(`Command ${index + 1}`, command[0] ?? '', next => { command[0] = next; changed(); });
      row.append(name.field);
      const argumentsList = document.createElement('div'); argumentsList.className = 'command-arguments';
      command.slice(1).forEach((argument, number) => {
        const argumentRow = document.createElement('div'); argumentRow.className = 'structured-entry';
        const field = input(`Command ${index + 1} argument ${number + 1}`, argument, next => { command[number + 1] = next; changed(); }, true);
        argumentRow.append(field.field, button('Remove', () => { command.splice(number + 1, 1); changed(); render(); }, `Remove command ${index + 1} argument ${number + 1}`));
        argumentsList.append(argumentRow);
      });
      row.append(argumentsList, button('Add argument', () => { command.push(''); changed(); render(); }, `Add argument to command ${index + 1}`),
        button('Remove command', () => { value.splice(index, 1); changed(); render(); }, `Remove command ${index + 1}`));
      fragment.append(row);
    });
    fragment.append(button('Add command', () => { value.push(['']); changed(); render(); }));
    return fragment;
  }

  function render() {
    fieldErrors = new Map();
    container.classList.add('structured-editor');
    container.replaceChildren(kind === 'commands' ? commands() : node(value, next => { value = next; }, labelOf(kind)));
    lock(jsonError);
  }
  function setValue(next) {
    const parsed = structuredValue(typeof next === 'string' ? JSON.parse(next) : next);
    if (kind === 'commands' && (!Array.isArray(parsed) || parsed.some(command => !Array.isArray(command) || command.some(argument => typeof argument !== 'string')))) {
      throw new TypeError('Console commands must be lists of text arguments.');
    }
    value = parsed; jsonError = null; fieldErrors = new Map();
    textarea.value = JSON.stringify(value, null, 2); render(); showError(null);
  }
  function read() {
    if (jsonError) {
      if (advanced) advanced.open = true;
      textarea.focus(); throw jsonError;
    }
    const first = fieldErrors.entries().next().value;
    if (first) { first[0].focus(); showError(first[1]); throw first[1]; }
    try { return structuredValue(validate(structuredValue(value))); }
    catch (error) { showError(error); throw error; }
  }
  textarea.addEventListener('input', () => {
    try {
      const parsed = structuredValue(JSON.parse(textarea.value));
      if (kind === 'commands' && (!Array.isArray(parsed) || parsed.some(command => !Array.isArray(command) || command.some(argument => typeof argument !== 'string')))) {
        throw new TypeError('Console commands must be lists of text arguments.');
      }
      value = parsed; jsonError = null; render();
    } catch (error) { lock(error); }
    onChange();
  });
  advanced?.addEventListener('toggle', () => { if (!advanced.open && jsonError) advanced.open = true; });
  setValue(textarea.value.trim() ? JSON.parse(textarea.value) : fallback);
  return { setValue, read, refresh() { if (!fieldErrors.size) render(); } };
}
