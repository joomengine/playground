import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSavedState, rememberSite, renameSavedSite, rememberSiteRoute } from '../src/ui-state.mjs';

const site = { storageKey: 'good', persistence: true, siteName: 'Existing Joomla', extensions: [], startupCommands: [], initialPath: '/' };

test('one malformed legacy entry cannot erase unrelated saved-site management metadata', () => {
  const input = { schemaVersion: 1, active: 'good', sites: { good: site,
    malformed: { ...site, storageKey: 'malformed', extensions: [null] },
    other: { ...site, storageKey: 'other', siteName: 'Other Joomla' } } };
  const state = readSavedState({ getItem: () => JSON.stringify(input) });
  assert.ok(Object.hasOwn(state.sites, 'good'));
  assert.ok(Object.hasOwn(state.sites, 'other'));
  assert.equal(state.active, 'good');
  assert.equal(state.sites.good.storageKey, 'good');
});

test('saving a renamed site with a changed last route retains its independent identity metadata', () => {
  const state = readSavedState({ getItem: () => JSON.stringify({ schemaVersion: 1, active: 'good', sites: { good: site } }) });
  const renamed = renameSavedSite(state, 'good', 'My separate display name');
  const navigated = rememberSiteRoute(renamed, 'good', '/administrator/index.php?option=com_content&view=articles&token=secret');
  const saved = rememberSite(navigated, { ...site, phpVersion: '8.4' });
  assert.equal(saved.sites.good.siteName, 'Existing Joomla');
  assert.equal(saved.sites.good.displayName, 'My separate display name');
  assert.equal(saved.sites.good.lastPath, '/administrator/index.php?option=com_content&view=articles');
  assert.equal(saved.sites.good.storageKey, 'good');
});
