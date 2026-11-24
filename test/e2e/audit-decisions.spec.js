'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

/*
 * The team's decisions, made from the audit: a decision someone else already
 * took back counts the finding again here too, rather than leaving it listed
 * as decided; and a scoring answered without a score and a grade leaves the
 * grade as it was and says so, rather than drawing a grade of nothing.
 */

const SQL = 'A SQL statement is built';
const openItem = (pane, text) => pane.locator('.audit-findings .audit-item', { hasText: text });

async function decided(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d{1,3} out of 100$/);
  return pane;
}
async function markFalsePositive(page, pane) {
  const item = openItem(pane, SQL).first();
  await item.locator('summary').click();
  await item.getByRole('button', { name: 'Triage' }).click();
  const dialog = ui.dialog(page, 'Triage this finding');
  await dialog.getByRole('radio', { name: /False positive/ }).check();
  await dialog.getByLabel('Reason').selectOption('validated');
  await dialog.getByRole('button', { name: 'Record decision' }).click();
}

test('a decision someone already took back counts the finding again here too', async ({ page }) => {
  const pane = await decided(page);
  await markFalsePositive(page, pane);
  await expect(openItem(pane, SQL)).toHaveCount(0);
  await page.route(url => /\/code-audit\/findings\/[^/]+\/reopen$/.test(new URL(url).pathname), route => route.fulfill({
    status: 404, json: { error: 'That decision is not recorded', code: 'CODE_AUDIT_TRIAGE_NOT_FOUND', correlationId: 'fixture-triage-not-found' }
  }));
  const triaged = pane.locator('.audit-waived', { hasText: 'Triaged by the team' });
  await triaged.locator('summary').first().click();
  await triaged.getByRole('button', { name: /Reopen/ }).first().click();
  await expect(ui.status(page, 'Notifications')).toContainText('That decision was already taken back');
  await expect(openItem(pane, SQL)).toHaveCount(1);
});

test('a scoring answered without a score leaves the grade as it was, and says so', async ({ page }) => {
  const pane = await decided(page);
  const before = await pane.locator('.audit-grade').getAttribute('aria-label');
  await page.route(url => new URL(url).pathname === '/api/code-audit/score', route => route.fulfill({ json: { capped: false } }));
  await markFalsePositive(page, pane);
  await expect(ui.status(page, 'Notifications')).toContainText('The grade will reflect this decision on the next audit');
  await expect(openItem(pane, SQL)).toHaveCount(0);
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', before);
  await expect(pane).not.toContainText('undefined');
});
