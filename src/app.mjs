import { createShareURL, normalizeConfiguration, parseCatalog, readURLConfiguration } from './config.mjs';
import { loadBlueprintCatalog, resolveBlueprintConfiguration } from './blueprints.mjs';
import { createPlayground, prepareEnvironment, resetPlayground } from './playground.mjs';
import { defaultSiteKey, forgetSite, publicConfiguration, readSavedState, rememberSite, runtimeLocation, savedStateKey } from './ui-state.mjs';

const $ = (id) => document.getElementById(id);
const deploymentURL = new URL('../', import.meta.url).href;
const preferenceKey = savedStateKey(deploymentURL);
const fields = {
  blueprintId: $('blueprint'), phpVersion: $('php-version'), joomlaVersion: $('joomla-version'),
  language: $('language'), siteName: $('site-name'), initialPath: $('initial-path'), storageKey: $('storage-key'),
  persistence: $('persistence'), autoLogin: $('auto-login'), extensions: $('extensions'), startupCommands: $('startup-commands'),
};
const controls = ['save-button', 'restart-button', 'close-button', 'reset-button', 'share-button', 'export-button', 'export-format'];
const drafts = new Map();
let catalog, blueprintCatalog, runtime, currentConfig, currentInput;
let busy = false;
let closing = false;
let selectedProfile;
let hideToolbar = false;
let pendingFresh = false;
let freshKeyPending = false;
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
}
function destroyPreview() {
  // Removing the old document avoids both late requests and transitions to a blank page.
  $('site-mount').replaceChildren();
  $('site-mount').hidden = true;
  $('open-link').removeAttribute('href');
}
function mountPreview(url) {
  const frame = document.createElement('iframe');
  frame.id = 'site-frame';
  frame.title = 'Your Joomla playground';
  frame.referrerPolicy = 'same-origin';
  frame.allow = 'clipboard-write';
  // Set the destination before attachment so a newly inserted blank document is never reused.
  frame.src = url;
  $('site-mount').replaceChildren(frame);
  $('open-link').href = url;
  show('site-mount');
}
function setBusy(value) {
  busy = value;
  const unavailable = !catalog || !blueprintCatalog;
  $('configuration-fields').disabled = busy || unavailable;
  $('installation-fields').disabled = busy || unavailable;
  for (const input of $('installation-fields').querySelectorAll('input:not([type="checkbox"]),textarea')) input.readOnly = Boolean(runtime);
  fields.autoLogin.disabled = busy || Boolean(runtime) || unavailable;
  fields.language.disabled = busy || Boolean(runtime) || unavailable;
  fields.persistence.disabled = busy || Boolean(runtime) || unavailable;
  $('launch-button').disabled = busy || Boolean(runtime) || unavailable;
  $('embedded-launch').disabled = busy || Boolean(runtime) || unavailable;
  $('retry-button').disabled = busy || unavailable;
  for (const id of controls) $(id).disabled = busy || !runtime;
  $('reset-button').disabled = busy || (!runtime && (unavailable || !fields.persistence.checked));
  $('save-button').disabled = busy || !runtime || !currentConfig?.persistence;
  $('open-link').setAttribute('aria-disabled', String(busy || !runtime));
  $('preview-dot').className = `status-dot${busy ? ' busy' : runtime ? '' : ' muted'}`;
  $('launch-button').querySelector('span').textContent = busy ? 'Working…' : runtime ? 'Site is running' : 'Launch playground';
  $('launch-hint').textContent = runtime
    ? 'Change PHP to restart this site with another runtime. Selecting Joomla or a blueprint opens a separate site.'
    : 'The first launch downloads the runtime and installs your selected blueprint.';
  $('storage-note').textContent = fields.persistence.checked
    ? 'Files and database stay in this browser. Download a backup to keep a separate copy.'
    : 'This is a temporary site. Download your work before closing or changing its runtime.';
  document.body.classList.toggle('running', Boolean(runtime));
}
function progress(event) {
  const details = typeof event === 'string' ? { message: event } : event;
  const message = details?.message || details?.phase || 'Preparing the playground…';
  if (details?.phase === 'failed' && runtime && !closing) {
    destroyPreview();
    displayError(new Error(message), 'The PHP session stopped');
    return;
  }
  $('loading-message').textContent = messageOf(message);
  if (typeof details?.progress === 'number' && Number.isFinite(details.progress)) {
    $('loading-progress').max = 1;
    $('loading-progress').value = Math.max(0, Math.min(1, details.progress));
  } else $('loading-progress').removeAttribute('value');
  activity(message);
}
function displayError(error, title = 'The playground couldn’t start') {
  $('error-title').textContent = title;
  $('error-message').textContent = messageOf(error);
  $('preview-dot').className = 'status-dot failed';
  show('error-view');
  activity(error);
  $('error-view').focus();
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
    blueprintId: fields.blueprintId.value,
    phpVersion: fields.phpVersion.value, joomlaVersion: fields.joomlaVersion.value,
    language: fields.language.value, siteName: fields.siteName.value,
    initialPath: fields.initialPath.value, storageKey: fields.storageKey.value,
    persistence: fields.persistence.checked, autoLogin: fields.autoLogin.checked,
    hideToolbar, fresh: pendingFresh, admin: administrator(),
    extensions: fields.extensions.value, startupCommands: fields.startupCommands.value, ...overrides,
  }, { catalog, baseURL: deploymentURL });
}
async function resolve(input) {
  return resolveBlueprintConfiguration(input, { catalog, blueprintCatalog, baseURL: deploymentURL });
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
  const tags = [...new Set(['en-GB', ...(blueprintCatalog.languages?.[major] || []).map((item) => item.tag)])];
  $('language-options').replaceChildren(...tags.map((tag) => {
    const option = document.createElement('option');
    option.value = tag;
    return option;
  }));
}
function applyConfiguration(config, input = config, blueprint) {
  for (const name of ['blueprintId', 'joomlaVersion', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language']) {
    if (config[name] !== undefined) fields[name].value = config[name];
  }
  fields.persistence.checked = config.persistence;
  fields.autoLogin.checked = config.autoLogin;
  fields.extensions.value = JSON.stringify(input.extensions || [], null, 2);
  fields.startupCommands.value = JSON.stringify(input.startupCommands || [], null, 2);
  pendingFresh = Boolean(config.fresh);
  hideToolbar = Boolean(config.hideToolbar);
  document.body.classList.toggle('embedded', hideToolbar);
  $('embedded-launch').hidden = !hideToolbar;
  selectedProfile = { blueprintId: config.blueprintId, joomlaVersion: config.joomlaVersion };
  const description = blueprint?.description ?? blueprintCatalog.blueprints.find((item) => item.id === config.blueprintId)?.description;
  $('blueprint-description').textContent = description || 'A verified Joomla installation with the selected setup steps.';
  updateCompatibility({ preserve: true });
}
function writePreferences() {
  try {
    if (!preferences) throw new Error('Browser preference storage is unavailable.');
    preferences.setItem(preferenceKey, JSON.stringify(savedState));
    return true;
  } catch {
    activity('Site data is available, but automatic-resume preferences could not be saved. Keep the site key to open it again.');
    return false;
  }
}
function rememberCurrentSite() {
  if (currentConfig?.persistence) {
    savedState = rememberSite(savedState, { ...currentInput, ...Object.fromEntries(['blueprintId', 'joomlaVersion', 'phpVersion', 'siteName', 'storageKey', 'persistence', 'language'].map((name) => [name, currentConfig[name]])) });
  } else {
    savedState = { ...savedState, active: null };
    if (!preferences) return true;
  }
  return writePreferences();
}
function rememberDraft(profile = selectedProfile) {
  if (!profile) return;
  try { drafts.set(`${profile.blueprintId}:${profile.joomlaVersion}`, publicConfiguration(formInput(profile))); } catch { /* Invalid unfinished fields stay visible until the user corrects them. */ }
}
function findProfile(blueprintId, joomlaVersion) {
  return drafts.get(`${blueprintId}:${joomlaVersion}`)
    || Object.values(savedState.sites).reverse().find((item) => item.blueprintId === blueprintId && item.joomlaVersion === joomlaVersion);
}
async function launch() {
  if (busy || runtime || !catalog || !blueprintCatalog) return;
  try {
    if (!$('launch-form').reportValidity()) return;
    setBusy(true);
    show('loading-view');
    $('loading-title').textContent = 'Preparing your playground';
    $('loading-progress').removeAttribute('value');
    let input = formInput();
    if (freshKeyPending) {
      input.storageKey = `${defaultSiteKey(input.blueprintId, input.joomlaVersion).slice(0, 44)}-fresh-${crypto.randomUUID().slice(0, 8)}`;
      fields.storageKey.value = input.storageKey;
    }
    const resolved = await resolve(input);
    currentInput = input;
    currentConfig = resolved.configuration;
    $('preview-label').textContent = currentConfig.siteName;
    activity(`Starting ${resolved.blueprint?.title || currentConfig.blueprintId} with Joomla ${currentConfig.joomlaVersion} and PHP ${currentConfig.phpVersion}.`);
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
    if (runtime.installation?.blueprintId && blueprintCatalog.blueprints.some((item) => item.id === runtime.installation.blueprintId)) {
      currentConfig.blueprintId = runtime.installation.blueprintId;
      currentInput.blueprintId = currentConfig.blueprintId;
      fields.blueprintId.value = currentConfig.blueprintId;
    }
    $('preview-label').textContent = currentConfig.siteName;
    mountPreview(siteURL.href);
    history.replaceState(null, '', runtimeLocation(location.href, currentInput));
    pendingFresh = false;
    freshKeyPending = false;
    currentInput.fresh = false;
    const resumeSaved = rememberCurrentSite();
    selectedProfile = { blueprintId: currentConfig.blueprintId, joomlaVersion: currentConfig.joomlaVersion };
    rememberDraft({ blueprintId: currentConfig.blueprintId, joomlaVersion: currentConfig.joomlaVersion });
    activity(currentConfig.persistence
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
async function closeSite({ reset = false } = {}) {
  if (busy || !runtime) return false;
  setBusy(true);
  closing = true;
  const handle = runtime;
  destroyPreview();
  try {
    if (reset) await handle.reset();
    else await handle.close();
    runtime = undefined;
    if (reset) {
      savedState = forgetSite(savedState, currentConfig.storageKey);
      writePreferences();
      pendingFresh = true;
      freshKeyPending = false;
    }
    $('preview-label').textContent = 'Your playground';
    show('welcome');
    activity(reset ? 'Site files and database deleted. Launch to build a fresh site from its blueprint.' : 'Site closed. Its saved data remains available.');
    return true;
  } catch (error) {
    runtime = undefined;
    displayError(error, reset ? 'The saved site could not be reset' : 'The site could not be closed');
    return false;
  } finally { closing = false; setBusy(false); }
}
async function changeProfile() {
  if (busy || !catalog) return;
  const target = { blueprintId: fields.blueprintId.value, joomlaVersion: fields.joomlaVersion.value };
  const previous = selectedProfile;
  const wasRunning = Boolean(runtime);
  if (wasRunning && !currentConfig.persistence && !confirm('Changing the starting point creates a fresh temporary site. Download your work first if you want to keep it. Continue?')) {
    fields.blueprintId.value = previous.blueprintId;
    fields.joomlaVersion.value = previous.joomlaVersion;
    return;
  }
  rememberDraft(previous);
  if (wasRunning && !await closeSite()) return;
  setBusy(true);
  try {
    const stored = findProfile(target.blueprintId, target.joomlaVersion);
    const input = {
      ...(stored || {}), ...target,
      phpVersion: fields.phpVersion.value,
      persistence: stored?.persistence ?? fields.persistence.checked,
      hideToolbar,
      ...(!stored && target.blueprintId === previous?.blueprintId ? { language: fields.language.value } : {}),
      storageKey: stored?.storageKey || defaultSiteKey(target.blueprintId, target.joomlaVersion),
      admin: administrator(),
    };
    fields.storageKey.value = input.storageKey;
    const compatible = catalog.joomla.find((item) => item.version === target.joomlaVersion)?.php;
    if (!compatible?.includes(input.phpVersion)) input.phpVersion = compatible?.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : compatible?.[0];
    const resolved = await resolve(input);
    freshKeyPending = false;
    applyConfiguration(resolved.configuration, input, resolved.blueprint);
    show('welcome');
    $('retry-button').hidden = false;
    activity(`Selected ${resolved.blueprint?.title || target.blueprintId}. Saved site key: ${resolved.configuration.storageKey}.`);
  } catch (error) { displayError(error, 'This starting point is not available'); }
  finally { setBusy(false); }
  if (wasRunning && $('error-view').hidden) await launch();
}

$('launch-form').addEventListener('submit', (event) => { event.preventDefault(); void launch(); });
$('embedded-launch').addEventListener('click', () => void launch());
$('retry-button').addEventListener('click', async () => { if (runtime && !await closeSite()) return; await launch(); });
$('close-button').addEventListener('click', () => void closeSite());
$('restart-button').addEventListener('click', async () => {
  if (currentConfig && !currentConfig.persistence && !confirm('Restarting creates a fresh temporary site. Download your work first if you want to keep it. Continue?')) return;
  if (await closeSite()) await launch();
});
$('reset-button').addEventListener('click', async () => {
  if (busy) return;
  const label = runtime ? currentConfig.siteName : `saved site key ${fields.storageKey.value}`;
  if (!confirm(`Delete the files and database for “${label}”? This cannot be undone.`)) return;
  if (runtime) { await closeSite({ reset: true }); return; }
  setBusy(true);
  try {
    await resetPlayground({ storageKey: fields.storageKey.value });
    savedState = forgetSite(savedState, fields.storageKey.value);
    writePreferences();
    pendingFresh = true;
    freshKeyPending = false;
    show('welcome');
    activity('Saved data deleted. Launch to build a fresh site from its blueprint.');
  } catch (error) { displayError(error, 'The saved site could not be reset'); }
  finally { setBusy(false); }
});
$('save-button').addEventListener('click', async () => {
  if (!runtime || busy) return;
  setBusy(true);
  try { await runtime.flush(); rememberCurrentSite(); activity('Files and database saved to browser storage.'); }
  catch (error) { activity(`Save failed: ${messageOf(error)}`); }
  finally { setBusy(false); }
});
$('export-button').addEventListener('click', async () => {
  if (!runtime || busy) return;
  setBusy(true);
  const format = $('export-format').value;
  activity('Preparing your download…');
  try {
    const result = await runtime.exportSite({ format, onProgress: (event) => activity(event.message || event) });
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
  } catch (error) { activity(`Download failed: ${messageOf(error)}`); }
  finally { setBusy(false); }
});
$('share-button').addEventListener('click', async () => {
  if (!currentInput) return;
  const url = createShareURL(location.href, currentInput);
  try {
    await navigator.clipboard.writeText(url);
    activity('Link copied with the blueprint and setup options. Site data and administrator credentials are not shared.');
  } catch { prompt('Copy this blueprint link. It includes setup options, but no site data or administrator credentials.', url); }
});
$('show-password').addEventListener('click', () => {
  const visible = $('admin-password').type === 'password';
  $('admin-password').type = visible ? 'text' : 'password';
  $('show-password').textContent = visible ? 'Hide' : 'Show';
  $('show-password').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('show-password').setAttribute('aria-pressed', String(visible));
});
$('log-toggle').addEventListener('click', () => {
  const expanded = $('activity-log').hidden;
  $('activity-log').hidden = !expanded;
  $('log-toggle').setAttribute('aria-expanded', String(expanded));
});
fields.blueprintId.addEventListener('change', () => void changeProfile());
fields.joomlaVersion.addEventListener('change', () => void changeProfile());
fields.phpVersion.addEventListener('change', async () => {
  if (busy || !runtime) return;
  if (!currentConfig.persistence && !confirm('Changing PHP creates a fresh temporary site. Download your work first if you want to keep it. Continue?')) {
    fields.phpVersion.value = currentConfig.phpVersion;
    return;
  }
  if (await closeSite()) await launch();
});
fields.persistence.addEventListener('change', () => setBusy(busy));
fields.storageKey.addEventListener('change', async () => {
  if (runtime || busy) return;
  const saved = Object.hasOwn(savedState.sites, fields.storageKey.value) ? savedState.sites[fields.storageKey.value] : undefined;
  if (!saved) return;
  setBusy(true);
  try {
    const resolved = await resolve({ ...saved, admin: administrator() });
    applyConfiguration(resolved.configuration, saved, resolved.blueprint);
    show('welcome');
    activity(`Selected saved site “${saved.siteName}”. Launch to resume it.`);
  } catch (error) { displayError(error, 'This saved configuration is unavailable'); }
  finally { setBusy(false); }
});

async function initialize() {
  try {
    const parsed = readURLConfiguration(location.href);
    const params = new URL(location.href).searchParams;
    hideToolbar = Boolean(parsed.config.hideToolbar);
    document.body.classList.toggle('embedded', hideToolbar);
    $('embedded-launch').hidden = !hideToolbar;
    activity('Preparing browser support for PHP and MariaDB…');
    const environment = await prepareEnvironment();
    const reloadMarker = `joomengine:environment-reload:${deploymentURL}`;
    if (environment.reloadRequired) {
      let previousReload;
      try { previousReload = sessionStorage.getItem(reloadMarker); sessionStorage.setItem(reloadMarker, '1'); }
      catch { throw new Error('Allow session storage for this page, then reload to enable the browser database runtime.'); }
      if (previousReload) throw new Error('This browser or host could not enable cross-origin isolation. Use HTTPS and allow service workers.');
      location.reload(); return;
    }
    try { sessionStorage.removeItem(reloadMarker); } catch { /* Already-isolated temporary sites need no saved preference. */ }
    if (!globalThis.crossOriginIsolated) throw new Error('This browser or host does not support the isolation required by MariaDB.');
    $('admin-password').value = password();
    const [manifest, recipes] = await Promise.all([
      fetch(new URL('../assets/manifest.json', import.meta.url), { cache: 'no-cache' }).then(async (response) => {
        if (!response.ok) throw new Error(`The runtime catalog is unavailable (HTTP ${response.status}).`);
        return response.json();
      }), loadBlueprintCatalog(),
    ]);
    catalog = parseCatalog(manifest);
    blueprintCatalog = recipes;
    fillOptions(fields.joomlaVersion, catalog.joomla);
    fillOptions(fields.phpVersion, catalog.php);
    fillOptions(fields.blueprintId, blueprintCatalog.blueprints);
    const hasOptions = ['blueprint', 'joomla', 'php', 'language', 'login', 'fresh', 'key', 'persist', 'path', 'initialPath', 'extensions', 'extension', 'commands', 'startupCommands'].some((name) => params.has(name));
    const keyed = parsed.config.storageKey && Object.hasOwn(savedState.sites, parsed.config.storageKey)
      ? savedState.sites[parsed.config.storageKey] : null;
    const previous = keyed || (!hasOptions && savedState.active ? savedState.sites[savedState.active] : null);
    let input = { ...(previous || {}), blueprintId: previous?.blueprintId || blueprintCatalog.default, ...parsed.config, admin: administrator() };
    let resolved = await resolve(input);
    input.storageKey ||= defaultSiteKey(resolved.configuration.blueprintId, resolved.configuration.joomlaVersion);
    if (!previous && !parsed.config.storageKey && !parsed.config.fresh) {
      const saved = findProfile(resolved.configuration.blueprintId, resolved.configuration.joomlaVersion);
      if (saved) input = { ...saved, ...parsed.config, admin: administrator() };
    }
    resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.blueprint);
    freshKeyPending = Boolean(parsed.config.fresh);
    setBusy(false);
    const shouldResume = Boolean(previous) && (!params.has('start') || parsed.autostart);
    activity(shouldResume ? 'Reopening your saved site…' : 'Ready to launch. Choose a starting point and your runtime versions.');
    if (!params.has('start') || parsed.autostart) await launch();
  } catch (error) {
    setBusy(false);
    displayError(error, 'The playground is not ready');
    $('retry-button').hidden = true;
  }
}

void initialize();
