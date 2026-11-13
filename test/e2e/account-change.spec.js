'use strict';

/*
 * An account change is an identity boundary crossed in the open.
 *
 * What the page held is purged before the server is asked, and the page then
 * starts again as whoever the server answers for. Between the two it is
 * nobody's, so the account sheet stays up with its controls held until the
 * start has ended, and only then is the change announced. These pin what a
 * reader meets however slowly the new account answers: nothing announced
 * early; a reader who leaves the sheet and goes elsewhere is left there, not
 * sent back to the overview; a repository they name meanwhile opens once the
 * session is known and not before; a refused change starts the page again as
 * who is still signed in; and the list of repositories is one account's,
 * once, however many listings were in flight and whoever was signed in when
 * they were asked.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const SECOND = Object.freeze({
  login: 'second-github', name: 'Second Account', avatar: '', provider: 'github', authMethod: 'token',
  offlineCacheScope: 'second-account-scope-0123456789',
  caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true }
});

/*
 * Two GitHub accounts. Once the switch is made the session is the second
 * account's, and it answers who it is only when the test lets it: the time a
 * real server takes, made as long as the test needs.
 */
async function twoAccounts(page, { refuse = false, removal = null } = {}) {
  await mockPublicAlphaApi(page, { access: 'active' });
  const session = { switched: false, removed: false, asked: 0, release: () => {} };
  const held = new Promise(resolve => { session.release = resolve; });
  await page.route('**/api/accounts', route => route.fulfill({ json: { active: 0, accounts: [
    { login: 'alpha-tester', provider: 'github' }, { login: 'second-github', provider: 'github' }
  ] } }));
  await page.route('**/api/accounts/switch-idx', route => {
    if (refuse) return route.fulfill({ status: 500, json: { error: 'The account could not be switched.' } });
    session.switched = true;
    return route.fulfill({ json: { ok: true, login: 'second-github' } });
  });
  /* A removal leaves the first account signed in, or nobody. */
  await page.route('**/api/accounts/remove', route => {
    session.removed = true;
    return route.fulfill({ json: removal });
  });
  await page.route('**/api/me', async route => {
    if (!session.switched && !session.removed) return route.fallback();
    session.asked += 1;
    await held;
    return session.switched ? route.fulfill({ json: SECOND }) : route.fallback();
  });
  return session;
}

/* Signed in on the overview with the account sheet open. */
async function openSheet(page) {
  await page.goto('/#/overview');
  await expect(page.locator('#ovWho')).toHaveText('Alpha Tester');
  await ui.button(page, 'Accounts').click();
  return ui.dialog(page, 'Accounts');
}

/* Signed in on the overview, the account sheet open, and Switch pressed. */
async function pressSwitch(page) {
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Switch' }).click();
  return sheet;
}

/* Every answer to a repository listing, held until released; `landed` settles once each has reached the page. */
async function heldListings(page) {
  const listings = { asked: 0, release: () => {}, landed: async () => {} };
  const held = new Promise(resolve => { listings.release = resolve; });
  const answers = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/repos') answers.push(response.finished());
  });
  await page.route('**/api/repos?*', async route => {
    listings.asked += 1;
    await held;
    await route.fallback();
  });
  listings.landed = async count => {
    await expect.poll(() => answers.length).toBe(count);
    await Promise.all(answers);
    /* The page reads an answer in the turns after it arrives: one frame later it has drawn what it will. */
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  return listings;
}

const switched = page => page.locator('.toast').filter({ hasText: 'Switched to second-github' });

/*
 * A screen changes inside a view transition, a frame or more after it is
 * asked for. Which screen the reader is on is read once any change under way
 * has finished, or a change they were never meant to see would not be seen.
 */
async function screenSettled(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
}

test('an account change is announced once the page has started again as the new account', async ({ page }) => {
  const session = await twoAccounts(page);
  const sheet = await pressSwitch(page);
  /* The new account has not said who it is: the sheet is up, nothing on it can be pressed, and nothing is announced. */
  await expect.poll(() => session.asked).toBe(1);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Switch' })).toBeDisabled();
  for (const control of await sheet.getByRole('button', { name: 'Remove' }).all()) await expect(control).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Add account' })).toBeDisabled();
  await expect(page.locator('.toast').filter({ hasText: 'Switched to' })).toHaveCount(0);
  session.release();
  await expect(switched(page)).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#ovWho')).toHaveText('Second Account');
  /* Focus goes back to what opened the sheet, on a page that is somebody's again. */
  await expect(ui.button(page, 'Accounts')).toBeFocused();
});

test('a reader who leaves the sheet and goes elsewhere while the page restarts is left there', async ({ page }) => {
  const session = await twoAccounts(page);
  const sheet = await pressSwitch(page);
  await expect.poll(() => session.asked).toBe(1);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  const repos = await ui.enterRepositories(page);
  session.release();
  await expect(switched(page)).toBeVisible();
  /* The start has ended. The reader is where they went, the list is the new account's, and the overview behind them is too. */
  await screenSettled(page);
  await expect(repos).toBeVisible();
  await expect(ui.screen(page, 'overview')).toBeHidden();
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  await expect(page.locator('#ovWho')).toHaveText('Second Account');
});

test('a repository named before the session is known opens once it is, and not before', async ({ page }) => {
  const session = await twoAccounts(page);
  const sheet = await pressSwitch(page);
  await expect.poll(() => session.asked).toBe(1);
  await sheet.getByRole('button', { name: 'Done' }).click();
  const repos = await ui.enterRepositories(page);
  await repos.getByRole('searchbox', { name: 'Filter repositories, or paste any public repository address' }).fill('sandbox/demo');
  await repos.getByRole('button', { name: /sandbox\/demo/ }).click();
  /* Nothing opens for nobody: the reader is still on the list. */
  await screenSettled(page);
  await expect(ui.screen(page, 'work')).toBeHidden();
  await expect(repos).toBeVisible();
  session.release();
  await expect(ui.screen(page, 'work')).toBeVisible();
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');
  await expect(page.locator('#branchSelect')).toHaveValue('main');
});

test('a refused account change starts the page again as who is still signed in', async ({ page }) => {
  await twoAccounts(page, { refuse: true });
  const sheet = await pressSwitch(page);
  await expect(page.locator('.toast').filter({ hasText: 'The account could not be switched.' })).toBeVisible();
  /* The sheet is given back, to try again or to leave. */
  await expect(sheet.getByRole('button', { name: 'Switch' })).toBeEnabled();
  await expect(page.locator('.toast').filter({ hasText: 'Switched to' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Done' }).click();
  /* What was purged before the server was asked is read again for the account that never left. */
  const repos = await ui.enterRepositories(page);
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  await expect(page.locator('#ovWho')).toHaveText('Alpha Tester');
});

test('an account removed is announced once the page has started again for who is left', async ({ page }) => {
  const session = await twoAccounts(page, { removal: { ok: true, removed: 'second-github', active: 0 } });
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Remove' }).last().click();
  await expect.poll(() => session.asked).toBe(1);
  await expect(sheet).toBeVisible();
  for (const control of await sheet.getByRole('button', { name: 'Remove' }).all()) await expect(control).toBeDisabled();
  await expect(page.locator('.toast').filter({ hasText: 'signed out' })).toHaveCount(0);
  session.release();
  await expect(page.locator('.toast').filter({ hasText: 'second-github signed out' })).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#ovWho')).toHaveText('Alpha Tester');
  /* Read again once, by the start itself. */
  const repos = await ui.enterRepositories(page);
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  await expect(page.locator('#reposPulseGrid .gx-pulse-cell').filter({ hasText: 'Galaxies' }).locator('.gx-pulse-value')).toHaveText('1');
});

test('the last account removed leaves the page at sign-in, with nobody to start as', async ({ page }) => {
  const session = await twoAccounts(page, { removal: { ok: true, removed: 'alpha-tester', empty: true } });
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.locator('.toast').filter({ hasText: 'alpha-tester signed out' })).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(ui.screen(page, 'login')).toBeVisible();
  expect(session.asked, 'nobody is asked who they are').toBe(0);
});

test('two listings in flight list each repository once', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/overview');
  const repos = await ui.enterRepositories(page);
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  const listings = await heldListings(page);
  const refresh = repos.getByRole('button', { name: 'Refresh repositories' });
  await refresh.click();
  await refresh.click();
  await expect.poll(() => listings.asked).toBe(2);
  listings.release();
  await listings.landed(2);
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  await expect(page.locator('#reposPulseGrid .gx-pulse-cell').filter({ hasText: 'Galaxies' }).locator('.gx-pulse-value')).toHaveText('1');
});

test('a listing that answers after its account has gone draws nothing', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.goto('/#/overview');
  const repos = await ui.enterRepositories(page);
  await expect(repos.locator('.repo-card')).toHaveCount(1);
  const listings = await heldListings(page);
  await repos.getByRole('button', { name: 'Refresh repositories' }).click();
  await expect.poll(() => listings.asked).toBe(1);
  /* The reader signs out while the listing is on its way. */
  await ui.button(page, 'Sign out').click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  listings.release();
  await listings.landed(1);
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(0);
});
