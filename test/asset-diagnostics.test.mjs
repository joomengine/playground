import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAssetDiagnostics } from './asset-diagnostics.mjs';

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
