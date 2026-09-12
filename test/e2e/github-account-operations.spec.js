'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

test('personal accounts can create and open a repository through the ordinary interface', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', login: 'sandbox' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  const create = ui.button(repos, 'Create repository');
  await expect(create).toHaveAttribute('aria-disabled', 'false');
  await expect(ui.button(repos, 'Notifications')).toHaveAttribute('aria-disabled', 'false');
  await create.click();
  const dialog = ui.dialog(page, 'New repository');
  await ui.field(dialog, 'Name').fill('demo');
  const created = page.waitForRequest(request => new URL(request.url()).pathname === '/api/repos' && request.method() === 'POST');
  await ui.button(dialog, 'Create').click();
  expect((await created).postDataJSON()).toMatchObject({ name: 'demo', isPrivate: true });
  await expect(ui.screen(page, 'work')).toBeVisible();
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await ui.paletteOption(page, /Delete this repository/).click();
  await expect(ui.dialog(page, 'Delete repository')).toContainText('sandbox/demo');
});

/*
 * The repositories screen carries two controls now: create, and notifications.
 * Code search was removed from it rather than renamed, so this checks that the
 * filter still filters the inventory in place and opens no dialog of its own --
 * the behaviour the removed button used to hide behind the Enter key.
 */
test('personal accounts can read notifications and filter the inventory in place', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await ui.button(repos, 'Notifications').click();
  await expect(ui.dialog(page, 'Notifications')).toContainText('Review requested');
  await ui.button(ui.dialog(page, 'Notifications'), 'Close').click();
  await expect(repos.getByRole('button', { name: /search code/i })).toHaveCount(0);
  const filter = repos.getByRole('searchbox', { name: 'Filter repositories' });
  await filter.fill('readme');
  await filter.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
