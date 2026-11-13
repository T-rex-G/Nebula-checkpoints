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

/*
 * Every request the page makes for the heavy modules, in order, by the name
 * the build gives each chunk. The pattern once named files the build no longer
 * makes, and so could see no download at all: a device that can draw the
 * artwork below proves it sees one.
 */
const HEAVY = /\/build\/((?:three\.module|nebula-galaxy|nebula-singularity)-[A-Za-z0-9_-]+\.js)$/;
function trackHeavyRequests(page) {
  const seen = [];
  page.on('request', request => {
    const match = HEAVY.exec(new URL(request.url()).pathname);
    /* The chunk's name without the eight characters of its content's hash. */
    if (match) seen.push(match[1].replace(/-[A-Za-z0-9_-]{8}\.js$/, ''));
  });
  return seen;
}

/*
 * The device the loader sees: a GPU, and frames that come every `frameMs`.
 * The runner draws WebGL on its CPU, which the loader rightly refuses, by the
 * browser's refusal and by the renderer's name, and then by its frame budget;
 * presented as a GPU that keeps sixty frames a second, the pieces mount and
 * stay, and presented as one that keeps ten, the budget takes them down --
 * whatever this machine's own speed.
 */
async function presentAsDevice(page, { frameMs }) {
  await page.addInitScript(gap => {
    /* A GPU names itself: RENDERER, and UNMASKED_RENDERER_WEBGL from the debug extension. */
    for (const proto of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!proto) continue;
      const original = proto.prototype.getParameter;
      proto.prototype.getParameter = function getParameter(name) {
        return name === 0x1F01 || name === 0x9246 ? 'Browser Suite Renderer' : original.call(this, name);
      };
    }
    /*
     * And it draws without a major performance caveat, so the browser never
     * refuses a context for one. Chromium 149 refuses it on a runner without
     * a GPU, where 141 handed the context over, so presenting the name alone
     * mounted the pieces on one and nothing on the other.
     */
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, options) {
      return getContext.call(this, kind, options && options.failIfMajorPerformanceCaveat ? { ...options, failIfMajorPerformanceCaveat: false } : options);
    };
    /* One time for every callback of a frame, advanced once per frame the browser draws. */
    const frame = window.requestAnimationFrame.bind(window);
    let drawn = null;
    let clock = null;
    window.requestAnimationFrame = callback => frame(now => {
      if (now !== drawn) { drawn = now; clock = clock === null ? now : clock + gap; }
      callback(clock);
    });
  }, frameMs);
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

  /* The repositories' artwork is not mounted: its host keeps the ground the stylesheet draws. */
  await expect(page.locator('#gxHeroArt')).not.toHaveAttribute('data-nebula-mounted', 'true');
  await expect(page.locator('nebula-galaxy, nebula-singularity')).toHaveCount(0);
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
  await expect(ui.heading(ui.screen(page, 'repos'), 'Choose a repository.')).toBeVisible();

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
  expect(overflow.withArt.width, 'decoration must never widen the page').toBe(overflow.without.width);
  expect(overflow.withArt.height, 'decoration beside the copy must not lengthen the page').toBe(overflow.without.height);
});

test('a device that can draw it downloads the galaxy once, as decoration that holds still for the reader\'s motion setting', async ({ page }) => {
  await ui.underHarness(page);
  await presentAsDevice(page, { frameMs: 16 });
  const heavy = trackHeavyRequests(page);
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  await signIn(page);
  await expect(ui.screen(page, 'overview')).toBeVisible();
  expect(heavy, 'nothing heavy before the screen that draws it is shown').toEqual([]);
  await expect(await ui.enterRepositories(page)).toBeVisible();

  const galaxy = page.locator('#gxHeroArt nebula-galaxy');
  await expect(galaxy).toHaveCount(1);
  await expect(galaxy, 'decoration is announced to nobody').toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#gxHeroArt')).toHaveAttribute('data-nebula-mounted', 'true');
  await expect.poll(() => [...heavy].sort()).toEqual(['nebula-galaxy', 'three.module']);

  /* What the piece is doing, read through the probe: whether it holds a still frame, runs its loop, and how many frames it has drawn. */
  const piece = () => page.evaluate(() => window.__NV_PROBE__.read('artwork').pieces.find(item => item.tag === 'nebula-galaxy'));
  await expect.poll(async () => (await piece()).running).toBe(true);
  const moving = (await piece()).frames;
  await expect.poll(async () => (await piece()).frames, 'it turns while motion is on').toBeGreaterThan(moving + 2);

  /* The reader turns motion off: one still frame, and the loop stops. */
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  const motion = ui.checkbox(settings, 'Animated nebula background');
  await motion.uncheck();
  await expect.poll(async () => (await piece()).held).toBe(true);
  expect((await piece()).running, 'a held frame is not drawn again').toBe(false);
  const held = (await piece()).frames;
  await page.waitForTimeout(400);
  expect((await piece()).frames, 'nothing is drawn while motion is off').toBe(held);

  /* And on again, from where it was held. */
  await motion.check();
  await expect.poll(async () => (await piece()).running).toBe(true);
  await expect.poll(async () => (await piece()).frames).toBeGreaterThan(held + 2);
  await ui.button(settings, 'Done').click();

  /* The system asks for less motion while it is on screen. */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await piece()).held).toBe(true);
  expect((await piece()).running).toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(async () => (await piece()).running).toBe(true);

  await expect(galaxy, 'a device that keeps its frames keeps the piece').toHaveCount(1);
  expect([...heavy].sort(), 'downloaded once').toEqual(['nebula-galaxy', 'three.module']);
  expect(failures).toEqual([]);
});

/*
 * A reader who asked for stillness before a piece arrives: the piece draws
 * its still frame and never starts its loop -- not when it mounts, and not
 * when it comes on screen.
 */
const reading = (page, tag) => page.evaluate(name => window.__NV_PROBE__.read('artwork').pieces.find(item => item.tag === name) || null, tag);
async function heldThroughout(page, tag) {
  await expect.poll(async () => (await reading(page, tag) || {}).held, `the ${tag} holds still for the reader`).toBe(true);
  const still = await reading(page, tag);
  expect(still.frames, `the ${tag} draws its still frame`).toBeGreaterThan(0);
  expect(still.running, `the ${tag} never starts its loop`).toBe(false);
  await page.waitForTimeout(400);
  const after = await reading(page, tag);
  expect(after.running, `the ${tag} never starts its loop`).toBe(false);
  expect(after.frames, `nothing more is drawn while motion is held`).toBe(still.frames);
}

test('the galaxy arriving while the reader holds motion still draws one still frame and never runs', async ({ page }) => {
  await ui.underHarness(page);
  await presentAsDevice(page, { frameMs: 16 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  await expect(await ui.enterRepositories(page)).toBeVisible();
  await expect(page.locator('#gxHeroArt')).toHaveAttribute('data-nebula-mounted', 'true');
  await heldThroughout(page, 'nebula-galaxy');
});

test('the singularity arriving while the reader holds motion still draws one still frame and never runs', async ({ page }) => {
  await ui.underHarness(page);
  await presentAsDevice(page, { frameMs: 16 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  const art = page.locator('#lpOrbitArt');
  await page.locator('.lp-orbit').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY + 40));
  await expect(art).toHaveAttribute('data-nebula-mounted', 'true', { timeout: 15000 });
  await heldThroughout(page, 'nebula-singularity');
});

test('a piece drawn too slowly is taken down for the session, and the interface goes on without it', async ({ page }) => {
  await ui.underHarness(page);
  await presentAsDevice(page, { frameMs: 100 });
  const heavy = trackHeavyRequests(page);
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  await signIn(page);
  await expect(ui.screen(page, 'overview')).toBeVisible();
  const host = page.locator('#gxHeroArt');
  await expect(await ui.enterRepositories(page)).toBeVisible();
  await expect.poll(() => [...heavy].sort()).toEqual(['nebula-galaxy', 'three.module']);
  /* Ten frames a second is a device drawing it on its CPU: the piece is removed and its host marked failed. */
  await expect(host).toHaveAttribute('data-nebula-mounted', 'failed', { timeout: 15000 });
  await expect(page.locator('nebula-galaxy, nebula-singularity')).toHaveCount(0);
  expect(await page.evaluate(() => window.__NV_PROBE__.read('artwork').pieces)).toEqual([]);
  /* The screen keeps its own ground, and the page reads as it does without the artwork. */
  await expect(ui.heading(ui.screen(page, 'repos'), 'Choose a repository.')).toBeVisible();
  await expect(host).toHaveCSS('pointer-events', 'none');
  expect([...heavy].sort(), 'nothing more is fetched this session').toEqual(['nebula-galaxy', 'three.module']);
  expect(failures).toEqual([]);
});
