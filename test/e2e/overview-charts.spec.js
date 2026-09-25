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
 * The card leads with a shape, and it is the same shape as the card above it.
 *
 * These two cards sit one under the other and answer the same kind of question
 * over the same kind of window, so drawing one as bars and the other as an
 * area made the overview read as two products. Derived, not fetched: the
 * series is the events already on screen counted per day, so the chart and the
 * ledger cannot disagree and no extra provider round trip is spent.
 */
test('the feed leads with its own events counted per day', async ({ page }) => {
  await overview(page);
  const line = page.locator('#wpFeed .wp-area-line');
  await expect(line).toBeVisible();
  /* Same chart language as the activity card, not a second one. */
  expect(await page.locator('#wpFeed .wp-bars, #wpFeed .wp-bar').count()).toBe(0);
  /* Derived: the headline figure is the number of rows the ledger holds. */
  const figure = await page.locator('#wpFeed .wp-area-head-figure').evaluate(
    el => Number(el.firstChild.textContent.trim()));
  await expect(page.locator('#wpFeed .wp-feed-row')).toHaveCount(figure);
});

/*
 * Today is still being counted, and the card says so in words rather than
 * leaving the reader to infer it from a short final reading. A day that is
 * half over drawn the same as a finished one is the card overstating what it
 * knows.
 */
test('the feed says that today is still being counted', async ({ page }) => {
  await overview(page);
  await expect(page.locator('#wpFeed .wp-area-head-desc')).toContainText('today still counting');
  await expect(page.locator('#wpFeed .wp-area-axis').last()).toHaveText('today');
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
  /* Segment count off the curve: one cubic per gap between readings. */
  const segments = await page.evaluate(() =>
    ((document.querySelector('#wpActivity .wp-area-line')?.getAttribute('d') || '').match(/C/g) || []).length);
  expect(segments).toBeGreaterThan(30);
  await expect(page.locator('#wpActivity .wp-area-dot')).toHaveCount(0);
  await expect(page.locator('#wpActivity .wp-area-head')).toBeVisible();
  /* The reading is named by the header now, not printed over the plot. */
  await expect(page.locator('#wpActivity .wp-area-head-figure')).toBeVisible();
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
  await expect(page.locator('#wpFeed .wp-area-line')).toBeVisible();
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

/*
 * The block composition: what is measured on the left, how much on the right,
 * and the series underneath. The card used to open with a sentence carrying
 * the number inside it, which puts the one fact a reader came for behind a
 * clause they have to parse.
 */
test('the activity card leads with its figure, and prints it once', async ({ page }) => {
  await overview(page);
  const figure = page.locator('#wpActivity .wp-area-head-figure');
  await expect(figure).toBeVisible();
  await expect(page.locator('#wpActivity .wp-area-head-title')).toHaveText('Repositories pushed');
  /* The endpoint readout stands down when the header states the figure --
     the same number twice within a couple of centimetres invites the reader
     to look for a difference between them. */
  await expect(page.locator('#wpActivity .wp-area-value')).toHaveCount(0);
});

/*
 * Curved, and never outside its own readings.
 *
 * This pins the property, not a bug that was seen: sampled along the rendered
 * curve, no point of it may fall below the zero line. Against this product's
 * own series -- a trailing count, which moves as plateaus rather than isolated
 * spikes -- an unclamped fit measures the same, so this assertion does not
 * currently separate the two implementations. It separates either of them from
 * a future one that overshoots, which is what it is here to do.
 */
test('the series is curved and never dips below its own baseline', async ({ page }) => {
  /*
   * A bump with zeros on both sides of it, which is the shape that exposes an
   * overshooting spline. Every repository was pushed on the same day a month
   * back, so the trailing count climbs, holds, and returns to zero -- and a
   * curve fitted with plain Catmull-Rom swings under the baseline on the way
   * down, drawing a count of repositories as a negative number.
   */
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(/\/api\/repos(\?|$)/, route => route.fulfill({
    json: Array.from({ length: 6 }, (unused, index) => ({
      full_name: `acme/r${index}`, name: `r${index}`, owner: 'acme',
      private: false, language: 'Go', pushed_at: thirtyDaysAgo
    }))
  }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const path = document.querySelector('#wpActivity .wp-area-line');
    const d = path.getAttribute('d');
    /* The baseline is where the series reads zero: the lowest grid line. */
    const baseline = Math.max(...[...document.querySelectorAll('#wpActivity .wp-grid-line')]
      .map(line => Number(line.getAttribute('y1'))));
    /* Sample the rendered curve rather than its control points -- a bezier
       leaves the interval between its endpoints, which is the whole failure. */
    const total = path.getTotalLength();
    let lowest = -Infinity;
    for (let at = 0; at <= total; at += total / 400) {
      lowest = Math.max(lowest, path.getPointAtLength(at).y);
    }
    return { curved: d.includes(' C'), lowest, baseline, peak: Math.min(...
      Array.from({ length: 401 }, (unused, index) => path.getPointAtLength(index * total / 400).y)) };
  });
  expect(geometry.curved).toBe(true);
  /* Sampled on the curve itself: no point of it may fall below zero. */
  expect(geometry.lowest).toBeLessThanOrEqual(geometry.baseline + 0.5);
  /* And the bump is real, so this is not passing on a flat line. */
  expect(geometry.peak).toBeLessThan(geometry.baseline - 10);
});

/*
 * The live end pings, and stops pinging when the reader asked for stillness.
 * A halo left static would be a ring they have to interpret.
 */
test('the endpoint pings, and does not when motion is off', async ({ page }) => {
  await overview(page);
  await expect(page.locator('#wpActivity .wp-area-ping')).toHaveCount(1);

  await page.addInitScript(() => {
    try { localStorage.setItem('nv_settings', JSON.stringify({ motion: false })); } catch (e) { /* private mode */ }
  });
  await page.reload();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#wpActivity .wp-area-ping')).toHaveCount(0);
});

/*
 * Drawn at the size it is shown. A fixed 380-unit box stretched across a wide
 * card arrived with its axis labels, dots and stroke all three times their
 * size. The box now matches the card, so a unit is a pixel.
 */
test('the chart is drawn at the width it is shown, not stretched to it', async ({ page }) => {
  await overview(page);
  const chart = page.locator('#wpFeed .wp-area');
  await expect(chart).toBeVisible();
  const fit = await chart.evaluate(svg => ({ box: svg.viewBox.baseVal.width, shown: svg.getBoundingClientRect().width }));
  expect(Math.abs(fit.box - fit.shown), `drawn ${fit.box} wide, shown ${fit.shown} wide`).toBeLessThanOrEqual(26);
  const label = await page.locator('#wpFeed .wp-area-axis').first()
    .evaluate(text => text.getBoundingClientRect().height);
  expect(label).toBeLessThan(16);
});

/*
 * A pointer over the plot names the day under it and its count; leaving the
 * plot puts it away. The table under the chart carries the same numbers for
 * every other reader.
 */
test('hovering the series names the day and the count under the pointer', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'a hover layer is a mouse affordance');
  await overview(page);
  const chart = page.locator('#wpFeed .wp-area');
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  await expect(page.locator('#wpFeed .wp-hover')).toHaveClass(/is-on/);
  await expect(page.locator('#wpFeed .wp-hover-text')).toHaveText(/^today · \d+$/);
  await page.mouse.move(box.x + box.width / 2, box.y - 60);
  await expect(page.locator('#wpFeed .wp-hover')).not.toHaveClass(/is-on/);
});
