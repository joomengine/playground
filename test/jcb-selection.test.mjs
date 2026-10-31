import test from 'node:test';
import assert from 'node:assert/strict';
import { initialJcbSelection, jcbSelectionInput, pinnedJcbPackages, recipeIncludesJcb } from '../src/jcb-selection.mjs';

const jcbEntry = {
  url: 'https://playground.example/assets/packages/derived.zip',
  sourceUrl: 'https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v6.2.0.zip',
  sha256: 'a'.repeat(64),
};
const jcbRecipe = { configuration: { extensions: [] }, variants: { 6: { extensions: [jcbEntry] } } };
const serviceRecipe = { configuration: { extensions: [] }, variants: { 6: { extensions: [{ url: 'https://playground.example/service.zip' }] } } };
const pinned = pinnedJcbPackages(jcbRecipe);

test('pinned selection identifies upstream JCB while retaining the staged package', () => {
  assert.equal(pinned.get('6').version, '6.2.0');
  assert.equal(pinned.get('6').package.url, jcbEntry.url);
  assert.equal(recipeIncludesJcb(jcbRecipe, '6', '6.2.0'), true);
  assert.equal(recipeIncludesJcb(serviceRecipe, '6', '6.2.0'), false);
});

test('existing saved deployments with no selector preserve their original setup', () => {
  for (const [deployId, deploy, version] of [['jcb', jcbRecipe, '6.2.0'], ['servicedirectory', serviceRecipe, 'none']]) {
    const selection = initialJcbSelection({ input: { deployId }, deploy, major: '6', pinned, isSaved: true });
    assert.deepEqual(selection, { version, omit: true });
    assert.deepEqual(jcbSelectionInput({ selection, deploy, major: '6', pinned }), {});
  }
});

test('new nonblank sites receive pinned JCB and blank sites start without it', () => {
  const selection = initialJcbSelection({ input: { deployId: 'servicedirectory' }, deploy: serviceRecipe, major: '6', pinned, isSaved: false });
  assert.deepEqual(jcbSelectionInput({ selection, deploy: serviceRecipe, major: '6', pinned }), {
    jcbVersion: '6.2.0', jcbPackage: { url: jcbEntry.url, sha256: jcbEntry.sha256 },
  });
  const blank = initialJcbSelection({ input: { deployId: 'blank' }, deploy: serviceRecipe, major: '6', pinned, isSaved: false });
  assert.deepEqual(jcbSelectionInput({ selection: blank, deploy: serviceRecipe, major: '6', pinned }), { jcbVersion: 'none' });
  assert.deepEqual(jcbSelectionInput({ selection: { version: '6.2.0', omit: false }, deploy: jcbRecipe, major: '6', pinned }), { jcbVersion: '6.2.0' });
});

test('Joomla 7 uses the requested JCB 6 testing fallback', () => {
  const selection = initialJcbSelection({ input: { deployId: 'servicedirectory' }, deploy: serviceRecipe, major: '7', pinned, isSaved: false });
  assert.equal(selection.version, '6.2.0');
  assert.equal(jcbSelectionInput({ selection, deploy: serviceRecipe, major: '7', pinned }).jcbPackage.url, jcbEntry.url);
});


test('a future pinned JCB 7 becomes the default for Joomla 7', () => {
  const nextPinned = new Map([...pinned, ['7', { version: '7.0.0', package: { url: '/jcb-7.zip', sha256: 'b'.repeat(64) } }]]);
  const selection = initialJcbSelection({ input: { deployId: 'servicedirectory' }, deploy: serviceRecipe, major: '7', pinned: nextPinned, isSaved: false });
  assert.equal(selection.version, '7.0.0');
  assert.equal(jcbSelectionInput({ selection, deploy: serviceRecipe, major: '7', pinned: nextPinned }).jcbPackage.url, '/jcb-7.zip');
});
