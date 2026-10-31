const MAX_DRAFT_BYTES = 1024 * 1024;
const editableTypes = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'checkbox', 'radio']);
const editable = field => !field.disabled && (field.tagName === 'TEXTAREA' || field.tagName === 'SELECT' || (field.tagName === 'INPUT' && editableTypes.has(field.type)));
const fieldKey = field => JSON.stringify([field.name, field.tagName, field.type]);
const formSignature = form => JSON.stringify([...form.elements].filter(editable).map(fieldKey).sort());

// Adminer's pinned Jush editor links its contenteditable PRE to the backing
// textarea. Only follow that explicit relationship, never arbitrary editable UI.
function jushEditor(field) {
  if (field.tagName !== 'TEXTAREA') return null;
  return [...(field.ownerDocument?.querySelectorAll('pre.sqlarea[contenteditable="true"]') || [])]
    .find(editor => editor.jushTextarea === field) || null;
}
function fieldValue(field) {
  const editor = jushEditor(field);
  if (!editor || editor.innerHTML === editor.lastHTML) return field.value;
  // Jush defers highlighting to a timer. A detach click may arrive before it
  // syncs the final input to the textarea. Use the same text normalization as
  // pinned Jush, confined to this editor fragment (including hidden panels).
  const text = field.ownerDocument.createElement('pre');
  text.innerHTML = editor.innerHTML
    .replace(/<br>((<\/[^>]+>)*<\/?div>)(?!$)/gi, '$1')
    .replace(/^<br\b[^>]*>$/i, '').replace(/<(br|div)\b[^>]*>/gi, '\n')
    .replace(/&nbsp;(<\/[pP]\b)/g, '$1').replace(/<\/p\b[^>]*>($|<p\b[^>]*>)/gi, '\n')
    .replace(/(&nbsp;)+$/gm, '');
  return text.textContent.replace(/\u00a0/g, ' ');
}

/** Copy draft controls only; never copy credentials, CSRF tokens or file uploads. */
export function captureDatabaseView(doc, url) {
  if ([...doc.forms].some(form => [...form.elements].some(field => field.type === 'file' && field.files?.length))) {
    throw new Error('Complete or clear the selected database import file before moving the viewer to another window.');
  }
  const forms = [...doc.forms].map(form => {
    const occurrences = new Map();
    return { id: form.id || '', name: form.name || '', signature: formSignature(form), fields: [...form.elements].map(field => {
      if (!editable(field)) return null;
      const key = fieldKey(field), occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      return { name: field.name, tag: field.tagName, type: field.type, occurrence,
        value: field.tagName === 'SELECT' ? [...field.options].map(option => option.selected) : fieldValue(field),
        checked: Boolean(field.checked) };
    }).filter(Boolean) };
  });
  const snapshot = { url, forms, scroll: { x: doc.defaultView?.scrollX || 0, y: doc.defaultView?.scrollY || 0 } };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_DRAFT_BYTES) throw new Error('The database draft is too large to transfer to another window. Save or shorten it first.');
  return snapshot;
}

/** Restore a draft without submitting a form or running SQL. */
export function restoreDatabaseView(doc, snapshot) {
  snapshot?.forms?.forEach(saved => {
    // SQL POST results add export forms that are absent on the fresh GET used
    // during a window transfer. Match Adminer's stable form ID, then a unique
    // editable-field signature; neither form nor control indexes are stable.
    const forms = [...doc.forms].filter(form => saved.id ? form.id === saved.id
      : (form.name || '') === saved.name && formSignature(form) === saved.signature);
    if (forms.length !== 1) return;
    const form = forms[0];
    for (const value of saved.fields) {
      const field = [...form.elements].filter(field => editable(field) && field.name === value.name
        && field.tagName === value.tag && field.type === value.type)[value.occurrence];
      if (!field) continue;
      if (field.tagName === 'SELECT') [...field.options].forEach((option, index) => { option.selected = Boolean(value.value[index]); });
      else {
        field.value = value.value;
        const editor = jushEditor(field);
        if (editor) {
          editor.textContent = value.value;
          // Refresh syntax highlighting and Jush's own undo state. An input
          // event never submits the form or executes SQL.
          editor.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
        }
      }
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
    return fieldValue(field) !== field.defaultValue;
  }));
}
