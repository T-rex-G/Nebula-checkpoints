'use strict';

/*
 * Licences in the audit: a family of their own that is reported but never
 * graded, a section that says what every dependency may be used under and
 * what it was judged against, the non-permissive packages listed with the
 * most demanding first, a row that leads to its finding where there is one,
 * and the same facts in the brief, the SARIF (filed as compliance, not
 * security) and the bill of materials.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function audit(page, scenario = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', ...scenario });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade [A-F], \d{1,3} out of 100$/);
  return pane;
}

test('every dependency’s licence is read and judged, and a development tool’s copyleft is listed but not reported', async ({ page }) => {
  const pane = await audit(page);
  const section = pane.locator('.audit-licences');
  await expect(section.getByRole('heading', { name: 'Licences' })).toBeVisible();
  await expect(section.locator('.audit-card-lede')).toHaveText('What each dependency may be used under, judged against use in proprietary code. Reported, not graded.');

  const stats = section.locator('.audit-licence-stat');
  await expect(stats).toHaveCount(2);
  await expect(stats.nth(0)).toHaveText('1 strong copyleft');
  await expect(stats.nth(1)).toHaveText('2 permissive');

  await expect(section.locator('.audit-licence-fact').nth(0)).toContainText('None found');
  await expect(section.locator('.audit-licence-fact').nth(1)).toContainText('Add .nebulaverse/licences.json');

  const rows = section.getByRole('list', { name: 'Dependencies that are not permissively licensed' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('crossenv');
  await expect(rows.first()).toContainText('GPL-3.0-only');
  await expect(rows.first()).toContainText('Development');
  /* Nothing to lead to: a tool only developers install never ships its copyleft. */
  await expect(rows.first().getByRole('button')).toHaveCount(0);
  await expect(pane.locator('.audit-item', { hasText: 'copyleft' })).toHaveCount(0);
  await expect(section.locator('.audit-licence-foot')).toContainText('3 of 3 package versions read: 0 from lockfiles, 3 from deps.dev.');

  /* The family tile says it is clear and not graded. */
  const tile = pane.getByRole('list', { name: 'Audit families' }).getByRole('button', { name: /Licences/ });
  await expect(tile).toContainText('Clear');
  await expect(tile).toContainText('Not graded');

  /* The brief carries the section. */
  await pane.getByRole('button', { name: /^Export/ }).click();
  const [brief] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export developer brief' }).click()]);
  const text = require('fs').readFileSync(await brief.path(), 'utf8');
  expect(text).toContain('## Licences');
  expect(text).toContain('Judged against use in proprietary code: no project licence was found. Reported, not graded.');
  expect(text).toContain('3 of 3 package versions read: 1 strong copyleft · 2 permissive.');
  expect(text).toContain('| crossenv 1.0.0 | GPL-3.0-only | Strong copyleft | development |');
});

test('network copyleft in what ships is a finding the row leads to, filed as compliance and never moving the grade', async ({ page }) => {
  /* The same branch with permissive licences, on a page of its own, for the grade to compare. */
  const baseline = await page.context().newPage();
  const grade = await (await audit(baseline)).locator('.audit-grade').getAttribute('aria-label');
  await baseline.close();

  const pane = await audit(page, { licences: 'copyleft' });
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', grade);

  const section = pane.locator('.audit-licences');
  await expect(section.locator('.audit-licence-stat').first()).toHaveText('1 network copyleft');
  const lodash = section.locator('.audit-licence-row', { hasText: 'lodash' });
  await expect(lodash).toContainText('AGPL-3.0-only');
  await expect(lodash.locator('.audit-licence-family')).toHaveText('Network copyleft');
  await lodash.getByRole('button').click();
  const finding = pane.locator('.audit-item', { hasText: 'A dependency must be shared with anyone who uses your service' });
  await expect(finding.locator('details')).toHaveAttribute('open', '');
  await expect(finding.locator('.audit-row-chip')).toHaveText('lodash 4.17.15 · AGPL-3.0-only');
  const facts = finding.locator('.audit-licence-facts .audit-licence-fact');
  await expect(facts.nth(0)).toContainText('AGPL-3.0-only (network copyleft)');
  await expect(facts.nth(1)).toContainText('lodash 4.17.15, asked for by the project');
  await expect(facts.nth(2)).toContainText('deps.dev');

  /* Its own family, one serious finding, not graded; and not among the jobs to do first. */
  const tile = pane.getByRole('list', { name: 'Audit families' }).getByRole('button', { name: /Licences/ });
  await expect(tile).toContainText('Not graded');
  await expect(tile.locator('.audit-category-count[data-severity="serious"]')).toContainText('1');
  await expect(pane.locator('.audit-first-btn', { hasText: 'shared with anyone' })).toHaveCount(0);

  /* SARIF files it as compliance, with no security severity for a dashboard to sort it among vulnerabilities. */
  await pane.getByRole('button', { name: /^Export/ }).click();
  const [sarifFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /SARIF/ }).click()]);
  const sarif = JSON.parse(require('fs').readFileSync(await sarifFile.path(), 'utf8'));
  const rule = sarif.runs[0].tool.driver.rules.find(item => item.id === 'LIC-001');
  expect(sarif.runs[0].results.find(item => item.ruleId === 'LIC-001').locations[0].physicalLocation.artifactLocation.uri).toBe('package.json');
  expect(rule.properties.tags).toEqual(['compliance', 'licences']);
  expect(rule.properties['security-severity']).toBeUndefined();
  expect(rule.helpUri).toBeUndefined();

  /* The bill of materials carries the licence deps.dev answered. */
  await pane.getByRole('button', { name: /^Export/ }).click();
  const [cdxFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export CycloneDX SBOM' }).click()]);
  const bom = JSON.parse(require('fs').readFileSync(await cdxFile.path(), 'utf8'));
  const component = bom.components.find(item => item.name === 'lodash');
  expect(JSON.stringify(component.licenses)).toContain('AGPL-3.0-only');
});
