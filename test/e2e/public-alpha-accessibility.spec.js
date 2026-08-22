'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi, openConnectedRepository } = require('./public-alpha-fixtures');
const ui = require('./semantic');

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
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(ui.screen(page, 'access'), 'Continue').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
}

/* Open the palette and run one entry by the name a reader reads. */
async function runFromPalette(page, name) {
  await ui.button(page, 'Command palette').click();
  await ui.palette(page).fill(name);
  await ui.paletteOption(page, new RegExp(name, 'i')).first().click();
}

test('required alpha screens have no critical or serious axe violations', async ({ page }) => {
  test.setTimeout(90000);
  await mockPublicAlphaApi(page, { access: 'required', mutation: 'blocked' });
  await page.goto('/');
  await expectNoHighImpactViolations(page, 'invitation access');

  await redeemInvitation(page);
  await expect(ui.screen(page, 'login')).toContainText('GitHub App');
  await expectNoHighImpactViolations(page, 'provider connection');

  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-provider-credential');
  await ui.button(ui.screen(page, 'login'), 'Enter orbit').click();
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await expectNoHighImpactViolations(page, 'repository list');

  await ui.button(ui.screen(page, 'repos'), /^Open repository /).first().click();
  await expect(ui.screen(page, 'work').getByRole('region', { name: 'Repository trust summary' })).toBeVisible();
  await expectNoHighImpactViolations(page, 'repository trust summary');

  await runFromPalette(page, 'New file');
  await expect(ui.dialog(page, 'New file')).toBeVisible();
  await expectNoHighImpactViolations(page, 'controlled action dialog');
  await ui.button(ui.dialog(page, 'New file'), 'Cancel').click();

  await runFromPalette(page, 'Safeguards');
  await page.locator('#sgEvidence').click();
  await expect(ui.dialog(page, 'Evidence package exported')).toBeVisible();
  await expectNoHighImpactViolations(page, 'evidence detail');
  await ui.button(ui.dialog(page, 'Evidence package exported'), 'Done').click();

  await ui.button(page, 'Command palette').focus();
  await page.evaluate(() => { void openSettings(); });
  await expect(page.locator('[data-alpha-privacy-action="disconnect"]')).toBeVisible();
  await expect(page.locator('[data-alpha-privacy-action="delete"]')).toBeVisible();
  await expectNoHighImpactViolations(page, 'disconnect and delete controls');
  await page.locator('[data-alpha-privacy-action="delete"]').click();
  await expect(ui.dialog(page, 'Delete alpha data')).toBeVisible();
  await expectNoHighImpactViolations(page, 'delete confirmation');
});

test('keyboard-only tester path exposes visible focus and status announcements', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', mutation: 'verified', cleanup: 'verified' });
  await page.goto('/');

  await ui.secretField(page, 'One-time invitation').focus();
  await page.keyboard.type('fixture-invitation');
  await ui.checkbox(page, /I accept/).focus();
  await page.keyboard.press('Space');
  const redeem = ui.button(ui.screen(page, 'access'), 'Continue');
  await redeem.focus();
  await expect(redeem).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(ui.screen(page, 'login')).toBeVisible();
  await page.waitForTimeout(350);

  await ui.secretField(page, 'GitHub Personal Access Token').focus();
  await page.keyboard.type('fixture-provider-credential');
  await page.keyboard.press('Tab');
  await expect(ui.button(ui.screen(page, 'login'), 'Enter orbit')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ui.screen(page, 'repos')).toBeVisible();

  const repo = ui.button(ui.screen(page, 'repos'), /^Open repository /).first();
  await repo.focus();
  await expect(repo).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(ui.screen(page, 'work')).toBeVisible();
  await page.waitForTimeout(350);

  await ui.button(page, 'Command palette').focus();
  await page.keyboard.press('Enter');
  await ui.palette(page).fill('New file');
  /*
   * The palette is a combobox, so the row the arrow keys select is named by
   * aria-activedescendant. Asserting it before committing proves the keyboard
   * selection is the one a screen reader would announce.
   */
  await expect(ui.palette(page)).toHaveAttribute('aria-activedescendant', /pal-option-\d+/);
  await page.keyboard.press('Enter');
  await expect(ui.dialog(page, 'New file')).toBeVisible();
  await page.waitForTimeout(100);
  await page.locator('#nfPath').focus();
  await page.keyboard.type('keyboard-proof.txt');
  await page.keyboard.press('Shift+Tab');
  await expect(ui.button(ui.dialog(page, 'New file'), 'Create')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ui.status(page, 'Notifications')).toContainText('Created keyboard-proof.txt');
  await expect(ui.status(page, 'Notifications')).toHaveAttribute('aria-live', 'polite');

  await page.locator('#paletteBtn').focus();
  await page.keyboard.press('Enter');
  await page.locator('#paletteInput').fill('Settings');
  await page.keyboard.press('Enter');
  const disconnect = page.locator('[data-alpha-privacy-action="disconnect"]');
  await expect(disconnect).toBeVisible();
  await disconnect.focus();
  await page.keyboard.press('Enter');
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect(ui.status(page, 'Notifications')).toContainText('Disconnected from Nebulaverse-X');
});

test('dialogs contain focus, restore it, and trust states do not depend on color', async ({ page }) => {
  await openConnectedRepository(page, { mutation: 'blocked' });
  const trigger = ui.button(page, 'Command palette');
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

test('reduced motion, 320 CSS-pixel reflow, and mobile navigation remain usable', async ({ page }) => {
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

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator('#bottomNav')).toBeVisible();
  await page.locator('#bottomNav [data-nav="more"]').click();
  await expect(page.locator('#sheetScrim')).toBeVisible();
  const reflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(Math.max(reflow.page, reflow.body)).toBeLessThanOrEqual(reflow.viewport + 1);
  expect(reflow.viewport).toBe(320);
});

test('identity changes purge private state and reload a sibling tab', async ({ context }) => {
  const activeTab = await context.newPage();
  const siblingTab = await context.newPage();
  await openConnectedRepository(activeTab);
  await openConnectedRepository(siblingTab);

  await siblingTab.evaluate(async () => {
    sessionStorage.setItem('nv-sensitive-session-probe', 'present');
    localStorage.setItem('nv_snap_identity-probe', '{"private":true}');
    const cache = await caches.open('nv-api-v1-alphaFixtureScope_0123456789abcdef');
    await cache.put('/api/repos?page=1', new Response('[]', {
      headers: { 'content-type': 'application/json' }
    }));
  });

  await activeTab.locator('#backBtn').click();
  await expect(activeTab.locator('#page-repos')).toHaveClass(/active/);
  const logout = await activeTab.locator('#logoutBtn').isVisible()
    ? activeTab.locator('#logoutBtn')
    : activeTab.locator('#logoutBtnM');

  await Promise.all([
    siblingTab.waitForEvent('domcontentloaded'),
    logout.click()
  ]);

  await expect.poll(() => siblingTab.evaluate(async () => ({
    sessionProbe: sessionStorage.getItem('nv-sensitive-session-probe'),
    snapshotProbe: localStorage.getItem('nv_snap_identity-probe'),
    privateCaches: (await caches.keys()).filter(key => key.startsWith('nv-api-'))
  }))).toEqual({
    sessionProbe: null,
    snapshotProbe: null,
    privateCaches: []
  });

  await activeTab.close();
  await siblingTab.close();
});
