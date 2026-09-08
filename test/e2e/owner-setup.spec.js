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
  await page.evaluate(() => { if (window.showPage) window.showPage('login'); });
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
    const resolved = typeof reply === 'function' ? await reply(route.request()) : reply;
    if (resolved.abort) return route.abort('failed');
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

  await page.locator('#workspaceToken').fill('ghp_example_token');
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

  await page.locator('#workspaceToken').fill('ghp_example_token');
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

for (const sessionReachable of [true, false]) {
  test(`a lost setup reply keeps recovery visible when the session check ${sessionReachable ? 'succeeds' : 'fails'}`, async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'required' });
    let committed = false;
    let writes = 0;
    await mockWorkspaceApi(page, {
      '/session': () => {
        if (!committed) return SESSION_OUT;
        if (!sessionReachable) return { abort: true };
        return { status: 200, json: {
          authenticated: true, csrfToken: 'test-recovered-csrf',
          context: { principalId: 'p1', workspaceId: 'w1', role: 'owner', connection: null }
        } };
      },
      '/setup': () => {
        writes += 1;
        committed = true;
        return { abort: true };
      }
    });
    await openInvitationGate(page);
    await page.locator('#workspaceToken').fill('ghp_example_token');
    await page.locator('#workspaceClaimToggle').click();
    await page.locator('#workspaceSetupSecret').fill('a'.repeat(43));
    await page.locator('#workspaceClaimBtn').click();

    const error = page.locator('#workspaceError');
    await expect(error).toBeVisible();
    await expect(error).toContainText('may have completed');
    await expect(error).toContainText('signing in with the same provider account');
    await expect(error).not.toContainText('Nothing was changed');
    await expect(page.locator('#workspaceToken')).toHaveValue('');
    await expect(page.locator('#workspaceSetupSecret')).toHaveValue('');
    if (sessionReachable) {
      await expect(page.locator('#workspaceSignedIn')).toBeVisible();
      await expect(page.locator('#workspaceIdentity')).toContainText('Signed in as workspace owner');
    } else {
      await expect(page.locator('#workspaceSignedIn')).toBeHidden();
      await expect(page.locator('#workspaceSignedOut')).toBeHidden();
      await expect(page.locator('#workspaceCardNote')).toContainText('session status is unavailable');
    }
    expect(writes).toBe(1);
    await expect(page.locator('#page-alpha-access.active')).toBeVisible();
    await expect(page.locator('#alphaInviteInput')).toBeVisible();
  });
}

/*
 * The gate. An owner on an `invite` deployment never reaches the login screen:
 * alpha-ui's boot() raises the invitation gate over everything whenever the
 * mode is not `off` and no cohort session exists. Without an entry point here,
 * owner setup is unreachable on exactly the deployment it was built for.
 *
 * The server side needs nothing: /api/workspace mounts ahead of
 * app.use('/api', alphaAccessBoundary), so these routes were always outside
 * the invitation boundary. This is the client catching up to that.
 */
async function openInvitationGate(page) {
  await page.goto('/');
  await page.locator('#page-alpha-access.active').waitFor();
}

test('the gate offers owner setup without an invitation', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await mockWorkspaceApi(page, { '/session': SESSION_OUT });
  await openInvitationGate(page);

  const card = page.locator('#workspaceCard');
  await expect(card).toBeVisible();
  /* Hosted on the gate itself, not left behind on a screen the gate covers. */
  await expect(page.locator('#page-alpha-access #workspaceCard')).toBeVisible();
  await expect(card).toContainText('No invitation is needed');

  /* The invitation route is untouched and still the primary path. */
  await expect(page.locator('#alphaInviteInput')).toBeVisible();
  await expect(page.locator('#alphaRedeemBtn')).toBeVisible();
});

test('the gate is unchanged when the foundation is switched off', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  /* Unmocked: the real server has no DATABASE_URL, so the router answers 404. */
  await openInvitationGate(page);

  await expect(page.locator('#workspaceCard')).toBeHidden();
  await expect(page.locator('#alphaInviteInput')).toBeVisible();
  const probed = await page.evaluate(() => window.NebulaWorkspaceUI.current());
  expect(probed.available).toBe(false);
});

test('an owner who signs in at the gate is told what it does not grant', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await mockWorkspaceApi(page, {
    '/session': SESSION_OUT,
    '/sign-in': {
      status: 200,
      json: {
        authenticated: true, csrfToken: 'test-csrf-2',
        context: {
          principalId: 'p1', workspaceId: 'w1', role: 'owner',
          connection: { id: 'c1', provider: 'github', instance: 'https://github.com', providerUserId: '42', login: 'owner-login' }
        }
      }
    }
  });
  await openInvitationGate(page);

  await page.locator('#workspaceToken').fill('ghp_example_token');
  await page.locator('#workspaceSignInBtn').click();

  await expect(page.locator('#workspaceIdentity')).toContainText('owner-login');
  /*
   * The claim that would be false is the tempting one: that signing in as the
   * owner automatically enters the repository app. It does not: a selected
   * credential and explicit owner workbench entry are still required.
   */
  const note = page.locator('#workspaceScopeNote');
  await expect(note).toBeVisible();
  await expect(note).toContainText('open the owner workbench');

  /* And it must not have let itself past the gate. */
  await expect(page.locator('#page-alpha-access.active')).toBeVisible();
  await expect(page.locator('#alphaInviteInput')).toBeVisible();
});

test('an owner connects, selects, lists and disconnects a Git account without a tester invitation', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  let bound = false, selected = false, reads = 0;
  const connection = { id: 'c1', provider: 'github', instance: 'https://github.com', providerUserId: '99', login: 'execution-account' };
  const context = () => ({ principalId: 'p1', workspaceId: 'w1', role: 'owner', connection: selected ? connection : null });
  await mockWorkspaceApi(page, {
    '/session': { status: 200, json: { authenticated: true, csrfToken: 'test-csrf', context: context() } },
    '/connections': () => ({ status: 200, json: { connections: bound ? [{ ...connection, credentialStored: true, selected }] : [] } }),
    '/connections/connect': request => {
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({ provider: 'github', token: 'synthetic-connection-token' });
      bound = true; return { status: 201, json: { id: 'c1' } };
    },
    '/connections/select': request => {
      expect(request.postDataJSON()).toEqual({ workspaceId: 'w1', connectionId: 'c1' });
      selected = true; return { status: 200, json: { context: context() } };
    },
    '/connections/disconnect': () => { bound = false; selected = false; return { status: 200, json: { ok: true } }; },
    '/repositories': request => {
      expect(request.method()).toBe('GET'); expect(selected).toBe(true); reads++;
      return { status: 200, json: { repositories: [{ fullName: 'execution-account/private-repo', private: true }], hasMore: false } };
    }
  });
  await openInvitationGate(page);
  await expect(page.locator('#workspaceSignedIn')).toBeVisible();
  await page.locator('#workspaceGitPanel summary').click();
  await expect(page.locator('#workspaceGitConnections')).toContainText('No Git accounts');
  await page.getByLabel('Git connection token', { exact: true }).fill('synthetic-connection-token');
  await page.getByRole('button', { name: 'Connect or refresh this account', exact: true }).click();
  await expect(page.locator('#workspaceGitToken')).toHaveValue('');
  await expect(page.locator('#workspaceGitConnections')).toContainText('token stored for this session');
  await page.getByRole('button', { name: 'Select execution-account on https://github.com', exact: true }).click();
  await expect(page.locator('#workspaceIdentity')).toContainText('execution-account');
  expect(await page.evaluate(() => window.NebulaWorkspaceUI.current().context.principalId)).toBe('p1');
  await page.locator('#workspaceGitRepos').click();
  await expect(page.locator('#workspaceGitRepositories')).toContainText('execution-account/private-repo');
  await expect(page.locator('#page-alpha-access.active')).toBeVisible();
  await expect(page.locator('#alphaInviteInput')).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole('button', { name: 'Disconnect execution-account on https://github.com', exact: true }).click();
  await expect(page.locator('#workspaceGitConnections')).toContainText('No Git accounts');
  await expect(page.locator('#workspaceGitRepositories')).toBeEmpty();
  await expect(page.locator('#workspaceIdentity')).toContainText('No Git connection is selected');
  expect(await page.evaluate(() => window.NebulaWorkspaceUI.current().authenticated)).toBe(true);
});
