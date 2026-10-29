import test from 'node:test';
import assert from 'node:assert/strict';
import { InlineDebugAdapter, createDebugSourceMapper } from '../src/code/debug-adapter.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function setup(overrides = {}, options = {}) {
  const calls = [];
  let notify = () => {};
  const backend = {
    subscribe(listener) { notify = listener; return { dispose() { calls.push(['unsubscribe']); } }; },
    async start(config) { calls.push(['start', config]); },
    async stop() { calls.push(['stop']); },
    async setBreakpoints(path, breakpoints) { calls.push(['breakpoints', path, breakpoints]); return breakpoints.map((value, i) => ({ id: i + 1, verified: true, line: value.line })); },
    async continue() { calls.push(['continue']); },
    async next() { calls.push(['next']); },
    async stepIn() { calls.push(['stepIn']); },
    async stepOut() { calls.push(['stepOut']); },
    async pause() { calls.push(['pause']); },
    async stackTrace() { return [
      { id: 0, name: 'save', source: { path: '/persist/www/components/com_example/model.php' }, line: 12, column: 1 },
      { id: 1, name: 'execute', source: { path: '/persist/www/index.php' }, line: 30, column: 1 },
      { id: 2, name: 'internal', source: { path: '/internal/bootstrap.php' }, line: 4, column: 1 },
    ]; },
    async scopes(frameId) { calls.push(['scopes', frameId]); return [{ name: 'Locals', variablesReference: 9, expensive: false }]; },
    async variables(reference, options) { calls.push(['variables', reference, options]); return [{ name: 'value', value: '42', type: 'int', variablesReference: 0 }]; },
    async evaluate(expression, frameId) { calls.push(['evaluate', expression, frameId]); return { result: '42', type: 'int', variablesReference: 0 }; },
    ...overrides,
  };
  const adapter = new InlineDebugAdapter(backend, { siteId: 'site-a', ...options });
  const messages = [];
  adapter.onDidSendMessage(message => messages.push(message));
  let sequence = 0;
  const send = async (command, args) => {
    const seq = ++sequence;
    await adapter.handleMessage({ type: 'request', seq, command, arguments: args });
    return messages.find(message => message.type === 'response' && message.request_seq === seq);
  };
  const initialize = args => send('initialize', { adapterID: 'joomengine-code', ...args });
  return { adapter, backend, calls, messages, send, initialize, emit: value => notify(value) };
}

test('source mapping retains workspace identity and rejects traversal, foreign sites and external runtime paths', () => {
  const mapper = createDebugSourceMapper({ siteId: 'site-a' });
  assert.equal(mapper.toEditor('/persist/www/templates/a file.php'), 'jec://site-a/templates/a%20file.php');
  assert.equal(mapper.toRuntime('jec://site-a/templates/a%20file.php'), '/persist/www/templates/a file.php');
  assert.equal(mapper.toEditor('/persist/www/a#b.php'), 'jec://site-a/a%23b.php');
  assert.equal(mapper.toRuntime('/persist/www/index.php'), '/persist/www/index.php');
  for (const value of ['jec://site-b/index.php', 'jec://site-a/../config.php', 'jec://site-a/%2e%2e/config.php',
    'jec://site-a/foo%2fbar.php', 'jec://site-a/foo.php?x=y', '/persist/www-other/index.php', '/config/secret.php']) {
    assert.throws(() => mapper.toRuntime(value));
  }
  assert.throws(() => mapper.toEditor('/persist/www/../secrets.php'));
  const custom = createDebugSourceMapper({ siteId: 'site-a', toRuntimePath: () => '/persist/www/index.php', toEditorPath: () => 'jec://site-b/index.php' });
  assert.throws(() => custom.toRuntime('jec://site-b/secret.php'));
  assert.throws(() => custom.toEditor('/persist/www/index.php'));
});

test('initialization reports supported capabilities and preserves DAP response/event ordering', async () => {
  const { initialize, messages, calls } = setup();
  const response = await initialize();
  assert.equal(response.success, true);
  assert.equal(response.body.supportsConfigurationDoneRequest, true);
  assert.equal(response.body.supportsConditionalBreakpoints, false);
  assert.equal(response.body.supportsEvaluateForHovers, false);
  assert.deepEqual(messages.map(value => value.type === 'response' ? value.command : value.event), ['initialize', 'initialized']);
  assert.deepEqual(messages.map(value => value.seq), [1, 2]);
  assert.deepEqual(calls, []);
});

test('configuration completes after breakpoint setup and arms the real backend only once', async () => {
  const held = deferred();
  const events = [];
  const { initialize, send, calls } = setup({ setBreakpoints: async (path, breakpoints) => {
    await held.promise; events.push('breakpoints'); return breakpoints.map(value => ({ ...value, verified: true }));
  }, start: async config => { events.push('start'); calls.push(['start', config]); } });
  await initialize();
  await send('launch', { method: 'POST', url: '/administrator/index.php' });
  const breakpoints = send('setBreakpoints', { source: { path: 'jec://site-a/index.php' }, breakpoints: [{ line: 8 }] });
  const configured = send('configurationDone');
  await Promise.resolve();
  assert.deepEqual(events, []);
  held.resolve();
  assert.equal((await breakpoints).success, true);
  assert.equal((await configured).success, true);
  assert.deepEqual(events, ['breakpoints', 'start']);
  assert.equal((await send('configurationDone')).success, false);
  assert.equal(calls.filter(([name]) => name === 'start').length, 1);
  assert.deepEqual((await send('threads')).body.threads, [{ id: 1, name: 'Joomla PHP request' }]);
});

test('conditional support is explicit; unsupported breakpoint kinds are unverified rather than silently applied', async () => {
  const { initialize, send, calls } = setup();
  await initialize({ linesStartAt1: false, columnsStartAt1: false });
  const result = await send('setBreakpoints', { source: { path: 'jec://site-a/index.php' }, breakpoints: [
    { line: 0 }, { line: 2, condition: '$x > 1' }, { line: 4, hitCondition: '3' }, { line: 6, logMessage: 'hello' },
  ] });
  assert.equal(result.success, true);
  assert.deepEqual(calls.find(([name]) => name === 'breakpoints'), ['breakpoints', '/persist/www/index.php', [{ line: 1 }]]);
  assert.deepEqual(result.body.breakpoints.map(value => value.verified), [true, false, false, false]);
  assert.equal(result.body.breakpoints[0].line, 0);
  assert.equal(result.body.breakpoints[0].source.path, 'jec://site-a/index.php');
  const supported = setup({ capabilities: { conditionalBreakpoints: true } });
  assert.equal((await supported.initialize()).body.supportsConditionalBreakpoints, true);
  await supported.send('setBreakpoints', { source: { path: 'jec://site-a/index.php' }, breakpoints: [{ line: 4, condition: '$x === 4' }] });
  assert.equal(supported.calls[0][2][0].condition, '$x === 4');
});

test('stack frames, scope selection, progressive variables and evaluation map actual backend data', async () => {
  const { initialize, send, emit, calls } = setup();
  await initialize({ linesStartAt1: false, columnsStartAt1: false });
  assert.equal((await send('stackTrace', { threadId: 1 })).success, false);
  emit({ event: 'stopped', body: { reason: 'breakpoint' } });
  const frames = await send('stackTrace', { threadId: 1, startFrame: 1, levels: 2 });
  assert.equal(frames.body.totalFrames, 3);
  assert.equal(frames.body.stackFrames[0].source.path, 'jec://site-a/index.php');
  assert.equal(frames.body.stackFrames[0].line, 29);
  assert.equal(frames.body.stackFrames[0].column, 0);
  assert.equal(frames.body.stackFrames[1].source.path, undefined);
  assert.equal((await send('scopes', { frameId: 1 })).body.scopes[0].variablesReference, 9);
  assert.equal((await send('variables', { variablesReference: 9, start: 10, count: 5, filter: 'named' })).body.variables[0].value, '42');
  assert.deepEqual(calls.find(([name]) => name === 'variables'), ['variables', 9, { start: 10, count: 5, filter: 'named' }]);
  assert.equal((await send('evaluate', { expression: '$x', frameId: 1, context: 'watch' })).body.result, '42');
  assert.deepEqual(calls.find(([name]) => name === 'evaluate'), ['evaluate', '$x', 1]);
  assert.equal((await send('evaluate', { expression: 'dangerous()', context: 'hover' })).success, false);
  assert.equal(calls.filter(([name]) => name === 'evaluate').length, 1);
  emit({ event: 'continued', body: {} });
  assert.equal((await send('variables', { variablesReference: 9 })).success, false);
});

test('execution controls route directly and runtime errors become failed responses', async () => {
  const { initialize, send, calls, messages } = setup({ next: async () => { throw new Error('No paused request'); } });
  await initialize();
  assert.equal((await send('continue', { threadId: 1 })).success, false);
  await send('launch', {});
  await send('configurationDone');
  assert.equal((await send('continue', { threadId: 1 })).body.allThreadsContinued, true);
  assert.equal((await send('next', { threadId: 1 })).success, false);
  assert.equal((await send('stepIn', { threadId: 1 })).success, true);
  assert.equal((await send('stepOut', { threadId: 1 })).success, true);
  assert.equal((await send('pause', { threadId: 1 })).success, true);
  assert.equal((await send('pause', { threadId: 2 })).success, false);
  assert.equal((await send('reverseContinue')).success, false);
  assert.deepEqual(calls.filter(([name]) => ['continue', 'stepIn', 'stepOut', 'pause'].includes(name)).map(([name]) => name), ['continue', 'stepIn', 'stepOut', 'pause']);
  assert.equal(messages.filter(value => value.event === 'stopped' || value.event === 'continued').length, 0);
});

test('duplicate/out-of-order requests do not invoke backend mutations a second time', async () => {
  const { adapter, initialize, calls, messages } = setup();
  await initialize();
  const message = { type: 'request', seq: 10, command: 'setBreakpoints', arguments: { source: { path: 'jec://site-a/index.php' }, breakpoints: [] } };
  await adapter.handleMessage(message);
  await adapter.handleMessage(message);
  await adapter.handleMessage({ ...message, seq: 9 });
  assert.equal(calls.filter(([name]) => name === 'breakpoints').length, 1);
  assert.equal(messages.at(-1).success, false);
  assert.ok(messages.every((value, index) => value.seq === index + 1));
});

test('terminate and disconnect wait for stop, emit termination once, and disposal suppresses stale replies/events', async () => {
  const held = deferred();
  let stopped = 0;
  const { initialize, send, emit, messages, adapter } = setup({ stop: async () => { await held.promise; stopped++; } });
  await initialize();
  const terminate = send('terminate');
  await Promise.resolve();
  assert.equal(messages.some(value => value.event === 'terminated'), false);
  held.resolve();
  assert.equal((await terminate).success, true);
  assert.equal(messages.filter(value => value.event === 'terminated').length, 1);
  await send('disconnect');
  assert.equal(stopped, 1);
  assert.equal(messages.filter(value => value.event === 'terminated').length, 1);
  const before = messages.length;
  await adapter.dispose();
  emit({ event: 'stopped', body: { reason: 'breakpoint' } });
  await adapter.handleMessage({ type: 'request', seq: 99, command: 'threads' });
  assert.equal(messages.length, before);
});

test('disposing while configuration waits does not launch PHP later', async () => {
  const held = deferred();
  let launches = 0;
  const { initialize, send, adapter, messages } = setup({ setBreakpoints: async () => { await held.promise; return []; },
    start: async () => { launches++; } });
  await initialize();
  await send('launch', {});
  const setting = send('setBreakpoints', { source: { path: 'jec://site-a/index.php' }, breakpoints: [] });
  const configuring = send('configurationDone');
  await Promise.resolve();
  await adapter.dispose();
  const before = messages.length;
  held.resolve();
  await Promise.all([setting, configuring]);
  assert.equal(launches, 0);
  assert.equal(messages.length, before);
});

test('backend events use mapped source locations and listener failures do not interrupt delivery', async () => {
  const { initialize, adapter, emit, messages } = setup();
  adapter.onDidSendMessage(() => { throw new Error('listener failed'); });
  const disposables = [];
  const receiver = { count: 0 };
  adapter.onDidSendMessage(function() { this.count++; }, receiver, disposables);
  await initialize();
  emit({ event: 'output', body: { output: 'PHP error', source: { path: '/persist/www/index.php' }, line: 10 } });
  assert.equal(messages.at(-1).body.source.path, 'jec://site-a/index.php');
  assert.equal(receiver.count, 3);
  disposables[0].dispose();
  emit({ event: 'output', body: { output: 'later' } });
  assert.equal(receiver.count, 3);
});
