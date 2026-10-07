'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

test('sign-in offers GitHub token and configured OAuth without a provider or custom-host choice', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required' });
  await page.route('**/api/config', route => route.fulfill({ json: {
    oauth: true, uploadMaxMb: 25, gitDataMaxMb: 16, nativePushMaxMb: 16, contentsMaxMb: 25,
    githubApp: { enabled: true }
  } }));
  const logins = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/login') logins.push(request.postDataJSON());
  });
  await page.goto('/');
  const access = ui.screen(page, 'access');
  await ui.secretField(page, 'One-time invitation').fill('fixture-invitation');
  await ui.checkbox(page, /I accept/).check();
  await ui.button(access, 'Continue').click();
  const login = ui.screen(page, 'login');
  await expect(login).toBeVisible();
  await expect(login.getByRole('radiogroup')).toHaveCount(0);
  await expect(login.locator('input[type="url"]')).toHaveCount(0);
  await expect(login).not.toContainText(/GitLab|Gitea/);
  await expect(login.getByRole('button', { name: 'Continue with GitHub (OAuth)', exact: true })).toBeVisible();
  await expect(login).toContainText('GitHub App');
  await ui.secretField(page, 'GitHub Personal Access Token').fill('fixture-github-credential');
  await ui.button(login, 'Enter orbit').click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  expect(logins).toEqual([{ token: 'fixture-github-credential', provider: 'github' }]);
});

test('account switching hides retired identities and preserves the GitHub account index', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route('**/api/accounts', route => route.fulfill({ json: { active: 1, accounts: [
    { login: 'retired-lab', provider: 'gitlab' },
    { login: 'alpha-tester', provider: 'github' },
    { login: 'retired-tea', provider: 'gitea' },
    { login: 'second-github', provider: 'github' }
  ] } }));
  const switches = [];
  await page.route('**/api/accounts/switch-idx', route => {
    switches.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, login: 'second-github' } });
  });
  await page.goto('/');
  await ui.button(page, 'Accounts').click();
  const accounts = ui.dialog(page, 'Accounts');
  await expect(accounts.locator('.acct-row')).toHaveCount(2);
  await expect(accounts).not.toContainText(/retired-lab|retired-tea/);
  await expect(accounts.locator('.acct-row.active')).toContainText('alpha-tester');
  await accounts.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect.poll(() => switches).toEqual([{ idx: 3 }]);
});

for (const provider of ['gitlab', 'gitea']) {
  test(`a retired ${provider} offline identity is purged instead of opening the workspace`, async ({ page }) => {
    await page.addInitScript(provider => {
      sessionStorage.setItem('nv_me', JSON.stringify({
        login: 'retired-user', provider, offlineCacheScope: 'retiredScope_0123456789abcdef'
      }));
      localStorage.setItem('nv_offline_repos:retiredScope_0123456789abcdef', JSON.stringify([`${provider}:sandbox/demo`]));
    }, provider);
    await mockPublicAlphaApi(page, { access: 'active' });
    await page.route('**/api/me', route => route.abort('internetdisconnected'));
    await page.goto('/');
    await expect(ui.screen(page, 'login')).toBeVisible();
    await expect(ui.screen(page, 'overview')).not.toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('nv_me'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('nv_offline_repos:retiredScope_0123456789abcdef'))).toBeNull();
  });
}
