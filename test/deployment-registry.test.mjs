import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullDeploymentDocument } from '../src/config.mjs';
import { deploymentRegistryKey, readDeploymentRegistry, saveCustomDeployment, deleteCustomDeployment, customDeploymentName } from '../src/deployment-registry.mjs';

const key = deploymentRegistryKey('https://playground.test/');
function storage() {
  const values = new Map();
  return { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), values };
}
function document(name = 'Directory Custom') {
  return createFullDeploymentDocument({ deployId: 'blank', joomlaVersion: '6.2.0', phpVersion: '8.4',
    siteName: 'Directory', initialPath: '/', jcbVersion: 'none', extensions: [], startupCommands: [],
    admin: { name: 'Administrator', username: 'admin', email: 'admin@example.test', password: 'a-private-password' } },
  { name, requirements: { joomla: ['6'], jcb: 'optional' } });
}
test('saved recipes reload independently and only custom recipes can be updated or deleted', () => {
  const local = storage(), original = document();
  const saved = saveCustomDeployment(local, key, readDeploymentRegistry(local, key), original, { builtInNames: ['Directory'] });
  assert.match(saved.entry.id, /^custom-/);
  assert.deepEqual(saved.entry.document, original);
  const restored = readDeploymentRegistry(local, key);
  assert.equal(restored.deployments[0].document.configuration.admin.password, 'a-private-password');
  const renamed = saveCustomDeployment(local, key, restored, document('My directory'), { id: saved.entry.id });
  assert.equal(renamed.registry.deployments.length, 1);
  assert.equal(renamed.entry.id, saved.entry.id);
  assert.throws(() => deleteCustomDeployment(local, key, renamed.registry, 'blank'), /Only custom/);
  assert.equal(deleteCustomDeployment(local, key, renamed.registry, saved.entry.id).deployments.length, 0);
  assert.deepEqual(original, document());
});
test('storage failures preserve prior recipes and corrupt entries do not hide valid recipes', () => {
  const local = storage();
  const saved = saveCustomDeployment(local, key, readDeploymentRegistry(local, key), document());
  local.setItem(key, JSON.stringify({ ...saved.registry, deployments: [{ id: 'bad' }, ...saved.registry.deployments] }));
  assert.equal(readDeploymentRegistry(local, key).deployments.length, 1);
  const failing = { ...local, setItem() { throw new Error('Quota exceeded'); } };
  assert.throws(() => saveCustomDeployment(failing, key, saved.registry, document('Another')), /Quota/);
  assert.equal(saved.registry.deployments.length, 1);
  assert.throws(() => saveCustomDeployment(local, key, saved.registry, document()), /distinct name/);
  assert.throws(() => saveCustomDeployment(local, key, saved.registry, document('Directory'), { builtInNames: ['Directory'] }), /distinct name/);
  assert.equal(customDeploymentName('Directory', ['Directory Custom']), 'Directory Custom 2');
});
