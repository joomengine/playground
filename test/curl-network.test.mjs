import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Execute the exact new JavaScript embedded in the native patch. The complete
// compiled extension is exercised by curl.integration.mjs; these deterministic
// checks need neither a copied upstream implementation nor a network download.
const patch = await readFile(new URL('../native/curl-network.patch', import.meta.url), 'utf8');
const hunks = patch.split(/^@@.*@@.*\n/m).slice(1);
const additions = hunks.map(hunk => hunk.split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n'));
function addition(anchor) {
  const matches = additions.filter(source => source.includes(anchor));
  assert.equal(matches.length, 1, `Expected one native bridge patch hunk containing ${anchor}.`);
  return matches[0];
}

function postimage(anchor) {
  const matches = hunks.filter(source => source.includes(anchor));
  assert.equal(matches.length, 1, `Expected one native bridge patch hunk containing ${anchor}.`);
  return matches[0].split('\n').filter(line => line.startsWith('+') || line.startsWith(' '))
    .map(line => line.slice(1)).join('\n');
}

function headerProjection() {
  const source = postimage('const hasBody');
  return vm.runInNewContext(`(response, init) => { ${source.slice(source.indexOf('const hasBody'))} return lines; }`);
}

function harness({ hook, fetcher = async () => new Response('direct') } = {}) {
  let clock = 100;
  const sandbox = vm.createContext({
    performance: { now: () => clock }, fetch: fetcher,
    ...(hook ? { __joomenginePhpFetch: hook } : {}),
  });
  const dispatch = vm.runInContext(`(async (request, started, currentURL, init) => {
    let response;
    ${addition('__joomenginePhpFetch')}
    return response;
  })`, sandbox);
  const redirectCount = vm.runInContext(`((response, canStopAtRedirect, followed) => {
    const result = {};
    ${addition('result.redirected =').match(/result\.redirected\s*=[\s\S]*?;/)[0]}
    return result.redirected;
  })`, sandbox);
  return { sandbox, dispatch, redirectCount, setClock: value => { clock = value; } };
}

test('native HTTP boundary selects the scoped hook without changing asset Fetch', async () => {
  const received = [];
  const assetFetch = async url => new Response(`asset:${url}`);
  const expected = new Response('upstream');
  const bridge = harness({ fetcher: assetFetch, hook: async (...args) => { received.push(args); return expected; } });
  const url = new URL('https://api.example/data?b=2&a=1');
  const headers = new Headers({ Accept: 'application/json' });
  const signal = new AbortController().signal;
  const init = { method: 'GET', headers, signal, redirect: 'manual' };
  const response = await bridge.dispatch({ timeoutMs: 1000, maxRedirs: 3, follow: true }, 10, url, init);
  assert.equal(response, expected);
  assert.equal(received.length, 1);
  assert.equal(received[0][0], url.href);
  assert.equal(received[0][1], init);
  assert.equal(init.headers, headers);
  assert.equal(init.signal, signal);
  assert.equal(init.redirect, 'manual', 'Node native redirect handling must retain its direct Fetch mode.');
  assert.deepEqual({ ...init.network }, { timeoutMs: 910, maxRedirects: 3, redirect: 'follow' });
  assert.equal(bridge.sandbox.fetch, assetFetch);
  assert.equal(await (await bridge.sandbox.fetch('runtime.wasm')).text(), 'asset:runtime.wasm');
  assert.equal(received.length, 1, 'Loading a runtime asset must not reach the PHP networking hook.');
});

test('native standalone callers keep ordinary Fetch when no Playground hook exists', async () => {
  const received = [];
  const bridge = harness({ fetcher: async (...args) => { received.push(args); return new Response('standalone'); } });
  const init = { method: 'HEAD', redirect: 'manual' };
  assert.equal(await (await bridge.dispatch({ timeoutMs: 0, maxRedirs: -1, follow: false }, 0,
    new URL('https://example.org/'), init)).text(), 'standalone');
  assert.equal(received.length, 1);
  assert.deepEqual({ ...init.network }, { timeoutMs: 0, maxRedirects: -1, redirect: 'manual' });
});

test('native retries pass only the original deadline remaining', async () => {
  const budgets = [];
  const bridge = harness({ hook: async (_url, init) => { budgets.push(init.network.timeoutMs); return new Response(null); } });
  const request = { timeoutMs: 1000, maxRedirs: 5, follow: true };
  const url = new URL('https://example.org/');
  for (const elapsed of [100, 400, 900, 1001]) {
    bridge.setClock(elapsed);
    await bridge.dispatch(request, 0, url, { method: 'GET' });
  }
  assert.deepEqual(budgets, [900, 600, 100, 1]);
  assert.equal(request.timeoutMs, 1000, 'The original native timer must not be reset by fallback or redirects.');
});

test('native write methods retain exact binary bodies and PHP redirect options', async () => {
  const bridge = harness({ hook: async () => new Response(null) });
  const body = new Uint8Array([0, 255, 10, 128]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const init = { method, body, headers: new Headers({ 'content-type': 'application/octet-stream' }) };
    await bridge.dispatch({ timeoutMs: 500, maxRedirs: 0, follow: false }, 0,
      new URL('https://example.org/write'), init);
    assert.equal(init.body, body);
    assert.equal(init.method, method);
    assert.equal(init.network.maxRedirects, 0);
    assert.equal(init.network.redirect, 'manual');
  }
});

test('native getinfo uses exact relay redirect counts and preserves native fallback semantics', () => {
  const { redirectCount } = harness();
  assert.equal(redirectCount({ networkRedirectCount: 4, redirected: true }, false, 0), 4);
  assert.equal(redirectCount({ networkRedirectCount: 0, redirected: false }, true, 0), 0);
  assert.equal(redirectCount({ networkRedirectCount: 0, redirected: false }, true, 3), 3);
  assert.equal(redirectCount({ networkRedirectCount: 2, redirected: true }, true, 3), 5);
  assert.equal(redirectCount({ redirected: true }, true, 3), 3);
  assert.equal(redirectCount({ redirected: true }, false, 0), 1,
    'Browser direct Fetch only exposes whether a redirect occurred, not its exact count.');
  assert.equal(redirectCount({ redirected: false }, false, 0), 0);
  assert.equal(redirectCount({ networkRedirectCount: 1.5, redirected: true }, true, 2), 2);
});

test('native deadline abort carries TimeoutError and standalone error handling recognizes it', () => {
  let callback, delay;
  const controller = new AbortController();
  const sandbox = vm.createContext({
    request: { timeoutMs: 125 }, controller, DOMException,
    setTimeout: (fn, value) => { callback = fn; delay = value; return 1; },
  });
  vm.runInContext(`let timer = null; ${addition('timer = setTimeout')}`, sandbox);
  assert.equal(delay, 125);
  assert.equal(controller.signal.aborted, false);
  callback();
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.name, 'TimeoutError');
  // Execute the changed condition too; the existing native branch maps this to
  // CURLE_OPERATION_TIMEDOUT, including when no shared transport is installed.
  const condition = addition("error.name === 'TimeoutError'").trim().replace(/^else /, '');
  const isTimeout = vm.runInContext(`error => { ${condition} return true; return false; }`, sandbox);
  assert.equal(isTimeout(controller.signal.reason), true);
  assert.equal(isTimeout(new DOMException('Caller cancelled', 'AbortError')), true);
  assert.equal(isTimeout(new TypeError('Connection failed')), false);
});

test('native preserves representation headers for HEAD and bodyless statuses, including CORS', () => {
  // Include unchanged loop statements from the real patch hunk, not a separate
  // implementation of the header projection. Compiled PHP verifies C callbacks.
  const project = headerProjection();
  for (const type of ['basic', 'cors']) {
    for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304]]) {
      const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '1234', 'x-proof': 'kept' });
      assert.deepEqual(Array.from(project({ headers, status, type }, { method })), [
        'content-encoding: gzip', 'content-length: 1234', 'x-proof: kept',
      ], `${method} ${status} ${type} must retain representation metadata.`);
      headers.delete('content-encoding');
      assert.deepEqual(Array.from(project({ headers, status, type }, { method })), [
        'content-length: 1234', 'x-proof: kept',
      ], `${method} ${status} ${type} must retain length even when CORS hides encoding.`);
    }
  }
  for (const type of ['basic', 'cors']) {
    const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '1234', 'x-proof': 'kept' });
    assert.deepEqual(Array.from(project({ headers, status: 200, type }, { method: 'GET' })), ['x-proof: kept']);
    headers.delete('content-encoding');
    assert.deepEqual(Array.from(project({ headers, status: 200, type }, { method: 'GET' })),
      type === 'cors' ? ['x-proof: kept'] : ['content-length: 1234', 'x-proof: kept']);
  }
});

test('native exposes proxy Set-Cookie headers once with or without getSetCookie', () => {
  const project = headerProjection();
  const cookies = ['first=one; Path=/', 'second=two; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/'];
  for (const accessor of [true, false]) {
    const headers = new Headers(cookies.map(value => ['set-cookie', value]));
    if (!accessor) Object.defineProperty(headers, 'getSetCookie', { value: undefined });
    assert.deepEqual(Array.from(project({ headers, status: 200, type: 'basic' }, { method: 'GET' })),
      cookies.map(value => `set-cookie: ${value}`));
  }
  assert.deepEqual(Array.from(project({ headers: new Headers(), status: 200, type: 'cors' }, { method: 'GET' })), [],
    'Direct browser Fetch keeps its normal hidden-cookie behavior.');
});
