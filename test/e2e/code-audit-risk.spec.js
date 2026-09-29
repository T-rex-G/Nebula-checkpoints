'use strict';

/*
 * Dependency risk: a vulnerable package is placed by whether it is being
 * exploited in the wild, how likely it is to be, and how close it sits to
 * the code that runs. The result comes from the real engine
 * (code-audit-risk-fixture.js).
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { riskyResult } = require('./code-audit-risk-fixture');

test.use({ serviceWorkers: 'block' });

const AUDIT = /\/api\/repo\/sandbox\/demo\/code-audit(\?|$)/;

async function audited(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const result = riskyResult();
  await page.route(AUDIT, route => (new URL(route.request().url()).searchParams.get('run') ? route.fulfill({ status: 200, json: result }) : route.fallback()));
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade /, { timeout: 15000 });
  return pane;
}

test('vulnerable packages are ranked by exploitation and reach, and the grade is held by what is exploited', async ({ page }) => {
  const pane = await audited(page);
  await expect(pane).toContainText('Held below 50 while a vulnerability CISA lists as exploited in the wild ships with the code.');

  /* Fix first leads with the exploited package the page imports, though its advisory is only moderate. */
  const first = pane.locator('.audit-first-btn').first();
  await expect(first).toContainText('jquery 3.4.1 → 3.5.0');
  await expect(first.locator('.audit-kev')).toHaveText('Exploited');
  await expect(first).toHaveAccessibleName(/exploited in the wild/);

  const risk = pane.locator('.audit-risk');
  await expect(risk.getByRole('heading', { name: 'Dependency risk' })).toBeVisible();
  const rows = risk.locator('.audit-risk-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('jquery');
  await expect(rows.nth(0)).toHaveAttribute('data-band', 'urgent');
  await expect(rows.nth(0).locator('.audit-kev')).toHaveAttribute('data-beam', 'on');
  await expect(rows.nth(0)).toContainText('EPSS 85%');
  await expect(rows.nth(0)).toContainText('Imported by main.js');
  /* qs is not imported; Express brings it, and the server imports Express. */
  const qs = rows.filter({ hasText: 'qs' });
  await expect(qs).toContainText('Via express');
  await expect(qs).toContainText('Comes with express, which the code imports');
  /* Exploited too, but only a development tool: listed, not beamed, and not what holds the grade. */
  const tool = rows.filter({ hasText: 'systeminformation' });
  await expect(tool.locator('.audit-kev')).toBeVisible();
  await expect(tool.locator('.audit-kev')).not.toHaveAttribute('data-beam', 'on');
  await expect(tool).toContainText('Dev only');
  /* A production dependency only a test imports is still installed, never "unused". */
  const lodash = rows.filter({ hasText: 'lodash' });
  await expect(lodash).toContainText('Installed');
  await expect(lodash).toContainText('Installed for production; only tests import it');
  await expect(risk.locator('.audit-risk-stats')).toContainText('1 exploited in the wild');
  await expect(risk.locator('.audit-risk-note')).toContainText('CISA’s Known Exploited Vulnerabilities catalog 2026.09.27 (1,728 CVEs)');

  /* A row opens its finding, whose facts say where each came from. */
  await rows.nth(0).locator('.audit-risk-btn').click();
  const finding = pane.locator('.audit-item', { hasText: 'jquery 3.4.1' });
  await expect(finding.locator('details')).toHaveAttribute('open', '');
  const intel = finding.locator('.audit-intel');
  await expect(intel).toContainText('CISA lists CVE-2020-11023 as exploited in the wild, added 2025-01-23; US federal agencies had to fix it by 2025-02-13.');
  await expect(intel.getByRole('link', { name: /CISA KEV/ })).toHaveAttribute('href', /known-exploited-vulnerabilities-catalog\?search_api_fulltext=CVE-2020-11023$/);
  await expect(intel).toContainText('EPSS: a 85% chance CVE-2020-11023 is exploited in the next 30 days, higher than 99.7% of scored CVEs (FIRST, 2026-09-28).');
  await expect(intel.getByRole('button', { name: 'Open web/main.js' })).toBeVisible();
  await expect(finding.locator('.audit-adv-kev')).toHaveText('KEV');

  const chain = pane.locator('.audit-item', { hasText: 'qs 6.7.0' }).locator('.audit-intel-chain');
  await expect(chain).toHaveAttribute('aria-label', 'Dependency path: express, then qs');
});

test('the exploited filter narrows the findings, and the exports carry the same facts', async ({ page }) => {
  const pane = await audited(page);
  const toggle = pane.locator('.audit-risk-stat');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.locator('.audit-exploits').getByRole('button', { name: /^Exploited/ })).toHaveAttribute('aria-pressed', 'true');
  const items = pane.locator('.audit-findings .audit-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('jquery');
  await pane.locator('.audit-exploits').getByRole('button', { name: /^Any/ }).click();
  await expect(items).not.toHaveCount(1);
  await pane.getByRole('searchbox', { name: 'Search findings' }).fill('kev');
  await expect(items).toHaveCount(2);

  /* A risk row whose finding the search is hiding brings it back, rather than doing nothing. */
  await pane.getByRole('searchbox', { name: 'Search findings' }).fill('lodash');
  await expect(items).toHaveCount(1);
  await pane.locator('.audit-risk-row', { hasText: 'jquery' }).locator('.audit-risk-btn').click();
  await expect(pane.getByRole('searchbox', { name: 'Search findings' })).toHaveValue('');
  await expect(pane.locator('.audit-item', { hasText: 'jquery 3.4.1' }).locator('details')).toHaveAttribute('open', '');

  await pane.getByRole('button', { name: /^Export/ }).click();
  const [brief] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export developer brief' }).click()]);
  const text = require('fs').readFileSync(await brief.path(), 'utf8');
  expect(text).toContain('(held below 50 by a vulnerability exploited in the wild)');
  expect(text).toContain('## Dependency risk');
  expect(text).toMatch(/\| \d+ urgent \| jquery 3\.4\.1 \| yes — CVE-2020-11023 \| 85% \(CVE-2020-11023\) \| Imported \|/);
  expect(text).toContain('- **Exploited in the wild:** CVE-2020-11023, in CISA’s catalog since 2025-01-23');
  expect(text).toContain('- **Reach:** Not imported itself; it comes with express, which the code imports. Path: express → qs.');

  await pane.getByRole('button', { name: /^Export/ }).click();
  const [sarifFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /SARIF/ }).click()]);
  const sarif = JSON.parse(require('fs').readFileSync(await sarifFile.path(), 'utf8'));
  const jquery = sarif.runs[0].results.find(result => result.message.text && result.properties && result.properties.epssCve === 'CVE-2020-11023');
  expect(jquery.properties.knownExploited).toBe(true);
  expect(jquery.properties.dependencyReach).toBe('imported');
  expect(jquery.properties['security-severity']).toBe('6.1');
  expect(sarif.runs[0].properties.capReason).toBe('exploited');

  /* The bill of materials downloads in both formats, named for the repository and the day. */
  await pane.getByRole('button', { name: /^Export/ }).click();
  const [cdxFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export CycloneDX SBOM' }).click()]);
  expect(cdxFile.suggestedFilename()).toMatch(/^demo-sbom-\d{4}-\d{2}-\d{2}\.cdx\.json$/);
  const bom = JSON.parse(require('fs').readFileSync(await cdxFile.path(), 'utf8'));
  expect(bom.specVersion).toBe('1.5');
  expect(bom.metadata.component.name).toBe('sandbox/demo');
  expect(bom.vulnerabilities.find(vulnerability => vulnerability.id === 'GHSA-jpcq-cgw6-v4j6').affects).toEqual([{ ref: 'pkg:npm/jquery@3.4.1' }]);
  await pane.getByRole('button', { name: /^Export/ }).click();
  const [spdxFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export SPDX SBOM' }).click()]);
  expect(spdxFile.suggestedFilename()).toMatch(/^demo-sbom-\d{4}-\d{2}-\d{2}\.spdx\.json$/);
  const spdx = JSON.parse(require('fs').readFileSync(await spdxFile.path(), 'utf8'));
  expect(spdx.spdxVersion).toBe('SPDX-2.3');
  expect(spdx.packages.map(item => item.name)).toContain('qs');
});
