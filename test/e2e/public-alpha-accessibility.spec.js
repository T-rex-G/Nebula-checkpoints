'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi, openConnectedRepository } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function expectNoHighImpactViolations(page, screen) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = result.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .map(violation => ({
      screen,
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map(node => node.target.join(' '))
    }));
  expect(violations).toEqual([]);
}

async function redeemInvitation(page) {
  await page.locator('#alphaInviteInput').fill('fixture-invitation');
  await page.locator('#alphaTermsAccept').check();
  await page.locator('#alphaRedeemBtn').click();
  await expect(page.locator('#page-login')).toHaveClass(/active/);
}

test('required alpha screens have no critical or serious axe violations', async ({ page }) => {
  test.setTimeout(90000);
  await mockPublicAlphaApi(page, { access: 'required', mutation: 'blocked' });
  await page.goto('/');
  await expectNoHighImpactViolations(page, 'invitation access');

  await redeemInvitation(page);
  await expect(page.locator('#alphaProviderGuidance')).toBeVisible();
  await expectNoHighImpactViolations(page, 'provider connection');

  await page.locator('#tokenInput').fill('fixture-provider-credential');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  await expectNoHighImpactViolations(page, 'repository list');

  await page.locator('.repo-card').first().click();
  await expect(page.locator('#trustSummary')).toBeVisible();
  await expectNoHighImpactViolations(page, 'repository trust summary');

  await page.locator('#paletteBtn').click();
  await page.locator('#paletteInput').fill('New file');
  await page.locator('.pal-item', { hasText: 'New file' }).first().click();
  await expect(page.locator('#modalTitle')).toHaveText('New file');
  await expectNoHighImpactViolations(page, 'controlled action dialog');
  await page.locator('#modalCancel').click();

  await page.locator('#paletteBtn').click();
  await page.locator('#paletteInput').fill('Safeguards');
  await page.locator('.pal-item', { hasText: 'Safeguards' }).first().click();
  await page.locator('#sgEvidence').click();
  await expect(page.locator('#modalTitle')).toHaveText('Evidence package exported');
  await expectNoHighImpactViolations(page, 'evidence detail');
  await page.locator('#modalOk').click();

  await page.locator('#paletteBtn').focus();
  await page.evaluate(() => { void openSettings(); });
  await expect(page.locator('[data-alpha-privacy-action="disconnect"]')).toBeVisible();
  await expect(page.locator('[data-alpha-privacy-action="delete"]')).toBeVisible();
  await expectNoHighImpactViolations(page, 'disconnect and delete controls');
  await page.locator('[data-alpha-privacy-action="delete"]').click();
  await expect(page.locator('#modalTitle')).toHaveText('Delete alpha data');
  await expectNoHighImpactViolations(page, 'delete confirmation');
});

test('keyboard-only tester path exposes visible focus and status announcements', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', mutation: 'verified', cleanup: 'verified' });
  await page.goto('/');

  await page.locator('#alphaInviteInput').focus();
  await page.keyboard.type('fixture-invitation');
  await page.locator('#alphaTermsAccept').focus();
  await page.keyboard.press('Space');
  await page.locator('#alphaRedeemBtn').focus();
  await expect(page.locator('#alphaRedeemBtn')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await page.waitForTimeout(350);

  await page.locator('#tokenInput').focus();
  await page.keyboard.type('fixture-provider-credential');
  await page.keyboard.press('Tab');
  await expect(page.locator('#loginBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-repos')).toHaveClass(/active/);

  const repo = page.locator('.repo-card').first();
  await repo.focus();
  await expect(repo).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await page.waitForTimeout(350);

  await page.locator('#paletteBtn').focus();
  await page.keyboard.press('Enter');
  await page.locator('#paletteInput').fill('New file');
  await page.keyboard.press('Enter');
  await expect(page.locator('#modalTitle')).toHaveText('New file');
  await page.waitForTimeout(100);
  await page.locator('#nfPath').focus();
  await page.keyboard.type('keyboard-proof.txt');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#modalOk')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toasts')).toContainText('Created keyboard-proof.txt');
  await expect(page.locator('#toasts')).toHaveAttribute('role', 'status');
  await expect(page.locator('#toasts')).toHaveAttribute('aria-live', 'polite');

  await page.locator('#paletteBtn').focus();
  await page.keyboard.press('Enter');
  await page.locator('#paletteInput').fill('Settings');
  await page.keyboard.press('Enter');
  const disconnect = page.locator('[data-alpha-privacy-action="disconnect"]');
  await expect(disconnect).toBeVisible();
  await disconnect.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await expect(page.locator('#toasts')).toContainText('Disconnected from Nebulaverse-X');
});

test('dialogs contain focus, restore it, and trust states do not depend on color', async ({ page }) => {
  await openConnectedRepository(page, { mutation: 'blocked' });
  const trigger = page.locator('#paletteBtn');
  await trigger.focus();
  await page.evaluate(() => { void openSettings(); });
  await page.locator('#modalOk').focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.querySelector('#modal').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();

  await page.evaluate(() => window.NebulaTrustUI.presentError({
    code: 'MUTATION_BLOCKED',
    message: 'The controlled action was blocked by policy.',
    correlationId: 'fixture-focus-restoration',
    safeState: 'The sandbox repository remains unchanged.',
    nextAction: 'Review the policy decision.'
  }));
  const dialog = page.locator('.trust-error-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('.trust-error-close').focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.querySelector('.trust-error-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();

  for (const evidence of await page.locator('#trustSummary .trust-evidence').all()) {
    await expect(evidence).not.toHaveText('');
    await expect(evidence.locator('.trust-evidence-icon')).not.toHaveText('');
  }
});

test('reduced motion, 200 percent text reflow, and mobile navigation remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openConnectedRepository(page);
  const motion = await page.locator('.orb-a').evaluate(element => ({
    animationDuration: getComputedStyle(element).animationDuration,
    iterations: getComputedStyle(element).animationIterationCount,
    transitionDuration: getComputedStyle(element).transitionDuration
  }));
  expect(motion.animationDuration).toBe('1e-05s');
  expect(motion.iterations).toBe('1');
  expect(motion.transitionDuration).toBe('1e-05s');

  await page.setViewportSize({ width: 393, height: 851 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(page.locator('#bottomNav')).toBeVisible();
  await page.locator('#bottomNav [data-nav="more"]').click();
  await expect(page.locator('#sheetScrim')).toBeVisible();
  const reflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(Math.max(reflow.page, reflow.body)).toBeLessThanOrEqual(reflow.viewport + 1);
});
