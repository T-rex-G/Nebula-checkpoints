'use strict';

/*
 * An alpha session that ends while the workbench is open.
 *
 * The server answers the next request with why -- the session expired, or
 * the access was revoked -- and the page takes the reader back to the
 * invitation gate, saying which. What the session kept in this browser is
 * purged before the gate is shown, and a new invitation starts the
 * application again: the boot that ran once for the ended session runs once
 * more for the new one.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const ENDINGS = [
  ['ALPHA_SESSION_EXPIRED', 'This alpha session expired. Redeem a new invitation to continue.'],
  ['ALPHA_ACCESS_REVOKED', 'This alpha access was revoked. Request a new invitation from the operator.']
];

for (const [code, message] of ENDINGS) {
  test(`${code}: the gate takes over, the session's browser state goes first, and a new invitation starts again`, async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/editor');
    await expect(page.locator('#page-work')).toHaveClass(/active/);
    /* The precondition: the session has kept something to purge. */
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('nv_me'))).not.toBeNull();

    /* The next request is answered for an ended session, once. */
    let ended = 0;
    await page.route('**/api/repo/sandbox/demo/commits?**', route => {
      if (ended) return route.fallback();
      ended += 1;
      return route.fulfill({ status: 401, json: { error: 'The alpha session has ended.', code } });
    });
    await ui.openTab(page, 'commits');

    await expect(page.locator('#page-alpha-access')).toHaveClass(/active/);
    await expect(page.locator('#alphaAccessError')).toHaveText(message);
    expect(ended).toBe(1);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await expect(page.locator('#page-work')).not.toHaveClass(/active/);

    /*
     * A new invitation: the application starts again, for the new session,
     * and the address still names the repository, so it opens there.
     */
    await page.locator('#alphaInviteInput').fill('alpha-invitation-code');
    await page.locator('#alphaTermsAccept').check();
    await page.locator('#alphaRedeemBtn').click();
    await expect(page.locator('#page-alpha-access')).not.toHaveClass(/active/);
    await expect(page.locator('#page-work')).toHaveClass(/active/);
    await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('nv_me'))).not.toBeNull();
  });
}
