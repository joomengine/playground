import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNetworkApiProof, assertPowerClientProof, assertEntityImportProof,
  powerGuid, fieldGuid, textFieldtypeGuid,
} from './jcb-network-contract.mjs';

const apiBase = 'https://api.joomlacomponentbuilder.com/v1/network/';

function discoveryProof() {
  const targets = ['super-powers', 'joomla-powers', 'packages'].map(target => ({
    target, network: [{ status: 1, url: `https://codeberg.org/joomla/${target}` }],
  }));
  const documents = [
    ['', { systems: [{ projects: [{ project: 'jcb', targets }] }] }],
    ...targets.map(document => [`community/jcb/${document.target}`, document]),
  ];
  return ['curl', 'stream'].flatMap(transport => documents.map(([suffix, body]) => ({
    transport, url: apiBase + suffix, status: 200, body: JSON.stringify(body), error: '',
    ...(transport === 'curl' ? { errno: 0 } : {}),
  })));
}

function entityProof() {
  return {
    before: null, imported: true, count: 1,
    defaultProbe: { status: 403, found: false, after: null },
    selectedRepository: { base: 'https://tildegit.org', organisation: 'joomla', repository: 'packages', branch: 'master' },
    discovery: [{ status: 1, url: 'https://tildegit.org/joomla/packages' }],
    after: {
      guid: fieldGuid, name: 'Greeting', fieldtype: textFieldtypeGuid, datatype: 'VARCHAR', datalenght: '255',
      xmlAttributes: { name: 'greeting', label: 'Greeting', default: 'Some text', filter: 'STRING' },
    },
    repositories: [{ repository: 'packages', branch: 'master', entry: { guid: fieldGuid } }],
  };
}

test('live API proof requires every endpoint through both native PHP transports', () => {
  const proof = discoveryProof();
  assert.equal(assertNetworkApiProof(proof).length, 8);
  assert.throws(() => assertNetworkApiProof(proof.slice(1)));
  const duplicate = structuredClone(proof);
  duplicate[5] = duplicate[0];
  assert.throws(() => assertNetworkApiProof(duplicate), /exactly once/);
  for (const transport of ['curl', 'stream']) {
    for (const failure of [{ status: 0 }, { status: 503 }, { error: 'Failed to fetch' }, { body: false }]) {
      const broken = discoveryProof();
      Object.assign(broken.find(item => item.transport === transport), failure);
      assert.throws(() => assertNetworkApiProof(broken), `${transport} must reject ${JSON.stringify(failure)}.`);
    }
  }
  const curlError = discoveryProof();
  curlError[0].errno = 7;
  assert.throws(() => assertNetworkApiProof(curlError));
});

test('HTTP 200 cannot conceal an HTML challenge, invalid JSON or unusable discovery', () => {
  for (const body of ['<!doctype html><title>Verify you are human</title>', '', 'null', '{}', '[]']) {
    const proof = discoveryProof();
    proof[0].body = body;
    assert.throws(() => assertNetworkApiProof(proof), `The root API must reject ${JSON.stringify(body)}.`);
  }
  for (const data of [
    { target: 'unrelated', network: [{ status: 1, url: 'https://codeberg.org/joomla/super-powers' }] },
    { target: 'super-powers', network: [] },
    { target: 'super-powers', network: [{ url: 'https://codeberg.org/joomla/super-powers' }] },
    { target: 'super-powers', network: [{ status: 1, url: 'http://codeberg.org/joomla/super-powers' }] },
    { target: 'super-powers', network: [{ status: 1, url: 'https://user:secret@codeberg.org/joomla/super-powers' }] },
    { target: 'super-powers', network: [{ status: 1, url: 'https://codeberg.org/joomla/unrelated' }] },
  ]) {
    const proof = discoveryProof();
    proof[1].body = JSON.stringify(data);
    assert.throws(() => assertNetworkApiProof(proof));
  }
  const missingRootTarget = discoveryProof();
  const root = JSON.parse(missingRootTarget[0].body);
  root.systems[0].projects[0].targets.pop();
  missingRootTarget[0].body = JSON.stringify(root);
  assert.throws(() => assertNetworkApiProof(missingRootTarget));
});

test('Power proof requires actual source retrieval without preloading the compiler dependency', () => {
  const proof = { before: 0, after: 0, guid: powerGuid, name: 'Actions', sourceBytes: 800,
    hasGetMethod: true, sourceSha256: 'a'.repeat(64) };
  assertPowerClientProof(proof);
  for (const failure of [
    { before: 1 }, { after: 1 }, { guid: fieldGuid }, { name: 'Other' },
    { sourceBytes: 0 }, { hasGetMethod: false }, { sourceSha256: '' },
  ]) assert.throws(() => assertPowerClientProof({ ...proof, ...failure }));
});

test('a successful repository index or import return value cannot replace a stored entity', () => {
  assertEntityImportProof(entityProof());
  for (const failure of [
    { before: { guid: fieldGuid } }, { imported: false }, { count: 0 }, { count: 2 },
    { after: null }, { after: { guid: fieldGuid } }, { repositories: [] },
    { repositories: [{ repository: 'packages', branch: 'other', entry: { guid: fieldGuid } }] },
  ]) assert.throws(() => assertEntityImportProof({ ...entityProof(), ...failure }));
});

test('the imported entity must retain its identity, field type and XML settings', () => {
  for (const failure of [
    { guid: powerGuid }, { name: 'Other' }, { fieldtype: powerGuid }, { datatype: 'INT' }, { datalenght: '0' },
  ]) {
    const proof = entityProof();
    Object.assign(proof.after, failure);
    assert.throws(() => assertEntityImportProof(proof));
  }
  for (const name of ['name', 'label', 'default', 'filter']) {
    const proof = entityProof();
    delete proof.after.xmlAttributes[name];
    assert.throws(() => assertEntityImportProof(proof), `Missing field XML ${name} must fail.`);
  }
});

test('explicit entity repository selection retains default denial and requires live healthy discovery', () => {
  for (const failure of [
    { defaultProbe: { status: 403, found: true, after: null } },
    { defaultProbe: { status: 200, found: true, after: { guid: fieldGuid } } },
    { discovery: [] },
    { discovery: [{ status: 0, url: 'https://tildegit.org/joomla/packages' }] },
  ]) assert.throws(() => assertEntityImportProof({ ...entityProof(), ...failure }));
  // Upstream recovery is allowed; an HTTP 403 is not hardcoded forever.
  assertEntityImportProof({ ...entityProof(), defaultProbe: { status: 200, found: true, after: null } });
});
