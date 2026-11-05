import assert from 'node:assert/strict';
import test from 'node:test';
import { assertJcbCompilerMessages, assertDemoDependencies } from './jcb-compiler-contract.mjs';

function completeProof() {
  return {
    phpEntries: 120,
    unresolved: [],
    actionsDefinitions: ['libraries/jcb_demo/Demo.Joomla/src/Demo/Utilities/Permitted/Actions.php'],
    powers: {
      power: ['7d95ce74-53dc-4672-bd8a-3b71cdacabea'],
      joomla_power: [
        'ca5456e1-552c-45fb-bf4c-b751ba6e9fa1',
        'a87c432d-b5b4-428e-b7ff-14b51664c624',
        '193deb3e-0c3e-4610-8e55-450e463095b4',
        '46ba6c12-361e-4f7d-b6d9-70450e7cd7c2',
        'a6ee04f5-33c7-4a9b-aa6d-6a03f3715a88',
        '47ee1f2b-9902-4f26-a856-04930ac9ddc3',
        'f5a65880-6185-4f43-8d55-770616692a40',
      ],
    },
  };
}

test('compiler receipt rejects the observed repository and missing Power errors even when a ZIP is offered', () => {
  for (const message of [
    'Super Power repository at /joomla/super-powers gave the following error!\nFailed to connect to tildegit.org: Failed to fetch',
    'Joomla Power repository at /joomla/joomla-powers gave the following error!\nInvalid response received from Gitea API.',
    'Power guid:7d95ce74-53dc-4672-bd8a-3b71cdacabea not found!',
    'Joomla Power guid:ca5456e1-552c-45fb-bf4c-b751ba6e9fa1 could not be found!',
  ]) {
    assert.throws(() => assertJcbCompilerMessages(`${message}\nDownload Component`), /failed repository reads or missing Powers/);
  }
});

test('compiler receipt permits informational global plugin notices', () => {
  assertJcbCompilerMessages('You do not have a global power plugin setup, so the powers plugin autoloader could not be added.\n'
    + 'You do not have a global privacy plugin setup, so the integration with Joomla privacy suite could not be build.\nDownload Component');
});

test('a compiled package requires all eight acquired dependencies', () => {
  assertDemoDependencies(completeProof());
  for (const [type, guids] of Object.entries(completeProof().powers)) {
    for (const missing of guids) {
      const proof = completeProof();
      proof.powers[type] = guids.filter(guid => guid !== missing);
      assert.throws(() => assertDemoDependencies(proof), /acquire every required/);
    }
  }
});

test('database imports alone cannot hide missing generated classes or unresolved PHP placeholders', () => {
  const missingClass = completeProof();
  missingClass.actionsDefinitions = [];
  assert.throws(() => assertDemoDependencies(missingClass), /include the required Permitted Actions class/);
  for (const prefix of ['Super', 'Joomla']) {
    const unresolved = completeProof();
    unresolved.unresolved = [{ file: 'admin/src/Helper/DemoHelper.php', placeholders: [`${prefix}___7d95ce74_53dc_4672_bd8a_3b71cdacabea___Power`] }];
    assert.throws(() => assertDemoDependencies(unresolved), /placeholder must be resolved/);
  }
});
