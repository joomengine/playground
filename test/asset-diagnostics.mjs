const staticTypes = new Set(['image', 'script', 'stylesheet', 'font']);
const staticPath = /\.(?:css|m?js|svg|png|gif|jpe?g|webp|woff2?|ttf)$/i;
const chromeMissingResources = new Set([
  'Failed to load resource: the server responded with a status of 404 (Not Found)',
  'Failed to load resource: the server responded with a status of 404 ()',
]);

/** Preserve image diagnostics while treating every missing asset as a failure. */
export function classifyAssetDiagnostics(failedResponses, consoleErrors) {
  const missingImages = [];
  const unexpectedAssets = [];
  for (const response of failedResponses) {
    if (response.status < 400) continue;
    if (response.status === 404 && response.resourceType === 'image') {
      missingImages.push({ ...response, consoleErrors: consoleErrors.filter(diagnostic =>
        chromeMissingResources.has(diagnostic.message) && diagnostic.url === response.url) });
    }
    if (staticTypes.has(response.resourceType) || staticPath.test(new URL(response.url).pathname)) {
      unexpectedAssets.push(response);
    }
  }
  return { missingImages, unexpectedAssets, consoleErrors: [...consoleErrors] };
}
