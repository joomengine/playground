import assert from 'node:assert/strict';
import test from 'node:test';
import { JoomlaFileSystemProvider } from '../src/code/file-provider.mjs';
import { JoomlaSearchProvider } from '../src/code/search-provider.mjs';

const expired = () => Object.assign(new Error('The search expired.'), { code: 'SEARCH_EXPIRED' });
const match = (path = '/file.php', revision = 'current') => ({ path, revision, preview: 'Joomla', lineNumber: 1,
  column: 1, endColumn: 7, previewColumn: 1 });
const page = (results = [], cursor = null) => ({ results, cursor, skipped: 0, truncated: false });
const query = { contentPattern: { pattern: 'Joomla' } };

test('workspace errors retain their protocol code and cause alongside the VS Code code', async () => {
  const cause = expired();
  const provider = new JoomlaFileSystemProvider({ request: async () => { throw cause; } }, 'test');
  try {
    await assert.rejects(provider.request('search', { cursor: 'old' }), error => {
      assert.equal(error.workspaceCode, 'SEARCH_EXPIRED');
      assert.equal(error.cause, cause);
      assert.equal(error.code, 'Unknown');
      return true;
    });
  } finally { provider.dispose(); }
});

test('an expired cursor before any matches restarts once with the original query', async () => {
  const calls = [], progress = [];
  const provider = new JoomlaFileSystemProvider({ async request(operation, args) {
    calls.push({ operation, args });
    if (calls.length === 1) return { ...page([], 'cgi-cursor'), skipped: 9 };
    if (calls.length === 2) throw expired();
    return page([match('/active.php')]);
  } }, 'test');
  try {
    const search = new JoomlaSearchProvider(provider);
    const result = await search.textSearch(query, item => progress.push(item));
    assert.equal(calls.length, 3);
    assert.equal(calls[1].args.cursor, 'cgi-cursor');
    assert.deepEqual(calls[2], calls[0]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].resource.path, '/active.php');
    assert.equal(progress.length, 1);
    assert.equal(search.revisions.get('/active.php'), 'current');
    assert.equal(result.limitHit, false);
    assert.deepEqual(result.messages, []);
  } finally { provider.dispose(); }
});

test('expiration after streamed matches returns an incomplete warning without mixing or duplicating results', async () => {
  let calls = 0;
  const progress = [];
  const provider = new JoomlaFileSystemProvider({ async request() {
    if (++calls === 1) return page([match('/first.php', 'before-pause')], 'old-cursor');
    throw expired();
  } }, 'test');
  try {
    const search = new JoomlaSearchProvider(provider);
    const result = await search.textSearch(query, item => progress.push(item));
    assert.equal(calls, 2, 'A search with streamed matches must not restart.');
    assert.equal(progress.length, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].resource.path, '/first.php');
    assert.equal(search.revisions.get('/first.php'), 'before-pause');
    assert.equal(result.limitHit, true);
    assert.match(result.messages[0].text, /incomplete; run the search again/);
  } finally { provider.dispose(); }
});

test('repeated expiration is bounded to one restart and reports incomplete results', async () => {
  let calls = 0;
  const provider = new JoomlaFileSystemProvider({ async request() { calls++; throw expired(); } }, 'test');
  try {
    const result = await new JoomlaSearchProvider(provider).textSearch(query, () => assert.fail('No matches were returned.'));
    assert.equal(calls, 2);
    assert.deepEqual(result.results, []);
    assert.equal(result.limitHit, true);
    assert.match(result.messages[0].text, /incomplete/);
  } finally { provider.dispose(); }
});

test('failed cursor cleanup cannot mask the original search error', async () => {
  const primary = Object.assign(new Error('Source file became unreadable.'), { code: 'READ_FAILED' });
  let searches = 0, cancellations = 0;
  const provider = new JoomlaFileSystemProvider({ async request(operation) {
    if (operation === 'cancelSearch') { cancellations++; throw new Error('Cleanup failed.'); }
    if (++searches === 1) return page([], 'cursor');
    throw primary;
  } }, 'test');
  try {
    await assert.rejects(new JoomlaSearchProvider(provider).textSearch(query), error => error.cause === primary);
    assert.equal(searches, 2);
    assert.equal(cancellations, 1);
  } finally { provider.dispose(); }
});

test('failed cleanup preserves successful limited results and cancellation stays bounded', async () => {
  let searches = 0, cancellations = 0;
  const provider = new JoomlaFileSystemProvider({ async request(operation) {
    if (operation === 'cancelSearch') { cancellations++; throw new Error('The debugger worker closed.'); }
    searches++;
    return page([match()], 'cursor');
  } }, 'test');
  try {
    const result = await new JoomlaSearchProvider(provider).textSearch({ ...query, maxResults: 1 });
    assert.equal(searches, 1);
    assert.equal(cancellations, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.limitHit, true);
    assert.deepEqual(result.messages, []);
  } finally { provider.dispose(); }
});
