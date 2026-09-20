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
