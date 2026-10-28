import { createPlayground, prepareEnvironment } from './playground.mjs';
import { receiveStandaloneConfiguration } from './standalone-transfer.mjs';
import { publicConfiguration } from './ui-state.mjs';

const status = document.querySelector('#message');
const frame = document.querySelector('#site');
const key = `joomengine:standalone:${new URL('../', import.meta.url).href}`;
let runtime;
let transfer;

try {
  const environment = await prepareEnvironment();
  if (environment.reloadRequired) location.reload();
  else {
    transfer = await receiveStandaloneConfiguration();
    let configuration = transfer?.configuration;
    if (!configuration) {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (!saved?.persistence) throw new Error('This temporary site is no longer open. Return to Rocket to start a new site.');
      configuration = { ...saved, admin: { password: `Rocket!${crypto.randomUUID()}` } };
    }
    runtime = await createPlayground(configuration, { checkpoint: transfer?.checkpoint, onProgress: value => { status.textContent = value.message; } });
    sessionStorage.setItem(key, JSON.stringify(publicConfiguration(runtime.configuration)));
    history.replaceState(null, '', `${location.pathname}${configuration.persistence ? `?site=${encodeURIComponent(configuration.storageKey)}` : ''}`);
    frame.src = runtime.url;
    frame.hidden = false;
    document.querySelector('#launch').hidden = true;
    transfer?.complete();
    setInterval(() => {
      if (!runtime.closed && !runtime.changing && runtime.configuration.persistence && document.visibilityState === 'visible') runtime.flush().catch(error => {
        status.textContent = error.message; document.querySelector('#launch').hidden = false;
      });
    }, 60_000);
  }
} catch (error) {
  transfer?.fail(error);
  status.textContent = error.message;
  document.querySelector('#launch').hidden = false;
}
