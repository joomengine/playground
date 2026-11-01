import { parseExtensions, parseUserExtensions } from './config.mjs';

const MAX_EXTENSIONS = 30;

/** URL rows and advanced JSON are two editors for the same extension list. */
export function createExtensionInputs({ textarea, rows, addButton, advanced, errorElement,
  baseURL, t, onChange = () => {},
}) {
  const document = textarea.ownerDocument;
  let entries = [];
  let managedEntries = new Map();
  let controls = [];
  let source = 'rows';
  let jsonError;
  let visibleError;
  const parse = value => parseUserExtensions(value, baseURL).map(entry => managedEntries.has(entry.url)
    ? structuredClone(managedEntries.get(entry.url)) : entry);

  const showError = error => {
    visibleError = error;
    errorElement.textContent = error ? `${source === 'json' ? `${t('error.extensionJson')} ` : ''}${error.message}` : '';
    errorElement.hidden = !error;
  };
  const markJson = error => {
    jsonError = error;
    textarea.setAttribute('aria-invalid', String(Boolean(error)));
    textarea.setCustomValidity(error?.message || '');
    for (const control of controls) {
      control.input.disabled = Boolean(error);
      control.remove.disabled = Boolean(error);
    }
    addButton.disabled = Boolean(error) || entries.length >= MAX_EXTENSIONS;
  };
  const rowError = () => {
    for (const [index, entry] of entries.entries()) {
      const value = entry.url.trim();
      let error;
      try {
        if (value && !/^https?:\/\//i.test(value)) throw new TypeError(t('error.extensionUrl', { number: index + 1 }));
        if (value) parse([{ ...entry, url: value }]);
      } catch (failure) { error = failure; }
      const control = controls[index];
      control?.input.setAttribute('aria-invalid', String(Boolean(error)));
      control?.input.setCustomValidity(error?.message || '');
      if (error) return { error, index };
    }
    return null;
  };
  const refresh = () => {
    addButton.textContent = t('action.addExtensionUrl');
    addButton.disabled = Boolean(jsonError) || entries.length >= MAX_EXTENSIONS;
    for (const [index, control] of controls.entries()) {
      const number = index + 1;
      const id = index ? `extension-url-${number}` : 'package-url';
      control.input.id = id;
      control.label.htmlFor = id;
      control.label.textContent = t('label.extensionUrlNumber', { number });
      control.remove.setAttribute('aria-label', t('action.removeExtensionUrl', { number }));
      control.remove.title = t('action.removeExtensionUrl', { number });
    }
    if (source === 'rows' && visibleError) showError(rowError()?.error);
    else if (visibleError) showError(visibleError);
  };
  const writeRows = () => {
    source = 'rows';
    // An unused extra row is a convenience, not an invalid package or a request
    // to install an empty URL. Preserve its input until explicitly removed.
    textarea.value = JSON.stringify(entries.filter(entry => entry.url.trim())
      .map(entry => ({ ...entry, url: entry.url.trim() })), null, 2);
    markJson(null);
    showError(rowError()?.error);
    onChange();
  };
  const renderRows = () => {
    controls = entries.map((entry, index) => {
      const row = document.createElement('div'); row.className = 'extension-url-row';
      const field = document.createElement('div'); field.className = 'field';
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'url'; input.value = entry.url; input.maxLength = 2048;
      input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = 'https://example.org/extension.zip';
      input.setAttribute('aria-describedby', errorElement.id);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button button-secondary extension-url-remove';
      remove.textContent = '×';
      input.addEventListener('input', () => {
        if (jsonError) return;
        // A digest belongs to the exact configured source. Never carry a stale
        // checksum into a different package when editing its URL.
        if (input.value.trim() !== entry.url) { delete entry.sha256; delete entry.sha512; }
        entry.url = input.value.trim();
        writeRows();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') event.preventDefault();
      });
      remove.addEventListener('click', () => {
        if (jsonError) return;
        entries.splice(index, 1);
        if (!entries.length) entries.push({ url: '' });
        renderRows(); writeRows();
        controls[Math.min(index, controls.length - 1)].input.focus();
      });
      field.append(label, input); row.append(field, remove);
      return { row, label, input, remove };
    });
    rows.replaceChildren(...controls.map(control => control.row));
    refresh(); markJson(jsonError);
  };
  const read = () => {
    if (source === 'rows') {
      const invalid = rowError();
      if (invalid) {
        showError(invalid.error); controls[invalid.index].input.focus();
        throw invalid.error;
      }
    }
    try {
      const result = parse(textarea.value);
      markJson(null); showError(null);
      return result;
    } catch (error) {
      source = 'json'; markJson(error); showError(error);
      advanced.open = true; textarea.focus();
      throw error;
    }
  };
  const setValue = (value, { managed = [] } = {}) => {
    // Validate before replacing either representation, including import errors.
    const nextManaged = new Map(parseExtensions(managed, baseURL).map(entry => [entry.url, entry]));
    const parsed = parseUserExtensions(value, baseURL).map(entry => nextManaged.has(entry.url) ? structuredClone(nextManaged.get(entry.url)) : entry);
    managedEntries = nextManaged;
    entries = parsed.length ? parsed : [{ url: '' }];
    textarea.value = JSON.stringify(parsed, null, 2);
    source = 'rows'; jsonError = undefined; showError(null);
    renderRows(); markJson(null);
  };

  addButton.addEventListener('click', () => {
    if (jsonError) return;
    if (entries.length >= MAX_EXTENSIONS) { showError(new TypeError(t('error.extensionLimit'))); return; }
    entries.push({ url: '' }); renderRows(); writeRows();
    controls.at(-1).input.focus();
  });
  textarea.addEventListener('input', () => {
    source = 'json';
    try {
      const parsed = parse(textarea.value);
      entries = parsed.length ? parsed : [{ url: '' }];
      markJson(null); showError(null); renderRows();
    } catch (error) {
      // Keep both the exact JSON draft and the last valid URL rows. Mutating
      // stale rows here would silently overwrite the user's unfinished JSON.
      markJson(error); showError(error);
    }
    onChange();
  });
  advanced.addEventListener('toggle', () => {
    if (!advanced.open && jsonError) { advanced.open = true; showError(jsonError); }
  });
  setValue(parseUserExtensions(textarea.value || '[]', baseURL));
  return { setValue, read, refresh };
}
