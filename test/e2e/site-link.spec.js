'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The deployed site on a repository's audit, and the check it sends to the
 * Website page: a check that ends while the reader is back on the audit is
 * shown there at once, not left "Checking" until something else draws the
 * card; and an answer that does not name the address it checked is said as a
 * failure rather than left running or shown as a result.
 */

const polls = url => new URL(url).pathname === '/api/site-check' && Boolean(new URL(url).searchParams.get('run'));

test('a check that ends while the reader is back on the audit is shown there at once', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let asked = 0;
  await page.route(polls, async route => { asked += 1; if (asked === 2) await gate; return route.fallback(); });
  await page.goto('/#/sandbox/demo@main/audit');
  const card = page.locator('#tab-audit .audit-site-link');
  await expect(card).toContainText('Not checked yet in this session.');
  await card.getByRole('button', { name: 'Check in Parallax' }).click();
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  await expect.poll(() => asked).toBe(2);
  await page.locator('#siteRoot [data-key="site-back"]').click();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Checking on the Website page…');
  await expect(card.getByRole('button', { name: 'Check in Parallax' })).toBeDisabled();
  release();
  await expect(card).not.toContainText('Checking on the Website page…');
  await expect(card.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Open in Parallax' })).toBeVisible();
});

test('an answer that does not name the address it checked is said as a failure', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(polls, route => route.fulfill({ json: { checkedAt: new Date().toISOString(), findings: [] } }));
  await page.goto('/#/sandbox/demo@main/audit');
  const card = page.locator('#tab-audit .audit-site-link');
  await card.getByRole('button', { name: 'Check in Parallax' }).click();
  const root = page.locator('#siteRoot');
  await expect(root).toContainText('The site check answered without the address it checked.');
  await expect(root.getByRole('button', { name: 'Check site' })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('nv_audit:site-url:standalone'))).not.toBe('undefined');
});

/* The rail is standing chrome on a desk and a drawer on a phone, opened from the bar of the screen that is showing. */
async function rail(page, name) {
  const menu = page.locator('.page.active .nav-menu-btn');
  if (await menu.isVisible()) await menu.click();
  await page.locator(`#navRail [data-rail="${name}"]`).click();
}

test('reached from the rail once its check has ended, the Website page is for any address, not the repository an audit sent it from', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  const card = page.locator('#tab-audit .audit-site-link');
  await expect(card).toContainText('Not checked yet in this session.');
  await card.evaluate(node => node.querySelector('[data-key="site-open"]').click());
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  await expect(page.locator('#siteRoot [data-key="site-back"]')).toBeVisible();
  /* A check still running keeps the repository it was sent from; this one is let finish. */
  await expect(page.locator('#siteRoot .audit-grade')).toHaveAttribute('aria-label', /^Site grade /, { timeout: 15000 });
  await rail(page, 'overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await rail(page, 'site');
  await expect(page.locator('#page-site')).toHaveClass(/active/);
  await expect(page.locator('#siteRoot .audit-site')).toBeVisible();
  await expect(page.locator('#siteRoot [data-key="site-back"]')).toHaveCount(0);
  await expect(page.locator('#siteRoot')).not.toContainText('For sandbox/demo');
});
