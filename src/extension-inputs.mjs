import { parseExtensions, parseUserExtensions } from './config.mjs';

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
  const withIntegrity = (entry, managed) => ({ ...entry,
    ...Object.fromEntries(['sha256', 'sha512'].filter(key => managed?.[key]).map(key => [key, managed[key]])) });
  const parse = value => parseUserExtensions(value, baseURL).map(entry => withIntegrity(entry, managedEntries.get(entry.url)));

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
      for (const input of control.inputs) input.disabled = Boolean(error);
    }
    addButton.disabled = Boolean(error);
  };
  const rowError = () => {
    for (const [index, entry] of entries.entries()) {
      const value = entry.url.trim();
      let error;
      try {
        if (controls[index]?.headersError) throw new TypeError(t('error.packageHeaders'));
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
    addButton.disabled = Boolean(jsonError);
    for (const [index, control] of controls.entries()) {
      const number = index + 1;
      const id = index ? `extension-url-${number}` : 'package-url';
      control.input.id = id;
      control.label.htmlFor = id;
      control.label.textContent = t('label.extensionUrlNumber', { number });
      control.remove.setAttribute('aria-label', t('action.removeExtensionUrl', { number }));
      control.remove.title = t('action.removeExtensionUrl', { number });
      for (const [element, key] of control.translations) element.textContent = t(key);
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
      input.type = 'text'; input.value = entry.url;
      input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = 'https://example.org/extension.zip';
      input.setAttribute('aria-describedby', errorElement.id);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'button button-secondary extension-url-remove';
      remove.textContent = '×';
      const translations = [];
      const localized = (element, key) => { translations.push([element, key]); element.textContent = t(key); return element; };
      const access = document.createElement('details'); access.className = 'extension-package-access';
      access.open = Boolean(entry.authentication || entry.provider || entry.apiBase || entry.headers && Object.keys(entry.headers).length);
      const summary = localized(document.createElement('summary'), 'label.packageAccess');
      const fields = document.createElement('div'); fields.className = 'extension-access-fields';
      const addField = (key, type = 'text') => {
        const wrapper = document.createElement('label'); wrapper.className = 'field';
        const caption = localized(document.createElement('span'), key);
        const control = document.createElement(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input');
        if (control.tagName === 'INPUT') control.type = type;
        control.autocomplete = 'off'; control.spellcheck = false;
        wrapper.append(caption, control); fields.append(wrapper);
        return { wrapper, control };
      };
      const addOptions = (select, options) => {
        for (const [value, key, brand] of options) {
          const option = document.createElement('option'); option.value = value;
          if (key) localized(option, key); else option.textContent = brand;
          select.append(option);
        }
      };
      const provider = addField('label.packageProvider', 'select');
      addOptions(provider.control, [['', 'option.packageProviderAuto'], ['direct', 'option.packageProviderDirect'], ['github', null, 'GitHub'], ['gitea', null, 'Gitea'], ['gitlab', null, 'GitLab']]);
      provider.control.value = entry.provider || '';
      const apiBase = addField('label.packageApiBase'); apiBase.control.value = entry.apiBase || '';
      const authentication = addField('label.packageAuthentication', 'select');
      addOptions(authentication.control, [['', 'option.packageAuthenticationNone'], ['bearer', 'option.packageAuthenticationBearer'], ['token', 'option.packageAuthenticationToken'], ['basic', 'option.packageAuthenticationBasic'], ['header', 'option.packageAuthenticationHeader']]);
      authentication.control.value = entry.authentication?.type || '';
      const token = addField('label.packageToken', 'password'); token.control.value = entry.authentication?.token || '';
      const username = addField('label.packageUsername'); username.control.value = entry.authentication?.username || '';
      const password = addField('label.packagePassword', 'password'); password.control.value = entry.authentication?.password || '';
      const name = addField('label.packageHeaderName'); name.control.value = entry.authentication?.name || '';
      const value = addField('label.packageHeaderValue', 'password'); value.control.value = entry.authentication?.value || '';
      const headers = addField('label.packageHeaders', 'textarea'); headers.wrapper.classList.add('extension-package-headers');
      headers.control.rows = 3; headers.control.value = JSON.stringify(entry.headers || {}, null, 2);
      const help = localized(document.createElement('p'), 'help.packageAccess'); help.className = 'extension-package-help';
      fields.append(help); access.append(summary, fields);
      const result = { row, label, input, remove, translations, inputs: [input, remove, provider.control, apiBase.control,
        authentication.control, token.control, username.control, password.control, name.control, value.control, headers.control], headersError: false };
      const showAuthentication = () => {
        const type = authentication.control.value;
        token.wrapper.hidden = !['bearer', 'token'].includes(type);
        username.wrapper.hidden = password.wrapper.hidden = type !== 'basic';
        name.wrapper.hidden = value.wrapper.hidden = type !== 'header';
      };
      const writeAccess = () => {
        if (jsonError) return;
        if (provider.control.value) entry.provider = provider.control.value; else delete entry.provider;
        if (apiBase.control.value.trim()) entry.apiBase = apiBase.control.value.trim(); else delete entry.apiBase;
        const type = authentication.control.value;
        if (!type) delete entry.authentication;
        else if (['bearer', 'token'].includes(type)) entry.authentication = { type, token: token.control.value };
        else if (type === 'basic') entry.authentication = { type, username: username.control.value, password: password.control.value };
        else entry.authentication = { type, name: name.control.value.trim(), value: value.control.value };
        try {
          const parsed = JSON.parse(headers.control.value.trim() || '{}');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(item => typeof item !== 'string')) throw new TypeError();
          if (Object.keys(parsed).length) entry.headers = parsed; else delete entry.headers;
          result.headersError = false;
        } catch { result.headersError = true; }
        headers.control.setAttribute('aria-invalid', String(result.headersError));
        headers.control.setCustomValidity(result.headersError ? t('error.packageHeaders') : '');
        showAuthentication(); writeRows();
      };
      for (const control of result.inputs.slice(2)) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', writeAccess);
      showAuthentication();
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
      field.append(label, input); row.append(field, remove, access);
      return result;
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
    const parsed = parseUserExtensions(value, baseURL).map(entry => withIntegrity(entry, nextManaged.get(entry.url)));
    managedEntries = nextManaged;
    entries = parsed.length ? parsed : [{ url: '' }];
    textarea.value = JSON.stringify(parsed, null, 2);
    source = 'rows'; jsonError = undefined; showError(null);
    renderRows(); markJson(null);
  };

  addButton.addEventListener('click', () => {
    if (jsonError) return;
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
