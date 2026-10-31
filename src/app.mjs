import { resolveSiteURL, createShareURL, createDeploymentDocument, parseDeploymentDocument, loadDeploymentDocument, normalizeConfiguration, parseCatalog, readURLConfiguration, catalogWithSelectedJoomlaPackage, resolveJoomlaVersion } from './config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from './deploys.mjs';
import { createPlayground, prepareEnvironment, resetPlayground } from './playground.mjs';
import { customSetupDetails, defaultSiteKey, forgetSite, isolateSetup, publicConfiguration, readSavedState, rememberSite, rememberSiteRoute, renameSavedSite, safeSavedRoute, resolveResumePath, runtimeLocation, savedStateKey } from './ui-state.mjs';

import { initializeTheme, setTheme, getThemeState } from './theme.mjs';
import { observeIcons, decorateAction } from './icons.mjs';
import { createLanguageSelector } from './language-selector.mjs';

import { connectFrame } from './frame-view.mjs';
import { DEFAULT_PHP_SETTINGS, normalizePhpSettings } from './php-settings.mjs';
import { UI_LANGUAGES, getLocale, initializeLocale, setLocale, t } from './i18n.mjs';
import { createLaunchCountdown, deploymentNeedsReview } from './launch-countdown.mjs';
import { presentError } from './error-presentation.mjs';
import { createExtensionInputs } from './extension-inputs.mjs';
import { initialJcbSelection, jcbSelectionInput, pinnedJcbPackages } from './jcb-selection.mjs';
import { loadVersionCatalog, withoutCatalogPackages } from './version-catalog.mjs';
import { dynamicJoomlaChoices, matchingJcbChoices } from './dynamic-selection.mjs';
import { selectCatalogPackage } from './dynamic-packages.mjs';

const $ = (id) => document.getElementById(id);
const deploymentURL = new URL('../', import.meta.url).href;
const preferenceKey = savedStateKey(deploymentURL);
const fields = {
  deployId: $('deploy'), phpVersion: $('php-version'), joomlaVersion: $('joomla-version'), jcbVersion: $('jcb-version'),
  language: $('language'), siteName: $('site-name'), initialPath: $('initial-path'), storageKey: $('storage-key'),
  persistence: $('persistence'), autoLogin: $('auto-login'), extensions: $('extensions'), startupCommands: $('startup-commands'),
};
const controls = ['save-button', 'restart-button', 'close-button', 'reset-button', 'share-button', 'export-button', 'export-format', 'code-button', 'code-refresh-button'];
const drafts = new Map();
let catalog, deployCatalog, runtime, currentConfig, currentInput;
let busy = false;
let launching = false;
let selectedSiteId = null;
let savedSiteNameDraft = null;
let runningSiteId = null;
let runningAdministrator = null;
let previewDirty = false;
let languageSelector, deploymentLanguageSelector;
let initialized = false;
let disconnectFrame = () => {};
let phpSettings = { ...DEFAULT_PHP_SETTINGS };
let lastSavedAt;
let feedbackTimer;
let sharedConfiguration;
let templateOptions = {};
let extraDeploymentFields = {};
let currentSitePath = '/';
let closing = false;
let selectedProfile;
let hideToolbar = false;
let initialFocusChoice;
let pendingFresh = false;
let resumeLastRoute = true;
let freshKeyPending = false;
let automaticLaunchPaused = false;
let approvedCustomSetup;
let codeHost;
let openingCode;
let extensionInputs;
let pinnedJcb = new Map();
const selectedJoomlaPackages = new Map();
let refreshNightlyOnNextLaunch = false;
let pinnedCatalog;
let dynamicMetadata = { joomla: [], jcb: [], errors: [] };
let dynamicCatalogRequest;
let dynamicCatalogUpdatedAt = 0;
let dynamicChoicesPending = false;
const catalogRefreshInterval = 5 * 60_000;
let currentDeployRecipe;
let jcbSelection = { version: 'none', omit: true };
const launchCountdown = createLaunchCountdown({
  onTick(seconds) {
    $('launch-countdown').hidden = $('dashboard-countdown').hidden = false;
    for (const prefix of ['', 'dashboard-']) {
      $(`${prefix}countdown-value`).textContent = String(seconds);
      $(`${prefix}countdown-message`).textContent = t('status.countdown', { seconds });
    }
    $('stop-countdown').disabled = $('stop-countdown-button').disabled = false;
  },
  onLaunch: () => launch(),
});
let preferences;
try { preferences = localStorage; } catch { /* A temporary site can run without preference storage. */ }
let savedState = readSavedState(preferences, preferenceKey);

function password() {
  return `Jp!${Array.from(crypto.getRandomValues(new Uint8Array(18)), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}
function messageOf(value) {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of [$('admin-password').value, runningAdministrator?.password]) {
    if (secret) text = text.split(secret).join('[password]');
  }
  return text;
}
function activity(message) {
  const text = messageOf(message);
  $('status-message').textContent = text;
  const entry = document.createElement('li');
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.append(time, document.createTextNode(text));
  const log = $('activity-log');
  log.append(entry);
  while (log.childElementCount > 150) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}
function show(view) {
  for (const name of ['welcome', 'loading-view', 'error-view', 'site-mount']) $(name).hidden = name !== view;
  document.querySelector('.preview-panel').classList.toggle('launching', view === 'loading-view');
  const video = $('launch-video');
  if (view === 'loading-view' && !matchMedia('(prefers-reduced-motion: reduce)').matches) video.play().catch(() => {});
  else video.pause();
}
function feedback(message, { error = false, persistent = false } = {}) {
  clearTimeout(feedbackTimer);
  const node = $('header-feedback');
  node.textContent = messageOf(message); node.dataset.error = String(error); node.hidden = false;
  if (!persistent) feedbackTimer = setTimeout(() => { node.hidden = true; }, 7000);
}
function clearFeedback() {
  clearTimeout(feedbackTimer);
  $('header-feedback').hidden = true;
  $('header-feedback').textContent = '';
}
function pauseAutomaticLaunch() {
  automaticLaunchPaused = true;
  if (!launchCountdown.active) return;
  launchCountdown.stop();
  $('launch-countdown').hidden = true;
  $('dashboard-countdown-message').textContent = t('status.countdownPaused');
  $('stop-countdown-button').disabled = true;
  activity(t('status.countdownPaused'));
}
function customReviewInput(input) {
  return withoutCatalogPackages(input, {
    joomla: dynamicJoomlaChoices(pinnedCatalog, dynamicMetadata.joomla),
    jcb: [...dynamicMetadata.jcb, ...[...pinnedJcb.values()].map(entry => ({ version: entry.version, ...entry.package }))],
  });
}
function approveCustomSetup(input) {
  if (!deploymentNeedsReview(customReviewInput(input))) return true;
  const custom = customSetupDetails(input);
  const identity = JSON.stringify(custom);
  if (identity === approvedCustomSetup) return true;
  if (!confirm(`${t('confirm.customSetup')}\n\n${JSON.stringify(custom, null, 2)}`)) return false;
  approvedCustomSetup = identity;
  return true;
}
function openDialog(id) {
  pauseAutomaticLaunch();
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function setDrawer(open) {
  if (open) { pauseAutomaticLaunch(); void refreshDynamicCatalog(); }
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  updateDrawerLabels();
}
function updateDrawerLabels() {
  const key = $('settings').hidden ? 'action.expand' : 'action.collapse';
  for (const attribute of ['title', 'aria-label']) {
    $('settings-toggle').setAttribute(`data-i18n-${attribute}`, key);
    $('settings-toggle').setAttribute(attribute, t(key));
  }
}
function setFocusMode(hidden, { focus = false, edge = 'top' } = {}) {
  // Asynchronous startup configuration must retain an explicit hide/restore action.
  if (!initialized) {
    if (focus) initialFocusChoice = Boolean(hidden);
    else if (initialFocusChoice !== undefined) hidden = initialFocusChoice;
  }
  const frame = $('site-frame');
  const previousTop = frame ? frame.getBoundingClientRect().top + window.scrollY : 0;
  const previousScroll = window.scrollY;
  hideToolbar = Boolean(hidden);
  document.body.classList.toggle('embedded', hideToolbar);
  for (const id of ['focus-header-button', 'focus-footer-button']) $(id).setAttribute('aria-expanded', String(!hideToolbar));
  for (const id of ['focus-restore-top', 'focus-restore-bottom']) {
    $(id).hidden = !hideToolbar;
    $(id).setAttribute('aria-expanded', String(!hideToolbar));
  }
  // Only the surrounding controls change: keep the live frame and its document.
  // Notify its layout observer and keep the same site content in view.
  window.dispatchEvent(new Event('resize'));
  if (frame && hidden) {
    const nextTop = frame.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, previousScroll + nextTop - previousTop), behavior: 'instant' });
  }
  if (focus) {
    const target = hidden ? `focus-restore-${edge}` : `focus-${edge === 'top' ? 'header' : 'footer'}-button`;
    $(target).focus({ preventScroll: true });
    if (!hidden) requestAnimationFrame(() => requestAnimationFrame(() => {
      const area = $(edge === 'bottom' ? 'site-footer' : 'site-header');
      area.scrollIntoView({ block: edge === 'bottom' ? 'end' : 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      $(target).focus({ preventScroll: true });
    }));
  }
}
function updateSaveState() {
  $('save-state').textContent = runtime ? currentConfig?.persistence
    ? lastSavedAt ? t('status.savedAt', { time: lastSavedAt.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) }) : t('status.saved')
    : t('status.temporary') : t('help.local');
}

function destroyPreview() {
  disconnectFrame();
  // Removing the old document avoids both late requests and transitions to a blank page.
  $('site-mount').replaceChildren();
  $('site-mount').hidden = true;
}
function updateRuntimeLocation() {
  if (!runtime || !currentInput) return;
  history.replaceState(null, '', runtimeLocation(location.href, { ...currentInput, initialPath: safeSavedRoute(currentSitePath, currentInput.initialPath) }));
}
function updateNavigation() {
  const available = Boolean(runtime?.healthy && !runtime?.recovery && !busy && !launching);
  const admin = /^\/administrator(?:\/|[?#]|$)/.test(currentSitePath);
  for (const [id, active] of [['nav-site', !admin], ['nav-admin', admin]]) {
    $(id).disabled = !available;
    $(id).setAttribute('aria-pressed', String(available && active));
  }
}
function navigatePreview(path) {
  if (busy || !runtime?.healthy || runtime?.recovery) return;
  const frame = $('site-frame');
  if (!frame) return;
  // Native navigation preserves Joomla's beforeunload checks and the runtime.
  frame.contentWindow.location.assign(resolveSiteURL(path, runtime.baseUrl));
}
function mountPreview(url) {
  const frame = document.createElement('iframe');
  frame.id = 'site-frame';
  frame.title = t('a11y.site');
  frame.referrerPolicy = 'same-origin';
  // Set the destination before attachment so a newly inserted blank document is never reused.
  frame.src = url;
  previewDirty = false;
  frame.addEventListener('load', () => {
    previewDirty = false;
    try {
      const markDirty = event => { if (event.isTrusted && event.target.closest('form')) previewDirty = true; };
      frame.contentDocument.addEventListener('input', markDirty, { capture: true });
      frame.contentDocument.addEventListener('change', markDirty, { capture: true });
    } catch { /* The browser owns cross-origin form navigation checks. */ }
  });
  disconnectFrame();
  disconnectFrame = connectFrame(frame, { onNavigate: ({ url, signedOut }) => {
    if (runtime && url.startsWith(runtime.baseUrl)) {
      currentSitePath = `/${url.slice(runtime.baseUrl.length)}`;
      if (runningSiteId && currentConfig.persistence) {
        const next = rememberSiteRoute(savedState, runningSiteId, currentSitePath);
        if (next !== savedState) { savedState = next; writePreferences({ render: false }); }
        updateRuntimeLocation();
      }
      updateNavigation();
    }
    $('credentials-button').dataset.signedOut = String(signedOut);
    $('credentials-button').textContent = `${t('title.credentials')}${signedOut ? ` · ${t('status.signedOut')}` : ''}`;
  } });
  $('site-mount').replaceChildren(frame);
  show('site-mount');
}
async function openCode() {
  if (busy || !runtime || openingCode) return;
  const owner = runtime;
  openingCode = (async () => {
    if (!codeHost || codeHost.closed) {
      const { createCodeHost } = await import('./code/host.mjs');
      if (runtime !== owner || owner.closed) return;
      codeHost = await createCodeHost({
        runtime: owner, host: document.querySelector('.workspace'), preview: document.querySelector('.preview-panel'),
        t, storage: preferences,
        getPreviewURL: () => resolveSiteURL(currentSitePath, runtime?.baseUrl || owner.baseUrl),
        refreshSite() {
          if (!runtime?.healthy) throw new Error('Open the active Joomla site before refreshing.');
          // currentSitePath follows Joomla navigation. Refresh never restarts PHP,
          // reuses the launch URL, or implicitly saves an editor buffer.
          mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
        },
        onError: error => feedback(error, { error: true, persistent: true }),
        onState(state) {
          $('code-refresh-button').hidden = Boolean(state.closed);
          $('code-button').setAttribute('aria-expanded', String(Boolean(state.visible)));
          const toggleLabel = state.visible ? 'code.hide' : 'code.open';
          for (const attribute of ['title', 'aria-label']) {
            $('code-button').setAttribute(`data-i18n-${attribute}`, toggleLabel);
            $('code-button').setAttribute(attribute, t(toggleLabel));
          }
          $('code-refresh-button').dataset.changed = String(Boolean(state.savedChanges));
          $('code-refresh-button').title = t(state.savedChanges ? 'code.savedChanges' : 'code.refresh');
        },
      });
      // A new host exposes its shell before the native workbench has mounted.
      // Its first activation must mount/open; later clicks toggle that session.
      await codeHost.open();
    } else await codeHost.toggle();
  })();
  $('code-button').disabled = true;
  try { await openingCode; }
  catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { openingCode = undefined; setBusy(busy); }
}
function updateMcpPreview() {
  $('deploy-mcp-preview').hidden = fields.deployId.value !== 'jcb-mcp';
  $('credentials-mcp-preview').hidden = !runtime || !(runtime.installation?.mcp || runtime.installation?.deployId === 'jcb-mcp');
}
function setBusy(value) {
  busy = value;
  const locked = busy || launching;
  const unavailable = !initialized || !catalog || !deployCatalog;
  if (!locked && !unavailable && dynamicChoicesPending) renderDynamicChoices();
  const filesOnly = Boolean(runtime?.recovery?.filesOnly);
  $('configuration-fields').disabled = locked || unavailable;
  $('installation-fields').disabled = locked || unavailable;
  fields.persistence.disabled = locked || unavailable;
  fields.phpVersion.disabled = locked || unavailable;
  fields.jcbVersion.disabled = locked || unavailable;
  const targetRunning = Boolean(runtime && fields.storageKey.value === currentConfig?.storageKey && fields.persistence.checked === currentConfig?.persistence);
  $('launch-button').disabled = locked || unavailable;
  $('embedded-launch').disabled = locked || unavailable;
  $('retry-button').disabled = locked || unavailable;
  $('recover-button').disabled = locked || unavailable || !fields.persistence.checked;
  $('repair-button').hidden = filesOnly || !runtime?.recovery?.configured;
  $('repair-button').disabled = locked || filesOnly;
  $('error-reset-button').disabled = locked || unavailable || !fields.persistence.checked;
  $('new-site-button').disabled = locked || unavailable;
  $('saved-site').disabled = locked || unavailable || Object.keys(savedState.sites).length === 0;
  for (const id of ['saved-site-name', 'rename-site-button', 'delete-site-button']) $(id).disabled = locked || !selectedSiteId || !Object.hasOwn(savedState.sites, selectedSiteId);
  updateNavigation();
  for (const id of controls) $(id).disabled = locked || !runtime;
  $('share-button').disabled = locked || unavailable;
  $('reset-button').disabled = locked || (!runtime && (unavailable || !fields.persistence.checked));
  $('save-button').disabled = locked || !runtime || filesOnly;
  $('restart-button').disabled = locked || !runtime || filesOnly;
  $('download-dialog-button').disabled = locked || !runtime;
  const recoveryFormat = $('export-format').querySelector('[value="recovery"]');
  recoveryFormat.hidden = !runtime?.recovery;
  recoveryFormat.disabled = !runtime?.recovery;
  for (const option of $('export-format').options) {
    if (option.value !== 'recovery') { option.hidden = filesOnly; option.disabled = filesOnly; }
  }
  if (filesOnly || (runtime?.recovery && !runtime.recovery.configured)) $('export-format').value = 'recovery';
  else if (!runtime?.recovery && $('export-format').value === 'recovery') $('export-format').value = 'bundle';
  $('recovery-files-notice').hidden = !filesOnly;
  $('download-files-notice').hidden = !filesOnly;
  $('download-help').hidden = filesOnly;
  $('credentials-button').disabled = locked || !runtime || Boolean(runtime.recovery);
  $('php-settings-button').disabled = locked || unavailable || filesOnly;
  $('use-deploy').disabled = locked || unavailable;
  $('apply-deploy').disabled = locked || !runtime || Boolean(runtime.recovery);
  $('preview-dot').className = `status-dot${locked ? ' busy' : runtime ? '' : ' muted'}`;
  $('launch-button').querySelector('span').textContent = t(locked ? 'status.working' : targetRunning ? 'action.openRunning' : 'action.launch');
  $('launch-hint').textContent = t('help.firstLaunch');
  $('storage-note').textContent = t(fields.persistence.checked ? 'help.storage' : 'help.temporary');
  document.body.classList.toggle('running', Boolean(runtime));
  $('preview-label').textContent = runtime && currentConfig ? savedState.sites[runningSiteId]?.displayName || currentConfig.siteName : t('title.site');
  $('running-site-note').textContent = runtime ? t('status.runningSite', { name: savedState.sites[runningSiteId]?.displayName || currentConfig.siteName }) : t('status.noRunningSite');
  updateSaveState();
  updateMcpPreview();
}
function progress(event) {
  const details = typeof event === 'string' ? { message: event } : event;
  const rawMessage = details?.message || details?.phase || 'Preparing the playground…';
  const message = details?.phase === 'warning' ? presentError(new Error(rawMessage), {
    secrets: [$('admin-password').value, runningAdministrator?.password], fallback: 'PHP reported diagnostic output. Check the browser console for details.',
  }).summary : rawMessage;
  if (details?.phase === 'failed' && runtime && !closing && !busy) {
    destroyPreview();
    displayError(new Error(message));
    return;
  }
  const phaseKeys = { assets: 'status.loadingCatalog', database: 'status.startingDatabase', php: 'status.startingPhp', install: 'status.installingJoomla', extensions: 'status.installingExtensions', configure: 'status.configuringSite', saving: 'status.saving', ready: 'status.openingSite', download: 'status.loading' };
  $('loading-title').textContent = t(phaseKeys[details?.phase] || 'title.loading');
  $('loading-message').textContent = messageOf(message);
  if (typeof details?.progress === 'number' && Number.isFinite(details.progress)) {
    $('loading-progress').max = 1;
    $('loading-progress').value = Math.max(0, Math.min(1, details.progress));
  } else $('loading-progress').removeAttribute('value');
  activity(message);
}
function displayError(error, title = t('title.error')) {
  const presentation = presentError(error, {
    secrets: [$('admin-password').value, runningAdministrator?.password], fallback: t('error.operationFailed'),
  });
  $('error-title').textContent = title;
  $('error-message').textContent = presentation.summary;
  $('error-technical-details').hidden = !presentation.details;
  $('error-technical-details').open = false;
  $('error-diagnostics').textContent = presentation.details;
  $('error-recovery-help').textContent = t(fields.persistence.checked ? 'help.savedRetry' : 'help.temporaryRetry');
  $('error-recovery-help').hidden = !error?.phase;
  $('preview-dot').className = 'status-dot failed';
  clearFeedback();
  show('error-view');
  activity(presentation.summary);
  $('error-view').focus();
}
async function recoverSite() {
  if (busy || !catalog || !deployCatalog || !fields.persistence.checked) return;
  pauseAutomaticLaunch();
  if (runtime && !await closeSite({ save: runtime.healthy && currentConfig.persistence && !runtime.recovery })) return;
  setBusy(true);
  destroyPreview();
  show('loading-view');
  try {
    const input = formInput();
    const resolved = await resolve(input);
    currentInput = input;
    currentConfig = resolved.configuration;
    runtime = await createPlayground(currentConfig, { recovery: true, onProgress: progress });
    runningSiteId = currentConfig.storageKey;
    runningAdministrator = runtime.installation?.administrator || currentInput.admin;
    clearFeedback();
    $('error-title').textContent = t('title.recovery');
    $('error-message').textContent = runtime.recovery.filesOnly ? messageOf(runtime.recovery.databaseError) : t('help.recovery');
    show('error-view');
    activity(t(runtime.recovery.filesOnly ? 'help.filesOnlyRecovery' : 'help.recovery'));
  } catch (error) { displayError(error); }
  finally { setBusy(false); }
}
function administrator() {
  return {
    name: $('admin-name').value, username: $('admin-username').value,
    email: $('admin-email').value, password: $('admin-password').value,
  };
}
function applyAdministrator(value) {
  if (!value) return;
  for (const name of ['name', 'username', 'email', 'password']) {
    if (typeof value[name] === 'string') $(`admin-${name}`).value = value[name];
  }
}
function formInput(overrides = {}) {
  const joomlaVersion = overrides.joomlaVersion ?? fields.joomlaVersion.value;
  const jcbInput = jcbSelectionInput({ selection: { ...jcbSelection, version: fields.jcbVersion.value },
    major: joomlaVersion.split('.')[0], deploy: currentDeployRecipe, pinned: pinnedJcb });
  return normalizeConfiguration({
    ...extraDeploymentFields,
    deployId: fields.deployId.value,
    phpVersion: fields.phpVersion.value, joomlaVersion: fields.joomlaVersion.value,
    language: fields.language.value, siteName: fields.siteName.value,
    initialPath: fields.initialPath.value, storageKey: fields.storageKey.value,
    persistence: fields.persistence.checked, autoLogin: fields.autoLogin.checked,
    hideToolbar, fresh: pendingFresh, admin: administrator(),
    extensions: extensionInputs.read(), startupCommands: fields.startupCommands.value,
    phpSettings, ...jcbInput, multilingual: $('multilingual').checked, languageTags: $('deploy-languages').value.split(',').map(value => value.trim()).filter(Boolean),
    menus: parseEditorJSON('deploy-menus', []), template: templateInput(), ...overrides,
  }, { catalog, baseURL: deploymentURL });
}
async function resolve(input) {
  input.joomlaVersion ||= catalog.defaults.joomlaVersion;
  if (input.jcbVersion === undefined && input.deployId !== 'blank' && !savedState.sites[input.storageKey]) {
    const current = matchingJcbChoices(input.joomlaVersion.split('.')[0], dynamicMetadata.jcb, pinnedJcb)
      .find(entry => entry.channel === 'stable');
    if (current) input.jcbVersion = current.version;
  }
  await prepareDynamicInput(input);
  // Exact older pinned versions may still belong to an existing saved site or
  // shared configuration, even after a newer stable replaced them in the menu.
  const previousPinned = pinnedCatalog.joomla.find(entry => entry.version === input.joomlaVersion);
  if (previousPinned && !catalog.joomla.some(entry => entry.version === input.joomlaVersion)) {
    selectedJoomlaPackages.set(previousPinned.version, { ...previousPinned });
    catalog = { ...catalog, joomla: dynamicJoomlaChoices(pinnedCatalog, dynamicMetadata.joomla, selectedJoomlaPackages) };
    fillJoomlaOptions();
  }
  const selectedCatalog = catalogWithSelectedJoomlaPackage(catalog, input, deploymentURL);
  const resolved = await resolveDeployConfiguration(input, { catalog: selectedCatalog, deployCatalog, baseURL: deploymentURL });
  if (selectedCatalog !== catalog) {
    selectedJoomlaPackages.set(resolved.configuration.joomlaVersion, structuredClone(resolved.configuration.joomlaPackage));
    const previous = fields.joomlaVersion.value;
    catalog = selectedCatalog;
    fillJoomlaOptions();
    fields.joomlaVersion.value = previous;
  }
  return resolved;
}
function fillOptions(select, items) {
  const nodes = [];
  const groups = new Map();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.version ?? item.id;
    option.textContent = item.label ?? item.title ?? item.version;
    option.disabled = item.disabled === true;
    if (['stable', 'nightly', 'preview', 'saved'].includes(item.channel)) {
      if (!groups.has(item.channel)) {
        const group = document.createElement('optgroup');
        group.label = t(`version.${item.channel}`);
        groups.set(item.channel, group);
        nodes.push(group);
      }
      groups.get(item.channel).append(option);
    } else nodes.push(option);
  }
  select.replaceChildren(...nodes);
}
function updateCompatibility({ preserve = false } = {}) {
  const joomla = catalog.joomla.find((item) => item.version === fields.joomlaVersion.value);
  if (!joomla) throw new Error('The selected Joomla release is not available.');
  for (const option of fields.phpVersion.options) option.disabled = !joomla.php.includes(option.value);
  if (!joomla.php.includes(fields.phpVersion.value)) {
    if (preserve) throw new Error('The selected Joomla and PHP versions are incompatible.');
    fields.phpVersion.value = joomla.php.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : joomla.php[0];
  }
  $('compatibility-note').textContent = `${joomla.label} · PHP ${joomla.php.join(', ')}`;
  const major = joomla.version.split('.')[0];
  for (const option of fields.deployId.options) { const descriptor = deployCatalog.deploys.find(item => item.id === option.value); option.disabled = Boolean(descriptor?.joomla && !descriptor.joomla.includes(major) && !(major === '7' && descriptor.joomla.includes('6'))); }
  const tags = [...new Set(['en-GB', ...(deployCatalog.languages?.[major] || []).map((item) => item.tag)])];
  languageSelector?.setCatalog(tags);
  deploymentLanguageSelector?.setCatalog(tags);
}
function fillJoomlaOptions() {
  const choices = pinnedCatalog ? dynamicJoomlaChoices(pinnedCatalog, dynamicMetadata.joomla, selectedJoomlaPackages) : catalog.joomla;
  fillOptions(fields.joomlaVersion, choices.map(entry => ({ ...entry, disabled: !entry.php.length })));
}
function renderDynamicChoices() {
  dynamicChoicesPending = false;
  if (!fields.joomlaVersion.value) return;
  const version = fields.joomlaVersion.value;
  fillJoomlaOptions();
  fields.joomlaVersion.value = version;
  renderJcbOptions(version.split('.')[0]);
  updateCompatibility({ preserve: true });
}
async function refreshDynamicCatalog({ required = false } = {}) {
  if (!pinnedCatalog || (document.hidden && !required)) return;
  if (dynamicCatalogRequest) return dynamicCatalogRequest;
  if (Date.now() - dynamicCatalogUpdatedAt < catalogRefreshInterval) return;
  dynamicCatalogRequest = (async () => {
    try {
      const result = await loadVersionCatalog();
      const current = initialized && catalog.joomla.find(entry => entry.version === fields.joomlaVersion.value);
      if (current) selectedJoomlaPackages.set(current.version, { ...current });
      dynamicMetadata = result;
      dynamicCatalogUpdatedAt = Date.now();
      const joomlaChoices = dynamicJoomlaChoices(pinnedCatalog, result.joomla, selectedJoomlaPackages);
      const joomla = joomlaChoices.filter(entry => entry.php.length);
      const defaultMajor = pinnedCatalog.defaults.joomlaVersion.split('.')[0];
      const latestDefault = joomla.find(entry => entry.channel === 'stable' && entry.version.split('.')[0] === defaultMajor);
      catalog = { ...pinnedCatalog, joomla, defaults: { ...pinnedCatalog.defaults,
        joomlaVersion: latestDefault?.version || pinnedCatalog.defaults.joomlaVersion } };
      if (initialized && !busy && !launching) renderDynamicChoices();
      else dynamicChoicesPending = true;
      if (initialized && result.errors.length) activity(`Some release lists could not refresh: ${result.errors.map(error => error.message).join(' ')}`);
    } catch (error) {
      if (initialized) activity(`Release list refresh failed: ${messageOf(error)}`);
      // Keep the current catalog and exact selected archives if discovery fails.
    } finally { dynamicCatalogRequest = undefined; }
  })();
  return dynamicCatalogRequest;
}
function pinnedJoomlaVersion(version) {
  try { return resolveJoomlaVersion(version, pinnedCatalog); }
  catch { return undefined; }
}
async function prepareDynamicInput(input) {
  if (input.joomlaVersion && !input.joomlaPackage) {
    try { input.joomlaVersion = resolveJoomlaVersion(input.joomlaVersion, catalog); }
    catch { input.joomlaVersion = pinnedJoomlaVersion(input.joomlaVersion) || input.joomlaVersion; }
  }
  const version = input.joomlaVersion;
  if (version && !input.joomlaPackage && !pinnedCatalog?.joomla.some(entry => entry.version === version)) {
    const entry = dynamicMetadata.joomla.find(item => item.version === version);
    const available = catalog.joomla.find(item => item.version === version);
    if (entry && available) {
      const selected = selectedJoomlaPackages.get(version);
      input.joomlaPackage = selectCatalogPackage(selected || entry, { php: available.php });
      selectedJoomlaPackages.set(version, structuredClone(input.joomlaPackage));
    }
  }
  if (input.jcbVersion && input.jcbVersion !== 'none' && !input.jcbPackage
      && ![...pinnedJcb.values()].some(entry => entry.version === input.jcbVersion)) {
    const entry = dynamicMetadata.jcb.find(item => item.version === input.jcbVersion);
    if (entry) input.jcbPackage = selectCatalogPackage(entry);
  }
}
function renderJcbOptions(major, selection = jcbSelection) {
  const choices = matchingJcbChoices(major, dynamicMetadata.jcb, pinnedJcb);
  if (selection.version !== 'none' && !choices.some(entry => entry.version === selection.version)) {
    const pinned = [...pinnedJcb.values()].find(entry => entry.version === selection.version);
    if (selection.package || pinned) choices.push({ version: selection.version, label: `JCB ${selection.version}`, channel: 'saved' });
  }
  fillOptions(fields.jcbVersion, [{ version: 'none', label: t('label.jcbNone') }, ...choices]);
  if (![...fields.jcbVersion.options].some(option => option.value === selection.version)) {
    throw new TypeError(`The selected JCB ${selection.version} package is unavailable.`);
  }
  fields.jcbVersion.value = selection.version;
}
async function changeJcbSelection() {
  if (busy || launching) return;
  const version = fields.jcbVersion.value;
  const previous = jcbSelection;
  pauseAutomaticLaunch();
  setBusy(true);
  try {
    const input = { jcbVersion: version };
    if (previous.version === version && previous.package) input.jcbPackage = previous.package;
    await prepareDynamicInput(input);
    const next = { version, omit: false, ...(input.jcbPackage ? { package: input.jcbPackage } : {}) };
    // Validate before changing either the configured value or the visible selection.
    jcbSelectionInput({ selection: next, major: fields.joomlaVersion.value.split('.')[0], deploy: currentDeployRecipe, pinned: pinnedJcb });
    jcbSelection = next;
  } catch (error) {
    jcbSelection = previous;
    fields.jcbVersion.value = previous.version;
    feedback(error, { error: true, persistent: true });
  } finally { setBusy(false); }
}

function applyConfiguration(config, input = config, deploy) {
  refreshNightlyOnNextLaunch = false;
  if (deploy) currentDeployRecipe = deploy;
  extraDeploymentFields = Object.fromEntries(['content', 'languages', 'joomlaPackage'].filter(key => input[key] !== undefined).map(key => [key, structuredClone(input[key])]));
  templateOptions = structuredClone(input.template || config.template || {});
  for (const name of ['deployId', 'joomlaVersion', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language']) {
    if (config[name] !== undefined) fields[name].value = config[name];
  }
  fields.persistence.checked = config.persistence;
  fields.autoLogin.checked = config.autoLogin;
  extensionInputs.setValue(input.extensions || []);
  phpSettings = normalizePhpSettings(input.phpSettings || config.phpSettings || DEFAULT_PHP_SETTINGS);
  $('deploy-languages').value = (input.languageTags || config.languageTags || []).join(', ');
  $('deploy-menus').value = JSON.stringify(input.menus || config.menus || [], null, 2);
  $('template-url').value = (input.template || config.template)?.url || '';
  $('template-name').value = (input.template || config.template)?.element || '';
  $('template-params').value = JSON.stringify((input.template || config.template)?.params || {}, null, 2);
  $('multilingual').checked = config.multilingual === true || config.content?.multilingual === true;
  renderEditorLists();
  fields.startupCommands.value = JSON.stringify(input.startupCommands || [], null, 2);
  pendingFresh = Boolean(config.fresh);
  setFocusMode(config.hideToolbar);
  $('embedded-launch').hidden = false;
  $('editor-runtime-summary').textContent = `${config.deployId} · Joomla ${config.joomlaVersion} · PHP ${config.phpVersion}`;
  selectedProfile = { deployId: config.deployId, joomlaVersion: config.joomlaVersion };
  const description = deploy?.description ?? deployCatalog.deploys.find((item) => item.id === config.deployId)?.description;
  $('deploy-description').textContent = description || 'A verified Joomla installation with the selected setup steps.';
  updateCompatibility({ preserve: true });
  const major = config.joomlaVersion.split('.')[0];
  const isSaved = config.persistence && Object.hasOwn(savedState.sites, config.storageKey);
  jcbSelection = initialJcbSelection({ input: { ...input, deployId: input.deployId ?? config.deployId },
    deploy: currentDeployRecipe, major, pinned: pinnedJcb, isSaved });
  renderJcbOptions(major);
  languageSelector?.refresh(); deploymentLanguageSelector?.refresh();
}

function writePreferences({ render = true } = {}) {
  if (render) renderSavedSites();
  try {
    if (!preferences) throw new Error('Browser preference storage is unavailable.');
    preferences.setItem(preferenceKey, JSON.stringify(savedState));
    return true;
  } catch {
    activity('Site data is available, but automatic-resume preferences could not be saved. Keep the site key to open it again.');
    return false;
  }
}
function renderSavedSites(selectedKey = selectedSiteId) {
  const select = $('saved-site');
  const entries = Object.values(savedState.sites).reverse();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = t(entries.length ? 'status.chooseSavedSite' : 'status.noSavedSites');
  select.replaceChildren(empty, ...entries.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.storageKey;
    option.textContent = `${entry.displayName || entry.siteName} · Joomla ${entry.joomlaVersion}${entry.storageKey === runningSiteId ? ` · ${t('status.running')}` : ''}`;
    return option;
  }));
  select.value = selectedKey || '';
  // Autosave and locale changes can refresh the catalog while a different
  // site's name is being edited. Keep that draft, including an empty value.
  if (savedSiteNameDraft?.key !== selectedKey || !Object.hasOwn(savedState.sites, selectedKey)) savedSiteNameDraft = null;
  $('saved-site-name').value = savedSiteNameDraft?.value ?? savedState.sites[selectedKey]?.displayName ?? '';
}
function rememberCurrentSite() {
  if (currentConfig?.persistence) {
    savedState = rememberSite(savedState, { ...currentInput, lastPath: safeSavedRoute(currentSitePath, currentConfig.initialPath), ...Object.fromEntries(['deployId', 'joomlaVersion', 'phpVersion', 'siteName', 'storageKey', 'persistence', 'language'].map((name) => [name, currentConfig[name]])) });
  } else {
    // Temporary installations must not replace the last resumable saved site.
    if (!preferences) return true;
  }
  return writePreferences();
}
function rememberDraft(profile = selectedProfile) {
  if (!profile) return;
  try { drafts.set(`${profile.deployId}:${profile.joomlaVersion}`, publicConfiguration(formInput(profile))); } catch { /* Invalid unfinished fields stay visible until the user corrects them. */ }
}
function findProfile(deployId, joomlaVersion) {
  return drafts.get(`${deployId}:${joomlaVersion}`)
    || Object.values(savedState.sites).reverse().find((item) => item.deployId === deployId && item.joomlaVersion === joomlaVersion);
}
async function launch() {
  if (busy || launching || !initialized || !catalog || !deployCatalog) return;
  launching = true;
  let switchingStarted = false;
  launchCountdown.stop();
  $('launch-countdown').hidden = true;
  $('dashboard-countdown').hidden = true;
  try {
    if (!$('launch-form').checkValidity()) { setDrawer(true); openDialog('deploy-dialog'); $('advanced-settings').open = true; $('launch-form').reportValidity(); return; }
    let input = formInput();
    const nightly = dynamicMetadata.joomla.find(entry => entry.version === input.joomlaVersion && entry.source === 'nightly');
    if (nightly && input.joomlaPackage && refreshNightlyOnNextLaunch) {
      setBusy(true);
      const selected = selectCatalogPackage(nightly, { php: input.joomlaPackage.php });
      input.joomlaPackage = selected;
      extraDeploymentFields.joomlaPackage = structuredClone(selected);
      selectedJoomlaPackages.set(input.joomlaVersion, structuredClone(selected));
      refreshNightlyOnNextLaunch = false;
    }
    if (!approveCustomSetup(input)) return;
    clearFeedback();
    setBusy(true);
    $('loading-title').textContent = t('title.loading');
    $('loading-progress').removeAttribute('value');
    if (freshKeyPending) {
      input.storageKey = `${defaultSiteKey(input.deployId, input.joomlaVersion).slice(0, 44)}-fresh-${crypto.randomUUID().slice(0, 8)}`;
      fields.storageKey.value = input.storageKey;
    }
    const recipe = await isolateSetup(savedState, input);
    input = recipe.configuration;
    if (recipe.changed) {
      fields.storageKey.value = input.storageKey;
      activity(`Changed setup steps use a separate site key, “${input.storageKey}”. Your previous site is preserved.`);
    }
    const resolved = await resolve(input);
    if (runtime && currentConfig.storageKey === resolved.configuration.storageKey && currentConfig.persistence === resolved.configuration.persistence && JSON.stringify(publicConfiguration(currentInput)) === JSON.stringify(publicConfiguration(input))) {
      setDrawer(false); $('site-frame')?.focus(); feedback(t('status.alreadyRunning')); return;
    }
    if (runtime) {
      if (!currentConfig.persistence && !confirm(t('confirm.temporary'))) return;
      setBusy(false);
      if (!await closeSite({ save: currentConfig.persistence })) return;
    }
    switchingStarted = true;
    setBusy(true); show('loading-view');
    currentInput = input;
    currentConfig = resolved.configuration;
    $('preview-label').textContent = currentConfig.siteName;
    activity(`Starting ${resolved.deploy?.title || currentConfig.deployId} with Joomla ${currentConfig.joomlaVersion} and PHP ${currentConfig.phpVersion}.`);
    const resumePath = resumeLastRoute && !input.fresh && currentConfig.persistence && savedState.sites[currentConfig.storageKey]?.lastPath;
    runtime = await createPlayground({ ...currentConfig, ...(resumePath ? { initialPath: safeSavedRoute(resumePath, currentConfig.initialPath) } : {}) }, { onProgress: progress });
    runningSiteId = currentConfig.storageKey;
    selectedSiteId = currentConfig.persistence ? currentConfig.storageKey : null;
    const restoredPath = resumePath ? await resolveResumePath((path, init) => runtime.request(path, init), resumePath, currentConfig.initialPath) : null;
    const siteURL = new URL(restoredPath ? resolveSiteURL(restoredPath, runtime.baseUrl) : runtime.url, location.href);
    if (siteURL.origin !== location.origin) throw new Error('The playground returned an unexpected site origin.');
    runningAdministrator = runtime.installation?.administrator || currentInput.admin;
    applyAdministrator(runningAdministrator);
    currentConfig.siteName = runtime.installation?.siteName || currentConfig.siteName;
    currentInput.siteName = currentConfig.siteName;
    fields.siteName.value = currentConfig.siteName;
    if (runtime.installation?.language) {
      currentConfig.language = runtime.installation.language;
      currentInput.language = currentConfig.language;
      fields.language.value = currentConfig.language;
    }
    if (runtime.installation?.deployId && deployCatalog.deploys.some((item) => item.id === runtime.installation.deployId)) {
      currentConfig.deployId = runtime.installation.deployId;
      currentInput.deployId = currentConfig.deployId;
      fields.deployId.value = currentConfig.deployId;
    }
    $('preview-label').textContent = currentConfig.siteName;
    currentSitePath = `/${siteURL.href.slice(runtime.baseUrl.length)}`;
    mountPreview(siteURL.href);
    lastSavedAt = currentConfig.persistence ? new Date() : undefined;
    setDrawer(false);
    $('deploy-dialog').close();
    updateRuntimeLocation();
    pendingFresh = false;
    freshKeyPending = false;
    currentInput.fresh = false;
    resumeLastRoute = true;
    const resumeSaved = rememberCurrentSite();
    selectedProfile = { deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion };
    rememberDraft({ deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion });
    activity(recipe.changed ? `Site ready under “${currentConfig.storageKey}”. Your previous site is available in Saved sites.` : currentConfig.persistence
      ? resumeSaved ? 'Site ready. Reopening this playground will resume your saved site.' : `Site ready. Keep saved site key “${currentConfig.storageKey}” to reopen it.`
      : 'Temporary site ready. Download your work before closing.');
  } catch (error) {
    if (!switchingStarted) { feedback(error, { error: true, persistent: true }); return; }
    destroyPreview();
    if (runtime) {
      try { await runtime.close(); } catch (closeError) { activity(closeError); }
      runtime = undefined;
      runningSiteId = null;
    }
    displayError(error);
  } finally {
    launching = false;
    setBusy(false);
    if (!$('error-view').hidden) $('preview-dot').className = 'status-dot failed';
  }
}
async function closeSite({ reset = false, save = false } = {}) {
  if (busy || closing || !runtime) return false;
  if (openingCode) { feedback(t('code.loading')); return false; }
  const handle = runtime;
  let previewRemoved = false;
  closing = true;
  setBusy(true);
  try {
    if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return false;
    if (handle.debugger.state !== 'idle') await handle.debugger.stop();
    if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return false;
    // A failed checkpoint must leave the current iframe and unsaved forms intact.
    if (save && !handle.recovery?.filesOnly) { activity('Saving the current site before closing…'); await handle.flush(); }
    destroyPreview(); previewRemoved = true;
    if (reset) await handle.reset();
    else await handle.close();
    await codeHost?.dispose(); codeHost = undefined;
    runtime = undefined;
    runningSiteId = null; runningAdministrator = null; previewDirty = false;
    if (reset) {
      savedState = forgetSite(savedState, currentConfig.storageKey);
      writePreferences();
      pendingFresh = false;
      freshKeyPending = false;
    }
    $('preview-label').textContent = t('title.site');
    clearFeedback(); show('welcome');
    activity(reset ? 'Site files and database deleted. Launch to build a fresh site from its deploy.' : 'Site closed. Its saved data remains available.');
    return true;
  } catch (error) {
    runtime = handle.healthy ? handle : undefined;
    if (runtime) {
      if (previewRemoved) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
      feedback(error, { error: true, persistent: true });
    } else {
      // Failed workers must still release the storage lock before a recovery retry.
      try { await handle.close(); } catch (cleanupError) { activity(cleanupError); }
      try { await codeHost?.dispose(); } catch (cleanupError) { activity(cleanupError); }
      codeHost = undefined; runningSiteId = null; runningAdministrator = null;
      displayError(error);
    }
    return false;
  } finally { closing = false; setBusy(false); }
}

async function newSite() {
  if (busy || launching || !catalog || !deployCatalog) return;
  pauseAutomaticLaunch();
  rememberDraft();
  const label = deployCatalog.deploys.find((entry) => entry.id === fields.deployId.value)?.title || 'Joomla site';
  fields.storageKey.value = `${defaultSiteKey(fields.deployId.value, fields.joomlaVersion.value).slice(0, 44)}-site-${crypto.randomUUID().slice(0, 8)}`;
  fields.siteName.value = `${label.slice(0, 88)} ${Object.keys(savedState.sites).length + 1}`;
  $('admin-password').value = password();
  refreshNightlyOnNextLaunch = dynamicMetadata.joomla.some(entry => entry.version === fields.joomlaVersion.value && entry.source === 'nightly');
  pendingFresh = false;
  freshKeyPending = false;
  selectedSiteId = null; resumeLastRoute = false;
  jcbSelection = initialJcbSelection({ input: { deployId: fields.deployId.value }, deploy: currentDeployRecipe,
    major: fields.joomlaVersion.value.split('.')[0], pinned: pinnedJcb, isSaved: false });
  if (fields.deployId.value !== 'blank') {
    const current = matchingJcbChoices(fields.joomlaVersion.value.split('.')[0], dynamicMetadata.jcb, pinnedJcb)
      .find(entry => entry.channel === 'stable');
    if (current) jcbSelection = { version: current.version, omit: false,
      ...(current.url ? { package: selectCatalogPackage(current) } : {}) };
  }
  renderJcbOptions(fields.joomlaVersion.value.split('.')[0]);
  renderSavedSites('');
  if (!runtime) show('welcome');
  setBusy(false);
  activity(`Choose settings for new site “${fields.storageKey.value}”, then Launch. Your saved sites are preserved.`);
  openDialog('deploy-dialog');
  fields.siteName.focus();
}

async function openSavedSite(key) {
  if (busy || launching || !Object.hasOwn(savedState.sites, key)) return;
  pauseAutomaticLaunch();
  rememberDraft();
  setBusy(true);
  try {
    const input = { ...savedState.sites[key], hideToolbar, admin: administrator() };
    const resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    selectedSiteId = key; resumeLastRoute = true;
    freshKeyPending = false;
    if (!runtime) show('welcome');
    $('retry-button').hidden = false;
    renderSavedSites(key);
    activity(t('status.siteStaged', { name: savedState.sites[key].displayName || input.siteName }));
  } catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { setBusy(false); }
}
async function deleteSelectedSite() {
  if (busy || launching || !selectedSiteId || !Object.hasOwn(savedState.sites, selectedSiteId)) return;
  pauseAutomaticLaunch();
  const key = selectedSiteId;
  const name = savedState.sites[key].displayName || savedState.sites[key].siteName;
  if (!confirm(t('confirm.deleteSavedSite', { name }))) return;
  if (runtime && runningSiteId === key && !await closeSite()) return;
  setBusy(true);
  try {
    // Locks, files, database and Code drafts all use the selected identity.
    // Retain catalog metadata on any failure so deletion can safely be retried.
    await resetPlayground({ storageKey: key });
    savedState = forgetSite(savedState, key);
    selectedSiteId = null;
    const metadataSaved = writePreferences();
    // Files are already deleted; report a catalog persistence failure instead
    // of promising a successful saved-site management change after reload.
    feedback(`${t('status.siteDeleted', { name })}${metadataSaved ? '' : ` ${t('error.storage')}`}`,
      { error: !metadataSaved, persistent: !metadataSaved });
  } catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { setBusy(false); }
}
function renameSelectedSite() {
  if (busy || launching || !selectedSiteId) return;
  pauseAutomaticLaunch();
  try {
    const previous = savedState;
    savedState = renameSavedSite(savedState, selectedSiteId, $('saved-site-name').value);
    const metadataSaved = writePreferences();
    if (!metadataSaved) { savedState = previous; renderSavedSites(); }
    else { savedSiteNameDraft = null; renderSavedSites(); }
    setBusy(false);
    feedback(t(metadataSaved ? 'status.siteRenamed' : 'error.storage'),
      { error: !metadataSaved, persistent: !metadataSaved });
  } catch (error) { feedback(error, { error: true, persistent: true }); }
}
async function changeProfile({ refreshNightly = false } = {}) {
  if (busy || launching || !catalog) return;
  const major = fields.joomlaVersion.value.split('.')[0];
  const descriptor = deployCatalog.deploys.find(item => item.id === fields.deployId.value);
  if (descriptor?.joomla && !descriptor.joomla.includes(major) && !(major === '7' && descriptor.joomla.includes('6'))) fields.deployId.value = deployCatalog.defaultsByJoomla?.[major] || deployCatalog.default;
  const target = { deployId: fields.deployId.value, joomlaVersion: fields.joomlaVersion.value };
  const previous = selectedProfile;
  pauseAutomaticLaunch();
  rememberDraft(previous);
  setBusy(true);
  try {
    const stored = findProfile(target.deployId, target.joomlaVersion);
    const input = {
      ...(stored || {}), ...target,
      phpVersion: fields.phpVersion.value,
      persistence: stored?.persistence ?? fields.persistence.checked,
      hideToolbar,
      ...(!stored && target.deployId === previous?.deployId ? { language: fields.language.value } : {}),
      storageKey: stored?.storageKey || defaultSiteKey(target.deployId, target.joomlaVersion),
      ...(!stored?.joomlaPackage && selectedJoomlaPackages.has(target.joomlaVersion)
        ? { joomlaPackage: structuredClone(selectedJoomlaPackages.get(target.joomlaVersion)) } : {}),
      admin: { ...administrator(), ...(!stored ? { password: password() } : {}) },
    };
    const selectedCatalog = catalogWithSelectedJoomlaPackage(catalog, input, deploymentURL);
    const compatible = selectedCatalog.joomla.find((item) => item.version === target.joomlaVersion)?.php;
    if (!compatible?.includes(input.phpVersion)) input.phpVersion = compatible?.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : compatible?.[0];
    const nightly = refreshNightly && dynamicMetadata.joomla.find(entry => entry.version === target.joomlaVersion && entry.source === 'nightly');
    if (nightly && !savedState.sites[input.storageKey]) {
      input.joomlaPackage = selectCatalogPackage(nightly, { php: compatible });
      selectedJoomlaPackages.set(target.joomlaVersion, structuredClone(input.joomlaPackage));
    }
    const resolved = await resolve(input);
    applyAdministrator(input.admin);
    freshKeyPending = false;
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    selectedSiteId = savedState.sites[input.storageKey] ? input.storageKey : null;
    resumeLastRoute = Boolean(selectedSiteId);
    renderSavedSites();
    if (!runtime) show('welcome');
    $('retry-button').hidden = false;
    activity(`Selected ${resolved.deploy?.title || target.deployId}. Saved site key: ${resolved.configuration.storageKey}.`);
  } catch (error) {
    if (previous) {
      fields.deployId.value = previous.deployId;
      fields.joomlaVersion.value = previous.joomlaVersion;
      updateCompatibility();
    }
    feedback(error, { error: true, persistent: true });
  } finally { setBusy(false); }
}

$('launch-form').addEventListener('submit', (event) => { event.preventDefault(); void launch(); });
$('embedded-launch').addEventListener('click', () => void launch());
$('retry-button').addEventListener('click', async () => { if (runtime && !await closeSite()) return; await launch(); });
$('download-error-diagnostics').addEventListener('click', () => {
  const contents = [$('error-message').textContent, $('error-diagnostics').textContent].join('\n\n');
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'joomengine-installation-diagnostics.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('code-button').addEventListener('click', () => { void openCode(); });
$('code-refresh-button').addEventListener('click', () => { void codeHost?.refresh().catch(error => feedback(error, { error: true, persistent: true })); });
$('close-button').addEventListener('click', () => { if (runtime && !currentConfig.persistence && !confirm(t('confirm.temporary'))) return; void closeSite(); });
$('new-site-button').addEventListener('click', () => void newSite());
$('saved-site').addEventListener('change', (event) => void openSavedSite(event.target.value));
$('saved-site-name').addEventListener('input', (event) => {
  savedSiteNameDraft = { key: selectedSiteId, value: event.target.value };
});
$('rename-site-button').addEventListener('click', renameSelectedSite);
$('delete-site-button').addEventListener('click', () => void deleteSelectedSite());
$('stop-countdown').addEventListener('click', pauseAutomaticLaunch);
$('stop-countdown-button').addEventListener('click', pauseAutomaticLaunch);
$('nav-site').addEventListener('click', () => navigatePreview('/'));
$('nav-admin').addEventListener('click', () => navigatePreview('/administrator/'));
$('restart-button').addEventListener('click', async () => {
  if (busy || !runtime || runtime.recovery?.filesOnly) return;
  setBusy(true); destroyPreview(); show('loading-view');
  try { await runtime.updatePhpSettings(currentConfig.phpSettings || DEFAULT_PHP_SETTINGS); mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); feedback(t('status.ready')); }
  catch (error) { if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else displayError(error); feedback(error, { error: true }); }
  finally { setBusy(false); }
});
$('reset-button').addEventListener('click', () => void resetSite());
$('error-reset-button').addEventListener('click', () => void resetSite({ start: true }));
$('recover-button').addEventListener('click', () => void recoverSite());
$('repair-button').addEventListener('click', async () => {
  if (busy || !runtime?.recovery || runtime.recovery.filesOnly) return;
  setBusy(true);
  try {
    await runtime.repairConfiguration();
    clearFeedback();
    $('error-message').textContent = t('status.repaired');
    activity(t('status.repaired'));
  } catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { setBusy(false); }
});
async function resetSite({ start = false } = {}) {
  if (busy) return;
  const targetKey = runtime ? currentConfig.storageKey : fields.storageKey.value;
  const targetName = savedState.sites[targetKey]?.displayName || (runtime ? currentConfig.siteName : fields.siteName.value);
  if (!confirm(`${targetName}\n\n${t('confirm.reset')}`)) return;
  pauseAutomaticLaunch();
  if (runtime) {
    if (await closeSite({ reset: true }) && start) await launch();
    return;
  }
  setBusy(true);
  let reset = false;
  try {
    await resetPlayground({ storageKey: fields.storageKey.value });
    savedState = forgetSite(savedState, fields.storageKey.value);
    writePreferences();
    pendingFresh = false;
    freshKeyPending = false;
    clearFeedback();
    show('welcome');
    activity('Saved data deleted. Launch to build a fresh site from its deploy.');
    reset = true;
  } catch (error) { displayError(error, t('title.error')); }
  finally { setBusy(false); }
  if (reset && start) await launch();
}
$('save-button').addEventListener('click', () => void saveSite());
$('export-button').addEventListener('click', async () => {
  if (!runtime || busy) return;
  setBusy(true);
  const format = $('export-format').value;
  activity('Preparing your download…');
  try {
    const result = format === 'recovery' || runtime.recovery?.filesOnly || (runtime.recovery && !runtime.recovery.configured)
      ? await runtime.exportRecoveryFiles()
      : await runtime.exportSite({ format, onProgress: (event) => activity(event.message || event) });
    if (!result || typeof result.filename !== 'string' || !result.filename
        || (!(result.blob instanceof Blob) && !(result.bytes instanceof Uint8Array))) {
      throw new Error('The export did not produce a downloadable file.');
    }
    const blob = result.blob || new Blob([result.bytes], { type: result.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    activity(`${result.filename} is ready to download.`);
  } catch (error) { activity(`Download failed: ${messageOf(error)}`); feedback(error, { error: true, persistent: true }); }
  finally { setBusy(false); }
});
$('share-button').addEventListener('click', () => showShare());
$('show-password').addEventListener('click', () => {
  const visible = $('admin-password').type === 'password';
  $('admin-password').type = visible ? 'text' : 'password';
  $('show-password').textContent = t(visible ? 'action.hide' : 'action.show');
  $('show-password').setAttribute('aria-label', t(visible ? 'a11y.hidePassword' : 'a11y.showPassword'));
  $('show-password').setAttribute('aria-pressed', String(visible));
});
$('log-toggle').addEventListener('click', () => {
  const expanded = $('activity-log').hidden;
  $('activity-log').hidden = !expanded;
  $('log-toggle').setAttribute('aria-expanded', String(expanded));
});
fields.deployId.addEventListener('change', () => void changeProfile());
fields.joomlaVersion.addEventListener('change', () => void changeProfile({ refreshNightly: true }));
fields.jcbVersion.addEventListener('change', () => void changeJcbSelection());
for (const select of [fields.joomlaVersion, fields.jcbVersion]) {
  select.addEventListener('focus', () => void refreshDynamicCatalog());
}

fields.initialPath.addEventListener('input', () => { resumeLastRoute = false; });
fields.phpVersion.addEventListener('change', () => { pauseAutomaticLaunch(); setBusy(busy); });
fields.persistence.addEventListener('change', () => { pauseAutomaticLaunch(); setBusy(busy); });
fields.storageKey.addEventListener('change', () => {
  pauseAutomaticLaunch();
  if (busy) return;
  if (Object.hasOwn(savedState.sites, fields.storageKey.value)) void openSavedSite(fields.storageKey.value);
  else { selectedSiteId = null; renderSavedSites(); setBusy(false); }
});

function parseEditorJSON(id, fallback) {
  try { return JSON.parse($(id).value.trim() || JSON.stringify(fallback)); }
  catch { throw new TypeError(`${$(id).labels?.[0]?.textContent || id}: ${t('error.configuration')}`); }
}
function templateInput() {
  const element = $('template-name').value.trim(), url = $('template-url').value.trim();
  if (!element && !url) return undefined;
  const template = { ...templateOptions, params: parseEditorJSON('template-params', {}) };
  if (url !== templateOptions.url) delete template.sha256;
  if (element !== templateOptions.element) delete template.styleId;
  if (url) template.url = url; else delete template.url;
  if (element) template.element = element; else delete template.element;
  return template;
}
function renderEditorLists() {
  for (const [field, target, label] of [
    ['deploy-menus', 'menu-list', item => `${item.title} · ${item.component || ''}${item.view ? ` / ${item.view}` : ''}${item.home ? ' ★' : ''}`],
  ]) {
    let items;
    try { items = parseEditorJSON(field, []); } catch { continue; }
    if (!Array.isArray(items)) continue;
    $(target).replaceChildren(...items.map((item, index) => {
      const row = document.createElement('div'); row.className = 'package-row';
      const text = document.createElement('span'); text.textContent = label(item);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '×';
      button.setAttribute('aria-label', `${t('action.remove')}: ${label(item)}`);
      button.addEventListener('click', () => { items.splice(index, 1); $(field).value = JSON.stringify(items, null, 2); renderEditorLists(); });
      row.append(text, button); return row;
    }));
  }
}
function openEditor() {
  $('deploy-error').hidden = true;
  $('advanced-settings').open = true;
  $('editor-runtime-summary').textContent = `${fields.deployId.value} · Joomla ${fields.joomlaVersion.value} · PHP ${fields.phpVersion.value}`;
  updateMcpPreview();
  renderEditorLists(); openDialog('deploy-dialog');
  if (runtime?.discoverConfiguration && !runtime.recovery && !busy) void runtime.discoverConfiguration().then(discovered => {
    $('component-options').replaceChildren(...[...new Set(discovered.menuTypes.map(item => item.component))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    $('template-options').replaceChildren(...[...new Set(discovered.templates.map(item => item.template))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '—';
    $('menu-preset').replaceChildren(empty, ...discovered.menuTypes.map(item => { const option = document.createElement('option'); option.value = JSON.stringify({component:item.component,view:item.view,layout:item.layout}); option.textContent = `${item.title || item.view} · ${item.component}${item.layout && item.layout !== 'default' ? ` / ${item.layout}` : ''}`; return option; }));
  }).catch(error => activity(error));
}
function editorError(error) { $('deploy-error').textContent = messageOf(error); $('deploy-error').hidden = false; }
async function saveSite({ quiet = false } = {}) {
  if (!runtime || busy || runtime.recovery?.filesOnly) return false;
  const wasTemporary = !currentConfig.persistence;
  const savingSelected = fields.storageKey.value === currentConfig.storageKey;
  setBusy(true); $('save-state').textContent = t('status.saving');
  if (wasTemporary) { destroyPreview(); show('loading-view'); }
  try {
    if (wasTemporary) {
      runtime = codeHost && !codeHost.closed ? await codeHost.keepSite() : await runtime.keep();
      currentConfig = runtime.configuration;
      currentInput = { ...currentInput, persistence: true, storageKey: currentConfig.storageKey };
      runningSiteId = currentConfig.storageKey;
      if (savingSelected) { fields.storageKey.value = currentConfig.storageKey; fields.persistence.checked = true; selectedSiteId = currentConfig.storageKey; }
      mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
    } else await runtime.flush();
    lastSavedAt = new Date(); rememberCurrentSite();
    updateRuntimeLocation();
    if (!quiet) { activity('Files and database saved to browser storage.'); feedback(t('status.savedAt', { time: lastSavedAt.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) })); }
    return true;
  } catch (error) {
    fields.persistence.checked = currentConfig.persistence;
    activity(`Save failed: ${messageOf(error)}`);
    if (runtime?.healthy) { if (wasTemporary) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); }
    else displayError(error);
    feedback(`${t('status.saveFailed')}: ${messageOf(error)}`, { error: true, persistent: true }); return false;
  }
  finally { setBusy(false); }
}
function showShare(input) {
  try {
    input ||= currentInput || formInput();
    sharedConfiguration = input;
    $('copy-share').disabled = false;
    $('share-summary').textContent = `${input.siteName || fields.siteName.value} · Joomla ${input.joomlaVersion || fields.joomlaVersion.value} · PHP ${input.phpVersion || fields.phpVersion.value}`;
    $('share-url').value = createShareURL(location.href, input);
    $('share-feedback').textContent = '';
    $('native-share').hidden = typeof navigator.share !== 'function';
    openDialog('share-dialog');
  } catch (error) {
    $('share-url').value = ''; $('share-feedback').textContent = `${t('error.share')} ${messageOf(error)}`;
    $('copy-share').disabled = true; $('native-share').hidden = true;
    if (sharedConfiguration) openDialog('share-dialog');
    else feedback(error, { error: true, persistent: true });
  }
}
function downloadConfiguration(input = formInput()) {
  const body = JSON.stringify(createDeploymentDocument(input), null, 2);
  const url = URL.createObjectURL(new Blob([`${body}\n`], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'joomengine-deploy.json';
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function useDeployment() {
  if (busy || launching || !catalog) return;
  $('deploy-error').hidden = true;
  try {
    let input = formInput();
    if (!approveCustomSetup(input)) return;
    const previousRuntime = runtime;
    if (runtime) input = { ...input, storageKey: `${defaultSiteKey(input.deployId, input.joomlaVersion).slice(0, 44)}-site-${crypto.randomUUID().slice(0, 8)}`, admin: { ...input.admin, password: password() } };
    const resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy); applyAdministrator(input.admin);
    selectedSiteId = null; resumeLastRoute = false; renderSavedSites();
    $('deploy-dialog').close();
    await launch();
    if (runtime && runtime !== previousRuntime) showShare(currentInput);
  } catch (error) { editorError(error); }
}
async function applyDeployment() {
  if (busy || launching || closing || !runtime) return;
  $('deploy-error').hidden = true;
  setBusy(true);
  try {
    if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return;
    if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return;
    const input = formInput({ storageKey: currentConfig.storageKey, persistence: currentConfig.persistence, fresh: false });
    if (!approveCustomSetup(input)) return;
    const resolved = await resolve(input);
    setBusy(true); destroyPreview(); show('loading-view');
    await runtime.applyConfiguration(resolved.configuration);
    currentConfig = runtime.configuration; currentInput = input;
    applyConfiguration(currentConfig, currentInput, resolved.deploy);
    runningAdministrator = runtime.installation?.administrator || currentInput.admin;
    applyAdministrator(runningAdministrator);
    lastSavedAt = currentConfig.persistence ? new Date() : undefined;
    rememberCurrentSite();
    currentSitePath = currentConfig.initialPath;
    mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
    $('deploy-dialog').close(); feedback(t('status.ready'));
    updateRuntimeLocation();
  } catch (error) {
    if (typeof error.recover === 'function') {
      try {
        const oldRuntime = runtime;
        runtime = await error.recover();
        await codeHost?.dispose(); codeHost = undefined;
        currentConfig = runtime.configuration;
        runningSiteId = currentConfig.storageKey;
        selectedSiteId = currentConfig.persistence ? currentConfig.storageKey : null;
        runningAdministrator = runtime.installation?.administrator || currentInput.admin;
        currentInput = { ...currentInput, storageKey: currentConfig.storageKey, persistence: currentConfig.persistence };
        applyConfiguration(currentConfig, currentInput); rememberCurrentSite();
        updateRuntimeLocation();
        try { await oldRuntime.close(); } catch (cleanupError) { activity(cleanupError); }
      }
      catch (recoveryError) { feedback(recoveryError, { error: true, persistent: true }); }
    }
    editorError(error); if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else displayError(error);
  }
  finally { setBusy(false); }
}
function populatePhpSettings(settings = phpSettings) {
  const form = $('php-settings-form');
  for (const [name, value] of Object.entries(settings)) if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
  const effective = runtime?.runtimeInfo?.effectivePhpSettings;
  $('php-effective').textContent = effective ? `${t('label.effectiveSettings')}: ${Object.entries(effective).map(([key, value]) => `${key}=${value}`).join(' · ')}` : '';
  $('php-error').hidden = true;
}
function syncThemeToggle() {
  const button = $('theme-toggle');
  const mode = getThemeState().resolved;
  const next = mode === 'dark' ? 'light' : 'dark';
  decorateAction(button, `theme-${mode}`, { iconOnly: true });
  button.setAttribute('aria-pressed', String(mode === 'dark'));
  button.setAttribute('aria-label', `${t('label.appearance')}: ${t(`theme.${mode}`)}`);
  button.title = `${t('label.appearance')}: ${t(`theme.${mode}`)} → ${t(`theme.${next}`)}`;
}
function setupInterface() {
  initializeTheme();
  observeIcons();
  syncThemeToggle();
  document.addEventListener('joomengine:themechange', syncThemeToggle);
  $('theme-toggle').addEventListener('click', () => setTheme(getThemeState().resolved === 'dark' ? 'light' : 'dark'));
  languageSelector = createLanguageSelector(fields.language, { t, getLocale });
  deploymentLanguageSelector = createLanguageSelector($('deploy-languages'), { multiple: true, t, getLocale });
  extensionInputs = createExtensionInputs({
    textarea: fields.extensions, rows: $('package-list'), addButton: $('add-package'),
    advanced: $('extension-advanced'), errorElement: $('extension-error'),
    baseURL: deploymentURL, t, onChange: pauseAutomaticLaunch,
  });
  // Native validation runs before submit. Reveal invalid controls even when
  // their deployment dialog or advanced editor was closed before Launch.
  $('launch-form').addEventListener('invalid', event => {
    if ($('deploy-dialog').contains(event.target)) openDialog('deploy-dialog');
    else setDrawer(true);
    for (let parent = event.target.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
  }, true);
  $('interface-language').replaceChildren(...UI_LANGUAGES.map(({ code, label }) => { const option = document.createElement('option'); option.value = code; option.textContent = label; return option; }));
  $('interface-language').value = getLocale();
  $('interface-language').addEventListener('change', async event => { try { await setLocale(event.target.value); } catch (error) { feedback(error, { error: true }); } });
  document.addEventListener('rocket:languagechange', () => {
    $('interface-language').value = getLocale();
    syncThemeToggle();
    if (catalog) setBusy(busy);
    if (runtime && currentConfig) $('preview-label').textContent = currentConfig.siteName;
    $('credentials-button').textContent = `${t('title.credentials')}${$('credentials-button').dataset.signedOut === 'true' ? ` · ${t('status.signedOut')}` : ''}`;
    $('site-frame')?.setAttribute('title', t('a11y.site'));
    updateDrawerLabels();
    renderSavedSites(); renderEditorLists();
    languageSelector?.refresh(); deploymentLanguageSelector?.refresh();
    extensionInputs?.refresh();
    if (catalog && fields.joomlaVersion.value) renderDynamicChoices();
  });
  $('settings-toggle').addEventListener('click', () => setDrawer($('settings').hidden));
  for (const [id, hidden, edge] of [
    ['focus-header-button', true, 'top'], ['focus-footer-button', true, 'bottom'],
    ['focus-restore-top', false, 'top'], ['focus-restore-bottom', false, 'bottom'],
  ]) $(id).addEventListener('click', () => setFocusMode(hidden, { focus: true, edge }));
  for (const id of ['deploy-editor-button', 'welcome-configure', 'error-configure']) $(id).addEventListener('click', openEditor);
  $('editor-runtime-button').addEventListener('click', () => { $('deploy-dialog').close(); setDrawer(true); fields.deployId.focus(); });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  }
  $('information-button').addEventListener('click', () => openDialog('information-dialog'));
  $('download-dialog-button').addEventListener('click', () => openDialog('download-dialog'));
  $('credentials-button').addEventListener('click', () => {
    updateMcpPreview();
    $('credential-username').value = runningAdministrator?.username || ''; $('credential-password').value = runningAdministrator?.password || '';
    $('credential-password').type = 'password'; $('reveal-credentials').textContent = t('action.show'); openDialog('credentials-dialog');
  });
  $('reveal-credentials').addEventListener('click', () => { const show = $('credential-password').type === 'password'; $('credential-password').type = show ? 'text' : 'password'; $('reveal-credentials').textContent = t(show ? 'action.hide' : 'action.show'); });
  $('copy-credentials').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('credential-password').value); feedback(t('status.passwordCopied')); } catch { $('credential-password').type = 'text'; $('credential-password').select(); feedback(t('error.clipboard'), { error: true }); } });
  $('go-administrator').addEventListener('click', () => { if (runtime) navigatePreview('/administrator/'); $('credentials-dialog').close(); });
  $('copy-share').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('share-url').value); $('share-feedback').textContent = t('status.copied'); } catch { $('share-url').focus(); $('share-url').select(); $('share-feedback').textContent = t('help.clipboard'); } });
  $('share-export-config').addEventListener('click', () => { try { downloadConfiguration(sharedConfiguration); } catch (error) { $('share-feedback').textContent = messageOf(error); } });
  $('native-share').addEventListener('click', async () => { try { await navigator.share({ title: sharedConfiguration?.siteName || 'JoomEngine Rocket', url: $('share-url').value }); } catch (error) { if (error.name !== 'AbortError') $('share-feedback').textContent = messageOf(error); } });
  $('menu-preset').addEventListener('change', event => { if (event.target.value) { const item = JSON.parse(event.target.value); $('menu-component').value = item.component; $('menu-view').value = item.view; } });
  $('add-menu').addEventListener('click', () => { try {
    const title = $('menu-title').value.trim(), component = $('menu-component').value.trim(), view = $('menu-view').value.trim();
    if (!title || !component || !view) throw new TypeError(t('error.configuration'));
    const menus = parseEditorJSON('deploy-menus', []);
    const home = $('menu-home').checked;
    if (home) for (const item of menus) if ((item.language || '*') === '*') item.home = false;
    const preset = $('menu-preset').value ? JSON.parse($('menu-preset').value) : undefined;
    const query = preset?.component === component && preset.view === view && preset.layout ? { layout: preset.layout } : {};
    menus.push({ key: `menu-${crypto.randomUUID().slice(0, 8)}`, title, component, view, query, home, menuType: 'mainmenu', language: '*', published: true });
    $('deploy-menus').value = JSON.stringify(menus, null, 2); formInput();
    $('menu-title').value = ''; $('menu-component').value = ''; $('menu-view').value = ''; $('menu-preset').value = ''; $('menu-home').checked = false; renderEditorLists();
  } catch (error) { editorError(error); } });
  $('deploy-menus').addEventListener('change', renderEditorLists);
  $('use-deploy').addEventListener('click', () => void useDeployment());
  $('apply-deploy').addEventListener('click', () => void applyDeployment());
  $('export-config').addEventListener('click', () => { try { downloadConfiguration(); } catch (error) { editorError(error); } });
  $('import-config').addEventListener('change', async event => { try {
    const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new RangeError('The deployment document exceeds 1 MiB.');
    const input = { ...parseDeploymentDocument(await file.text()), admin: administrator() };
    const resolved = await resolve(input); applyConfiguration(resolved.configuration, input, resolved.deploy); resumeLastRoute = false; openEditor();
  } catch (error) { editorError(error); } finally { event.target.value = ''; } });
  $('php-settings-button').addEventListener('click', () => { populatePhpSettings(runtime ? currentConfig.phpSettings : phpSettings); openDialog('php-dialog'); });
  $('reset-php').addEventListener('click', () => populatePhpSettings(DEFAULT_PHP_SETTINGS));
  $('php-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || runtime?.recovery?.filesOnly) return;
    $('php-error').hidden = true;
    try {
      const settings = normalizePhpSettings(Object.fromEntries(new FormData(event.target)));
      if (runtime) {
        setBusy(true); destroyPreview(); show('loading-view');
        await runtime.updatePhpSettings(settings);
        currentConfig = runtime.configuration; currentInput = { ...currentInput, phpSettings: settings };
        rememberCurrentSite(); mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
        updateRuntimeLocation();
      }
      phpSettings = settings; $('php-dialog').close(); feedback(t('status.ready'));
    } catch (error) { $('php-error').textContent = messageOf(error); $('php-error').hidden = false; if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else if (runtime) displayError(error); }
    finally { setBusy(false); }
  });
  for (const event of ['input', 'change']) $('launch-form').addEventListener(event, pauseAutomaticLaunch);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAutomaticLaunch(); });
  window.addEventListener('pagehide', () => launchCountdown.stop());
  setInterval(() => { if (runtime && !runtime.recovery && !runtime.changing && currentConfig?.persistence && !busy && document.visibilityState === 'visible') void saveSite({ quiet: true }); }, 60000);
}

async function initialize() {
  try {
    await initializeLocale();
    $('interface-language').value = getLocale();
    const parsed = readURLConfiguration(location.href);
    if (parsed.document) parsed.config = { ...await loadDeploymentDocument(parsed.document.url, { ...parsed.document, baseURL: deploymentURL }), ...parsed.config };
    const params = new URL(location.href).searchParams;
    resumeLastRoute = !parsed.document && !new URL(location.href).hash.startsWith('#deploy=') && !params.has('path') && !params.has('initialPath') && !parsed.config.fresh;
    setFocusMode(parsed.config.hideToolbar);
    $('embedded-launch').hidden = false;
    activity('Preparing browser support for PHP and MariaDB…');
    const environment = await prepareEnvironment();
    const reloadMarker = `joomengine:environment-reload:${deploymentURL}`;
    if (environment.reloadRequired) {
      let previousReload;
      try { previousReload = sessionStorage.getItem(reloadMarker); sessionStorage.setItem(reloadMarker, '1'); }
      catch { throw new Error('Allow session storage for this page, then reload to enable the browser database runtime.'); }
      if (previousReload) throw new Error('This browser or host could not enable the credentialless isolation required by MariaDB and external assets. Use a current desktop Firefox or Chromium browser over HTTPS with service workers enabled.');
      location.reload(); return;
    }
    try { sessionStorage.removeItem(reloadMarker); } catch { /* Already-isolated temporary sites need no saved preference. */ }
    if (!globalThis.crossOriginIsolated) throw new Error('This browser or host does not support the isolation required by MariaDB.');
    $('admin-password').value = password();
    const [manifest, recipes] = await Promise.all([
      fetch(new URL('../assets/manifest.json', import.meta.url), { cache: 'no-cache' }).then(async (response) => {
        if (!response.ok) throw new Error(`The runtime catalog is unavailable (HTTP ${response.status}).`);
        return response.json();
      }), loadDeployCatalog(),
    ]);
    catalog = pinnedCatalog = parseCatalog(manifest);
    deployCatalog = recipes;
    const jcbRecipe = await resolveDeployConfiguration({ deployId: 'jcb', joomlaVersion: catalog.defaults.joomlaVersion, admin: administrator() },
      { catalog, deployCatalog, baseURL: deploymentURL });
    pinnedJcb = pinnedJcbPackages(jcbRecipe.deploy);
    await refreshDynamicCatalog({ required: true });
    renderSavedSites();
    fillJoomlaOptions();
    fillOptions(fields.phpVersion, catalog.php);
    fillOptions(fields.deployId, deployCatalog.deploys);
    const hasOptions = Boolean(parsed.document) || new URL(location.href).hash.startsWith('#deploy=') || ['deploy', 'joomla', 'jcb', 'php', 'language', 'login', 'fresh', 'key', 'persist', 'path', 'initialPath', 'extensions', 'extension', 'commands', 'startupCommands', 'name', 'phpSettings', 'languageTags', 'menus', 'template'].some((name) => params.has(name));
    const keyed = parsed.config.storageKey && Object.hasOwn(savedState.sites, parsed.config.storageKey)
      ? savedState.sites[parsed.config.storageKey] : null;
    const previous = keyed || (!hasOptions && savedState.active ? savedState.sites[savedState.active] : null);
    let input = { ...(previous || {}), ...(previous?.deployId ? { deployId: previous.deployId } : {}), ...parsed.config, admin: administrator() };
    // Shared exact package configurations retain their identity; plain version
    // links resolve against the small catalog published with this deployment.
    if ((input.joomlaVersion && !input.joomlaPackage && !pinnedJoomlaVersion(input.joomlaVersion))
      || (input.jcbVersion && input.jcbVersion !== 'none' && !input.jcbPackage && ![...pinnedJcb.values()].some(entry => entry.version === input.jcbVersion))) {
      await refreshDynamicCatalog({ required: true });
      fillJoomlaOptions();
    }
    let resolved = await resolve(input);
    input.storageKey ||= defaultSiteKey(resolved.configuration.deployId, resolved.configuration.joomlaVersion);
    if (!hasOptions && !previous && !parsed.config.storageKey && !parsed.config.fresh) {
      const saved = findProfile(resolved.configuration.deployId, resolved.configuration.joomlaVersion);
      if (saved) input = { ...saved, ...parsed.config, admin: administrator() };
    }
    resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    selectedSiteId = resolved.configuration.persistence && savedState.sites[resolved.configuration.storageKey] ? resolved.configuration.storageKey : null;
    renderSavedSites();
    freshKeyPending = Boolean(parsed.config.fresh);
    initialized = true;
    setBusy(false);
    void refreshDynamicCatalog();
    setInterval(() => { if (!$('settings').hidden && !busy && !launching) void refreshDynamicCatalog(); }, catalogRefreshInterval);
    const shouldResume = Boolean(previous) && (!params.has('start') || parsed.autostart);
    // A saved installation already ran this exact reviewed setup. A shared link
    // that changes any executable source or custom content still needs consent.
    const reviewedSavedSetup = previous && JSON.stringify(customSetupDetails(previous)) === JSON.stringify(customSetupDetails(input));
    if (reviewedSavedSetup) approvedCustomSetup = JSON.stringify(customSetupDetails(input));
    activity(shouldResume ? 'Reopening your saved site…' : 'Ready to launch. Choose a starting point and your runtime versions.');
    if (deploymentNeedsReview(customReviewInput(parsed.config)) && !reviewedSavedSetup) {
      automaticLaunchPaused = true;
      feedback(t('help.customSetup'), { persistent: true });
      openEditor();
    } else if ((!params.has('start') || parsed.autostart) && !automaticLaunchPaused && !document.hidden) launchCountdown.start();
  } catch (error) {
    setBusy(false);
    displayError(error, t('title.error'));
    $('retry-button').hidden = true;
  }
}

setupInterface();
setBusy(false);
void initialize();
