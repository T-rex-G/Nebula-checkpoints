'use strict';

/*
 * The chart palette had no light theme, and the overview was shipped in one.
 *
 * --wp-muted, --wp-track and the radar's fill were declared once, under
 * `:root, [data-theme="dark"]`, in colours chosen against the dark shell. A
 * near-white ink over a near-white card is not a faint version of the dark
 * reading, it is no reading: the radar's rings and spokes stopped being drawn
 * and the polygon was left as a shape with no scale behind it. The same token
 * draws the area chart's axis, the bars, the gauge arc, a donut's unknown
 * state and the meter fill, so this was the whole chart surface rather than
 * one chart.
 *
 * Read from the rendered page in both themes and compared, rather than
 * asserted as fixed values, because what matters is that the two themes differ --
 * a test pinning today's hex would pass on a palette that had quietly been
 * flipped back to one value for both.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const repo = (name, language) => ({
  full_name: `acme/${name}`, name, owner: 'acme', private: false, language,
  pushed_at: new Date().toISOString()
});

async function overviewWithRadar(page) {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(/\/api\/repos(\?|$)/, route => route.fulfill({
    json: ['HTML', 'HTML', 'Python', 'Python', 'TypeScript', 'JavaScript']
      .map((language, index) => repo(`r${index}`, language))
  }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await ui.enterRepositories(page);
  await expect(page.locator('.wp-radar')).toBeVisible();
}

/* Perceived lightness, 0 (black) to 255 (white), from an rgb()/rgba() string. */
const luminance = value => {
  const [r, g, b] = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/*
 * Read after the transition, not after a frame.
 *
 * `.btn` transitions box-shadow over .16s, and getComputedStyle during a
 * transition reports the value the animation is currently at -- which, two
 * frames after the theme flips, is still the one it is leaving. A guard
 * written that way reads the old theme's shadow and calls the new theme
 * broken, which is what the first version of this file did: it failed against
 * a fix that a screenshot taken a second later showed working perfectly.
 * Long enough to outlast the transition, and the frame pair still settles the
 * SVG stops, which do not transition.
 */
const SETTLE_MS = 320;

const readTheme = (page, theme) => page.evaluate(async ([name, settle]) => {
  document.documentElement.dataset.theme = name;
  await new Promise(resolve => setTimeout(resolve, settle));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const token = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ring = document.querySelector('.wp-radar-ring');
  const from = document.querySelector('.wp-radar-fill-from');
  const to = document.querySelector('.wp-radar-fill-to');
  const button = document.querySelector('#page-repos .btn-primary');
  return {
    muted: token('--wp-muted'),
    track: token('--wp-track'),
    ringStroke: ring && getComputedStyle(ring).stroke,
    fillFrom: from && Number(getComputedStyle(from).stopOpacity),
    fillTo: to && Number(getComputedStyle(to).stopOpacity),
    buttonShadow: button && getComputedStyle(button).boxShadow
  };
}, [theme, SETTLE_MS]);

test('the chart palette is themed, not reused from the dark surface', async ({ page }) => {
  await overviewWithRadar(page);
  const dark = await readTheme(page, 'dark');
  const light = await readTheme(page, 'light');

  expect(dark.muted, 'the dark chart ink is gone').toBeTruthy();
  expect(light.muted, '--wp-muted is the same in both themes, so one of them is unreadable')
    .not.toBe(dark.muted);
  expect(light.track, '--wp-track is the same in both themes').not.toBe(dark.track);

  /*
   * The direction, not merely a difference: the ink has to be dark on the
   * light surface and light on the dark one, or the two values could differ
   * and still both be near-white.
   */
  expect(luminance(dark.muted), 'the dark theme needs a light ink').toBeGreaterThan(128);
  expect(luminance(light.muted), 'the light theme needs a dark ink').toBeLessThan(128);
});

test('the radar web is drawn against the card it sits on', async ({ page }) => {
  await overviewWithRadar(page);
  const dark = await readTheme(page, 'dark');
  const light = await readTheme(page, 'light');
  expect(luminance(dark.ringStroke)).toBeGreaterThan(128);
  expect(luminance(light.ringStroke),
    'the radar web is near-white on a white card, so the polygon has no scale behind it')
    .toBeLessThan(128);
});

/*
 * Styled from CSS rather than written as attributes, because the theme toggles
 * without redrawing the chart: app.js sets data-theme and does not re-render
 * the overview. A stop carrying a build-time attribute keeps whichever theme
 * was current when it was drawn.
 */
test('the radar fill follows a theme toggled after the chart was drawn', async ({ page }) => {
  await overviewWithRadar(page);
  const dark = await readTheme(page, 'dark');
  const light = await readTheme(page, 'light');
  expect(dark.fillFrom, 'the fill stops are not styleable, so a toggle cannot reach them').toBeGreaterThan(0);
  expect(light.fillFrom,
    'the light surface needs more fill than the dark one to read as the same tint')
    .toBeGreaterThan(dark.fillFrom);
  expect(light.fillTo).toBeGreaterThan(dark.fillTo);
  /* Still a fill, not a second object competing with the stroke. */
  expect(light.fillFrom).toBeLessThan(0.5);
});

test('the primary button carries its own elevation on a light surface', async ({ page }) => {
  await overviewWithRadar(page);
  const dark = await readTheme(page, 'dark');
  const light = await readTheme(page, 'light');
  expect(dark.buttonShadow, 'the primary button lost its elevation').not.toBe('none');
  expect(light.buttonShadow,
    'the deep-violet shadow tuned for the dark shell reads as a dark blob under the button on a light one')
    .not.toBe(dark.buttonShadow);
});
