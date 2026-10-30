import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runConnectionBroker } from '../src/code/ai-connections.mjs';

function brokerFixture() {
  const listeners = new Set(), notices = [];
  const parent = { postMessage: value => notices.push(value) };
  vm.runInNewContext(`(${runConnectionBroker.toString()})({nonce:'one-use-capability',hostOrigin:'https://playground.test'})`, {
    parent, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn),
  });
  const port = () => ({ replies: [], postMessage(value) { this.replies.push(structuredClone(value)); }, close() { this.closed = true; } });
  const connect = control => { for (const listener of [...listeners]) listener({ source: parent, origin: 'https://playground.test',
    data: { type: 'jec-ai-broker-connect', nonce: 'one-use-capability' }, ports: [control] }); };
  const control = port(); connect(control);
  const attach = () => { const view = port(); control.onmessage({ data: { operation: 'attach' }, ports: [view] }); return view; };
  let sequence = 0;
  const call = (view, operation, args = {}) => { const id = ++sequence; view.onmessage({ data: { id, operation, args } }); return view.replies.find(message => message.id === id)?.result; };
  return { attach, call, connect, port, control, notices, listeners };
}

test('isolated session connection survives view replacement and accepts only one owner channel', () => {
  const { attach, call, connect, port, notices, listeners } = brokerFixture();
  const first = attach();
  call(first, 'save', { id: 'openai', settings: { provider: 'openai', apiKey: 'isolated-session-secret', model: 'available-model' } });
  assert.equal(listeners.size, 0, 'owner handshake must be removed after first use');
  const attacker = port(); connect(attacker);
  assert.equal(attacker.onmessage, undefined, 'replayed nonce cannot attach another owner');
  call(first, 'detach');
  const replacement = attach();
  assert.equal(call(replacement, 'read').apiKey, 'isolated-session-secret');
  assert.equal(JSON.stringify(notices).includes('isolated-session-secret'), false, 'owner notices never contain credentials');
  call(replacement, 'clear');
  assert.equal(call(replacement, 'read'), null);
});

test('isolated views share connection updates and site-scoped conversations through direct ports only', () => {
  const { attach, call, notices } = brokerFixture();
  const embedded = attach(), detached = attach();
  call(embedded, 'save', { id: 'local', settings: { provider: 'other', baseURL: 'http://localhost:1234/v1', apiKey: 'optional-local-key' } });
  assert.equal(detached.replies.find(message => message.type === 'settings').settings.apiKey, 'optional-local-key');
  const state = { key: 'site-a', messages: [{ role: 'user', content: 'review current file' }], transcript: [{ type: 'message', role: 'You', content: 'review current file' }] };
  call(embedded, 'session-save', state);
  assert.deepEqual(call(detached, 'session-read', { key: 'site-a' }).messages, state.messages);
  assert.equal(call(detached, 'session-read', { key: 'site-b' }), null);
  assert.equal(JSON.stringify(notices).includes('review current file'), false);
  call(detached, 'clear');
  assert.ok(embedded.replies.some(message => message.type === 'clear'));
  assert.equal(call(embedded, 'session-read', { key: 'site-a' }), null);
});

test('credentials are loaded only by exact connection identity and changing a key invalidates native conversation replay', () => {
  const { attach, call } = brokerFixture();
  const view = attach();
  const original = call(view, 'save', { id: 'local-openai-A', settings: { provider: 'other', apiKey: 'first-key', model: 'first' } });
  assert.equal(call(view, 'read', { id: 'local-openai-B' }), null);
  assert.equal(call(view, 'read', { id: 'local-anthropic-A' }), null);
  assert.equal(call(view, 'read', { id: 'local-openai-A' }).apiKey, 'first-key');
  const same = call(view, 'save', { id: 'local-openai-A', settings: { provider: 'other', apiKey: 'first-key', model: 'second' } });
  assert.equal(original.revision, same.revision);
  const changed = call(view, 'save', { id: 'local-openai-A', settings: { provider: 'other', apiKey: 'second-key' } });
  assert.notEqual(original.revision, changed.revision);
});

test('AWS discovery secrets remain in direct isolated channels and each credential change rotates revision', () => {
  const { attach, call, notices } = brokerFixture();
  const view = attach();
  const settings = { provider: 'bedrock', apiKey: 'inference-only-key', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'discovery-secret', sessionToken: 'temporary-token' };
  const first = call(view, 'save', { id: 'bedrock-runtime-us', settings });
  assert.equal(call(view, 'read', { id: 'bedrock-runtime-us' }).secretAccessKey, 'discovery-secret');
  let previous = first;
  for (const [key, value] of [['accessKeyId', 'AKIACHANGED'], ['secretAccessKey', 'rotated-secret'], ['sessionToken', 'new-token']]) {
    settings[key] = value;
    const changed = call(view, 'save', { id: 'bedrock-runtime-us', settings });
    assert.notEqual(changed.revision, previous.revision); previous = changed;
  }
  assert.equal(call(view, 'read', { id: 'bedrock-mantle-us' }), null);
  for (const secret of ['discovery-secret', 'temporary-token', 'inference-only-key']) assert.equal(JSON.stringify(notices).includes(secret), false);
  call(view, 'clear'); assert.equal(call(view, 'read', { id: 'bedrock-runtime-us' }), null);
});

test('named custom connection listing excludes secrets and forgetting one preserves other connections', () => {
  const { attach, call, notices } = brokerFixture();
  const view = attach(), peer = attach();
  call(view, 'save', { id: 'local-a', settings: { provider: 'other', connectionName: 'Local workstation', baseURL: 'http://localhost:1234/v1', protocol: 'openai', apiKey: 'private-a' } });
  call(view, 'save', { id: 'private-b', settings: { provider: 'other', connectionName: 'Team API', baseURL: 'https://private.example/v1', protocol: 'responses', apiKey: 'private-b' } });
  call(view, 'save', { id: 'cloud', settings: { provider: 'openai', apiKey: 'cloud-key' } });
  const choices = call(view, 'connections');
  assert.deepEqual(choices, [
    { id: 'local-a', label: 'Local workstation', baseURL: 'http://localhost:1234/v1', protocol: 'openai' },
    { id: 'private-b', label: 'Team API', baseURL: 'https://private.example/v1', protocol: 'responses' },
  ]);
  call(view, 'forget', { id: 'local-a' });
  assert.equal(call(view, 'read', { id: 'local-a' }), null);
  assert.equal(call(view, 'read', { id: 'private-b' }).apiKey, 'private-b');
  assert.equal(call(view, 'read', { id: 'cloud' }).apiKey, 'cloud-key');
  assert.deepEqual(peer.replies.find(message => message.type === 'forgotten'), { type: 'forgotten', id: 'local-a' });
  assert.equal(JSON.stringify(notices).includes('private-a'), false);
  assert.equal(JSON.stringify(notices).includes('Team API'), false);
});

test('catalog cache is scoped to connection and credential revision and forgetting deletes its cached versions', () => {
  const { attach, call } = brokerFixture();
  const view = attach();
  const settings = { provider: 'other', baseURL: 'http://localhost:1234/v1', protocol: 'openai', apiKey: 'first' };
  const first = call(view, 'save', { id: 'connection-a', settings });
  const cacheKey = JSON.stringify(['connection-a', first.revision]);
  const catalog = { models: [{ id: 'local-model', label: 'Local model', tools: true }], selectedModel: 'local-model', source: 'live' };
  call(view, 'catalog-save', { id: cacheKey, connectionId: 'connection-a', catalog });
  assert.deepEqual(call(view, 'catalog-read', { id: cacheKey }), catalog);
  assert.equal(call(view, 'catalog-read', { id: JSON.stringify(['connection-b', first.revision]) }), null);
  const same = call(view, 'save', { id: 'connection-a', settings: { ...settings, model: 'manual-model' } });
  assert.equal(same.revision, first.revision);
  const changed = call(view, 'save', { id: 'connection-a', settings: { ...settings, apiKey: 'rotated' } });
  assert.equal(call(view, 'catalog-read', { id: JSON.stringify(['connection-a', changed.revision]) }), null);
  call(view, 'catalog-save', { id: 'other-cache', connectionId: 'connection-b', catalog });
  call(view, 'forget', { id: 'connection-a' });
  assert.equal(call(view, 'catalog-read', { id: cacheKey }), null);
  assert.deepEqual(call(view, 'catalog-read', { id: 'other-cache' }), catalog);
});

test('drafts, context and request leases stay site-scoped while detached views can cancel their shared request', () => {
  const { attach, call, notices } = brokerFixture();
  const owner = attach(), sibling = attach();
  const context = { mode: 'selected', paths: ['/templates'], excluded: ['/templates/cache'] };
  call(owner, 'session-draft', { key: 'site-a', draft: 'Review this template' });
  call(owner, 'session-context', { key: 'site-a', context });
  const state = call(sibling, 'session-read', { key: 'site-a' });
  assert.equal(state.draft, 'Review this template'); assert.deepEqual(state.context, context);
  assert.equal(call(sibling, 'session-read', { key: 'site-b' }), null);
  assert.equal(call(owner, 'session-lock', { key: 'site-a' }), true);
  assert.equal(call(sibling, 'session-lock', { key: 'site-a' }), false);
  assert.equal(call(sibling, 'session-lock', { key: 'site-b' }), true);
  call(sibling, 'session-release', { key: 'site-a' });
  assert.equal(call(sibling, 'session-read', { key: 'site-a' }).busy, true);
  call(sibling, 'session-cancel', { key: 'site-a' });
  assert.ok(owner.replies.some(message => message.type === 'cancel-request' && message.key === 'site-a'));
  call(owner, 'detach');
  assert.equal(call(sibling, 'session-read', { key: 'site-a' }).busy, false);
  assert.equal(call(sibling, 'session-lock', { key: 'site-a' }), true);
  assert.equal(JSON.stringify(notices).includes('/templates'), false);
  assert.equal(JSON.stringify(notices).includes('Review this template'), false);
});

test('an idle sibling checkpoint cannot replace an active request transcript', () => {
  const { attach, call } = brokerFixture();
  const owner = attach(), sibling = attach();
  call(owner, 'session-lock', { key: 'site-a' });
  const latest = { key: 'site-a', messages: [{ role: 'user', content: 'current request' }], transcript: [{ type: 'message', role: 'Assistant', content: 'Latest streamed text' }] };
  call(owner, 'session-save', latest);
  call(sibling, 'session-save', { key: 'site-a', messages: [], transcript: [] });
  assert.deepEqual(call(sibling, 'session-read', { key: 'site-a' }).transcript, latest.transcript);
  call(owner, 'session-release', { key: 'site-a' });
  call(sibling, 'session-save', { key: 'site-a', messages: [], transcript: [] });
  assert.deepEqual(call(sibling, 'session-read', { key: 'site-a' }).transcript, []);
});

test('owner reset clears only the named site session and global clear releases all request leases', () => {
  const { attach, call, control } = brokerFixture();
  const first = attach(), second = attach();
  call(first, 'session-lock', { key: 'site-a' }); call(second, 'session-lock', { key: 'site-b' });
  call(first, 'session-draft', { key: 'site-a', draft: 'A' }); call(second, 'session-draft', { key: 'site-b', draft: 'B' });
  control.onmessage({ data: { operation: 'clear-session', key: 'site-a' } });
  assert.equal(call(second, 'session-read', { key: 'site-a' }), null);
  assert.equal(call(second, 'session-read', { key: 'site-b' }).draft, 'B');
  assert.ok(first.replies.some(message => message.type === 'cancel-request' && message.key === 'site-a'));
  call(first, 'clear');
  assert.equal(call(first, 'session-read', { key: 'site-b' }), null);
  assert.ok(second.replies.some(message => message.type === 'cancel-request' && message.key === 'site-b'));
  assert.equal(call(first, 'session-lock', { key: 'site-b' }), true);
});

test('evicting an old isolated view releases its request lease', () => {
  const { attach, call } = brokerFixture();
  const old = attach(); call(old, 'session-lock', { key: 'site-a' });
  let replacement;
  for (let index = 0; index < 64; index++) replacement = attach();
  assert.equal(old.closed, true);
  assert.equal(call(replacement, 'session-lock', { key: 'site-a' }), true);
});

test('pending settings restore across views without changing exact saved connections and clear with their owner', () => {
  const { attach, call, notices } = brokerFixture();
  const first = attach();
  const saved = call(first, 'save', { id: 'custom-a', settings: { provider: 'other', baseURL: 'http://localhost:1234/v1', protocol: 'openai', apiKey: 'committed-key', connectionName: 'Saved server' } });
  const draft = { ...saved, baseURL: 'http://localhost:4321/v1', apiKey: 'pending-isolated-key', connectionName: 'Editing server', revision: '' };
  call(first, 'settings-draft', { id: 'custom-draft', settings: { ...draft, arbitrary: 'must-not-survive' } });
  assert.deepEqual(call(first, 'read'), draft);
  assert.equal(call(first, 'read', { id: 'custom-a' }).apiKey, 'committed-key');
  assert.equal(call(first, 'read', { provider: 'other' }).connectionName, 'Saved server');
  assert.equal(call(first, 'read', { id: 'custom-draft' }), null, 'editing does not commit a new connection');
  assert.equal(call(first, 'connections').length, 1);
  call(first, 'detach');
  const replacement = attach();
  assert.deepEqual(call(replacement, 'read'), draft);
  call(replacement, 'forget', { id: 'unrelated-connection' });
  assert.deepEqual(call(replacement, 'read'), draft);
  call(replacement, 'forget', { id: 'custom-draft' });
  assert.deepEqual(call(replacement, 'read'), saved, 'forgetting the pending identity clears its draft, leaving committed connection intact');
  call(replacement, 'settings-draft', { id: 'custom-draft', settings: draft });
  call(replacement, 'clear');
  assert.equal(call(replacement, 'read'), null);
  assert.equal(call(replacement, 'read', { id: 'custom-a' }), null);
  for (const secret of ['committed-key', 'pending-isolated-key', 'Editing server']) assert.equal(JSON.stringify(notices).includes(secret), false);
});
