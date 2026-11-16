import { renderMailHtml } from './preview.mjs';

export function formatMailAddresses(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(formatMailAddresses).filter(Boolean).join(', ');
  if (value.group) return `${value.name || ''}: ${formatMailAddresses(value.group)};`;
  return value.name && value.address ? `${value.name} <${value.address}>` : value.address || value.name || '';
}

export function downloadMail(entry, doc = globalThis.document) {
  const url = doc.defaultView.URL.createObjectURL(new Blob([entry.raw], { type: 'message/rfc822' }));
  const link = doc.createElement('a');
  link.href = url; link.download = `message-${String(entry.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.eml`;
  doc.body.append(link); link.click(); link.remove();
  doc.defaultView.setTimeout(() => doc.defaultView.URL.revokeObjectURL(url), 1000);
}

/** A read-only view of the owner mailbox. No request uses the PHP operation queue. */
export function createMailDialog({ mail, document: doc = globalThis.document, t, onClose = () => {} }) {
  let disposed = false, selected = null, view = 'text', entry = null, revision = 0, detailSignature;
  const rows = new Map(), tabs = new Map();
  function element(tag, className, key) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (key) { node.dataset.i18n = key; node.textContent = t(key); }
    return node;
  }
  function button(key, callback, className = 'button button-secondary') {
    const node = element('button', className, key); node.type = 'button';
    node.addEventListener('click', () => { void Promise.resolve().then(callback).catch(showError); });
    return node;
  }
  const dialog = element('dialog', 'rocket-dialog mail-dialog'); dialog.id = 'mail-dialog';
  dialog.setAttribute('aria-labelledby', 'mail-title');
  const heading = element('div', 'dialog-heading'), title = element('h2', '', 'mail.title'); title.id = 'mail-title';
  const close = button('action.close', () => dialog.close(), 'dialog-close');
  heading.append(title, close);
  const notice = element('p', 'mail-notice', 'mail.notice');
  const limits = element('p', 'field-help', 'mail.limits');
  const error = element('p', 'dialog-error mail-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const toolbar = element('div', 'mail-toolbar'), total = element('p', 'field-help'); total.setAttribute('role', 'status');
  const clear = button('mail.clear', async () => { await mail.clear(); await refresh(); }); clear.id = 'mail-clear';
  toolbar.append(total, clear);
  const split = element('div', 'mail-split'), list = element('div', 'mail-list'); list.setAttribute('role', 'group');
  list.dataset.i18nAriaLabel = 'mail.messages';
  list.setAttribute('aria-label', t('mail.messages'));
  const empty = element('p', 'mail-empty', 'mail.empty');
  const detail = element('section', 'mail-detail'); detail.setAttribute('aria-label', t('mail.message'));
  detail.dataset.i18nAriaLabel = 'mail.message';
  const subject = element('h3', 'mail-subject'), metadata = element('dl', 'mail-metadata');
  const parseError = element('p', 'dialog-error'); parseError.setAttribute('role', 'status');
  const attachments = element('p', 'field-help mail-attachments');
  const actions = element('div', 'mail-message-actions'), tablist = element('div', 'mail-tabs'); tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', t('mail.views'));
  tablist.dataset.i18nAriaLabel = 'mail.views';
  const panel = element('div', 'mail-body'); panel.id = 'mail-message-body'; panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
  for (const name of ['text', 'html', 'raw']) {
    const tab = button(`mail.${name}`, () => selectView(name), 'mail-tab');
    tab.id = `mail-tab-${name}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('keydown', event => {
      const choices = [...tabs.entries()].filter(([, node]) => !node.disabled);
      let index = choices.findIndex(([key]) => key === name);
      if (event.key === 'ArrowRight') index = (index + 1) % choices.length;
      else if (event.key === 'ArrowLeft') index = (index + choices.length - 1) % choices.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = choices.length - 1;
      else return;
      event.preventDefault(); selectView(choices[index][0]); choices[index][1].focus();
    });
    tabs.set(name, tab); tablist.append(tab);
  }
  const download = button('mail.download', () => { if (entry) downloadMail(entry, doc); }); download.id = 'mail-download';
  actions.append(tablist, download); detail.append(subject, metadata, parseError, attachments, actions, panel);
  split.append(list, detail); dialog.append(heading, notice, limits, error, toolbar, empty, split); doc.body.append(dialog);

  function showError(value) { if (!disposed) { error.textContent = value?.message || String(value); error.hidden = false; } }
  function date(value) {
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? String(value || '') : instant.toLocaleString();
  }
  function fallbackSubject(message) { return message.subject || t(message.parseStatus === 'pending' ? 'mail.parsing' : 'mail.noSubject'); }
  function selectView(name) { view = name; renderBody(); }
  function renderBody() {
    const scroll = panel.scrollTop;
    for (const [name, tab] of tabs) {
      tab.disabled = name === 'html' && !entry?.parsed?.html;
      tab.setAttribute('aria-selected', String(name === view)); tab.tabIndex = name === view ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `mail-tab-${view}`);
    if (!entry) { panel.replaceChildren(); return; }
    if (view === 'html' && entry.parsed?.html) {
      const frame = element('iframe', 'mail-html'); frame.title = t('mail.htmlPreview');
      renderMailHtml(frame, entry.parsed.html); panel.replaceChildren(frame);
    } else {
      const pre = element('pre', 'mail-source');
      pre.textContent = view === 'raw' ? new TextDecoder().decode(entry.raw)
        : entry.parsed?.text ?? t(entry.parseStatus === 'pending' ? 'mail.parsing' : 'mail.noText');
      panel.replaceChildren(pre);
    }
    panel.scrollTop = scroll;
  }
  function renderDetail(message) {
    const signature = JSON.stringify([message.id, message.parseStatus, message.parseError]);
    entry = message; detail.hidden = false;
    if (signature === detailSignature) return;
    detailSignature = signature;
    subject.textContent = fallbackSubject(message); metadata.replaceChildren();
    const fields = [['mail.from', formatMailAddresses(message.parsed?.from)], ['mail.to', formatMailAddresses(message.parsed?.to)],
      ['mail.cc', formatMailAddresses(message.parsed?.cc)], ['mail.bcc', formatMailAddresses(message.parsed?.bcc)],
      ['mail.received', date(message.receivedAt)], ['mail.envelopeSender', message.envelopeSender],
      ['mail.envelopeRecipients', message.envelopeRecipients?.join(', ')]];
    for (const [key, value] of fields) if (value) {
      const term = element('dt', '', key), description = element('dd'); description.textContent = value; metadata.append(term, description);
    }
    parseError.hidden = message.parseStatus !== 'error';
    parseError.textContent = message.parseStatus === 'error' ? t('mail.parseError', { message: message.parseError || '' }) : '';
    const files = message.parsed?.attachments || [];
    attachments.hidden = !files.length;
    attachments.textContent = t('mail.attachments', { count: files.length }) + ' ' + files.map(file => file.filename || file.mimeType).join(', ');
    if (view === 'html' && !message.parsed?.html) view = 'text';
    renderBody();
  }
  async function refresh() {
    if (disposed || !dialog.open) return;
    const request = ++revision, version = mail.state.version;
    const messages = await mail.list();
    if (disposed || request !== revision || mail.state.version !== version) return;
    error.hidden = !mail.state.error; error.textContent = mail.state.error || '';
    total.textContent = t('mail.count', { count: messages.length }); clear.disabled = !messages.length && !mail.state.error;
    empty.hidden = messages.length > 0; split.hidden = messages.length === 0;
    const listScroll = list.scrollTop;
    const ids = new Set(messages.map(message => message.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
    if (!ids.has(selected)) { selected = messages[0]?.id ?? null; view = 'text'; detailSignature = null; panel.scrollTop = 0; }
    for (const [index, message] of messages.entries()) {
      let row = rows.get(message.id);
      if (!row) {
        row = button('mail.noSubject', async () => {
          if (selected !== message.id) { selected = message.id; view = 'text'; detailSignature = null; panel.scrollTop = 0; }
          await refresh();
        }, 'mail-row');
        row.removeAttribute('data-i18n'); row.dataset.mailId = message.id;
        row.replaceChildren(element('strong'), element('span'), element('small')); rows.set(message.id, row);
      }
      row.children[0].textContent = fallbackSubject(message);
      row.children[1].textContent = formatMailAddresses(message.from) || t('mail.unknownSender');
      row.children[2].textContent = date(message.receivedAt);
      row.setAttribute('aria-pressed', String(message.id === selected));
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    list.scrollTop = listScroll;
    if (!selected) { entry = null; detail.hidden = true; panel.replaceChildren(); return; }
    const message = await mail.get(selected);
    if (disposed || request !== revision || version !== mail.state.version || message?.id !== selected) return;
    if (message) renderDetail(message);
  }
  const unsubscribe = mail.subscribe(state => {
    if (state.closed) { dialog.close(); return; }
    void refresh().catch(showError);
  });
  const translate = () => { detailSignature = null; void refresh().catch(showError); };
  doc.addEventListener('rocket:languagechange', translate);
  dialog.addEventListener('close', () => { revision++; if (!disposed) onClose(); });
  return {
    get open() { return dialog.open; },
    async show() { if (disposed) return; if (!dialog.open) dialog.showModal(); await refresh(); },
    hide() { dialog.close(); },
    dispose() { if (disposed) return; disposed = true; revision++; unsubscribe(); doc.removeEventListener('rocket:languagechange', translate); dialog.close(); dialog.remove(); },
  };
}

/** Bind the toolbar to whichever owner (or companion owner) is currently active. */
export function createMailController({ button, badge, t, onError = () => {} }) {
  let mail, identity, unsubscribe, dialog;
  const doc = button.ownerDocument;
  function update() {
    const state = mail?.state, count = state?.count || 0;
    badge.textContent = String(count); badge.hidden = count === 0;
    button.disabled = !mail || Boolean(state?.closed);
    button.setAttribute('aria-label', t('mail.countLabel', { count }));
    button.title = t('mail.open');
  }
  const open = () => {
    if (!mail || button.disabled) return;
    dialog ||= createMailDialog({ mail, document: doc, t, onClose: () => button.setAttribute('aria-expanded', 'false') });
    if (dialog.open) dialog.hide();
    else { button.setAttribute('aria-expanded', 'true'); void dialog.show().catch(onError); }
  };
  button.addEventListener('click', open); doc.addEventListener('rocket:languagechange', update); update();
  return {
    bind(next, ownerIdentity) {
      if (next === mail && ownerIdentity === identity) { update(); return; }
      unsubscribe?.(); dialog?.dispose(); dialog = undefined; mail = next; identity = ownerIdentity;
      button.setAttribute('aria-expanded', 'false');
      unsubscribe = mail?.subscribe(update); update();
    },
    dispose() { unsubscribe?.(); dialog?.dispose(); button.removeEventListener('click', open); doc.removeEventListener('rocket:languagechange', update); },
  };
}
