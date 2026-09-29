'use strict';

/*
 * The Audit tab: a grade that rests on what was read, the three jobs to do
 * first, the eight families it is built from, the endpoints a caller can
 * reach, what was covered and what is already in place, the OWASP Top 10 map
 * of the same findings, findings that say whether they are confirmed and open
 * into their reason, traced path, fix, advisories, CWE and prompt, a search
 * over them, a brief, SARIF and CSV to export, and the comparison with the
 * last audit of the same repository.
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

  /* A traced, confirmed critical SQL finding holds the grade below 50 and says so. */
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F, \d{1,2} out of 100$/);
  await expect(pane).toContainText('Held below 50 while a confirmed critical finding is open.');
  await expect(pane.locator('.audit-verdict').first()).toHaveText('1 critical issue to fix');
  /* Confirmed findings are counted apart from leads to confirm, and the engine says how far it followed values. */
  await expect(pane.locator('.audit-split')).toHaveAttribute('aria-label', '7 confirmed, 4 to confirm');
  await expect(pane.locator('.audit-engine-line')).toContainText('Uranus 2.0');
  await expect(pane.locator('.audit-engine-line')).toContainText('3 entry points mapped');
  /* The evidence as figures, the sentence behind them as the strip's name. */
  const evidence = pane.locator('.audit-evidence');
  await expect(evidence).toHaveAttribute('aria-label', /^Read \d+ of \d+ files it audits at a{7} · 3 of 3 packages checked against their registry · 3 of 3 package versions checked against OSV · 3 components in the bill of materials \(npm\) · 2 CVEs checked against CISA KEV 2026\.09\.27 and EPSS \(2 scored\) · 3 of 3 package versions’ licences read\.$/);
  await expect(evidence).toContainText('3 versions');

  /* Three jobs first, no two from the same rule; the first opens its finding. */
  const first = pane.getByRole('list').filter({ has: page.locator('.audit-first-item') }).locator('.audit-first-btn');
  await expect(first).toHaveCount(3);
  await expect(first.nth(0)).toContainText('A SQL statement is built by string interpolation');
  await first.nth(0).click();
  await expect(pane.locator('details[open]', { hasText: 'A SQL statement is built' })).toHaveCount(1);
  await expect(pane.locator('.audit-item', { hasText: 'A SQL statement is built' }).locator('summary')).toBeFocused();

  /* Eight families, each with its own reading; licences are reported, not graded. */
  const families = pane.getByRole('list', { name: 'Audit families' }).getByRole('button');
  await expect(families).toHaveCount(8);
  await expect(families.nth(7)).toContainText('Licences');
  await expect(families.nth(7)).toContainText('Not graded');
  await expect(families.nth(7).locator('.audit-category-meter')).toHaveCount(0);
  await expect(families.nth(1)).toContainText('Code security');
  await expect(families.nth(2)).toContainText('Access control');
  await expect(families.nth(3)).toContainText('Secrets');

  /* The attack surface: every endpoint, the guard in front of it, the open write first. */
  const routes = pane.getByRole('list', { name: 'Endpoints' }).getByRole('listitem');
  await expect(routes).toHaveCount(3);
  await expect(routes.first()).toContainText('POST');
  await expect(routes.first()).toContainText('/users');
  await expect(routes.first()).toContainText('Open');
  await expect(routes.filter({ hasText: '/users/:id' })).toContainText('Signed in');

  /* Coverage says what was traced and what no rule can judge; the controls say what is already right. */
  const ledger = pane.locator('.audit-ledger');
  await expect(ledger.locator('.audit-ledger-item', { hasText: 'Injection' })).toContainText('Traced');
  await expect(ledger.locator('.audit-ledger-item', { hasText: 'Business logic' })).toContainText('Not assessed');
  await expect(pane.locator('.audit-controls')).toContainText('A committed lockfile');

  /* A committed credential is named by its kind, never shown. */
  const secret = pane.locator('.audit-item', { hasText: 'A credential is committed to the repository' });
  await expect(secret).toContainText('Database connection string with its password');
  await expect(pane).not.toContainText('Tr0ub4dor');

  /* A vulnerable version opens into its advisories, each linked to OSV, and the version that fixes them. */
  const vulnerable = pane.locator('.audit-item', { hasText: 'A dependency version has a published vulnerability' });
  await expect(vulnerable).toContainText('lodash 4.17.15 → 4.17.21');
  await vulnerable.locator('summary').click();
  await expect(vulnerable.getByRole('link', { name: /GHSA-35jh-r3h4-6jhm/ })).toHaveAttribute('href', 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm');
  await expect(vulnerable).toContainText('CVE-2021-23337');
  await expect(pane.locator('.audit-item', { hasText: 'one keystroke from a popular package' })).toContainText('crossenv ≈ cross-env');

  /* Severity narrows the list, and All brings it back. */
  const severity = pane.getByRole('group', { name: 'Show by severity' });
  await severity.getByRole('button', { name: /^Critical/ }).click();
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(1);
  await severity.getByRole('button', { name: /^All/ }).click();
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(11);

  /* The verdict narrows it too: the leads, each with what is unknown and how to confirm it. */
  const verdicts = pane.getByRole('group', { name: 'Show by verdict' });
  await verdicts.getByRole('button', { name: /^To confirm/ }).click();
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(4);
  const lead = pane.locator('.audit-item', { hasText: 'A request body is written to the database' });
  await lead.locator('summary').click();
  await expect(lead).toContainText('What is unknown');
  await expect(lead).toContainText('How to confirm');
  await verdicts.getByRole('button', { name: /^Any/ }).click();
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(11);

  /* A finding opens into its reason, its fix and a prompt, and never quotes the code. */
  const sql = pane.locator('.audit-item', { hasText: 'A SQL statement is built by string interpolation' });
  await expect(sql).toHaveAttribute('data-severity', 'critical');
  /* Already open: Fix first opened it. */
  await expect(sql).toContainText('Use parameterised queries');
  /* Filed under its weakness and its OWASP category, each linked to the definition. */
  await expect(sql.getByRole('link', { name: 'CWE-89' })).toHaveAttribute('href', 'https://cwe.mitre.org/data/definitions/89.html');
  await expect(sql.getByRole('link', { name: 'OWASP A05' })).toHaveAttribute('href', 'https://top10.owasp.org/2025/A05_2025-Injection/');
  await expect(sql.getByRole('link', { name: 'Top 25 #2' })).toHaveAttribute('href', 'https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html');
  await expect(sql.getByRole('button', { name: 'Open api/users.js:4', exact: true })).toBeVisible();
  /* Reached through its route, behind a sign-in, and traced from where the value enters to the query. */
  await expect(sql.locator('.audit-reach-line')).toContainText('GET /users/:id');
  await expect(sql.locator('.audit-reach-line')).toContainText('After sign-in');
  await expect(sql.locator('.audit-trace-step')).toHaveCount(2);
  await expect(sql.getByRole('button', { name: 'Open api/users.js:4, step 1 of the traced path' })).toBeVisible();
  await expect(sql.getByRole('button', { name: 'Copy fix prompt' })).toBeVisible();
  await expect(pane).not.toContainText('SELECT * FROM users');

  /* The OWASP map is a filter too, and says clear where nothing sits. */
  const owasp = pane.getByRole('list', { name: 'OWASP Top 10 categories' }).getByRole('button');
  await expect(owasp).toHaveCount(10);
  await expect(owasp.filter({ hasText: 'A10' })).toHaveAccessibleName(/^A10 Exceptional conditions: /);
  await expect(owasp.filter({ hasText: 'A03' })).toHaveAccessibleName(/^A03 Supply chain: /);
  await pane.getByRole('button', { name: /^A05 Injection: \d+ findings?$/ }).click();
  await expect(pane.getByRole('heading', { name: 'Findings — OWASP A05 Injection' })).toBeVisible();
  await expect(pane.locator('.audit-findings .audit-item', { hasText: 'A SQL statement is built' })).toHaveCount(1);
  await pane.getByRole('button', { name: 'Show all' }).click();

  /* The search narrows by rule, file or weakness, keeps focus while typing, and says when nothing matches. */
  const search = pane.getByRole('searchbox', { name: 'Search findings' });
  await search.fill('cwe-89');
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(1);
  await expect(search).toBeFocused();
  await search.fill('no-such-thing');
  await expect(pane.locator('.audit-findings')).toContainText('Nothing matches “no-such-thing”.');
  await search.press('Escape');
  await expect(pane.locator('.audit-findings .audit-item')).toHaveCount(11);

  /* Filtering by a family shows only its findings, and can be undone. */
  await pane.getByRole('button', { name: /Project hygiene/ }).click();
  await expect(pane.getByRole('heading', { name: 'Findings — Project hygiene' })).toBeVisible();
  /* Open-ended versions: the one hygiene finding the project has, now that it commits a lockfile. */
  await expect(pane.locator('.audit-item')).toHaveCount(1);
  await expect(pane.locator('.audit-item', { hasText: 'SQL' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Show all' }).click();
  await expect(pane.getByRole('heading', { name: 'Findings', exact: true })).toBeVisible();

  /* The developer brief is a Markdown download of the same words. */
  const exportButton = pane.locator('.audit-summary').getByRole('button', { name: 'Export', exact: true });
  await exportButton.click();
  await expect(exportButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem')).toHaveCount(5);
  await expect(page.getByRole('menuitem', { name: 'Export developer brief' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(exportButton).toHaveAttribute('aria-expanded', 'false');
  await expect(exportButton).toBeFocused();
  await exportButton.click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export developer brief' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^demo-audit-\d{4}-\d{2}-\d{2}\.md$/);
  const text = require('fs').readFileSync(await file.path(), 'utf8');
  expect(text).toContain('# Security audit: sandbox/demo (main)');
  expect(text).toContain('A SQL statement is built by string interpolation');
  expect(text).toContain('**Fix first:**');
  expect(text).toContain('- **Advisories:** GHSA-35jh-r3h4-6jhm (CVE-2021-23337), GHSA-p6mc-m468-83gw (CVE-2020-8203)');
  expect(text).not.toContain('SELECT * FROM users');
  expect(text).not.toContain('Tr0ub4dor');
  expect(text).toContain('- **Standards:** CWE-89 (SQL Injection) · OWASP A05:2025 Injection · CWE Top 25 (2025) #2');

  /* SARIF for a code-scanning dashboard, CSV for a spreadsheet; neither carries what was read. */
  await exportButton.click();
  const sarifDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export SARIF' }).click();
  const sarifFile = await sarifDownload;
  expect(sarifFile.suggestedFilename()).toMatch(/^demo-audit-\d{4}-\d{2}-\d{2}\.sarif$/);
  const sarif = JSON.parse(require('fs').readFileSync(await sarifFile.path(), 'utf8'));
  expect(sarif.version).toBe('2.1.0');
  const sqlResult = sarif.runs[0].results.find(result => result.ruleId === 'SEC-001');
  expect(sqlResult.codeFlows[0].threadFlows[0].locations).toHaveLength(2);
  expect(sqlResult.properties.verdict).toBe('confirmed');
  expect(JSON.stringify(sarif)).not.toContain('Tr0ub4dor');
  await exportButton.click();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export CSV' }).click();
  const csvText = require('fs').readFileSync(await (await csvDownload).path(), 'utf8');
  expect(csvText.split('\r\n')[0]).toBe('Source,Status,Severity,Verdict,Rule,Title,Detail,Family,CWE,CWE Top 25 (2025),OWASP,Location,Line,Reached through,Risk,Known exploited,EPSS,Dependency reach,How to confirm,Reason waived,Fix');
  expect(csvText).toContain('SEC-001');
  expect(csvText).not.toContain('Tr0ub4dor');

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
  /* A job the page follows: the step it is on, then the result. */
  await expect(site.locator('.audit-site-progress .audit-progress-line')).toHaveText('Reading the site’s JavaScript for secrets and libraries · 2 of 5');
  await expect(site.locator('.audit-site-progress .audit-step[data-step="crawl"]')).toHaveAttribute('data-state', 'active');
  await expect(site.locator('.audit-grade')).toHaveAttribute('aria-label', /^Site grade F, \d{1,2} out of 100$/);
  await expect(site).toContainText(/\d+ anonymous requests in \d+ s; the page answered 200\./);

  /* What was checked, row by row -- so a short list of findings is never read as a clean site. */
  const ledger = site.getByRole('list', { name: 'What was checked' }).getByRole('listitem');
  await expect(ledger.filter({ hasText: 'Certificate' })).toContainText('Valid for 74 more days, issued by Let’s Encrypt');
  await expect(ledger.filter({ hasText: 'Plain HTTP' })).toContainText('Plain HTTP redirects to HTTPS');
  await expect(ledger.filter({ hasText: 'Exposed files' })).toHaveAttribute('data-state', 'fail');
  await expect(ledger.filter({ hasText: 'Email spoofing' })).toContainText('example.com: SPF strict, DMARC missing');
  await expect(site.getByRole('list', { name: 'Browser libraries' })).toContainText('jquery 1.12.4');
  await expect(site.getByRole('list', { name: 'Browser libraries' })).toContainText('2 advisories · fixed in 3.5.0');
  /* Past five, the rest of the findings fold behind one control; the library is among them. */
  await site.locator('.audit-more').click();
  await expect(site.locator('.audit-item', { hasText: 'A JavaScript library with known vulnerabilities is loaded' })).toBeVisible();
  await expect(site.locator('.audit-item', { hasText: 'Source maps are public' })).toBeVisible();

  /* The headers a browser enforces, each marked sent or not, and never by colour alone. */
  const headers = site.getByRole('list', { name: 'Security headers' }).getByRole('listitem');
  await expect(headers).toHaveCount(8);
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
  await pane.locator('.audit-summary').getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export developer brief' }).click();
  const text = require('fs').readFileSync(await (await download).path(), 'utf8');
  expect(text).toContain('# Deployed site: https://demo.example.com');
  expect(text).toContain('An environment file is served publicly');
  expect(text).toContain('## What was checked');
  expect(text).toContain('- jquery 1.12.4: 2 advisories (CVE-2020-11022, CVE-2015-9251), fixed in 3.5.0');
  expect(text).not.toContain('SECRET_KEY');

  /* Fixed: the headers are sent and the file is gone. */
  await site.getByRole('button', { name: 'Check again' }).click();
  await expect(site.locator('.audit-grade')).toHaveAttribute('aria-label', 'Site grade A, 100 out of 100');
  await expect(site.locator('.audit-verdict')).toHaveText('Nothing found');
  await expect(site.locator('.audit-origin')).toHaveText('demo.example.com');
  /* X-Frame-Options is not sent, but CSP frame-ancestors does its job, and the tile says so. */
  await expect(headers.filter({ hasText: 'X-Frame-Options' })).toContainText('via CSP');
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
  await site.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Export developer brief' })).toBeVisible();
});
