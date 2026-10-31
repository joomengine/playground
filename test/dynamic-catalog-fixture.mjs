/** Default runtime/browser regressions use the pinned catalog. Live upstream
 * availability is tested separately; optional discovery must not make otherwise
 * deterministic runtime contracts depend on public API quotas or nightly jobs.
 */
export async function withPinnedCatalog(browser, options) {
  const context = await browser.newContext(options);
  const headers = { 'Access-Control-Allow-Origin': '*' };
  await context.route(/^https:\/\/api\.github\.com\/repos\/(?:joomla\/joomla-cms\/releases|joomengine\/pkg-component-builder\/tags)\?/, route => route.fulfill({ headers, json: [] }));
  await context.route(/^https:\/\/api\.github\.com\/repos\/joomengine\/Joomla-Component-Builder\/branches\?/, route => route.fulfill({ headers, json: [{ name: '6.x' }, { name: '5.x' }] }));
  await context.route(/^https:\/\/raw\.githubusercontent\.com\/joomengine\/Joomla-Component-Builder\/(?:refs\/heads\/)?\d+\.x\/componentbuilder_update_server\.xml$/, route => route.fulfill({ headers, contentType: 'application/xml', body: '<updates></updates>' }));
  await context.route(/^https:\/\/update\.joomla\.org\/core\/nightlies\/[a-z_]+_list\.xml$/, route => route.fulfill({ headers, contentType: 'application/xml',
    body: '<extensionset><extension element="joomla" type="file" detailsurl="https://update.joomla.org/core/nightlies/next_patch_extension.xml" /></extensionset>' }));
  await context.route(/^https:\/\/update\.joomla\.org\/core\/nightlies\/[a-z_]+_extension\.xml$/, route => route.fulfill({ headers, contentType: 'application/xml', body: '<updates></updates>' }));
  return context;
}
