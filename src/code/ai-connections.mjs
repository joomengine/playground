/** Isolated session vault. This function is serialized into an opaque sandbox. */
export function runConnectionBroker({ nonce, hostOrigin }) {
  const connections = new Map(), sessions = new Map(), catalogs = new Map(), drafts = new Map(), contexts = new Map();
  const peers = new Set(), owners = new Map();
  let latest, editing, credentialGeneration = 0;
  const cleanSettings = settings => Object.fromEntries(['provider', 'baseURL', 'protocol', 'model', 'apiKey', 'region', 'workspaceId', 'resource', 'accountId', 'route', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'connectionName', 'revision']
    .filter(key => typeof settings[key] === 'string' && settings[key].length <= 4096 && !/[\r\n]/.test(settings[key])).map(key => [key, settings[key]]));
  const broadcast = (message, sender) => { for (const peer of peers) if (peer !== sender) peer.postMessage(message); };
  const session = key => {
    const saved = sessions.get(key);
    return saved || drafts.has(key) || contexts.has(key) || owners.has(key)
      ? { messages: [], transcript: [], ...saved, draft: drafts.get(key) || '', context: contexts.get(key), busy: owners.has(key) } : null;
  };
  const clearSession = key => {
    owners.get(key)?.postMessage({ type: 'cancel-request', key }); owners.delete(key);
    sessions.delete(key); drafts.delete(key); contexts.delete(key);
    broadcast({ type: 'session-cleared', key }); broadcast({ type: 'busy', key, busy: false });
  };
  function connect(event) {
    if (event.source !== parent || event.origin !== hostOrigin || event.data?.type !== 'jec-ai-broker-connect' || event.data.nonce !== nonce || event.ports.length !== 1) return;
    removeEventListener('message', connect);
    const control = event.ports[0];
    control.onmessage = event => {
      if (event.data?.operation === 'clear-session' && typeof event.data.key === 'string') { clearSession(event.data.key); return; }
      if (event.data?.operation !== 'attach' || event.ports.length !== 1) return;
      const port = event.ports[0]; peers.add(port);
      const release = target => {
        for (const [key, owner] of owners) if (owner === target) { owners.delete(key); broadcast({ type: 'busy', key, busy: false }, target); }
        peers.delete(target); target.close();
      };
      const detach = () => release(port);
      while (peers.size > 64) release(peers.values().next().value);
      port.onmessageerror = detach;
      port.onmessage = event => {
        const { id, operation, args } = event.data || {};
        if (!Number.isSafeInteger(id) || !args || typeof args !== 'object') return;
        if (operation === 'detach') { detach(); return; }
        let result = null;
        const key = typeof args.key === 'string' && args.key.length < 256 ? args.key : null;
        if (operation === 'clear') {
          for (const [key, owner] of owners) owner.postMessage({ type: 'cancel-request', key });
          connections.clear(); catalogs.clear(); sessions.clear(); drafts.clear(); contexts.clear(); owners.clear(); latest = editing = undefined;
          broadcast({ type: 'clear' }, port);
        } else if (operation === 'forget' && typeof args.id === 'string') {
          connections.delete(args.id);
          if (editing?.id === args.id) editing = undefined;
          for (const [key, value] of catalogs) if (value.connectionId === args.id) catalogs.delete(key);
          if (latest === args.id) latest = [...connections.keys()].at(-1);
          broadcast({ type: 'forgotten', id: args.id }, port);
        } else if (operation === 'connections') {
          result = [...connections.entries()].filter(([, value]) => value.provider === 'other').map(([id, value]) => ({
            id, label: value.connectionName || value.baseURL, baseURL: value.baseURL, protocol: value.protocol,
          }));
        } else if (operation === 'session-clear' && key) clearSession(key);
        else if (operation === 'session-read' && key) result = session(key);
        else if (operation === 'session-lock' && key) {
          result = !owners.has(key) || owners.get(key) === port;
          if (result) { owners.set(key, port); broadcast({ type: 'busy', key, busy: true }, port); }
        } else if (operation === 'session-release' && key && owners.get(key) === port) {
          owners.delete(key); broadcast({ type: 'busy', key, busy: false }, port);
        } else if (operation === 'session-cancel' && key) owners.get(key)?.postMessage({ type: 'cancel-request', key });
        else if (operation === 'session-draft' && key && typeof args.draft === 'string' && args.draft.length <= 16000) {
          drafts.set(key, args.draft); broadcast({ type: 'draft', key, draft: args.draft }, port);
        } else if (operation === 'session-context' && key && args.context && ['current', 'selected', 'project'].includes(args.context.mode)
          && Array.isArray(args.context.paths) && args.context.paths.length <= 64 && Array.isArray(args.context.excluded) && args.context.excluded.length <= 64
          && JSON.stringify(args.context).length <= 32768) {
          contexts.set(key, args.context); broadcast({ type: 'context', key, context: args.context }, port);
        } else if (operation === 'session-save' && key && (!owners.has(key) || owners.get(key) === port)
          && Array.isArray(args.messages) && args.messages.length <= 128 && Array.isArray(args.transcript) && args.transcript.length <= 256
          && JSON.stringify(args).length <= 4 * 1024 * 1024) {
          sessions.set(key, { messages: args.messages, transcript: args.transcript,
            scopeKey: typeof args.scopeKey === 'string' ? args.scopeKey.slice(0, 32768) : null,
            connectionKey: typeof args.connectionKey === 'string' ? args.connectionKey.slice(0, 32768) : null });
          broadcast({ type: 'session', key, state: session(key) }, port);
          while (sessions.size > 8) { const oldest = sessions.keys().next().value; sessions.delete(oldest); drafts.delete(oldest); contexts.delete(oldest); }
        } else if (operation === 'catalog-read' && typeof args.id === 'string') {
          const cached = catalogs.get(args.id); result = cached?.catalog || null;
        } else if (operation === 'catalog-save' && typeof args.id === 'string' && args.id.length <= 16384
          && typeof args.connectionId === 'string' && Array.isArray(args.catalog?.models) && args.catalog.models.length <= 10000
          && JSON.stringify(args.catalog).length <= 2 * 1024 * 1024) {
          catalogs.set(args.id, { connectionId: args.connectionId, catalog: args.catalog });
          while (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value);
        } else if (operation === 'settings-draft' && typeof args.id === 'string' && args.id.length <= 8192 && args.settings && typeof args.settings === 'object') {
          editing = { id: args.id, settings: cleanSettings(args.settings) };
        } else if (operation === 'read') {
          const record = args.id ? connections.get(args.id) : args.provider
            ? [...connections.values()].reverse().find(value => value.provider === args.provider) : editing?.settings || connections.get(latest);
          result = record || null;
        } else if (operation === 'save' && typeof args.id === 'string' && args.id.length <= 8192 && args.settings && typeof args.settings === 'object') {
          const record = {};
          for (const key of ['provider', 'baseURL', 'protocol', 'model', 'apiKey', 'region', 'workspaceId', 'resource', 'accountId', 'route', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'connectionName']) {
            const value = args.settings[key];
            if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) record[key] = value;
          }
          const previous = connections.get(args.id);
          record.revision = previous && ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken'].every(key => previous[key] === record[key]) ? previous.revision : String(++credentialGeneration);
          connections.set(args.id, record); latest = args.id; result = record; broadcast({ type: 'settings', settings: record }, port);
          while (connections.size > 64) connections.delete(connections.keys().next().value);
        }
        port.postMessage({ id, result });
      };
    };
  }
  addEventListener('message', connect);
  parent.postMessage({ type: 'jec-ai-broker-ready', nonce }, hostOrigin);
}
