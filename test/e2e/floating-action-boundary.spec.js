'use strict';

/*
 * The floating action lives outside the screens so its action can change with
 * the screen. The cost of that is that nothing removes it when a screen goes
 * away -- it is repainted by showPage, and showPage returns early when the
 * screen it is asked for is already current:
 *
 *     if (_page === name) return;
 *
 * Two paths set _page directly and never reach that repaint: the initial value
 * and the expiry handler, which shows the invitation gate when an alpha session
 * expires or is revoked. So an expired session left the workbench's action
 * button sitting over the gate's primary control, offering an action against a
 * workspace the reader no longer has.
 *
 * Reported from a phone, with the button overlapping Continue.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });
test.skip(({ viewport }) => !viewport || viewport.width > 900, 'the dock is a phone surface');

test('the gate taking over removes the action for the screen it replaced', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.reload();
  await expect(page.locator('#page-work')).toHaveClass(/active/);

  /* The precondition is the whole point: without a visible action there is
   * nothing to leak, and the test would pass for the wrong reason. */
  const fab = page.locator('#paletteFab');
  await expect(fab, 'the workbench offers no floating action to leak').toBeVisible();

  await page.evaluate(() => window.NebulaAlphaUI.showExpired('ALPHA_SESSION_EXPIRED'));
  await expect(page.locator('#page-alpha-access')).toBeVisible();

  await expect(fab, 'the workbench action outlived the workbench').not.toBeVisible();
});

test('no action is offered before a screen has asked for one', async ({ page }) => {
  /* Hidden from the first frame rather than hidden once script catches up: the
   * gate is the first thing drawn, and it has no actions of its own. */
  await page.goto('/');
  await expect(page.locator('#paletteFab')).not.toBeVisible();
});

test('the floating action stays inside a comfortable target size', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.reload();
  const box = await page.locator('#paletteFab').boundingBox();
  /* WCAG 2.5.8 asks 24; a primary action wants more than the minimum, and it
   * shares the corner with the bottom navigation, so it should not dominate. */
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeLessThanOrEqual(52);
  expect(Math.round(box.height)).toBe(Math.round(box.width));
});
