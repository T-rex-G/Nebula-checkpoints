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
  await mockPublicAlphaApi(page, { mode: 'invite', access: 'required', ready: 'ready' });
  await page.goto('/');

  await expect(landing(page)).toHaveClass(/active/);
  await expect(invite(page)).toBeVisible();
  await expect(passThrough(page)).toBeHidden();
  await expect(ui.button(ui.screen(page, 'access'), 'Continue')).toBeVisible();
});

/*
 * The alpha chrome follows the gate.
 *
 * Two panels on the sign-in screen and one in Settings belong to the
 * controlled alpha: they name an alpha session, offer to end it and offer to
 * delete alpha data. None of that exists with the gate off -- every
 * /api/alpha/* route answers 404 in that mode -- yet all three were built
 * unconditionally, so an open deployment answered "Continue" with a sign-in
 * screen still talking about an invitation the reader was never asked for.
 *
 * Asserted in both directions in the same file, because a check that only
 * watches them disappear passes just as well against a build that removed
 * them altogether, and an invited tester needs those controls.
 */

const guidance = page => page.locator('#alphaProviderGuidance');
const sessionControls = page => page.locator('#loginAlphaSessionControls');

async function signInScreenWithoutProvider(page, mode) {
  await mockPublicAlphaApi(page, { mode, access: 'required', ready: 'ready' });
  /* Added after the fixture, so this answers first: no provider credential,
     which is what sends a reader to the sign-in screen rather than a
     workspace. */
  await page.route('**/api/me', route => route.fulfill({
    status: 401,
    json: { error: 'Authentication required', code: 'AUTH_REQUIRED' }
  }));
  await page.goto('/');
}

test('with the gate off the sign-in screen says nothing about an alpha session', async ({ page }) => {
  await signInScreenWithoutProvider(page, 'off');
  await passThrough(page).click();

  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await expect(guidance(page)).toHaveCount(0);
  await expect(sessionControls(page)).toHaveCount(0);
  /* The provider credential is still asked for. It is how the product reaches
     GitHub at all, and has never been the invitation. */
  await expect(page.locator('#tokenInput')).toBeVisible();
});

test('with the gate on the invited tester still gets the alpha controls', async ({ page }) => {
  await signInScreenWithoutProvider(page, 'invite');
  await invite(page).fill('alpha-invitation-code');
  await page.locator('#alphaTermsAccept').check();
  await page.locator('#alphaRedeemBtn').click();

  await expect(page.locator('#page-login')).toHaveClass(/active/);
  await expect(guidance(page)).toHaveCount(1);
  await expect(sessionControls(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'End alpha session' })).toBeVisible();
});

test('Settings offers alpha privacy actions only while the gate is on', async ({ page }) => {
  for (const [mode, expected] of [['invite', 1], ['off', 0]]) {
    await mockPublicAlphaApi(page, { mode, access: 'active', ready: 'ready' });
    await page.goto('/');
    if (mode === 'off') await passThrough(page).click();

    await (await ui.action(page, 'Settings')).click();
    const settings = ui.dialog(page, 'Settings');
    await expect(settings).toBeVisible();
    await expect(settings.locator('.alpha-privacy-panel')).toHaveCount(expected);
    await page.locator('#modalClose').click();
    await expect(settings).toBeHidden();
  }
});

/*
 * A database that never comes back must not turn into an invitation gate.
 *
 * The production deployment ran with entry off and a database one migration
 * behind, so /readyz answered "migration-mismatch" on every retry. boot()
 * returned on that failed readiness check, before it had ever asked what the
 * gate was set to -- and the invitation form was the card's default markup, so
 * that is what the visitor was left looking at: a one-time-invitation field on
 * a deployment whose operator had turned invitations off, under a readiness
 * line that would never clear.
 *
 * Two rules, because either alone leaves the hole open. The form is never the
 * default paint, and the gate's setting is learned whether or not the database
 * answers -- it does not depend on the database, and it is what decides which
 * screen this is.
 */

const wakeState = page => page.locator('#alphaWakeState');

/*
 * waitUntilReady() backs off 1s, 2s, 4s then 8s before it gives up, so a
 * deployment that never answers takes fifteen seconds to settle -- three times
 * the default expect timeout. Waited out rather than shortened: the ladder is
 * the behaviour under test, and a reader on a stuck deployment really does sit
 * through it.
 */
const SETTLES_AFTER_RETRIES = { timeout: 20000 };

test('the invitation form is not what the page paints before it has asked', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'invite', access: 'required', ready: 'database-unavailable' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  /* Checked at once, before any request settles: this is about what the
     markup claims on its own, not about what the page settles on. */
  await expect(invite(page)).toBeHidden();
  await expect(page.locator('#alphaRedeemBtn')).toBeHidden();
  await expect(page.locator('#alphaTermsAccept')).toBeHidden();
});

test('entry stays open when the database is behind, and settles in one step', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'required', ready: 'database-unavailable' });
  const opened = Date.now();
  await page.goto('/');

  /*
   * Drawn without waiting out the readiness ladder. The gate's setting comes
   * from configuration in one round trip; the database is a separate question
   * and used to be asked first, which made every visitor watch fifteen seconds
   * of "Waking database" before the page would say what it was. Three seconds
   * is far under the ladder and far over a local round trip, so this fails on
   * a rebuilt sequence rather than on a slow machine.
   */
  await expect(passThrough(page)).toBeVisible({ timeout: 3000 });
  expect(Date.now() - opened).toBeLessThan(6000);
  await expect(landing(page)).toHaveClass(/active/);
  /* No invitation is asked for on a deployment that does not use invitations,
     however poorly the database is answering. */
  await expect(invite(page)).toBeHidden();

  /*
   * And once the database has failed for good, the door is shut rather than
   * left standing open. Sessions live in PostgreSQL, so every authenticated
   * request behind this door answers 503: a reader who walked it reached a
   * sign-in screen that could not succeed and was returned to the front door,
   * which is the loop this closes.
   */
  await expect(passThrough(page)).toBeDisabled(SETTLES_AFTER_RETRIES);
  await expect(passThrough(page)).toHaveText(/Workspace unavailable/);
});

test('a sign-in that did not finish is explained at the door', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'required', ready: 'ready' });
  /*
   * The provider round trip ends at a fresh page load, and with entry open the
   * reader stays at the door -- so the application, which used to announce
   * this, never runs. The reason was lost entirely: they pressed continue,
   * went to GitHub, came back to the same front door and were told nothing.
   */
  await page.goto('/?oauth=bad_verification_code');

  await expect(page.locator('#alphaAccessError'))
    .toContainText('Could not finish signing in with GitHub');
  await expect(page.locator('#alphaAccessError')).toContainText('already been used');
  await expect(landing(page)).toHaveClass(/active/);
  /* The marker is consumed, so a reload does not re-accuse the reader. */
  expect(new URL(page.url()).search).toBe('');
});

test('a reader returning from a finished sign-in is not sent back to the door', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'off', access: 'active', ready: 'ready' });
  await page.goto('/?entered=1');

  /*
   * They asked to pass once already and then signed in; the front door is not
   * where they were going. Anything else is the loop -- continue, sign in,
   * back to continue.
   */
  await expect(landing(page)).not.toHaveClass(/active/);
  expect(new URL(page.url()).search).toBe('');
});

test('the marker admits nobody on its own', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'invite', access: 'required', ready: 'ready' });
  /*
   * It says a sign-in finished, not who finished it, and it is a query string
   * anyone can type. With the gate on it changes nothing: the invitation is
   * still the only way in, and the session cookie is what admits anyone.
   */
  await page.goto('/?entered=1');

  await expect(landing(page)).toHaveClass(/active/);
  await expect(invite(page)).toBeVisible();
  await expect(passThrough(page)).toBeHidden();
});

test('a gate that cannot redeem says so instead of offering the field', async ({ page }) => {
  await mockPublicAlphaApi(page, { mode: 'invite', access: 'required', ready: 'database-unavailable' });
  await page.goto('/');

  await expect(wakeState(page)).toHaveText('Temporarily unavailable', SETTLES_AFTER_RETRIES);
  /* Redemption needs the database. Offering the field would spend a reader's
     one-time code on a request that was always going to fail. */
  await expect(invite(page)).toBeHidden();
  await expect(passThrough(page)).toBeHidden();
});
