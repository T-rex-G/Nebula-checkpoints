'use strict';

/*
 * Kept audits. The page shows the last kept grade until it runs an audit of
 * its own, says what has been published about the branch's packages since,
 * charts the score over the audits kept, opens any one of them, and clears
 * them on a second press. Without a database it keeps nothing and says
 * nothing about a history.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { riskyResult } = require('./code-audit-risk-fixture');

test.use({ serviceWorkers: 'block' });

const DAY = 24 * 60 * 60 * 1000;
const COMMITS = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];

/* Three audits of main, a week apart, the grade improving as findings were fixed. */
function seed() {
  const full = riskyResult();
  const now = Date.now();
  return [
    { ...full, commitSha: COMMITS[0], ref: 'main', score: 55, grade: 'F', auditedAt: new Date(now - 15 * DAY).toISOString() },
    { ...full, commitSha: COMMITS[1], ref: 'main', score: 64, grade: 'D', capped: false, capReason: null, auditedAt: new Date(now - 8 * DAY).toISOString(), findings: full.findings.slice(1) },
    { ...full, commitSha: COMMITS[2], ref: 'main', score: 72, grade: 'C', capped: false, capReason: null, auditedAt: new Date(now - 1 * DAY).toISOString(), findings: full.findings.slice(2) }
  ];
}
const ALERTS = [
  { kind: 'exploited', ecosystem: 'npm', name: 'qs', version: '6.7.0', direct: false, dev: false, id: null, cve: 'CVE-2022-24999', severity: null, cvss: null, fixed: null, malicious: false, exploited: true, ransomware: false, kevAdded: '2026-09-28', kevDue: '2026-10-19', epss: 0.41 },
  { kind: 'advisory', ecosystem: 'npm', name: 'express', version: '4.17.1', direct: true, dev: false, id: 'GHSA-rv95-896h-c2vc', cve: 'CVE-2024-29041', severity: 'warning', cvss: 6.1, fixed: '4.19.2', malicious: false, exploited: false, ransomware: false, kevAdded: null, kevDue: null, epss: 0.0012 }
];

test('the last kept audit stands in until the next, and the watch says what was published since', async ({ page }) => {
  const state = await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditHistorySeed: seed(), auditWatchAlerts: ALERTS });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');

  /* The kept grade, said to be kept, with the way to the full report. */
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Grade C, 72 out of 100, from the last audit', { timeout: 15000 });
  await expect(pane.locator('.audit-verdict')).toHaveText(/^Last audited /);
  await expect(pane.locator('.audit-stored-note')).toContainText('Audit again for the full report');
  await expect(pane.locator('.audit-stored-note')).toContainText('3333333');
  await expect(pane.getByRole('button', { name: 'Audit again', exact: true })).toBeVisible();

  /* The watch asked, because the latest check was a day old, and found two things. */
  const watch = pane.locator('.audit-watch');
  await expect(watch.getByRole('heading', { name: 'Since the last audit' })).toBeVisible();
  await expect(watch.locator('.audit-watch-state')).toContainText('2 new items for');
  await expect(watch.locator('.audit-watch-state')).toContainText('Last asked of OSV and CISA’s exploited catalog');
  const rows = watch.locator('.audit-watch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Newly exploited');
  await expect(rows.nth(0)).toContainText('CISA added CVE-2022-24999 to its catalog of vulnerabilities exploited in the wild on 2026-09-28; US federal agencies must fix it by 2026-10-19.');
  await expect(rows.nth(0).getByRole('link', { name: /CISA KEV/ })).toHaveAttribute('href', /search_api_fulltext=CVE-2022-24999$/);
  await expect(rows.nth(1)).toContainText('New advisory');
  await expect(rows.nth(1)).toContainText('Fixed in 4.19.2.');
  await expect(rows.nth(1).getByRole('link', { name: /GHSA-rv95-896h-c2vc/ })).toHaveAttribute('href', 'https://osv.dev/vulnerability/GHSA-rv95-896h-c2vc');
  await expect(page.locator('.toast').filter({ hasText: '2 new items for demo since its last audit' })).toBeVisible();
  expect(state.watchChecks).toBe(1);
  /* Asked moments ago: the control says when it can be asked again rather than asking twice. */
  await expect(watch.getByRole('button', { name: 'Check for new advisories now' })).toBeDisabled();

  /* The trend over the three kept audits, oldest to newest, and the list that is its table. */
  const history = pane.locator('.audit-history');
  await expect(history.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(history.locator('.audit-trend-dot')).toHaveCount(3);
  await expect(history.locator('.audit-trend-caption')).toContainText('Score over the last 3 audits, from 55 (F)');
  await expect(history.locator('.audit-trend-caption')).toContainText('to 72 (C)');
  await history.locator('.audit-trend-dot').nth(1).hover();
  await expect(history.locator('.audit-trend-tip')).toBeVisible();
  await expect(history.locator('.audit-trend-tip')).toContainText('Grade D, 64 · 2222222');
  const kept = history.locator('.audit-hist-row');
  await expect(kept).toHaveCount(3);
  await expect(kept.nth(0)).toContainText('Latest');
  await expect(kept.nth(0).locator('.audit-hist-resolved')).toContainText('1 resolved');
  await expect(kept.nth(2).locator('.audit-hist-tags .nv-chip')).toHaveCount(1);

  /* A point opens its audit, and what that audit kept is its rules, places and packages. */
  await history.locator('.audit-trend-dot').nth(0).click();
  const oldest = kept.nth(2).locator('details');
  await expect(oldest).toHaveAttribute('open', '');
  await expect(oldest.locator('.audit-hist-finding').first()).toBeVisible();
  await expect(oldest.locator('.audit-hist-finding', { hasText: 'jquery 3.4.1 → 3.5.0' })).toContainText('Exploited');

  /* Folding the watch is remembered like every other section. */
  await watch.getByRole('button', { name: 'Collapse Since the last audit' }).click();
  await expect(watch).toHaveAttribute('data-folded', 'true');
});

test('an audit is kept and compared by the server, and a second press clears every kept audit', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane.locator('.audit-history')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d+ out of 100$/, { timeout: 15000 });

  const history = pane.locator('.audit-history');
  await expect(history.locator('.audit-hist-row')).toHaveCount(1);
  await expect(history.locator('.audit-hist-row').first()).toContainText('Shown above');
  await expect(history.locator('.audit-trend-caption')).toHaveText('The trend appears after the next audit of this branch.');
  /* The audit was the watch's first check: nothing is asked again straight away. */
  await expect(pane.locator('.audit-watch-state')).toContainText('Last asked by the audit itself');

  await pane.getByRole('button', { name: 'Audit again', exact: true }).first().click();
  await expect(pane.locator('.audit-diff')).toContainText(/0 new findings, 1 resolved since the audit of /, { timeout: 15000 });
  await expect(history.locator('.audit-hist-row')).toHaveCount(2);
  await expect(history.locator('.audit-hist-row').first().locator('.audit-hist-resolved')).toContainText('1 resolved');

  const clear = history.getByRole('button', { name: 'Clear the kept audits of this repository' });
  await clear.click();
  const confirm = history.getByRole('button', { name: /^Press again to delete every kept audit/ });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.locator('.toast').filter({ hasText: 'Cleared 2 kept audits of demo' })).toBeVisible();
  await expect(pane.locator('.audit-history')).toHaveCount(0);
  await expect(pane.locator('.audit-watch')).toHaveCount(0);
  /* The report on screen is this page's own and stays. */
  await expect(pane.locator('.audit-findings')).toBeVisible();
});

test('without a database nothing is kept, and the comparison is this browser’s own', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', auditHistory: 'unavailable' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade /, { timeout: 15000 });
  await pane.getByRole('button', { name: 'Audit again', exact: true }).first().click();
  await expect(pane.locator('.audit-diff')).toContainText(/0 new findings, 1 resolved since the audit of /, { timeout: 15000 });
  await expect(pane.locator('.audit-history')).toHaveCount(0);
  await expect(pane.locator('.audit-watch')).toHaveCount(0);
});
