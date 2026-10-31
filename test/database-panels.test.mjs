import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolPanelGroup } from '../src/code/tool-panels.mjs';
import { captureDatabaseView, restoreDatabaseView, hasDatabaseDraft } from '../src/database/view-state.mjs';

test('only one embedded tool owns the site grid; hidden tool events cannot reclaim it', () => {
  const group = createToolPanelGroup();
  let code = { visible: true, detached: false }, database = { visible: false, detached: false };
  group.register('code', () => { code.visible = false; group.update('code', code); });
  group.register('database', () => { database.visible = false; group.update('database', database); });
  group.update('code', code);
  database.visible = true; group.update('database', database);
  assert.equal(code.visible, false);
  assert.equal(group.active, 'database');
  group.update('code', code);
  assert.equal(group.active, 'database');
  code.visible = true; group.update('code', code);
  assert.equal(database.visible, false);
  assert.equal(group.active, 'code');
});

test('detached tools coexist and redocking atomically hides the embedded sibling', () => {
  const group = createToolPanelGroup();
  const code = { visible: true, detached: true }, database = { visible: true, detached: false };
  group.register('code', () => { code.visible = false; group.update('code', code); });
  group.register('database', () => { database.visible = false; group.update('database', database); });
  group.update('code', code); group.update('database', database);
  assert.equal(code.visible, true); assert.equal(database.visible, true); assert.equal(group.active, 'database');
  code.detached = false; group.update('code', code);
  assert.equal(database.visible, false); assert.equal(group.active, 'code');
  group.remove('database'); assert.equal(group.active, 'code');
  group.remove('code'); assert.equal(group.active, undefined); assert.equal(group.size, 0);
});

const field = (name, value, type = 'text') => ({ tagName: 'INPUT', name, value, defaultValue: value, type, disabled: false });
const document = elements => ({ forms: [{ elements }], defaultView: { scrollX: 0, scrollY: 20, scrollTo() {} } });
test('detachment transfers editable drafts without credentials, tokens, or form submission', () => {
  const source = document([field('query', 'SELECT 1'), field('password', 'private', 'password'), field('token', 'secret', 'hidden')]);
  source.forms[0].elements[0].value = 'UPDATE example SET value = 2';
  assert.equal(hasDatabaseDraft(source), true);
  const snapshot = captureDatabaseView(source, 'https://example.test/__adminer/?sql=');
  assert.deepEqual(snapshot.forms[0].fields.map(item => item.name), ['query']);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  const target = document([field('query', ''), field('password', 'new-private', 'password'), field('token', 'new-token', 'hidden')]);
  restoreDatabaseView(target, snapshot);
  assert.equal(target.forms[0].elements[0].value, 'UPDATE example SET value = 2');
  assert.equal(target.forms[0].elements[1].value, 'new-private');
  assert.equal(target.forms[0].elements[2].value, 'new-token');
});

test('SQL draft follows its stable form and field names when POST result forms disappear', () => {
  const source = document([field('format', 'csv')]);
  source.forms.push({ id: 'form', elements: [field('token', 'old', 'hidden'), field('query', 'INSERT INTO example VALUES (99)')] });
  const target = document([field('query', ''), field('token', 'new', 'hidden')]);
  target.forms[0].id = 'form';
  restoreDatabaseView(target, captureDatabaseView(source, 'https://example.test/__adminer/?sql='));
  assert.equal(target.forms[0].elements[0].value, 'INSERT INTO example VALUES (99)');
  assert.equal(target.forms[0].elements[1].value, 'new');
});

test('selected import files and oversized drafts stop a lossy window transfer', () => {
  const upload = field('import', '', 'file'); upload.files = [{}];
  const doc = document([upload]);
  assert.equal(hasDatabaseDraft(doc), true);
  assert.throws(() => captureDatabaseView(doc, 'https://example.test/__adminer/'), /import file/);
  assert.throws(() => captureDatabaseView(document([field('query', 'x'.repeat(1024 * 1024))]), 'https://example.test/__adminer/'), /too large/);
});
