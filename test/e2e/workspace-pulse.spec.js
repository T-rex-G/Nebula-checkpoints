'use strict';

/*
 * The overview is what a signed-in tester sees first, and it now carries two
 * figures the reference design asked for. The unit tests prove the model never
 * overstates; these prove the screen shows what the model computed -- including
 * the components behind the score, so the number can be argued with rather than
 * merely believed.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function signIn(page) {
  await mockPublicAlphaApi(page, {
    access: 'required',
    ready: 'ready',
    provider: 'github',
    repositoryState: 'current'
  });
  await page.goto('/');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-provider-credential');
  await ui.button(ui.screen(page, 'login'), 'Enter orbit').click();
}

test('a signed-in session lands on the overview and reports a trust score it can justify', async ({ page }) => {
  await signIn(page);

  const overview = ui.screen(page, 'overview');
  await expect(overview).toBeVisible();

  const trust = page.getByRole('article', { name: 'Trust score' });
  await expect(trust).toBeVisible();

  /*
   * Every component that fed the score is named on screen. This is the property
   * that keeps the figure honest: a bare number could be anything, but a number
   * shown beside its inputs can be checked.
   */
  for (const label of [
    'Leaked credentials', 'Verified capabilities', 'Upload scanning', 'Recovery points',
    'Credential reach', 'Private repositories'
  ]) {
    await expect(trust).toContainText(label);
  }

  /*
   * Each reading comes from the posture the server reported, not from what
   * the provider could offer: the credential is described as the token it
   * is, and recovery counts the recovery point that exists.
   */
  await expect(trust).toContainText('Fine-grained token limited to the repositories chosen for it');
  await expect(trust).toContainText('The connected repository has a recovery point');
  await expect(trust).toContainText('No open leaked credentials; the connected repository was scanned');
  await expect(trust.locator('.wp-grade')).toHaveAttribute('aria-label', /^Grade [A-F]$/);

  /*
   * State never rides on colour alone: each component carries a word for its
   * reading, so the card survives a mono print and forced-colours mode.
   */
  await expect(trust.locator('.wp-mark-word').first()).toBeVisible();

  /* The underlying numbers are reachable as a table, not only as bars. */
  const numbers = trust.getByRole('group').first();
  await numbers.getByText('Show the numbers').click();
  await expect(trust.getByRole('table', { name: /Trust score components/i })).toBeVisible();

  const signals = page.getByRole('article', { name: 'Capabilities' });
  await expect(signals).toBeVisible();
  await expect(signals).toContainText('Verified');
  await expect(signals).toContainText('CAPABILITIES');

  /* Nothing on the overview claims more than the session established. */
  await expect(page.locator('#ovCoreLive')).toHaveText('Connected');
  await expect(page.locator('#ovCoreLine')).toHaveText(/^Grade [A-F] \u00b7 \d{1,3}\/100 \u00b7 /);
  await expect(page.locator('#navBoundary')).toHaveAttribute('data-state', 'online');
  await expect(page.locator('#navBoundary')).toContainText('Boundary online');
  await expect(page.locator('#ovPulseGrid')).toContainText('Verified capabilities');
  await expect(page.locator('#ovPulseGrid')).not.toContainText('Live signals');

  await expect(page.getByRole('article', { name: 'Repository activity' })).toBeVisible();
});

test('an open critical leak caps the score and says why', async ({ page }) => {
  await mockPublicAlphaApi(page, {
    access: 'required', ready: 'ready', provider: 'github', repositoryState: 'current', postureState: 'critical-leak'
  });
  await page.goto('/');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-provider-credential');
  await ui.button(ui.screen(page, 'login'), 'Enter orbit').click();

  const trust = page.getByRole('article', { name: 'Trust score' });
  await expect(trust).toContainText('1 leaked credential still exposed (1 critical)');
  await expect(trust).toContainText('Held below 50 while a critical leaked credential is still exposed');
  const figure = Number((await trust.locator('.wp-dial .wp-gauge-figure').first().textContent()).trim());
  expect(figure).toBeLessThanOrEqual(49);
  await expect(trust.locator('.wp-grade')).toHaveAttribute('aria-label', 'Grade F');
  await expect(page.locator('#ovCoreLine')).toContainText('capped by a critical leak');
});

test('the overview never invents a figure it could not measure', async ({ page }) => {
  await signIn(page);
  const trust = page.getByRole('article', { name: 'Trust score' });
  await expect(trust).toBeVisible();

  /*
   * Whatever the fixture provides, the card must never print a bare zero for a
   * signal it could not read -- "not measured" and "measured and failing" are
   * different claims, and only one of them is an accusation.
   */
  const figure = trust.locator('.wp-dial .wp-gauge-figure').first();
  const shown = (await figure.textContent()).trim();
  /*
   * The score is drawn inside its own dial now. An unmeasured score shows an em
   * dash rather than a zero, and the arc that would carry a reading is not
   * drawn at all -- a zero-length arc is a reading of zero, and "not measured"
   * is not zero.
   */
  expect(shown === '\u2014' || /^\d{1,3}$/.test(shown)).toBeTruthy();
  const arcs = await trust.locator('.wp-dial .wp-gauge-arc').count();
  if (shown === '\u2014') {
    expect(arcs).toBe(0);
  } else {
    expect(Number(shown)).toBeGreaterThan(0);
    expect(Number(shown)).toBeLessThanOrEqual(100);
    expect(arcs).toBe(1);
  }
});

/*
 * Every reading on this page is an arc now, and an arc is stroked, not filled.
 * The state classes the legend swatches use also set `fill`, and a class rule
 * outranks a presentation attribute -- so reusing them on the ring turned each
 * arc into a filled disc and the donut rendered solid. This reads the computed
 * fill rather than the markup, because the markup said fill="none" the whole
 * time it was wrong.
 */
test('every reading is drawn as a stroked arc, never a filled disc', async ({ page }) => {
  await signIn(page);
  /*
   * The cards paint from a model that is assembled after the inventory and the
   * scanner posture land, so counting straight after sign-in counts nothing and
   * the check passes an empty page as clean. Wait for the reading to exist
   * before asserting anything about how it is drawn.
   */
  await expect(page.getByRole('article', { name: 'Trust score' })).toBeVisible();
  const arcs = page.locator('.wp-gauge-arc, .wp-gauge-track, .wp-donut-arc, .wp-donut-track');
  await expect(arcs.first()).toBeAttached();
  const count = await arcs.count();
  expect(count).toBeGreaterThan(3);
  for (let index = 0; index < count; index += 1) {
    const painted = await arcs.nth(index).evaluate(node => {
      const style = getComputedStyle(node);
      return { fill: style.fill, stroke: style.stroke, width: parseFloat(style.strokeWidth) };
    });
    expect(painted.fill).toMatch(/^(none|rgba\(0, 0, 0, 0\))$/);
    expect(painted.stroke).not.toBe('none');
    expect(painted.width).toBeGreaterThan(0);
  }
});

/*
 * The activity plot is drawn into a card that clips its overflow. A series that
 * is mostly zero with one recent push -- the ordinary case for a session with a
 * single repository -- laid its baseline on the bottom of the frame and its
 * spike on the right edge, so the whole reading disappeared into the border and
 * left one stray vertical line behind. The guard is geometric: every plotted
 * point has to sit inside the frame, not on it.
 */
test('the activity plot is drawn inside its frame, not along the edges', async ({ page }) => {
  await signIn(page);
  const activity = page.getByRole('article', { name: 'Repository activity' });
  await expect(activity).toBeVisible();

  const chart = activity.locator('svg.wp-area');
  await expect(chart).toBeVisible();

  const box = await chart.evaluate(node => {
    const view = node.getAttribute('viewBox').split(/\s+/).map(Number);
    /*
     * Sampled along the rendered curve rather than read off its control
     * points. The series is a path now, and a curve can leave the interval
     * its endpoints define -- so checking the points it was built from would
     * be checking the one part of the shape that cannot be wrong.
     */
    const line = node.querySelector('path.wp-area-line');
    const total = line.getTotalLength();
    const points = [];
    for (let at = 0; at <= total; at += total / 240) {
      const point = line.getPointAtLength(at);
      points.push({ x: point.x, y: point.y });
    }
    return { width: view[2], height: view[3], points };
  });

  expect(box.points.length).toBeGreaterThan(1);
  for (const point of box.points) {
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(box.width);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(box.height);
  }

  /* And it has to use the height it was given, not collapse onto one level.
     Rounded, because sampling a curve returns fractional positions that would
     make a flat line look like hundreds of distinct levels. */
  const levels = new Set(box.points.map(point => Math.round(point.y)));
  expect(levels.size).toBeGreaterThan(1);

  /*
   * The frame itself has to be inside the card. It was pinned to the bottom of
   * a positioned body element rather than the card, which put it above the
   * card's top edge and ran its line through the caption -- a chart that is
   * geometrically correct and still drawn in the wrong place.
   */
  const card = await activity.boundingBox();
  const plot = await chart.boundingBox();
  expect(plot.y).toBeGreaterThanOrEqual(card.y);
  expect(plot.y + plot.height).toBeLessThanOrEqual(card.y + card.height + 1);
  expect(plot.height).toBeGreaterThan(40);
});
