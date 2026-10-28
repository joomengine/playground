const CHANNEL_PREFIX = 'joomengine:standalone:';
const TOKEN = /^[a-f0-9-]{36}$/;

function receive(channel, type, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { channel.removeEventListener('message', listener); reject(new Error('The standalone tab did not respond.')); }, timeout);
    const listener = event => {
      if (event.data?.type !== type && event.data?.type !== 'error') return;
      clearTimeout(timer); channel.removeEventListener('message', listener);
      if (event.data.type === 'error') reject(new Error(event.data.message || 'The standalone tab could not open the site.'));
      else resolve(event.data);
    };
    channel.addEventListener('message', listener);
  });
}

/** Transfer ownership, never allow a second writer to acquire an active saved database. */
export async function openStandalone(runtime, { path = '/' } = {}) {
  const token = crypto.randomUUID();
  const url = new URL(`../standalone.html#handoff=${token}`, import.meta.url);
  const channel = new BroadcastChannel(CHANNEL_PREFIX + token);
  const ready = receive(channel, 'ready', 60_000);
  // Open synchronously in the button's activation event, before preparing a checkpoint.
  const tab = window.open(url.href, '_blank');
  if (!tab) { channel.close(); ready.catch(() => {}); throw new Error('Allow the standalone tab to open, then try again.'); }
  let checkpoint;
  try {
    await ready;
    const configuration = runtime.configuration;
    configuration.initialPath = path;
    configuration.hideToolbar = true;
    if (configuration.persistence) await runtime.flush();
    else checkpoint = await runtime.checkpoint();
    await runtime.close();
    const opened = receive(channel, 'opened', 600_000);
    channel.postMessage({ type: 'site', configuration, checkpoint });
    await opened;
    return { url: url.href };
  } catch (error) {
    if (runtime.closed) error.recovery = { configuration: runtime.configuration, checkpoint };
    throw error;
  } finally { channel.close(); }
}

export async function receiveStandaloneConfiguration() {
  const token = new URLSearchParams(location.hash.slice(1)).get('handoff');
  if (!TOKEN.test(token || '')) return null;
  const channel = new BroadcastChannel(CHANNEL_PREFIX + token);
  const payload = receive(channel, 'site', 600_000);
  channel.postMessage({ type: 'ready' });
  const announce = setInterval(() => channel.postMessage({ type: 'ready' }), 1000);
  try {
    const result = await payload;
    return { ...result, complete: () => { channel.postMessage({ type: 'opened' }); channel.close(); }, fail: error => { channel.postMessage({ type: 'error', message: error.message }); channel.close(); } };
  } catch (error) { channel.close(); throw error; }
  finally { clearInterval(announce); }
}
