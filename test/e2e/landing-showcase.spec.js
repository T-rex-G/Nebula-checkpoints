'use strict';

/*
 * The landing shows the product rather than describing it.
 *
 * Below the gate: the providers it works against, the audit played at the
 * pace of the scroll, a framed miniature of the Neural view that settles as
 * it scrolls in, what it checks with the code's own counts, the
 * capabilities as a bento, the comparison with what a scan usually does, the
 * three moves, the questions and a closing call that returns the reader to
 * the card. These read what a
 * visitor gets: that each is there, says true things, fits every width, and
 * holds still for a reader who asked for stillness.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { EXPOSURE_RULES } = require('../../src/exposure-rules');
const { ADAPTERS } = require('../../src/credential-verification');
const audit = require('../../src/code-audit');
const site = require('../../src/site-check');

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
  /* Read the rule sets, independently of the markup and animation under test. */
  const counts = [EXPOSURE_RULES.length, Object.keys(ADAPTERS).length,
    Object.keys(audit.RULES).length, Object.keys(site.RULES).length].map(String);
  await expect(values).toHaveText(counts, { timeout: 5000 });
  /* The figures are in the markup, not produced by the count: without script
     a reader still gets them. */
  expect(await values.evaluateAll(els => els.map(el => el.dataset.count))).toEqual(counts);
  await expect(checks.getByRole('heading', { level: 3 })).toHaveText(['Secret detectors', 'Live verifiers', 'Uranus audit rules', 'Deployed-site checks']);
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
  /* At the last move the rail is lit to its end and every move before it is marked as passed. */
  const rail = play.locator('.lp-play-rail');
  await expect(rail).toHaveCount(1);
  await expect(rail).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => rail.evaluate(el => Number(el.style.getPropertyValue('--play-p')))).toBeGreaterThan(0.9);
  expect(await steps.evaluateAll(els => els.map(el => el.classList.contains('is-passed')))).toEqual([true, true, true, false]);
  /* The frame's tab under the ink is the move being played. */
  const inked = () => frame.evaluate(el => {
    const ink = el.querySelector('.lp-au-ink').getBoundingClientRect();
    const tab = [...el.querySelectorAll('[data-tab]')].find(item => {
      const box = item.getBoundingClientRect();
      return Math.abs(box.left - ink.left) < 2 && Math.abs(box.width - ink.width) < 2;
    });
    return tab ? tab.dataset.tab : null;
  });
  await expect.poll(inked).toBe('again');
  /* Scrolling back plays it backwards: the stage follows the reader, not a timer. */
  await steps.nth(1).evaluate(el => el.scrollIntoView({ block: 'center' }));
  await expect(frame).toHaveAttribute('data-stage', 'find');
  await expect.poll(inked).toBe('find');
  expect(await steps.evaluateAll(els => els.map(el => el.classList.contains('is-passed')))).toEqual([true, false, false, false]);
  await expect(frame.locator('.lp-au-cap')).toHaveText('Held below 50 while a confirmed critical finding is open.');
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
    '.lp-ticker-track', '.lp-play-frame [data-only]', '.lp-au-bar i', '.lp-au-sweep'
  ].filter(selector => [...document.querySelectorAll(selector)]
    .some(el => getComputedStyle(el).animationName !== 'none')));
  expect(moving).toEqual([]);
  /* The map's moving layer draws nothing and hands the picture back to the still SVG. */
  const view = page.locator('.lp-show .lp-frame-view');
  await expect(view).toHaveAttribute('data-fx', 'still');
  await expect(view).not.toHaveClass(/has-fx/);
});

/*
 * The hero's ambient motion -- the beam round the entry bar, the floating
 * readings, the title's sheen -- is earned: it runs only once the visuals
 * loader has seen this device keep a steady frame rate (data-ambient="on"). A runner
 * drawing on its CPU never earns it, and the hero is simply still; the same
 * rules run as soon as the attribute is granted.
 */
test('the hero drifts only on a device that has shown it can keep up', async ({ page }) => {
  await openLanding(page);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-ambient', /^(on|off)$/);
  const drifting = () => page.evaluate(() => ['.lp-chip', '.lp-title em']
    .map(selector => getComputedStyle(document.querySelector(selector)).animationName));
  /* No soft blobs of light drift behind the hero: the galaxy is its light. */
  await expect(page.locator('.lp-aurora')).toHaveCount(0);
  if (await root.getAttribute('data-ambient') === 'off') {
    expect((await drifting()).filter(name => /lpFloat|lpSheen/.test(name))).toEqual([]);
    /* Still is not hidden: the readings are there, settled where they float. */
    await expect(page.locator('.lp-chip').first()).toHaveCSS('opacity', '1');
  }
  await page.evaluate(() => { document.documentElement.dataset.ambient = 'on'; });
  const names = await drifting();
  expect(names[0]).toContain('lpFloat');
  expect(names[1]).toBe('lpSheen');
});

/*
 * The map, alive: signals run each strand into the hub on their own canvas,
 * on a phone as on a desk, only while the map is on screen. If the device
 * cannot keep pace, the canvas goes and the still map is the picture.
 */
test('the map moves while it is read, and stops when it is not', async ({ page }) => {
  await openLanding(page);
  const view = page.locator('.lp-show .lp-frame-view');
  await expect(view).toHaveAttribute('data-fx', /paused|still/);
  await view.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await expect(view).toHaveAttribute('data-fx', /running|retired/);
  if (await view.getAttribute('data-fx') === 'retired') {
    await expect(view.locator('canvas.lp-map-fx')).toHaveCount(0);
    return;
  }
  const layer = view.locator('canvas.lp-map-fx');
  await expect(layer).toHaveCount(1);
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  /* It is drawing, and the SVG is not drawing the same motion under it. */
  await expect.poll(() => layer.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) lit++;
    return lit;
  })).toBeGreaterThan(0);
  expect(await view.evaluate(el => [...el.querySelectorAll('.lp-map-flows, .lp-map-arcs')]
    .every(group => getComputedStyle(group).display === 'none'))).toBe(true);
  /* Nothing on it takes a tap or a scroll from the page. */
  expect(await layer.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
  /* Off screen it stops. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(view).toHaveAttribute('data-fx', 'paused');
});

/*
 * The singularity: six systems around one core, lit one by one as the reader
 * scrolls through the section, ending at a gate that is the way in. Every
 * system is in the page from the start; motion only decides when each lights.
 * Each is named for what it is, and only Uranus is called an engine.
 */
test('the systems light as the section is scrolled, and the gate leads to the card', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  const orbit = page.locator('.lp-orbit');
  await expect(orbit.getByRole('heading', { name: /Six systems/ })).toBeAttached();
  await expect(orbit.getByRole('list', { name: 'The systems' }).getByRole('listitem').locator('b'))
    .toHaveText(['Pulsar Map', 'Kepler Twin', 'Quasar Scanner', 'Uranus Engine', 'Parallax Probe', 'Corona Guard']);
  const at = progress => orbit.evaluate((el, p) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * p), progress);
  await at(0);
  await expect.poll(() => orbit.locator('.lp-system[data-on="true"]').count()).toBe(0);
  await at(0.5);
  await expect.poll(() => orbit.locator('.lp-system[data-on="true"]').count()).toBeGreaterThan(1);
  await expect.poll(() => orbit.locator('.lp-system[data-on="true"]').count()).toBeLessThan(6);
  await at(1);
  await expect.poll(() => orbit.locator('.lp-system[data-on="true"]').count()).toBe(6);
  await expect(orbit).toHaveAttribute('data-ready', 'true');
  /* Nothing in the section is wider than the screen. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  /* The gate is the way in: it takes the reader to the invitation and into its first control. */
  await orbit.getByRole('button', { name: 'Enter through the horizon' }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement && !!document.activeElement.closest('.lp-card'))).toBe(true);

  /* With motion off every system is lit wherever the reader is. */
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; window.scrollTo(0, 0); });
  await at(0);
  await expect.poll(() => orbit.locator('.lp-system[data-on="true"]').count()).toBe(6);
});

/*
 * The scene answers to the page, not the other way round. It loads only when
 * its section is on screen, so nothing heavy competes with the entry card at
 * load; and a device that cannot keep up with it -- here a frame held for a
 * second and a half, as a CPU rasteriser does -- loses the scene, not the page:
 * it is taken down, its host marked failed, and the stage keeps the CSS
 * horizon. A WebKit build drawing in software once froze the landing so long
 * its sign-in button could not be pressed.
 */
test('the singularity loads on approach and stands down when the page cannot keep up', async ({ page }) => {
  await page.addInitScript(() => {
    /* Lets the scene mount on this runner: the probe would otherwise refuse its software renderer. */
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      const get = C.prototype.getParameter;
      C.prototype.getParameter = function (p) { return p === 0x9246 || p === 0x1F01 ? 'ANGLE (Test GPU)' : get.call(this, p); };
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, options) {
      return getContext.call(this, kind, options && options.failIfMajorPerformanceCaveat ? { ...options, failIfMajorPerformanceCaveat: false } : options);
    };
    /* A frame that takes a second and a half, a few frames after the scene goes in. */
    new MutationObserver((records, observer) => {
      if (!document.querySelector('#lpOrbitArt nebula-singularity')) return;
      observer.disconnect();
      let frames = 0;
      const stall = () => {
        if (++frames < 3) return requestAnimationFrame(stall);
        const start = performance.now();
        while (performance.now() - start < 1500) { /* a CPU rasteriser's frame */ }
      };
      requestAnimationFrame(stall);
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  const art = page.locator('#lpOrbitArt');
  await page.waitForTimeout(600);
  await expect(art, 'nothing heavy loads with the page').not.toHaveAttribute('data-nebula-mounted', /.+/);
  await page.locator('.lp-orbit').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY + 40));
  await expect(art).toHaveAttribute('data-nebula-mounted', 'failed', { timeout: 15000 });
  await expect(art.locator('nebula-singularity')).toHaveCount(0);
  await expect(page.locator('.lp-orbit')).not.toHaveAttribute('data-drawn', 'true');
  await expect(art.locator('.lp-orbit-fallback')).toBeAttached();
  expect(await page.evaluate(() => window.NebulaVisuals.supportsWebGL()), 'no other piece mounts this session').toBe(false);
});
