'use strict';

/*
 * The deployed-site check on its own page, for any address: reached from the
 * rail without a repository, followed step by step while it runs, reported
 * with what was checked beside what was found, remembered for the reader
 * under the prefix the account purge removes, and exported without a
 * repository.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/* The rail is standing chrome on a desk and a drawer on a phone, opened from the bar of the screen that is showing. */
async function rail(page, name) {
  const menu = page.locator('.page.active .nav-menu-btn');
  if (await menu.isVisible()) {
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator(`#navRail [data-rail="${name}"]`).click();
}

async function openWebsite(page) {
  const state = await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  /* A signed-in session lands on the overview; the rail is asked for once it is there. */
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await rail(page, 'site');
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  return state;
}

test('any site is checked from the rail, followed step by step, and reported with what was checked', async ({ page }) => {
  await openWebsite(page);
  await expect(page.locator('#navRail [data-rail="site"]')).toHaveAttribute('aria-current', 'page');
  const root = page.locator('#siteRoot');
  const card = root.locator('.audit-site');
  await expect(page.getByRole('heading', { name: 'Website', exact: true })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Check a site' })).toBeVisible();
  await expect(card).toContainText('it is asked only what any visitor’s browser asks, and nothing is submitted, guessed or tried.');

  const address = card.getByLabel('Site address');
  await address.fill('https://demo.example.com/pricing?ref=ad');
  await card.getByRole('button', { name: 'Check site' }).click();
  await expect(card.locator('.audit-site-progress .audit-progress-line')).toHaveText('Reading the site’s JavaScript for secrets and libraries · 2 of 5');
  await expect(card.locator('.audit-site-progress .audit-step[data-step="connect"]')).toHaveAttribute('data-state', 'done');
  await expect(card.locator('.audit-site-progress [role="progressbar"]')).toHaveAttribute('aria-valuetext', 'Reading the site’s JavaScript for secrets and libraries · 2 of 5');

  await expect(card.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade F, \d{1,2} out of 100$/, { timeout: 15000 });
  await expect(card.locator('.audit-origin')).toHaveText('demo.example.com');
  const ledger = card.getByRole('list', { name: 'What was checked' }).getByRole('listitem');
  await expect(ledger).toHaveCount(15);
  await expect(ledger.filter({ hasText: 'Pages read' })).toContainText('2 pages read: /, /pricing');
  await expect(ledger.filter({ hasText: 'JavaScript' })).toContainText('1 of 1 script on this origin read (under 1 KB), no server-side secret in them');
  await expect(ledger.filter({ hasText: 'Source maps' })).toHaveAttribute('data-state', 'warn');
  await expect(card.locator('.audit-site-ledger-sum')).toContainText(/\d+ passed · \d+ failed/);
  /* The state is a word as well as a glyph. */
  await expect(ledger.filter({ hasText: 'Exposed files' }).locator('.sr-only')).toHaveText('Failed: ');

  /* The origin alone is remembered, under the audit prefix the account purge removes. */
  expect(await page.evaluate(() => localStorage.getItem('nv_audit:site-url:standalone'))).toBe('https://demo.example.com');

  /* Exported without a repository. */
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export developer brief' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^demo\.example\.com-site-check-\d{4}-\d{2}-\d{2}\.md$/);
  const text = require('fs').readFileSync(await file.path(), 'utf8');
  expect(text).toContain('# Deployed site: https://demo.example.com');
  expect(text).toContain('| Exposed files | Failed |');
  expect(text).not.toContain('SECRET_KEY');

  /* Checked again once fixed: nothing found, and the comparison says what was resolved. */
  await card.getByRole('button', { name: 'Check again' }).click();
  await expect(card.locator('.audit-grade')).toHaveAttribute('aria-label', 'Site grade A, 100 out of 100', { timeout: 15000 });
  await expect(card).toContainText(/0 new findings, \d+ resolved since the check of/);
  await expect(card.getByRole('list', { name: 'Browser libraries' })).toHaveCount(0);
});

test('a phone reaches the site check from the workbench menu, under Security', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();
  const more = page.locator('#bottomNav button[data-nav="more"]');
  /* The desk has its rail standing; the phone keeps the rest of the workbench in a sheet. */
  test.skip(!(await more.isVisible()), 'the workbench sheet is a phone menu');
  await more.click();
  await page.locator('.sheet-item[data-act="site"]').click();
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  await expect(page.locator('#siteRoot .audit-site').getByLabel('Site address')).toBeVisible();
});

test('an address the check will not request is refused with the reason, and the page survives leaving and returning', async ({ page }) => {
  await openWebsite(page);
  const card = page.locator('#siteRoot .audit-site');
  await card.getByLabel('Site address').fill('http://demo.example.com');
  await card.getByRole('button', { name: 'Check site' }).click();
  await expect(card.getByRole('alert')).toHaveText('Only HTTPS sites can be checked');

  await card.getByLabel('Site address').fill('https://demo.example.com');
  await card.getByRole('button', { name: 'Check site' }).click();
  await expect(card.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade F/, { timeout: 15000 });

  /* Away to the overview and back: the report is still there. */
  await rail(page, 'overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await rail(page, 'site');
  await expect(page.locator('#siteRoot .audit-grade')).toHaveAttribute('aria-label', /^Site grade F/);
});
