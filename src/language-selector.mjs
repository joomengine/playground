/** Joomla language tags follow the same language[-Script]-REGION contract as configuration parsing. */
export function normalizeLanguageTag(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('-');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.length === 3 && !/^[a-zA-Z]{4}$/.test(parts[1])) return null;
  const language = parts[0].toLowerCase();
  const region = parts.at(-1).toUpperCase();
  const script = parts.length === 3 ? `${parts[1].slice(0, 1).toUpperCase()}${parts[1].slice(1).toLowerCase()}` : '';
  const tag = `${language}${script ? `-${script}` : ''}-${region}`;
  return /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2}$/.test(tag) ? tag : null;
}

export function languageCatalog(tags, locale = 'en') {
  let names;
  try { names = new Intl.DisplayNames([locale], { type: 'language' }); } catch { /* Tag remains a useful label. */ }
  return [...new Set(['en-GB', ...(tags || [])].map(normalizeLanguageTag).filter(Boolean))].map(tag => {
    let name = tag;
    try { name = names?.of(tag) || tag; } catch { /* Future catalog tags can still be selected. */ }
    return { tag, name };
  });
}

export function filterLanguages(catalog, query = '', selected = []) {
  const needle = String(query).trim().toLocaleLowerCase();
  const existing = new Set(selected);
  return catalog.filter(({ tag, name }) => !existing.has(tag)
    && (!needle || tag.toLocaleLowerCase().includes(needle) || name.toLocaleLowerCase().includes(needle)));
}

/**
 * A shared editable combobox. The original input remains the configuration
 * value: a tag for single select, comma-separated tags for multiple select.
 * Availability is deliberately left to the pinned language-package resolver.
 */
export function createLanguageSelector(input, { multiple = false, t, getLocale = () => 'en' } = {}) {
  if (!input?.ownerDocument || typeof t !== 'function') throw new TypeError('A language input and translator are required.');
  const document = input.ownerDocument;
  const window = document.defaultView;
  const listeners = [];
  const original = { type: input.type, hidden: input.hidden, list: input.getAttribute('list'),
    pattern: input.getAttribute('pattern'), autocomplete: input.getAttribute('autocomplete'),
    role: input.getAttribute('role'), labelled: input.getAttribute('aria-label'), described: input.getAttribute('aria-describedby') };
  const labels = [...(input.labels || [])];
  const wrapper = document.createElement('div'); wrapper.className = 'language-selector';
  input.before(wrapper);
  const row = document.createElement('div'); row.className = 'language-input-row'; wrapper.append(row);
  const entry = multiple ? document.createElement('input') : input;
  if (multiple) {
    input.type = 'hidden'; wrapper.append(input);
    entry.type = 'text'; entry.id = `${input.id}-entry`;
    entry.setAttribute('aria-label', t('language.add'));
    for (const label of labels) label.htmlFor = entry.id;
  }
  row.append(entry);
  entry.autocomplete = 'off'; entry.spellcheck = false;
  entry.removeAttribute('list'); entry.removeAttribute('pattern');
  entry.setAttribute('role', 'combobox'); entry.setAttribute('aria-autocomplete', 'list');
  entry.setAttribute('aria-haspopup', 'listbox'); entry.setAttribute('aria-expanded', 'false');
  const toggle = document.createElement('button'); toggle.type = 'button';
  toggle.className = 'language-toggle'; toggle.textContent = '⌄';
  toggle.dataset.icon = 'dashboard-toggle'; toggle.dataset.iconOnly = 'true';
  row.append(toggle);
  const chips = document.createElement('div'); chips.className = 'language-tags';
  if (multiple) wrapper.append(chips);
  const list = document.createElement('div'); list.className = 'language-options';
  list.id = `${input.id}-choices`; list.setAttribute('role', 'listbox'); list.hidden = true;
  entry.setAttribute('aria-controls', list.id); toggle.setAttribute('aria-controls', list.id);
  const note = document.createElement('p'); note.className = 'language-note'; note.id = `${input.id}-note`;
  entry.setAttribute('aria-describedby', [original.described, note.id].filter(Boolean).join(' '));
  wrapper.append(list, note);
  let catalog = languageCatalog([], getLocale()), tags = [], selected = [], options = [], active = -1;
  let open = false, internal = false, disposed = false;
  const on = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  };
  const signal = () => {
    internal = true;
    try {
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    } finally { internal = false; }
  };
  const canonical = value => normalizeLanguageTag(value) || String(value).trim();
  function validity() {
    const pending = entry.value.trim();
    const valid = !pending || (multiple ? pending.split(',').every(value => normalizeLanguageTag(value)) : normalizeLanguageTag(pending));
    entry.setCustomValidity(valid ? '' : t('language.invalid'));
    return Boolean(valid);
  }
  function syncPending() {
    if (multiple) input.value = [...selected, ...(entry.value.trim() ? entry.value.split(',').map(canonical) : [])].join(', ');
    validity();
  }
  function updateNote() {
    const current = multiple ? input.value.split(',').map(value => value.trim()).filter(Boolean) : [input.value.trim()].filter(Boolean);
    const custom = current.filter(tag => normalizeLanguageTag(tag) && !catalog.some(item => item.tag === normalizeLanguageTag(tag)));
    note.textContent = custom.length ? t('language.customPackage', { tags: custom.join(', ') }) : t(multiple ? 'language.multipleHelp' : 'language.singleHelp');
    note.classList.toggle('language-custom', custom.length > 0);
    toggle.title = t('language.show'); toggle.setAttribute('aria-label', t('language.show'));
    if (multiple) entry.setAttribute('aria-label', t('language.add'));
  }
  function setActive(index) {
    active = index;
    for (const [i, node] of [...list.children].entries()) node.setAttribute('aria-selected', String(i === active));
    if (active >= 0 && list.children[active]) {
      entry.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView?.({ block: 'nearest' });
    } else entry.removeAttribute('aria-activedescendant');
  }
  function renderChoices({ all = false } = {}) {
    const query = all ? '' : entry.value.trim();
    options = filterLanguages(catalog, query, multiple ? selected : []);
    const custom = normalizeLanguageTag(query);
    if (custom && !catalog.some(item => item.tag === custom) && !selected.includes(custom)) {
      options.push({ tag: custom, name: t('language.custom', { tag: custom }), custom: true });
    }
    list.replaceChildren(...options.map((option, index) => {
      const node = document.createElement('div'); node.className = 'language-option';
      node.id = `${list.id}-${index}`; node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', 'false');
      node.textContent = option.custom ? option.name : `${option.tag} — ${option.name}`;
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => choose(option.tag));
      return node;
    }));
    if (!options.length) {
      const empty = document.createElement('div'); empty.className = 'language-empty';
      empty.textContent = t('language.noMatches'); list.append(empty);
    }
    setActive(-1); updateNote();
  }
  function show({ all = false } = {}) {
    if (entry.disabled || input.disabled || disposed) return;
    open = true; list.hidden = false;
    entry.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-expanded', 'true');
    renderChoices({ all });
  }
  function hide() {
    open = false; list.hidden = true; setActive(-1);
    entry.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-expanded', 'false');
  }
  function renderChips() {
    if (!multiple) return;
    chips.replaceChildren(...selected.map(tag => {
      const chip = document.createElement('span'); chip.className = 'language-tag';
      const label = document.createElement('span'); label.textContent = tag;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.dataset.icon = 'remove-item'; remove.dataset.iconOnly = 'true';
      remove.title = t('language.remove', { tag }); remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => {
        selected = selected.filter(value => value !== tag); syncPending(); renderChips(); signal();
        entry.focus(); show({ all: true });
      });
      chip.append(label, remove); return chip;
    }));
  }
  function choose(tag) {
    if (multiple) {
      if (!selected.includes(tag)) {
        if (selected.length >= 30) { entry.setCustomValidity(t('language.limit')); entry.reportValidity(); return; }
        selected.push(tag);
      }
      entry.value = ''; syncPending(); renderChips();
    } else { input.value = tag; validity(); }
    signal(); updateNote(); hide(); entry.focus();
  }
  function commit() {
    if (!entry.value.trim() || !validity()) return validity();
    if (!multiple) { input.value = canonical(input.value); signal(); updateNote(); return true; }
    const next = [...new Set([...selected, ...entry.value.split(',').map(canonical)])];
    if (next.length > 30) { entry.setCustomValidity(t('language.limit')); return false; }
    selected = next; entry.value = ''; syncPending(); renderChips(); signal(); updateNote(); return true;
  }
  function refresh() {
    if (disposed) return;
    catalog = languageCatalog(tags, getLocale());
    if (multiple) {
      selected = [...new Set(input.value.split(',').map(canonical).filter(Boolean))];
      entry.value = ''; renderChips();
    }
    validity(); updateNote();
    if (open) renderChoices({ all: true });
  }
  on(entry, 'focus', () => show({ all: true }));
  on(entry, 'input', () => {
    if (internal) return;
    syncPending();
    if (multiple) signal();
    show();
  });
  on(entry, 'keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show({ all: true });
      if (options.length) setActive(active < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      if (open || multiple || entry.value.trim()) {
        event.preventDefault();
        if (active >= 0 && options[active]) choose(options[active].tag);
        else if (commit()) hide(); else entry.reportValidity();
      }
    } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); hide(); }
    else if (multiple && event.key === ',' && entry.value.trim()) {
      event.preventDefault(); if (commit()) show({ all: true }); else entry.reportValidity();
    }
  });
  on(toggle, 'pointerdown', event => event.preventDefault());
  on(toggle, 'click', () => { if (open) hide(); else { entry.focus(); show({ all: true }); } });
  on(wrapper, 'focusout', event => {
    if (!wrapper.contains(event.relatedTarget)) { commit(); hide(); }
  });
  on(document, 'pointerdown', event => { if (!wrapper.contains(event.target)) { commit(); hide(); } });
  on(input, 'change', () => { if (!internal) refresh(); });
  const form = input.form || wrapper.closest('form');
  if (form) on(form, 'submit', event => {
    if (!commit()) { event.preventDefault(); event.stopImmediatePropagation(); entry.reportValidity(); }
  }, true);
  refresh();
  return {
    setCatalog(values) { tags = [...values]; refresh(); },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true; listeners.forEach(remove => remove());
      for (const label of labels) label.htmlFor = input.id;
      wrapper.before(input); wrapper.remove(); input.type = original.type; input.hidden = original.hidden;
      for (const [attribute, value] of [['list', original.list], ['pattern', original.pattern], ['autocomplete', original.autocomplete],
        ['role', original.role], ['aria-label', original.labelled], ['aria-describedby', original.described]]) {
        if (value === null) input.removeAttribute(attribute); else input.setAttribute(attribute, value);
      }
      for (const attribute of ['aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) input.removeAttribute(attribute);
      input.setCustomValidity('');
    },
  };
}
