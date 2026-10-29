import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugRequestMatcher, DebugRequestCoordinator } from '../src/code/debug-request.mjs';

const siteURL = 'https://playground.example/__site/owner/instance/';
const request = (method = 'POST', path = 'administrator/index.php?option=com_content') => ({
  url: new URL(path, siteURL).href, method, headers: [['content-type', 'application/x-www-form-urlencoded']],
  body: method === 'POST' ? new TextEncoder().encode('task=save&title=Edited') : null,
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  const events = [];
  const coordinator = new DebugRequestCoordinator({ siteURL,
    normalRequest: async value => { events.push(['normal', value]); return { status: 200 }; },
    debugRequest: async () => { throw new Error('Missing debug test execution'); },
    debugControl: async (command, args) => { events.push(['control', command, args]); },
    terminateDebug: async () => { events.push(['terminated']); },
    onState: value => { events.push(['state', value.state]); },
    startupTimeoutMs: 100, stopTimeoutMs: 20, requestTimeoutMs: 100,
    ...options,
  });
  return { coordinator, events };
}
function arm(coordinator, value = request(), extra = {}) {
  coordinator.arm({ method: value.method, url: value.url, ...extra });
}

test('request selection is exact, site-confined and fails closed for missing metadata', () => {
  const match = createDebugRequestMatcher({ siteURL, method: 'POST', url: request().url,
    headers: [['content-type', 'application/x-www-form-urlencoded']], destination: 'iframe' });
  assert.equal(match({ ...request(), destination: 'iframe' }), true);
  assert.equal(match({ ...request(), headers: [...request().headers, ['Sec-Fetch-Dest', 'iframe']] }), true);
  assert.equal(match(request()), false);
  assert.equal(match({ ...request(), destination: 'document' }), false);
  assert.equal(match({ ...request('GET'), destination: 'iframe' }), false);
  assert.equal(match({ ...request('POST', 'administrator/index.php?option=com_users'), destination: 'iframe' }), false);
  assert.equal(match({ ...request(), url: 'https://playground.example/__site/owner/other/index.php', destination: 'iframe' }), false);
  assert.equal(match({ ...request(), headers: [], destination: 'iframe' }), false);
  assert.equal(match({ ...request(), headers: [['bad\nheader', 'x']], destination: 'iframe' }), false);
  assert.throws(() => createDebugRequestMatcher({ siteURL, method: 'POST', url: '../outside.php' }), /active site/);
  assert.throws(() => createDebugRequestMatcher({ siteURL, method: 'POST', url: 'https://elsewhere.example/' }), /active site/);
  assert.throws(() => createDebugRequestMatcher({ siteURL, method: 'POST', url: 'index.php#fragment' }), /fragment/);
  assert.throws(() => createDebugRequestMatcher({ siteURL, url: 'index.php' }), /explicit HTTP method/);
});

test('only the chosen request uses debug execution, with original POST bytes and response', async () => {
  const selected = request();
  const response = { status: 303, headers: [['location', '/saved']], body: new Uint8Array(0) };
  const calls = [];
  const { coordinator, events } = setup({ debugRequest: async (value, hooks) => {
    calls.push(value); hooks.started(); return response;
  } });
  arm(coordinator);
  await coordinator.request(request('GET', 'api/index.php?heartbeat=1'));
  const result = await coordinator.request(selected);
  await coordinator.request(selected);
  assert.equal(result, response);
  assert.deepEqual(calls, [selected]);
  assert.equal(calls[0].body, selected.body);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 2);
  assert.equal(coordinator.state, 'idle');
});

test('paused execution holds writes and other requests while control bypasses the queue', async () => {
  const finished = deferred();
  const entered = deferred();
  let hooks;
  const writes = [];
  const { coordinator, events } = setup({ requestTimeoutMs: 20, debugRequest: async (value, callbacks) => {
    hooks = callbacks; hooks.started(); hooks.paused(); entered.resolve(); return finished.promise;
  } });
  arm(coordinator);
  const debug = coordinator.request(request());
  await entered.promise;
  const save = coordinator.mutate(async () => { writes.push('saved'); return 1; });
  const later = coordinator.request(request('GET', 'index.php'));
  await coordinator.control('variables', { variablesReference: 7 });
  await pause(50);
  assert.equal(coordinator.paused, true);
  assert.deepEqual(writes, []);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 0);
  assert.deepEqual(events.find(([kind]) => kind === 'control'), ['control', 'variables', { variablesReference: 7 }]);
  hooks.resumed(); finished.resolve({ status: 200 });
  await debug; assert.equal(await save, 1); await later;
  assert.deepEqual(writes, ['saved']);
});

test('stop waits for the active runtime to terminate and never replays the POST', async () => {
  const finished = deferred();
  const entered = deferred();
  const terminate = deferred();
  let terminated = false, writes = 0, hooks;
  const { coordinator, events } = setup({ debugRequest: (value, callbacks) => {
    hooks = callbacks; hooks.paused(); entered.resolve(); return finished.promise;
  }, terminateDebug: async () => { await terminate.promise; terminated = true; } });
  arm(coordinator);
  const debug = coordinator.request(request());
  const rejection = assert.rejects(debug, error => error.code === 'DEBUG_STOPPED');
  await entered.promise;
  const save = coordinator.mutate(() => { assert.equal(terminated, true); writes++; });
  const stop = coordinator.stop();
  await pause(25);
  assert.equal(hooks.signal.aborted, true);
  assert.equal(writes, 0);
  terminate.resolve();
  assert.equal(await stop, true);
  await rejection; await save;
  assert.equal(writes, 1);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 0);
  // Late completion of a terminated backend cannot produce a second response.
  finished.resolve({ status: 200 });
  await pause(1);
  assert.equal(coordinator.state, 'idle');
});

test('failed termination rejects queued mutations and requests without releasing them into an unsafe runtime', async () => {
  const entered = deferred();
  let writes = 0;
  const { coordinator, events } = setup({ debugRequest: (value, hooks) => {
    hooks.paused(); entered.resolve(); return new Promise(() => {});
  }, terminateDebug: async () => { throw new Error('handoff failed'); } });
  arm(coordinator);
  const debug = coordinator.request(request());
  const rejectedDebug = assert.rejects(debug, error => error.code === 'DEBUG_RECOVERY_FAILED');
  await entered.promise;
  const save = coordinator.mutate(() => { writes++; });
  const rejectedSave = assert.rejects(save, error => error.code === 'DEBUG_RECOVERY_FAILED');
  const later = coordinator.request(request('GET', 'index.php'));
  const rejectedLater = assert.rejects(later, error => error.code === 'DEBUG_RECOVERY_FAILED');
  await assert.rejects(coordinator.stop(), /handoff failed/);
  await Promise.all([rejectedDebug, rejectedSave, rejectedLater]);
  assert.equal(writes, 0);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 0);
  assert.equal(coordinator.state, 'failed');
});

test('startup timeout cancels the selected request and recovers without normal execution', async () => {
  let terminated = 0;
  const { coordinator, events } = setup({ startupTimeoutMs: 10, stopTimeoutMs: 10,
    debugRequest: () => new Promise(() => {}), terminateDebug: async () => { terminated++; } });
  arm(coordinator);
  await assert.rejects(coordinator.request(request()), error => error.code === 'DEBUG_STARTUP_TIMEOUT');
  assert.equal(terminated, 1);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 0);
  assert.equal(coordinator.state, 'idle');
});

test('execution timeout resumes after a deliberate pause and never retries', async () => {
  const entered = deferred();
  let hooks;
  const { coordinator } = setup({ requestTimeoutMs: 15, stopTimeoutMs: 10, debugRequest: (value, callbacks) => {
    hooks = callbacks; hooks.started(); hooks.paused(); entered.resolve(); return new Promise(() => {});
  } });
  arm(coordinator);
  const debug = coordinator.request(request());
  const rejected = assert.rejects(debug, error => error.code === 'DEBUG_TIMEOUT');
  await entered.promise;
  await pause(30);
  assert.equal(coordinator.paused, true);
  hooks.resumed();
  await rejected;
  assert.equal(coordinator.state, 'idle');
});

test('a selected queued request can be cancelled before any PHP runs', async () => {
  const holding = deferred();
  let executions = 0;
  const { coordinator, events } = setup({ debugRequest: async () => { executions++; } });
  const first = coordinator.mutate(() => holding.promise);
  arm(coordinator);
  const debug = coordinator.request(request());
  const rejection = assert.rejects(debug, error => error.code === 'DEBUG_STOPPED');
  assert.equal(coordinator.state, 'queued');
  assert.throws(() => arm(coordinator), /already selected/);
  await coordinator.stop();
  holding.resolve(); await first; await rejection;
  assert.equal(executions, 0);
  assert.equal(events.filter(([kind]) => kind === 'normal').length, 0);
});

test('queue saturation cannot consume an armed selection', async () => {
  const holding = deferred();
  let executions = 0;
  const { coordinator } = setup({ debugRequest: async (value, hooks) => { hooks.started(); executions++; return { status: 200 }; } });
  const queued = Array.from({ length: 64 }, () => coordinator.mutate(() => holding.promise));
  arm(coordinator);
  await assert.rejects(coordinator.request(request()), error => error.code === 'DEBUG_QUEUE_FULL');
  assert.equal(coordinator.state, 'armed');
  holding.resolve(); await Promise.all(queued);
  await coordinator.request(request());
  assert.equal(executions, 1);
});

test('observer callbacks cannot fail execution and may stop synchronously at startup', async () => {
  let coordinator;
  let executions = 0;
  ({ coordinator } = setup({ debugRequest: async () => { executions++; }, onState: ({ state }) => {
    if (state === 'starting') void coordinator.stop();
    throw new Error('UI failed');
  } }));
  arm(coordinator);
  await assert.rejects(coordinator.request(request()), error => error.code === 'DEBUG_STOPPED');
  assert.equal(executions, 0);
  await coordinator.close();
  await assert.rejects(coordinator.request(request()), error => error.code === 'DEBUG_CLOSED');
});
