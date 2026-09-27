'use strict';

/*
 * Safeguards: the posture in three figures, this app's switches beside the
 * rules the provider enforces, the locked paths with presets that say how
 * many files they cover, and the recovery tools. In the hosted alpha the
 * global switches are the deployment's, so they are shown and not offered.
 *
 * It is a section of the workbench with its own address, not a dialog: a
 * lock redraws it in place, and Back returns to where the reader came from.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function openSafeguards(page) {
  await (await ui.action(page, 'Command palette')).click();
  await page.locator('#paletteInput').fill('Safeguards');
  await page.locator('.pal-item', { hasText: 'Safeguards' }).first().click();
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/safeguards$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return section;
}

test('safeguards show the provider rules, lock paths by preset and unlock them', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  const dialog = await openSafeguards(page);
  await expect(page.locator('.tab[data-tab="safeguards"]')).toHaveClass(/active/);

  /* The provider's rules, read for a reader without administration: what rulesets show is on, the rest is unknown, never on. */
  const rules = dialog.locator('.sg-rule');
  await expect(rules).toHaveCount(8);
  await expect(rules.filter({ hasText: 'Pull request review before merging' })).toHaveAttribute('data-state', 'on');
  await expect(rules.filter({ hasText: 'Pull request review before merging' })).toContainText('1 approval');
  await expect(rules.filter({ hasText: 'Force pushes blocked' })).toHaveAttribute('data-state', 'on');
  await expect(rules.filter({ hasText: 'Signed commits required' })).toHaveAttribute('data-state', 'unknown');
  await expect(dialog).toContainText('Some rules need administration access to read');
  await expect(dialog.getByRole('link', { name: /Branch settings/ })).toHaveAttribute('href', 'https://github.com/sandbox/demo/settings/branches');
  await expect(dialog.locator('#sgStatRules')).toHaveText('4 of 8');
  /* No locks and no snapshot yet: the branch is guarded, the workspace not fully. */
  await expect(dialog.locator('#sgPostureWord')).toHaveText('Mostly guarded');

  /* The hosted alpha's global switches are shown as the deployment's, not offered. */
  await expect(dialog.getByRole('switch', { name: /Read-only mode/ })).toBeDisabled();
  await expect(dialog).toContainText('Set by the deployment in the hosted alpha');

  /* Presets say how many files they would cover, and lock in one tap. */
  const workflows = dialog.getByRole('button', { name: /CI workflows/ });
  await expect(workflows).toContainText('2');
  await expect(dialog.getByRole('button', { name: /Environment files/ })).toContainText('1');
  await workflows.click();
  const again = page.getByRole('region', { name: 'Safeguards' });
  await expect(again.locator('.sg-lock-row')).toHaveCount(1);
  await expect(again.locator('.sg-lock-row')).toContainText('.github/workflows/**');
  await expect(again.locator('.sg-lock-row')).toContainText('2 files');
  await expect(again.getByRole('button', { name: /CI workflows/ })).toBeDisabled();

  /* A typed pattern locks too; a root .env is covered by **\/.env* as the server reads it. */
  await again.getByRole('textbox', { name: 'Path or pattern to lock' }).fill('**/.env*');
  await again.getByRole('button', { name: 'Lock', exact: true }).click();
  const third = page.getByRole('region', { name: 'Safeguards' });
  await expect(third.locator('.sg-lock-row')).toHaveCount(2);
  await expect(third.locator('.sg-lock-row', { hasText: '**/.env*' })).toContainText('1 file');

  /* Unlocking removes it. */
  await third.getByRole('button', { name: 'Unlock .github/workflows/**' }).click();
  const fourth = page.getByRole('region', { name: 'Safeguards' });
  await expect(fourth.locator('.sg-lock-row')).toHaveCount(1);
  await expect(fourth.getByRole('button', { name: /CI workflows/ })).toBeEnabled();

  /* The recovery tools are tiles, and each opens its flow. */
  await expect(fourth.locator('.sg-tile')).toHaveCount(5);
  await expect(fourth.locator('#sgSnap')).toContainText('None taken yet');

  /* A section is a step in the history: Back returns to the audit it was opened from. */
  await page.goBack();
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page.locator('#tab-safeguards')).toBeHidden();
});
