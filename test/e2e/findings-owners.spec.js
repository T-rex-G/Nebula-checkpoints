'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * The findings inbox read again while each repository's owners are still
 * being read: the owners belong to the repository, not to the read, so they
 * are kept and shown rather than left unread for good; and a finding's
 * record that the server answered without its events is said as unread, not
 * as nobody having decided; a record that is answered names each
 * decision's day and kind; and the inbox one account read is never shown to
 * the next.
 */

const inboxReads = page => {
  const asked = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/workspace/findings') asked.push(request.url()); });
  return asked;
};

test('Refresh while the owners are read keeps them, and the rows name their owners', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  const reads = inboxReads(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let asked = 0;
  await page.route(url => new URL(url).pathname.endsWith('/codeowners'), async route => { asked += 1; if (asked === 1) await gate; return route.fallback(); });
  await page.goto('/#/findings');
  const root = page.locator('#findingsRoot');
  const rows = root.locator('.fi-item');
  await expect(rows).toHaveCount(4);
  await expect.poll(() => asked).toBeGreaterThan(0);
  await page.locator('#findingsRefresh').click();
  await expect.poll(() => reads.length).toBe(2);
  release();
  await expect(rows.nth(0).locator('.fi-owner')).toHaveText('Owner @sandbox/web');
});

test('a record answered without its events is said as unread, not as nobody deciding', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(url => new URL(url).pathname.endsWith('/triage-events'), route => route.fulfill({ json: { available: true } }));
  await page.goto('/#/findings');
  const row = page.locator('#findingsRoot .fi-item[data-state="regressed"]');
  await row.locator('summary').click();
  await expect(row.locator('.fi-decisions')).toContainText('The team\u2019s decisions about this finding could not be read here.');
  await expect(row.locator('.fi-decisions')).not.toContainText('Nobody has decided anything about this finding.');
});

test('a record names each decision\u2019s day and kind, and who made it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(url => new URL(url).pathname.endsWith('/triage-events'), route => route.fulfill({ json: { events: [
    { event: 'decided', disposition: 'accepted-risk', reason: 'compensating-control', actor: 'ada', at: '2026-11-20T10:00:00Z' }] } }));
  await page.goto('/#/findings');
  const row = page.locator('#findingsRoot .fi-item[data-state="regressed"]');
  await row.locator('summary').click();
  const decision = row.locator('.fi-decisions li').first();
  await expect(decision).toContainText('Accepted the risk by ada \u2014 compensating control');
  await expect(decision.locator('time')).toHaveAttribute('datetime', '2026-11-20T10:00:00Z');
  await expect(decision.locator('time')).toHaveText(/2026/);
});

test('the inbox one account read is read again for the next, not shown to it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  const second = { login: 'second-github', name: 'Second Account', avatar: '', provider: 'github', authMethod: 'token', offlineCacheScope: 'second-account-scope-0123456789',
    caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true } };
  let switched = false;
  await page.route('**/api/accounts', route => route.fulfill({ json: { active: 0, accounts: [{ login: 'alpha-tester', provider: 'github' }, { login: 'second-github', provider: 'github' }] } }));
  await page.route('**/api/accounts/switch-idx', route => { switched = true; return route.fulfill({ json: { ok: true, login: 'second-github' } }); });
  await page.route('**/api/me', route => (switched ? route.fulfill({ json: second }) : route.fallback()));
  const reads = inboxReads(page);
  await page.goto('/#/findings');
  await expect(page.locator('#findingsRoot .fi-item')).toHaveCount(4);
  expect(reads.length).toBe(1);
  await page.locator('#findingsHomeBtn').click();
  await expect(page.locator('#ovWho')).toHaveText('Alpha Tester');
  await ui.button(page, 'Accounts').click();
  await ui.dialog(page, 'Accounts').getByRole('button', { name: 'Switch' }).click();
  await expect(page.locator('#ovWho')).toHaveText('Second Account');
  /* The rail is standing chrome on a desk and a drawer on a phone. */
  const menu = page.locator('.page.active .nav-menu-btn');
  if (await menu.isVisible()) await menu.click();
  await page.locator('#navRail [data-rail="findings"]').click();
  await expect(page.locator('#page-findings')).toHaveClass(/active/);
  await expect.poll(() => reads.length).toBe(2);
});
