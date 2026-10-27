import { DEFAULTS, createShareURL, normalizeConfiguration, parseCatalog, readURLConfiguration } from './config.mjs';
import { createPlayground, prepareEnvironment, resetPlayground } from './playground.mjs';

const $ = (id) => document.getElementById(id);
const fields = {
  phpVersion: $('php-version'), joomlaVersion: $('joomla-version'), siteName: $('site-name'),
  initialPath: $('initial-path'), storageKey: $('storage-key'), persistence: $('persistence'),
  autoLogin: $('auto-login'), extensions: $('extensions'), startupCommands: $('startup-commands'),
};
const controls = ['save-button', 'restart-button', 'close-button', 'reset-button', 'share-button'];
const extensionConfigurations = new Map();
let catalog;
let runtime;
let currentConfig;
let busy = false;
let selectedJoomla;
let urlConfiguration = {};
let autostart = false;

function password() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `Jp!${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
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
  for (const name of ['welcome', 'loading-view', 'error-view', 'site-frame']) $(name).hidden = name !== view;
}

function setBusy(value) {
  busy = value;
  $('configuration-fields').disabled = busy || Boolean(runtime) || !catalog;
  $('launch-button').disabled = busy || Boolean(runtime) || !catalog;
  $('embedded-launch').disabled = busy || !catalog;
  $('retry-button').disabled = busy || !catalog;
  for (const id of controls) $(id).disabled = busy || !runtime;
  $('reset-button').disabled = busy || (!runtime && (!catalog || !fields.persistence.checked));
  $('save-button').disabled = busy || !runtime || !currentConfig?.persistence;
  $('open-link').setAttribute('aria-disabled', String(busy || !runtime));
  $('preview-dot').className = `status-dot${busy ? ' busy' : runtime ? '' : ' muted'}`;
  $('launch-button').querySelector('span').textContent = busy ? 'Preparing playground…' : runtime ? 'Playground is running' : 'Launch playground';
  $('launch-hint').textContent = runtime ? 'Close the site to change its configuration.' : 'The first launch downloads the runtime and Joomla.';
  document.body.classList.toggle('running', Boolean(runtime));
}

function progress(event) {
  const details = typeof event === 'string' ? { message: event } : event;
  const message = details?.message || details?.phase || 'Preparing the playground…';
  if (details?.phase === 'failed' && runtime) {
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

function configuration() {
  return normalizeConfiguration({
    phpVersion: fields.phpVersion.value,
    joomlaVersion: fields.joomlaVersion.value,
    siteName: fields.siteName.value,
    initialPath: fields.initialPath.value,
    storageKey: fields.storageKey.value,
    persistence: fields.persistence.checked,
    autoLogin: fields.autoLogin.checked,
    hideToolbar: Boolean(urlConfiguration.hideToolbar),
    admin: {
      name: $('admin-name').value,
      username: $('admin-username').value,
      email: $('admin-email').value,
      password: $('admin-password').value,
    },
    extensions: fields.extensions.value,
    startupCommands: fields.startupCommands.value,
  }, { catalog, baseURL: location.href });
}

async function launch() {
  if (busy || runtime || !catalog) return;
  try {
    if (!$('launch-form').reportValidity()) return;
    currentConfig = configuration();
    setBusy(true);
    show('loading-view');
    $('loading-title').textContent = 'Preparing your playground';
    $('loading-progress').removeAttribute('value');
    $('preview-label').textContent = currentConfig.siteName;
    activity(`Starting Joomla ${currentConfig.joomlaVersion} with PHP ${currentConfig.phpVersion}.`);
    runtime = await createPlayground(currentConfig, { onProgress: progress });
    const siteURL = new URL(runtime.url, location.href);
    if (siteURL.origin !== location.origin) throw new Error('The playground returned an unexpected site origin.');
    $('site-frame').src = siteURL.href;
    $('open-link').href = siteURL.href;
    show('site-frame');
    activity(currentConfig.persistence ? 'Site is ready. Files and database use browser storage.' : 'Site is ready. This session is temporary.');
  } catch (error) {
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
  const handle = runtime;
  // Destroy the site document before shutting down its workers. Navigating it
  // to a blank page can start a cross-document transition and late requests.
  const frame = $('site-frame');
  const emptyFrame = frame.cloneNode(false);
  emptyFrame.removeAttribute('src');
  emptyFrame.hidden = true;
  frame.replaceWith(emptyFrame);
  $('open-link').removeAttribute('href');
  try {
    if (reset) await handle.reset();
    else await handle.close();
    runtime = undefined;
    $('preview-label').textContent = 'Your playground';
    show('welcome');
    activity(reset ? 'Site data was deleted. Launch to create a fresh installation.' : 'Site closed. You can now change its settings.');
    return true;
  } catch (error) {
    runtime = undefined;
    activity(`Could not ${reset ? 'reset' : 'close'} the site: ${messageOf(error)}`);
    return false;
  } finally { setBusy(false); }
}

function fillVersions(select, items) {
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.version;
    option.textContent = item.label;
    return option;
  }));
}

function updateCompatibility({ preserve = false } = {}) {
  const joomla = catalog.joomla.find((entry) => entry.version === fields.joomlaVersion.value);
  if (!joomla) throw new Error('The selected Joomla version is not in the runtime catalog.');
  for (const option of fields.phpVersion.options) option.disabled = !joomla.php.includes(option.value);
  if (!joomla.php.includes(fields.phpVersion.value)) {
    if (preserve) throw new Error('The selected PHP and Joomla versions are not compatible. Choose an available combination.');
    fields.phpVersion.value = joomla.php.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : joomla.php[0];
  }
  $('compatibility-note').textContent = `${joomla.label} supports the listed PHP versions.`;
}

$('launch-form').addEventListener('submit', (event) => { event.preventDefault(); void launch(); });
$('embedded-launch').addEventListener('click', () => void launch());
$('retry-button').addEventListener('click', async () => {
  if (runtime && !await closeSite()) return;
  await launch();
});
$('close-button').addEventListener('click', () => void closeSite());
$('restart-button').addEventListener('click', async () => {
  if (currentConfig && !currentConfig.persistence && !confirm('This is a temporary site. Restarting creates a fresh installation and discards its changes. Continue?')) return;
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
    show('welcome');
    activity('Saved site data was deleted. Launch to create a fresh installation.');
  } catch (error) { displayError(error, 'The saved site could not be reset'); }
  finally { setBusy(false); }
});
$('save-button').addEventListener('click', async () => {
  if (!runtime || busy) return;
  setBusy(true);
  try { await runtime.flush(); activity('Files and database saved to browser storage.'); }
  catch (error) { activity(`Save failed: ${messageOf(error)}`); }
  finally { setBusy(false); }
});
$('share-button').addEventListener('click', async () => {
  if (!currentConfig) return;
  const url = createShareURL(location.href, currentConfig);
  try {
    await navigator.clipboard.writeText(url);
    activity('Link copied with the selected versions and initial page. Site data, credentials and setup steps are not shared.');
  } catch {
    prompt('Copy this configuration link. Site data, credentials and setup steps are not included.', url);
  }
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
fields.joomlaVersion.addEventListener('change', () => {
  extensionConfigurations.set(selectedJoomla, fields.extensions.value);
  selectedJoomla = fields.joomlaVersion.value;
  fields.extensions.value = extensionConfigurations.get(selectedJoomla) || '[]';
  try { updateCompatibility(); } catch (error) { activity(error); }
});
fields.persistence.addEventListener('change', () => setBusy(busy));

async function initialize() {
  try {
    ({ config: urlConfiguration, autostart } = readURLConfiguration(location.href));
    document.body.classList.toggle('embedded', Boolean(urlConfiguration.hideToolbar));
    $('embedded-launch').hidden = !urlConfiguration.hideToolbar;
    activity('Preparing browser support for PHP and MariaDB…');
    const environment = await prepareEnvironment();
    const reloadMarker = 'joomengine:environment-reload';
    if (environment.reloadRequired) {
      let previousReload;
      try {
        previousReload = sessionStorage.getItem(reloadMarker);
        sessionStorage.setItem(reloadMarker, '1');
      } catch {
        throw new Error('Allow session storage for this page, then reload to enable the browser database runtime.');
      }
      if (previousReload) throw new Error('This browser or host could not enable cross-origin isolation. Use a current browser over HTTPS and allow service workers.');
      location.reload();
      return;
    }
    try { sessionStorage.removeItem(reloadMarker); } catch { /* An isolated temporary site does not require session storage. */ }
    if (!globalThis.crossOriginIsolated) throw new Error('MariaDB requires cross-origin isolation. This browser or hosting configuration does not support it.');
    $('admin-password').value = password();
    const response = await fetch(new URL('../assets/manifest.json', import.meta.url), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`The runtime catalog is unavailable (HTTP ${response.status}). Build and serve the complete playground assets.`);
    catalog = parseCatalog(await response.json());
    fillVersions(fields.joomlaVersion, catalog.joomla);
    fillVersions(fields.phpVersion, catalog.php);
    const initial = { ...DEFAULTS, ...catalog.defaults, ...urlConfiguration };
    fields.joomlaVersion.value = initial.joomlaVersion;
    fields.phpVersion.value = initial.phpVersion;
    fields.initialPath.value = initial.initialPath;
    fields.persistence.checked = initial.persistence;
    selectedJoomla = initial.joomlaVersion;
    updateCompatibility({ preserve: true });
    setBusy(false);
    activity('Ready to launch. Choose a version combination and start your site.');
    if (autostart) await launch();
  } catch (error) {
    setBusy(false);
    displayError(error, 'The playground is not ready');
    $('retry-button').hidden = true;
  }
}

void initialize();
