'use strict';

/*
 * A security tool chosen before a repository is. The rail used to refuse
 * with "Open a repository first"; now it asks which repository, filters as
 * the reader types, opens with the keyboard, and lands in the tool that was
 * chosen. The recent list it keeps holds names only, under the prefix the
 * account-boundary purge removes.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function chooseFromRail(page, target) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  const item = page.locator(`.nv-rail-item[data-rail="${target}"]`);
  if (!(await item.isVisible())) await page.locator('.page.active .nav-menu-btn').click();
  await item.click();
  const dialog = page.locator('#modal');
  await expect(dialog.getByRole('heading', { name: 'Choose a repository' })).toBeVisible();
  return dialog;
}

test('a security tool without a repository asks which one and lands in the tool', async ({ page }) => {
  const dialog = await chooseFromRail(page, 'audit');
  await expect(dialog.locator('.rp-pick-tool-name')).toHaveText('Audit');
  const search = dialog.getByRole('combobox', { name: 'Search repositories' });
  const options = dialog.getByRole('option');
  await expect(options.first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open Audit' })).toBeEnabled();

  /* Nothing matches: it says so, and there is nothing to open. */
  await search.fill('no-such-repository');
  await expect(dialog.locator('.rp-pick-empty')).toHaveText('No repository matches “no-such-repository”.');
  await expect(dialog.getByRole('button', { name: 'Open Audit' })).toBeDisabled();

  /* Typing narrows, the first match is the highlighted one, Enter opens it in the tool. */
  await search.fill('demo');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.first()).toContainText('sandbox/demo');
  await expect(search).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id'));
  await search.press('Enter');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');

  /* The repository is remembered as a name only, under the purged prefix. */
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_recent:repositories')));
  expect(recent).toEqual([{ owner: 'sandbox', name: 'demo' }]);
});

test('the picker is dismissed without opening anything', async ({ page }) => {
  const dialog = await chooseFromRail(page, 'exposure');
  await expect(dialog.locator('.rp-pick-tool-name')).toHaveText('Exposure');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#page-work')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('nv_recent:repositories'))).toBeNull();
});

test('a repository opened before is offered first, and a click opens the tool', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nv_recent:repositories', JSON.stringify([{ owner: 'sandbox', name: 'demo' }])));
  const dialog = await chooseFromRail(page, 'safeguards');
  await expect(dialog.locator('.rp-pick-group').first()).toHaveText('Recent');
  await dialog.getByRole('option').first().click();
  await expect(page.locator('#tab-safeguards')).toBeVisible();
});
