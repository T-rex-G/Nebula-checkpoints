'use strict';

/*
 * The activity export, as a reader takes it: asked for from the command
 * palette, downloaded as CSV and opened in a spreadsheet.
 *
 * Every text in it was written by someone else -- a commit message, a pull
 * request's title -- and a spreadsheet runs a cell that begins with =, +, -
 * or @ as a formula. The export writes each such cell with a leading
 * apostrophe, the formula-safe form of apps/web/src/features/workbench/
 * export-safety.js (test/export-safety.test.js), so the file the reader
 * opens shows the text and runs nothing.
 */

const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const SHA = 'f'.repeat(40);
const ACTIVITY = {
  owner: 'sandbox', repo: 'demo', days: 30, generatedAt: '2026-11-01T12:00:00.000Z',
  commits: [{ sha: SHA, message: '=HYPERLINK("https://attacker.example","open me")', author: 'mallory', date: '2026-10-31T09:00:00Z' }],
  pulls: [{ number: 7, title: '+SUM(1,2)', state: 'open', user: 'mallory', updated_at: '2026-10-30T09:00:00Z' }],
  issues: [{ number: 9, title: '@import of a list', state: 'open', user: 'alpha-tester', updated_at: '2026-10-29T09:00:00Z' }],
  releases: []
};

test('the activity CSV writes a cell a spreadsheet would run as text', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo/activity?days=30', route => route.fulfill({ json: ACTIVITY }));
  await page.route('**/api/repo/sandbox/demo/intelligence/events?**', route => route.fulfill({ json: { available: false, events: [] } }));
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);

  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Export recent activity');
  await ui.paletteOption(page, /Export recent activity/).click();
  const dialog = ui.dialog(page, 'Activity export ready');
  await expect(dialog).toContainText('1 commits · 1 PRs · 1 issues · 0 releases');

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('demo-activity-2026-11-01.csv');
  const rows = fs.readFileSync(await file.path(), 'utf8').trim().split('\r\n');
  expect(rows[0]).toBe('"type","id","title","state","actor","timestamp","sha_or_tag","risk_score","severity"');
  expect(rows).toContain(`"commit","${SHA}","'=HYPERLINK(""https://attacker.example"",""open me"")","","mallory","2026-10-31T09:00:00Z","${SHA}","",""`);
  expect(rows).toContain('"pull_request","7","\'+SUM(1,2)","open","mallory","2026-10-30T09:00:00Z","","",""');
  expect(rows).toContain('"issue","9","\'@import of a list","open","alpha-tester","2026-10-29T09:00:00Z","","",""');
});
