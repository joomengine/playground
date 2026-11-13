import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetSite, publicConfiguration, readSavedState, rememberSavedSite, rememberSite,
  rememberSiteRoute, renameSavedSite, savedSiteImages } from '../src/ui-state.mjs';

const config = { storageKey: 'jcb-work', persistence: true, siteName: 'Component work',
  deployId: 'jcb', joomlaVersion: '6.2.0', jcbVersion: '6.2.0', phpVersion: '8.4',
  extensions: [], startupCommands: [], initialPath: '/administrator/',
  admin: { username: 'admin', password: 'private-password' } };
const firstSave = '2026-11-13T20:00:00.000Z';
const nextSave = '2026-11-13T20:05:00.000Z';
const empty = () => readSavedState({ getItem: () => null }, 'test');
const roundTrip = state => readSavedState({ getItem: () => JSON.stringify(state) }, 'test');

test('launch metadata does not create a Local images entry before a completed save', () => {
  const pending = rememberSite(empty(), config);
  assert.deepEqual(savedSiteImages(pending), []);
  assert.deepEqual(savedSiteImages(roundTrip(pending)), []);
  assert.deepEqual(Object.keys(pending.sites), []);
  assert.equal(pending.active, null);
  assert.throws(() => rememberSavedSite(pending, config), /save time/);
  assert.deepEqual(savedSiteImages(pending), []);

  const saved = rememberSavedSite(pending, config, firstSave);
  assert.deepEqual(savedSiteImages(saved), [{
    key: 'site:jcb-work', kind: 'site', storageKey: config.storageKey, title: config.siteName,
    joomlaVersion: '6.2.0', jcbVersion: '6.2.0', phpVersion: '8.4',
    lastSavedAt: firstSave, legacy: false,
  }]);
  assert.deepEqual(savedSiteImages(roundTrip(saved)), savedSiteImages(saved));
  assert.deepEqual(Object.keys(pending.sites), [], 'Completion must not mutate earlier launch metadata.');
  const unconfirmed = roundTrip({ schemaVersion: 3, active: config.storageKey,
    sites: { [config.storageKey]: { ...config, lastSavedAt: null, legacySaved: false } } });
  assert.deepEqual(Object.keys(unconfirmed.sites), []);
  assert.equal(unconfirmed.active, null, 'A failed first save cannot resume from launch metadata.');
});

test('repeated saves update one native identity and retain rename and safe route metadata', () => {
  const saved = rememberSavedSite(empty(), config, firstSave);
  const renamed = renameSavedSite(saved, config.storageKey, 'My JCB build');
  const navigated = rememberSiteRoute(renamed, config.storageKey, '/administrator/index.php?option=com_componentbuilder&view=fields&token=private');
  const metadataOnly = rememberSite(navigated, { ...config, jcbVersion: '6.2.1' });
  assert.equal(metadataOnly.sites[config.storageKey].lastSavedAt, firstSave);
  assert.equal(metadataOnly.sites[config.storageKey].jcbVersion, config.jcbVersion,
    'An unsaved runtime change cannot replace the last saved configuration.');
  const updated = rememberSavedSite(metadataOnly, { ...config, jcbVersion: '6.2.1', phpVersion: '8.5' }, new Date(nextSave));
  const images = savedSiteImages(roundTrip(updated));
  assert.equal(images.length, 1);
  assert.equal(images[0].storageKey, config.storageKey);
  assert.equal(images[0].title, 'My JCB build');
  assert.equal(images[0].jcbVersion, '6.2.1');
  assert.equal(images[0].phpVersion, '8.5');
  assert.equal(images[0].lastSavedAt, nextSave);
  assert.equal(updated.sites[config.storageKey].lastPath, '/administrator/index.php?option=com_componentbuilder&view=fields');
  assert.equal(updated.active, config.storageKey);
  assert.doesNotMatch(JSON.stringify(images), /private-password|administrator|extensions|startupCommands/);
  assert.deepEqual(savedSiteImages(forgetSite(updated, config.storageKey)), []);
});

test('legacy saved sites remain reopenable without inventing a completed-save timestamp', () => {
  for (const schemaVersion of [1, 2]) {
    const legacy = readSavedState({ getItem: () => JSON.stringify({ schemaVersion, active: config.storageKey,
      sites: { [config.storageKey]: config } }) });
    assert.equal(legacy.schemaVersion, 3);
    assert.equal(legacy.active, config.storageKey);
    const [image] = savedSiteImages(legacy);
    assert.equal(image.storageKey, config.storageKey);
    assert.equal(image.lastSavedAt, null);
    assert.equal(image.legacy, true);
    assert.deepEqual(savedSiteImages(roundTrip(rememberSite(legacy, config))), [image]);
    const completed = rememberSavedSite(legacy, config, firstSave);
    assert.equal(savedSiteImages(completed)[0].legacy, false);
    assert.equal(completed.sites[config.storageKey].legacySaved, false);
  }
});

test('temporary sites never register native Local images and save metadata stays out of deployment recipes', () => {
  const state = empty();
  assert.equal(rememberSavedSite(state, { ...config, persistence: false }, firstSave), state);
  assert.deepEqual(savedSiteImages(state), []);
  const saved = rememberSavedSite(state, config, firstSave);
  const publicConfig = publicConfiguration(saved.sites[config.storageKey]);
  assert.equal(Object.hasOwn(publicConfig, 'lastSavedAt'), false);
  assert.equal(Object.hasOwn(publicConfig, 'legacySaved'), false);
  assert.equal(Object.hasOwn(publicConfig, 'admin'), false);
});
