'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi, openConnectedRepository, startNewFileAction } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

test('cold start shows a waking state and a safe access action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'waking' });
  await page.goto('/');
  await expect(page.locator('#alphaWakeState')).toContainText(/Waking database|Ready/);
  await expect(page.locator('#alphaAccessTitle')).toBeVisible();
  await expect(page.locator('#alphaRedeemBtn')).toBeVisible();
  await expect(page.locator('#toasts .ok')).toHaveCount(0);
});

test('loading state names checks in progress and preserves a next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await page.locator('.repo-card').click();
  await expect(page.locator('#trustConnection')).toContainText('Checking provider');
  await expect(page.locator('#trustAction')).toContainText('Waiting for verified');
  await expect(page.locator('#toasts .ok')).toHaveCount(0);
});

test('empty state names the status and preserves a next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'empty' });
  await page.goto('/');
  await expect(page.locator('#repoGrid')).toContainText('No repositories yet');
  await expect(page.locator('#repoGrid')).toContainText('Create one');
  await expect(page.locator('#toasts .ok')).toHaveCount(0);
});

for (const [repositoryState, assertion, action] of [
  ['current', 'Repository is current', 'Continue with the golden path'],
  ['stale', 'Treat the pipeline as stale', 'Re-verify the evidence chain'],
  ['partial', 'Access inventory is partial', 'Refresh the access inventory'],
  ['degraded', 'pipeline is degraded', 'Connect durable evidence storage']
]) {
  test(`${repositoryState} repository state is explicit and does not overclaim success`, async ({ page }) => {
    await openConnectedRepository(page, { repositoryState });
    await expect(page.locator('#trustSummary')).toBeVisible();
    await expect(page.locator('#trustSummary')).toContainText(assertion);
    await expect(page.locator('#trustAction')).toContainText(action);
    if (repositoryState !== 'current') await expect(page.locator('#trustSummary')).not.toContainText('verified success');
  });
}

test('recoverable repository error shows safe state and next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'error' });
  await page.goto('/');
  await page.locator('.repo-card').click();
  await expect(page.locator('.trust-error-dialog')).toBeVisible();
  await expect(page.locator('.trust-error-dialog')).toContainText('Safe state now');
  await expect(page.locator('.trust-error-dialog')).toContainText('Retry opening');
  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  await expect(page.locator('#toasts .ok')).toHaveCount(0);
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
      await expect(page.locator('#toasts')).toContainText(expectedText);
      await expect(page.locator('.trust-error-dialog')).toHaveCount(0);
    } else {
      await expect(page.locator('.trust-error-dialog')).toContainText(expectedText);
      await expect(page.locator('#toasts .ok')).toHaveCount(0);
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
    await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
    await expect(page.locator('#alphaAccessError')).toContainText(message);
    await expect(page.locator('#alphaRedeemBtn')).toBeVisible();
    await expect(page.locator('#toasts .ok')).toHaveCount(0);
  });
}
