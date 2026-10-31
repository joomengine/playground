const MAX_DRAFT_BYTES = 1024 * 1024;
const editableTypes = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'checkbox', 'radio']);
const editable = field => !field.disabled && (field.tagName === 'TEXTAREA' || field.tagName === 'SELECT' || (field.tagName === 'INPUT' && editableTypes.has(field.type)));

/** Copy draft controls only; never copy credentials, CSRF tokens or file uploads. */
export function captureDatabaseView(doc, url) {
  if ([...doc.forms].some(form => [...form.elements].some(field => field.type === 'file' && field.files?.length))) {
    throw new Error('Complete or clear the selected database import file before moving the viewer to another window.');
  }
  const forms = [...doc.forms].map(form => [...form.elements].map((field, index) => {
    if (!editable(field)) return null;
    return { index, name: field.name, tag: field.tagName, type: field.type,
      value: field.tagName === 'SELECT' ? [...field.options].map(option => option.selected) : field.value,
      checked: Boolean(field.checked) };
  }).filter(Boolean));
  const snapshot = { url, forms, scroll: { x: doc.defaultView?.scrollX || 0, y: doc.defaultView?.scrollY || 0 } };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_DRAFT_BYTES) throw new Error('The database draft is too large to transfer to another window. Save or shorten it first.');
  return snapshot;
}

/** Restore a draft without submitting a form or running SQL. */
export function restoreDatabaseView(doc, snapshot) {
  snapshot?.forms?.forEach((saved, formIndex) => {
    const form = doc.forms[formIndex];
    if (!form) return;
    for (const value of saved) {
      const field = form.elements[value.index];
      if (!field || !editable(field) || field.name !== value.name || field.tagName !== value.tag || field.type !== value.type) continue;
      if (field.tagName === 'SELECT') [...field.options].forEach((option, index) => { option.selected = Boolean(value.value[index]); });
      else field.value = value.value;
      if (field.type === 'checkbox' || field.type === 'radio') field.checked = value.checked;
    }
  });
  doc.defaultView?.scrollTo(snapshot?.scroll?.x || 0, snapshot?.scroll?.y || 0);
}

export function hasDatabaseDraft(doc) {
  return [...(doc?.forms || [])].some(form => [...form.elements].some(field => {
    if (field.type === 'file') return Boolean(field.files?.length);
    if (!editable(field)) return false;
    if (field.tagName === 'SELECT') {
      const options = [...field.options];
      const declared = options.some(option => option.defaultSelected);
      return options.some((option, index) => option.selected !== (option.defaultSelected || (!field.multiple && !declared && index === 0)));
    }
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
    return field.value !== field.defaultValue;
  }));
}
