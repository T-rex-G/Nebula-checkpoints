'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { riskyResult } = require('./code-audit-risk-fixture');

test.use({ serviceWorkers: 'block' });

/*
 * The audit's kept history read again while what comes with it is still
 * out: a check of the watch, the team's decisions or the clocks that the
 * page let go of never leaves its part of the page waiting for good. And the
 * second press that clears the history is offered for a few seconds only.
 */

const DAY = 24 * 60 * 60 * 1000;
function seed() {
  const full = riskyResult();
  return [{ ...full, commitSha: '3'.repeat(40), ref: 'main', score: 72, grade: 'C', capped: false, capReason: null, auditedAt: new Date(Date.now() - DAY).toISOString(), findings: full.findings.slice(2) }];
}
const path = name => url => new URL(url).pathname === `/api/repo/sandbox/demo/code-audit/${name}`;
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('Refresh while the watch is being checked leaves the watch checked, not "Checking\u2026" for good', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditHistorySeed: seed() });
  const held = gate();
  let asked = 0;
  await page.route(path('watch'), async route => { asked += 1; if (asked === 1) await held.promise; return route.fallback(); });
  await page.goto('/#/sandbox/demo@main/audit');
  const watch = page.locator('#tab-audit .audit-watch');
  await expect(watch.locator('button', { hasText: 'Checking\u2026' })).toBeVisible({ timeout: 15000 });
  await page.locator('#syncBtn').click();
  await expect(page.locator('.toast', { hasText: 'Refreshed' })).toBeVisible();
  held.release();
  await expect(watch.locator('button', { hasText: 'Check now' })).toBeVisible();
  await expect(watch.locator('.audit-watch-state')).toContainText('Last asked of OSV');
});

test('Check now while the team\u2019s decisions and the clocks are being read leaves them read', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditHistorySeed: seed() });
  const held = gate();
  /* The watch answers from what it kept and may be checked again at once. */
  await page.route(path('watch'), async route => {
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, checkableAt: new Date(Date.now() - 1000).toISOString() } });
  });
  await page.route(path('metrics'), async route => { await held.promise; return route.fallback(); });
  const pressed = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/code-audit/watch') && url.searchParams.get('refresh') === '1') pressed.push(url.searchParams.get('ref')); });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  const check = pane.locator('.audit-watch button', { hasText: 'Check now' });
  await expect(check).toBeEnabled({ timeout: 15000 });
  await check.click();
  await expect.poll(() => pressed).toEqual(['main']);
  held.release();
  await expect(pane.locator('.audit-remediation .audit-rem-tiles')).toBeVisible({ timeout: 10000 });
  await expect(pane.locator('.audit-remediation')).not.toContainText('Reading the clocks');
});

test('a first press of Clear history is taken back if the second does not follow', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditHistorySeed: seed() });
  await page.goto('/#/sandbox/demo@main/audit');
  const history = page.locator('#tab-audit .audit-history');
  await history.getByRole('button', { name: 'Clear the kept audits of this repository' }).click({ timeout: 15000 });
  await expect(history.getByRole('button', { name: /^Press again to delete every kept audit/ })).toBeVisible();
  await expect(history.getByRole('button', { name: 'Clear the kept audits of this repository' })).toBeVisible({ timeout: 8000 });
});
