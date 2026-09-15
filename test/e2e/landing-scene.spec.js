'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const scale = transform => {
  if (!transform || transform === 'none') return 1;
  const n = transform.match(/-?[\d.]+/g);
  return n ? Number(n[0]) : 1;
};

/*
 * The scene is allowed to fail, and the poster is what is left when it does.
 *
 * That claim was false for a whole release. The poster lived only on the
 * <video> element's poster attribute, and that element is held at opacity 0
 * until `playing` fires -- which, for a reader who asked for less motion,
 * never fires. The unit guard could only ever ask whether the attribute was
 * written; this asks the browser whether anything was painted.
 */
test('a reader who asked for less motion still gets the scene, held still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');

  const poster = page.locator('.lp-poster');
  await expect(poster).toBeVisible();
  await expect(poster).toHaveJSProperty('complete', true);
  const painted = await poster.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(el).opacity),
      area: rect.width * rect.height,
      decoded: el.naturalWidth * el.naturalHeight
    };
  });
  expect(painted.opacity).toBeGreaterThan(0.9);
  expect(painted.area).toBeGreaterThan(10000);
  expect(painted.decoded).toBeGreaterThan(0);

  /* And the video genuinely stood down rather than playing behind it. */
  await page.waitForTimeout(900);
  await expect(page.locator('#lpVideo')).toHaveJSProperty('paused', true);
  expect(await page.locator('#lpVideo').evaluate(el => el.classList.contains('is-playing'))).toBe(false);
});

test('the scene leans in while the reader is in the card and settles when they leave', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  const stage = page.locator('.lp-stage');
  const lp = page.locator('.lp');

  /*
   * At rest before anyone has touched anything -- and the gate autofocuses the
   * invitation, so this is the assertion that caught the moment being applied
   * on the first frame and never coming back.
   */
  const resting = scale(await stage.evaluate(el => getComputedStyle(el).transform));
  expect(resting).toBeCloseTo(1, 2);
  await expect(lp).not.toHaveClass(/is-reaching/);

  /* A real press, not a programmatic focus: the scene answers the reader. */
  await page.locator('#alphaInviteInput').click();
  await expect(lp).toHaveClass(/is-reaching/);
  await expect.poll(
    async () => scale(await stage.evaluate(el => getComputedStyle(el).transform)),
    { timeout: 4000 }
  ).toBeGreaterThan(1.02);

  /* Tabbing within the card holds the lean rather than dropping it per stop. */
  await page.locator('#alphaTermsAccept').focus();
  await expect(lp).toHaveClass(/is-reaching/);

  await page.locator('.lp-title').evaluate(el => { el.tabIndex = -1; el.focus(); });
  await expect(lp).not.toHaveClass(/is-reaching/);
  await expect.poll(
    async () => scale(await stage.evaluate(el => getComputedStyle(el).transform)),
    { timeout: 4000 }
  ).toBeLessThan(1.01);
});

test('the motion switch stands the scene down without taking the state away', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  /*
   * data-motion is published by app.js applySettings(), which runs from boot()
   * -- and boot() is behind the gate, so nothing sets it here. Set it the way
   * the interface would, to prove the override the cascade carries for it.
   */
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await page.locator('#alphaInviteInput').click();
  await expect(page.locator('.lp')).toHaveClass(/is-reaching/);
  await page.waitForTimeout(1800);
  const moved = scale(await page.locator('.lp-stage').evaluate(el => getComputedStyle(el).transform));
  expect(moved).toBeCloseTo(1, 2);
});

test('a reader who asked for less motion gets the state and none of the movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await page.locator('#alphaInviteInput').click();
  await expect(page.locator('.lp')).toHaveClass(/is-reaching/);
  await page.waitForTimeout(1800);
  const moved = scale(await page.locator('.lp-stage').evaluate(el => getComputedStyle(el).transform));
  expect(moved).toBeCloseTo(1, 2);
});

test('the theme control at the gate changes the theme and survives a reload', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');

  const toggle = page.locator('.lp-nav .theme-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  /*
   * The reload is the point. The choice used to be written to localStorage and
   * never read back at the gate, because the only thing that read it ran from
   * boot() -- which is behind the gate. A visitor could toggle the theme and
   * lose it on the very next load.
   */
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.lp-nav .theme-toggle')).toHaveAttribute('aria-checked', 'false');
});

test('the real Settings motion switch stays off at the landing gate after reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const session = await mockPublicAlphaApi(page);
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    window.landingPlayCalls = 0;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.id === 'lpVideo') window.landingPlayCalls++;
      return play.apply(this, args);
    };
  });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  await ui.checkbox(settings, 'Animated nebula background').uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await ui.button(settings, 'Done').click();
  session.accessGranted = false;
  session.providerConnected = false;
  await page.reload();
  await expect(ui.screen(page, 'access')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await page.locator('#alphaInviteInput').click();
  await expect(page.locator('#lpVideo')).toHaveJSProperty('paused', true);
  await expect(page.locator('.lp-poster')).toBeVisible();
  // Cross the observer/animation boundary; this is not just an initial paused value.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.landingPlayCalls)).toBe(0);
});

test('landing playback follows live OS motion and remains stopped behind the gate', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  const video = page.locator('#lpVideo');
  const decodable = await video.evaluate(el => !!(el.canPlayType('video/webm; codecs="vp9"') || el.canPlayType('video/mp4; codecs="avc1.42E01E"')));
  test.skip(!decodable, 'This browser has neither landing-video decoder; poster coverage runs separately.');
  await page.locator('#alphaInviteInput').click();
  // Reaching the invitation scrolls the scene out of view on a phone. Its
  // pause is intentional; bring it back before checking actual playback.
  if (isMobile) {
    await expect(video).not.toBeInViewport();
    await expect(video).toHaveJSProperty('paused', true);
  }
  await video.scrollIntoViewIfNeeded();
  await expect(video).toBeInViewport({ ratio: 0.05 });
  await expect(video).toHaveJSProperty('paused', false);
  await expect(video).toHaveClass(/is-playing/);
  const before = await video.evaluate(el => el.currentTime);
  await expect.poll(() => video.evaluate(el => el.currentTime)).toBeGreaterThan(before);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(video).toHaveJSProperty('paused', true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(video).toHaveJSProperty('paused', false);

  await page.locator('#alphaInviteInput').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect(video).toHaveJSProperty('paused', true);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(video).toHaveJSProperty('paused', true);
});
