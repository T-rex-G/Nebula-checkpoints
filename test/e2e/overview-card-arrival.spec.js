'use strict';

/*
 * The overview's cards arrive on a scroll-driven view timeline. The entrance
 * is welcome; a card still playing it while the reader is reading it is not.
 *
 * `nv-arrive` holds a card at opacity 0 with a 22px downward offset until its
 * range begins, and `animation-range: entry 5% entry 85%` measured that range
 * against the card's own travel across the viewport. A card only finished
 * arriving once its top edge had climbed to the top of the screen, so for the
 * whole time its top sat in the lower half -- which is where a reader meets it
 * -- the card was half transparent and pushed down: an empty band where the
 * card should have been, with dim content under it.
 *
 * Recent activity showed it worst, for three reasons that compound. It is the
 * last card, so a reader stops at it rather than scrolling past. Expanding its
 * commits makes it taller than the screen, which stretches the range it has to
 * travel. And expanding it mid-range re-measures that range under the reader.
 *
 * These tests pin the property that matters: arrival is bounded by a fixed
 * distance, not by the card's height, so every card has finished arriving
 * before it can be read -- while still arriving, and while the last card on
 * the page still reaches its end state.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' });

/* The timeline is declared inside @media (max-width:760px). */
const PHONE_MAX = 760;
/* Where a reader meets a card: its top edge in the lower-middle of the screen. */
const READING_FRACTION = 0.75;

async function overview(page) {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#wpFeed')).toBeVisible();
  await page.waitForTimeout(900);
}

/* Two frames: a scroll-driven animation is sampled on the frame after the scroll. */
async function settle(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function arrival(page, selector) {
  return page.evaluate(sel => {
    const style = getComputedStyle(document.querySelector(sel));
    const matrix = new DOMMatrixReadOnly(style.transform);
    return { opacity: Number(style.opacity), offsetY: Math.abs(matrix.m42) };
  }, selector);
}

test('a card taller than the screen has finished arriving before it is read', async ({ page }) => {
  test.skip(page.viewportSize().width > PHONE_MAX, 'the arrival timeline is declared for phone widths');
  await overview(page);

  /*
   * A reader with real history expands twenty commits and the card outgrows
   * the screen. Forcing the height reproduces that without depending on how
   * much the fixture happens to carry.
   */
  await page.evaluate(() => { document.querySelector('#wpFeed').style.minHeight = '1400px'; });
  await settle(page);

  await page.evaluate(fraction => {
    const card = document.querySelector('#wpFeed');
    scrollTo(0, card.getBoundingClientRect().top + scrollY - innerHeight * fraction);
  }, READING_FRACTION);
  await settle(page);

  const read = await arrival(page, '#wpFeed');
  expect(read.opacity, 'a card being read must not still be fading in').toBeGreaterThan(0.99);
  expect(read.offsetY, 'a card being read must not still be displaced downward').toBeLessThan(0.5);
});

test('the entrance still plays as a card appears', async ({ page }) => {
  test.skip(page.viewportSize().width > PHONE_MAX, 'the arrival timeline is declared for phone widths');
  await overview(page);

  /* Bounding the range must not amount to deleting the animation. */
  await page.evaluate(() => {
    const card = document.querySelector('#wpFeed');
    scrollTo(0, card.getBoundingClientRect().top + scrollY - innerHeight * 0.98);
  });
  await settle(page);

  const appearing = await arrival(page, '#wpFeed');
  expect(appearing.opacity, 'a card at the bottom edge is still arriving').toBeLessThan(0.6);
});

test('the last card on the page reaches its end state', async ({ page }) => {
  test.skip(page.viewportSize().width > PHONE_MAX, 'the arrival timeline is declared for phone widths');
  await overview(page);

  /*
   * The regression this range was rewritten for once already: under `cover`
   * the bottom card had nowhere left to travel, so the scroll ran out and it
   * stayed invisible under a gap. Whatever bounds the range must not bring
   * that back.
   */
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  await settle(page);

  const rested = await arrival(page, '#wpFeed');
  expect(rested.opacity, 'the last card must not rest invisible').toBeGreaterThan(0.99);
  expect(rested.offsetY, 'the last card must not rest displaced').toBeLessThan(0.5);
});
