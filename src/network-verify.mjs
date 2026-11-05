import { loadNetworkConfiguration } from './network-session.mjs';

const status = document.getElementById('status');
const nonce = location.hash.slice(1);
let channel, widget, completed = false;
function finish(error, token) {
  if (completed) return; completed = true;
  channel?.postMessage(error ? { type: 'failed' } : { type: 'verified', token });
  if (widget !== undefined) globalThis.turnstile?.remove(widget);
  status.textContent = error ? 'Verification could not be completed. Close this window and try the request again.' : 'Verified. You can close this window and return to Playground.';
  document.getElementById('close').textContent = 'Close';
}
async function loadTurnstile() {
  if (globalThis.turnstile?.render) return globalThis.turnstile;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true; script.defer = true;
    script.onload = resolve; script.onerror = () => reject(new Error('Verification script unavailable.'));
    document.head.append(script);
  });
  if (!globalThis.turnstile?.render) throw new Error('Verification service unavailable.');
  return globalThis.turnstile;
}
try {
  if (window.top !== window || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) throw new Error('Open verification from Playground.');
  channel = new BroadcastChannel(`joomengine-network-${nonce}`);
  channel.onmessage = event => {
    if (['cancel', 'complete'].includes(event.data?.type)) {
      completed = true;
      if (widget !== undefined) globalThis.turnstile?.remove(widget);
      channel.close(); window.close();
    }
  };
  const config = await loadNetworkConfiguration(new URL('../', import.meta.url));
  if (!config.enabled || !config.turnstileSiteKey) throw new Error('Verification is disabled.');
  const turnstile = await loadTurnstile();
  status.textContent = 'Complete the verification below to continue your network request.';
  widget = turnstile.render(document.getElementById('verification'), {
    sitekey: config.turnstileSiteKey, action: 'network-session',
    callback: token => finish(null, token),
    'error-callback': () => { finish(new Error('Verification failed.')); return true; },
    'expired-callback': () => finish(new Error('Verification expired.')),
    'timeout-callback': () => finish(new Error('Verification timed out.')),
  });
} catch (error) { finish(error); }
document.getElementById('close').addEventListener('click', () => { if (!completed) finish(new Error('Cancelled.')); window.close(); });
window.addEventListener('pagehide', () => { if (!completed) finish(new Error('Closed.')); channel?.close(); }, { once: true });
