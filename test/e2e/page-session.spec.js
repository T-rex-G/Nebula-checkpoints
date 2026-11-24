'use strict';

/*
 * Signing in and out, in the page (features/access/session.ts and
 * account-boundary.ts): the unread marker follows the session both ways; a
 * mistyped token while adding an account does not leave an empty workspace
 * behind the way back; a sign-out the provider has not finished is not taken
 * for one that has; and a doubled press is one sign-out.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const signedOutUntilSignIn = async page => {
  let signedIn = false;
  await page.route('**/api/me', route => (signedIn ? route.fallback() : route.fulfill({ status: 401, json: { error: 'Not signed in', code: 'AUTH_REQUIRED' } })));
  await page.route('**/api/login', route => { signedIn = true; return route.fallback(); });
};

test('the unread marker lights for a reader who signs in, and goes dark when they sign out', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await signedOutUntilSignIn(page);
  await page.goto('/');
  await expect(ui.screen(page, 'login')).toBeVisible();
  await page.locator('#tokenInput').fill('github_pat_fixture');
  await page.locator('#tokenInput').press('Enter');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#notifUnread')).toHaveJSProperty('hidden', false);
  await page.locator('#logoutBtnOv:visible, #logoutBtn:visible, #logoutBtnM:visible').first().click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect(page.locator('#notifUnread')).toHaveJSProperty('hidden', true);
});

test('a mistyped token while adding an account goes back to the workspace, started again, not an empty one', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/accounts', route => route.fulfill({ json: { active: 0, accounts: [{ login: 'alpha-tester', provider: 'github' }] } }));
  await page.route('**/api/login', route => route.fulfill({ status: 401, json: { error: 'Invalid token for that provider.' } }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await page.locator('#accountBtnOv:visible, #accountBtn:visible').first().click();
  await page.locator('#accAdd').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await page.locator('#tokenInput').fill('github_pat_mistyped');
  await page.locator('#loginBtn').click();
  /* The failure is said; the reader is still signed in at the server as before. */
  await expect(page.locator('#trustErrorBackdrop')).toBeVisible();
  await expect(page.locator('#trustErrorBackdrop')).toContainText('Invalid token for that provider.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#trustErrorBackdrop')).toBeHidden();
  await page.locator('#loginBackBtn').click();
  /*
   * The attempt let go of everything the page held before it asked. The way
   * back starts the page again as whoever the server answers for -- the
   * reader who was signed in all along -- rather than showing them an empty
   * repository list that belongs to nobody.
   */
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(ui.screen(page, 'overview')).toContainText('Alpha Tester');
  await expect(page.locator('#repoGrid')).toContainText('demo');
});

test('a sign-out still in progress at the provider leaves the reader signed in, and says so', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/logout', route => route.fulfill({ status: 202, json: { ok: false, status: 'pending', results: [] } }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await page.locator('#logoutBtnOv:visible, #logoutBtn:visible, #logoutBtnM:visible').first().click();
  await expect(page.locator('.toast').filter({ hasText: 'You are still signed in' })).toBeVisible();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(ui.screen(page, 'login')).toBeHidden();
  /* Nothing let go of, and no other tab told to let go of anything. */
  expect(await page.evaluate(() => localStorage.getItem('nv_identity_boundary_event'))).toBeNull();
});

test('a doubled press on sign out is one sign-out, with nothing failed said after it', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let asked = 0;
  await page.route('**/api/logout', async route => {
    asked += 1;
    await new Promise(resolve => setTimeout(resolve, 600));
    /* What the server says to a second sign-out once the first has ended the session. */
    return asked > 1 ? route.fulfill({ status: 401, json: { error: 'Not signed in', code: 'AUTH_REQUIRED' } }) : route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await page.locator('#logoutBtnOv:visible, #logoutBtn:visible, #logoutBtnM:visible').first().dblclick();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(asked).toBe(1);
  await expect(page.locator('#trustErrorBackdrop')).toBeHidden();
});

test('a sign-out in one tab makes another let go of the reader and start again', async ({ page, context }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const other = await context.newPage();
  await mockPublicAlphaApi(other, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await other.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(ui.screen(other, 'overview')).toBeVisible();
  /* Set on the other tab's page as it stands: a start of the page again leaves no trace of it. */
  await other.evaluate(() => { window.__beforeTheBoundary = true; sessionStorage.setItem('nv_me', '{"login":"alpha-tester"}'); });
  await page.locator('#logoutBtnOv:visible, #logoutBtn:visible, #logoutBtnM:visible').first().click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  await expect.poll(() => other.evaluate(() => window.__beforeTheBoundary === true).catch(() => true)).toBe(false);
  expect(await other.evaluate(() => sessionStorage.getItem('nv_me'))).not.toBe('{"login":"alpha-tester"}');
});

test('signing out of the controlled alpha shows the sign-in with the alpha\'s two panels', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'invite', access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await page.locator('#logoutBtnOv:visible, #logoutBtn:visible, #logoutBtnM:visible').first().click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  /*
   * The reader signed in when the page opened never saw the sign-in screen, so
   * its alpha panels were never built: signing out showed a sign-in with no
   * word on provider permissions and no way to end the alpha session.
   */
  await expect(page.locator('#alphaProviderGuidance')).toBeVisible();
  await expect(page.locator('#loginAlphaSessionControls')).toContainText('End alpha session');
});
