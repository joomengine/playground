import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { aiConnectionIdentity, createAiCatalogLoader } from '../src/code/ai-connection-settings.mjs';

const local = { provider: { id: 'other', fields: [] }, baseURL: 'http://localhost:1234/v1', protocol: 'openai', model: 'local-coder' };
test('connection identities isolate endpoints, protocols and account routing without including keys or model choice', () => {
  const identity = vm.runInNewContext(`(${aiConnectionIdentity.toString()})`, { URL });
  const key = identity(local);
  assert.notEqual(identity({ ...local, protocol: 'anthropic' }), key);
  assert.notEqual(identity({ ...local, baseURL: 'http://localhost:11434/v1' }), key);
  assert.equal(identity({ ...local, baseURL: 'http://localhost:1234/v1/', apiKey: 'private-key', model: 'second-model' }), key);
  assert.equal(key.includes('private-key'), false);
  const azure = { provider: { id: 'azure', protocol: 'openai', fields: [{ id: 'resource' }] }, resource: 'one' };
  assert.notEqual(identity(azure), identity({ ...azure, resource: 'two' }));
});

test('catalog cancellation aborts and disposes the previous client and ignores stale failures', async () => {
  const requests = [], loading = [], errors = [];
  const createProvider = () => {
    const request = { disposed: 0 }; requests.push(request);
    return { listModels({ signal }) { request.signal = signal; return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; }); },
      dispose() { request.disposed++; } };
  };
  const loader = createAiCatalogLoader({ createProvider, onLoading: value => loading.push(value), onError: error => errors.push(error.message) });
  const first = loader.load(local);
  const second = loader.load({ ...local, baseURL: 'http://localhost:11434/v1' });
  assert.equal(requests[0].signal.aborted, true); assert.ok(requests[0].disposed >= 1);
  requests[0].reject(new Error('stale authentication error'));
  assert.equal(await first, null);
  assert.deepEqual(errors, []); assert.equal(loading.at(-1), true, 'old finally must not enable controls while new catalog is loading');
  requests[1].resolve({ models: [{ id: 'new-model' }] });
  assert.equal((await second).models[0].id, 'new-model'); assert.equal(loading.at(-1), false);
  const third = loader.load(local); loader.cancel();
  requests[2].resolve({ models: [{ id: 'obsolete-model' }] });
  assert.equal(await third, null); assert.equal(requests[2].signal.aborted, true);
});

test('AWS discovery credentials never enter public connection identity', () => {
  const settings = { provider: { id: 'bedrock', protocol: 'openai', fields: [
    { id: 'region' }, { id: 'route' }, { id: 'accessKeyId', credential: true },
    { id: 'secretAccessKey', credential: true, secret: true }, { id: 'sessionToken', credential: true, secret: true },
  ] }, region: 'us-east-1', route: 'runtime', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'aws-secret', sessionToken: 'temporary-session' };
  const identity = aiConnectionIdentity(settings);
  assert.equal(identity.includes('AKIAEXAMPLE'), false);
  assert.equal(identity.includes('aws-secret'), false);
  assert.equal(identity.includes('temporary-session'), false);
  assert.equal(identity, aiConnectionIdentity({ ...settings, accessKeyId: 'OTHER', secretAccessKey: 'changed', sessionToken: '' }));
  assert.notEqual(identity, aiConnectionIdentity({ ...settings, region: 'eu-west-1' }));
  assert.notEqual(identity, aiConnectionIdentity({ ...settings, route: 'mantle' }));
});
