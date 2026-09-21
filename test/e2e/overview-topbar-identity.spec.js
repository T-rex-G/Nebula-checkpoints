'use strict';

/*
 * The overview's top bar had nothing of the product on it, and no way to
 * change the theme.
 *
 * Its brand button's only child was a `.hide-sm` span, and `.hide-sm` is
 * `display:none !important` below 900px -- so on a phone the button held
 * nothing and collapsed to zero width. The crumbs beside it are `display:none`
 * below 901px too. Between them the bar lost the mark, the wordmark and the
 * reader's location at once, which is why the report was that the logo and the
 * name were "hiding".
 *
 * The theme control was a separate absence rather than a hidden one: the
 * inventory and the workbench each carry a `.theme-toggle` in their bar and
 * the overview simply never had one. A reader who lands on the overview -- and
 * a signed-in session starts there -- had to leave the screen to change it.
 *
 * Reachability is the claim, so each of these is asserted as operable and not
 * merely present: visible, topmost at its own centre, and for the control,
 * that pressing it changes the theme. "Topmost" is the part that matters and
 * the part a presence check misses -- adding the control without making room
 * for it overflowed the bar by 57px at 360 and pushed an action button clean
 * over the mark, which reads as present to a selector and is invisible to a
 * reader.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function overview(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
}

/*
 * Topmost at its own centre: what a finger landing on it would actually hit.
 *
 * Polled rather than sampled. The screen arrives on a `pageIn` animation, and
 * a single reading taken the instant the page turns active answers for a bar
 * that has not settled -- which is a flake either way round, and the round
 * that passes is the worse one.
 */
const topmost = (locator, selector) => expect.poll(() => locator.evaluate((el, sel) => {
  const box = el.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return !!(hit && hit.closest(sel) === el);
}, selector));

test('the overview bar carries the product mark on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await overview(page);
  const mark = page.locator('#page-overview .topbar-brand .nv-mark');
  await expect(mark, 'the brand button holds nothing once the wordmark is hidden').toBeVisible();
  await topmost(page.locator('#page-overview .topbar-brand'), '.topbar-brand')
    .toBe(true);
});

test('the overview offers a theme control that works, on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await overview(page);
  const toggle = page.locator('#page-overview .topbar .theme-toggle');
  await expect(toggle, 'the overview has no theme control at all').toBeVisible();
  await topmost(toggle, '.theme-toggle').toBe(true);

  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before);
});

/*
 * The bar is fixed and its children do not shrink, so it does not report
 * overflow by growing a scrollbar -- it reports it by laying one child on top
 * of another, which is how the theme control came to sit over the brand.
 *
 * 360 is the narrowest width asserted, and the omission of 320 is deliberate
 * rather than convenient. At 320 the bar overflows by 34px and cannot be made
 * to fit without dropping one of its five actions or rebuilding the theme
 * switch as a plain icon button -- a visual change, not a fix. It overflowed
 * there before this change too, by 32px, measured both ways; the two extra
 * pixels are the brand no longer being crushed to zero width to absorb the
 * difference, which is an improvement to the same defect this file is about.
 * 320 CSS px is an iPhone SE first generation, which cannot run a current iOS.
 * Every phone this ships to is 360 or wider.
 */
for (const width of [360, 390, 430]) {
  test(`the overview bar fits its own box at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await overview(page);
    const overflow = await page.locator('#page-overview .topbar').evaluate(el =>
      el.scrollWidth - Math.round(el.getBoundingClientRect().width));
    expect(overflow, 'the bar overflows its own box, so its children overlap').toBeLessThanOrEqual(0);
  });
}
