import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retryableJcbReceipt, runJcbNetwork } from '../scripts/test-jcb-network.mjs';

const phase = 'real Demo compile, required Powers, ZIP, install and dashboard';
const failed = { browser: 'firefox', status: 'failed', cases: [{ status: 'failed', phase }] };
const passed = { browser: 'firefox', status: 'passed', cases: [{ joomlaVersion: '5.4.0', phpVersion: '8.4', status: 'passed', phase: 'complete' },
  { joomlaVersion: '6.0.0', phpVersion: '8.4', status: 'passed', phase: 'complete' }] };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jcb-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, PLAYGROUND_BROWSERS: 'firefox' }, backoffMs: 0, warn: () => {} };
}

function mockProcesses(results, calls) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
    const index = calls.length;
    calls.push({ executable, args, options, child });
    const result = results[index];
    queueMicrotask(async () => {
      if (result.receipt) await writeFile(path.join(options.env.PLAYGROUND_JCB_RECEIPTS, 'jcb-network-firefox.json'), JSON.stringify(result.receipt));
      if (result.error) child.emit('error', Object.assign(new Error('Cannot spawn'), { code: result.error }));
      else if (!result.pending) child.emit('close', result.code, result.signal || null);
    });
    return child;
  };
}

test('only failed selected-browser receipts in the four live phases qualify for retry', () => {
  for (const live of ['live API through native PHP cURL and HTTP streams', 'live read-only JCB Power client', phase, 'live JCB Greeting field entity import']) {
    assert.equal(retryableJcbReceipt({ ...failed, cases: [{ status: 'failed', phase: live }] }, 'firefox'), true);
  }
  for (const receipt of [null, {}, passed, { ...failed, browser: 'chromium' }, { ...failed, status: 'running' },
    { ...failed, cases: [] }, { ...failed, cases: [{ status: 'failed', phase: 'bootstrap' }] },
    { ...failed, cases: [{ status: 'failed', phase: 'document assets' }] },
    { ...failed, cases: [{ status: 'failed', phase }, { status: 'failed', phase }] }]) {
    assert.equal(retryableJcbReceipt(receipt, 'firefox'), false);
  }
  assert.equal(retryableJcbReceipt({ ...failed, status: 'timed-out', cases: [{ status: 'running', phase }] }, 'firefox'), true);
});

test('passing first attempt runs once and configuration rejects ambiguous browser selections', async t => {
  const options = await fixture(t); const calls = [];
  const result = await runJcbNetwork({ ...options, spawnProcess: mockProcesses([{ code: 0, receipt: passed }], calls) });
  assert.equal(calls.length, 1); assert.equal(result.exitCode, 0); assert.equal(result.summary.recovered, false);
  for (const browser of [undefined, '', 'chromium,firefox', 'webkit']) {
    await assert.rejects(runJcbNetwork({ ...options, env: { PLAYGROUND_BROWSERS: browser } }), /exactly one browser/);
  }
});

test('ordinary live failure retries once with unchanged artifact/browser and distinct retained receipt directories', async t => {
  const options = await fixture(t); const calls = []; const warnings = [];
  const result = await runJcbNetwork({ ...options, warn: value => warnings.push(value),
    spawnProcess: mockProcesses([{ code: 1, receipt: failed }, { code: 0, receipt: passed }], calls) });
  assert.equal(result.exitCode, 0); assert.equal(result.summary.recovered, true);
  assert.deepEqual(result.summary.attempts.map(attempt => attempt.status), ['failed', 'passed']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['--test', 'test/jcb-network.browser.mjs']);
  assert.equal(calls[0].executable, calls[1].executable);
  assert.equal(calls[0].options.env.PLAYGROUND_DIST, calls[1].options.env.PLAYGROUND_DIST);
  assert.equal(calls[0].options.env.PLAYGROUND_BROWSERS, calls[1].options.env.PLAYGROUND_BROWSERS);
  assert.notEqual(calls[0].options.env.PLAYGROUND_JCB_RECEIPTS, calls[1].options.env.PLAYGROUND_JCB_RECEIPTS);
  const retained = JSON.parse(await readFile(path.join(calls[0].options.env.PLAYGROUND_JCB_RECEIPTS, 'jcb-network-firefox.json')));
  assert.deepEqual(retained, failed);
  assert.ok(warnings.every(value => !/transient|network outage|PHP timeout/i.test(value)));
  const summary = JSON.parse(await readFile(path.join(options.root, 'test-results/jcb-network-attempts.json')));
  assert.deepEqual(summary, result.summary);
});

test('two failed attempts remain a failure and there is no third attempt', async t => {
  const options = await fixture(t); const calls = [];
  const result = await runJcbNetwork({ ...options,
    spawnProcess: mockProcesses([{ code: 1, receipt: failed }, { code: 2, receipt: failed }], calls) });
  assert.equal(calls.length, 2); assert.equal(result.exitCode, 2); assert.equal(result.summary.recovered, false);
  assert.equal(result.summary.status, 'failed');
});

test('bootstrap failures, absent receipts, spawn errors and signals never retry', async t => {
  for (const failure of [{ code: 1, receipt: { ...failed, cases: [{ status: 'failed', phase: 'bootstrap' }] } },
    { code: 1 }, { code: 0 }, { code: 0, receipt: { ...passed, cases: [passed.cases[0], passed.cases[0]] } },
    { code: 1, receipt: { ...failed, cases: {} } }, { code: 0, receipt: { ...passed, cases: [null, null] } },
    { error: 'ENOENT', receipt: failed }, { code: null, signal: 'SIGKILL', receipt: failed }]) {
    const options = await fixture(t); const calls = [];
    const result = await runJcbNetwork({ ...options, spawnProcess: mockProcesses([failure], calls) });
    assert.equal(calls.length, 1); assert.notEqual(result.exitCode, 0); assert.equal(result.summary.recovered, false);
  }
});

test('stale previous receipt cannot qualify a current failure for retry', async t => {
  const options = await fixture(t); const calls = [];
  const previous = path.join(options.root, 'test-results/jcb-network-attempts/attempt-1');
  await mkdir(previous, { recursive: true });
  await writeFile(path.join(previous, 'jcb-network-firefox.json'), JSON.stringify(failed));
  const result = await runJcbNetwork({ ...options, spawnProcess: mockProcesses([{ code: 1 }], calls) });
  assert.equal(calls.length, 1); assert.equal(result.summary.attempts[0].retryEligible, false);
});

test('interruption forwards to the child and stops before a retry or another launch', async t => {
  const options = await fixture(t); const calls = []; const controller = new AbortController();
  const running = runJcbNetwork({ ...options, signal: controller.signal,
    spawnProcess: mockProcesses([{ pending: true }], calls) });
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort('SIGINT');
  const result = await running;
  assert.equal(calls.length, 1); assert.equal(result.exitCode, 130); assert.equal(result.summary.status, 'interrupted');
  const stopped = await runJcbNetwork({ ...options, signal: controller.signal, spawnProcess: () => assert.fail('must not spawn') });
  assert.equal(stopped.summary.attempts.length, 0); assert.equal(stopped.exitCode, 130);
});

test('actual subprocess retries use different Node processes and preserve failed diagnostics', async t => {
  const options = await fixture(t);
  // This fixture launches the runner as CI does, outside Node's own test child protocol.
  delete options.env.NODE_TEST_CONTEXT;
  await mkdir(path.join(options.root, 'test'), { recursive: true });
  await writeFile(path.join(options.root, 'test/jcb-network.browser.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const directory = process.env.PLAYGROUND_JCB_RECEIPTS;
    const first = directory.endsWith('attempt-1');
    await writeFile(path.join(directory, 'pid.json'), JSON.stringify({ pid: process.pid }));
    await writeFile(path.join(directory, 'jcb-network-firefox.json'), JSON.stringify(first ? ${JSON.stringify(failed)} : ${JSON.stringify(passed)}));
    process.exitCode = first ? 1 : 0;
  `);
  const result = await runJcbNetwork({ ...options, spawnProcess: (executable, args, init) => spawn(executable, args, { ...init, stdio: 'ignore' }) });
  assert.equal(result.exitCode, 0); assert.equal(result.summary.recovered, true);
  const pids = await Promise.all(result.summary.attempts.map(async attempt =>
    JSON.parse(await readFile(path.join(attempt.receiptDirectory, 'pid.json'))).pid));
  assert.notEqual(pids[0], pids[1]);
});
