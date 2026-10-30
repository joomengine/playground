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
  return { attach, call, connect, port, notices, listeners };
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
