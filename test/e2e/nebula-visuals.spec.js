'use strict';

/*
 * The artwork is decoration that costs 750KB. The properties worth guarding
 * are not "does it draw" -- a headless runner may have no GPU to draw with --
 * but what happens around it: that a device which cannot draw it never pays
 * for it, and that the interface is whole either way.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/* Every request the page makes for the heavy modules, in order. */
function trackHeavyRequests(page) {
  const seen = [];
  page.on('request', request => {
    const url = request.url();
    if (/three\.(module|core)\.min\.js|nebula-(galaxy|mark-3d)\.js/.test(url)) seen.push(url);
  });
  return seen;
}

async function signIn(page) {
  await mockPublicAlphaApi(page, {
    access: 'required', ready: 'ready', provider: 'github', repositoryState: 'current'
  });
  await page.goto('/');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-provider-credential');
  await ui.button(ui.screen(page, 'login'), 'Enter orbit').click();
}

test('a device without WebGL never downloads the artwork and loses nothing else', async ({ page }) => {
  /*
   * Refuse every WebGL context before any script runs. This is the machine
   * that has no GPU, an old driver, or the context limit already spent.
   */
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(kind, ...rest) {
      if (String(kind).startsWith('webgl') || String(kind) === 'experimental-webgl') return null;
      return original.call(this, kind, ...rest);
    };
  });

  const heavy = trackHeavyRequests(page);
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));

  await signIn(page);
  await expect(ui.screen(page, 'overview')).toBeVisible();
  const repos = await ui.enterRepositories(page);
  await expect(repos).toBeVisible();

  expect(await page.evaluate(() => window.NebulaVisuals.supportsWebGL())).toBe(false);
  expect(heavy, 'nothing heavy may be fetched for a device that cannot draw it').toEqual([]);
  expect(failures, 'a missing context must not throw through the page').toEqual([]);

  /* The panel that hosts the mark keeps its own artwork rather than emptying. */
  await expect(page.locator('#ovCoreArt .ov-core-glow')).toHaveCount(1);
});

test('a metered connection declines the artwork', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      get: () => ({ saveData: true })
    });
  });
  const heavy = trackHeavyRequests(page);

  await signIn(page);
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(await ui.enterRepositories(page)).toBeVisible();

  expect(heavy, 'Save-Data means decoration is the first thing to drop').toEqual([]);
});

test('the artwork hosts are decoration: hidden from readers and out of the way', async ({ page }) => {
  await signIn(page);
  await expect(ui.screen(page, 'overview')).toBeVisible();

  /*
   * Both hosts must be hidden from the accessibility tree. The galaxy also sits
   * behind the hero copy, so it must never take pointer events -- text over it
   * has to stay selectable and every control has to keep its own hit area.
   */
  for (const id of ['#ovCoreArt', '#gxHeroArt']) {
    await expect(page.locator(id)).toHaveAttribute('aria-hidden', 'true');
  }
  await expect(await ui.enterRepositories(page)).toBeVisible();
  await expect(page.locator('#gxHeroArt')).toHaveCSS('pointer-events', 'none');

  /*
   * The hero heading sits over the galaxy and must still be readable text --
   * not a picture of text, and not something the artwork covers.
   */
  await expect(ui.heading(ui.screen(page, 'repos'), /one clear/)).toBeVisible();

  /*
   * Decoration must not grow the page. The artwork is sized past its hero on
   * purpose, and an unclipped overflowing layer extends the scrollable area
   * even though it takes no pointer events -- which moves every control below
   * it out from under where a reader expects it. This caught exactly that: a
   * sign-out button that had slid under the repository grid.
   */
  const overflow = await page.evaluate(() => {
    const art = document.querySelector('#gxHeroArt');
    const root = document.documentElement;
    /*
     * Measured, not reasoned about: the page is sized with the decoration in
     * place and again with it removed. The artwork is deliberately larger than
     * its hero, so what matters is not where its box ends but whether anything
     * downstream can feel it.
     */
    const withArt = { height: root.scrollHeight, width: root.scrollWidth };
    const previous = art.style.display;
    art.style.display = 'none';
    const without = { height: root.scrollHeight, width: root.scrollWidth };
    art.style.display = previous;
    return {
      clipped: getComputedStyle(document.querySelector('.gx-hero')).overflow !== 'visible',
      withArt,
      without
    };
  });
  expect(overflow.clipped, 'the hero must clip its own decoration').toBe(true);
  expect(overflow.withArt, 'decoration must not change the size of the page').toEqual(overflow.without);
});
