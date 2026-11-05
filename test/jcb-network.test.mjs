import test from 'node:test';
import assert from 'node:assert/strict';
import { createJcbRepositoryFetch } from '../src/jcb-network.mjs';
import { createPhpFetch } from '../src/php-network.mjs';

const guid = '7d95ce74-53dc-4672-bd8a-3b71cdacabea';
const api = 'https://api.joomlacomponentbuilder.com/v1/network/community/jcb/';
const raw = (host = 'git.envs.net', repository = 'super-powers', file = 'super-powers.json', ref = 'master') =>
  `https://${host}/api/v1/repos/joomla/${repository}/raw/${file}?ref=${ref}`;
const index = (repository = 'super-powers') => JSON.stringify({ [guid]: {
  guid, name: 'Actions', path: `src/${guid}`,
  settings: `src/${guid}/${repository === 'joomla-powers' ? 'item' : 'settings'}.json`,
  ...(repository === 'joomla-powers' ? {} : { power: `src/${guid}/code.power` }),
} });
const network = (entries, repository = 'super-powers') => new Response(JSON.stringify({ target: repository,
  network: entries.map(([host, status]) => ({ status, url: `https://${host}/joomla/${repository}` })) }));
const failed = () => { throw new TypeError('Failed to fetch'); };

test('a healthy original index keeps its URL, headers, response and bytes', async () => {
  const input = new Request(raw(), { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Joomla' } });
  const response = new Response(index(), { headers: { 'X-Proof': 'original' } });
  let calls = 0;
  const fetcher = createJcbRepositoryFetch(async (value, init) => {
    calls++; assert.equal(value, input); assert.equal(init.headers, undefined); assert.ok(init.signal);
    return response;
  });
  assert.equal(await fetcher(input), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), index());
  assert.equal(calls, 1);
});

test('advertised active mirrors precede an advertised inactive browser-reachable mirror', async () => {
  const calls = [], options = { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Joomla Gitea' } };
  const fetcher = createJcbRepositoryFetch(async (url, init) => {
    calls.push(url);
    if (url.startsWith(api)) return network([['codeberg.org', 0], ['tildegit.org', 1], ['git.envs.net', 1]]);
    if (url.startsWith('https://codeberg.org/')) {
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
      assert.equal(new Headers(init.headers).has('content-type'), false);
      assert.equal(new Headers(init.headers).has('user-agent'), false);
      return new Response(index());
    }
    return failed();
  });
  const response = await fetcher(raw(), options);
  assert.equal(await response.text(), index());
  assert.deepEqual(calls, [raw(), `${api}super-powers`, raw('tildegit.org'), raw('codeberg.org')]);
});

test('an active mirror that works prevents probing inactive mirrors', async () => {
  const calls = [];
  const fetcher = createJcbRepositoryFetch(async url => {
    calls.push(url);
    if (url.startsWith(api)) return network([['codeberg.org', 0], ['tildegit.org', 1]]);
    if (url.startsWith('https://tildegit.org/')) return new Response(index());
    return failed();
  });
  await fetcher(raw());
  assert.deepEqual(calls, [raw(), `${api}super-powers`, raw('tildegit.org')]);
});

test('index-selected mirror supplies settings and code with the exact requested branch', async () => {
  const calls = [], ref = 'feature%2Fdemo';
  const fetcher = createJcbRepositoryFetch(async url => {
    calls.push(url);
    if (url.startsWith(api)) return network([['codeberg.org', 0]]);
    if (!url.startsWith('https://codeberg.org/')) return failed();
    return new Response(url.includes('super-powers.json') ? index()
      : url.includes('settings.json') ? JSON.stringify({ guid }) : 'public function example() {}');
  });
  await fetcher(raw(undefined, undefined, undefined, ref));
  for (const file of [`src/${guid}/settings.json`, `src/${guid}/code.power`]) {
    assert.equal((await fetcher(raw('tildegit.org', 'super-powers', file, ref))).status, 200);
    assert.equal(calls.at(-1), raw('codeberg.org', 'super-powers', file, ref));
  }
  assert.equal(calls.filter(url => url.startsWith(api)).length, 1);
});

test('Joomla Power index selects item.json paths and verifies the returned GUID', async () => {
  const fetcher = createJcbRepositoryFetch(async url => {
    if (url.startsWith(api)) return network([['codeberg.org', 0]], 'joomla-powers');
    if (!url.startsWith('https://codeberg.org/')) return failed();
    return new Response(url.includes('index.json') ? index('joomla-powers') : JSON.stringify({ guid }));
  });
  await fetcher(raw('git.envs.net', 'joomla-powers', 'index.json'));
  assert.deepEqual(await (await fetcher(raw('git.envs.net', 'joomla-powers', `src/${guid}/item.json`))).json(), { guid });
});

test('portable entity indices use packages discovery and retain separate mirror selections', async () => {
  const calls = [], ref = 'feature%2Fentities';
  const entityIndex = name => JSON.stringify({ [guid]: { guid, path: `src/${name}/${guid}`, settings: `src/${name}/${guid}/item.json` } });
  const fetcher = createJcbRepositoryFetch(async (url, options) => {
    calls.push(url);
    if (url.startsWith(api)) {
      assert.equal(url, `${api}packages`);
      return network([['tildegit.org', 1], ['codeberg.org', 0]], 'packages');
    }
    const entity = url.includes('admin-view') || url.includes('admin_view') ? 'admin_view' : 'field';
    const origin = entity === 'field' ? 'https://codeberg.org/' : 'https://tildegit.org/';
    if (!url.startsWith(origin)) return failed();
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(url.includes('/index/') ? entityIndex(entity) : JSON.stringify({ guid, entity }));
  });
  await fetcher(raw('git.vdm.dev', 'packages', 'index/field.json', ref));
  await fetcher(raw('git.vdm.dev', 'packages', 'index/admin-view.json', ref));
  for (const [entity, host] of [['field', 'codeberg.org'], ['admin_view', 'tildegit.org']]) {
    const file = `src/${entity}/${guid}/item.json`;
    assert.deepEqual(await (await fetcher(raw('git.vdm.dev', 'packages', file, ref))).json(), { guid, entity });
    assert.equal(calls.at(-1), raw(host, 'packages', file, ref));
  }
  assert.equal(calls.filter(url => url.startsWith(api)).length, 1, 'Entity indices share only discovery, not their selected files.');
});

test('portable entity fallback rejects cross-entity paths and mismatched stored identities', async () => {
  const makeIndex = (entity, settings = `src/${entity}/${guid}/item.json`) => JSON.stringify({ [guid]: {
    guid, path: `src/${entity}/${guid}`, settings,
  } });
  for (const invalid of [makeIndex('admin_view'), makeIndex('field', `src/field/${guid}/code.php`),
    makeIndex('field', '../private.json')]) {
    const calls = [];
    const fetcher = createJcbRepositoryFetch(async url => {
      calls.push(url);
      if (url.startsWith(api)) return network([['codeberg.org', 0]], 'packages');
      return new Response(invalid);
    });
    await assert.rejects(fetcher(raw('git.vdm.dev', 'packages', 'index/field.json')), /could not be read/);
    assert.equal(calls.length, 3);
  }
  const fetcher = createJcbRepositoryFetch(async url => new Response(url.includes('/index/')
    ? makeIndex('field') : JSON.stringify({ guid: 'wrong' })));
  await fetcher(raw('git.vdm.dev', 'packages', 'index/field.json'));
  await assert.rejects(fetcher(raw('git.vdm.dev', 'packages', `src/field/${guid}/item.json`)), /GUID does not match/);
});

test('a failed selected file does not mix in another mirror or silently return HTML', async () => {
  const calls = [];
  const fetcher = createJcbRepositoryFetch(async url => {
    calls.push(url);
    if (url.startsWith(api)) return network([['codeberg.org', 0], ['tildegit.org', 0]]);
    if (url.startsWith('https://codeberg.org/')) return new Response(url.includes('super-powers.json') ? index() : '<!doctype html>challenge');
    return failed();
  });
  await fetcher(raw());
  const before = calls.length;
  await assert.rejects(fetcher(raw('git.envs.net', 'super-powers', `src/${guid}/code.power`)), /invalid file/);
  assert.deepEqual(calls.slice(before), [raw('codeberg.org', 'super-powers', `src/${guid}/code.power`)]);
});

test('selected settings with a different GUID fail closed', async () => {
  const fetcher = createJcbRepositoryFetch(async url => new Response(url.includes('super-powers.json') ? index() : JSON.stringify({ guid: 'wrong' })));
  await fetcher(raw());
  await assert.rejects(fetcher(raw('git.envs.net', 'super-powers', `src/${guid}/settings.json`)), /GUID does not match/);
});

test('HTML challenge, HTTP failure, malformed index and oversized body are rejected before fallback', async () => {
  for (const bad of [
    () => new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('Unavailable', { status: 503 }),
    () => new Response('{"error":"challenge"}'),
    () => new Response(index(), { headers: { 'Content-Length': String(5 * 1024 * 1024) } }),
    () => new Response(index().replace(`src/${guid}/settings.json`, '../private.json')),
  ]) {
    const fetcher = createJcbRepositoryFetch(async url => {
      if (url.startsWith(api)) return network([['codeberg.org', 0]]);
      return url.startsWith('https://codeberg.org/') ? new Response(index()) : bad();
    });
    assert.equal(await (await fetcher(raw())).text(), index());
  }
});

test('all mirror failures report the attempted hosts and preserve the original cause', async () => {
  const cause = new TypeError('Failed to fetch');
  const fetcher = createJcbRepositoryFetch(async url => {
    if (url.startsWith(api)) return network([['codeberg.org', 0], ['tildegit.org', 1]]);
    throw cause;
  });
  await assert.rejects(fetcher(raw()), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /git\.envs\.net, tildegit\.org, codeberg\.org/);
    return true;
  });
});

test('failed discovery is retried on a later index request', async () => {
  let discoveries = 0;
  const fetcher = createJcbRepositoryFetch(async url => {
    if (url.startsWith(api)) return ++discoveries === 1 ? new Response('Unavailable', { status: 503 }) : network([['codeberg.org', 0]]);
    return url.startsWith('https://codeberg.org/') ? new Response(index()) : failed();
  });
  await assert.rejects(fetcher(raw()), /could not be read/);
  assert.equal((await fetcher(raw())).status, 200);
  assert.equal(discoveries, 2);
});

test('advertised URLs cannot expand the exact host, organization, repository or port allowlist', async () => {
  const calls = [];
  const urls = ['https://localhost/joomla/super-powers', 'https://codeberg.org/other/super-powers',
    'https://codeberg.org/joomla/private', 'https://codeberg.org:444/joomla/super-powers',
    'https://user:secret@codeberg.org/joomla/super-powers', 'https://codeberg.org/joomla/super-powers?token=secret'];
  const fetcher = createJcbRepositoryFetch(async url => {
    calls.push(url);
    if (url.startsWith(api)) return new Response(JSON.stringify({ target: 'super-powers', network: urls.map(url => ({ url, status: 1 })) }));
    return failed();
  });
  await assert.rejects(fetcher(raw()), /could not be read/);
  assert.deepEqual(calls, [raw(), `${api}super-powers`]);
});

test('credentials, custom requests and unindexed files keep their exact original Fetch call', async () => {
  const cases = [
    [raw(), { headers: { Authorization: 'token secret' } }], [raw(), { headers: { Cookie: 'secret' } }],
    [raw(), { headers: { 'Proxy-Authorization': 'secret' } }], [raw(), { headers: { 'X-Api-Key': 'secret' } }],
    [raw(), { headers: { Range: 'bytes=0-10' } }], [raw(), { credentials: 'include' }],
    [raw(), { method: 'POST', body: 'secret' }], [raw(), { method: 'HEAD' }],
    [raw(), { mode: 'no-cors' }], [raw(), { integrity: 'sha256-abc' }],
    [raw().replace('/joomla/', '/custom/')], [raw().replace('git.envs.net', 'example.test')],
    [raw().replace('/super-powers/', '/custom/')], [`${raw()}&token=secret`], [`${raw()}&ref=other`],
    [raw().replace('https://', 'https://user:secret@')], [raw('git.envs.net', 'super-powers', 'README.md')],
    [raw('git.envs.net', 'super-powers', 'src/%2e%2e/private')],
    [raw('git.vdm.dev', 'packages', 'index/field.json'), { headers: { Authorization: 'token secret' } }],
    [raw('git.vdm.dev', 'packages', 'index/custom-code.json')],
    [raw('git.vdm.dev', 'packages', 'index/admin-fields.json')],
    [raw('git.vdm.dev', 'packages', `src/field/${guid}/unindexed.json`)],
    [raw('git.vdm.dev', 'packages', 'src/field/not-a-guid/item.json')],
  ];
  for (const [input, init] of cases) {
    let calls = 0;
    const expected = new Response('unchanged');
    const fetcher = createJcbRepositoryFetch(async (actual, options) => {
      calls++; assert.equal(actual, input); assert.equal(options, init); return expected;
    });
    assert.equal(await fetcher(input, init), expected); assert.equal(calls, 1);
  }
});

test('caller cancellation stops discovery and every fallback, preserving its reason', async () => {
  const controller = new AbortController(), reason = new Error('Cancelled by caller');
  let calls = 0;
  const fetcher = createJcbRepositoryFetch((_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = fetcher(raw(), { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 1);
  await assert.rejects(fetcher(raw(), { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

test('a stalled primary mirror times out and still permits a healthy advertised fallback', async () => {
  let primarySignal;
  const fetcher = createJcbRepositoryFetch(async (url, { signal }) => {
    if (url.startsWith(api)) return network([['codeberg.org', 0]]);
    if (url.startsWith('https://codeberg.org/')) return new Response(index());
    primarySignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { attemptTimeoutMs: 30, timeoutMs: 200 });
  assert.equal((await fetcher(raw())).status, 200);
  assert.equal(primarySignal.aborted, true);
});

test('the PHP fetch wrapper enables fallback independently of optional image relay settings', async () => {
  const fetcher = createPhpFetch(async url => {
    if (url.startsWith(api)) return network([['codeberg.org', 0]]);
    return url.startsWith('https://codeberg.org/') ? new Response(index()) : failed();
  }, 'https://playground.example/__site/test/', () => true);
  assert.equal((await fetcher(raw())).status, 200);
});
