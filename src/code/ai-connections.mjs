/** Isolated session vault. This function is serialized into an opaque sandbox. */
export function runConnectionBroker({ nonce, hostOrigin }) {
  const connections = new Map(), sessions = new Map(), peers = new Set();
  let latest;
  function connect(event) {
    if (event.source !== parent || event.origin !== hostOrigin || event.data?.type !== 'jec-ai-broker-connect' || event.data.nonce !== nonce || event.ports.length !== 1) return;
    removeEventListener('message', connect);
    const control = event.ports[0];
    control.onmessage = event => {
      if (event.data?.operation !== 'attach' || event.ports.length !== 1) return;
      const port = event.ports[0]; peers.add(port);
      while (peers.size > 64) { const expired = peers.values().next().value; expired.close(); peers.delete(expired); }
      port.onmessageerror = () => peers.delete(port);
      port.onmessage = event => {
        const { id, operation, args } = event.data || {};
        if (!Number.isSafeInteger(id) || !args || typeof args !== 'object') return;
        if (operation === 'detach') { peers.delete(port); port.close(); return; }
        let result = null;
        const broadcast = message => { for (const peer of peers) if (peer !== port) peer.postMessage(message); };
        if (operation === 'clear') { connections.clear(); sessions.clear(); latest = undefined; broadcast({ type: 'clear' }); }
        else if (operation === 'session-read' && typeof args.key === 'string') result = sessions.get(args.key) || null;
        else if (operation === 'session-save' && typeof args.key === 'string' && args.key.length < 256
          && Array.isArray(args.messages) && args.messages.length <= 128 && Array.isArray(args.transcript) && args.transcript.length <= 256
          && JSON.stringify(args).length <= 4 * 1024 * 1024) {
          sessions.set(args.key, { messages: args.messages, transcript: args.transcript, scopeKey: typeof args.scopeKey === 'string' ? args.scopeKey.slice(0, 32768) : null });
          broadcast({ type: 'session', key: args.key, state: sessions.get(args.key) });
          while (sessions.size > 8) sessions.delete(sessions.keys().next().value);
        }
        else if (operation === 'read') {
          const record = args.id ? connections.get(args.id) : args.provider
            ? [...connections.values()].reverse().find(value => value.provider === args.provider) : connections.get(latest);
          result = record || null;
        } else if (operation === 'save' && typeof args.id === 'string' && args.id.length <= 8192 && args.settings && typeof args.settings === 'object') {
          const record = {};
          for (const key of ['provider', 'baseURL', 'protocol', 'model', 'apiKey', 'region', 'workspaceId', 'resource', 'accountId', 'route']) {
            const value = args.settings[key];
            if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) record[key] = value;
          }
          connections.set(args.id, record); latest = args.id; broadcast({ type: 'settings', settings: record });
          while (connections.size > 64) connections.delete(connections.keys().next().value);
        }
        port.postMessage({ id, result });
      };
    };
  }
  addEventListener('message', connect);
  parent.postMessage({ type: 'jec-ai-broker-ready', nonce }, hostOrigin);
}
