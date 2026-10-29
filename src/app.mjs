import { resolveSiteURL, createShareURL, createDeploymentDocument, parseDeploymentDocument, loadDeploymentDocument, normalizeConfiguration, parseCatalog, readURLConfiguration } from './config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from './deploys.mjs';
import { createPlayground, prepareEnvironment, resetPlayground } from './playground.mjs';
import { defaultSiteKey, forgetSite, isolateSetup, publicConfiguration, readSavedState, rememberSite, runtimeLocation, savedStateKey } from './ui-state.mjs';

import { connectFrame } from './frame-view.mjs';
import { DEFAULT_PHP_SETTINGS, normalizePhpSettings } from './php-settings.mjs';
import { UI_LANGUAGES, getLocale, initializeLocale, setLocale, t } from './i18n.mjs';
import { createLaunchCountdown, deploymentNeedsReview } from './launch-countdown.mjs';

const $ = (id) => document.getElementById(id);
const deploymentURL = new URL('../', import.meta.url).href;
const preferenceKey = savedStateKey(deploymentURL);
const fields = {
  deployId: $('deploy'), phpVersion: $('php-version'), joomlaVersion: $('joomla-version'),
  language: $('language'), siteName: $('site-name'), initialPath: $('initial-path'), storageKey: $('storage-key'),
  persistence: $('persistence'), autoLogin: $('auto-login'), extensions: $('extensions'), startupCommands: $('startup-commands'),
};
const controls = ['save-button', 'restart-button', 'close-button', 'reset-button', 'share-button', 'export-button', 'export-format'];
const drafts = new Map();
let catalog, deployCatalog, runtime, currentConfig, currentInput;
let busy = false;
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
let pendingFresh = false;
let freshKeyPending = false;
let automaticLaunchPaused = false;
let approvedCustomSetup;
const launchCountdown = createLaunchCountdown({
  onTick(seconds) {
    $('launch-countdown').hidden = false;
    $('countdown-value').textContent = String(seconds);
    $('countdown-message').textContent = t('status.countdown', { seconds });
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
  const secret = $('admin-password').value;
  if (secret) text = text.split(secret).join('[password]');
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
  activity(t('status.countdownPaused'));
}
function approveCustomSetup(input) {
  if (!deploymentNeedsReview(input)) return true;
  const sources = [...(input.extensions || []).map(item => item.url), input.template?.url,
    ...(input.languages || []).map(item => item.url)].filter(Boolean);
  const commands = (input.startupCommands || []).map(command => command.join(' '));
  const custom = { sources, commands, extensions: input.extensions, template: input.template,
    languages: input.languages, content: input.content, menus: input.menus };
  const identity = JSON.stringify(custom);
  if (identity === approvedCustomSetup) return true;
  if (!confirm(`${t('confirm.customSetup')}\n\n${JSON.stringify(custom, null, 2)}`)) return false;
  approvedCustomSetup = identity;
  return true;
}
function openDialog(id) {
  pauseAutomaticLaunch();
  $('site-actions').open = false;
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
function setDrawer(open) {
  if (open) pauseAutomaticLaunch();
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-toggle').setAttribute('aria-label', t(open ? 'action.collapse' : 'action.expand'));
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
  $('open-link').removeAttribute('href');
}
function mountPreview(url) {
  const frame = document.createElement('iframe');
  frame.id = 'site-frame';
  frame.title = t('a11y.site');
  frame.referrerPolicy = 'same-origin';
  // Set the destination before attachment so a newly inserted blank document is never reused.
  frame.src = url;
  disconnectFrame();
  disconnectFrame = connectFrame(frame, { onNavigate: ({ url, signedOut }) => {
    if (runtime && url.startsWith(runtime.baseUrl)) currentSitePath = `/${url.slice(runtime.baseUrl.length)}`;
    $('credentials-button').dataset.signedOut = String(signedOut);
    $('credentials-button').textContent = `${t('title.credentials')}${signedOut ? ` · ${t('status.signedOut')}` : ''}`;
  } });
  $('site-mount').replaceChildren(frame);
  $('open-link').href = url;
  show('site-mount');
}
function updateMcpPreview() {
  $('deploy-mcp-preview').hidden = fields.deployId.value !== 'jcb-mcp';
  $('credentials-mcp-preview').hidden = !runtime || !(runtime.installation?.mcp || runtime.installation?.deployId === 'jcb-mcp');
}
function setBusy(value) {
  busy = value;
  const unavailable = !initialized || !catalog || !deployCatalog;
  $('configuration-fields').disabled = busy || unavailable;
  $('installation-fields').disabled = busy || unavailable;
  fields.persistence.disabled = busy || unavailable;
  $('launch-button').disabled = busy || Boolean(runtime) || unavailable;
  $('embedded-launch').disabled = busy || Boolean(runtime) || unavailable;
  $('retry-button').disabled = busy || unavailable;
  $('recover-button').disabled = busy || unavailable || !fields.persistence.checked;
  $('repair-button').hidden = !runtime?.recovery?.configured;
  $('repair-button').disabled = busy;
  $('error-reset-button').disabled = busy || unavailable || !fields.persistence.checked;
  $('new-site-button').disabled = busy || unavailable;
  $('saved-site').disabled = busy || unavailable || Object.keys(savedState.sites).length === 0;
  for (const id of controls) $(id).disabled = busy || !runtime;
  $('share-button').disabled = busy || unavailable;
  $('reset-button').disabled = busy || (!runtime && (unavailable || !fields.persistence.checked));
  $('save-button').disabled = busy || !runtime;
  $('download-dialog-button').disabled = busy || !runtime;
  const recoveryFormat = $('export-format').querySelector('[value="recovery"]');
  recoveryFormat.hidden = !runtime?.recovery;
  recoveryFormat.disabled = !runtime?.recovery;
  if (runtime?.recovery && !runtime.recovery.configured) $('export-format').value = 'recovery';
  else if (!runtime?.recovery && $('export-format').value === 'recovery') $('export-format').value = 'bundle';
  $('credentials-button').disabled = busy || !runtime || Boolean(runtime.recovery);
  $('php-settings-button').disabled = busy || unavailable;
  $('use-deploy').disabled = busy || unavailable;
  $('apply-deploy').disabled = busy || !runtime || Boolean(runtime.recovery);
  $('open-link').setAttribute('aria-disabled', String(Boolean(busy || !runtime || runtime.recovery)));
  $('preview-dot').className = `status-dot${busy ? ' busy' : runtime ? '' : ' muted'}`;
  $('launch-button').querySelector('span').textContent = t(busy ? 'status.working' : runtime ? 'status.running' : 'action.launch');
  $('launch-hint').textContent = t('help.firstLaunch');
  $('storage-note').textContent = t(fields.persistence.checked ? 'help.storage' : 'help.temporary');
  document.body.classList.toggle('running', Boolean(runtime));
  $('preview-label').textContent = runtime && currentConfig ? currentConfig.siteName : t('title.site');
  updateSaveState();
  updateMcpPreview();
}
function progress(event) {
  const details = typeof event === 'string' ? { message: event } : event;
  const message = details?.message || details?.phase || 'Preparing the playground…';
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
  $('error-title').textContent = title;
  $('error-message').textContent = messageOf(error);
  $('preview-dot').className = 'status-dot failed';
  feedback(error, { error: true, persistent: true });
  show('error-view');
  activity(error);
  $('error-view').focus();
}
async function recoverSite() {
  if (busy || !catalog || !deployCatalog || !fields.persistence.checked) return;
  pauseAutomaticLaunch();
  if (runtime) {
    try { await runtime.close(); } catch (error) { activity(error); }
    runtime = undefined;
  }
  setBusy(true);
  destroyPreview();
  show('loading-view');
  try {
    const input = currentInput || formInput();
    const resolved = await resolve(input);
    currentInput = input;
    currentConfig = resolved.configuration;
    runtime = await createPlayground(currentConfig, { recovery: true, onProgress: progress });
    clearFeedback();
    $('error-title').textContent = t('title.recovery');
    $('error-message').textContent = t('help.recovery');
    show('error-view');
    activity(t('help.recovery'));
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
  return normalizeConfiguration({
    ...extraDeploymentFields,
    deployId: fields.deployId.value,
    phpVersion: fields.phpVersion.value, joomlaVersion: fields.joomlaVersion.value,
    language: fields.language.value, siteName: fields.siteName.value,
    initialPath: fields.initialPath.value, storageKey: fields.storageKey.value,
    persistence: fields.persistence.checked, autoLogin: fields.autoLogin.checked,
    hideToolbar, fresh: pendingFresh, admin: administrator(),
    extensions: fields.extensions.value, startupCommands: fields.startupCommands.value,
    phpSettings, multilingual: $('multilingual').checked, languageTags: $('deploy-languages').value.split(',').map(value => value.trim()).filter(Boolean),
    menus: parseEditorJSON('deploy-menus', []), template: templateInput(), ...overrides,
  }, { catalog, baseURL: deploymentURL });
}
async function resolve(input) {
  return resolveDeployConfiguration(input, { catalog, deployCatalog, baseURL: deploymentURL });
}
function fillOptions(select, items) {
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.version ?? item.id;
    option.textContent = item.label ?? item.title ?? item.version;
    return option;
  }));
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
  for (const option of fields.deployId.options) { const descriptor = deployCatalog.deploys.find(item => item.id === option.value); option.disabled = Boolean(descriptor?.joomla && !descriptor.joomla.includes(major)); }
  const tags = [...new Set(['en-GB', ...(deployCatalog.languages?.[major] || []).map((item) => item.tag)])];
  $('language-options').replaceChildren(...tags.map((tag) => {
    const option = document.createElement('option');
    option.value = tag;
    return option;
  }));
}
function applyConfiguration(config, input = config, deploy) {
  extraDeploymentFields = Object.fromEntries(['content', 'languages'].filter(key => input[key] !== undefined).map(key => [key, structuredClone(input[key])]));
  templateOptions = structuredClone(input.template || config.template || {});
  for (const name of ['deployId', 'joomlaVersion', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language']) {
    if (config[name] !== undefined) fields[name].value = config[name];
  }
  fields.persistence.checked = config.persistence;
  fields.autoLogin.checked = config.autoLogin;
  fields.extensions.value = JSON.stringify(input.extensions || [], null, 2);
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
  hideToolbar = Boolean(config.hideToolbar);
  document.body.classList.toggle('embedded', hideToolbar);
  $('embedded-launch').hidden = false;
  $('editor-runtime-summary').textContent = `${config.deployId} · Joomla ${config.joomlaVersion} · PHP ${config.phpVersion}`;
  selectedProfile = { deployId: config.deployId, joomlaVersion: config.joomlaVersion };
  const description = deploy?.description ?? deployCatalog.deploys.find((item) => item.id === config.deployId)?.description;
  $('deploy-description').textContent = description || 'A verified Joomla installation with the selected setup steps.';
  updateCompatibility({ preserve: true });
}
function writePreferences() {
  renderSavedSites();
  try {
    if (!preferences) throw new Error('Browser preference storage is unavailable.');
    preferences.setItem(preferenceKey, JSON.stringify(savedState));
    return true;
  } catch {
    activity('Site data is available, but automatic-resume preferences could not be saved. Keep the site key to open it again.');
    return false;
  }
}
function renderSavedSites(selectedKey = runtime && currentConfig?.persistence ? currentConfig.storageKey : savedState.active) {
  const select = $('saved-site');
  const entries = Object.values(savedState.sites).reverse();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = t(entries.length ? 'status.chooseSavedSite' : 'status.noSavedSites');
  select.replaceChildren(empty, ...entries.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.storageKey;
    option.textContent = `${entry.siteName} · Joomla ${entry.joomlaVersion} · ${entry.storageKey}`;
    return option;
  }));
  select.value = selectedKey || '';
}
function rememberCurrentSite() {
  if (currentConfig?.persistence) {
    savedState = rememberSite(savedState, { ...currentInput, ...Object.fromEntries(['deployId', 'joomlaVersion', 'phpVersion', 'siteName', 'storageKey', 'persistence', 'language'].map((name) => [name, currentConfig[name]])) });
  } else {
    savedState = { ...savedState, active: null };
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
  if (busy || runtime || !initialized || !catalog || !deployCatalog) return;
  launchCountdown.stop();
  $('launch-countdown').hidden = true;
  try {
    if (!$('launch-form').checkValidity()) { setDrawer(true); openDialog('deploy-dialog'); $('advanced-settings').open = true; $('launch-form').reportValidity(); return; }
    let input = formInput();
    if (!approveCustomSetup(input)) return;
    clearFeedback();
    setBusy(true);
    show('loading-view');
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
    currentInput = input;
    currentConfig = resolved.configuration;
    $('preview-label').textContent = currentConfig.siteName;
    activity(`Starting ${resolved.deploy?.title || currentConfig.deployId} with Joomla ${currentConfig.joomlaVersion} and PHP ${currentConfig.phpVersion}.`);
    runtime = await createPlayground(currentConfig, { onProgress: progress });
    const siteURL = new URL(runtime.url, location.href);
    if (siteURL.origin !== location.origin) throw new Error('The playground returned an unexpected site origin.');
    applyAdministrator(runtime.installation?.administrator);
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
    mountPreview(siteURL.href);
    lastSavedAt = currentConfig.persistence ? new Date() : undefined;
    setDrawer(false);
    $('deploy-dialog').close();
    history.replaceState(null, '', runtimeLocation(location.href, currentInput));
    pendingFresh = false;
    freshKeyPending = false;
    currentInput.fresh = false;
    const resumeSaved = rememberCurrentSite();
    selectedProfile = { deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion };
    rememberDraft({ deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion });
    activity(recipe.changed ? `Site ready under “${currentConfig.storageKey}”. Your previous site is available in Saved sites.` : currentConfig.persistence
      ? resumeSaved ? 'Site ready. Reopening this playground will resume your saved site.' : `Site ready. Keep saved site key “${currentConfig.storageKey}” to reopen it.`
      : 'Temporary site ready. Download your work before closing.');
  } catch (error) {
    destroyPreview();
    if (runtime) {
      try { await runtime.close(); } catch (closeError) { activity(closeError); }
      runtime = undefined;
    }
    displayError(error);
  } finally {
    setBusy(false);
    if (!$('error-view').hidden) $('preview-dot').className = 'status-dot failed';
  }
}
async function closeSite({ reset = false, save = false } = {}) {
  if (busy || !runtime) return false;
  setBusy(true);
  closing = true;
  const handle = runtime;
  destroyPreview();
  try {
    if (save) { activity('Saving the current site before closing…'); await handle.flush(); }
    if (reset) await handle.reset();
    else await handle.close();
    runtime = undefined;
    if (reset) {
      savedState = forgetSite(savedState, currentConfig.storageKey);
      writePreferences();
      pendingFresh = false;
      freshKeyPending = false;
    }
    $('preview-label').textContent = t('title.site');
    clearFeedback();
    show('welcome');
    activity(reset ? 'Site files and database deleted. Launch to build a fresh site from its deploy.' : 'Site closed. Its saved data remains available.');
    return true;
  } catch (error) {
    runtime = handle.healthy ? handle : undefined;
    if (runtime) { mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); feedback(error, { error: true, persistent: true }); }
    else displayError(error);
    return false;
  } finally { closing = false; setBusy(false); }
}

async function newSite() {
  if (busy || !catalog || !deployCatalog) return;
  if (runtime && !currentConfig.persistence && !confirm(t('confirm.temporary'))) return;
  rememberDraft();
  if (runtime && !await closeSite({ save: currentConfig.persistence })) return;
  const label = deployCatalog.deploys.find((entry) => entry.id === fields.deployId.value)?.title || 'Joomla site';
  fields.storageKey.value = `${defaultSiteKey(fields.deployId.value, fields.joomlaVersion.value).slice(0, 44)}-site-${crypto.randomUUID().slice(0, 8)}`;
  fields.siteName.value = `${label.slice(0, 88)} ${Object.keys(savedState.sites).length + 1}`;
  $('admin-password').value = password();
  pendingFresh = false;
  freshKeyPending = false;
  renderSavedSites('');
  show('welcome');
  setBusy(false);
  activity(`Choose settings for new site “${fields.storageKey.value}”, then Launch. Your saved sites are preserved.`);
  openDialog('deploy-dialog');
  fields.siteName.focus();
}

async function openSavedSite(key) {
  if (busy || !Object.hasOwn(savedState.sites, key)) return;
  if (runtime && currentConfig.storageKey === key && currentConfig.persistence) return;
  if (runtime && !currentConfig.persistence && !confirm(t('confirm.temporary'))) {
    renderSavedSites(''); return;
  }
  if (runtime && !await closeSite({ save: currentConfig.persistence })) return;
  setBusy(true);
  try {
    const input = { ...savedState.sites[key], hideToolbar, admin: administrator() };
    const resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    freshKeyPending = false;
    show('welcome');
    $('retry-button').hidden = false;
    renderSavedSites(key);
  } catch (error) { displayError(error, t('title.error')); }
  finally { setBusy(false); }
  if ($('error-view').hidden) await launch();
}
async function changeProfile() {
  if (busy || !catalog) return;
  const major = fields.joomlaVersion.value.split('.')[0];
  const descriptor = deployCatalog.deploys.find(item => item.id === fields.deployId.value);
  if (descriptor?.joomla && !descriptor.joomla.includes(major)) fields.deployId.value = deployCatalog.defaultsByJoomla?.[major] || deployCatalog.default;
  const target = { deployId: fields.deployId.value, joomlaVersion: fields.joomlaVersion.value };
  const previous = selectedProfile;
  const wasRunning = Boolean(runtime);
  if (wasRunning && !currentConfig.persistence && !confirm(t('confirm.temporary'))) {
    fields.deployId.value = previous.deployId;
    fields.joomlaVersion.value = previous.joomlaVersion;
    return;
  }
  rememberDraft(previous);
  if (wasRunning && !await closeSite()) return;
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
      admin: { ...administrator(), ...(!stored ? { password: password() } : {}) },
    };
    applyAdministrator(input.admin);
    fields.storageKey.value = input.storageKey;
    const compatible = catalog.joomla.find((item) => item.version === target.joomlaVersion)?.php;
    if (!compatible?.includes(input.phpVersion)) input.phpVersion = compatible?.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : compatible?.[0];
    const resolved = await resolve(input);
    freshKeyPending = false;
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    show('welcome');
    $('retry-button').hidden = false;
    activity(`Selected ${resolved.deploy?.title || target.deployId}. Saved site key: ${resolved.configuration.storageKey}.`);
  } catch (error) { displayError(error, t('title.error')); }
  finally { setBusy(false); }
  if (wasRunning && $('error-view').hidden) await launch();
}

$('launch-form').addEventListener('submit', (event) => { event.preventDefault(); void launch(); });
$('embedded-launch').addEventListener('click', () => void launch());
$('retry-button').addEventListener('click', async () => { if (runtime && !await closeSite()) return; await launch(); });
$('close-button').addEventListener('click', () => { if (runtime && !currentConfig.persistence && !confirm(t('confirm.temporary'))) return; void closeSite(); });
$('new-site-button').addEventListener('click', () => void newSite());
$('saved-site').addEventListener('change', (event) => void openSavedSite(event.target.value));
$('restart-button').addEventListener('click', async () => {
  if (busy || !runtime) return;
  setBusy(true); destroyPreview(); show('loading-view');
  try { await runtime.updatePhpSettings(phpSettings); mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); feedback(t('status.ready')); }
  catch (error) { if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else displayError(error); feedback(error, { error: true }); }
  finally { setBusy(false); }
});
$('reset-button').addEventListener('click', () => void resetSite());
$('error-reset-button').addEventListener('click', () => void resetSite({ start: true }));
$('recover-button').addEventListener('click', () => void recoverSite());
$('repair-button').addEventListener('click', async () => {
  if (busy || !runtime?.recovery) return;
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
  if (!confirm(t('confirm.reset'))) return;
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
    const result = format === 'recovery' || (runtime.recovery && !runtime.recovery.configured)
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
fields.joomlaVersion.addEventListener('change', () => void changeProfile());
fields.phpVersion.addEventListener('change', async () => {
  if (busy || !runtime) return;
  const previous = currentConfig.phpVersion;
  setBusy(true); destroyPreview(); show('loading-view');
  try {
    await runtime.switchPhpVersion(fields.phpVersion.value);
    currentConfig = runtime.configuration;
    currentInput = { ...currentInput, phpVersion: currentConfig.phpVersion };
    rememberCurrentSite();
    mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
    history.replaceState(null, '', runtimeLocation(location.href, currentInput));
    feedback(t('status.ready'));
  } catch (error) { fields.phpVersion.value = previous; if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else displayError(error); feedback(error, { error: true }); }
  finally { setBusy(false); }
});
fields.persistence.addEventListener('change', async () => {
  if (!runtime) { setBusy(busy); return; }
  if (fields.persistence.checked && !currentConfig.persistence) await saveSite();
  else if (!fields.persistence.checked && currentConfig.persistence) {
    fields.persistence.checked = true;
    feedback(t('help.savedSites'));
  }
});
fields.storageKey.addEventListener('change', async () => {
  if (runtime || busy) return;
  const saved = Object.hasOwn(savedState.sites, fields.storageKey.value) ? savedState.sites[fields.storageKey.value] : undefined;
  if (!saved) return;
  setBusy(true);
  try {
    const resolved = await resolve({ ...saved, admin: administrator() });
    applyConfiguration(resolved.configuration, saved, resolved.deploy);
    show('welcome');
    activity(`Selected saved site “${saved.siteName}”. Launch to resume it.`);
  } catch (error) { displayError(error, t('title.error')); }
  finally { setBusy(false); }
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
    ['extensions', 'package-list', item => item.url],
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
  if (runtime?.discoverConfiguration && !busy) void runtime.discoverConfiguration().then(discovered => {
    $('component-options').replaceChildren(...[...new Set(discovered.menuTypes.map(item => item.component))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    $('template-options').replaceChildren(...[...new Set(discovered.templates.map(item => item.template))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '—';
    $('menu-preset').replaceChildren(empty, ...discovered.menuTypes.map(item => { const option = document.createElement('option'); option.value = JSON.stringify({component:item.component,view:item.view,layout:item.layout}); option.textContent = `${item.title || item.view} · ${item.component}${item.layout && item.layout !== 'default' ? ` / ${item.layout}` : ''}`; return option; }));
  }).catch(error => activity(error));
}
function editorError(error) { $('deploy-error').textContent = messageOf(error); $('deploy-error').hidden = false; }
async function saveSite({ quiet = false } = {}) {
  if (!runtime || busy) return false;
  const wasTemporary = !currentConfig.persistence;
  setBusy(true); $('save-state').textContent = t('status.saving');
  if (wasTemporary) { destroyPreview(); show('loading-view'); }
  try {
    if (wasTemporary) {
      runtime = await runtime.keep();
      currentConfig = runtime.configuration;
      currentInput = { ...currentInput, persistence: true, storageKey: currentConfig.storageKey };
      fields.storageKey.value = currentConfig.storageKey; fields.persistence.checked = true;
      mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
    } else await runtime.flush();
    lastSavedAt = new Date(); rememberCurrentSite();
    history.replaceState(null, '', runtimeLocation(location.href, currentInput));
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
  if (busy || !catalog) return;
  $('deploy-error').hidden = true;
  try {
    let input = formInput();
    if (!approveCustomSetup(input)) return;
    const wasRunning = Boolean(runtime);
    if (wasRunning) {
      if (!await saveSite()) return;
      if (!await closeSite()) return;
      input = { ...input, storageKey: `${defaultSiteKey(input.deployId, input.joomlaVersion).slice(0, 44)}-site-${crypto.randomUUID().slice(0, 8)}`, admin: { ...input.admin, password: password() } };
    }
    const resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy); applyAdministrator(input.admin);
    $('deploy-dialog').close();
    await launch();
    if (runtime) showShare(currentInput);
  } catch (error) { editorError(error); }
}
async function applyDeployment() {
  if (busy || !runtime) return;
  $('deploy-error').hidden = true;
  try {
    const input = formInput({ storageKey: currentConfig.storageKey, persistence: currentConfig.persistence, fresh: false });
    if (!approveCustomSetup(input)) return;
    const resolved = await resolve(input);
    setBusy(true); destroyPreview(); show('loading-view');
    await runtime.applyConfiguration(resolved.configuration);
    currentConfig = runtime.configuration; currentInput = input;
    applyConfiguration(currentConfig, currentInput, resolved.deploy);
    applyAdministrator(runtime.installation?.administrator);
    lastSavedAt = currentConfig.persistence ? new Date() : undefined;
    rememberCurrentSite();
    mountPreview(resolveSiteURL(currentConfig.initialPath, runtime.baseUrl));
    $('deploy-dialog').close(); feedback(t('status.ready'));
    history.replaceState(null, '', runtimeLocation(location.href, currentInput));
  } catch (error) {
    if (typeof error.recover === 'function') {
      try {
        const oldRuntime = runtime;
        runtime = await error.recover();
        currentConfig = runtime.configuration;
        currentInput = { ...currentInput, storageKey: currentConfig.storageKey, persistence: currentConfig.persistence };
        applyConfiguration(currentConfig, currentInput); rememberCurrentSite();
        history.replaceState(null, '', runtimeLocation(location.href, currentInput));
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
function setupInterface() {
  $('interface-language').replaceChildren(...UI_LANGUAGES.map(({ code, label }) => { const option = document.createElement('option'); option.value = code; option.textContent = label; return option; }));
  $('interface-language').value = getLocale();
  $('interface-language').addEventListener('change', async event => { try { await setLocale(event.target.value); } catch (error) { feedback(error, { error: true }); } });
  document.addEventListener('rocket:languagechange', () => {
    $('interface-language').value = getLocale();
    if (catalog) setBusy(busy);
    if (runtime && currentConfig) $('preview-label').textContent = currentConfig.siteName;
    $('credentials-button').textContent = `${t('title.credentials')}${$('credentials-button').dataset.signedOut === 'true' ? ` · ${t('status.signedOut')}` : ''}`;
    $('site-frame')?.setAttribute('title', t('a11y.site'));
    $('settings-toggle').setAttribute('aria-label', t($('settings').hidden ? 'action.expand' : 'action.collapse'));
    renderSavedSites(); renderEditorLists();
  });
  $('settings-toggle').addEventListener('click', () => setDrawer($('settings').hidden));
  for (const id of ['deploy-editor-button', 'welcome-configure', 'error-configure']) $(id).addEventListener('click', openEditor);
  $('editor-runtime-button').addEventListener('click', () => { $('deploy-dialog').close(); setDrawer(true); fields.deployId.focus(); });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
  }
  document.addEventListener('click', event => { if (!$('site-actions').contains(event.target)) $('site-actions').open = false; });
  $('information-button').addEventListener('click', () => openDialog('information-dialog'));
  $('download-dialog-button').addEventListener('click', () => openDialog('download-dialog'));
  $('credentials-button').addEventListener('click', () => {
    updateMcpPreview();
    $('credential-username').value = $('admin-username').value; $('credential-password').value = $('admin-password').value;
    $('credential-password').type = 'password'; $('reveal-credentials').textContent = t('action.show'); openDialog('credentials-dialog');
  });
  $('reveal-credentials').addEventListener('click', () => { const show = $('credential-password').type === 'password'; $('credential-password').type = show ? 'text' : 'password'; $('reveal-credentials').textContent = t(show ? 'action.hide' : 'action.show'); });
  $('copy-credentials').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('credential-password').value); feedback(t('status.passwordCopied')); } catch { $('credential-password').type = 'text'; $('credential-password').select(); feedback(t('error.clipboard'), { error: true }); } });
  $('go-administrator').addEventListener('click', () => { if (runtime) mountPreview(resolveSiteURL('/administrator/', runtime.baseUrl)); $('credentials-dialog').close(); });
  $('copy-share').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('share-url').value); $('share-feedback').textContent = t('status.copied'); } catch { $('share-url').focus(); $('share-url').select(); $('share-feedback').textContent = t('help.clipboard'); } });
  $('share-export-config').addEventListener('click', () => { try { downloadConfiguration(sharedConfiguration); } catch (error) { $('share-feedback').textContent = messageOf(error); } });
  $('native-share').addEventListener('click', async () => { try { await navigator.share({ title: sharedConfiguration?.siteName || 'JoomEngine Rocket', url: $('share-url').value }); } catch (error) { if (error.name !== 'AbortError') $('share-feedback').textContent = messageOf(error); } });
  $('add-package').addEventListener('click', () => { try { const url = $('package-url').value.trim(); if (!url) return; const items = parseEditorJSON('extensions', []); items.push({ url }); fields.extensions.value = JSON.stringify(items, null, 2); formInput(); $('package-url').value = ''; renderEditorLists(); } catch (error) { editorError(error); } });
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
  for (const id of ['extensions', 'deploy-menus']) $(id).addEventListener('change', renderEditorLists);
  $('use-deploy').addEventListener('click', () => void useDeployment());
  $('apply-deploy').addEventListener('click', () => void applyDeployment());
  $('export-config').addEventListener('click', () => { try { downloadConfiguration(); } catch (error) { editorError(error); } });
  $('import-config').addEventListener('change', async event => { try {
    const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new RangeError('The deployment document exceeds 1 MiB.');
    const input = { ...parseDeploymentDocument(await file.text()), admin: administrator() };
    const resolved = await resolve(input); applyConfiguration(resolved.configuration, input, resolved.deploy); openEditor();
  } catch (error) { editorError(error); } finally { event.target.value = ''; } });
  $('php-settings-button').addEventListener('click', () => { populatePhpSettings(); openDialog('php-dialog'); });
  $('reset-php').addEventListener('click', () => populatePhpSettings(DEFAULT_PHP_SETTINGS));
  $('php-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    $('php-error').hidden = true;
    try {
      const settings = normalizePhpSettings(Object.fromEntries(new FormData(event.target)));
      if (runtime) {
        setBusy(true); destroyPreview(); show('loading-view');
        await runtime.updatePhpSettings(settings);
        currentConfig = runtime.configuration; currentInput = { ...currentInput, phpSettings: settings };
        rememberCurrentSite(); mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
        history.replaceState(null, '', runtimeLocation(location.href, currentInput));
      }
      phpSettings = settings; $('php-dialog').close(); feedback(t('status.ready'));
    } catch (error) { $('php-error').textContent = messageOf(error); $('php-error').hidden = false; if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else if (runtime) displayError(error); }
    finally { setBusy(false); }
  });
  $('open-link').addEventListener('click', async event => {
    event.preventDefault(); if (!runtime || runtime.recovery || busy) return;
    try {
      setBusy(true); destroyPreview(); show('loading-view'); await runtime.openStandalone({ path: currentSitePath });
      destroyPreview(); runtime = undefined; show('welcome'); feedback(t('status.closed'));
    } catch (error) {
      if (error.recovery) {
        try {
          runtime = await createPlayground(error.recovery.configuration, { checkpoint: error.recovery.checkpoint, onProgress: progress });
          currentConfig = runtime.configuration; currentInput = { ...currentInput, storageKey: currentConfig.storageKey, persistence: currentConfig.persistence };
          applyConfiguration(currentConfig, currentInput); rememberCurrentSite();
          history.replaceState(null, '', runtimeLocation(location.href, currentInput));
        } catch (recoveryError) { runtime = undefined; displayError(recoveryError); }
      }
      if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
      else if (runtime?.closed) runtime = undefined;
      feedback(error, { error: true, persistent: true });
    }
    finally { setBusy(false); }
  });
  for (const event of ['input', 'change']) $('launch-form').addEventListener(event, pauseAutomaticLaunch);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAutomaticLaunch(); });
  setInterval(() => { if (runtime && !runtime.recovery && !runtime.changing && currentConfig?.persistence && !busy && document.visibilityState === 'visible') void saveSite({ quiet: true }); }, 60000);
}

async function initialize() {
  try {
    await initializeLocale();
    $('interface-language').value = getLocale();
    const parsed = readURLConfiguration(location.href);
    if (parsed.document) parsed.config = { ...await loadDeploymentDocument(parsed.document.url, { ...parsed.document, baseURL: deploymentURL }), ...parsed.config };
    const params = new URL(location.href).searchParams;
    hideToolbar = Boolean(parsed.config.hideToolbar);
    document.body.classList.toggle('embedded', hideToolbar);
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
    catalog = parseCatalog(manifest);
    deployCatalog = recipes;
    renderSavedSites();
    fillOptions(fields.joomlaVersion, catalog.joomla);
    fillOptions(fields.phpVersion, catalog.php);
    fillOptions(fields.deployId, deployCatalog.deploys);
    const hasOptions = Boolean(parsed.document) || new URL(location.href).hash.startsWith('#deploy=') || ['deploy', 'joomla', 'php', 'language', 'login', 'fresh', 'key', 'persist', 'path', 'initialPath', 'extensions', 'extension', 'commands', 'startupCommands', 'name', 'phpSettings', 'languageTags', 'menus', 'template'].some((name) => params.has(name));
    const keyed = parsed.config.storageKey && Object.hasOwn(savedState.sites, parsed.config.storageKey)
      ? savedState.sites[parsed.config.storageKey] : null;
    const previous = keyed || (!hasOptions && savedState.active ? savedState.sites[savedState.active] : null);
    let input = { ...(previous || {}), ...(previous?.deployId ? { deployId: previous.deployId } : {}), ...parsed.config, admin: administrator() };
    let resolved = await resolve(input);
    input.storageKey ||= defaultSiteKey(resolved.configuration.deployId, resolved.configuration.joomlaVersion);
    if (!previous && !parsed.config.storageKey && !parsed.config.fresh) {
      const saved = findProfile(resolved.configuration.deployId, resolved.configuration.joomlaVersion);
      if (saved) input = { ...saved, ...parsed.config, admin: administrator() };
    }
    resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    freshKeyPending = Boolean(parsed.config.fresh);
    initialized = true;
    setBusy(false);
    const shouldResume = Boolean(previous) && (!params.has('start') || parsed.autostart);
    activity(shouldResume ? 'Reopening your saved site…' : 'Ready to launch. Choose a starting point and your runtime versions.');
    if (deploymentNeedsReview(parsed.config)) {
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
