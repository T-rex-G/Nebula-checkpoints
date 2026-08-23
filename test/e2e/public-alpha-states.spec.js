'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi, openConnectedRepository, startNewFileAction } = require('./public-alpha-fixtures');
const ui = require('./semantic');

/*
 * "No success was claimed" is the assertion these states share. Outcome used
 * to be a colour class on the toast; it is announced text now, so the check
 * reads the notifications region for the word a listener would hear rather
 * than counting elements carrying a green style.
 */
function claimedSuccess(page) {
  return ui.status(page, 'Notifications').getByText(/^Success:/);
}

test.use({ serviceWorkers: 'block' });

test('cold start shows a waking state and a safe access action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'waking' });
  await page.goto('/');
  await expect(ui.status(page, 'Service readiness')).toContainText(/Waking database|Ready/);
  const access = ui.screen(page, 'access');
  await expect(ui.heading(access, ui.SCREENS.access)).toBeVisible();
  await expect(ui.button(access, 'Continue')).toBeVisible();
  await expect(claimedSuccess(page)).toHaveCount(0);
});

test('loading state names checks in progress and preserves a next action', async ({ page }) => {
  /* The trust endpoints are held open, so the loading state is asserted rather than raced. */
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', trust: 'pending' });
  await page.goto('/');
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  await expect(ui.trustArticle(page, 'Connection trust')).toContainText('Checking provider');
  await expect(ui.trustArticle(page, 'Next action')).toContainText('Waiting for verified');
  await expect(claimedSuccess(page)).toHaveCount(0);
});

test('empty state names the status and preserves a next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'empty' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await expect(repos).toContainText('No repositories yet');
  await expect(repos).toContainText('Create one');
  await expect(claimedSuccess(page)).toHaveCount(0);
});

for (const [repositoryState, assertion, action] of [
  ['current', 'Repository is current', 'Continue with the golden path'],
  ['stale', 'Treat the pipeline as stale', 'Re-verify the evidence chain'],
  ['partial', 'Access inventory is partial', 'Refresh the access inventory'],
  ['degraded', 'pipeline is degraded', 'Connect durable evidence storage']
]) {
  test(`${repositoryState} repository state is explicit and does not overclaim success`, async ({ page }) => {
    await openConnectedRepository(page, { repositoryState });
    const trust = ui.trust(page);
    await expect(trust).toBeVisible();
    await expect(trust).toContainText(assertion);
    await expect(ui.trustArticle(page, 'Next action')).toContainText(action);
    if (repositoryState !== 'current') await expect(trust).not.toContainText('verified success');
  });
}

test('recoverable repository error shows safe state and next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'error' });
  await page.goto('/');
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  await expect(page.locator('.trust-error-dialog')).toBeVisible();
  await expect(page.locator('.trust-error-dialog')).toContainText('Safe state now');
  await expect(page.locator('.trust-error-dialog')).toContainText('Retry opening');
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await expect(claimedSuccess(page)).toHaveCount(0);
});

for (const [mutation, expectedText, verified] of [
  ['blocked', 'blocked by policy', false],
  ['failed-unchanged', 'previously verified head', false],
  ['unknown', 'Do not retry', false],
  ['verified', 'Created verified.txt', true]
]) {
  test(`${mutation} controlled action has a truthful outcome`, async ({ page }) => {
    await openConnectedRepository(page, { mutation });
    await startNewFileAction(page, `${mutation}.txt`);
    if (verified) {
      await expect(ui.status(page, 'Notifications')).toContainText(expectedText);
      await expect(page.locator('.trust-error-dialog')).toHaveCount(0);
    } else {
      await expect(page.locator('.trust-error-dialog')).toContainText(expectedText);
      await expect(claimedSuccess(page)).toHaveCount(0);
    }
  });
}

test('unavailable provider capability is disabled before interaction with a safe reason', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', provider: 'gitlab' });
  await page.goto('/');
  await expect(page.locator('#repoGlobalSearchBtn')).toBeDisabled();
  await expect(page.locator('#repoGlobalSearchBtn')).toHaveAttribute('data-capability-reason', /.{12,}/);
  await expect(page.locator('#repoGlobalSearchBtn + .capability-state')).toContainText('Unavailable');
});

for (const [access, message] of [
  ['revoked', 'access was revoked'],
  ['expired', 'session expired']
]) {
  test(`${access} access returns to the invitation gate with a safe next action`, async ({ page }) => {
    await mockPublicAlphaApi(page, { access });
    await page.goto('/');
    const gate = ui.screen(page, 'access');
    await expect(gate).toBeVisible();
    await expect(ui.alert(gate)).toContainText(message);
    await expect(ui.button(gate, 'Continue')).toBeVisible();
    await expect(claimedSuccess(page)).toHaveCount(0);
  });
}
