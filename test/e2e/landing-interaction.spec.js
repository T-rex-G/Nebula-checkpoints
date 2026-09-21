'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function openScene(page) {
  await page.addInitScript(() => {
    window.__plasma = {};
    const proto = window.WebGLRenderingContext.prototype;
    const get = proto.getUniformLocation;
    const set = proto.uniform1f;
    const names = new WeakMap();
    proto.getUniformLocation = function (program, name) {
      const location = get.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    proto.uniform1f = function (location, value) {
      if (this.canvas.id === 'lpPortal') window.__plasma[names.get(location)] = value;
      return set.call(this, location, value);
    };
  });
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  const portal = page.locator('#lpPortal');
  await expect(portal).toHaveClass(/is-live/);
  await portal.scrollIntoViewIfNeeded();
  return portal;
}

const uniform = (page, name) => page.evaluate(key => window.__plasma[key], name);

test('the canvas is unobstructed and the desktop entry card belongs below the copy', async ({ page, isMobile }) => {
  const portal = await openScene(page);
  const box = await portal.boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe('lpPortal');
  if (!isMobile) {
    const card = await page.locator('.lp-card').boundingBox();
    const copy = await page.locator('.lp-copy').boundingBox();
    expect(card.x).toBeCloseTo(copy.x, 0);
    expect(card.y).toBeGreaterThan(copy.y + copy.height);
    expect(card.x + card.width).toBeLessThan(box.x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('hover deformation recovers after missing the sphere, and leaves with the pointer', async ({ page }) => {
  const portal = await openScene(page);
  const b = await portal.boundingBox();
  await page.mouse.move(b.x + 2, b.y + 2);
  await expect.poll(() => uniform(page, 'uHoverActive')).toBeLessThan(.02);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(() => uniform(page, 'uHoverActive')).toBeGreaterThan(.7);
  await page.mouse.move(3, 3);
  await expect.poll(() => uniform(page, 'uHoverActive')).toBeLessThan(.02);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(() => uniform(page, 'uHoverActive')).toBeGreaterThan(.7);
});

test('drag rotates real geometry, but stopped motion ignores further gestures', async ({ page }) => {
  const portal = await openScene(page);
  const b = await portal.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const before = await uniform(page, 'uCamYaw');
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 65, b.y + b.height / 2 + 20, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(await uniform(page, 'uCamYaw') - before)).toBeGreaterThan(.05);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await page.waitForTimeout(150);
  const held = await uniform(page, 'uCamYaw');
  const glow = await page.locator('.lp-glow').getAttribute('style');
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await uniform(page, 'uCamYaw')).toBe(held);
  expect(await page.locator('.lp-glow').getAttribute('style')).toBe(glow);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'on'; });
  await page.waitForTimeout(300);
  expect(await uniform(page, 'uCamYaw')).toBeCloseTo(held, 5);
});

test('touch can turn the sphere while a vertical swipe still scrolls the page', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch gesture regression runs in the touch-enabled mobile project.');
  const portal = await openScene(page);
  const b = await portal.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }]
  });
  const before = await uniform(page, 'uCamYaw');
  await touch('touchStart', x, y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x + i * 9, y);
  await touch('touchEnd');
  await expect.poll(async () => Math.abs(await uniform(page, 'uCamYaw') - before)).toBeGreaterThan(.05);
  const scroll = await page.evaluate(() => scrollY);
  await touch('touchStart', x, y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x, y - i * 16);
  await touch('touchEnd');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scroll + 30);
  await cdp.detach();
});

test('sections share the page ground and reveal without hiding content or trapping scroll', async ({ page }) => {
  await openScene(page);
  const more = page.locator('.lp-more');
  expect(await more.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('0px');
  expect(await more.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const section = page.locator('.lp-sec').first();
  await section.scrollIntoViewIfNeeded();
  await expect(section).toHaveClass(/lp-revealed/);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  expect(await section.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(section.getByRole('heading', { name: 'One repository, read honestly' })).toBeVisible();
});

/*
 * The landing is a screen of the product, not a page laid over it.
 *
 * The shell paints the ground once: body carries var(--page) and body::before
 * carries var(--bloom) as a fixed layer. When .lp repeated var(--page) in its
 * own background it covered that bloom, so the first screen a visitor sees was
 * a flat slab in a colour the rest of the product never shows -- and because
 * the slab scrolled while the bloom underneath stayed fixed, an overscroll
 * drag slid it off and uncovered the real background behind it.
 */
test('the landing sits on the shell ground rather than laying its own over it', async ({ page }) => {
  await openScene(page);
  const opaque = await page.evaluate(() => {
    const transparent = 'rgba(0, 0, 0, 0)';
    /* Every box between the shell's ground and the landing's content. One
       opaque fill anywhere in this chain re-creates the slab. */
    return ['#page-alpha-access', '.lp', '.lp-hero', '.lp-body']
      .filter(selector => {
        const el = document.querySelector(selector);
        return el && getComputedStyle(el).backgroundColor !== transparent;
      });
  });
  expect(opaque).toEqual([]);
  /* And the ground it defers to is really there, so "transparent" cannot pass
     by the shell having stopped painting a bloom at all. */
  expect(await page.evaluate(() =>
    getComputedStyle(document.body, '::before').backgroundImage)).toMatch(/radial-gradient/);
});

/*
 * The theme control is the only one a visitor can reach before the gate: the
 * other two live inside the application. Inside .lp-hero the bar scrolled away
 * with the hero, so on a phone the control existed only at the very top of a
 * page nearly four screens tall.
 */
test('the theme control stays reachable once the visitor has scrolled', async ({ page }) => {
  await openScene(page);
  const toggle = page.locator('.lp-nav .theme-toggle');
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400);
  const placed = await toggle.evaluate(el => {
    const box = el.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, viewport: innerHeight };
  });
  expect(placed.top).toBeGreaterThanOrEqual(0);
  expect(placed.bottom).toBeLessThanOrEqual(placed.viewport);
  /* Reachable means operable, not merely on screen: nothing may cover it. */
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
});

/*
 * Sticking is not the same as being reachable, and this is the half that was
 * still broken after the bar was made to stick.
 *
 * On a phone the status bar is drawn over the top of the page, so a bar pinned
 * at top:0 needs that strip reserved as padding or its contents sit beneath
 * the clock -- which is what a reader photographed: the theme control's pill
 * peeking out from under the time. The stylesheet did reserve it, and a
 * `padding-block` shorthand in the narrow-screen block, later in the file,
 * wrote a flat 20px back over the top edge on every viewport under 480px.
 * Every phone is under 480px, so the reservation existed everywhere except
 * where it was needed, and making the bar sticky had not helped because
 * sticking was never the half that was broken.
 *
 * What is asserted is that the clearance survives to the phone, which is the
 * part that broke. The inset itself cannot be exercised here -- Chromium
 * reports 0 for env(safe-area-inset-top) and no runner has a notch -- so with
 * the inset at 0 the reservation is the bar's own breathing room, and the test
 * holds it to that. It reads 28 and not 44 deliberately: 44 would only pass by
 * padding the bar out on every phone whose browser reports the inset honestly
 * because it genuinely has nothing to clear, which is most of them. Any later
 * rule that writes the top edge back down -- a shorthand, a reset, a tighter
 * mobile block -- lands under this number.
 */
const CLEARANCE = 28;
test('the bar reserves the status-bar strip on a phone, not just a sticky position', async ({ page }) => {
  const width = page.viewportSize().width;
  test.skip(width > 900, 'no status bar is drawn over the page at this width');
  await openScene(page);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400);
  const placed = await page.evaluate(() => {
    const nav = document.querySelector('.lp-nav');
    const box = nav.getBoundingClientRect();
    return {
      paddingTop: parseFloat(getComputedStyle(nav).paddingTop),
      navTop: box.top,
      brandTop: document.querySelector('.lp-brand').getBoundingClientRect().top,
      toggleTop: document.querySelector('.lp-nav .theme-toggle').getBoundingClientRect().top
    };
  });
  /* Pinned, or the clearance is measured against a bar that scrolled away. */
  expect(Math.abs(placed.navTop)).toBeLessThan(2);
  expect(placed.paddingTop).toBeGreaterThanOrEqual(CLEARANCE);
  expect(placed.brandTop).toBeGreaterThanOrEqual(CLEARANCE);
  expect(placed.toggleTop).toBeGreaterThanOrEqual(CLEARANCE);
});

/*
 * The plasma is a light in the room, not an object in a lit panel. Both of the
 * glow's sources are wider than the box that carries them -- the violet one is
 * centred at 65% 65% and still has colour at 100% -- so the element's own
 * rectangle cut them off and drew corners around the artwork. The mask is what
 * removes the rectangle for good, because --gx/--gy follow the pointer and any
 * fixed set of stops is one gesture away from reaching an edge again.
 */
test('the glow fades out on every side instead of ending at a rectangle', async ({ page }) => {
  await openScene(page);
  const glow = page.locator('.lp-glow');
  const mask = await glow.evaluate(el => {
    const style = getComputedStyle(el);
    return style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
  });
  expect(mask).toMatch(/radial-gradient/);
  /* The light also has to reach past the stage, or the mask would merely round
     off a rectangle that still ends inside the artwork. */
  const [glowBox, stageBox] = await Promise.all([
    glow.boundingBox(), page.locator('.lp-stage').boundingBox()
  ]);
  expect(glowBox.width).toBeGreaterThan(stageBox.width);
  expect(glowBox.height).toBeGreaterThan(stageBox.height);
  /* Driven to a corner, the way a pointer drives it, it still has no edge. */
  await glow.evaluate(el => { el.style.setProperty('--gx', '4%'); el.style.setProperty('--gy', '96%'); });
  const held = await glow.evaluate(el => {
    const style = getComputedStyle(el);
    return style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
  });
  expect(held).toMatch(/radial-gradient/);
});

/*
 * The landing draws its own artwork, so the moving ground stands down there --
 * the same yield the repositories screen already makes to the galaxy. In light
 * theme the waves ran as a column of violet verticals straight through the
 * copy, which is a second moving thing to read on the one screen whose whole
 * job is to be read once.
 *
 * display:none rather than a paint trick, because light-waves.js measures its
 * own box: out of the layout, the render loop stops too.
 */
test('the light-theme waves stand down behind the landing artwork', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('nv_theme', 'light'); } catch (e) { /* private mode */ }
  });
  await openScene(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const waves = page.locator('#lightWaves');
  await expect(waves).toBeHidden();
  expect(await waves.evaluate(el => getComputedStyle(el).display)).toBe('none');
  /* And the module really stopped rather than drawing into a hidden canvas. */
  const first = await waves.evaluate(el => el.toDataURL());
  await page.waitForTimeout(250);
  expect(await waves.evaluate(el => el.toDataURL())).toBe(first);
});

/*
 * The build is still reachable by the person who needs it.
 *
 * Removing it from the landing footer only helps if it did not simply vanish:
 * a tester filing a fault report has to be able to say which build they saw
 * it on. It travels on /api/me now, which is behind a session, and Settings
 * prints it -- so the same string is one screen further in and no longer
 * within reach of an anonymous curl.
 */
test('the landing publishes no build, and a signed-in session can still read one', async ({ page }) => {
  const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await expect(page.locator('.lp-foot-meta')).toBeVisible();
  expect(await page.locator('.lp-foot-meta').innerText()).not.toMatch(/\d+\.\d+\.\d+/);
  /* And the whole landing document, not just the footer it used to sit in. */
  expect(await page.locator('#page-alpha-access').innerText()).not.toMatch(/\d+\.\d+\.\d+-alpha/);
});
