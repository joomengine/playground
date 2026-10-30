import { ACTION_ICONS } from './icon-data.mjs';

export const ICON_IDS = Object.freeze([...Object.keys(ACTION_ICONS), 'deployment', 'launch']);
const branded = new Set(['deployment', 'launch']);
const iconsURL = new URL('./brand/rocket.svg', import.meta.url).href;
const idMapping = Object.freeze({
  'deploy-editor-button': 'deployment', 'nav-site': 'site', 'nav-admin': 'admin',
  'save-button': 'save-site', 'share-button': 'share-site', 'code-button': 'code', 'code-refresh-button': 'refresh-site',
  'download-dialog-button': 'download-site', 'settings-toggle': 'dashboard-toggle',
  'new-site-button': 'new-site', 'restart-button': 'restart-site', 'close-button': 'close-site',
  'credentials-button': 'login-details', 'php-settings-button': 'php-settings', 'reset-button': 'reset-site',
  'launch-button': 'launch', 'embedded-launch': 'launch', 'use-deploy': 'deployment',
  'stop-countdown': 'stop-countdown', 'stop-countdown-button': 'stop-countdown',
  'rename-site': 'rename-site', 'rename-site-button': 'rename-site', 'delete-site': 'delete-site', 'delete-site-button': 'delete-site',
  'focus-header-button': 'hide-chrome', 'focus-footer-button': 'hide-chrome',
  'focus-restore-top': 'restore-top', 'focus-restore-bottom': 'restore-bottom',
  'activity-toggle': 'activity', 'log-toggle': 'activity', 'information-button': 'about', 'welcome-configure': 'deployment',
  'editor-runtime-button': 'workspace-layout', 'show-password': 'show-password', 'reset-php': 'recommended-settings', 'php-apply-button': 'apply',
  'apply-deploy': 'apply', 'copy-share': 'copy', 'copy-credentials': 'copy', 'go-administrator': 'open-administrator',
  'reveal-credentials': 'show-password', 'native-share': 'share-site', 'share-export-config': 'export-configuration',
  'export-button': 'download-site', 'retry-button': 'retry', 'recover-button': 'recover-site',
  'repair-button': 'recommended-settings', 'error-reset-button': 'reset-site', 'error-configure': 'deployment',
  'add-package': 'add-item', 'add-menu': 'add-item', 'import-config': 'import-configuration', 'export-config': 'export-configuration',
});
const keyMapping = Object.freeze({
  'action.fork': 'fork', 'action.star': 'star', 'action.source': 'view-source', 'action.licenses': 'licenses',
  'action.add': 'add-item', 'action.remove': 'remove-item', 'action.apply': 'apply', 'action.cancel': 'cancel',
  'action.copy': 'copy', 'action.show': 'show-password', 'action.hide': 'hide-password',
  'action.import': 'import-configuration', 'action.export': 'export-configuration',
  'action.guide': 'deployment-guide', 'title.advanced': 'workspace-layout', 'action.deploymentGuide': 'deployment-guide', 'action.about': 'about',
  'code.ai': 'ai-assistant', 'code.aiAssistant': 'ai-assistant', 'code.accounts': 'accounts',
  'code.saveAll': 'save-all', 'code.refresh': 'refresh-site', 'code.clearCache': 'clear-cache', 'code.cacheClear': 'clear-cache', 'code.debugRefresh': 'debug-refresh',
  'code.debugArm': 'arm-php', 'code.retry': 'retry', 'code.armPhp': 'arm-php', 'code.detach': 'detach', 'code.return': 'redock', 'code.hide': 'hide-editor',
  'code.maximize': 'full-workspace', 'code.restore': 'restore-workspace',
  'code.files.upload': 'upload-files', 'code.files.download': 'download-file', 'code.files.preview': 'preview-image',
  'code.files.history': 'file-recovery', 'code.files.close': 'cancel', 'code.files.choose': 'upload-files',
  'code.files.open': 'open-file', 'code.files.restore': 'restore-snapshot',
});
const themedFields = new WeakSet();
const alwaysIconOnly = new Set(['fork', 'star', 'ai-assistant', 'dashboard-toggle', 'hide-chrome', 'restore-top', 'restore-bottom']);

/** Trusted, bundled artwork only. Credentials/user content never enter this markup. */
export function iconMarkup(actionId) {
  const value = ACTION_ICONS[actionId];
  if (!value) throw new TypeError(`Unknown monochrome icon action: ${actionId}`);
  return value.replace('<svg ', '<svg class="je-icon" aria-hidden="true" focusable="false" ');
}
export function createIcon(actionId, doc = globalThis.document) {
  if (!doc) throw new TypeError('Icons need an owning document.');
  if (branded.has(actionId)) {
    const icon = doc.createElement('img'); icon.src = iconsURL; icon.alt = '';
    icon.className = 'je-icon je-brand-icon rocket-icon'; icon.width = 24; icon.height = 24;
    icon.setAttribute('aria-hidden', 'true'); return icon;
  }
  const template = doc.createElement('template'); template.innerHTML = iconMarkup(actionId);
  return template.content.firstElementChild;
}
/** Keep the existing button node, handlers, focus and translatable label intact. */
export function decorateAction(button, actionId, { iconOnly = alwaysIconOnly.has(actionId) || button?.dataset?.iconOnly === 'true' } = {}) {
  if (!button?.ownerDocument || (!ACTION_ICONS[actionId] && !branded.has(actionId))) return button;
  const doc = button.ownerDocument;
  const key = button.getAttribute('data-i18n');
  let label = [...button.children].find(node => node.classList.contains('je-action-label'));
  if (!label) {
    for (const node of [...button.children]) {
      if (node.matches('svg,img.rocket-icon,span[aria-hidden="true"]')) node.remove();
    }
    label = [...button.children].find(node => node.hasAttribute('data-i18n'));
    if (!label) {
      label = doc.createElement('span');
      label.append(...button.childNodes); button.append(label);
    }
    label.classList.add('je-action-label');
  }
  if (key) {
    label.setAttribute('data-i18n', key); button.removeAttribute('data-i18n');
    if (!button.hasAttribute('data-i18n-title')) button.setAttribute('data-i18n-title', key);
    if (!button.hasAttribute('data-i18n-aria-label')) button.setAttribute('data-i18n-aria-label', key);
  }
  const name = label.textContent?.trim();
  if (name && !button.getAttribute('aria-label')) button.setAttribute('aria-label', name);
  if (name && !button.getAttribute('title')) button.title = name;
  const existing = [...button.children].find(node => node.classList.contains('je-icon'));
  if (button.dataset.icon !== actionId || !existing) {
    existing?.remove(); button.prepend(createIcon(actionId, doc));
  }
  button.dataset.icon = actionId;
  button.classList.add('je-action');
  button.classList.toggle('je-icon-only', iconOnly);
  return button;
}
export function decorateIcons(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const nodes = [...root.querySelectorAll('button,a,summary')];
  if (root.matches?.('button,a,summary')) nodes.unshift(root);
  for (const button of nodes) {
    const key = button.getAttribute('data-i18n') || button.getAttribute('data-i18n-title') || button.getAttribute('data-i18n-aria-label');
    const changingIcon = ['action.show', 'action.hide', 'code.maximize', 'code.restore'].includes(key) ? keyMapping[key] : null;
    const action = changingIcon || button.dataset.icon || idMapping[button.id] || keyMapping[key] || (button.hasAttribute('data-close-dialog') ? 'cancel' : null);
    if (action) decorateAction(button, action, button.hasAttribute('data-close-dialog') ? { iconOnly: true } : undefined);
  }
  const theme = root.querySelector('#theme-preference');
  if (theme && !themedFields.has(theme)) {
    themedFields.add(theme);
    const refresh = () => {
      const parent = theme.parentElement;
      parent.querySelector('.je-theme-icon')?.remove();
      const icon = createIcon(`theme-${['system', 'light', 'dark'].includes(theme.value) ? theme.value : 'system'}`, theme.ownerDocument);
      icon.classList.add('je-theme-icon'); parent.insertBefore(icon, theme);
    };
    theme.addEventListener('change', refresh);
    theme.ownerDocument.addEventListener('joomengine:themechange', refresh);
    refresh();
  }
}
/** One observer per mounted surface; useful for dynamic dialogs and translations. */
export function observeIcons(root = globalThis.document) {
  decorateIcons(root);
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const Observer = doc?.defaultView?.MutationObserver;
  if (!Observer) return () => {};
  let pending = false;
  const observer = new Observer(records => {
    if (pending || !records.some(record => record.type === 'childList')) return;
    pending = true;
    queueMicrotask(() => { pending = false; observer.disconnect(); decorateIcons(root); observer.observe(root, { childList: true, subtree: true }); });
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
