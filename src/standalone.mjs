import { createPlayground, prepareEnvironment } from './playground.mjs';
import { receiveStandaloneConfiguration } from './standalone-transfer.mjs';
import { publicConfiguration } from './ui-state.mjs';

const status = document.querySelector('#message');
function mountSite(url) {
  const frame = document.createElement('iframe');
  frame.id = 'site';
  frame.title = 'Joomla site';
  frame.referrerPolicy = 'same-origin';
  frame.addEventListener('load', () => {
    // Component popup callbacks reload Joomla rather than its runtime owner.
    try {
      const view = frame.contentWindow;
      if (frame.contentDocument?.body && view) Object.defineProperty(view, 'parent', { configurable: true, value: view });
    } catch { /* An external navigation retains its native browsing context. */ }
  });
  // Firefox must receive the destination before an initial blank document exists.
  frame.src = url;
  document.querySelector('#site-mount').replaceChildren(frame);
}
const keyPrefix = `joomengine:standalone:${new URL('../', import.meta.url).href}:`;
let runtime;
let transfer;

try {
  const environment = await prepareEnvironment();
  if (environment.reloadRequired) location.reload();
  else {
    transfer = await receiveStandaloneConfiguration();
    let configuration = transfer?.configuration;
    if (!configuration) {
      const site = new URL(location.href).searchParams.get('site');
      let saved = site ? history.state?.rocketSite : null;
      if (!saved && site) {
        try { saved = JSON.parse(sessionStorage.getItem(keyPrefix + site) || 'null'); } catch { /* Resume preferences are optional. */ }
      }
      if (!saved?.persistence) throw new Error('This temporary site is no longer open. Return to Rocket to start a new site.');
      if (saved.storageKey !== site) throw new Error('The standalone site identity does not match its saved settings.');
      configuration = { ...saved, admin: { password: `Rocket!${crypto.randomUUID()}` } };
    }
    runtime = await createPlayground(configuration, { checkpoint: transfer?.checkpoint, onProgress: value => { status.textContent = value.message; } });
    const resumeSettings = configuration.persistence ? publicConfiguration(runtime.configuration) : null;
    if (resumeSettings) {
      try { sessionStorage.setItem(keyPrefix + configuration.storageKey, JSON.stringify(resumeSettings)); } catch { /* History retains this tab's public resume settings. */ }
    }
    history.replaceState(resumeSettings ? { rocketSite: resumeSettings } : null, '', `${location.pathname}${configuration.persistence ? `?site=${encodeURIComponent(configuration.storageKey)}` : ''}`);
    mountSite(runtime.url);
    document.querySelector('#launch').hidden = true;
    transfer?.complete();
    setInterval(() => {
      if (!runtime.closed && !runtime.changing && runtime.configuration.persistence && document.visibilityState === 'visible') runtime.flush().catch(error => {
        status.textContent = error.message; document.querySelector('#launch').hidden = false;
      });
    }, 60_000);
  }
} catch (error) {
  if (runtime && !runtime.closed) {
    try { await runtime.close(); } catch (cleanupError) { error.message += ` Cleanup: ${cleanupError.message}`; }
  }
  transfer?.fail(error);
  status.textContent = error.message;
  document.querySelector('#launch').hidden = false;
}
