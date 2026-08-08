'use strict';

const { test, expect } = require('@playwright/test');
const { HEAD_SHA, mockPublicAlphaApi, startNewFileAction } = require('./public-alpha-fixtures');

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
  await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
  await expect(page.locator('#alphaAccessTitle')).toBeVisible();
  await expect(page.locator('.alpha-access-rule')).toContainText('no real secrets');
  await expect(page.locator('.alpha-access-rule')).toContainText('production deployments');
  await page.locator('#alphaInviteInput').fill('fixture-invitation');
  await page.locator('#alphaTermsAccept').check();
  await page.locator('#alphaRedeemBtn').click();

  await expect(page.locator('#page-login')).toHaveClass(/active/);
  const guidance = page.locator('#alphaProviderGuidance');
  await expect(guidance).toContainText('GitHub App');
  await expect(guidance).toContainText('selected repositories');
  await expect(guidance).toContainText('sandbox');
  await page.locator('#tokenInput').fill('fixture-provider-credential');
  await page.locator('#loginBtn').click();

  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  await expect(page.locator('.repo-card')).toHaveCount(1);
  await expect(page.locator('.repo-card')).toContainText('sandbox/demo');
  await page.locator('.repo-card').click();

  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await expect(page.locator('#trustSummary')).toBeVisible();
  await expect(page.locator('#trustConnection')).toContainText('Provider-verified');
  await expect(page.locator('#trustPipeline')).toContainText('Evidence chain verified');
  await expect(page.locator('#trustRisk')).toContainText('No issue');
  await expect(page.locator('#trustEvidence')).toContainText('chained record');

  await page.locator('#paletteBtn').click();
  await page.locator('#paletteInput').fill('Safeguards');
  await page.locator('.pal-item', { hasText: 'Safeguards' }).first().click();
  await expect(page.locator('#sgEvidence')).toBeVisible();
  await page.locator('#sgEvidence').click();
  await expect(page.locator('#modalTitle')).toHaveText('Evidence package exported');
  await expect(page.locator('#modalBody')).toContainText('verified event');
  await page.locator('#modalOk').click();

  await startNewFileAction(page, 'alpha-proof.txt');
  await expect(page.locator('#toasts')).toContainText('Created alpha-proof.txt');
  expect(fixture.mutationRequests).toHaveLength(1);
  expect(fixture.mutationRequests[0].expectedHeadSha).toBe(HEAD_SHA);

  await page.locator('#paletteBtn').click();
  await page.locator('#paletteInput').fill('Settings');
  await page.locator('.pal-item', { hasText: 'Settings' }).first().click();
  await page.locator('#modalBody [data-alpha-privacy-action="disconnect"]').click();
  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await expect.poll(() => fixture.disconnected).toBe(true);

  await page.locator('.login-card [data-alpha-privacy-action="end"]').click();
  await expect.poll(() => fixture.alphaEnded).toBe(true);
  await expect(page.locator('#page-login')).toHaveClass(/active/);
});
