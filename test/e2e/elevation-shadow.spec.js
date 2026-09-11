'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

// Pixel subtraction measures only the shadow when the decorative background
// stays at the same phase in both captures. Keep the shadow bound unchanged.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

/*
 * The primary button was reported twice as having "visible box edges, not a
 * clean shadow", and the first fix missed because it was aimed at a hard edge
 * that does not exist: scanning the pixels beside the button, the largest step
 * between neighbours is 2 of 765 either way. There is no compositing seam.
 *
 * The shadow itself was the box. 20px of blur at 0.4 alpha with no spread
 * throws a wide soft rectangle well past the button's shape, and on a pale
 * page that region reads as a slab rather than as lift.
 *
 * So this measures the one thing that distinguishes the two: how far the
 * shadow's influence actually reaches. Measured on the reported styling it is
 * 16 css px; on the shipping styling, 7. The bound sits between them, so
 * restoring the old shadow fails this test.
 */
const SHADOW_REACH_LIMIT_PX = 10;

/*
 * The shadow's reach, isolated by difference.
 *
 * A first version of this compared each pixel against the far end of its own
 * scan line, which works on the pale theme and is meaningless on the dark one:
 * that hero carries a gradient and an aura to the button's right, so the whole
 * strip differs from its far end and the measurement read 51px of "shadow"
 * that was really just background. Measuring the background and calling it the
 * shadow would have been the same class of mistake as the fix this guards.
 *
 * So the strip is captured twice -- once as styled, once with the shadow
 * suppressed -- and subtracted. Whatever is left is the shadow and nothing
 * else, on any background.
 */
async function shadowReach(page, theme) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.waitForTimeout(600);
  await page.evaluate(() => { if (window.showPage) window.showPage('repos'); });
  const button = page.locator('#reposRefreshBtn');
  await button.waitFor({ state: 'visible' });
  await page.waitForTimeout(900);
  if (theme === 'light') {
    await expect(page.locator('#lightWaves')).toHaveAttribute('data-wave-state', 'still');
  }

  const box = await button.boundingBox();
  const ratio = await page.evaluate(() => window.devicePixelRatio || 1);
  const clip = { x: box.x + box.width, y: box.y + box.height / 2 - 1, width: 90, height: 3 };

  const withShadow = await page.screenshot({ clip });
  await page.addStyleTag({ content: '#reposRefreshBtn{box-shadow:none!important}' });
  await page.waitForTimeout(300);
  const withoutShadow = await page.screenshot({ clip });

  return page.evaluate(async ({ a, b, scale }) => {
    const load = async url => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return { data: canvas.getContext('2d').getImageData(0, 1, image.width, 1).data, width: image.width };
    };
    const lit = await load(a);
    const flat = await load(b);
    let reach = 0;
    for (let x = 0; x < lit.width; x += 1) {
      const delta = Math.abs(lit.data[x * 4] - flat.data[x * 4])
        + Math.abs(lit.data[x * 4 + 1] - flat.data[x * 4 + 1])
        + Math.abs(lit.data[x * 4 + 2] - flat.data[x * 4 + 2]);
      /* 6 of 765 is above the page's own dithering. */
      if (delta > 6) reach = x;
    }
    return Math.round(reach / scale);
  }, {
    a: `data:image/png;base64,${withShadow.toString('base64')}`,
    b: `data:image/png;base64,${withoutShadow.toString('base64')}`,
    scale: ratio
  });
}

for (const theme of ['light', 'dark']) {
  test(`the primary button casts elevation, not a slab (${theme})`, async ({ page }) => {
    const reach = await shadowReach(page, theme);
    expect(
      reach,
      `the primary button's shadow reaches ${reach}px past its edge in ${theme}; `
      + `above ${SHADOW_REACH_LIMIT_PX}px it stops reading as lift and starts reading as a box`
    ).toBeLessThanOrEqual(SHADOW_REACH_LIMIT_PX);
  });
}
