'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

/* Without this the page can run a cached app.js and exercise yesterday's code. */
test.use({ serviceWorkers: 'block' });

/*
 * The owner workspace card is the only way in to the personal-workspace
 * foundation, and the foundation is opt-in. Both halves of that need proving.
 *
 * The half that matters today is the switched-off one. Every deployment
 * currently runs with NV_WORKSPACE_FOUNDATION_ENABLED unset, so the router
 * answers 404 and the login screen must look exactly as it did before this
 * card existed. A card that appeared anyway would offer an owner setup that
 * cannot work, on the first screen an invited tester sees.
 *
 * The Playwright server runs with DATABASE_URL empty, which is precisely the
 * disabled configuration -- so the first test needs no fixture for the
 * workspace routes at all. It asks the real server.
 */
async function openLoginScreen(page) {
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.evaluate(() => showPage('login'));
  await page.locator('#page-login.active').waitFor();
}

/*
 * Registered after mockPublicAlphaApi so it wins: Playwright gives precedence
 * to the most recently added route, and the fixture claims all of **\/api\/**.
 */
async function mockWorkspaceApi(page, handlers) {
  await page.route('**/api/workspace/**', async route => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace('/api/workspace', '') || '/session';
    const reply = handlers[key];
    if (!reply) return route.fulfill({ status: 404, json: { code: 'WORKSPACE_ROUTE_NOT_FOUND' } });
    const resolved = typeof reply === 'function' ? reply(route.request()) : reply;
    return route.fulfill({ status: resolved.status, json: resolved.json });
  });
}

const SESSION_OUT = { status: 200, json: { authenticated: false, csrfToken: 'test-csrf' } };

test('the owner card stays hidden when the foundation is switched off', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  /*
   * The workspace routes are deliberately NOT mocked. The fixture passes
   * unmatched /api/** through to the real server, which has no DATABASE_URL
   * and therefore answers 404 -- the production shape of "switched off".
   */
  await openLoginScreen(page);

  const card = page.locator('#workspaceCard');
  await expect(card).toBeHidden();

  /* The probe must have happened and concluded "off", not merely not run. */
  const probed = await page.evaluate(() => window.NebulaWorkspaceUI.current());
  expect(probed.available).toBe(false);
  expect(probed.authenticated).toBe(false);

  /* And the screen it shares is untouched. */
  await expect(page.locator('#loginBtn')).toBeVisible();
  await expect(page.locator('#tokenInput')).toBeVisible();
});

test('the owner card offers sign-in and setup when the foundation is enabled', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await mockWorkspaceApi(page, { '/session': SESSION_OUT });
  await openLoginScreen(page);

  await expect(page.locator('#workspaceCard')).toBeVisible();
  await expect(page.locator('#workspaceSignInBtn')).toBeVisible();

  /* The setup credential is behind a disclosure: signing in is the usual case. */
  const secret = page.locator('#workspaceSetupSecret');
  await expect(secret).toBeHidden();
  await expect(page.locator('#workspaceClaimToggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#workspaceClaimToggle').click();
  await expect(secret).toBeVisible();
  await expect(page.locator('#workspaceClaimToggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(secret).toHaveAttribute('type', 'password');
});

test('claiming ownership reports the owner session it actually established', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const sent = [];
  await mockWorkspaceApi(page, {
    '/session': SESSION_OUT,
    '/setup': request => {
      sent.push(JSON.parse(request.postData() || '{}'));
      return {
        status: 201,
        json: {
          authenticated: true,
          csrfToken: 'test-csrf-2',
          context: {
            principalId: 'p1', workspaceId: 'w1', role: 'owner',
            connection: { id: 'c1', provider: 'github', instance: 'https://github.com', providerUserId: '42', login: 'owner-login' }
          }
        }
      };
    }
  });
  await openLoginScreen(page);

  await page.locator('#tokenInput').fill('ghp_example_token');
  await page.locator('#workspaceClaimToggle').click();
  await page.locator('#workspaceSetupSecret').fill('a'.repeat(43));
  await page.locator('#workspaceClaimBtn').click();

  await expect(page.locator('#workspaceSignedIn')).toBeVisible();
  await expect(page.locator('#workspaceIdentity')).toContainText('owner-login');
  await expect(page.locator('#workspaceSignedOut')).toBeHidden();
  await expect(page.locator('#workspaceError')).toBeHidden();

  /* The credential field must not keep the secret after it has been used. */
  await expect(page.locator('#workspaceSetupSecret')).toHaveValue('');

  expect(sent).toHaveLength(1);
  expect(sent[0].token).toBe('ghp_example_token');
  expect(Object.keys(sent[0]).sort()).toEqual(['provider', 'setupSecret', 'token']);
});

test('a refused claim explains itself and does not present an owner session', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await mockWorkspaceApi(page, {
    '/session': SESSION_OUT,
    '/setup': { status: 403, json: { code: 'WORKSPACE_SETUP_REJECTED' } }
  });
  await openLoginScreen(page);

  await page.locator('#tokenInput').fill('ghp_example_token');
  await page.locator('#workspaceClaimToggle').click();
  await page.locator('#workspaceSetupSecret').fill('b'.repeat(43));
  await page.locator('#workspaceClaimBtn').click();

  const error = page.locator('#workspaceError');
  await expect(error).toBeVisible();
  /*
   * The specific reason, not a generic failure. "Something went wrong" would
   * leave the owner unable to tell a wrong credential from an already-claimed
   * deployment, which are the two things that actually produce this refusal.
   */
  await expect(error).toContainText('already been claimed');
  await expect(page.locator('#workspaceSignedIn')).toBeHidden();
  await expect(page.locator('#workspaceSignedOut')).toBeVisible();

  /* The button must return to service rather than staying in its working state. */
  await expect(page.locator('#workspaceClaimBtn')).toBeEnabled();
  await expect(page.locator('#workspaceClaimBtn')).toHaveText('Claim ownership');
});
