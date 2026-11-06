import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const livePhases = new Set([
  'live API through native PHP cURL and HTTP streams',
  'live read-only JCB Power client',
  'real Demo compile, required Powers, ZIP, install and dashboard',
  'live JCB Greeting field entity import',
]);

/** Receipt eligibility identifies the test phase, not the cause of its failure. */
export function retryableJcbReceipt(receipt, browser) {
  if (receipt?.browser !== browser || !['failed', 'timed-out'].includes(receipt.status)
    || !Array.isArray(receipt.cases) || !receipt.cases.length) return false;
  const failed = receipt.cases.at(-1);
  return ['failed', 'timed-out', 'running'].includes(failed?.status) && livePhases.has(failed.phase)
    && receipt.cases.slice(0, -1).every(item => item?.status === 'passed');
}

function execute(root, env, signal, spawnProcess) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', interrupt);
      resolve(result);
    };
    const interrupt = () => {
      child?.kill(signal.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
      killTimer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    try {
      child = spawnProcess(process.execPath, ['--test', 'test/jcb-network.browser.mjs'], { cwd: root, env, stdio: 'inherit' });
      child.once('error', error => finish({ exitCode: null, signal: null, processError: error.code || 'SPAWN_ERROR' }));
      child.once('close', (exitCode, processSignal) => finish({ exitCode, signal: processSignal, processError: null }));
      signal?.addEventListener('abort', interrupt, { once: true });
      if (signal?.aborted) interrupt();
    } catch (error) { finish({ exitCode: null, signal: null, processError: error.code || 'SPAWN_ERROR' }); }
  });
}

export async function runJcbNetwork({ root = rootDirectory, env = process.env, signal,
  spawnProcess = spawn, backoffMs = 15000, warn = console.warn } = {}) {
  const browser = env.PLAYGROUND_BROWSERS;
  if (!['chromium', 'firefox'].includes(browser)) throw new Error('PLAYGROUND_BROWSERS must select exactly one browser: chromium or firefox.');
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 15000) throw new Error('Invalid JCB retry backoff.');
  const results = path.join(root, 'test-results');
  const attemptsDirectory = path.join(results, 'jcb-network-attempts');
  const summaryFile = path.join(results, 'jcb-network-attempts.json');
  const artifactDirectory = path.resolve(root, env.PLAYGROUND_DIST || 'dist');
  const summary = { schemaVersion: 1, browser, artifactDirectory, maximumAttempts: 2,
    status: 'running', recovered: false, attempts: [] };
  await mkdir(results, { recursive: true });
  // Remove only this runner's previous attempt outputs so stale receipts cannot
  // authorize a retry or turn a missing current result into success.
  await rm(attemptsDirectory, { recursive: true, force: true });
  const save = () => writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  await save();
  let exitCode = 1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) { summary.status = 'interrupted'; break; }
    const receiptDirectory = path.join(attemptsDirectory, `attempt-${attempt}`);
    await mkdir(receiptDirectory, { recursive: true });
    const entry = { attempt, receiptDirectory, status: 'running', startedAt: new Date().toISOString() };
    summary.attempts.push(entry);
    await save();
    const result = await execute(root, { ...env, PLAYGROUND_BROWSERS: browser,
      PLAYGROUND_DIST: artifactDirectory, PLAYGROUND_JCB_RECEIPTS: receiptDirectory }, signal, spawnProcess);
    Object.assign(entry, result, { finishedAt: new Date().toISOString() });
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(receiptDirectory, `jcb-network-${browser}.json`), 'utf8')); }
    catch { /* A missing or malformed current receipt never qualifies for retry. */ }
    const lastCase = Array.isArray(receipt?.cases) ? receipt.cases.at(-1) : null;
    entry.failurePhase = typeof lastCase?.phase === 'string' ? lastCase.phase : null;
    entry.retryEligible = result.exitCode !== 0 && Number.isInteger(result.exitCode) && !result.signal
      && !result.processError && !signal?.aborted && retryableJcbReceipt(receipt, browser);
    if (signal?.aborted || result.signal) {
      entry.status = 'interrupted'; summary.status = 'interrupted';
      exitCode = (result.signal || signal.reason) === 'SIGINT' ? 130 : 143;
      break;
    }
    if (result.exitCode === 0 && !result.processError && receipt?.browser === browser && receipt.status === 'passed'
      && Array.isArray(receipt.cases) && receipt.cases.length === 2
      && receipt.cases.every(item => item?.status === 'passed' && item.phpVersion === '8.4')
      && ['5', '6'].every(major => receipt.cases.some(item => String(item.joomlaVersion).split('.')[0] === major))) {
      entry.status = 'passed'; summary.status = 'passed'; summary.recovered = attempt > 1; exitCode = 0;
      if (summary.recovered) warn('::warning::The first live integration attempt failed; a fresh second attempt passed. Both attempts and diagnostics are retained.');
      break;
    }
    entry.status = result.processError ? 'process-error' : 'failed';
    summary.status = 'failed';
    exitCode = Number.isInteger(result.exitCode) && result.exitCode > 0 ? result.exitCode : 1;
    await save();
    if (attempt === 2 || !entry.retryEligible) break;
    warn('::warning::The first live integration attempt failed. Retaining its diagnostics and retrying once in a fresh process.');
    try { await delay(backoffMs, undefined, { signal }); }
    catch { summary.status = 'interrupted'; exitCode = signal?.reason === 'SIGINT' ? 130 : 143; break; }
  }
  if (summary.status === 'interrupted' && !summary.attempts.length) exitCode = signal?.reason === 'SIGINT' ? 130 : 143;
  summary.finishedAt = new Date().toISOString();
  await save();
  return { exitCode, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const interrupt = signal => controller.abort(signal);
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try { process.exitCode = (await runJcbNetwork({ signal: controller.signal })).exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
}
