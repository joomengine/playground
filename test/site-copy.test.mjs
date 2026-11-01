import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUploadedSiteCopy } from '../src/site-copy.mjs';

const original = () => ({ storageKey: 'uploaded-source', persistence: true, fresh: false,
  restoredSite: { joomlaVersion: '6.2.0', php: ['8.4', '8.5'] }, joomlaVersion: '6.2.0', jcbVersion: '6.1.3', phpVersion: '8.4',
  siteName: 'Existing site', initialPath: '/administrator/', admin: { username: 'owner', password: 'Unchanged-password!' },
  extensions: [{ url: 'https://retired.example/component.zip' }], startupCommands: [], menus: [] });

test('copying an open uploaded site captures its data and applies only changed settings to a new identity', async () => {
  const configuration = original();
  const checkpoint = { configuration: structuredClone(configuration), archive: new Uint8Array([1]), filesystem: new Uint8Array([2]) };
  let captured = 0;
  const runtime = { configuration, checkpoint: async () => { captured++; return checkpoint; }, close: () => assert.fail('Must leave the source open until launch switches sites.') };
  const copy = await prepareUploadedSiteCopy({ input: { ...configuration, siteName: 'Independent copy' }, sourceConfiguration: configuration,
    storageKey: 'new-independent-key', runtime, open: () => assert.fail('Already running source must be reused.') });
  assert.equal(captured, 1);
  assert.equal(copy.checkpoint, checkpoint);
  assert.equal(copy.configuration.storageKey, 'new-independent-key');
  assert.equal(copy.configuration.siteName, 'Existing site', 'Restore the actual base before applying the edited name.');
  assert.equal(copy.changes.siteName, 'Independent copy');
  assert.equal(copy.changes.storageKey, 'new-independent-key');
  assert.deepEqual(copy.configuration.admin, configuration.admin);
  copy.configuration.admin.password = 'Only-the-copy-changes';
  assert.equal(configuration.admin.password, 'Unchanged-password!');
  assert.equal(checkpoint.configuration.storageKey, 'uploaded-source');
});

test('a closed uploaded source is opened, captured and closed without modifying another running site', async () => {
  const configuration = original(), events = [];
  const copy = await prepareUploadedSiteCopy({ input: { ...configuration, phpVersion: '8.5' }, sourceConfiguration: configuration,
    storageKey: 'copy', runtime: { configuration: { storageKey: 'unrelated', persistence: true }, close: () => assert.fail('Unrelated site must stay open.') },
    open: async value => {
      assert.equal(value, configuration); events.push('open');
      return { checkpoint: async () => { events.push('checkpoint'); return { configuration: structuredClone(configuration) }; },
        close: async () => { events.push('close'); } };
    } });
  assert.deepEqual(events, ['open', 'checkpoint', 'close']);
  assert.equal(copy.configuration.phpVersion, '8.5');
  assert.equal(copy.changes, undefined, 'Unchanged installed setup must not reinstall packages or overwrite manually edited database records.');
});

test('checkpoint failure closes an internally opened source and leaves its identity unchanged', async () => {
  const configuration = original();
  let closed = false;
  await assert.rejects(prepareUploadedSiteCopy({ input: configuration, sourceConfiguration: configuration, storageKey: 'copy',
    open: async () => ({ checkpoint: async () => { throw new Error('Checkpoint failed'); }, close: async () => { closed = true; } }) }), /Checkpoint failed/);
  assert.equal(closed, true);
  assert.equal(configuration.storageKey, 'uploaded-source');
});

test('copying does not relabel installed Joomla or JCB as a different version', async () => {
  const configuration = original();
  for (const changed of [{ joomlaVersion: '5.4.2' }, { jcbVersion: 'none' }]) {
    await assert.rejects(prepareUploadedSiteCopy({ input: { ...configuration, ...changed }, sourceConfiguration: configuration,
      storageKey: 'copy', runtime: { configuration, checkpoint: async () => ({ configuration }) } }), /installed Joomla or JCB/);
  }
});
