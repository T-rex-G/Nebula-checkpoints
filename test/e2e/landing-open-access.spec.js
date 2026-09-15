'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * The landing page is the product's front door, and a front door should not be
 * painted and then taken away.
 *
 * boot() raised the access page on its first line and only learned the gate's
 * mode two round trips later, so with the gate off a visitor saw the landing
 * page appear and vanish. These checks pin both halves of the rule: with the
 * gate off the page stays and offers a way through; with it on the invitation
 * is still the only way in.
 */

const landing = page => page.locator('#page-alpha-access');
const passThrough = page => page.locator('#alphaPassThrough');
const invite = page => page.locator('#alphaInviteInput');

test('with the gate off the landing page stays instead of handing over', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'required', ready: 'ready' });
  await page.goto('/');

  await expect(landing(page)).toHaveClass(/active/);
  await expect(passThrough(page)).toBeVisible();

  /*
   * And it is still there after the app has had every chance to replace it.
   * The flash was a late hand-over, so a check that only looks once cannot
   * tell a page that stayed from a page that had not been taken away yet.
   */
  await page.waitForTimeout(1500);
  await expect(landing(page)).toHaveClass(/active/);
  await expect(passThrough(page)).toBeVisible();

  /* No invitation is asked for, because there is none to redeem. */
  await expect(invite(page)).toBeHidden();
});

test('the way through knows whether the session is signed in', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'required', ready: 'ready' });
  await page.goto('/');
  await expect(passThrough(page)).toHaveText(/Continue to sign in/);

  await passThrough(page).click();
  /* It hands over to the application, which routes on from there. */
  await expect(landing(page)).not.toHaveClass(/active/);
});

test('with the gate on the invitation is still the only way in', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'on', access: 'required', ready: 'ready' });
  await page.goto('/');

  await expect(landing(page)).toHaveClass(/active/);
  await expect(invite(page)).toBeVisible();
  await expect(passThrough(page)).toBeHidden();
  await expect(ui.button(ui.screen(page, 'access'), 'Continue')).toBeVisible();
});
