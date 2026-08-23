'use strict';

const { test, expect } = require('@playwright/test');
const { HEAD_SHA, mockPublicAlphaApi, startNewFileAction } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

test('invited tester completes the GitHub sandbox golden path and cleanup', async ({ page }) => {
  const fixture = await mockPublicAlphaApi(page, {
    access: 'required',
    ready: 'ready',
    provider: 'github',
    repositoryState: 'current',
    mutation: 'verified',
    cleanup: 'verified'
  });

  await page.goto('/');
  const access = ui.screen(page, 'access');
  await expect(access).toBeVisible();
  await expect(ui.heading(access, ui.SCREENS.access)).toBeVisible();
  await expect(access).toContainText('no real secrets');
  await expect(access).toContainText('production deployments');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(access, 'Continue').click();

  const login = ui.screen(page, 'login');
  await expect(login).toBeVisible();
  await expect(login).toContainText('GitHub App');
  await expect(login).toContainText('selected repositories');
  await expect(login).toContainText('sandbox');
  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-provider-credential');
  await ui.button(login, 'Enter orbit').click();

  const repos = ui.screen(page, 'repos');
  await expect(repos).toBeVisible();
  const repository = ui.button(repos, 'Open repository sandbox/demo');
  await expect(repository).toHaveCount(1);
  await repository.click();

  const work = ui.screen(page, 'work');
  await expect(work).toBeVisible();
  const trust = work.getByRole('region', { name: 'Repository trust summary' });
  await expect(trust).toBeVisible();
  await expect(trust.getByRole('article', { name: 'Connection trust' })).toContainText('Provider-verified');
  await expect(trust.getByRole('article', { name: 'Pipeline trust' })).toContainText('Evidence chain verified');
  await expect(trust.getByRole('article', { name: 'Risk' })).toContainText('No issue');
  await expect(trust.getByRole('article', { name: 'Evidence' })).toContainText('chained record');

  await ui.button(page, 'Command palette').click();
  await page.locator('#paletteInput').fill('Safeguards');
  await page.locator('.pal-item', { hasText: 'Safeguards' }).first().click();
  await expect(page.locator('#sgEvidence')).toBeVisible();
  await page.locator('#sgEvidence').click();
  await expect(page.locator('#modalTitle')).toHaveText('Evidence package exported');
  await expect(page.locator('#modalBody')).toContainText('verified event');
  await page.locator('#modalOk').click();

  await startNewFileAction(page, 'alpha-proof.txt');
  await expect(ui.status(page, 'Notifications')).toContainText('Created alpha-proof.txt');
  expect(fixture.mutationRequests).toHaveLength(1);
  expect(fixture.mutationRequests[0].expectedHeadSha).toBe(HEAD_SHA);

  await ui.button(page, 'Command palette').click();
  await page.locator('#paletteInput').fill('Settings');
  await page.locator('.pal-item', { hasText: 'Settings' }).first().click();
  await page.locator('#modalBody [data-alpha-privacy-action="disconnect"]').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect.poll(() => fixture.disconnected).toBe(true);

  await page.locator('.login-card [data-alpha-privacy-action="end"]').click();
  await expect.poll(() => fixture.alphaEnded).toBe(true);
  await expect(ui.screen(page, 'login')).toBeVisible();
});
