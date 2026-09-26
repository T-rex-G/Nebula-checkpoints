'use strict';

/*
 * The Audit tab: a grade that rests on what was read, the four families it is
 * built from, findings that open into their reason, fix and prompt, a brief
 * to export, and the comparison with the last audit of the same repository.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function openAudit(page, scenario = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', ...scenario });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  return pane;
}

test('an audit grades the branch, names what it read and explains every finding', async ({ page }) => {
  const pane = await openAudit(page);
  await expect(pane.getByRole('heading', { name: 'Audit', exact: true })).toBeVisible();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');

  await pane.getByRole('button', { name: 'Audit this branch' }).click();

  /* A critical SQL finding holds the grade below 50 and says so. */
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F, \d{1,2} out of 100$/);
  await expect(pane).toContainText('Held below 50 while a critical finding is open.');
  await expect(pane).toContainText(/Read \d+ of \d+ files it audits at a{7}/);

  /* Four families, each with its own reading. */
  const families = pane.getByRole('list', { name: 'Audit families' }).getByRole('button');
  await expect(families).toHaveCount(4);
  await expect(families.nth(1)).toContainText('Code security');

  /* A finding opens into its reason, its fix and a prompt, and never quotes the code. */
  const sql = pane.locator('.audit-item', { hasText: 'A SQL statement is built by string interpolation' });
  await expect(sql).toHaveAttribute('data-severity', 'critical');
  await sql.locator('summary').click();
  await expect(sql).toContainText('Use parameterised queries');
  await expect(sql.getByRole('button', { name: 'Open api/users.js:1' })).toBeVisible();
  await expect(sql.getByRole('button', { name: 'Copy fix prompt' })).toBeVisible();
  await expect(pane).not.toContainText('SELECT * FROM users');

  /* Filtering by a family shows only its findings, and can be undone. */
  await pane.getByRole('button', { name: /Project hygiene/ }).click();
  await expect(pane.getByRole('heading', { name: 'Findings — Project hygiene' })).toBeVisible();
  /* Open-ended versions and no lockfile: the two hygiene findings the project has. */
  await expect(pane.locator('.audit-item')).toHaveCount(2);
  await expect(pane.locator('.audit-item', { hasText: 'SQL' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Show all' }).click();
  await expect(pane.getByRole('heading', { name: 'Findings', exact: true })).toBeVisible();

  /* The developer brief is a Markdown download of the same words. */
  const download = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Export developer brief' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^demo-audit-\d{4}-\d{2}-\d{2}\.md$/);
  const text = require('fs').readFileSync(await file.path(), 'utf8');
  expect(text).toContain('# Security audit: sandbox/demo (main)');
  expect(text).toContain('A SQL statement is built by string interpolation');
  expect(text).not.toContain('SELECT * FROM users');

  /* The next audit compares itself with this one: the SQL is fixed, nothing is new. */
  await pane.getByRole('button', { name: 'Audit again' }).click();
  await expect(pane).toContainText(/0 new findings, 1 resolved since the audit of/);
  await expect(pane.locator('.audit-item', { hasText: 'A SQL statement is built' })).toHaveCount(0);
  await expect(pane.locator('.audit-grade')).not.toHaveAttribute('aria-label', /Grade F/);
});

test('a finding opens its file in the editor at its line', async ({ page }) => {
  const pane = await openAudit(page);
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  const cors = pane.locator('.audit-item', { hasText: 'CORS lets any origin' });
  await cors.locator('summary').click();
  await cors.getByRole('button', { name: /Open server\.js:2/ }).click();
  await expect(page.locator('#tab-editor')).toBeVisible();
});

test('the deployed site is checked anonymously, and the next check shows what was fixed', async ({ page }) => {
  const pane = await openAudit(page);
  const site = pane.locator('.audit-site');
  await expect(site.getByRole('heading', { name: 'Deployed site' })).toBeVisible();
  const address = site.getByLabel('Site address');
  await expect(address).toHaveValue('https://demo.example.com');
  await expect(site).toContainText('Filled in from the repository’s homepage.');

  await site.getByRole('button', { name: 'Check site' }).click();
  await expect(site.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade F, \d{1,2} out of 100$/);
  await expect(site).toContainText(/\d anonymous requests; the page answered 200\./);

  /* The headers a browser enforces, each marked sent or not, and never by colour alone. */
  const headers = site.getByRole('list', { name: 'Security headers' }).getByRole('listitem');
  await expect(headers).toHaveCount(6);
  await expect(headers.filter({ hasText: 'Strict-Transport-Security' })).toContainText('not sent');

  /* A served .env is named by its path and never quoted. */
  const leak = site.locator('.audit-item', { hasText: 'An environment file is served publicly' });
  await expect(leak).toHaveAttribute('data-severity', 'critical');
  await leak.locator('summary').click();
  await expect(leak).toContainText('/.env');
  await expect(leak).toContainText('rotate every value it held');
  await expect(leak.getByRole('button', { name: 'Copy fix prompt' })).toBeVisible();
  await expect(pane).not.toContainText('SECRET_KEY');
  const cookie = site.locator('.audit-item', { hasText: 'cookie' }).first();
  await cookie.locator('summary').click();
  await expect(cookie).toContainText('Set-Cookie: sid');

  /* The origin is remembered for this repository, under the prefix the account purge removes. */
  expect(await page.evaluate(() => localStorage.getItem('nv_audit:site-url:sandbox/demo'))).toBe('https://demo.example.com');

  /* The developer brief carries the site with the repository. */
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-summary .audit-grade')).toHaveAttribute('aria-label', /^Grade F/);
  const download = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Export developer brief' }).click();
  const text = require('fs').readFileSync(await (await download).path(), 'utf8');
  expect(text).toContain('# Deployed site: https://demo.example.com');
  expect(text).toContain('An environment file is served publicly');
  expect(text).not.toContain('SECRET_KEY');

  /* Fixed: the headers are sent and the file is gone. */
  await site.getByRole('button', { name: 'Check again' }).click();
  await expect(site.locator('.audit-grade')).toHaveAttribute('aria-label', 'Site grade A, 100 out of 100');
  await expect(site).toContainText('Nothing found on https://demo.example.com.');
  await expect(site).toContainText('the page answered 200 after 1 redirect.');
  await expect(site).toContainText(/0 new findings, \d+ resolved since the check of/);
  await expect(site.locator('.audit-item')).toHaveCount(0);

  /* An address the check will not request is refused with the reason, not reported clean. */
  await address.fill('http://demo.example.com');
  await site.getByRole('button', { name: 'Check again' }).click();
  await expect(site.getByRole('alert')).toHaveText('Only HTTPS sites can be checked');
});

test('where the provider has no repository reader, the audit says so and the site check still works', async ({ page }) => {
  const pane = await openAudit(page, { provider: 'gitlab' });
  await expect(pane.getByRole('heading', { name: 'Repository audit' })).toBeVisible();
  await expect(pane).toContainText('Not available for this provider yet.');
  await expect(pane).toContainText('No repository reader is implemented for this provider');
  await expect(pane.getByRole('button', { name: 'Audit this branch' })).toHaveCount(0);
  const site = pane.locator('.audit-site');
  await site.getByRole('button', { name: 'Check site' }).click();
  await expect(site.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade F/);
  await expect(site.getByRole('button', { name: 'Export developer brief' })).toBeVisible();
});
