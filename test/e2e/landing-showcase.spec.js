'use strict';

/*
 * The landing shows the product rather than describing it.
 *
 * Below the gate: the providers it works against, the audit played at the
 * pace of the scroll, a framed miniature of the Neural view that settles as
 * it scrolls in, what it checks with the engine's own counts, the
 * capabilities as a bento, the comparison with what a scan usually does, the
 * three moves, the questions and a closing call that returns the reader to
 * the card. These read what a
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
  /* One composition per shape of screen, and exactly one of them drawn. */
  const maps = page.locator('.lp-map');
  for (const map of await maps.all()) await expect(map).toHaveAttribute('aria-hidden', 'true');
  const map = page.locator('.lp-map:visible');
  await expect(map).toHaveCount(1);
  /* A real picture of the product: the hub and one panel per group, whole. */
  expect(await map.locator('.lp-map-panel').count()).toBe(6);
  expect(await map.locator('.lp-map-hub').count()).toBe(1);
  const clipped = await map.evaluate(svg => {
    const view = svg.viewBox.baseVal;
    return [...svg.querySelectorAll('.lp-map-panel rect:first-child')].filter(rect => {
      const box = rect.getBBox();
      return box.x < view.x || box.y < view.y || box.x + box.width > view.x + view.width || box.y + box.height > view.y + view.height;
    }).length;
  });
  expect(clipped, 'a group panel runs off the edge of the picture').toBe(0);
  /* And words for anyone who cannot see it. */
  await expect(page.locator('.lp-frame-cap')).toHaveText(/identities, branches, workflows/);
  await expect(page.getByRole('list', { name: 'Supported providers' }).getByRole('listitem')).toHaveText(['GitHub', 'GitLab', 'Gitea']);
});

test('the numbers are the build\'s own, and arrive whole', async ({ page }) => {
  await openLanding(page);
  const checks = page.locator('.lp-checks');
  await checks.scrollIntoViewIfNeeded();
  const values = checks.locator('.lp-check-v');
  /* test/landing-claims.test.js holds each of these to the engine's own count. */
  await expect(values).toHaveText(['99', '43', '33', '15'], { timeout: 5000 });
  /* The figures are in the markup, not produced by the count: without script
     a reader still gets them. */
  expect(await values.evaluateAll(els => els.map(el => el.dataset.count))).toEqual(['99', '43', '33', '15']);
  await expect(checks.getByRole('heading', { level: 3 })).toHaveText(['Secret detectors', 'Live verifiers', 'Repository audit rules', 'Deployed-site checks']);
});

/*
 * The audit, played. Beside a held frame on a wide screen, the move nearest
 * the middle of the view is the one the frame shows; on a narrow one each
 * move carries its own snapshot. Either way the frame never names the code.
 */
test('the audit plays at the pace of the scroll', async ({ page }, info) => {
  await openLanding(page);
  const play = page.locator('.lp-play');
  await expect(play.getByRole('heading', { name: 'Find it. Fix it. Prove it is gone.' })).toBeAttached();
  const steps = play.locator('.lp-play-step');
  await expect(steps.getByRole('heading', { level: 3 })).toHaveText(['Read what ships', 'Grade what an attacker would find', 'Hand over the fix', 'Prove it is gone']);
  const letters = { read: '—', find: 'F', fix: 'F', again: 'A' };

  if (info.project.name === 'mobile') {
    const snaps = play.locator('.lp-play-snap');
    await expect(snaps).toHaveCount(4);
    expect(await snaps.evaluateAll(els => els.map(el => el.dataset.stage))).toEqual(['read', 'find', 'fix', 'again']);
    await expect(play.locator('.lp-play-stick')).toBeHidden();
    for (const [index, stage] of ['read', 'find', 'fix', 'again'].entries()) {
      const snap = snaps.nth(index);
      await snap.scrollIntoViewIfNeeded();
      await expect(snap.locator('.lp-au-letter')).toHaveText(letters[stage], { useInnerText: true });
    }
    await expect(snaps.nth(2).locator('.lp-au-prompt')).toBeVisible();
    await expect(play).not.toContainText('SELECT *');
    return;
  }

  const frame = play.locator('.lp-play-stick .lp-play-frame');
  for (const [index, stage] of ['read', 'find', 'fix', 'again'].entries()) {
    await steps.nth(index).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await expect(frame).toHaveAttribute('data-stage', stage);
    await expect(steps.nth(index)).toHaveClass(/is-current/);
    await expect(frame.locator('.lp-au-letter')).toHaveText(letters[stage], { useInnerText: true });
    await expect(frame).toBeInViewport();
  }
  /* Scrolling back plays it backwards: the stage follows the reader, not a timer. */
  await steps.nth(1).evaluate(el => el.scrollIntoView({ block: 'center' }));
  await expect(frame).toHaveAttribute('data-stage', 'find');
  await expect(frame.locator('.lp-au-cap')).toHaveText('Held below 50 while a critical finding is open.');
  await expect(play).not.toContainText('SELECT *');
});

test('the comparison says which column is which, heard or seen', async ({ page }, info) => {
  await openLanding(page);
  const proof = page.locator('.lp-proof');
  await proof.scrollIntoViewIfNeeded();
  const rows = proof.locator('.lp-proof-row:not(.lp-proof-cols)');
  await expect(rows).toHaveCount(7);
  /* The words "Usually" and "Here" are in every row for a screen reader. */
  await expect(rows.first()).toContainText('UsuallyFlags a pattern.');
  const pill = rows.first().locator('.lp-proof-us .lp-proof-tag');
  const box = await pill.boundingBox();
  if (info.project.name === 'mobile') {
    expect(box.width, 'a phone shows the column as a pill').toBeGreaterThan(10);
  } else {
    expect(box.width, 'a wide screen has the column heads instead').toBeLessThanOrEqual(1);
    await expect(proof.locator('.lp-proof-cols')).toBeVisible();
  }
});

test('the questions open and close from the keyboard', async ({ page }) => {
  await openLanding(page);
  const items = page.locator('.lp-faq details');
  await expect(items).toHaveCount(6);
  const first = items.first();
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('p')).toBeVisible();
  await expect(first.locator('p')).toContainText('never the content');
  await page.keyboard.press('Enter');
  await expect(first).not.toHaveAttribute('open', '');
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
  /*
   * Five widths, each a relayout of the whole page, in one test. The question
   * is where things are, not how they move, so the page is read with motion
   * off: nothing is mid-arrival when it is measured, and the scene is not
   * redrawn live on every resize -- which, on a software renderer under a
   * loaded suite, was enough to run this past the default budget.
   */
  test.setTimeout(60000);
  await openLanding(page, false);
  for (const width of [320, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `at ${width}px the page scrolls sideways`).toBeLessThanOrEqual(0);
    for (const selector of ['.lp-play', '.lp-show', '.lp-checks', '.lp-caps', '.lp-proof', '.lp-story', '.lp-faq', '.lp-cta']) {
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
    '.lp-frame', '.lp-map-flow', '.lp-map-arcs', '.lp-story-progress span', '.lp-line',
    '.lp-ticker-track', '.lp-play-frame [data-only]', '.lp-au-bar i'
  ].filter(selector => [...document.querySelectorAll(selector)]
    .some(el => getComputedStyle(el).animationName !== 'none')));
  expect(moving).toEqual([]);
});
