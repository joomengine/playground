const staticTypes = new Set(['image', 'script', 'stylesheet', 'font']);
const staticPath = /\.(?:css|m?js|svg|png|gif|jpe?g|webp|woff2?|ttf)$/i;
const chromeMissingResources = new Set([
  'Failed to load resource: the server responded with a status of 404 (Not Found)',
  'Failed to load resource: the server responded with a status of 404 ()',
]);

/** Report missing content images separately without hiding runtime asset failures. */
export function classifyAssetDiagnostics(failedResponses, consoleErrors) {
  const missingImages = [];
  const unexpectedAssets = [];
  for (const response of failedResponses) {
    if (response.status < 400) continue;
    if (response.status === 404 && response.resourceType === 'image') {
      missingImages.push({ ...response, consoleErrors: [] });
    } else if (staticTypes.has(response.resourceType) || staticPath.test(new URL(response.url).pathname)) {
      unexpectedAssets.push(response);
    }
  }
  const ambiguousURLs = new Set(unexpectedAssets.map(response => response.url));
  const remaining = [];
  for (const diagnostic of consoleErrors) {
    const image = chromeMissingResources.has(diagnostic.message) && !ambiguousURLs.has(diagnostic.url)
      ? missingImages.find(response => response.url === diagnostic.url) : undefined;
    if (image) image.consoleErrors.push(diagnostic);
    else remaining.push(diagnostic);
  }
  return { missingImages, unexpectedAssets, consoleErrors: remaining };
}
