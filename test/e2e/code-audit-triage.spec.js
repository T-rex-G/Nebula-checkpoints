'use strict';

/*
 * What a team does with a finding after the audit: decide it is a false
 * positive or accept the risk until a date, with a reason chosen from a list,
 * see it leave the grade and stay listed with its reason, read back who
 * decided what, and reopen it. And the clock every open finding runs on, the
 * remediation card that reads those clocks, and the merge gate a pull request
 * is judged by before anybody presses Merge.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { mockMediumRepo } = require('./medium-repo-fixtures');
const { evaluateMergeGate } = require('../../src/code-audit-triage');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

const SQL = 'A SQL statement is built';

async function auditedPane(page, scenario = {}) {
  const state = await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', ...scenario });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d{1,3} out of 100$/);
  return { pane, state };
}

/* The open findings list, apart from the team's decisions and the waivers listed beneath it. */
const openItem = (pane, text) => pane.locator('.audit-findings .audit-item', { hasText: text });

test('a reviewer marks a finding a false positive, reads back who decided, and reopens it', async ({ page }) => {
  const { pane, state } = await auditedPane(page);
  const item = openItem(pane, SQL).first();
  await item.locator('summary').click();
  await item.getByRole('button', { name: 'Triage' }).click();

  const dialog = ui.dialog(page, 'Triage this finding');
  await expect(dialog).toContainText(SQL);
  /* A reason is chosen, never written: there is no free-text field. */
  await expect(dialog.locator('textarea, input[type="text"]')).toHaveCount(0);
  await dialog.getByRole('radio', { name: /False positive/ }).check();
  await dialog.getByLabel('Reason').selectOption('validated');
  await expect(dialog.locator('#triageDaysWrap')).toBeHidden();
  await dialog.getByRole('button', { name: 'Record decision' }).click();

  await expect(ui.status(page, 'Notifications')).toContainText('Recorded as a false positive');
  await expect(openItem(pane, SQL)).toHaveCount(0);
  const triaged = pane.locator('.audit-waived', { hasText: 'Triaged by the team' });
  await expect(triaged).toContainText('1');
  await triaged.locator('summary').first().click();
  await expect(triaged).toContainText(SQL);
  await expect(triaged).toContainText('The value is checked before it is used');
  expect([...state.triage.values()].map(decision => [decision.disposition, decision.reason, decision.decidedBy]))
    .toEqual([['false-positive', 'validated', 'alpha-tester']]);

  /* Who decided what, newest first. */
  await triaged.getByRole('button', { name: /History|Decisions/ }).first().click();
  const history = ui.dialog(page, 'Decisions about this finding');
  await expect(history.locator('.triage-event')).toHaveCount(1);
  await expect(history.locator('.triage-event').first()).toContainText('Marked a false positive — The value is checked before it is used');
  await expect(history.locator('.triage-event').first()).toContainText('alpha-tester');
  await history.getByRole('button', { name: 'Done' }).click();

  /* Taken back, it counts again, and the record says so. */
  await triaged.getByRole('button', { name: /Reopen/ }).first().click();
  await expect(ui.status(page, 'Notifications')).toContainText('Reopened: the finding counts again');
  await expect(openItem(pane, SQL)).toHaveCount(1);
  expect(state.triage.size).toBe(0);
  expect(state.triageEvents.map(event => event.event)).toEqual(['decided', 'reopened']);
});

test('accepting a risk asks for how long, and says when the acceptance lapses', async ({ page }) => {
  const { pane, state } = await auditedPane(page);
  const item = openItem(pane, SQL).first();
  await item.locator('summary').click();
  await item.getByRole('button', { name: 'Triage' }).click();
  const dialog = ui.dialog(page, 'Triage this finding');
  await dialog.getByRole('radio', { name: /Accept the risk/ }).check();
  /* The reasons follow the decision, and the date appears with it. */
  await expect(dialog.getByLabel('Reason').locator('option')).toHaveText([
    'A control elsewhere covers it', 'The impact is low here', 'A fix is scheduled', 'No fix is available yet', 'Vendored or upstream code'
  ]);
  await expect(dialog.locator('#triageDaysWrap')).toBeVisible();
  await dialog.getByLabel('Reason').selectOption('fix-scheduled');
  await dialog.getByLabel('Accept until').selectOption('30');
  await dialog.getByRole('button', { name: 'Record decision' }).click();

  await expect(ui.status(page, 'Notifications')).toContainText('Risk accepted until');
  const decision = [...state.triage.values()][0];
  expect(decision.disposition).toBe('accepted-risk');
  const days = (Date.parse(decision.expiresAt) - Date.parse(decision.decidedAt)) / (24 * 60 * 60 * 1000);
  expect(days).toBe(30);
});

test('a reader sees the team’s decisions and is offered no way to make one', async ({ page }) => {
  const { pane } = await auditedPane(page, { triage: 'reader' });
  const item = openItem(pane, SQL).first();
  await item.locator('summary').click();
  await expect(item).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Triage' })).toHaveCount(0);
});

test('a finding past its deadline says so on itself and in the remediation card', async ({ page }) => {
  const { pane } = await auditedPane(page, { auditClock: 'aged' });
  /* Forty days on, the critical and serious clocks have run out. */
  const chip = openItem(pane, SQL).first().locator('.audit-clock-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/overdue/i);

  const card = pane.locator('.audit-remediation');
  await expect(card.getByRole('heading', { name: 'Remediation' })).toBeVisible();
  const tiles = card.getByRole('list', { name: 'Open findings against their deadlines, and time to fix' });
  const overdue = tiles.getByRole('listitem').filter({ hasText: 'Overdue' });
  await expect(overdue).not.toContainText(/^Overdue\s*0/);
  await expect(card.locator('tr[data-severity="critical"] td[data-label="Overdue"]')).toHaveAttribute('data-alert', 'true');
  await expect(card).toContainText('Clock: 7 days for critical, 30 days for serious, 90 days for warnings');
  await expect(card).toContainText('set your own in .nebulaverse/audit.json');
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
});

test('fresh findings run on track, and a fix shows up as time to fix on the next audit', async ({ page }) => {
  const { pane } = await auditedPane(page);
  const card = pane.locator('.audit-remediation');
  await expect(card.getByRole('listitem').filter({ hasText: 'Overdue' })).toContainText('none past due');
  await expect(card.getByRole('listitem').filter({ hasText: 'Median time to fix' })).toContainText('nothing fixed');
  /* The second audit of the session finds the SQL parameterised: one fix, timed. */
  await pane.getByRole('button', { name: /Audit again|Audit this branch/ }).first().click();
  await expect(card.getByRole('listitem').filter({ hasText: 'Median time to fix' })).toContainText(/1 finding fixed/);
});

/*
 * The merge gate on a pull request: what the latest audit of its head says,
 * after the team's decisions, worked out by the same function the server
 * uses, with an active policy's answer beside it.
 */
async function openPull(page, gate) {
  await page.addInitScript(() => { localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: false, motion: false })); });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await mockMediumRepo(page);
  await page.route('**/api/repo/sandbox/demo/code-audit/gate**', route => route.fulfill({ json: gate }));
  await page.goto('/#/sandbox/demo@main/pulls');
  await expect(page.locator('#tab-pulls')).toBeVisible();
  await page.locator('#prList .list-item').first().click();
  return page.locator('#prGate');
}
const HEAD = 'b'.repeat(40);
const now = Date.now();
const finding = (id, extra) => ({ id: id.repeat(24).slice(0, 24), rule: 'SEC-001', category: 'code', severity: 'critical', verdict: 'confirmed',
  firstSeenAt: new Date(now - 2 * 864e5).toISOString(), waived: null, exploited: false, reach: null, ...extra });
const kept = findings => ({ audit: { grade: 'F', auditedAt: new Date(now - 3600e3).toISOString(), commitSha: HEAD, files: { complete: true }, sla: null }, findings });

test('a pull request whose audited head holds a confirmed critical says why, and what the policy does', async ({ page }) => {
  const gate = evaluateMergeGate({ headSha: HEAD, head: kept([finding('a'), finding('c', { severity: 'serious', category: 'secrets', rule: 'SEC-020' })]),
    base: kept([]), decisions: new Map(), now });
  expect(gate.blocking).toEqual(['critical', 'serious', 'secret', 'introduced']);
  const box = await openPull(page, {
    available: true, pull: { number: 90, head: 'feature/long', base: 'main', headSha: HEAD, fork: false, open: true }, gate,
    enforcement: { available: true, policies: [{ policyKey: 'audit-merge-gate', mode: 'block', effect: 'deny',
      rules: [{ id: 'hold-critical', effect: 'deny', description: 'Hold merges whose audit finds a confirmed critical', audit: true }] }] }
  });
  await expect(box).toHaveAttribute('data-state', 'hold');
  await expect(box.locator('.pr-gate-chip')).toHaveText('4 reasons to hold');
  await expect(box.locator('.pr-gate-reasons li')).toHaveText([
    'An open confirmed critical finding', 'Open confirmed serious findings', 'A credential in the code', '2 serious or critical findings not on the base branch'
  ]);
  await expect(box.locator('.pr-gate-policy')).toHaveText('Policy audit-merge-gate (block) refuses this merge: Hold merges whose audit finds a confirmed critical');
});

test('a pull request whose head nobody audited offers to audit it, and a cleared one passes', async ({ page }) => {
  const missing = evaluateMergeGate({ headSha: HEAD, head: null, base: null, decisions: new Map(), now });
  const box = await openPull(page, { available: true, pull: { number: 90, head: 'feature/long', base: 'main', headSha: HEAD, fork: false, open: true },
    gate: missing, enforcement: { available: true, policies: [] } });
  await expect(box).toHaveAttribute('data-state', 'missing');
  await expect(box.locator('.pr-gate-chip')).toHaveText('Not audited');
  await expect(box).toContainText('You have not audited feature/long');
  await expect(box).toContainText('The Audit merge gate template in Governance does.');

  /* A decision in force clears the gate: the same finding, decided a false positive, no longer holds the merge. */
  const decided = new Map([[finding('a').id, { findingId: finding('a').id, rule: 'SEC-001', disposition: 'false-positive', reason: 'validated', expiresAt: null }]]);
  const cleared = evaluateMergeGate({ headSha: HEAD, head: kept([finding('a')]), base: kept([finding('a')]), decisions: decided, now });
  expect(cleared.blocking).toEqual([]);
  await page.unroute('**/api/repo/sandbox/demo/code-audit/gate**');
  await page.route('**/api/repo/sandbox/demo/code-audit/gate**', route => route.fulfill({ json: {
    available: true, pull: { number: 89, head: 'feature/long', base: 'main', headSha: HEAD, fork: false, open: true }, gate: cleared, enforcement: { available: true, policies: [] } } }));
  await page.locator('#prList .list-item').nth(1).click();
  await expect(page.locator('#prGate')).toHaveAttribute('data-state', 'pass');
  await expect(page.locator('#prGate .pr-gate-chip')).toHaveText('Passes');
});
