'use strict';

/*
 * The landing bar, compact: the brand, the page's sections, one theme icon
 * and the way in. A section link lands its heading below the bar and marks
 * itself as the one being read; the theme icon turns into the other and
 * says so to a screen reader; on a phone the bar is one short row. And the
 * promise under the providers lights a word at a time as it is read.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function open(page) {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
  await page.goto('/');
  await expect(page.locator('.lp-nav')).toBeVisible();
}

test('the bar is one short row and carries the way in', async ({ page }) => {
  await open(page);
  const height = await page.locator('.lp-nav').evaluate(nav => nav.getBoundingClientRect().height);
  const phone = page.viewportSize().width < 940;
  expect(height).toBeLessThanOrEqual(phone ? 60 : 70);
  const cta = page.getByRole('button', { name: 'Enter the alpha' });
  await expect(cta).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await cta.click();
  /* It returns the reader to the entry and puts them in its first control. */
  await expect.poll(() => page.evaluate(() => {
    const box = document.querySelector('.lp-card').getBoundingClientRect();
    return box.top < innerHeight && box.bottom > 0;
  })).toBe(true);
  await expect(page.locator('#alphaInviteInput')).toBeFocused();
});

test('a section link lands its heading below the bar and marks it as being read', async ({ page }) => {
  await open(page);
  const links = page.getByRole('navigation', { name: 'On this page' });
  if (page.viewportSize().width < 940) {
    /* A phone keeps the bar to the brand, the theme and the way in. */
    await expect(links).toBeHidden();
    return;
  }
  await expect(links.getByRole('button')).toHaveText(['Engines', 'Audit', 'Map', 'Coverage', 'Proof', 'FAQ']);
  await links.getByRole('button', { name: 'Coverage' }).click();
  await expect.poll(() => page.evaluate(() => {
    const heading = document.getElementById('lpChecksTitle').getBoundingClientRect();
    const bar = document.querySelector('.lp-nav').getBoundingClientRect();
    return heading.top >= bar.bottom - 1 && heading.top < innerHeight / 2;
  })).toBe(true);
  await expect(links.getByRole('button', { name: 'Coverage' })).toHaveAttribute('aria-current', 'location');
  await expect(links.locator('[aria-current]')).toHaveCount(1);
  /* The ink sits under the link it marks. */
  await expect.poll(() => page.evaluate(() => {
    const ink = document.querySelector('.lp-links-ink');
    const link = document.querySelector('.lp-link[aria-current]');
    const a = ink.getBoundingClientRect();
    const b = link.getBoundingClientRect();
    return ink.classList.contains('is-on') && Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2;
  })).toBe(true);
  /* Back at the top, no section is being read. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(links.locator('[aria-current]')).toHaveCount(0);
});

test('the theme is one icon that turns into the other', async ({ page }) => {
  await open(page);
  const toggle = page.locator('.lp-nav .theme-toggle');
  await expect(toggle).toHaveAttribute('role', 'switch');
  const box = await toggle.boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
  const visible = () => toggle.evaluate(el => [...el.querySelectorAll('.tt-ico')]
    .filter(icon => Number(getComputedStyle(icon).opacity) > 0.5)
    .map(icon => icon.classList.contains('tt-moon') ? 'moon' : 'sun'));
  await expect.poll(visible).toEqual(['moon']);
  /* The icon sits in the middle of its button, not at one end of a track. */
  const centred = await toggle.evaluate(el => {
    const b = el.getBoundingClientRect();
    const i = el.querySelector('.tt-moon').getBoundingClientRect();
    return Math.abs((b.left + b.right) / 2 - (i.left + i.right) / 2) < 2;
  });
  expect(centred).toBe(true);
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(visible).toEqual(['sun']);
});

test('the promise lights a word at a time as it is read, and is whole without motion', async ({ page }) => {
  await open(page);
  const text = page.locator('.lp-statement-text');
  const full = await text.textContent();
  expect(full).toContain('OWASP Top 10:2025');
  const lit = () => text.evaluate(el => {
    const words = el.querySelectorAll('.lp-word-lit');
    return { total: words.length, lit: el.querySelectorAll('.lp-word-lit.is-lit').length };
  });
  /* Off screen, nothing is lit yet. */
  const before = await lit();
  expect(before.total).toBeGreaterThan(30);
  expect(before.lit).toBe(0);
  await text.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, innerHeight * 0.4));
  await expect.poll(async () => (await lit()).lit).toBeGreaterThan(0);
  /* Wrapping words changed nothing a reader or a copy gets. */
  expect(await text.textContent()).toBe(full);
});

test('with motion off the promise is simply there', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('nv_settings', JSON.stringify({ motion: false })); });
  await open(page);
  const words = page.locator('.lp-statement-text .lp-word-lit');
  await expect(words).toHaveCount(0);
  await expect(page.locator('.lp-statement-text')).toHaveCSS('opacity', '1');
});

/*
 * The path under the hero -- 01 Connect, 02 Understand, 03 Prove -- is read as
 * one row, so it has to look like one. Two defects were photographed there:
 * the horizon's rim was drawn straight through the row (across "01" and "03"
 * on a desktop, into the dividers on a phone), and each number sat lower than
 * its title because it spanned two grid rows. The rim's highest point is where
 * it can first touch the row; the baseline is found with a zero-height probe,
 * which sits exactly on it.
 */
test('the horizon passes under the steps, and each number sits on its title', async ({ page }) => {
  /*
   * The settled layout, not a frame of the reveal: the row arrives with a
   * short rise from translateY(18px), and a box read mid-rise is up to 18px
   * lower than where it rests -- which read as the rim crowding the row on a
   * runner that happened to measure during it. Less motion means no rise;
   * any other finite animation is waited out.
   */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect && animation.effect.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => null))));
  const placed = await page.evaluate(() => {
    const horizon = document.querySelector('.lp-horizon');
    const apex = horizon.getBoundingClientRect().top + parseFloat(getComputedStyle(horizon, '::before').top);
    const steps = document.querySelector('.lp-steps').getBoundingClientRect();
    const baseline = el => {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      el.appendChild(probe);
      const y = probe.getBoundingClientRect().top;
      probe.remove();
      return y;
    };
    return {
      clear: apex - steps.bottom,
      rows: [...document.querySelectorAll('.lp-step')].map(step => ({
        number: baseline(step.querySelector('.lp-step-n')),
        title: baseline(step.querySelector('.lp-step-t')),
        titleLeft: step.querySelector('.lp-step-t').getBoundingClientRect().left,
        lineLeft: step.querySelector('.lp-step-d').getBoundingClientRect().left
      }))
    };
  });
  expect(placed.clear).toBeGreaterThanOrEqual(24);
  expect(placed.rows).toHaveLength(3);
  const phone = page.viewportSize().width < 940;
  placed.rows.forEach(row => {
    /* On a phone the number stands above its title; beside it, it shares the line. */
    if (!phone) expect(Math.abs(row.number - row.title)).toBeLessThan(1);
    else expect(row.number).toBeLessThan(row.title);
    expect(Math.abs(row.lineLeft - row.titleLeft)).toBeLessThan(1);
  });
});
