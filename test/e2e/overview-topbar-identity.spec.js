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
 * Include narrow viewports and both sides of the wrapping breakpoint. A
 * larger brand target previously made the 360px bar overflow again; keeping
 * that target must leave every action reachable and content below the bar.
 */
for (const width of [320, 360, 380, 381, 390, 430]) {
  test(`the overview bar fits its own box at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await overview(page);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect.poll(() => page.locator('#page-overview .topbar').evaluate(el => {
        const bar = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')];
        const boxes = buttons.map(button => button.getBoundingClientRect());
        const brand = el.querySelector('.topbar-brand').getBoundingClientRect();
        const content = document.querySelector('#page-overview .container').getBoundingClientRect();
        return {
          overflow: el.scrollWidth > Math.round(bar.width),
          reachable: buttons.every((button, i) => {
            const box = boxes[i];
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return box.width > 0 && box.height > 0 && button.contains(hit);
          }),
          contained: boxes.every(box => box.left >= bar.left && box.right <= bar.right &&
            box.top >= bar.top && box.bottom <= bar.bottom),
          overlapping: boxes.some((box, i) => boxes.slice(i + 1).some(other =>
            box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          brandTarget: brand.width >= 44 && brand.height >= 44,
          contentClear: content.top >= bar.bottom
        };
      }), { message: `${theme}: all seven controls must fit, remain reachable, and leave content clear` }).toEqual({
        overflow: false, reachable: true, contained: true, overlapping: false, brandTarget: true, contentClear: true
      });
      await expect(page.locator('#page-overview .topbar button')).toHaveCount(7);
    }
  });
}

test('the overview reserves its new header height when the viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await overview(page);
  for (const width of [320, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.locator('#page-overview .topbar').evaluate(el => {
      const bar = el.getBoundingClientRect();
      const content = document.querySelector('#page-overview .container').getBoundingClientRect();
      const reserved = parseFloat(document.documentElement.style.getPropertyValue('--tbh'));
      return reserved === el.offsetHeight && content.top >= bar.bottom;
    })).toBe(true);
  }
});

test('the repositories header fits after navigation and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await overview(page);
  await page.locator('#ovGoRepos').click();
  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  for (const width of [320, 360, 380, 381, 390, 430, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect.poll(() => page.locator('#page-repos .topbar').evaluate(el => {
        const bar = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0);
        const brand = el.querySelector('.topbar-brand').getBoundingClientRect();
        const content = document.querySelector('#page-repos .container').getBoundingClientRect();
        return el.scrollWidth <= Math.round(bar.width) && buttons.length === 6 &&
          brand.width >= 44 && brand.height >= 44 && content.top >= bar.bottom &&
          parseFloat(document.documentElement.style.getPropertyValue('--tbh')) === el.offsetHeight &&
          buttons.every(button => {
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom &&
              (button.disabled || button.contains(hit));
          });
      }), { message: `${theme} at ${width}px: repository controls must fit and content must clear the header` }).toBe(true);
    }
  }
});
