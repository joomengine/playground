import assert from 'node:assert/strict';
import test from 'node:test';
import { administratorCaptureTargets } from '../src/deployment-capture.mjs';

const base = 'https://playground.example/site/';
function frame(path, { fields = {}, selected = [], action } = {}) {
  return { contentWindow: { location: { href: new URL(path, base).href } }, contentDocument: {
    querySelector(selector) {
      if (selector.startsWith('form#')) return action ? { getAttribute: () => action } : null;
      const name = /input\[name="(.+)"\]/.exec(selector)?.[1];
      return name && Object.hasOwn(fields, name) ? { value: fields[name] } : null;
    },
    querySelectorAll: () => selected.map(value => ({ value: String(value) })),
  } };
}

test('capture recognizes native plugin, module, component and JCB saved identities', () => {
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php?option=com_plugins&extension_id=42'), base), [{ kind: 'plugin', id: 42 }]);
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php?option=com_plugins', { fields: { 'jform[extension_id]': '42' } }), base), [{ kind: 'plugin', id: 42 }]);
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php?option=com_modules', { selected: [3, 4] }), base), [{ kind: 'module', id: 3 }, { kind: 'module', id: 4 }]);
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php?option=com_config&component=com_content'), base), [{ kind: 'component', component: 'com_content' }]);
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php?option=com_componentbuilder&view=repositories', { selected: [7] }), base), [{ kind: 'record', component: 'com_componentbuilder', view: 'repositories', id: 7 }]);
  assert.deepEqual(administratorCaptureTargets(frame('administrator/index.php', { action: '?option=com_content&task=article.edit&id=8' }), base), [{ kind: 'record', component: 'com_content', view: 'article', id: 8 }]);
});

test('capture ignores new records, frontend pages and other site frames', () => {
  for (const path of ['administrator/index.php?option=com_content&task=article.add&id=0', 'index.php?option=com_content&view=article&id=8', '/other/administrator/index.php?option=com_content&view=article&id=8', 'https://other.example/administrator/index.php?option=com_content&view=article&id=8']) {
    assert.deepEqual(administratorCaptureTargets(frame(path), base), []);
  }
  assert.deepEqual(administratorCaptureTargets(null, base), []);
});
