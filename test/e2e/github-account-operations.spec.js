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
  await expect(ui.button(repos, 'Search code')).toHaveAttribute('aria-disabled', 'false');
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

test('personal accounts can open scoped search results and notifications', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await ui.button(repos, 'Notifications').click();
  await expect(ui.dialog(page, 'Notifications')).toContainText('Review requested');
  await ui.button(ui.dialog(page, 'Notifications'), 'Close').click();
  await repos.getByRole('searchbox', { name: 'Filter repositories' }).fill('readme');
  await ui.button(repos, 'Search code').click();
  await expect(ui.dialog(page, /Code search/)).toContainText('README.md');
});
