'use strict';

/*
 * The sections under the audit's summary fold to their heading. A fold is
 * remembered for this browser by section name, so the next audit keeps it;
 * a folded body leaves the tab order; and the findings list opens by itself
 * when something is about to show a result in it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

const SECTIONS = [
  ['first', 'Fix first'], ['risk', 'Dependency risk'], ['families', 'Families'], ['surface', 'Attack surface'], ['coverage', 'Coverage'],
  ['controls', 'Already in place'], ['owasp', 'OWASP Top 10'], ['findings', 'Findings'], ['site', 'Deployed site']
];

async function audited(page) {
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: /^(Audit this branch|Audit again)$/ }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade /, { timeout: 15000 });
  return pane;
}

test('every section folds to its heading, stays folded for the next audit, and opens again', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const pane = await audited(page);

  for (const [id, name] of SECTIONS) {
    const toggle = pane.getByRole('button', { name: `Collapse ${name}` });
    await expect(toggle, `${name} has a fold control`).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', `auditFold-${id}`);
  }

  const surface = pane.locator('[data-fold="surface"]');
  const open = await surface.boundingBox();
  await pane.getByRole('button', { name: 'Collapse Attack surface' }).click();
  const expand = pane.getByRole('button', { name: 'Expand Attack surface' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(surface.locator('.audit-routes')).toBeHidden();
  await expect.poll(async () => (await surface.boundingBox()).height).toBeLessThan(open.height / 2);
  /* A folded body is out of the tab order. */
  expect(await surface.locator('.audit-fold').evaluate(node => node.inert)).toBe(true);
  /* Only the section's name is kept. */
  expect(await page.evaluate(() => localStorage.getItem('nv_ui:audit-folded'))).toBe('["surface"]');

  /* The next audit, after a reload, finds it folded. */
  await page.reload();
  const again = await audited(page);
  await expect(again.getByRole('button', { name: 'Expand Attack surface' })).toHaveAttribute('aria-expanded', 'false');
  await expect(again.locator('[data-fold="surface"] .audit-routes')).toBeHidden();

  await again.getByRole('button', { name: 'Expand Attack surface' }).click();
  await expect(again.locator('[data-fold="surface"] .audit-routes')).toBeVisible();
  await expect(again.getByRole('button', { name: 'Collapse Attack surface' })).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => localStorage.getItem('nv_ui:audit-folded'))).toBe('[]');
});

test('a folded findings list opens by itself for a family filter and for Fix first', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const pane = await audited(page);
  const findings = pane.locator('[data-fold="findings"]');

  await pane.getByRole('button', { name: 'Collapse Findings' }).click();
  await expect(findings.locator('.audit-item').first()).toBeHidden();
  await pane.locator('.audit-category-btn:not([data-status="clear"])').first().click();
  await expect(pane.getByRole('button', { name: 'Collapse Findings' })).toBeVisible();
  await expect(findings.locator('.audit-item').first()).toBeVisible();

  await pane.getByRole('button', { name: 'Show all' }).click();
  await pane.getByRole('button', { name: 'Collapse Findings' }).click();
  await expect(findings.locator('.audit-item').first()).toBeHidden();
  await pane.locator('.audit-first-btn').first().click();
  await expect(pane.getByRole('button', { name: 'Collapse Findings' })).toBeVisible();
  await expect(findings.locator('details[data-finding-id][open]').first()).toBeVisible();
});
