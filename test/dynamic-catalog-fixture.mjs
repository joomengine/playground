/** Runtime/browser regressions use the pinned catalog. Build-time discovery is
 * covered separately so public release changes never alter these fixtures.
 */
export async function withPinnedCatalog(browser, options) {
  const context = await browser.newContext(options);
  await context.route('**/assets/version-catalog.json', route => route.fulfill({ json: {
    schemaVersion: 1, generatedAt: '2026-10-31T00:00:00.000Z', joomla: [], jcb: [], errors: [],
  } }));
  return context;
}
