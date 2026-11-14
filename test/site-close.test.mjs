import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSiteResources } from '../src/site-close.mjs';

test('a final database write failure reports a closed site and releases its lock', async () => {
  const events = [], failure = new DOMException('', 'QuotaExceededError');
  const lastSavedAt = '2026-11-13T10:30:00.000Z';
  await assert.rejects(closeSiteResources({
    closePhp: async () => { events.push('php'); },
    closeDatabase: async () => { events.push('database'); throw failure; },
    release: async () => { events.push('release'); }, lastSavedAt,
  }), error => {
    assert.equal(error.closed, true);
    assert.equal(error.code, 'SITE_CLOSE_FAILED');
    assert.equal(error.cause, failure);
    assert.equal(error.lastSavedAt, lastSavedAt);
    assert.equal(error.erased, false);
    assert.match(error.message, /site is closed/);
    return true;
  });
  assert.deepEqual(events, ['php', 'database', 'release']);
});

test('PHP shutdown failure still closes the database and releases the site lock', async () => {
  const events = [];
  await assert.rejects(closeSiteResources({
    closePhp: async () => { events.push('php'); throw new Error('PHP shutdown failed'); },
    closeDatabase: async () => { events.push('database'); },
    release: async () => { events.push('release'); },
  }), { closed: true, lastSavedAt: null });
  assert.deepEqual(events, ['php', 'database', 'release']);
});

test('reset deletes a partial new site even when its final database write fails', async () => {
  const events = [];
  const result = await closeSiteResources({
    closePhp: async () => { events.push('php'); },
    closeDatabase: async () => { events.push('database'); throw new Error('Storage full'); },
    erase: async () => { events.push('erase'); },
    release: async () => { events.push('release'); },
  });
  assert.deepEqual(events, ['php', 'database', 'erase', 'release']);
  assert.deepEqual(result, { closed: true, erased: true, lastSavedAt: null });
});

test('failed deletion is not reported as a successful reset', async () => {
  let released = false;
  await assert.rejects(closeSiteResources({
    erase: async () => { throw new Error('Saved storage is still in use'); },
    release: async () => { released = true; },
  }), error => error.closed && !error.erased && /still in use/.test(error.message));
  assert.equal(released, true);
});

test('a release error cannot imply that already terminated workers are usable', async () => {
  await assert.rejects(closeSiteResources({ release: async () => { throw new Error('Lock release failed'); } }), {
    closed: true, code: 'SITE_CLOSE_FAILED',
  });
});
