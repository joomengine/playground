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

const mastodonFeeds = new Set([5, 7].map(limit =>
  `https://joomla.social/api/v1/accounts/112766899254600077/statuses?limit=${limit}`));
const compilerPath = /^(.*\/__site\/[^/]+\/[^/]+\/)administrator\/components\/com_componentbuilder\/assets\/js\/compiler\.js$/;
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1000;

/**
 * The pinned JCB 5.2.0/6.2.0 compiler.js (SHA256
 * f07bf1c4ffbe79826999ebbbb60bdb0c75ab6a4b8b17dc122bfd1306a89fdc8b)
 * logs every loadFeed() rejection at line 82, including Firefox canceling its
 * optional feed fetch when the compiler form navigates away. Keep those exact
 * diagnostics as receipts only when a real navigation/detach and failed request
 * establish cancellation of the same document. All other errors still fail.
 */
export function classifyNavigationAbortDiagnostics(consoleErrors, failedRequests, navigations) {
  const remaining = [...failedRequests], navigationAborts = [], unexpected = [];
  for (const diagnostic of consoleErrors) {
    let source, siteRoot, matchedNavigation;
    try { source = new URL(diagnostic.url); siteRoot = source.pathname.match(compilerPath)?.[1]; } catch { /* Unknown source remains an error. */ }
    if (diagnostic.message !== 'Error loading Mastodon feed: JSHandle@object' || !siteRoot) { unexpected.push(diagnostic); continue; }
    const index = remaining.findIndex(request => {
      if (!mastodonFeeds.has(request.url) || request.method !== 'GET' || request.type !== 'fetch'
        || request.error !== 'NS_BINDING_ABORTED' || request.status >= 400 || request.step !== diagnostic.step
        || !near(request.time, diagnostic.time) || !Number.isInteger(request.frameId) || !Number.isInteger(request.documentId)) return false;
      let document;
      try { document = new URL(request.documentURL); } catch { return false; }
      if (document.origin !== source.origin || !document.pathname.startsWith(siteRoot)) return false;
      matchedNavigation = navigations.find(navigation => navigation.frameId === request.frameId && navigation.documentId === request.documentId
        && navigation.fromURL === request.documentURL && Number.isFinite(navigation.committed)
        && ['navigation', 'detach'].includes(navigation.kind)
        && (near(request.time, navigation.started) || near(request.time, navigation.committed)));
      return Boolean(matchedNavigation);
    });
    if (index < 0) unexpected.push(diagnostic);
    else navigationAborts.push({ ...diagnostic, request: remaining.splice(index, 1)[0], navigation: matchedNavigation,
      reason: 'Pinned JCB optional feed fetch canceled by verified frame navigation or removal.' });
  }
  return { consoleErrors: unexpected, navigationAborts };
}
