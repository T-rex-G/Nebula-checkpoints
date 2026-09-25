'use strict';

/*
 * Two design presets, one product.
 *
 * Nebula -- violet glass over the nebula -- is the default and the one the
 * product was built in. Obsidian -- stone, near-black or quartz -- is chosen
 * in Settings. A reader reported the first shipping of Obsidian as having
 * replaced Nebula outright, so these tests read both: the default is Nebula,
 * the choice is made by looking, it is revealed rather than cut, it survives
 * a reload without flashing the other preset, and the pieces each preset
 * draws for itself -- the page colour the phone paints around the app, the
 * Trust core, the landing bar -- follow it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

const themeColor = page => page.evaluate(() => document.querySelector('meta[name=theme-color]:not([media])').content);
const design = page => page.evaluate(() => document.documentElement.dataset.design);

async function openOverview(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/');
  await expect(page.locator('#page-overview')).toBeVisible();
}

async function openSettings(page) {
  const button = page.locator('.page.active [title="Settings"]').first();
  await button.click();
  await expect(page.getByRole('radiogroup', { name: 'Design' })).toBeVisible();
}

test('Nebula is the default, and Obsidian is chosen in Settings and kept', async ({ page }) => {
  await openOverview(page);
  expect(await design(page)).toBe('nebula');
  expect((await themeColor(page)).toUpperCase()).toBe('#06030F');

  await openSettings(page);
  const nebula = page.getByRole('radio', { name: /Nebula/ });
  const obsidian = page.getByRole('radio', { name: /Obsidian/ });
  await expect(nebula).toHaveAttribute('aria-checked', 'true');
  await expect(obsidian).toHaveAttribute('aria-checked', 'false');

  await obsidian.click();
  await expect.poll(() => design(page)).toBe('obsidian');
  await expect(obsidian).toHaveAttribute('aria-checked', 'true');
  await expect(nebula).toHaveAttribute('aria-checked', 'false');
  expect((await themeColor(page)).toUpperCase()).toBe('#07080A');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_settings')).design);
  expect(stored).toBe('obsidian');

  /* Restored before the first paint: the head script sets it, not app.js. */
  await page.addInitScript(() => {
    window.__designAtHead = null;
    document.addEventListener('readystatechange', () => {
      if (window.__designAtHead === null) window.__designAtHead = document.documentElement.dataset.design || '';
    });
  });
  await page.reload();
  await expect(page.locator('#page-overview')).toBeVisible();
  expect(await page.evaluate(() => window.__designAtHead)).toBe('obsidian');
  expect(await design(page)).toBe('obsidian');

  /* And back. */
  await openSettings(page);
  await page.getByRole('radio', { name: /Nebula/ }).click();
  await expect.poll(() => design(page)).toBe('nebula');
  expect((await themeColor(page)).toUpperCase()).toBe('#06030F');
});

test('the light theme keeps its preset, and paints the preset\'s own page colour', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nv_theme', 'light');
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: true, motion: true, design: 'obsidian' }));
  });
  await openOverview(page);
  expect(await design(page)).toBe('obsidian');
  expect((await themeColor(page)).toUpperCase()).toBe('#F4F2EE');
  await page.locator('.page.active .theme-toggle').first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await design(page)).toBe('obsidian');
  expect((await themeColor(page)).toUpperCase()).toBe('#07080A');
});

test('a preset change is revealed from the control that asked for it', async ({ page }) => {
  await openOverview(page);
  const supported = await page.evaluate(() => typeof document.startViewTransition === 'function');
  test.skip(!supported, 'this browser has no view transitions; the change is simply made');
  await openSettings(page);
  await page.evaluate(() => {
    window.__reveal = null;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (options && options.pseudoElement === '::view-transition-new(root)') {
        window.__reveal = { frames: JSON.stringify(frames), classed: document.documentElement.classList.contains('vt-reveal') };
      }
      return original.call(this, frames, options);
    };
  });
  await page.getByRole('radio', { name: /Obsidian/ }).click();
  await expect.poll(() => page.evaluate(() => window.__reveal)).not.toBeNull();
  const reveal = await page.evaluate(() => window.__reveal);
  expect(reveal.frames).toContain('circle(0px at');
  expect(reveal.classed).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('vt-reveal'))).toBe(false);
});

test('with motion off the preset changes at once, with no reveal', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: true, motion: false, design: 'nebula' }));
  });
  await openOverview(page);
  await openSettings(page);
  await page.getByRole('radio', { name: /Obsidian/ }).click();
  expect(await design(page)).toBe('obsidian');
  expect(await page.evaluate(() => document.documentElement.classList.contains('vt-reveal'))).toBe(false);
});

test('the Trust core is alive in both presets, and still when motion is off', async ({ page }) => {
  await openOverview(page);
  const motion = () => page.evaluate(() => {
    const running = el => el ? getComputedStyle(el).animationName : 'missing';
    return {
      aura: getComputedStyle(document.querySelector('#ovCoreArt .ov-core-glow'), '::before').animationName,
      auraShown: getComputedStyle(document.querySelector('#ovCoreArt .ov-core-glow'), '::before').display,
      auraPaint: getComputedStyle(document.querySelector('#ovCoreArt .ov-core-glow'), '::before').backgroundImage,
      orbit: running(document.querySelector('#ovCoreArt .oc-orbit')),
      sweep: running(document.querySelector('#ovCoreArt .oc-sweep')),
      float: running(document.querySelector('#ovCoreArt .oc-float'))
    };
  });
  /* Nebula: a still pool of violet under the mark -- no turning wheel of
     colours, which was reported twice as unprofessional -- and the
     instrument moving round it. */
  const nebula = await motion();
  expect(nebula.aura).toBe('none');
  expect(nebula.auraShown).not.toBe('none');
  expect(nebula.auraPaint).not.toMatch(/conic|34, 211, 238|217, 70, 239/);
  expect(nebula.orbit).toBe('oc-turn');

  await page.evaluate(() => { document.documentElement.dataset.design = 'obsidian'; });
  const obsidian = await motion();
  expect(obsidian.auraShown).toBe('none');
  expect(obsidian.orbit).toBe('oc-turn');
  expect(obsidian.sweep).toBe('oc-sweep');
  expect(obsidian.float).toBe('oc-float');

  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  const still = await motion();
  expect(still.orbit).toBe('none');
  expect(still.sweep).toBe('none');
  expect(still.aura).toBe('none');
});

test('the Trust core is the same SVG instrument in both presets, its node riding the arc', async ({ page }) => {
  await openOverview(page);
  const core = () => page.evaluate(() => {
    const art = document.getElementById('ovCoreArt');
    const arc = art.querySelector('.oc-arc').getAttribute('d');
    const end = arc.trim().split(/[\s,A-Za-z]+/).filter(Boolean).slice(-2).map(Number);
    const node = art.querySelector('.oc-node');
    return {
      webgl: art.querySelectorAll('canvas, nebula-mark-3d, nebula-galaxy').length,
      mark: getComputedStyle(art.querySelector('.oc-float')).display,
      gap: Math.hypot(Number(node.getAttribute('cx')) - end[0], Number(node.getAttribute('cy')) - end[1])
    };
  });
  const nebula = await core();
  expect(nebula.webgl).toBe(0);
  expect(nebula.mark).not.toBe('none');
  /* The node sits on the arc's leading end, not a step behind it. */
  expect(nebula.gap).toBeLessThan(1);

  await openSettings(page);
  await page.getByRole('radio', { name: /Obsidian/ }).click();
  await expect.poll(() => design(page)).toBe('obsidian');
  const obsidian = await core();
  expect(obsidian).toEqual(nebula);
});

test('the landing bar has no ground at rest, and a full-width one once the page scrolls', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  await expect(page.locator('.lp-nav')).toBeVisible();
  const scrim = () => page.evaluate(() => {
    const nav = document.querySelector('.lp-nav');
    const after = getComputedStyle(nav, '::after');
    return { stuck: nav.classList.contains('is-stuck'), opacity: Number(after.opacity), width: parseFloat(after.width), viewport: document.documentElement.clientWidth };
  });
  const rest = await scrim();
  expect(rest.stuck).toBe(false);
  expect(rest.opacity).toBe(0);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await scrim()).stuck).toBe(true);
  await expect.poll(async () => (await scrim()).opacity).toBe(1);
  const stuck = await scrim();
  /* As wide as the window, not the content column: no lit strip down either side. */
  expect(stuck.width).toBeGreaterThanOrEqual(stuck.viewport - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await scrim()).stuck).toBe(false);
});

test('a text field is focused on its own edge, not with a ring hung outside it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.goto('/');
  const field = page.getByLabel('One-time invitation');
  await field.focus();
  await page.keyboard.type('x');
  /* The invitation shares one edge with its button, so that edge -- the row
     they sit in -- is the control's own, and is what lights. */
  const ring = await field.evaluate(node => {
    const style = getComputedStyle(node.closest('.lp-entry-row') || node);
    return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth), shadow: style.boxShadow };
  });
  expect(ring.offset).toBe(0);
  expect(ring.width).toBeLessThanOrEqual(1.5);
  expect(ring.shadow).not.toBe('none');
});

test('the Design choices are one radio group: one tab stop, moved with the arrows', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: true, motion: false, design: 'nebula' }));
  });
  await openOverview(page);
  await openSettings(page);
  const nebula = page.getByRole('radio', { name: /Nebula/ });
  const obsidian = page.getByRole('radio', { name: /Obsidian/ });
  await expect(nebula).toHaveAttribute('tabindex', '0');
  await expect(obsidian).toHaveAttribute('tabindex', '-1');
  await nebula.focus();
  await page.keyboard.press('ArrowRight');
  await expect(obsidian).toBeFocused();
  await expect(obsidian).toHaveAttribute('aria-checked', 'true');
  await expect(obsidian).toHaveAttribute('tabindex', '0');
  expect(await design(page)).toBe('obsidian');
  await page.keyboard.press('ArrowLeft');
  await expect(nebula).toBeFocused();
  expect(await design(page)).toBe('nebula');
});
