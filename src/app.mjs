import { resolveSiteURL, createShareURL, createFullDeploymentDocument, parseDeploymentDocument, loadDeploymentDocument, normalizeConfiguration, parseCatalog, readURLConfiguration, catalogWithSelectedJoomlaPackage, resolveJoomlaVersion, parseStartupCommands } from './config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from './deploys.mjs';
import { createPlayground, prepareEnvironment, resetPlayground } from './playground.mjs';
import { defaultSiteKey, forgetSite, isolateSetup, publicConfiguration, readSavedState, rememberSite, rememberSiteRoute, renameSavedSite, safeSavedRoute, resolveResumePath, runtimeLocation, savedStateKey } from './ui-state.mjs';

import { initializeTheme, setTheme, getThemeState } from './theme.mjs';
import { observeIcons, decorateAction } from './icons.mjs';
import { createLanguageSelector } from './language-selector.mjs';

import { connectFrame } from './frame-view.mjs';
import { loginFromCredentialsDialog, populateCredentialsDialog } from './credentials-login.mjs';
import { prepareUploadedSiteCopy } from './site-copy.mjs';
import { DEFAULT_PHP_SETTINGS, normalizePhpSettings } from './php-settings.mjs';
import { UI_LANGUAGES, getLocale, initializeLocale, setLocale, t } from './i18n.mjs';
import { createLaunchCountdown } from './launch-countdown.mjs';
import { createLaunchMedia } from './launch-media.mjs';
import { deploymentLaunchReadiness } from './launch-readiness.mjs';
import { startAutosave } from './autosave.mjs';
import { presentError } from './error-presentation.mjs';
import { createExtensionInputs } from './extension-inputs.mjs';
import { createStructuredInputs } from './structured-inputs.mjs';
import { loadDeploymentFormSchemas } from './deployment-form-schema.mjs';
import { administratorCaptureTargets } from './deployment-capture.mjs';
import { normalizeDeploymentOverlays } from './deployment-overlays.mjs';
import { deploymentRegistryKey, readDeploymentRegistry, saveCustomDeployment, deleteCustomDeployment, customDeploymentName } from './deployment-registry.mjs';
import { initialJcbSelection, jcbSelectionInput, pinnedJcbPackages, recipeIncludesJcb } from './jcb-selection.mjs';
import { deploymentRequiresJcb, deploymentPhpVersions, selectDeploymentRuntime } from './deployment-compatibility.mjs';
import { loadVersionCatalog } from './version-catalog.mjs';
import { createBuildUpdateMonitor } from './build-updates.mjs';
import { dynamicJoomlaChoices, matchingJcbChoices } from './dynamic-selection.mjs';
import { selectCatalogPackage } from './dynamic-packages.mjs';
import { deploymentImages } from './deployment-images.mjs';
import { readSiteExport, configurationForSiteExport, catalogForRestoredSite } from './site-import.mjs';
import { networkFetch } from './network-transport.mjs';
import { createSiteBackups } from './site-backups.mjs';
import { createBackupPanel } from './backup-panel.mjs';
import { createStorageManagement } from './storage-management.mjs';
import { createRuntimeViewHost, attachRuntimeView, readRuntimeViewURL, readActiveRuntimeView, runtimeViewURL } from './runtime-views.mjs';

const $ = (id) => document.getElementById(id);
const deploymentURL = new URL('../', import.meta.url).href;
const preferenceKey = savedStateKey(deploymentURL);
const fields = {
  deployId: $('deploy'), phpVersion: $('php-version'), joomlaVersion: $('joomla-version'), jcbVersion: $('jcb-version'),
  language: $('language'), siteName: $('site-name'), initialPath: $('initial-path'), storageKey: $('storage-key'),
  persistence: $('persistence'), autoLogin: $('auto-login'), extensions: $('extensions'), startupCommands: $('startup-commands'),
};
const controls = ['save-button', 'restart-button', 'close-button', 'reset-button', 'share-button', 'export-button', 'export-format', 'code-button', 'database-button', 'code-refresh-button'];
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
let savingSite, savePromise, autosave;
let saveFailed = false;
let stoppedSite, sourceBackupId, backupPanel, runtimeViewHost, persistenceSubscription;
let currentLiveManaged = false;
let companionRuntime, companionView, companionUnavailable = false;
let companionSnapshot, companionLifecycleRegistered = false;
let persistenceNotice;
const backupStorage = createSiteBackups({ baseURL: deploymentURL });
const protectedLiveKeys = () => new Set([runtime?.configuration.storageKey, stoppedSite?.configuration.storageKey, readLiveMetadata()?.storageKey].filter(Boolean));
const managedStorage = createStorageManagement({ baseURL: deploymentURL,
  getKnownSites: () => savedState.sites,
  getProtectedKeys: () => [...protectedLiveKeys()],
  getProtectedIds: () => [runtime?.workspace.storageId].filter(Boolean),
});
const liveMetadataKey = `joomengine-live:${new URL(deploymentURL).pathname}`;
function readLiveMetadata() {
  try { return JSON.parse(localStorage.getItem(liveMetadataKey) || 'null'); } catch { return null; }
}
function rememberLiveMetadata(stopped = false) {
  if (!currentConfig) return;
  try { preferences?.setItem(liveMetadataKey, JSON.stringify({ managed: currentLiveManaged, storageKey: currentConfig.storageKey, stopped, sourceBackupId, path: currentSitePath })); }
  catch { /* Native site storage remains authoritative. */ }
}
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
let launchManifest, launchReadinessTimer, launchReadinessRequest = 0;
const launchRecipeSources = new Map();
let codeHost;
let databaseHost, openingDatabase;
let openingCode;
let extensionInputs;
let commandInputs, parameterInputs, menuInputs, contentInputs, overlayInputs;
let deploymentFormSchemas = {};
let deploymentSchemaUnavailable = false;
let discoveredConfiguration;
let editorConfiguration, editorSourceInput;
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
const launchMedia = createLaunchMedia({ video: $('launch-video'), poster: $('launch-image-poster') });
let preferences;
try { preferences = localStorage; } catch { /* A temporary site can run without preference storage. */ }
let savedState = readSavedState(preferences, preferenceKey);
const customRegistryKey = deploymentRegistryKey(deploymentURL);
let customRegistry = readDeploymentRegistry(preferences, customRegistryKey);
const buildUpdates = createBuildUpdateMonitor({
  baseURL: deploymentURL, loadedId: document.querySelector('meta[name="joomengine-build"]')?.content,
  onUpdate() { pauseAutomaticLaunch(); renderBuildUpdate(); },
});

function renderBuildUpdate() {
  $('build-update').hidden = !buildUpdates.pending;
  $('build-update-message').textContent = t(runtime ? 'buildUpdate.closeFirst' : 'buildUpdate.available');
  // Keep the existing Close/save/export flow in charge of temporary sites and
  // unfinished editor/database changes. Updating must never discard a site.
  $('reload-build').disabled = Boolean(runtime || busy || launching || closing);
}

function deploymentDescriptor(id) {
  const entry = customRegistry.deployments.find(item => item.id === id);
  if (entry) return { id, title: entry.title, joomla: entry.document.requirements.joomla,
    requirements: entry.document.requirements, configuration: entry.document.configuration };
  return deployCatalog?.deploys.find(item => item.id === id) || (currentDeployRecipe?.id === id ? currentDeployRecipe : undefined);
}
function customDeploymentInput(input) {
  if (input.deploymentRecipe) return input;
  const entry = customRegistry.deployments.find(item => item.id === input.deployId);
  if (!entry) return input;
  const stored = parseDeploymentDocument(entry.document, { baseURL: deploymentURL });
  const combined = { ...stored, ...input };
  if (input.joomlaVersion && input.joomlaVersion !== stored.joomlaVersion && !input.joomlaPackage) delete combined.joomlaPackage;
  if (input.jcbVersion && input.jcbVersion !== stored.jcbVersion && !input.jcbPackage) delete combined.jcbPackage;
  Object.assign(input, combined);
  return input;
}
function renderDeploymentChoices(selected = fields.deployId.value) {
  if (!deployCatalog) return;
  const entries = [...deployCatalog.deploys, ...customRegistry.deployments.map(entry => ({ id: entry.id, title: entry.title, group: 'Custom deployments' }))];
  if (selected && !entries.some(entry => entry.id === selected) && currentDeployRecipe?.id === selected) {
    entries.push({ id: selected, title: currentDeployRecipe.title || 'Saved deployment', group: 'Saved deployment' });
  }
  fillOptions(fields.deployId, entries);
  fillOptions($('editor-deployment'), entries);
  fields.deployId.value = selected;
  $('editor-deployment').value = selected;
  $('delete-deployment').disabled = !customRegistry.deployments.some(entry => entry.id === selected);
}
let administratorEdited = false;
function markDeploymentEdited(event) {
  if (['admin-name', 'admin-username', 'admin-email', 'admin-password'].includes(event?.target?.id)) administratorEdited = true;
  pauseAutomaticLaunch();
  $('deployment-save-status').hidden = true;
  const descriptor = deploymentDescriptor(fields.deployId.value);
  if (descriptor && !fields.deployId.value.startsWith('custom-') && $('deployment-name').value === descriptor.title) {
    $('deployment-name').value = customDeploymentName(descriptor.title, customRegistry.deployments.map(entry => entry.title));
  }
}
function editorRequirements(configuration = editorConfiguration, descriptor = deploymentDescriptor(fields.deployId.value) || currentDeployRecipe) {
  const requirements = structuredClone(descriptor?.requirements || {});
  requirements.joomla = [...(descriptor?.joomla || requirements.joomla || [configuration.joomlaVersion.split('.')[0]])];
  requirements.jcb = /(?:[?&]option=|\/)com_componentbuilder(?:[&#/]|$)/i.test(configuration.initialPath || '') ? 'required' : 'optional';
  return requirements;
}

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
  launchMedia.setActive(view === 'loading-view' && launching);
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
function updateLaunchReadiness() {
  const request = ++launchReadinessRequest;
  clearTimeout(launchReadinessTimer);
  const hint = $('launch-readiness');
  const render = state => {
    const key = `launchReadiness.${state || 'checking'}`;
    hint.dataset.i18n = key;
    hint.dataset.readiness = state || 'checking';
    hint.textContent = t(key);
  };
  if (!initialized || !catalog || !deployCatalog || !launchManifest || busy || launching) { render(null); return; }
  render(null);
  launchReadinessTimer = setTimeout(async () => {
    try {
      const input = formInput();
      const state = await deploymentLaunchReadiness(input, { manifest: launchManifest,
        catalog, deployCatalog, baseURL: deploymentURL, fetcher: async url => {
          const key = String(url);
          const descriptor = deployCatalog.deploys.find(entry => entry.id === currentDeployRecipe?.id);
          const currentURL = descriptor && (descriptor.url ?? new URL(descriptor.file, deployCatalog.url).href);
          if (currentDeployRecipe?.schemaVersion === 1 && key === currentURL) return Response.json(currentDeployRecipe);
          if (!launchRecipeSources.has(key)) {
            launchRecipeSources.set(key, networkFetch(url).then(async response => {
              if (!response.ok) throw new Error('Deployment metadata is unavailable.');
              return response.text();
            }).catch(error => { launchRecipeSources.delete(key); throw error; }));
          }
          return new Response(await launchRecipeSources.get(key));
        } });
      if (request === launchReadinessRequest) render(state);
    } catch { if (request === launchReadinessRequest) render(null); }
  }, 150);
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
  let status = t('help.local');
  if (runtime) {
    if (saveFailed || runtime.persistenceError) status = t('lifecycle.unsaved');
    else if (savingSite === runtime || runtime.persistencePending) status = t('lifecycle.persisting');
    else if (runtime.recovery) status = t('status.saved');
    else status = lastSavedAt
      ? t('status.savedAt', { time: lastSavedAt.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) })
      : t('status.saving');
  } else if (stoppedSite) status = t('lifecycle.stopped');
  $('save-state').textContent = status;
}

function watchLivePersistence() {
  persistenceSubscription?.();
  persistenceSubscription = runtime?.workspace?.subscribe(event => {
    if (event.type !== 'persistence-state') return;
    saveFailed = event.state === 'failed';
    if (event.state === 'saved') {
      lastSavedAt = event.savedAt ? new Date(event.savedAt) : new Date();
      persistenceNotice = undefined;
      rememberCurrentSite();
    } else if (saveFailed && !persistenceNotice) {
      persistenceNotice = true;
      activity(t('lifecycle.persistFailed'));
    }
    updateSaveState();
    runtimeViewHost?.update();
  });
}

function destroyPreview() {
  disconnectFrame();
  // Removing the old document avoids both late requests and transitions to a blank page.
  $('site-mount').replaceChildren();
  $('site-mount').hidden = true;
}
function updateRuntimeLocation() {
  if (!runtime || !currentInput || runtime.isRemoteView) return;
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
      frame.contentDocument.addEventListener('change', updateCaptureAction);
      updateCaptureAction();
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
    updateCaptureAction();
    $('credentials-button').dataset.signedOut = String(signedOut);
    $('credentials-button').textContent = `${t('title.credentials')}${signedOut ? ` · ${t('status.signedOut')}` : ''}`;
  } });
  $('site-mount').replaceChildren(frame);
  show('site-mount');
}
async function openCode() {
  if (busy || !runtime || openingCode || openingDatabase) return;
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
async function openDatabase() {
  if (busy || !runtime || openingCode || openingDatabase || runtime.recovery?.filesOnly) return;
  const owner = runtime;
  openingDatabase = (async () => {
    if (!databaseHost || databaseHost.closed) {
      const { createDatabaseHost } = await import('./database/host.mjs');
      if (runtime !== owner || owner.closed) return;
      databaseHost = await createDatabaseHost({
        runtime: owner, host: document.querySelector('.workspace'), preview: document.querySelector('.preview-panel'),
        t, storage: preferences,
        refreshSite() {
          if (!runtime?.healthy) throw new Error('Open the active Joomla site before refreshing.');
          mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
        },
        onError: error => feedback(error, { error: true, persistent: true }),
        onState(state) {
          $('database-button').setAttribute('aria-expanded', String(Boolean(state.visible)));
          const label = state.visible ? 'database.hide' : 'database.open';
          for (const attribute of ['title', 'aria-label']) {
            $('database-button').setAttribute(`data-i18n-${attribute}`, label);
            $('database-button').setAttribute(attribute, t(label));
          }
        },
      });
      await databaseHost.open();
    } else await databaseHost.toggle();
  })();
  $('database-button').disabled = true;
  try { await openingDatabase; }
  catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { openingDatabase = undefined; setBusy(busy); }
}
function updateMcpPreview() {
  const sourceId = deploymentDescriptor(fields.deployId.value)?.configuration?.sourceDeployId || fields.deployId.value;
  $('deploy-mcp-preview').hidden = sourceId !== 'jcb-mcp';
  $('credentials-mcp-preview').hidden = !runtime || !(runtime.installation?.mcp || (currentConfig?.sourceDeployId || runtime.installation?.deployId) === 'jcb-mcp');
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
  $('upload-site-button').disabled = locked || unavailable;
  $('retry-button').disabled = locked || unavailable;
  $('recover-button').disabled = locked || unavailable || !fields.persistence.checked;
  $('repair-button').hidden = filesOnly || !runtime?.recovery?.configured;
  $('repair-button').disabled = locked || filesOnly;
  $('error-reset-button').disabled = locked || unavailable || !fields.persistence.checked;
  $('saved-site').disabled = locked || unavailable || Object.keys(savedState.sites).length === 0;
  for (const id of ['saved-site-name', 'rename-site-button', 'delete-site-button']) $(id).disabled = locked || !selectedSiteId || !Object.hasOwn(savedState.sites, selectedSiteId);
  if (protectedLiveKeys().has(selectedSiteId)) $('delete-site-button').disabled = true;
  updateNavigation();
  for (const id of controls) $(id).disabled = locked || !runtime;
  $('share-button').disabled = locked || unavailable;
  $('reset-button').disabled = locked || (!runtime && (unavailable || !fields.persistence.checked));
  $('save-button').disabled = locked || unavailable;
  $('restart-button').disabled = locked || (!runtime && !stoppedSite) || filesOnly;
  const restartLabel = runtime ? 'action.restart' : 'action.start';
  $('restart-button').dataset.i18n = restartLabel;
  if ($('restart-button').dataset.controlLabel !== restartLabel) {
    $('restart-button').dataset.controlLabel = restartLabel;
    $('restart-button').textContent = t(restartLabel);
    decorateAction($('restart-button'), runtime ? 'restart-site' : 'debug-continue');
  }
  $('backup-button').disabled = locked || unavailable;
  $('database-button').disabled = locked || !runtime || filesOnly || Boolean(openingCode || openingDatabase);
  $('code-button').disabled = locked || !runtime || Boolean(openingCode || openingDatabase);
  $('download-dialog-button').disabled = locked || !runtime;
  updateCaptureAction();
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
  for (const id of ['editor-deployment', 'deployment-name', 'new-deployment', 'save-deployment', 'copy-deployment', 'edit-deployment']) $(id).disabled = locked || unavailable;
  $('delete-deployment').disabled = locked || unavailable || !customRegistry.deployments.some(entry => entry.id === fields.deployId.value);
  $('preview-dot').className = `status-dot${locked ? ' busy' : runtime ? '' : ' muted'}`;
  $('launch-button').querySelector('span').textContent = t(locked ? 'status.working' : targetRunning ? 'action.openRunning' : 'action.launch');
  $('launch-hint').textContent = t('help.firstLaunch');
  $('storage-note').textContent = t('help.storage');
  document.body.classList.toggle('running', Boolean(runtime));
  $('preview-label').textContent = runtime && currentConfig ? savedState.sites[runningSiteId]?.displayName || currentConfig.siteName : t('title.site');
  $('running-site-note').textContent = runtime ? t('status.runningSite', { name: savedState.sites[runningSiteId]?.displayName || currentConfig.siteName }) : t('status.noRunningSite');
  updateSaveState();
  backupPanel?.updateState();
  updateMcpPreview();
  renderBuildUpdate();
  updateLaunchReadiness();
}
function openImages() { return backupPanel.open(); }

function downloadArchive(result) {
  const blob = result.blob || new Blob([result.bytes], { type: result.mimeType || 'application/zip' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = result.filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function confirmLiveReplacement({ reset = false } = {}) {
  const activeElement = document.activeElement;
  const choice = await new Promise(resolveChoice => {
    const dialog = document.createElement('dialog');
    dialog.className = 'rocket-dialog'; dialog.dataset.liveReplacement = 'true';
    const heading = document.createElement('h2'); heading.id = 'live-replacement-title';
    heading.textContent = t(reset ? 'lifecycle.resetConfirm' : 'lifecycle.replaceConfirm');
    dialog.setAttribute('aria-labelledby', heading.id);
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const finish = value => { dialog.close(); dialog.remove(); activeElement?.focus(); resolveChoice(value); };
    for (const [value, label] of [['cancel', 'lifecycle.cancel'], ['backup', 'lifecycle.keepBackup'],
      ['download', 'lifecycle.keepDownload'], ['continue', reset ? 'lifecycle.resetContinue' : 'lifecycle.continue']]) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'button button-secondary'; button.dataset.replaceChoice = value;
      button.textContent = t(label);
      if (['backup', 'download'].includes(value)) button.disabled = !runtime?.healthy;
      button.addEventListener('click', () => finish(value)); actions.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
    dialog.append(heading, actions); document.body.append(dialog); dialog.showModal(); actions.firstChild.focus();
  });
  if (choice === 'backup') await backupPanel.open();
  if (choice === 'download') {
    try { downloadArchive(await runtime.exportSite({ format: 'bundle', includePlaygroundConfiguration: true,
      onProgress: event => activity(event.message || event) })); }
    catch (error) { feedback(error, { error: true, persistent: true }); }
  }
  return choice === 'continue';
}

function setupBackups() {
  backupPanel = createBackupPanel({ element: $('backups-panel'), backups: backupStorage,
    isBlocked: () => busy || launching || closing,
    getRuntime: () => runtime, getSourceBackupId: () => sourceBackupId,
    createArchive: () => runtime.exportSite({ format: 'bundle', includePlaygroundConfiguration: true,
      onProgress: event => activity(event.message || event) }),
    async onRestore(blob, record) {
      const siteExport = await readSiteExport(blob);
      const importedConfiguration = configurationForSiteExport(siteExport, catalog, { baseURL: deploymentURL, admin: administrator() });
      // The panel reserves its buttons; launch owns the runtime transition.
      setBusy(false);
      await launch({ siteExport, importedConfiguration, backupId: record.id });
    },
    onBackupSaved(record) { sourceBackupId = record.id; rememberLiveMetadata(); },
    getManagedEntries: listManagedStorage, removeManagedEntry,
    onDownload: downloadArchive, onBusy: value => setBusy(value),
    onError: error => activity(error), t,
  });
  for (const id of ['backup-button', 'local-images-button']) $(id).addEventListener('click', () => void openImages());
}

async function listManagedStorage() {
  const liveKeys = protectedLiveKeys();
  const native = await managedStorage.list();
  const entries = native.map(entry => ({ ...entry, id: `native:${entry.id}`, nativeId: entry.id,
    name: entry.scope === 'unassigned' ? `${t('storage.unassigned')} (${entry.id.slice(0, 8)})` : entry.title,
    kind: t('storage.oldSite'), active: entry.protected, key: entry.storageKey }));
  for (const site of Object.values(savedState.sites)) if (!native.some(entry => entry.storageKey === site.storageKey)) {
    entries.push({ id: `site:${site.storageKey}`, key: site.storageKey, name: site.displayName || site.siteName,
      kind: t('storage.oldSite'), active: liveKeys.has(site.storageKey), removable: !liveKeys.has(site.storageKey) });
  }
  const images = await deploymentImages.list();
  for (const image of images.filter(item => item.available !== false)) entries.push({ id: `image:${image.key}`, key: image.key,
    name: image.title || image.deploymentId || t('storage.image'), kind: t('storage.image'), size: image.size, removable: true });
  for (const deployment of customRegistry.deployments) entries.push({ id: `deployment:${deployment.id}`, key: deployment.id,
    name: deployment.title, kind: t('storage.configuration'), removable: true });
  for (let index = 0; index < (preferences?.length || 0); index++) {
    const key = preferences.key(index);
    if (['joomengine-code-layout', 'joomengine-database-layout', 'joomengine.rocket.interface-language.v1'].includes(key)
      || key?.startsWith('joomengine.dynamic-catalog.v2:')) {
      entries.push({ id: `preference:${key}`, key, name: t('storage.preferences'),
        kind: key.split(':')[0], size: new Blob([preferences.getItem(key) || '']).size, removable: true });
    }
  }
  return entries;
}

async function removeManagedEntry(entry) {
  const liveKeys = protectedLiveKeys();
  if (entry.id.startsWith('native:')) {
    await managedStorage.remove(entry.nativeId, { allowUnassigned: Boolean(entry.manualOnly) });
    if (entry.key) { savedState = forgetSite(savedState, entry.key); writePreferences(); }
  } else if (entry.id.startsWith('site:')) {
    if (liveKeys.has(entry.key)) throw new Error(t('backups.retained'));
    await resetPlayground({ storageKey: entry.key });
    savedState = forgetSite(savedState, entry.key); writePreferences();
  } else if (entry.id.startsWith('image:')) await deploymentImages.remove(entry.key);
  else if (entry.id.startsWith('preference:')) preferences?.removeItem(entry.key);
  else if (entry.id.startsWith('deployment:')) {
    customRegistry = deleteCustomDeployment(preferences, customRegistryKey, customRegistry, entry.key);
    for (const key of drafts.keys()) if (key.startsWith(`${entry.key}:`)) drafts.delete(key);
    renderDeploymentChoices(fields.deployId.value === entry.key ? deployCatalog.default : fields.deployId.value);
  }
}

function showExtensionWarnings(warnings = []) {
  // Optional component configuration is reported in Activity, without an install alert.
  warnings = warnings.filter(warning => warning.phase !== 'configuration');
  const panel = $('extension-warnings');
  panel.replaceChildren();
  panel.hidden = warnings.length === 0;
  if (!warnings.length) return;
  const heading = document.createElement('strong');
  heading.textContent = 'Extension installation errors';
  const dismiss = document.createElement('button');
  dismiss.type = 'button'; dismiss.className = 'text-button'; dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { panel.hidden = true; });
  const list = document.createElement('ul');
  for (const warning of warnings) {
    const error = Object.assign(new Error(warning.message), { technicalDetails: warning.technicalDetails });
    const presented = presentError(error, { secrets: [$('admin-password').value, runningAdministrator?.password] });
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = presented.summary.replace(/https?:\/\/[^\s<>"']+/gi, '[package URL]');
    item.append(label);
    if (presented.details) {
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Technical details';
      const output = document.createElement('pre'); output.textContent = presented.details;
      details.append(summary, output); item.append(details);
    }
    list.append(item);
  }
  panel.append(heading, dismiss, list);
}
function progress(event) {
  const details = typeof event === 'string' ? { message: event } : event;
  const rawMessage = details?.message || details?.phase || 'Preparing the playground…';
  const message = details?.phase === 'warning' ? presentError(new Error(rawMessage), {
    secrets: [$('admin-password').value, runningAdministrator?.password], fallback: 'PHP reported diagnostic output. Check the browser console for details.',
  }).summary : rawMessage;
  if (details?.background) { activity(message); return; }
  if (details?.phase === 'failed' && runtime && !closing && !busy) {
    destroyPreview();
    displayError(new Error(message));
    return;
  }
  const phaseKeys = { assets: 'status.loadingCatalog', database: 'status.startingDatabase', php: 'status.startingPhp', install: 'status.installingJoomla', extensions: 'status.installingExtensions', configure: 'status.configuringSite', saving: 'status.saving', ready: 'status.openingSite', download: 'status.loading' };
  const imageTitles = { 'build-image': 'Building your deployment image', 'launch-image': 'Launching your site', 'download-image': 'Downloading image', 'save-image': 'Saving image' };
  $('loading-title').textContent = imageTitles[details?.phase] || t(phaseKeys[details?.phase] || 'title.loading');
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
  if (!requireOwnerForReplacement()) return;
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
    lastSavedAt = undefined; saveFailed = false;
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
  administratorEdited = false;
  for (const name of ['name', 'username', 'email', 'password']) {
    if (typeof value[name] === 'string') $(`admin-${name}`).value = value[name];
  }
}
function matchesInstalledSelection(input) {
  const source = runtime?.configuration && runtime.configuration.storageKey === input.storageKey
    && runtime.configuration.persistence === input.persistence ? runtime.configuration : savedState.sites[input.storageKey];
  return source && source.deployId === input.deployId && source.joomlaVersion === input.joomlaVersion
    && (source.jcbVersion || 'none') === (input.jcbVersion || 'none')
    && source.persistence === input.persistence;
}
function sameEditorSetup(input, baseline) {
  return baseline && ['siteName', 'initialPath', 'admin', 'extensions', 'startupCommands', 'menus', 'template', 'languageTags', 'multilingual', 'content', 'overlays', 'language', 'autoLogin', 'phpSettings']
    .every(name => JSON.stringify(input[name] ?? null) === JSON.stringify(baseline[name] ?? null));
}
function coreRecipeAdditions(configuration) {
  const input = { ...configuration, extensions: configuration.addonExtensions || [],
    startupCommands: configuration.addonStartupCommands || [], languages: configuration.addonLanguages || [],
    template: configuration.addonTemplate || editorSourceInput?.template };
  delete input.deploymentRecipe;
  return input;
}
function formInput(overrides = {}) {
  const joomlaVersion = overrides.joomlaVersion ?? fields.joomlaVersion.value;
  const unchangedRestoredJcb = (editorConfiguration?.restoredSite || matchesInstalledSelection({
    ...editorConfiguration, deployId: fields.deployId.value, storageKey: fields.storageKey.value,
    joomlaVersion, jcbVersion: fields.jcbVersion.value, persistence: fields.persistence.checked,
  }))
    && fields.jcbVersion.value === (editorConfiguration.jcbVersion ?? 'none');
  const jcbInput = unchangedRestoredJcb ? { jcbVersion: fields.jcbVersion.value } : jcbSelectionInput({ selection: { ...jcbSelection, version: fields.jcbVersion.value },
    major: joomlaVersion.split('.')[0], deploy: currentDeployRecipe, pinned: pinnedJcb });
  const candidate = {
    ...(editorConfiguration || {}),
    ...extraDeploymentFields,
    deployId: fields.deployId.value,
    phpVersion: fields.phpVersion.value, joomlaVersion: fields.joomlaVersion.value,
    language: fields.language.value, siteName: fields.siteName.value,
    initialPath: fields.initialPath.value, storageKey: fields.storageKey.value,
    persistence: true, autoLogin: fields.autoLogin.checked,
    hideToolbar, fresh: pendingFresh, admin: administrator(),
    extensions: extensionInputs.read(), startupCommands: commandInputs ? commandInputs.read() : fields.startupCommands.value,
    phpSettings, jcbVersion: fields.jcbVersion.value || 'none', ...jcbInput, multilingual: $('multilingual').checked, languageTags: $('deploy-languages').value.split(',').map(value => value.trim()).filter(Boolean),
    menus: menuInputs ? menuInputs.read() : parseEditorJSON('deploy-menus', []), template: templateInput(),
    content: contentInputs ? contentInputs.read() : editorConfiguration?.content,
    overlays: overlayInputs ? overlayInputs.read() : editorConfiguration?.overlays || [], ...overrides,
  };
  if (candidate.jcbVersion === 'none' || (editorConfiguration?.jcbVersion !== candidate.jcbVersion && !jcbInput.jcbPackage)) delete candidate.jcbPackage;
  if (candidate.content == null) delete candidate.content;
  const full = normalizeConfiguration(candidate, { catalog, baseURL: deploymentURL });
  if (full.restoredSite) return full;
  const sameSetup = sameEditorSetup(full, editorConfiguration);
  if (sameSetup && !editorSourceInput?.deploymentRecipe && !fields.deployId.value.startsWith('custom-')) {
    // Keep unchanged core recipes eligible for their prepared image. The editor
    // shows full lists while the core resolver receives only genuine additions.
    return coreRecipeAdditions(full);
  }
  const previousAddons = new Set((editorConfiguration?.addonExtensions || []).map(item => item.url));
  const managed = new Map((editorConfiguration?.extensions || []).filter(item => !previousAddons.has(item.url)).map(item => [item.url, item]));
  full.extensions = full.extensions.map(item => managed.has(item.url) && !item.authentication && !item.headers && !item.provider
    ? structuredClone(managed.get(item.url)) : structuredClone(item));
  full.addonExtensions = full.extensions.filter(item => !managed.has(item.url) || item.authentication || item.headers || item.provider).map(item => structuredClone(item));
  full.addonStartupCommands = full.startupCommands;
  full.addonLanguages = full.languages || [];
  full.addonTemplate = full.template?.url && full.template.url !== editorConfiguration?.template?.url
    ? full.template : editorConfiguration?.addonTemplate || null;
  const name = $('deployment-name').value.trim() || deploymentDescriptor(fields.deployId.value)?.title || full.siteName;
  const document = createFullDeploymentDocument(full, { name, requirements: editorRequirements(full), baseURL: deploymentURL });
  return { ...full, deploymentRecipe: document };
}
async function resolve(input) {
  if (input.restoredSite) {
    if (input.jcbVersion !== editorConfiguration?.jcbVersion) await prepareDynamicInput(input);
    catalog = catalogForRestoredSite(catalog, input);
    selectedJoomlaPackages.set(input.joomlaVersion, { ...catalog.joomla.find(entry => entry.version === input.joomlaVersion) });
    fillJoomlaOptions();
    return { configuration: normalizeConfiguration(input, { catalog, baseURL: deploymentURL }), deploy: deploymentDescriptor('blank') };
  }
  // An unchanged core recipe keeps additive setup identity in saved preferences,
  // while the editor retains its complete configuration for package-free resume.
  const retainedCore = !input.deploymentRecipe && !editorSourceInput?.deploymentRecipe && editorConfiguration
    && ['storageKey', 'persistence', 'deployId', 'joomlaVersion', 'jcbVersion'].every(name => input[name] === editorConfiguration[name])
    && JSON.stringify(input.languages || []) === JSON.stringify(editorConfiguration.addonLanguages || [])
    && sameEditorSetup(input, coreRecipeAdditions(editorConfiguration));
  const installedInput = input.deploymentRecipe ? input : retainedCore ? { ...editorConfiguration, ...input,
    extensions: editorConfiguration.extensions, startupCommands: editorConfiguration.startupCommands,
    languages: editorConfiguration.languages, template: editorConfiguration.template } : null;
  // A complete recipe for an unchanged installed runtime needs no package lookup.
  // This also lets owners configure a JCB version no longer present in the catalog.
  if (installedInput && matchesInstalledSelection(input)) {
    const document = input.deploymentRecipe;
    return { configuration: normalizeConfiguration(installedInput, { catalog: catalogForRestoredSite(catalog, installedInput), baseURL: deploymentURL }),
      deploy: deploymentDescriptor(input.deployId) || (document ? { id: input.deployId, title: document.name,
        joomla: document.requirements.joomla, requirements: document.requirements, configuration: document.configuration } : undefined) };
  }
  input = customDeploymentInput(input);
  input.joomlaVersion ||= catalog.defaults.joomlaVersion;
  const descriptor = deploymentDescriptor(input.deployId ?? deployCatalog.default);
  if (input.jcbVersion === undefined && deploymentRequiresJcb(descriptor) && !savedState.sites[input.storageKey]) {
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
  const deploy = currentDeployRecipe ?? deploymentDescriptor(fields.deployId.value);
  const compatiblePhp = deploymentPhpVersions(deploy, joomla);
  for (const option of fields.phpVersion.options) option.disabled = !compatiblePhp.includes(option.value);
  for (const option of fields.joomlaVersion.options) {
    const release = catalog.joomla.find(entry => entry.version === option.value);
    const archiveOnly = release && !release.url && !pinnedCatalog?.joomla.some(entry => entry.version === release.version)
      && !dynamicMetadata.joomla.some(entry => entry.version === release.version);
    option.disabled = (!editorConfiguration?.restoredSite && archiveOnly) || !deploymentPhpVersions(deploy, release).length;
  }
  if (!compatiblePhp.includes(fields.phpVersion.value)) {
    if (preserve) throw new Error('The selected Joomla and PHP versions are incompatible.');
    fields.phpVersion.value = compatiblePhp.includes(catalog.defaults.phpVersion) ? catalog.defaults.phpVersion : compatiblePhp[0];
  }
  $('compatibility-note').textContent = `${joomla.label} · PHP ${compatiblePhp.join(', ')}`;
  const major = joomla.version.split('.')[0];
  for (const select of [fields.deployId, $('editor-deployment')]) {
    for (const option of select.options) {
      const descriptor = deploymentDescriptor(option.value);
      option.disabled = !catalog.joomla.some(release => deploymentPhpVersions(descriptor, release).length);
    }
  }
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
  if (!pinnedCatalog || buildUpdates.pending || (document.hidden && !required)) return;
  if (dynamicCatalogRequest) return dynamicCatalogRequest;
  if (Date.now() - dynamicCatalogUpdatedAt < catalogRefreshInterval) return;
  dynamicCatalogRequest = (async () => {
    try {
      const result = await loadVersionCatalog();
      if (buildUpdates.pending) return;
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
      input.joomlaPackage = selectCatalogPackage(selected?.url ? selected : entry, { php: available.php });
      selectedJoomlaPackages.set(version, structuredClone(input.joomlaPackage));
    }
  }
  if (input.jcbVersion && input.jcbVersion !== 'none' && !input.jcbPackage) {
    const pinned = [...pinnedJcb.values()].find(entry => entry.version === input.jcbVersion);
    const deploy = input.deployId === currentDeployRecipe?.id ? currentDeployRecipe : undefined;
    const major = (input.joomlaVersion || fields.joomlaVersion.value).split('.')[0];
    if (pinned) {
      // Core JCB recipes already contain this exact pin. Other deployments use
      // the shared pin explicitly rather than assuming their recipe has JCB.
      const descriptor = deploymentDescriptor(input.deployId || fields.deployId.value);
      if (!recipeIncludesJcb(deploy, major, input.jcbVersion) && !deploymentRequiresJcb(descriptor)) input.jcbPackage = structuredClone(pinned.package);
    } else {
      const entry = dynamicMetadata.jcb.find(item => item.version === input.jcbVersion);
      if (entry) input.jcbPackage = selectCatalogPackage(entry);
    }
  }
}
function renderJcbOptions(major, selection = jcbSelection) {
  const choices = matchingJcbChoices(major, dynamicMetadata.jcb, pinnedJcb);
  if (selection.version !== 'none' && !choices.some(entry => entry.version === selection.version)) {
    const pinned = [...pinnedJcb.values()].find(entry => entry.version === selection.version);
    if (selection.package || pinned || editorConfiguration?.restoredSite || runtime?.configuration?.jcbVersion === selection.version) choices.push({ version: selection.version, label: `JCB ${selection.version}`, channel: 'saved' });
  }
  fillOptions(fields.jcbVersion, [{ version: 'none', label: t('label.jcbNone'), disabled: deploymentRequiresJcb(currentDeployRecipe) }, ...choices]);
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
    clearFeedback();
  } catch (error) {
    jcbSelection = previous;
    fields.jcbVersion.value = previous.version;
    feedback(error, { error: true, persistent: true });
  } finally { setBusy(false); }
}

function applyConfiguration(config, input = config, deploy) {
  administratorEdited = false;
  refreshNightlyOnNextLaunch = false;
  if (deploy) currentDeployRecipe = deploy;
  editorConfiguration = structuredClone(config);
  editorSourceInput = structuredClone(input);
  extraDeploymentFields = Object.fromEntries(['content', 'languages', 'joomlaPackage', 'deploymentRecipe', 'restoredSite'].filter(key => config[key] !== undefined).map(key => [key, structuredClone(config[key])]));
  templateOptions = structuredClone(input.template || config.template || {});
  for (const name of ['deployId', 'joomlaVersion', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language']) {
    if (config[name] !== undefined) fields[name].value = config[name];
  }
  fields.persistence.checked = true;
  fields.autoLogin.checked = config.autoLogin;
  const addonUrls = new Set((config.addonExtensions || []).map(item => item.url));
  extensionInputs.setValue(config.extensions || [], { managed: (config.extensions || []).filter(item => !addonUrls.has(item.url)) });
  phpSettings = normalizePhpSettings(input.phpSettings || config.phpSettings || DEFAULT_PHP_SETTINGS);
  $('deploy-languages').value = (input.languageTags || config.languageTags || []).join(', ');
  $('deploy-menus').value = JSON.stringify(input.menus || config.menus || [], null, 2);
  menuInputs?.setValue(input.menus || config.menus || []);
  $('template-url').value = (input.template || config.template)?.url || '';
  $('template-name').value = (input.template || config.template)?.element || '';
  $('template-params').value = JSON.stringify((input.template || config.template)?.params || {}, null, 2);
  parameterInputs?.setValue((input.template || config.template)?.params || {});
  contentInputs?.setValue(config.content || null);
  overlayInputs?.setValue(input.overlays || config.overlays || []);
  updateDeploymentFormContext();
  $('multilingual').checked = config.multilingual === true || config.content?.multilingual === true;
  renderEditorLists();
  fields.startupCommands.value = JSON.stringify(config.startupCommands || [], null, 2);
  commandInputs?.setValue(config.startupCommands || []);
  pendingFresh = Boolean(config.fresh);
  setFocusMode(config.hideToolbar);
  $('embedded-launch').hidden = false;
  $('editor-runtime-summary').textContent = `${deploymentDescriptor(config.deployId)?.title || deploy?.title || config.siteName} · Joomla ${config.joomlaVersion} · PHP ${config.phpVersion}`;
  selectedProfile = { deployId: config.deployId, joomlaVersion: config.joomlaVersion };
  const description = deploy?.description ?? deploymentDescriptor(config.deployId)?.description;
  $('deploy-description').textContent = description || 'A verified Joomla installation with the selected setup steps.';
  renderDeploymentChoices(config.deployId);
  $('deployment-name').value = input.deploymentRecipe?.name || deploymentDescriptor(config.deployId)?.title || config.siteName;
  $('deployment-save-status').hidden = true;
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
async function launch({ siteExport, checkpoint, importedConfiguration, deploymentChanges, jcbUpgrade, rotateAdministrator = false, resumeOnly = false, backupId } = {}) {
  if (!requireOwnerForReplacement()) return;
  if (busy || launching || !initialized || !catalog || !deployCatalog) return;
  launching = true;
  let switchingStarted = false;
  let previousView;
  let preparedRuntime;
  const previousLiveKey = runtime?.configuration?.storageKey || stoppedSite?.configuration?.storageKey;
  const previousManaged = readLiveMetadata();
  launchCountdown.stop();
  $('launch-countdown').hidden = true;
  $('dashboard-countdown').hidden = true;
  try {
    if (!siteExport && !checkpoint && !importedConfiguration && !resumeOnly && !$('launch-form').checkValidity()) { setDrawer(true); openDialog('deploy-dialog'); $('advanced-settings').open = true; $('launch-form').reportValidity(); return; }
    // Reserve the transition before checking the network. Validate first:
    // disabled form controls do not participate in native form validation.
    setBusy(true);
    $('loading-title').textContent = t('title.loading');
    $('loading-message').textContent = t('status.loading');
    $('loading-progress').removeAttribute('value');
    // A landing-page launch gives immediate feedback, including while the
    // update check and configuration resolve. Keep an existing site visible
    // until its close/save flow has accepted a switch.
    if (!runtime) {
      previousView = ['welcome', 'error-view', 'site-mount'].find(name => !$(name).hidden) || 'welcome';
      show('loading-view');
    }
    if (await buildUpdates.check({ force: true })) return;
    let input = { ...(importedConfiguration || formInput()), persistence: true };
    const nightly = dynamicMetadata.joomla.find(entry => entry.version === input.joomlaVersion && entry.source === 'nightly');
    if (!resumeOnly && nightly && input.joomlaPackage && refreshNightlyOnNextLaunch) {
      setBusy(true);
      const selected = selectCatalogPackage(nightly, { php: input.joomlaPackage.php });
      input.joomlaPackage = selected;
      extraDeploymentFields.joomlaPackage = structuredClone(selected);
      selectedJoomlaPackages.set(input.joomlaVersion, structuredClone(selected));
      refreshNightlyOnNextLaunch = false;
    }
    clearFeedback();
    setBusy(true);
    if (freshKeyPending && !siteExport && !checkpoint && !resumeOnly) {
      input.storageKey = `${defaultSiteKey(input.deployId, input.joomlaVersion).slice(0, 44)}-fresh-${crypto.randomUUID().slice(0, 8)}`;
      fields.storageKey.value = input.storageKey;
    }
    const recipe = resumeOnly || checkpoint || input.restoredSite ? { configuration: input, changed: false } : await isolateSetup(savedState, input);
    input = recipe.configuration;
    if (recipe.changed) {
      fields.storageKey.value = input.storageKey;
      activity(`Changed setup steps use a separate site key, “${input.storageKey}”. Your previous site is preserved.`);
    }
    const resolved = checkpoint || resumeOnly
      ? { configuration: normalizeConfiguration(input, { catalog: catalogForRestoredSite(catalog, input), baseURL: deploymentURL }), deploy: deploymentDescriptor(input.deployId) }
      : await resolve(input);
    if (runtime && currentConfig.storageKey === resolved.configuration.storageKey && currentConfig.persistence === resolved.configuration.persistence && JSON.stringify(publicConfiguration(currentInput)) === JSON.stringify(publicConfiguration(input))) {
      setDrawer(false); $('site-frame')?.focus(); feedback(t('status.alreadyRunning')); return;
    }
    if (runtime || (stoppedSite && stoppedSite.configuration.storageKey !== resolved.configuration.storageKey)) {
      if (!resumeOnly && !await confirmLiveReplacement()) return;
    }
    // Validate a complete upload/backup in its own new live store before the
    // existing site is stopped. A failed restore never destroys the source.
    if (siteExport) {
      preparedRuntime = await createPlayground(resolved.configuration, { onProgress: progress, siteExport, deferInitialSave: true });
      // Do not discard a working site until the replacement is durably stored.
      await preparedRuntime.flush();
    }
    if (runtime) {
      setBusy(false);
      if (!await closeSite({ save: currentConfig.persistence })) return;
    }
    switchingStarted = true;
    setBusy(true); show('loading-view');
    currentInput = input;
    currentConfig = resolved.configuration;
    if (siteExport || checkpoint) applyConfiguration(currentConfig, input, resolved.deploy);
    $('preview-label').textContent = currentConfig.siteName;
    activity(`Starting ${resolved.deploy?.title || currentConfig.deployId} with Joomla ${currentConfig.joomlaVersion} and PHP ${currentConfig.phpVersion}.`);
    const resumePath = resumeLastRoute && !input.fresh && currentConfig.persistence && savedState.sites[currentConfig.storageKey]?.lastPath;
    runtime = preparedRuntime || await createPlayground({ ...currentConfig, ...(resumePath ? { initialPath: safeSavedRoute(resumePath, currentConfig.initialPath) } : {}) }, { onProgress: progress, siteExport, checkpoint, jcbUpgrade, rotateAdministrator, deferInitialSave: true, resumeOnly });
    preparedRuntime = undefined;
    stoppedSite = undefined;
    currentLiveManaged = previousManaged?.storageKey === currentConfig.storageKey
      ? Boolean(previousManaged.managed) : !savedState.sites[currentConfig.storageKey];
    sourceBackupId = backupId || (resumeOnly ? previousManaged?.sourceBackupId : undefined);
    // The runtime opens the last visited route, but the deployment retains its
    // chosen initial path for future fresh installations and configuration exports.
    currentConfig = { ...runtime.configuration, initialPath: currentConfig.initialPath };
    currentInput = { ...currentInput, jcbVersion: currentConfig.jcbVersion, jcbPackage: currentConfig.jcbPackage };
    jcbSelection = { version: currentConfig.jcbVersion || 'none', omit: false,
      ...(currentConfig.jcbPackage ? { package: currentConfig.jcbPackage } : {}) };
    renderJcbOptions(currentConfig.joomlaVersion.split('.')[0], jcbSelection);
    if (deploymentChanges) {
      deploymentChanges = { ...deploymentChanges, jcbVersion: currentConfig.jcbVersion, jcbPackage: currentConfig.jcbPackage };
      await runtime.applyConfiguration(deploymentChanges);
      currentConfig = runtime.configuration;
      currentInput = { ...deploymentChanges, admin: runtime.installation?.administrator || deploymentChanges.admin };
    }
    applyConfiguration(currentConfig, currentInput, resolved.deploy);
    runningSiteId = currentConfig.storageKey;
    selectedSiteId = currentConfig.persistence ? currentConfig.storageKey : null;
    const restoredPath = resumePath
      ? await resolveResumePath((path, init) => runtime.request(path, init), resumePath, currentConfig.initialPath)
      : runtime.installation?.extensionWarnings?.some(warning => warning.phase !== 'configuration')
        ? await resolveResumePath((path, init) => runtime.request(path, init), currentConfig.initialPath, '/administrator/index.php')
        : null;
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
    showExtensionWarnings(runtime.installation?.extensionWarnings);
    lastSavedAt = runtime.lastSavedAt ? new Date(runtime.lastSavedAt) : undefined;
    saveFailed = false;
    if (currentConfig.persistence && !lastSavedAt && !runtime.subscribePersistence) autosave.request();
    setDrawer(false);
    $('deploy-dialog').close();
    updateRuntimeLocation();
    pendingFresh = false;
    freshKeyPending = false;
    currentInput.fresh = false;
    resumeLastRoute = true;
    const resumeSaved = rememberCurrentSite();
    rememberLiveMetadata();
    watchLivePersistence();
    hostRuntimeViews();
    selectedProfile = { deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion };
    rememberDraft({ deployId: currentConfig.deployId, joomlaVersion: currentConfig.joomlaVersion });
    activity(recipe.changed ? `Site ready under “${currentConfig.storageKey}”. Your previous site is available in Saved sites.` : currentConfig.persistence
      ? resumeSaved ? 'Site ready. Reopening this playground will resume your saved site.' : `Site ready. Keep saved site key “${currentConfig.storageKey}” to reopen it.`
      : 'Temporary site ready. Download your work before closing.');
    if (siteExport) feedback(runtime.installation.contentHashValidated ? 'Package validated.' : 'Package validation is unavailable for this older export.');
    // Only newly managed replacement slots are discarded. Legacy saved sites
    // and PR24's deliberate source copies remain visible in storage management.
    if (previousManaged?.managed && previousLiveKey && previousLiveKey !== currentConfig.storageKey && !checkpoint) {
      try {
        await runtime.flush();
        await resetPlayground({ storageKey: previousLiveKey });
        savedState = forgetSite(savedState, previousLiveKey); writePreferences();
      } catch (error) { activity(error); }
    }
    return true;
  } catch (error) {
    if (!switchingStarted) { feedback(error, { error: true, persistent: true }); return false; }
    destroyPreview();
    if (runtime) {
      try { await runtime.close(); } catch (closeError) { activity(closeError); }
      runtime = undefined;
      runningSiteId = null;
    }
    displayError(error);
  } finally {
    if (preparedRuntime) { try { await preparedRuntime.reset(); } catch (error) { activity(error); } }
    launching = false;
    launchMedia.setActive(false);
    if (!switchingStarted && previousView) show(previousView);
    setBusy(false);
    if (!$('error-view').hidden) $('preview-dot').className = 'status-dot failed';
    if (backupPanel?.isOpen) void backupPanel.refresh();
  }
}
async function closeSite({ reset = false, save = false } = {}) {
  if (busy || closing || !runtime) return false;
  if (openingCode || openingDatabase) { feedback(t(openingDatabase ? 'database.loading' : 'code.loading')); return false; }
  const handle = runtime;
  let previewRemoved = false;
  closing = true;
  setBusy(true);
  try {
    if (runtimeViewHost && !await runtimeViewHost.prepareTransition(reset ? 'reset' : 'stop')) return false;
    if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return false;
    if (handle.debugger.state !== 'idle') await handle.debugger.stop();
    if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return false;
    if (databaseHost && !databaseHost.closed && !await databaseHost.beforeClose()) return false;
    // Background persistence must finish before this owner is closed or reset.
    if (savingSite === handle && !await savePromise) return false;
    // A failed checkpoint must leave the current iframe and unsaved forms intact.
    if (!reset && currentConfig.persistence && !handle.recovery?.filesOnly) {
      activity('Saving the current site before closing…'); await handle.flush();
    }
    destroyPreview(); previewRemoved = true;
    if (reset) await handle.reset();
    else await handle.close();
    if (!reset) {
      stoppedSite = { configuration: { ...currentConfig, fresh: false, admin: runningAdministrator || currentInput.admin }, input: { ...currentInput, fresh: false }, path: currentSitePath };
      rememberLiveMetadata(true);
    } else { stoppedSite = undefined; sourceBackupId = undefined; }
    await databaseHost?.dispose(); databaseHost = undefined;
    await codeHost?.dispose(); codeHost = undefined;
    runtime = undefined;
    persistenceSubscription?.(); persistenceSubscription = undefined;
    runtimeViewHost?.update();
    runningSiteId = null; runningAdministrator = null; previewDirty = false;
    if (reset) {
      savedState = forgetSite(savedState, currentConfig.storageKey);
      writePreferences();
      pendingFresh = false;
      freshKeyPending = false;
    }
    $('preview-label').textContent = t('title.site');
    clearFeedback(); show('welcome');
    activity(reset ? t('lifecycle.resetConfirm') : t('lifecycle.stopped'));
    return true;
  } catch (error) {
    runtime = handle.healthy ? handle : undefined;
    if (runtime) {
      if (previewRemoved) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
      feedback(error, { error: true, persistent: true });
    } else {
      // Failed workers must still release the storage lock before a recovery retry.
      try { await handle.close(); } catch (cleanupError) { activity(cleanupError); }
      try { await databaseHost?.dispose(); databaseHost = undefined; } catch (cleanupError) { activity(cleanupError); }
      try { await codeHost?.dispose(); } catch (cleanupError) { activity(cleanupError); }
      codeHost = undefined; runningSiteId = null; runningAdministrator = null;
      if (!reset && currentConfig.persistence) {
        stoppedSite = { configuration: { ...currentConfig, fresh: false }, input: { ...currentInput, fresh: false }, path: currentSitePath };
        rememberLiveMetadata(true);
      }
      persistenceSubscription?.(); persistenceSubscription = undefined;
      runtimeViewHost?.update();
      displayError(error);
    }
    return false;
  } finally { closing = false; setBusy(false); }
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
  if (protectedLiveKeys().has(key)) return;
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
async function changeProfile({ refreshNightly = false, deploymentChanged = false } = {}) {
  if (busy || launching || !catalog) return;
  const previous = selectedProfile;
  pauseAutomaticLaunch();
  rememberDraft(previous);
  setBusy(true);
  try {
    const descriptor = deploymentDescriptor(fields.deployId.value);
    const installableCatalog = deploymentChanged ? { ...catalog, joomla: dynamicJoomlaChoices(pinnedCatalog, dynamicMetadata.joomla,
      new Map([...selectedJoomlaPackages].filter(([, entry]) => entry.url))).filter(entry => entry.php?.length) } : catalog;
    const selected = deploymentChanged ? selectDeploymentRuntime(descriptor, installableCatalog, {
      joomlaVersion: fields.joomlaVersion.value, phpVersion: fields.phpVersion.value,
    }) : { joomlaVersion: fields.joomlaVersion.value, phpVersion: fields.phpVersion.value };
    const target = { deployId: fields.deployId.value, joomlaVersion: selected.joomlaVersion };
    const stored = deploymentChanged ? undefined : findProfile(target.deployId, target.joomlaVersion);
    const input = {
      ...(stored || {}), ...target,
      phpVersion: selected.phpVersion,
      persistence: true,
      hideToolbar,
      ...(!stored && target.deployId === previous?.deployId ? { language: fields.language.value } : {}),
      storageKey: stored?.storageKey || defaultSiteKey(target.deployId, target.joomlaVersion),
      ...(!stored?.restoredSite && !stored?.joomlaPackage && selectedJoomlaPackages.get(target.joomlaVersion)?.url
        ? { joomlaPackage: structuredClone(selectedJoomlaPackages.get(target.joomlaVersion)) } : {}),
      ...(!target.deployId.startsWith('custom-') ? { admin: { ...administrator(), ...(!stored ? { password: password() } : {}) } } : {}),
    };
    customDeploymentInput(input);
    const major = target.joomlaVersion.split('.')[0];
    const jcbMajor = input.jcbVersion?.split('.')[0];
    if (input.jcbVersion && input.jcbVersion !== 'none' && jcbMajor !== major && !(major === '7' && jcbMajor === '6')) {
      const choices = matchingJcbChoices(major, dynamicMetadata.jcb, pinnedJcb);
      input.jcbVersion = deploymentRequiresJcb(descriptor) ? (choices.find(entry => entry.channel === 'stable') || choices[0])?.version : 'none';
      delete input.jcbPackage;
    }
    const selectedCatalog = catalogWithSelectedJoomlaPackage(catalog, input, deploymentURL);
    const compatible = deploymentPhpVersions(descriptor, selectedCatalog.joomla.find((item) => item.version === target.joomlaVersion));
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
    clearFeedback();
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
$('database-button').addEventListener('click', () => { void openDatabase(); });
$('code-refresh-button').addEventListener('click', () => { void codeHost?.refresh().catch(error => feedback(error, { error: true, persistent: true })); });
$('close-button').addEventListener('click', () => void stopSite());
$('saved-site').addEventListener('change', (event) => void openSavedSite(event.target.value));
$('saved-site-name').addEventListener('input', (event) => {
  savedSiteNameDraft = { key: selectedSiteId, value: event.target.value };
});
$('rename-site-button').addEventListener('click', renameSelectedSite);
$('delete-site-button').addEventListener('click', () => void deleteSelectedSite());
$('stop-countdown').addEventListener('click', pauseAutomaticLaunch);
$('stop-countdown-button').addEventListener('click', pauseAutomaticLaunch);
for (const [id, path] of [['nav-site', '/'], ['nav-admin', '/administrator/']]) {
  $(id).addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) { event.preventDefault(); openRuntimeView(path); }
    else navigatePreview(path);
  });
  $(id).addEventListener('auxclick', event => {
    if (event.button === 1) { event.preventDefault(); openRuntimeView(path); }
  });
}
async function stopSite({ confirmed = false } = {}) {
  if (busy || launching || !runtime) return false;
  if (!confirmed && !confirm(t('lifecycle.stopConfirm'))) return false;
  if (companionRuntime) {
    try { return await companionRuntime.action('stop', { confirmed: true }); }
    catch (error) { feedback(error, { error: true, persistent: true }); return false; }
  }
  return closeSite();
}
async function restartOrStart({ confirmed = false } = {}) {
  if (busy || launching) return false;
  if (companionRuntime) {
    if (companionUnavailable) return resumeCompanionHere();
    if (runtime && !confirmed && !confirm(t('lifecycle.restartConfirm'))) return false;
    try { return await companionRuntime.action(runtime ? 'restart' : 'start', { confirmed: true }); }
    catch (error) { feedback(error, { error: true, persistent: true }); return false; }
  }
  if (!runtime) {
    if (!stoppedSite) return false;
    const input = { ...stoppedSite.input, ...stoppedSite.configuration, persistence: true, fresh: false };
    return launch({ importedConfiguration: input, resumeOnly: true, backupId: sourceBackupId });
  }
  if (runtime.recovery?.filesOnly || (!confirmed && !confirm(t('lifecycle.restartConfirm')))) return false;
  if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return false;
  if (runtimeViewHost && !await runtimeViewHost.prepareTransition('restart')) return false;
  setBusy(true); destroyPreview(); show('loading-view');
  try {
    await runtime.updatePhpSettings(runtime.configuration.phpSettings || DEFAULT_PHP_SETTINGS);
    mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); feedback(t('status.ready'));
    runtimeViewHost?.update(); return true;
  } catch (error) {
    if (runtime?.healthy) mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl)); else displayError(error);
    feedback(error, { error: true }); return false;
  } finally { setBusy(false); }
}
$('restart-button').addEventListener('click', () => void restartOrStart());
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
async function resetSite({ confirmed = false } = {}) {
  if (busy || launching) return;
  if (companionView && !companionRuntime) return requireOwnerForReplacement();
  if (!confirmed && !await confirmLiveReplacement({ reset: true })) return;
  if (companionRuntime) return companionRuntime.action('reset', { confirmed: true });
  pauseAutomaticLaunch();
  const targetKey = runtime?.configuration.storageKey || stoppedSite?.configuration.storageKey || fields.storageKey.value;
  const resetByRuntime = Boolean(runtime);
  if (runtime && !await closeSite({ reset: true })) return;
  setBusy(true);
  let ready = false;
  try {
    if (!resetByRuntime) await resetPlayground({ storageKey: targetKey });
    savedState = forgetSite(savedState, targetKey); writePreferences();
    stoppedSite = undefined; sourceBackupId = undefined;
    preferences?.removeItem(liveMetadataKey);
    const input = { deployId: 'jcb', joomlaVersion: catalog.defaults.joomlaVersion,
      phpVersion: catalog.defaults.phpVersion, persistence: true, fresh: false,
      storageKey: `jcb-default-${crypto.randomUUID().slice(0, 8)}`, admin: { ...administrator(), password: password() } };
    const resolved = await resolve(input);
    applyAdministrator(input.admin);
    applyConfiguration(resolved.configuration, input, resolved.deploy);
    currentConfig = undefined; currentInput = undefined;
    selectedSiteId = null; pendingFresh = false; freshKeyPending = false; resumeLastRoute = false;
    clearFeedback(); show('welcome'); ready = true;
  } catch (error) { feedback(error, { error: true, persistent: true }); }
  finally { setBusy(false); }
  if (ready) await launch();
}
$('save-button').addEventListener('click', () => void saveDeployment());
$('upload-site-button').addEventListener('click', () => { pauseAutomaticLaunch(); $('upload-site-file').click(); });
$('upload-site-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || busy || launching) return;
  pauseAutomaticLaunch();
  setBusy(true);
  let siteExport, importedConfiguration;
  try {
    siteExport = await readSiteExport(file);
    importedConfiguration = configurationForSiteExport(siteExport, catalog, { baseURL: deploymentURL, admin: administrator() });
  } catch (error) { feedback(error, { error: true, persistent: true }); return; }
  finally { setBusy(false); }
  await launch({ siteExport, importedConfiguration });
});
$('export-button').addEventListener('click', async () => {
  if (!runtime || busy) return;
  setBusy(true);
  const format = $('export-format').value;
  activity('Preparing your download…');
  try {
    const result = format === 'recovery' || runtime.recovery?.filesOnly || (runtime.recovery && !runtime.recovery.configured)
      ? await runtime.exportRecoveryFiles()
      : await runtime.exportSite({ format, includePlaygroundConfiguration: format === 'bundle', onProgress: (event) => activity(event.message || event) });
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
fields.deployId.addEventListener('change', () => void changeProfile({ deploymentChanged: true }));
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
  const template = { ...templateOptions, params: parameterInputs ? parameterInputs.read() : parseEditorJSON('template-params', {}) };
  if (url !== templateOptions.url) delete template.sha256;
  if (element !== templateOptions.element) delete template.styleId;
  if (url) template.url = url; else delete template.url;
  if (element) template.element = element; else delete template.element;
  return template;
}
function renderEditorLists() {
  for (const editor of [menuInputs, contentInputs, parameterInputs, overlayInputs, commandInputs]) editor?.refresh();
}
function updateDeploymentFormContext() {
  const context = { ...discoveredConfiguration, language: fields.language.value || 'en-GB', schemaUnavailable: deploymentSchemaUnavailable };
  for (const editor of [menuInputs, contentInputs, parameterInputs, overlayInputs]) editor?.setContext(context);
  const template = discoveredConfiguration?.templates?.find(item => item.template === $('template-name').value);
  if (parameterInputs) parameterInputs.setSchema(template?.schema?.properties?.params || template?.schema || deploymentFormSchemas.parameters);
}
function updateCaptureAction() {
  const available = runtime && !runtime.recovery && !busy && !launching
    && administratorCaptureTargets($('site-frame'), runtime.baseUrl).length > 0;
  for (const id of ['capture-deployment-data', 'capture-deployment-data-editor']) {
    const button = $(id);
    if (button) { button.disabled = !available; button.title = t(available ? 'deployment.captureSaved' : 'deployment.captureUnavailable'); }
  }
}
async function captureDeploymentData() {
  const targets = administratorCaptureTargets($('site-frame'), runtime?.baseUrl);
  if (!runtime?.captureConfiguration || runtime.recovery || busy || launching || !targets.length) {
    feedback(t('deployment.captureUnavailable'), { error: true }); return;
  }
  setBusy(true);
  try {
    for (const target of targets) {
      const captured = await runtime.captureConfiguration({ ...target, uiLanguage: getLocale() });
      for (const related of captured.related || []) overlayInputs.append(related, { schema: related.schema });
      overlayInputs.append(captured.overlay, { schema: captured.schema });
      for (const warning of captured.warnings || []) activity(typeof warning === 'string' ? warning : warning.message);
    }
    markDeploymentEdited();
    activity(t('deployment.captureSuccess'));
    openEditor();
    $('deployment-overlays-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('deployment-capture-feedback').textContent = t('deployment.reviewCopied');
  } catch (error) {
    feedback(t('deployment.captureFailed', { message: messageOf(error) }), { error: true });
  } finally { setBusy(false); }
}
function openEditor() {
  $('deploy-error').hidden = true;
  $('advanced-settings').open = true;
  $('editor-runtime-summary').textContent = `${deploymentDescriptor(fields.deployId.value)?.title || fields.siteName.value} · Joomla ${fields.joomlaVersion.value} · PHP ${fields.phpVersion.value}`;
  updateMcpPreview();
  renderEditorLists(); openDialog('deploy-dialog');
  updateCaptureAction();
  if (runtime?.discoverConfiguration && !runtime.recovery && !busy) void runtime.discoverConfiguration({ uiLanguage: getLocale() }).then(discovered => {
    discoveredConfiguration = discovered;
    $('template-options').replaceChildren(...[...new Set((discovered.templates || []).map(item => item.template))].map(value => { const option = document.createElement('option'); option.value = value; return option; }));
    updateDeploymentFormContext();
  }).catch(error => activity(error));
}

async function saveDeployment({ copy = false } = {}) {
  if (busy || launching || !catalog) return;
  $('deploy-error').hidden = true;
  setBusy(true);
  try {
    const input = formInput();
    const resolved = await resolve(input);
    const existing = customRegistry.deployments.find(entry => entry.id === fields.deployId.value);
    const builtInNames = deployCatalog.deploys.map(entry => entry.title);
    let name = $('deployment-name').value.trim() || resolved.deploy?.title || resolved.configuration.siteName;
    if (builtInNames.includes(name) || (copy && customRegistry.deployments.some(entry => entry.title === name))) {
      name = customDeploymentName(name, [...builtInNames, ...customRegistry.deployments.map(entry => entry.title)]);
    }
    const document = createFullDeploymentDocument(resolved.configuration, { name,
      requirements: editorRequirements(resolved.configuration), baseURL: deploymentURL });
    const saved = saveCustomDeployment(preferences, customRegistryKey, customRegistry, document, {
      id: copy ? undefined : existing?.id, builtInNames,
    });
    customRegistry = saved.registry;
    const selected = { ...parseDeploymentDocument(saved.entry.document, { baseURL: deploymentURL }),
      deployId: saved.entry.id, storageKey: fields.storageKey.value };
    const result = await resolve(selected);
    applyConfiguration(result.configuration, selected, result.deploy);
    applyAdministrator(selected.admin);
    $('deployment-save-status').textContent = `Saved “${saved.entry.title}”.`;
    $('deployment-save-status').hidden = false;
    feedback($('deployment-save-status').textContent);
  } catch (error) { editorError(error); }
  finally { setBusy(false); }
}
async function removeDeployment() {
  if (busy || launching) return;
  const selected = customRegistry.deployments.find(entry => entry.id === fields.deployId.value);
  if (!selected || !confirm(`Delete deployment “${selected.title}”?`)) return;
  try {
    customRegistry = deleteCustomDeployment(preferences, customRegistryKey, customRegistry, selected.id);
    for (const key of drafts.keys()) if (key.startsWith(`${selected.id}:`)) drafts.delete(key);
    renderDeploymentChoices(deployCatalog.default);
    await changeProfile({ deploymentChanged: true });
    openEditor();
  } catch (error) { editorError(error); }
}
function editorError(error) { $('deploy-error').textContent = messageOf(error); $('deploy-error').hidden = false; }
function saveSite({ quiet = false } = {}) {
  if (savePromise && savingSite === runtime) return savePromise;
  if (!runtime || busy || runtime.recovery?.filesOnly) return Promise.resolve(false);
  const handle = runtime;
  savingSite = handle; saveFailed = false; updateSaveState();
  savePromise = (async () => {
    try {
      await handle.flush(); lastSavedAt = new Date(); autosave?.saved(); rememberCurrentSite();
      if (!quiet) feedback(t('lifecycle.persisted'));
      return true;
    } catch (error) {
      saveFailed = true; activity(error);
      if (!quiet) feedback(t('lifecycle.persistFailed'), { error: true, persistent: true });
      return false;
    } finally { savingSite = undefined; savePromise = undefined; updateSaveState(); }
  })();
  return savePromise;
}
function showShare(input) {
  try {
    input ||= currentInput || formInput();
    sharedConfiguration = input;
    $('copy-share').disabled = false;
    $('share-summary').textContent = `${input.siteName || fields.siteName.value} · Joomla ${input.joomlaVersion || fields.joomlaVersion.value} · PHP ${input.phpVersion || fields.phpVersion.value}`;
    $('share-url').value = createShareURL(location.href, input, { immediate: $('share-immediate').checked });
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
async function downloadConfiguration(input) {
  const fromEditor = !input;
  input ||= formInput();
  const resolved = await resolve(input);
  const name = (fromEditor ? $('deployment-name').value.trim() : input.deploymentRecipe?.name) || resolved.deploy?.title || resolved.configuration.siteName;
  const body = JSON.stringify(createFullDeploymentDocument(resolved.configuration, {
    name, requirements: editorRequirements(resolved.configuration, resolved.deploy), baseURL: deploymentURL,
  }), null, 2);
  const url = URL.createObjectURL(new Blob([`${body}\n`], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'joomengine-deploy.json';
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function useDeployment() {
  if (!requireOwnerForReplacement()) return;
  if (busy || launching || !catalog) return;
  $('deploy-error').hidden = true;
  try {
    let input = formInput();
    const storageKey = `${defaultSiteKey(input.deployId, input.joomlaVersion).slice(0, 44)}-site-${crypto.randomUUID().slice(0, 8)}`;
    const sourceSite = runtime?.configuration && runtime.configuration.storageKey === input.storageKey ? runtime.configuration : savedState.sites[input.storageKey];
    const changesInstalledJcb = sourceSite && input.joomlaVersion === sourceSite.joomlaVersion
      && input.jcbVersion && input.jcbVersion !== 'none' && input.jcbVersion !== (sourceSite.jcbVersion || 'none');
    if (input.restoredSite || changesInstalledJcb) {
      if (input.jcbVersion && input.jcbVersion !== 'none' && !input.jcbPackage) {
        await prepareDynamicInput(input);
        const pin = [...pinnedJcb.values()].find(item => item.version === input.jcbVersion);
        if (!input.jcbPackage && pin) input.jcbPackage = structuredClone(pin.package);
      }
      input = (await resolve(input)).configuration;
      setBusy(true);
      let copy;
      try {
        if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return;
        if (databaseHost && !databaseHost.closed && !await databaseHost.beforeClose()) return;
        const sourceConfiguration = { ...(sourceSite || editorConfiguration),
          storageKey: input.storageKey, admin: input.admin };
        copy = await prepareUploadedSiteCopy({ input, sourceConfiguration, runtime, storageKey, administratorEdited,
          open: async source => createPlayground((await resolve(source)).configuration, { onProgress: progress }) });
      } finally { setBusy(false); }
      freshKeyPending = false; selectedSiteId = null; resumeLastRoute = false;
      $('deploy-dialog').close();
      await launch({ checkpoint: copy.checkpoint, importedConfiguration: copy.configuration, deploymentChanges: copy.changes,
        rotateAdministrator: copy.rotateAdministrator, jcbUpgrade: copy.jcbUpgrade });
      return;
    }
    // Using a recipe creates an independent installation, including when a
    // saved site's runtime is closed. Dashboard Launch resumes that saved site.
    input = { ...input, storageKey };
    const resolved = await resolve(input);
    applyConfiguration(resolved.configuration, input, resolved.deploy); applyAdministrator(input.admin);
    freshKeyPending = false;
    refreshNightlyOnNextLaunch = dynamicMetadata.joomla.some(entry => entry.version === input.joomlaVersion && entry.source === 'nightly');
    selectedSiteId = null; resumeLastRoute = false; renderSavedSites();
    $('deploy-dialog').close();
    await launch();
  } catch (error) { editorError(error); }
}
async function applyDeployment() {
  if (!requireOwnerForReplacement()) return;
  if (busy || launching || closing || !runtime) return;
  $('deploy-error').hidden = true;
  setBusy(true);
  try {
    if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return;
    if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return;
    if (databaseHost && !databaseHost.closed && !await databaseHost.beforeClose()) return;
    const input = formInput({ storageKey: currentConfig.storageKey, persistence: currentConfig.persistence, fresh: false });
    const resolved = await resolve(input);
    setBusy(true); destroyPreview(); show('loading-view');
    await runtime.applyConfiguration(resolved.configuration);
    showExtensionWarnings(runtime.installation?.extensionWarnings);
    currentConfig = runtime.configuration; currentInput = input;
    applyConfiguration(currentConfig, currentInput, resolved.deploy);
    runningAdministrator = runtime.installation?.administrator || currentInput.admin;
    applyAdministrator(runningAdministrator);
    lastSavedAt = currentConfig.persistence ? new Date() : undefined;
    saveFailed = false;
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
        await databaseHost?.dispose(); databaseHost = undefined;
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

function requireOwnerForReplacement() {
  if (!companionView) return true;
  feedback('This window shares an existing live site. Use its original Playground window to deploy, upload, restore, or replace the site.', { error: true, persistent: true });
  return false;
}

async function beforeCompanionTransition(action) {
  if (openingCode || openingDatabase) return false;
  if (previewDirty && !confirm(t('confirm.unsavedSiteForm'))) return false;
  if (action === 'restart') return true;
  if (codeHost && !codeHost.closed && !await codeHost.beforeClose()) return false;
  if (databaseHost && !databaseHost.closed && !await databaseHost.beforeClose()) return false;
  return true;
}

function registerRuntimeViewLifecycle() {
  if (companionLifecycleRegistered) return;
  companionLifecycleRegistered = true;
  window.addEventListener('pagehide', () => {
    // Closing a view only detaches its tools. Only the owner owns the workers.
    companionRuntime?.dispose();
    runtimeViewHost?.dispose();
    runtimeViewHost = undefined;
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (companionView) location.reload();
    else if (runtime) hostRuntimeViews();
  });
  window.addEventListener('beforeunload', event => {
    if (runtimeViewHost?.clients && runtime) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', event => {
    if (event.key !== liveMetadataKey) return;
    const live = readLiveMetadata();
    if (live?.storageKey === currentConfig?.storageKey) {
      sourceBackupId = live.sourceBackupId;
      backupPanel?.updateState();
    }
  });
}

function hostRuntimeViews() {
  if (!runtime || runtime.isRemoteView) return;
  registerRuntimeViewLifecycle();
  if (runtimeViewHost) { runtimeViewHost.update(); return; }
  runtimeViewHost = createRuntimeViewHost({
    getRuntime: () => runtime, baseURL: deploymentURL, storage: preferences,
    onAction(action, options) {
      if (action === 'stop') return stopSite(options);
      if (action === 'start' || action === 'restart') return restartOrStart(options);
      if (action === 'reset') return resetSite(options);
      if (action === 'backup') return openImages();
      throw new Error('This site action is unavailable.');
    },
    onState(snapshot) {
      if (!runtime || runtime.isRemoteView || !currentConfig || !snapshot?.configuration) return;
      // Runtime PHP controls are available in every view. Preserve unfinished
      // deployment form choices while keeping live runtime metadata current.
      currentConfig = { ...currentConfig, phpVersion: snapshot.configuration.phpVersion,
        phpSettings: snapshot.configuration.phpSettings };
      currentInput = { ...currentInput, phpVersion: currentConfig.phpVersion, phpSettings: currentConfig.phpSettings };
      lastSavedAt = snapshot.lastSavedAt ? new Date(snapshot.lastSavedAt) : lastSavedAt;
    },
    onError: error => activity(error),
  });
}

function openRuntimeView(path = currentSitePath) {
  if (busy || !runtime?.healthy || runtime.recovery) return;
  if (!runtime.isRemoteView) hostRuntimeViews();
  const url = companionView
    ? runtimeViewURL({ token: companionView.token, path, baseURL: deploymentURL })
    : runtimeViewHost?.url(path);
  if (url) window.open(url, '_blank', 'noopener');
}

function applyCompanionSnapshot(snapshot, { unavailable = false } = {}) {
  if (!companionRuntime || !snapshot?.configuration) return;
  const previous = companionSnapshot;
  companionSnapshot = snapshot;
  companionUnavailable = unavailable;
  const changed = !previous || previous.workspace.id !== snapshot.workspace.id || previous.baseUrl !== snapshot.baseUrl;
  const running = !unavailable && !snapshot.closed;
  currentConfig = { ...snapshot.configuration, persistence: true, fresh: false };
  currentInput = { ...currentConfig };
  const live = readLiveMetadata();
  if (live?.storageKey === currentConfig.storageKey) {
    sourceBackupId = live.sourceBackupId;
    currentLiveManaged = Boolean(live.managed);
  }
  lastSavedAt = snapshot.lastSavedAt ? new Date(snapshot.lastSavedAt) : undefined;
  saveFailed = Boolean(snapshot.persistenceError);
  if (changed) {
    if (currentConfig.restoredSite) catalog = catalogForRestoredSite(catalog, currentConfig);
    applyConfiguration(currentConfig, currentInput, deploymentDescriptor(currentConfig.deployId));
  }
  if (running) {
    const hadRuntime = Boolean(runtime);
    runtime = companionRuntime;
    stoppedSite = undefined;
    runningSiteId = currentConfig.storageKey;
    selectedSiteId = currentConfig.storageKey;
    runningAdministrator = snapshot.installation?.administrator || currentConfig.admin;
    applyAdministrator(runningAdministrator);
    if (changed || !hadRuntime) {
      currentSitePath = safeSavedRoute(previous ? currentSitePath : companionView.path, currentConfig.initialPath);
      mountPreview(resolveSiteURL(currentSitePath, runtime.baseUrl));
      setDrawer(false);
      $('deploy-dialog').close();
    }
  } else {
    runtime = undefined;
    stoppedSite = { configuration: currentConfig, input: currentInput, path: currentSitePath };
    runningSiteId = null;
    // An unexpected owner loss must leave unsaved editor/SQL text available.
    // Confirmed owner transitions have already checked each view's drafts.
    if (!unavailable && (!previous?.closed || changed)) {
      const previousCode = codeHost, previousDatabase = databaseHost;
      codeHost = databaseHost = undefined;
      void Promise.all([previousCode?.dispose(), previousDatabase?.dispose()]).catch(error => activity(error));
    }
    if (previous && !previous.closed || changed) destroyPreview();
    show('welcome');
  }
  setBusy(busy);
  if (unavailable) feedback('The original Playground window closed. The saved live site is still available. Unsaved editor text remains open; preserve it before selecting Start to resume the saved site here.', { persistent: true });
}

async function connectRuntimeView(selection) {
  registerRuntimeViewLifecycle();
  let latest, latestState;
  const proxy = await attachRuntimeView({
    token: selection.token, baseURL: deploymentURL,
    beforeTransition: beforeCompanionTransition,
    onState(snapshot, state) {
      latest = snapshot; latestState = state;
      if (companionRuntime) applyCompanionSnapshot(snapshot, state);
    },
  });
  companionView = selection;
  companionRuntime = proxy;
  companionSnapshot = undefined;
  applyCompanionSnapshot(latest, latestState);
  launchCountdown.stop();
  $('launch-countdown').hidden = $('dashboard-countdown').hidden = true;
  activity('Connected to the existing live site. This window shares its files and database without starting another runtime.');
}

async function resumeCompanionHere() {
  if (!companionRuntime || !companionUnavailable || busy || launching) return false;
  const input = { ...companionRuntime.configuration, persistence: true, fresh: false };
  if (!confirm('Start the saved live site in this window? It resumes the last persisted files and database. Unsaved changes from a closed runtime cannot be recovered.')) return false;
  try {
    if (!await beforeCompanionTransition()) return false;
    await codeHost?.dispose(); codeHost = undefined;
    await databaseHost?.dispose(); databaseHost = undefined;
    companionRuntime.dispose(); companionRuntime = undefined;
    companionView = undefined; companionSnapshot = undefined; companionUnavailable = false;
    currentConfig = input; currentInput = input;
    stoppedSite = { configuration: input, input, path: currentSitePath };
    history.replaceState(null, '', runtimeLocation(location.href, { ...input, initialPath: safeSavedRoute(currentSitePath, input.initialPath) }));
    return await launch({ importedConfiguration: input, resumeOnly: true, backupId: sourceBackupId });
  } catch (error) { feedback(error, { error: true, persistent: true }); return false; }
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
    baseURL: deploymentURL, t, onChange: markDeploymentEdited,
  });
  const structured = (kind, textarea, container, advanced, error, validate) => createStructuredInputs({
    kind, textarea: $(textarea), container: $(container), advanced: $(advanced), errorElement: $(error),
    validate, schema: deploymentFormSchemas[kind], context: { schemaUnavailable: deploymentSchemaUnavailable }, onChange: markDeploymentEdited,
    onSchemaRequest: target => runtime?.discoverConfiguration && !runtime.recovery
      ? runtime.discoverConfiguration({ ...target, uiLanguage: getLocale() }) : null,
  });
  commandInputs = structured('commands', 'startup-commands', 'command-inputs', 'commands-advanced', 'command-error', parseStartupCommands);
  parameterInputs = structured('parameters', 'template-params', 'template-parameter-inputs', 'template-advanced', 'template-parameter-error');
  menuInputs = structured('menus', 'deploy-menus', 'menu-inputs', 'menus-advanced', 'menu-input-error');
  contentInputs = structured('content', 'deploy-content', 'content-inputs', 'content-advanced', 'content-input-error');
  overlayInputs = structured('overlays', 'deploy-overlays', 'overlay-inputs', 'overlays-advanced', 'overlay-input-error', normalizeDeploymentOverlays);
  for (const id of ['capture-deployment-data', 'capture-deployment-data-editor']) $(id).addEventListener('click', () => void captureDeploymentData());
  $('template-name').addEventListener('change', updateDeploymentFormContext);
  fields.language.addEventListener('change', updateDeploymentFormContext);
  for (const button of document.querySelectorAll('[data-deployment-section]')) button.addEventListener('click', () => {
    $('advanced-settings').open = true;
    $(button.dataset.deploymentSection)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('installation-fields').addEventListener('input', markDeploymentEdited);
  $('installation-fields').addEventListener('change', markDeploymentEdited);
  $('editor-deployment').addEventListener('change', async event => {
    fields.deployId.value = event.target.value;
    await changeProfile({ deploymentChanged: true });
  });
  $('edit-deployment').addEventListener('click', openEditor);
  $('save-deployment').addEventListener('click', () => void saveDeployment());
  $('copy-deployment').addEventListener('click', () => void saveDeployment({ copy: true }));
  $('delete-deployment').addEventListener('click', () => void removeDeployment());
  $('new-deployment').addEventListener('click', async () => {
    fields.deployId.value = 'blank';
    await changeProfile({ deploymentChanged: true });
    $('deployment-name').value = customDeploymentName('New deployment', customRegistry.deployments.map(entry => entry.title));
    $('site-name').focus();
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
    renderBuildUpdate();
    if (catalog) setBusy(busy);
    if (runtime && currentConfig) $('preview-label').textContent = currentConfig.siteName;
    $('credentials-button').textContent = `${t('title.credentials')}${$('credentials-button').dataset.signedOut === 'true' ? ` · ${t('status.signedOut')}` : ''}`;
    $('site-frame')?.setAttribute('title', t('a11y.site'));
    updateDrawerLabels();
    renderSavedSites(); renderEditorLists();
    languageSelector?.refresh(); deploymentLanguageSelector?.refresh();
    extensionInputs?.refresh();
    updateCaptureAction();
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
  setupBackups();
  $('download-dialog-button').addEventListener('click', () => openDialog('download-dialog'));
  $('credentials-button').addEventListener('click', () => {
    updateMcpPreview();
    populateCredentialsDialog({ dialog: $('credentials-dialog'), administrator: runningAdministrator, installation: runtime?.installation });
    $('reveal-credentials').textContent = t('action.show'); openDialog('credentials-dialog');
  });
  $('reveal-credentials').addEventListener('click', () => { const show = $('credential-password').type === 'password'; $('credential-password').type = show ? 'text' : 'password'; $('reveal-credentials').textContent = t(show ? 'action.hide' : 'action.show'); });
  $('credential-login').addEventListener('click', () => {
    loginFromCredentialsDialog({ dialog: $('credentials-dialog'), frame: $('site-frame'),
      administrator: runningAdministrator, baseURL: runtime?.baseUrl,
      administratorUnavailable: runtime?.installation?.administratorUnavailable });
  });
  $('go-administrator').addEventListener('click', () => { if (runtime) navigatePreview('/administrator/'); $('credentials-dialog').close(); });
  $('copy-share').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('share-url').value); $('share-feedback').textContent = t('status.copied'); } catch { $('share-url').focus(); $('share-url').select(); $('share-feedback').textContent = t('help.clipboard'); } });
  $('share-immediate').addEventListener('change', () => showShare(sharedConfiguration));
  $('share-export-config').addEventListener('click', () => void downloadConfiguration(sharedConfiguration).catch(error => { $('share-feedback').textContent = messageOf(error); }));
  $('native-share').addEventListener('click', async () => { try { await navigator.share({ title: sharedConfiguration?.siteName || 'JoomEngine Rocket', url: $('share-url').value }); } catch (error) { if (error.name !== 'AbortError') $('share-feedback').textContent = messageOf(error); } });
  $('use-deploy').addEventListener('click', () => void useDeployment());
  $('apply-deploy').addEventListener('click', () => void applyDeployment());
  $('export-config').addEventListener('click', () => void downloadConfiguration().catch(editorError));
  $('import-config').addEventListener('change', async event => { try {
    const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new RangeError('The deployment document exceeds 1 MiB.');
    const input = parseDeploymentDocument(await file.text(), { baseURL: deploymentURL });
    input.admin ||= administrator();
    const resolved = await resolve(input);
    const builtInNames = deployCatalog.deploys.map(entry => entry.title);
    let name = input.deploymentRecipe?.name || resolved.deploy?.title || resolved.configuration.siteName;
    if ([...builtInNames, ...customRegistry.deployments.map(entry => entry.title)].includes(name)) name = customDeploymentName(name, [...builtInNames, ...customRegistry.deployments.map(entry => entry.title)]);
    const document = createFullDeploymentDocument(resolved.configuration, { name,
      requirements: input.deploymentRecipe?.requirements || { ...resolved.deploy.requirements, joomla: resolved.deploy.joomla }, baseURL: deploymentURL });
    const saved = saveCustomDeployment(preferences, customRegistryKey, customRegistry, document, { builtInNames });
    customRegistry = saved.registry;
    const selected = { ...parseDeploymentDocument(saved.entry.document, { baseURL: deploymentURL }), deployId: saved.entry.id };
    selected.storageKey = defaultSiteKey(selected.deployId, selected.joomlaVersion);
    const ready = await resolve(selected); applyConfiguration(ready.configuration, selected, ready.deploy); applyAdministrator(selected.admin);
    resumeLastRoute = false; openEditor();
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
  for (const event of ['input', 'change']) $('launch-form').addEventListener(event, () => { pauseAutomaticLaunch(); updateLaunchReadiness(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAutomaticLaunch();
    else void buildUpdates.check();
  });
  window.addEventListener('focus', () => { if (!document.hidden) void buildUpdates.check(); });
  window.addEventListener('beforeunload', event => {
    if (!runtime || runtime.isRemoteView || (!runtime.persistencePending && !runtime.persistenceError && !previewDirty)) return;
    event.preventDefault(); event.returnValue = '';
  });
  $('reload-build').addEventListener('click', () => {
    if (buildUpdates.pending && !runtime && !busy && !launching && !closing) location.reload();
  });
  window.addEventListener('pagehide', () => launchCountdown.stop());
  autosave = startAutosave({
    canSave: () => runtime?.idle && !runtime.subscribePersistence && !runtime.isRemoteView && !runtime.recovery && currentConfig?.persistence
      && !busy && !launching && !savePromise && (!lastSavedAt || document.visibilityState === 'visible'),
    save: () => saveSite({ quiet: true }),
    onError: error => activity(`Autosave failed: ${messageOf(error)}`),
  });
}

async function initialize() {
  try {
    await initializeLocale();
    $('interface-language').value = getLocale();
    const parsed = readURLConfiguration(location.href);
    const requestedView = readRuntimeViewURL(location.href);
    companionView = requestedView;
    if (parsed.document) parsed.config = { ...await loadDeploymentDocument(parsed.document.url, { baseURL: deploymentURL }), ...parsed.config };
    const params = new URL(location.href).searchParams;
    resumeLastRoute = !parsed.document && !new URL(location.href).hash.startsWith('#deploy=') && !params.has('path') && !params.has('initialPath') && !parsed.config.fresh;
    setFocusMode(parsed.config.hideToolbar);
    $('embedded-launch').hidden = false;
    activity('Preparing browser support for PHP and MariaDB…');
    const environment = await prepareEnvironment();
    if (environment.reloadRequired) {
      activity(environment.reason);
      location.replace(environment.reloadURL); return;
    }
    // This document will not navigate again for bootstrap. Keep shell interaction
    // checks distinct from the later asynchronous catalog/runtime readiness.
    document.documentElement.dataset.playgroundEnvironment = 'ready';
    if (environment.diagnostic) activity(environment.diagnostic);
    if (await buildUpdates.check({ force: true })) return;
    $('admin-password').value = password();
    const [manifest, recipes] = await Promise.all([
      networkFetch(new URL('../assets/manifest.json', import.meta.url), { cache: 'no-cache' }).then(async (response) => {
        if (!response.ok) throw new Error(`The runtime catalog is unavailable (HTTP ${response.status}).`);
        return response.json();
      }), loadDeployCatalog(),
    ]);
    launchManifest = manifest;
    catalog = pinnedCatalog = parseCatalog(manifest, { baseURL: new URL('../assets/manifest.json', import.meta.url) });
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
    const activeView = readActiveRuntimeView({ storage: preferences, baseURL: deploymentURL });
    const sharedView = requestedView || (!parsed.config.fresh && activeView
      && (!hasOptions || parsed.config.storageKey === activeView.storageKey) ? {
        ...activeView, path: parsed.config.initialPath || activeView.path,
      } : null);
    if (sharedView) {
      initialized = true;
      try { await connectRuntimeView(sharedView); return; }
      catch (error) {
        // A requested companion must never silently become a new deployment.
        // A stale discovery marker may instead resume the existing saved site.
        if (requestedView || companionRuntime) throw error;
        activity('The previous runtime window is unavailable. Checking the saved live site…');
      }
    }
    const live = readLiveMetadata();
    const keyed = parsed.config.storageKey && Object.hasOwn(savedState.sites, parsed.config.storageKey)
      ? savedState.sites[parsed.config.storageKey] : null;
    const previous = keyed || (!hasOptions && (savedState.sites[live?.storageKey] || savedState.sites[savedState.active])) || null;
    let input = { ...(previous || {}), ...(previous?.deployId ? { deployId: previous.deployId } : {}), ...parsed.config, persistence: true, admin: administrator() };
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
      if (saved) input = { ...saved, ...parsed.config, persistence: true, admin: administrator() };
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
    const shouldResume = Boolean(previous) && !parsed.config.fresh && (!params.has('start') || parsed.autostart);
    if (live?.stopped && live.storageKey === resolved.configuration.storageKey && !parsed.config.fresh) {
      currentLiveManaged = Boolean(live.managed);
      currentConfig = { ...resolved.configuration, persistence: true, fresh: false };
      currentInput = { ...input, persistence: true, fresh: false };
      currentSitePath = safeSavedRoute(live.path, currentConfig.initialPath);
      stoppedSite = { configuration: currentConfig, input: currentInput, path: currentSitePath };
      sourceBackupId = live.sourceBackupId;
      setBusy(false);
      activity(t('lifecycle.stopped'));
      return;
    }
    activity(shouldResume ? 'Reopening your saved site…' : 'Ready to launch. Choose a starting point and your runtime versions.');
    if ((!params.has('start') || parsed.autostart) && !automaticLaunchPaused && !document.hidden) {
      if (shouldResume) void launch({ importedConfiguration: input, resumeOnly: true });
      else if (parsed.immediate) void launch();
      else launchCountdown.start();
    }
  } catch (error) {
    setBusy(false);
    displayError(error, t('title.error'));
    $('retry-button').hidden = true;
  }
}

async function startInterface() {
  try { deploymentFormSchemas = await loadDeploymentFormSchemas({ fetcher: networkFetch }); }
  catch { deploymentSchemaUnavailable = true; }
  setupInterface();
  $('deployment-schema-error').hidden = !deploymentSchemaUnavailable;
  setBusy(false);
  await initialize();
}
void startInterface();
