'use strict';

/*
 * The overview's core panel as a reader meets it: the rail names the host
 * the session talks to and says "Connected", the line under it states the
 * reading rather than a slogan, and the pointer light follows a fine pointer
 * -- only on a device that can hover, and not at all with motion off.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function overview(page, settings) {
  if (settings) await page.addInitScript(value => { localStorage.setItem('nv_settings', value); }, JSON.stringify(settings));
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
}

test('the rail names the host the session talks to, and the line states the reading', async ({ page }) => {
  await overview(page);
  await expect(page.locator('#ovWho')).toHaveText('Alpha Tester');
  await expect(page.locator('#ovCoreScope')).toHaveText('github.com');
  await expect(page.locator('#ovCoreLive')).toHaveText('Connected');
  await expect(page.locator('#ovCoreLive')).not.toHaveClass(/is-idle/);
  await expect(page.locator('#ovCoreLine')).toHaveText(/^Grade [A-F] \u00b7 \d{1,3}\/100 \u00b7 (every measured signal healthy|\d+ signals? needs? attention)( \u00b7 capped by a critical leak)?\.$/);
  await expect(page.locator('#ovCoreLine')).not.toContainText('Proven by design');
});

/* Where the light is: the two properties the panel's gradient reads, as fractions of the panel. */
const light = core => core.evaluate(element => [element.style.getPropertyValue('--nv-px'), element.style.getPropertyValue('--nv-py')]);

test('the light follows a fine pointer, and only where one can hover', async ({ page }) => {
  await overview(page);
  const core = page.locator('#ovCore');
  await core.scrollIntoViewIfNeeded();
  const box = await core.boundingBox();
  const hover = await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
  const x = box.x + box.width * 0.25;
  const y = box.y + box.height * 0.75;
  await page.mouse.move(x, y);
  if (!hover) {
    /* A phone never pays for the listener, so nothing is written. */
    await page.waitForTimeout(200);
    expect(await light(core)).toEqual(['', '']);
    return;
  }
  /*
   * The pointer keeps moving, as a reader's does: while the cross-fade into
   * the overview runs, the browser hands pointer events to the transition,
   * not to the page, and a single move made then never reaches the panel.
   * Each try ends on the same point, so the light is read there.
   */
  await expect.poll(async () => {
    await page.mouse.move(x + 1, y);
    await page.mouse.move(x, y);
    return (await light(core)).map(value => Math.round(parseFloat(value)));
  }).toEqual([25, 75]);
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.6);
  await expect.poll(async () => (await light(core)).map(value => Math.round(parseFloat(value)))).toEqual([90, 60]);
});

test('with motion off the light stays where it rests', async ({ page }) => {
  await overview(page, { fontSize: 14, wrap: true, motion: false });
  const core = page.locator('#ovCore');
  await core.scrollIntoViewIfNeeded();
  const box = await core.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.waitForTimeout(200);
  expect(await light(core)).toEqual(['', '']);
});

/*
 * The brand in the repositories screen's bar leads back to the overview, at
 * its full 44-pixel target on a desk and on a phone. It once computed to no
 * width at all there and could not be pressed.
 */
test('the brand on the repositories screen leads back to the overview', async ({ page }) => {
  await overview(page);
  await page.locator('#ovGoRepos').click();
  await expect(ui.screen(page, 'repos')).toBeVisible();
  const brand = page.locator('#homeBtn');
  const box = await brand.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await brand.click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
});
