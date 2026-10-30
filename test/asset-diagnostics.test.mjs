import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAssetDiagnostics, classifyNavigationAbortDiagnostics } from './asset-diagnostics.mjs';

const url = 'https://site.test/image';
const message = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

test('a missing image retains its diagnostic and fails the asset and console gates', () => {
  const response = Object.freeze({ url, status: 404, resourceType: 'image', step: 'dashboard' });
  const diagnostic = Object.freeze({ url, message, step: 'dashboard' });
  const result = classifyAssetDiagnostics(Object.freeze([response]), Object.freeze([diagnostic]));
  assert.deepEqual(result, {
    missingImages: [{ ...response, consoleErrors: [diagnostic] }], unexpectedAssets: [response], consoleErrors: [diagnostic],
  });
  assert.equal(response.consoleErrors, undefined, 'The original HTTP evidence must remain unchanged.');
  const serviceWorkerDiagnostic = { url, message: 'Failed to load resource: the server responded with a status of 404 ()' };
  assert.deepEqual(classifyAssetDiagnostics([response], [serviceWorkerDiagnostic]).missingImages[0].consoleErrors, [serviceWorkerDiagnostic]);
});

test('server errors and missing executable resources remain failures', () => {
  const responses = [
    { url: `${url}.png`, status: 500, resourceType: 'image' },
    ...['script', 'stylesheet', 'font'].map(resourceType => ({ url: `${url}/${resourceType}`, status: 404, resourceType })),
    { url: `${url}.svg`, status: 404, resourceType: 'fetch' },
    { url: `${url}.jpg`, status: 404 },
  ];
  const result = classifyAssetDiagnostics([...responses, { url, status: 200, resourceType: 'image' }], []);
  assert.deepEqual(result.unexpectedAssets, responses);
  assert.deepEqual(result.missingImages, []);
});

test('unrelated URLs, other messages and ambiguous resource failures stay in the console gate', () => {
  const diagnostics = [
    { url: `${url}?different=1`, message },
    { url, message: 'TypeError: image initialization failed' },
    { url, message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' },
    { url, message: `Unexpected: ${message}` },
  ];
  const missing = { url, status: 404, resourceType: 'image' };
  assert.deepEqual(classifyAssetDiagnostics([missing], diagnostics).consoleErrors, diagnostics);
  const diagnostic = { url, message };
  const ambiguous = classifyAssetDiagnostics([missing, { url, status: 404, resourceType: 'script' }], [diagnostic]);
  assert.deepEqual(ambiguous.consoleErrors, [diagnostic]);
  assert.equal(ambiguous.unexpectedAssets.length, 2);
});

const compiler = 'https://site.test/playground/__site/instance/session/administrator/components/com_componentbuilder/assets/js/compiler.js?003273';
const documentURL = 'https://site.test/playground/__site/instance/session/administrator/index.php?option=com_componentbuilder&view=compiler';
const feedError = Object.freeze({ url: compiler, message: 'Error loading Mastodon feed: JSHandle@object', step: 'compile Demo J5', time: 1050 });
const feedRequest = Object.freeze({ url: 'https://joomla.social/api/v1/accounts/112766899254600077/statuses?limit=5',
  method: 'GET', type: 'fetch', error: 'NS_BINDING_ABORTED', step: 'compile Demo J5', time: 1000,
  frameId: 2, documentId: 3, documentURL });
const navigation = Object.freeze({ frameId: 2, documentId: 3, fromURL: documentURL,
  toURL: documentURL, kind: 'navigation', started: 950, committed: 5000 });

test('only a matching optional feed cancellation during a committed navigation becomes a retained receipt', () => {
  const result = classifyNavigationAbortDiagnostics([feedError], [feedRequest], [navigation]);
  assert.deepEqual(result.consoleErrors, []);
  assert.equal(result.navigationAborts.length, 1);
  assert.deepEqual(result.navigationAborts[0].request, feedRequest);
  assert.equal(feedError.request, undefined, 'The original console and request evidence remains intact.');
  assert.equal(classifyNavigationAbortDiagnostics([feedError], [feedRequest], [
    { ...navigation, kind: 'detach', started: 1000, committed: 1000 },
  ]).navigationAborts.length, 1);
});

test('HTTP failures, unrelated sources and unverified navigation aborts remain console failures', () => {
  for (const [diagnostic, request, transition] of [
    [{ ...feedError, message: 'Error loading Mastodon feed: TypeError: Failed to fetch' }, feedRequest, navigation],
    [{ ...feedError, url: compiler.replace('compiler.js', 'dashboard.js') }, feedRequest, navigation],
    [{ ...feedError, url: compiler.replace('/session/', '/another-session/') }, feedRequest, navigation],
    [{ ...feedError, time: 2501 }, feedRequest, navigation],
    [feedError, { ...feedRequest, url: feedRequest.url.replace('limit=5', 'limit=50') }, navigation],
    [feedError, { ...feedRequest, method: 'POST' }, navigation],
    [feedError, { ...feedRequest, type: 'xhr' }, navigation],
    [feedError, { ...feedRequest, error: 'NS_ERROR_DOM_BAD_URI' }, navigation],
    [feedError, { ...feedRequest, status: 500 }, navigation],
    [feedError, { ...feedRequest, step: 'unrelated action' }, navigation],
    [feedError, { ...feedRequest, documentURL: documentURL.replace('site.test', 'elsewhere.test') }, navigation],
    [feedError, { ...feedRequest, frameId: undefined }, navigation],
    [feedError, { ...feedRequest, documentId: 4 }, navigation],
    [feedError, { ...feedRequest, time: undefined }, navigation],
    [feedError, feedRequest, { ...navigation, committed: undefined }],
    [feedError, feedRequest, { ...navigation, kind: 'unverified' }],
    [feedError, feedRequest, { ...navigation, fromURL: `${documentURL}&changed=1` }],
    [feedError, feedRequest, { ...navigation, started: 2501, committed: 5000 }],
  ]) {
    const result = classifyNavigationAbortDiagnostics([diagnostic], [request], [transition]);
    assert.deepEqual(result.consoleErrors, [diagnostic]);
    assert.deepEqual(result.navigationAborts, []);
  }
  assert.deepEqual(classifyNavigationAbortDiagnostics([feedError], [], [navigation]).consoleErrors, [feedError]);
  assert.deepEqual(classifyNavigationAbortDiagnostics([feedError], [feedRequest], []).consoleErrors, [feedError]);
});

test('a verified canceled request accounts for exactly one matching console diagnostic', () => {
  const otherError = { ...feedError, message: 'Unrelated compiler failure' };
  const result = classifyNavigationAbortDiagnostics([feedError, feedError, otherError], [feedRequest], [navigation]);
  assert.equal(result.navigationAborts.length, 1);
  assert.deepEqual(result.consoleErrors, [feedError, otherError]);
  const two = classifyNavigationAbortDiagnostics([feedError, feedError], [feedRequest,
    { ...feedRequest, url: feedRequest.url.replace('limit=5', 'limit=7') }], [navigation]);
  assert.equal(two.navigationAborts.length, 2);
  assert.deepEqual(two.consoleErrors, []);
});
