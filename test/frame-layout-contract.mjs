import assert from 'node:assert/strict';

/** Exercise responsive extension handlers without repeatedly moving the footer. */
export async function assertFrameLayoutStable(page, frame) {
  // The preceding settings action shows a seven-second notification. Its normal
  // dismissal shortens the outer document and clamps scrollY at the bottom,
  // even though the iframe and the visible footer have not moved.
  await page.locator('#header-feedback').waitFor({ state: 'hidden', timeout: 10_000 });
  const originalHeight = await page.locator('#site-frame').evaluate(element => element.clientHeight);
  await frame.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'rocket-resize-proof';
    block.className = 'responsive-content';
    block.style.height = '5000px';
    document.body.append(block);
    let count = 0;
    const resized = () => {
      count += 1;
      // Atum and extensions use classList on resize, including no-op writes.
      block.classList.add('responsive-content');
      block.classList.add('temporary-layout');
      block.classList.remove('temporary-layout');
    };
    window.addEventListener('resize', resized);
    window.rocketFrameProof = { count: () => count, cleanup: () => { window.removeEventListener('resize', resized); block.remove(); } };
  });
  try {
    await page.waitForFunction(original => document.getElementById('site-frame').clientHeight >= original + 4500, originalHeight);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    // Let load/resize callbacks settle before observing an otherwise idle page.
    await frame.evaluate(() => new Promise(resolve => { let frames = 6; const tick = () => --frames ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick); }));
    const before = await frame.evaluate(() => window.rocketFrameProof.count());
    const samples = await page.evaluate(() => new Promise(resolve => {
      const values = [];
      const sample = () => {
        values.push({ height: document.getElementById('site-frame').clientHeight, scroll: scrollY,
          footer: document.getElementById('site-footer').getBoundingClientRect().top,
          documentHeight: document.documentElement.scrollHeight,
          feedbackHidden: document.getElementById('header-feedback')?.hidden });
        if (values.length < 24) requestAnimationFrame(sample); else resolve(values);
      };
      requestAnimationFrame(sample);
    }));
    assert.equal(await frame.evaluate(() => window.rocketFrameProof.count()), before,
      'An idle site must not repeatedly resize its own viewport.');
    for (const sample of samples) {
      assert.ok(Math.abs(sample.height - samples[0].height) <= 1, 'The iframe height must settle.');
      assert.ok(Math.abs(sample.scroll - samples[0].scroll) <= 1,
        `The outer scroll position must remain stable at the footer. Samples: ${JSON.stringify(samples)}`);
      assert.ok(Math.abs(sample.footer - samples[0].footer) <= 1, 'The footer must not flicker between layout positions.');
    }
    const tallHeight = samples[0].height;
    await frame.locator('#rocket-resize-proof').evaluate(block => { block.style.height = '1000px'; });
    await page.waitForFunction(tall => document.getElementById('site-frame').clientHeight <= tall - 3900, tallHeight);
    assert.ok(await page.locator('#site-frame').evaluate(element => element.contentDocument.documentElement.scrollHeight <= element.clientHeight + 3),
      'Shrinking real content must still fit within one scrolling document.');
  } finally {
    await frame.evaluate(() => { window.rocketFrameProof?.cleanup(); delete window.rocketFrameProof; });
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}
