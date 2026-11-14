import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeViewHost, attachRuntimeView, runtimeViewURL, readRuntimeViewURL, readActiveRuntimeView } from '../src/runtime-views.mjs';

function channelFactory() {
  const channels = new Map();
  return name => {
    const bucket = channels.get(name) || new Set(); channels.set(name, bucket);
    const channel = {
      onmessage: null,
      postMessage(value) {
        const cloned = structuredClone(value);
        for (const other of bucket) if (other !== channel) queueMicrotask(() => {
          if (bucket.has(other)) other.onmessage?.({ data: structuredClone(cloned) });
        });
      },
      close() { bucket.delete(channel); },
    };
    bucket.add(channel);
    return channel;
  };
}
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function runtime(id = 'live') {
  const workspaceListeners = new Set(), debugListeners = new Set(), files = new Map([['/index.php', 'original']]);
  let queue = Promise.resolve(), count = 0;
  const serialized = callback => { const next = queue.then(callback); queue = next.catch(() => {}); return next; };
  async function request(operation, args = {}) {
    if (operation === 'read') return { contents: files.get(args.path) };
    if (operation === 'write') { count++; files.set(args.path, args.contents); for (const listener of workspaceListeners) listener({ type: 'changes', changes: [{ type: 'changed', path: args.path }] }); return { ok: true }; }
    if (operation === 'fail') throw Object.assign(new Error('Disk full'), { name: 'QuotaExceededError', code: 'QUOTA' });
    return args;
  }
  const site = {
    url: `https://example.test/__site/owner/${id}/administrator/`, baseUrl: `https://example.test/__site/owner/${id}/`,
    isolation: { ownerId: 'owner', policy: 'credentialless' }, documentRoot: '/persist/www',
    configuration: { storageKey: id, persistence: true, phpVersion: '8.4', admin: { password: 'private' } },
    installation: { resumed: true }, runtimeInfo: { phpVersion: '8.4' }, recovery: null,
    healthy: true, closed: false, idle: true, changing: false, lastSavedAt: '2026-11-14T12:00:00Z', savedCurrentState: true,
    workspace: { id, storageId: id, root: '/',
      request: (operation, args) => serialized(() => request(operation, args)),
      withBatch: callback => serialized(() => callback({ request })),
      subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
    },
    debugger: { state: 'idle', capabilities: {}, subscribe(listener) { debugListeners.add(listener); return () => debugListeners.delete(listener); },
      evaluate: async expression => ({ expression }),
    },
    openDatabase: async () => ({ url: `https://example.test/__site/owner/${id}/__adminer/` }),
    clearJoomlaCache: async () => true,
    async exportSite(options) { options.onProgress?.({ message: 'Exporting' }); return { filename: 'site.zip', bytes: new Uint8Array([1, 2, 3]) }; },
    async request() { return new Response('Joomla', { headers: { 'x-test': 'yes' } }); },
    flush: async () => {},
    get writes() { return count; },
  };
  return site;
}
const base = 'https://example.test/playground/';
const token = 'runtime_view_token_12345678';

function setup(t, options = {}) {
  const createChannel = channelFactory(), local = storage();
  let current = runtime();
  const actions = [];
  const host = createRuntimeViewHost({ getRuntime: () => current, token, baseURL: base, createChannel, storage: local,
    onAction: async action => { actions.push(action); if (action === 'stop') current = null; if (action === 'start') current = runtime('resumed'); },
    ...options });
  t.after(() => host.dispose());
  return { host, local, actions, runtime: () => current,
    attach: async extra => {
      const view = await attachRuntimeView({ token, baseURL: base, createChannel, ...extra });
      t.after(() => view.dispose()); return view;
    },
  };
}

test('companion URLs identify one owner and a relative view without including configuration', () => {
  const url = runtimeViewURL({ token, baseURL: base, path: '/administrator/index.php?option=com_componentbuilder' });
  assert.deepEqual(readRuntimeViewURL(url), { token, path: '/administrator/index.php?option=com_componentbuilder' });
  assert.equal(readRuntimeViewURL(base), null);
  assert.throws(() => runtimeViewURL({ token, path: '//outside.test/' }), /Invalid site view/);
  assert.throws(() => runtimeViewURL({ token: 'bad', path: '/' }), /Invalid runtime/);
});

test('two companion tools share authoritative files and SQL view without starting another runtime', async t => {
  const state = setup(t), first = await state.attach(), second = await state.attach();
  assert.equal(first.isRemoteView, true);
  assert.equal(first.baseUrl, state.runtime().baseUrl);
  assert.equal(first.workspace.id, second.workspace.id);
  const events = [];
  second.workspace.subscribe(event => events.push(event));
  await first.workspace.request('write', { path: '/index.php', contents: 'changed' });
  assert.deepEqual(await second.workspace.request('read', { path: '/index.php' }), { contents: 'changed' });
  assert.equal(state.runtime().writes, 1);
  assert.equal(events[0].changes[0].path, '/index.php');
  assert.deepEqual(await second.openDatabase(), await state.runtime().openDatabase());
  const response = await first.request('/');
  assert.equal(await response.text(), 'Joomla');
  assert.equal(response.headers.get('x-test'), 'yes');
  assert.equal(state.host.clients, 2);
});

test('editor batch owns one runtime queue reservation and does not replay successful writes', async t => {
  const state = setup(t), first = await state.attach(), second = await state.attach();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const batch = first.workspace.withBatch(async workspace => {
    await workspace.request('write', { path: '/index.php', contents: 'first' });
    entered(); await gate;
    await workspace.request('write', { path: '/index.php', contents: 'second' });
    return 'finished';
  });
  await started;
  let observed = false;
  const other = second.workspace.request('read', { path: '/index.php' }).then(value => { observed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(observed, false);
  release();
  assert.equal(await batch, 'finished');
  assert.deepEqual(await other, { contents: 'second' });
  assert.equal(state.runtime().writes, 2);
});

test('a failed batch releases its reservation and preserves native error identity', async t => {
  const state = setup(t), first = await state.attach();
  await assert.rejects(first.workspace.withBatch(workspace => workspace.request('fail')), { name: 'QuotaExceededError', code: 'QUOTA', message: 'Disk full' });
  assert.deepEqual(await first.workspace.request('read', { path: '/index.php' }), { contents: 'original' });
});

test('closing a companion detaches its tools without stopping the owner', async t => {
  const state = setup(t), first = await state.attach();
  first.dispose();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(state.runtime().healthy, true);
  assert.deepEqual(state.actions, []);
  assert.equal(state.host.clients, 0);
  const other = await state.attach();
  assert.equal(other.healthy, true);
});

test('owner Stop and Start update companion identity without launching independent copies', async t => {
  const state = setup(t), first = await state.attach();
  await first.action('stop');
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(first.closed, true);
  assert.equal(first.configuration.storageKey, 'live');
  await first.action('start');
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(first.healthy, true);
  assert.equal(first.workspace.id, 'resumed');
  assert.match(first.baseUrl, /resumed/);
  assert.deepEqual(state.actions, ['stop', 'start']);
});

test('owner loss disables companions, clears discovery, and does not create a fallback runtime', async t => {
  const state = setup(t); let lost = false;
  const first = await state.attach({ onUnavailable() { lost = true; } });
  const events = [];
  first.workspace.subscribe(event => events.push(event));
  assert.equal(readActiveRuntimeView({ storage: state.local, baseURL: base }).token, token);
  assert.equal([...state.local.values.values()].join('').includes('private'), false);
  state.host.dispose();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(lost, true);
  assert.equal(first.healthy, false);
  assert.deepEqual(events, [{ type: 'workspace-unavailable', ownerUnavailable: true }], 'Unexpected loss must not dispose editor buffers through workspace-closed.');
  assert.equal(readActiveRuntimeView({ storage: state.local, baseURL: base }), null);
  await assert.rejects(first.workspace.request('write', { path: '/index.php', contents: 'lost' }), /no longer available/);
  assert.equal(state.runtime().writes, 0);
});

test('an owner which disappears without pagehide becomes unavailable without starting another runtime', async t => {
  const state = setup(t), timers = [];
  const first = await state.attach({
    setTimer(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer() {}, ownerTimeoutMs: 90_000,
  });
  assert.equal(first.healthy, true);
  timers.findLast(timer => timer.delay === 90_000).callback();
  assert.equal(first.healthy, false);
  await assert.rejects(first.action('start'), /no longer available/);
  assert.deepEqual(state.actions, []);
  assert.equal(state.runtime().healthy, true, 'A connection timeout must never close or replace the authoritative runtime.');
});

test('persistence progress and failures remain visible in companion save status', async t => {
  const state = setup(t), first = await state.attach();
  state.runtime().persistencePending = true;
  state.runtime().persistenceState = 'saving';
  state.host.update();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(first.persistencePending, true);
  assert.equal(first.persistenceState, 'saving');
  state.runtime().persistenceError = Object.assign(new Error('Storage full'), { name: 'QuotaExceededError' });
  state.host.update();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(first.persistenceError.name, 'QuotaExceededError');
});

test('portable exports report progress and preserve archive bytes over the tool channel', async t => {
  const state = setup(t), first = await state.attach(), progress = [];
  const result = await first.exportSite({ format: 'bundle', onProgress: event => progress.push(event.message) });
  assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3]));
  assert.deepEqual(progress, ['Exporting']);
});

test('missing owner produces a bounded connection failure', async () => {
  await assert.rejects(attachRuntimeView({ token, baseURL: base, createChannel: channelFactory(), connectTimeoutMs: 5 }), /running site could not be reached/);
});

test('owner transition waits for companion draft checks and honors cancellation', async t => {
  const state = setup(t), actions = [];
  let approved = false;
  await state.attach({ beforeTransition: async action => { actions.push(action); return approved; } });
  assert.equal(await state.host.prepareTransition('stop'), false);
  approved = true;
  assert.equal(await state.host.prepareTransition('restore'), true);
  assert.deepEqual(actions, ['stop', 'restore']);
  assert.equal(state.runtime().healthy, true);
});

test('unresponsive companion cannot approve destructive transitions by timing out', async t => {
  const state = setup(t);
  await state.attach({ beforeTransition: () => new Promise(() => {}) });
  assert.equal(await state.host.prepareTransition('reset', { timeoutMs: 5 }), false);
  assert.equal(state.runtime().healthy, true);
});
