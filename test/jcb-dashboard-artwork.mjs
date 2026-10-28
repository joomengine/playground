import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile(new URL('../dependencies/jcb-dashboard-assets/assets.json', import.meta.url)));

/** Verify the real rendered credit artwork, not just a quiet browser console. */
export async function assertJcbDashboardArtwork(frame) {
  await frame.getByRole('tab', { name: 'Readme', exact: true }).click();
  await frame.locator('#readme-md').waitFor({ state: 'visible' });
  await frame.waitForFunction(() => {
    const images = [...document.querySelectorAll('#readme-md img')];
    return images.length === 24 && images.every(image => image.complete);
  }, undefined, { timeout: 30_000 });
  const images = await frame.locator('#readme-md img').evaluateAll(items => items.map(image => ({
    src: image.src, href: image.closest('a')?.href ?? null,
    width: image.naturalWidth, height: image.naturalHeight,
  })));
  assert.equal(images.length, manifest.readmeLinks.length);
  for (const [index, image] of images.entries()) {
    const original = manifest.readmeLinks[index];
    const asset = manifest.assets.find(item => item.url === original.image);
    assert.ok(asset, `Every rendered image needs its original source: ${original.image}`);
    const expected = new URL(`components/com_componentbuilder/assets/images/community/${path.basename(asset.file)}`, frame.url());
    assert.equal(image.src, expected.href, 'README artwork must load from the owned Joomla route.');
    assert.ok(image.width > 0 && image.height > 0, `The original artwork must actually decode: ${original.image}`);
    assert.equal(image.href, original.href, 'Original contributor and sponsor credit links must remain intact.');
  }
  return { images: images.length, decoded: true, originalCreditLinks: true, localResources: true };
}
