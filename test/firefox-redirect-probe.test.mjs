import assert from 'node:assert/strict';
import test from 'node:test';
import { isSyntheticRedirectDiagnostic, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';

const sourceURL = 'https://playground.example.invalid/service-worker.mjs';
const requestURL = 'https://playground.example.invalid/__site/mail/administrator/index.php?task=joomla_component.edit&id=25';
const finalURL = 'https://playground.example.invalid/__site/mail/administrator/index.php?view=joomla_component&layout=edit&id=25';
const step = 'enable the native email helper option for Demo J5';
function diagnostic(overrides = {}) {
  return {
    message: `[JavaScript Error: "Failed to load ‘’. A ServiceWorker intercepted the request and encountered an unexpected error." {file: "${sourceURL}" line: 42}]`,
    url: sourceURL, step, ...overrides,
  };
}
function fixture({ errors = [diagnostic()], redirects = [{ url: requestURL, method: 'GET', status: 303, location: finalURL }] } = {}) {
  const page = {
    consoleErrors: errors, knownBrowserDiagnostics: [],
    evaluate: async (_evaluate, from) => redirects.slice(from),
  };
  const options = {
    probe: { cases: { get303: { reproduced: true, status: 303, redirects: 1, diagnostics: [diagnostic()] } } },
    kind: 'get303', from: 0, traceFrom: 0, sourceURL, step, requestURL, finalURL,
    responseStatus: 200, methodAfterRedirect: 'GET',
  };
  return { page, options };
}

test('redirect diagnostics require the exact Firefox message and service-worker source', () => {
  const record = diagnostic();
  assert.equal(isSyntheticRedirectDiagnostic(record, sourceURL), true);
  for (const changed of [
    { url: `${sourceURL}?other` },
    { message: record.message.replace(sourceURL, `${sourceURL}?other`) },
    { message: record.message + ' another error' },
    { message: record.message.replace('line: 42', 'line: unknown') },
    { message: 'A ServiceWorker intercepted the request and encountered an unexpected error.' },
  ]) assert.equal(isSyntheticRedirectDiagnostic(diagnostic(changed), sourceURL), false);
});

test('a reproduced GET 303 attributes only the exact diagnostic in this navigation and preserves its evidence', async () => {
  const before = diagnostic(), accepted = diagnostic();
  const unrelated = [diagnostic({ step: 'different step' }), diagnostic({ url: `${sourceURL}?different` }), diagnostic({ message: 'Unrelated application failure' })];
  const redirect = { url: requestURL, method: 'GET', status: 303, location: finalURL };
  const { page, options } = fixture({ errors: [before, accepted, ...unrelated], redirects: [{ url: 'ignored' }, redirect] });
  options.from = 1;
  options.traceFrom = 1;
  await recordVerifiedRedirectDiagnostic(page, options);
  assert.deepEqual(page.consoleErrors, [before, ...unrelated]);
  assert.equal(page.knownBrowserDiagnostics.length, 1);
  const recorded = page.knownBrowserDiagnostics[0];
  assert.equal(recorded.message, accepted.message);
  assert.equal(recorded.url, sourceURL);
  assert.equal(recorded.step, step);
  assert.deepEqual(recorded.redirects, [redirect]);
  assert.deepEqual(recorded.probe, options.probe.cases.get303);
});

test('GET 303 errors remain errors when the current browser did not reproduce that case', async () => {
  for (const probe of [null, { cases: { get303: { reproduced: false } } }, { cases: { post303: { reproduced: true, status: 303 } } }]) {
    const { page, options } = fixture();
    const errors = [...page.consoleErrors];
    options.probe = probe;
    page.evaluate = () => { throw new Error('Unproven diagnostics must not be classified.'); };
    await recordVerifiedRedirectDiagnostic(page, options);
    assert.deepEqual(page.consoleErrors, errors);
    assert.deepEqual(page.knownBrowserDiagnostics, []);
  }
});

test('GET 303 attribution requires a native GET 303 trace for every diagnostic', async () => {
  for (const redirects of [[], [{ url: requestURL, method: 'POST', status: 303, location: finalURL }], [{ url: requestURL, method: 'GET', status: 301, location: finalURL }]]) {
    const { page, options } = fixture({ redirects });
    await assert.rejects(recordVerifiedRedirectDiagnostic(page, options), /Every known browser diagnostic needs an observed native HTTP redirect/);
    assert.equal(page.consoleErrors.length, 1);
    assert.deepEqual(page.knownBrowserDiagnostics, []);
  }
  const { page, options } = fixture({ errors: [diagnostic(), diagnostic()] });
  await assert.rejects(recordVerifiedRedirectDiagnostic(page, options), /Every known browser diagnostic needs an observed native HTTP redirect/);
  assert.equal(page.consoleErrors.length, 2);
});

test('attribution rejects a different initial request, redirect target, origin, or site path', async () => {
  for (const changed of [
    { url: `${requestURL}&unrelated=1` },
    { location: `${finalURL}&unrelated=1` },
    { url: requestURL.replace('playground.example.invalid', 'other.example.invalid') },
    { location: 'https://playground.example.invalid/administrator/index.php' },
  ]) {
    const { page, options } = fixture({ redirects: [{ url: requestURL, method: 'GET', status: 303, location: finalURL, ...changed }] });
    await assert.rejects(recordVerifiedRedirectDiagnostic(page, options), { name: 'AssertionError' });
    assert.equal(page.consoleErrors.length, 1);
    assert.deepEqual(page.knownBrowserDiagnostics, []);
  }
});

test('attribution requires the final navigation to succeed with a 200 GET', async () => {
  for (const changed of [{ responseStatus: 500 }, { methodAfterRedirect: 'POST' }]) {
    const { page, options } = fixture();
    await assert.rejects(recordVerifiedRedirectDiagnostic(page, { ...options, ...changed }), { name: 'AssertionError' });
    assert.equal(page.consoleErrors.length, 1);
    assert.deepEqual(page.knownBrowserDiagnostics, []);
  }
});
