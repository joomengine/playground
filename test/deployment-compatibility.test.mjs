import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentRequiresJcb, deploymentSupportsJoomla, deploymentPhpVersions, selectDeploymentRuntime } from '../src/deployment-compatibility.mjs';

const catalog = { defaults: { joomlaVersion: '6.2.0', phpVersion: '8.4' }, joomla: [
  { version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.3', '8.4', '8.5'] },
  { version: '7.0.0-alpha1', php: ['8.4', '8.5'] },
] };

test('a selected preset remains selected while its incompatible runtime is replaced', () => {
  const mcp = { title: 'JCB + MCP', joomla: ['6'], requirements: { jcb: 'required', php: ['8.4'] } };
  assert.deepEqual(selectDeploymentRuntime(mcp, catalog, { joomlaVersion: '5.4.10', phpVersion: '8.3' }), { joomlaVersion: '6.2.0', phpVersion: '8.4' });
  assert.deepEqual(deploymentPhpVersions(mcp, catalog.joomla[1]), ['8.4']);
  assert.equal(deploymentSupportsJoomla(mcp, '7.0.0-alpha1'), false);
});

test('Joomla 7 inheritance requires an explicit recipe declaration', () => {
  const ordinary = { joomla: ['5', '6'] };
  const jcb = { ...ordinary, requirements: { jcb: 'required', joomlaFallbacks: { 7: '6' } } };
  assert.equal(deploymentSupportsJoomla(ordinary, '7.0.0-alpha1'), false);
  assert.equal(deploymentSupportsJoomla(jcb, '7.0.0-alpha1'), true);
  assert.deepEqual(selectDeploymentRuntime(jcb, catalog, { joomlaVersion: '7.0.0-alpha1', phpVersion: '8.5' }), { joomlaVersion: '7.0.0-alpha1', phpVersion: '8.5' });
});

test('a custom JCB opening page requires JCB even without a preset identity', () => {
  assert.equal(deploymentRequiresJcb({ configuration: { initialPath: '/administrator/index.php?option=com_componentbuilder' } }), true);
  assert.equal(deploymentRequiresJcb({ configuration: { initialPath: '/' }, requirements: { jcb: 'optional' } }), false);
});
