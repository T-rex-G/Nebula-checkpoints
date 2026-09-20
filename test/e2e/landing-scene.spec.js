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
 * Whether the scene is running, and whether it drew anything, measured at the
 * only place that can answer either: the WebGL context.
 *
 * The video this replaced published its own answer -- `paused` -- and these
 * guards read it. The ring has no such property reachable from the page, and
 * giving it one would be a test-only API on a production module. Two instruments
 * stand in, both installed from the test side and neither visible to the page.
 *
 * Comparing screenshots of the canvas was the obvious alternative and it is
 * wrong three ways, each of which cost a red run to find: Playwright scrolls an
 * element into view before photographing it, so measuring an offscreen scene
 * is what starts it; it refuses to photograph a hidden element at all, so the
 * canvas cannot be taken out of the picture for comparison; and the canvas is
 * transparent, so a photograph of it is really a photograph of the bloom and
 * the ground behind it, which move on their own. Counting draws and reading
 * pixels measures the ring and nothing else.
 */
async function instrument(page) {
  await page.addInitScript(() => {
    window.__ringDraws = 0;
    /*
     * preserveDrawingBuffer, forced from here. Without it readPixels is only
     * defined inside the frame that drew, which a test cannot be inside. The
     * page asks for its own attributes and gets them; this adds one that
     * changes what may be read back, never what is drawn.
     */
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (this.id === 'lpPortal' && String(type).indexOf('webgl') === 0) {
        return getContext.call(this, type, Object.assign({}, attrs || {}, { preserveDrawingBuffer: true }));
      }
      return getContext.apply(this, arguments);
    };
    const proto = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype;
    if (!proto) return;
    const drawElements = proto.drawElements;
    proto.drawElements = function (...args) {
      if (this.canvas && this.canvas.id === 'lpPortal') window.__ringDraws += 1;
      return drawElements.apply(this, args);
    };
  });
}

/*
 * Frames the ring drew in a window of time.
 *
 * A held scene draws only when something asks it to redraw: zero on a quiet
 * page, and one or two just after a state change, because standing the scene
 * down repaints the frame it is being held on. So an upper bound is safe to
 * state outright.
 */
const HELD = 6;  /* more than settling has ever needed */

async function draws(page, ms) {
  const before = await page.evaluate(() => window.__ringDraws || 0);
  await page.waitForTimeout(ms || 600);
  const after = await page.evaluate(() => window.__ringDraws || 0);
  return after - before;
}

/*
 * Running, told apart from held by growth rather than by rate.
 *
 * A loop draws for as long as it is given; a held scene draws when something
 * asks it to and then stops. So the window is measured twice, the second one
 * three times the length of the first: a loop roughly triples its count, a
 * held scene does not move. A fixed frame count cannot do this -- the same
 * grid that runs at 60Hz on a GPU manages about 15 on the software rasteriser
 * a CI runner has, and a threshold chosen to separate the two on one machine
 * calls the other one stopped. This was measured, not guessed: the first
 * version of this asserted more than 15 frames in 600ms and reported a
 * perfectly healthy desktop scene as standing still, twice.
 */
async function running(page) {
  const brief = await draws(page, 300);
  const longer = await draws(page, 900);
  return longer > brief + 2;
}

/*
 * How much of the canvas the ring actually covered. A transparent canvas
 * satisfies every measurement of size and opacity there is, so this is the
 * one that fails when the scene is a hole rather than a picture.
 */
async function litPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('lpPortal');
    const gl = canvas && canvas.getContext('webgl');
    if (!gl) return -1;
    /*
     * The whole buffer, not a corner of it. readPixels starts at the bottom
     * left, and on a 1440x900 stage the bottom-left 512x512 is the empty
     * space beside a subject placed to the right -- which reads as a scene
     * that drew nothing at all.
     */
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return 0;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lit = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) lit += 1;
    return lit;
  });
}

/*
 * WebGL can be absent for reasons that are none of the reader's business, and
 * a CI runner without it is one of them. Where it is missing the module hides
 * the canvas by design, which the unit guards cover; these guards are about
 * what a scene does once it exists, so they say so and stand down.
 */
async function ringOrSkip(page) {
  const ok = await page.evaluate(() => {
    const canvas = document.getElementById('lpPortal');
    return !!canvas && !canvas.hidden && !!window.NebulaPlasmaRing;
  });
  test.skip(!ok, 'This build has no WebGL; the no-WebGL path is covered by the unit guards.');
}

/* The scene is allowed to fail, and a held frame is what is left when it does. */
test('a reader who asked for less motion still gets the scene, held still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await instrument(page);
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await ringOrSkip(page);

  /*
   * The claim the poster used to carry, now carried by the scene itself: a
   * reader who asked for less motion gets the picture, not a hole where it
   * would have been. It used to be false for a whole release -- the poster
   * lived on the <video> element's poster attribute, and that element was
   * held at opacity 0 until `playing` fired, which for exactly these readers
   * never fired. So this asks the browser whether anything was painted,
   * never whether an attribute was written.
   */
  const portal = page.locator('#lpPortal');
  await expect(portal).toBeVisible();
  await expect(portal).toHaveClass(/is-live/);
  const painted = await portal.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      opacity: Number(getComputedStyle(el).opacity),
      area: rect.width * rect.height,
      buffer: el.width * el.height
    };
  });
  expect(painted.opacity).toBeGreaterThan(0.9);
  expect(painted.area).toBeGreaterThan(10000);
  expect(painted.buffer).toBeGreaterThan(10000);

  /* And something is actually in it, read back from the buffer itself. */
  expect(await litPixels(page)).toBeGreaterThan(500);

  /* Held, not running: not one further frame in the next second. */
  expect(await draws(page, 900)).toBe(0);
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

test('resizing a stopped scene redraws its held frame without starting a loop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await instrument(page);
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await ringOrSkip(page);
  expect(await litPixels(page)).toBeGreaterThan(500);
  await page.setViewportSize({ width: 820, height: 780 });
  await expect.poll(() => litPixels(page)).toBeGreaterThan(500);
  await page.waitForTimeout(200);
  expect(await draws(page, 500)).toBe(0);
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
  await instrument(page);
  const session = await mockPublicAlphaApi(page);
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
  await ringOrSkip(page);
  await page.locator('#alphaInviteInput').click();
  await expect(page.locator('#lpPortal')).toBeVisible();
  await expect(page.locator('#lpPortal')).toHaveClass(/is-live/);
  // Cross the observer/animation boundary; this is not just an initial state.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await draws(page, 900)).toBe(0);
  /* Still a picture, not a blank rectangle, with the motion setting off. */
  expect(await litPixels(page)).toBeGreaterThan(500);
});

test('the scene follows live OS motion and stands down behind the gate', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await instrument(page);
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  await ringOrSkip(page);
  const portal = page.locator('#lpPortal');

  await page.locator('#alphaInviteInput').click();
  // The redesigned phone puts the card close to the scene. Scroll beyond the
  // artwork explicitly: lifecycle should not depend on the form's position.
  if (isMobile) {
    await page.locator('.lp-foot').scrollIntoViewIfNeeded();
    await expect(portal).not.toBeInViewport();
    expect(await draws(page)).toBe(0);
  }
  await portal.scrollIntoViewIfNeeded();
  await expect(portal).toBeInViewport({ ratio: 0.05 });
  await expect(portal).toHaveClass(/is-live/);
  await expect.poll(() => running(page), { timeout: 7000 }).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await draws(page)).toBeLessThan(HELD);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Media-query notifications and GPU scheduling settle asynchronously.
  // Require sustained drawing, but do not race one particular time window.
  await expect.poll(() => running(page), { timeout: 7000 }).toBe(true);

  /*
   * Through the gate, the scene is behind a screen nobody is looking at. The
   * motion setting is toggled off and on again afterwards because that is the
   * path that used to revive it: a sync() that consulted the setting and
   * forgot to ask whether the landing screen was still the active one.
   */
  await page.locator('#alphaInviteInput').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  /* Crossing the gate stands the scene down, which repaints the held frame
     once on the way past; what it must not do is leave a loop running. */
  expect(await draws(page)).toBeLessThan(HELD);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await draws(page)).toBeLessThan(HELD);
});
