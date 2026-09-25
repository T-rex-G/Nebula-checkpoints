'use strict';

/*
 * The landing shows the product rather than describing it.
 *
 * Below the gate: the providers it works against, a framed miniature of the
 * Neural view that settles as it scrolls in, the capabilities as a bento, the
 * three moves told at the pace of the scroll, the numbers the build ships and
 * a closing call that returns the reader to the card. These read what a
 * visitor gets: that each is there, says true things, fits every width, and
 * holds still for a reader who asked for stillness.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function openLanding(page, motion = true) {
  await page.addInitScript(on => {
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: true, motion: on, design: 'nebula' }));
  }, motion);
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  await expect(page.locator('.lp-nav')).toBeVisible();
}

test('the product is framed, named and described for a reader who cannot see it', async ({ page }) => {
  await openLanding(page);
  const show = page.locator('.lp-show');
  await show.scrollIntoViewIfNeeded();
  await expect(show.getByRole('heading', { name: 'Your repository, drawn as one living map' })).toBeVisible();
  const map = page.locator('.lp-map');
  await expect(map).toHaveAttribute('aria-hidden', 'true');
  /* A real picture of the product: the hub and one panel per group. */
  expect(await page.locator('.lp-map-panel').count()).toBe(6);
  expect(await page.locator('.lp-map-hub').count()).toBe(1);
  /* And words for anyone who cannot see it. */
  await expect(page.locator('.lp-frame-cap')).toHaveText(/identities, branches, workflows/);
  await expect(page.getByRole('list', { name: 'Supported providers' }).getByRole('listitem')).toHaveText(['GitHub', 'GitLab', 'Gitea']);
});

test('the numbers are the build\'s own, and arrive whole', async ({ page }) => {
  await openLanding(page);
  const stats = page.locator('.lp-stats');
  await stats.scrollIntoViewIfNeeded();
  const values = stats.locator('.lp-stat-v');
  await expect(values).toHaveText(['99', '43', '3', '0'], { timeout: 5000 });
  /* The figures are in the markup, not produced by the count: without script
     a reader still gets them. */
  expect(await values.evaluateAll(els => els.map(el => el.dataset.count))).toEqual(['99', '43', '3', '0']);
});

test('the closing call returns the reader to the card and into its first control', async ({ page }) => {
  await openLanding(page);
  await expect(page.locator('#alphaInviteInput')).toBeVisible();
  const cta = page.getByRole('button', { name: 'Request entry' });
  await cta.scrollIntoViewIfNeeded();
  await cta.click();
  await expect(page.locator('#alphaInviteInput')).toBeFocused({ timeout: 4000 });
  await expect(page.locator('.lp-card')).toBeInViewport();
});

test('every width gets the whole page and nothing wider than the screen', async ({ page }) => {
  await openLanding(page);
  for (const width of [320, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `at ${width}px the page scrolls sideways`).toBeLessThanOrEqual(0);
    for (const selector of ['.lp-show', '.lp-caps', '.lp-story', '.lp-stats', '.lp-cta']) {
      const box = await page.locator(selector).boundingBox();
      expect(box && box.width, `${selector} at ${width}px`).toBeGreaterThan(0);
      expect(box.x, `${selector} starts off screen at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${selector} runs off screen at ${width}px`).toBeLessThanOrEqual(width + 1);
    }
  }
});

test('with motion off the showcase holds still', async ({ page }) => {
  await openLanding(page, false);
  await page.locator('.lp-show').scrollIntoViewIfNeeded();
  const moving = await page.evaluate(() => [
    '.lp-frame', '.lp-map-flow', '.lp-map-arcs', '.lp-story-progress span', '.lp-line'
  ].filter(selector => [...document.querySelectorAll(selector)]
    .some(el => getComputedStyle(el).animationName !== 'none')));
  expect(moving).toEqual([]);
});
