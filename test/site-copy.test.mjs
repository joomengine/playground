import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUploadedSiteCopy } from '../src/site-copy.mjs';
import { deploymentConfigurationChanges } from '../src/deployment-changes.mjs';

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
  assert.deepEqual(copy.configuration.extensions, configuration.extensions, 'The restored baseline retains installed packages for runtime delta comparison.');
  assert.deepEqual(copy.configuration.startupCommands, configuration.startupCommands);
  assert.equal(copy.rotateAdministrator, false);
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

test('a copy preserves installed JCB when none is selected and still refuses changing Joomla', async () => {
  const configuration = original();
  const runtime = { configuration, checkpoint: async () => ({ configuration: structuredClone(configuration) }) };
  await assert.rejects(prepareUploadedSiteCopy({ input: { ...configuration, joomlaVersion: '5.4.2' }, sourceConfiguration: configuration,
    storageKey: 'copy', runtime }), /installed Joomla version/);
  const copy = await prepareUploadedSiteCopy({ input: { ...configuration, jcbVersion: 'none' }, sourceConfiguration: configuration,
    storageKey: 'copy', runtime });
  assert.equal(copy.configuration.jcbVersion, '6.1.3');
  assert.equal(copy.changes, undefined);
  assert.equal(configuration.jcbVersion, '6.1.3');
});


test('only deliberate administrator edits replace the account in the new copy', async () => {
  const configuration = original();
  const input = { ...configuration, admin: { username: 'copy-owner', password: 'New-copy-password!' } };
  const runtime = { configuration, checkpoint: async () => ({ configuration: structuredClone(configuration) }) };
  const unchanged = await prepareUploadedSiteCopy({ input, sourceConfiguration: configuration, runtime, storageKey: 'unchanged-copy' });
  assert.deepEqual(unchanged.configuration.admin, configuration.admin, 'Generated form placeholders must never reset a saved account.');
  assert.equal(unchanged.rotateAdministrator, false);
  const edited = await prepareUploadedSiteCopy({ input, sourceConfiguration: configuration, runtime, storageKey: 'edited-copy', administratorEdited: true });
  assert.equal(edited.rotateAdministrator, true);
  assert.deepEqual(edited.configuration.admin, input.admin);
  assert.equal(edited.changes, undefined, 'Changing the account does not replay package setup steps.');
  assert.deepEqual(edited.checkpoint.configuration.admin, configuration.admin, 'The source snapshot stays unchanged.');
  assert.equal(configuration.admin.username, 'owner');
});

test('a JCB upgrade copy retains source data and applies overlays without reinstalling the source package or startup commands', async () => {
  const oldPackage = { url: 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/6.1.3.zip' };
  const newPackage = { url: 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/6.2.0.zip' };
  const configuration = { ...original(), jcbPackage: oldPackage, extensions: [oldPackage], addonExtensions: [oldPackage],
    startupCommands: [['jcb:power', 'shared-guid']] };
  const before = structuredClone(configuration);
  const overlays = [{ key: 'repository', kind: 'record', component: 'com_componentbuilder', view: 'repository',
    guid: '10215abf-b850-48a5-8bb1-2d0ce6ea1f11', fields: { organisation: 'team' } }];
  const snapshot = { configuration: structuredClone(configuration), archive: new Uint8Array([1, 2]), filesystem: new Uint8Array([3, 4]) };
  const input = { ...configuration, jcbVersion: '6.2.0', jcbPackage: newPackage, overlays };
  const copy = await prepareUploadedSiteCopy({ input, sourceConfiguration: configuration, storageKey: 'upgraded-copy',
    runtime: { configuration, checkpoint: async () => snapshot } });
  assert.deepEqual(configuration, before, 'The source configuration stays unchanged.');
  assert.equal(copy.checkpoint, snapshot, 'The full source archive and filesystem are retained.');
  assert.deepEqual(copy.jcbUpgrade, { version: '6.2.0', package: newPackage });
  assert.deepEqual(copy.configuration.extensions, [newPackage]);
  assert.deepEqual(copy.changes.extensions, [newPackage]);
  assert.deepEqual(copy.changes.addonExtensions, []);
  const delta = deploymentConfigurationChanges({ ...copy.configuration, languages: [], overlays: [] }, { ...copy.changes, languages: [] }).configuration;
  assert.deepEqual(delta.extensions, [], 'JCB was updated before applying edited configuration.');
  assert.deepEqual(delta.startupCommands, [], 'Previously executed startup commands must not run again.');
  assert.deepEqual(delta.overlays, overlays);
  assert.deepEqual(copy.configuration.deploymentRecipe.configuration.startupCommands, configuration.startupCommands);
  assert.deepEqual(copy.changes.deploymentRecipe.configuration.extensions, [newPackage]);
});

test('an unchanged stale selection uses the checkpoint installed version without retaining its old download', async () => {
  const stale = { ...original(), jcbPackage: { url: 'https://example.test/jcb-old.zip' } };
  const actual = { ...original(), jcbVersion: '6.2.0' };
  const copy = await prepareUploadedSiteCopy({ input: stale, sourceConfiguration: stale, storageKey: 'actual-copy',
    runtime: { configuration: stale, checkpoint: async () => ({ configuration: actual }) } });
  assert.equal(copy.configuration.jcbVersion, '6.2.0');
  assert.equal(copy.configuration.jcbPackage, undefined);
  assert.equal(copy.jcbUpgrade.version, '6.2.0');
  assert.equal(copy.jcbUpgrade.package, undefined, 'A no-op comparison must not associate the previous archive with the installed version.');
  assert.equal(stale.jcbVersion, '6.1.3');
});
