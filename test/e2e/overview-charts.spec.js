'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function overview(page, scenario = {}) {
  await mockPublicAlphaApi(page, { access: 'active', ...scenario });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#wpFeed')).toBeVisible();
}

/*
 * The card leads with a shape.
 *
 * The feed answers "what changed" one row at a time, which is the right shape
 * for reading a single change and the wrong one for seeing a week: no number
 * of rows shows that the middle of the week was quiet. The bars are the same
 * events counted per day, derived here rather than fetched, so the two cannot
 * disagree and no extra provider round trip is spent on them.
 */
test('the feed leads with its own events counted per day', async ({ page }) => {
  await overview(page);
  const bars = page.locator('#wpFeed .wp-bar');
  await expect(bars.first()).toBeVisible();
  /* Derived, not fetched: the counts must add up to the rows on screen. */
  const counted = await page.evaluate(() => [...document.querySelectorAll('#wpFeed .wp-bar title')]
    .reduce((total, node) => total + Number((node.textContent.match(/(\d+) commit/) || [0, 0])[1]), 0));
  await expect(page.locator('#wpFeed .wp-feed-row')).toHaveCount(counted);
});

/*
 * A day that is still being counted is drawn even at zero, and marked.
 * Skipping it renders "nothing has landed today yet" as a chart that stops at
 * yesterday, and those are different statements -- the same distinction this
 * card already makes between a quiet workspace and one it could not read.
 */
test('the day still being counted is drawn, hatched, even when it is empty', async ({ page }) => {
  await overview(page);
  const last = page.locator('#wpFeed .wp-bar').last();
  await expect(last).toHaveAttribute('fill', /-h\)$/);
  await expect(last.locator('title')).toHaveText(/so far$/);
  /* And the texture it points at is really defined, not a dangling url(). */
  expect(await page.locator('#wpFeed .wp-bars pattern').count()).toBe(1);
});

/*
 * Dashed gridlines are the house style of most chart libraries and they are a
 * mistake: a dash reads as a threshold or a projection, so a grid drawn that
 * way says "target" on a chart that has no target.
 */
test('the grid is a solid hairline, not a dashed rule', async ({ page }) => {
  await overview(page);
  const dashes = await page.evaluate(() => [...document.querySelectorAll('.wp-grid-line')]
    .map(line => getComputedStyle(line).strokeDasharray)
    .filter(value => /[1-9]/.test(value)));
  expect(dashes).toEqual([]);
  await expect(page.locator('#wpActivity .wp-area-axis').first()).toBeVisible();
});

/*
 * A dot per reading is chrome once the readings are closer together than a
 * dot is wide. At the sixty-day window this series uses they are under six
 * units apart, so sixty dots is a bead chain laid over the line rather than
 * sixty marks. The line carries the shape and the endpoint carries the value.
 */
test('a dense series draws no dots, and still names its latest reading', async ({ page }) => {
  await overview(page);
  const points = await page.evaluate(() =>
    (document.querySelector('#wpActivity .wp-area-line')?.getAttribute('points') || '').trim().split(/\s+/).length);
  expect(points).toBeGreaterThan(30);
  await expect(page.locator('#wpActivity .wp-area-dot')).toHaveCount(0);
  await expect(page.locator('#wpActivity .wp-area-head')).toBeVisible();
  await expect(page.locator('#wpActivity .wp-area-value')).toBeVisible();
});

/*
 * Motion has one owner on this page. A chart that reveals itself for a reader
 * who asked for stillness has taken that decision back off them.
 */
test('the reveal is skipped when motion is off', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('nv_settings', JSON.stringify({ motion: false })); } catch (e) { /* private mode */ }
  });
  await overview(page);
  expect(await page.locator('#wpActivity .wp-area-line animate').count()).toBe(0);
  await expect(page.locator('#wpActivity .wp-area-line')).not.toHaveAttribute('stroke-dashoffset', /.+/);
});

/*
 * The rows are the evidence, not the headline.
 *
 * Every row carries a repository, a short sha and an author so a claim can be
 * checked, which is exactly why they cannot be deleted -- and exactly why
 * thirty of them stacked under the chart buries both the shape and the card
 * below. Folded, the card is the shape; opened, it is the ledger.
 */
test('the commit rows are folded away, and the chart is what is left', async ({ page }) => {
  await overview(page);
  const fold = page.locator('#wpFeed .wp-feed-fold');
  await expect(fold).toBeVisible();
  expect(await fold.evaluate(el => el.open)).toBe(false);
  await expect(page.locator('#wpFeed .wp-feed-row').first()).toBeHidden();
  /* The chart is not folded with them. */
  await expect(page.locator('#wpFeed .wp-bars')).toBeVisible();
  /* And the bounds are still stated where the chart is read, sample included. */
  await expect(page.locator('#wpFeed .wp-feed-scope')).toContainText('bounded sample');

  await fold.locator('summary').click();
  await expect(page.locator('#wpFeed .wp-feed-row').first()).toBeVisible();
  /* The long provenance travels with the rows it describes. */
  await expect(page.locator('#wpFeed .wp-feed-scope-full')).toBeVisible();
});

/*
 * A reader who opened the ledger did so to read it. Re-folding it under them
 * on the next repaint -- a refresh, a revisit -- is the card taking that back.
 */
test('an opened ledger stays open across a revisit', async ({ page }) => {
  await overview(page);
  await page.locator('#wpFeed .wp-feed-fold summary').click();
  await expect(page.locator('#wpFeed .wp-feed-row').first()).toBeVisible();
  /*
   * Wait for the choice to be written, not just for the rows to appear. The
   * toggle event fires after the element opens, so a reload issued on the
   * strength of the rows being visible can outrun the write -- which is this
   * assertion failing for a reason that has nothing to do with the behaviour
   * it is about.
   */
  await expect.poll(() => page.evaluate(() => {
    try { return localStorage.getItem('nv_feed_rows_open'); } catch { return null; }
  })).toBe('open');
  await page.reload();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#wpFeed .wp-feed-row').first()).toBeVisible();
  expect(await page.locator('#wpFeed .wp-feed-fold').evaluate(el => el.open)).toBe(true);
});
