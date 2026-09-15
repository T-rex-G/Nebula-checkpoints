'use strict';
const { test, expect } = require('@playwright/test');
const ui = require('./semantic');
const { assetStampFor } = require('../../src/asset-stamp');

const scope = 'scopeAlice_0123456789abcdefXYZ';

async function mockApi(page, overrides = {}) {
  await page.route('**/readyz', route => route.fulfill({ json: { ok: true, database: 'ready' } }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    if (overrides[key]) return overrides[key](route, request, url);
    /*
     * An admitted session: the gate is on and this reader is already through
     * it. It used to say the gate was off, which reached the same place by
     * accident -- gate-off handed straight over to the workspace. It no longer
     * does: with entry open the landing page stays until the reader asks to
     * pass, so saying 'off' here would park every journey below on the front
     * door. Admission is what these tests need; the gate has its own suite.
     */
    if (url.pathname === '/api/alpha/status') return route.fulfill({ json: { mode: 'invite', authenticated: true, access: 'active' } });
    if (url.pathname === '/api/config') return route.fulfill({ json: { oauth: false, uploadMaxMb: 2048, gitDataMaxMb: 64, nativePushMaxMb: 64, contentsMaxMb: 40 } });
    if (url.pathname === '/api/me') return route.fulfill({ json: { login: 'alice', name: 'Alice', avatar: '', provider: 'github', authMethod: 'token', caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true }, offlineCacheScope: scope } });
    if (url.pathname === '/api/security/csrf') return route.fulfill({ json: { token: 'csrf-test-token', expiresAt: new Date(Date.now() + 600000).toISOString() } });
    if (url.pathname === '/api/repos') return route.fulfill({ json: [{ full_name: 'acme/demo', name: 'demo', owner: 'acme', private: true, description: 'Demo', language: 'JavaScript', stars: 1, forks: 0, pushed_at: new Date().toISOString() }] });
    if (url.pathname === '/api/repo/acme/demo') return route.fulfill({ json: { full_name: 'acme/demo', private: true, default_branch: 'main', branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }] } });
    if (url.pathname === '/api/repo/acme/demo/tree') return route.fulfill({ json: [] });
    if (url.pathname === '/api/safety') return route.fulfill({ json: { readOnly: false, freezeSync: false, protected: {} } });
    if (url.pathname === '/api/accounts') return route.fulfill({ json: { active: 0, accounts: [{ login: 'alice', provider: 'github', authMethod: 'token', avatar: '' }, { login: 'bob', provider: 'github', authMethod: 'token', avatar: '' }] } });
    if (url.pathname === '/api/accounts/switch-idx') return route.fulfill({ json: { ok: true, login: 'bob' } });
    if (url.pathname === '/api/logout') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: `Unmocked ${key}` } });
  });
}

test('PWA shell uses official release identity and installs a versioned shell cache', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/Nebulaverse-X/);
  await expect(await ui.enterRepositories(page)).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.evaluate(async () => {
    await caches.open('nv-api-perm');
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.unregister();
  });
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const keys = await page.evaluate(() => caches.keys());
  /* Named by the release tree rather than the version string: two builds of
     one version must not share a shell cache, or a returning browser keeps
     older scripts behind newer markup. */
  const { releaseTreeSha256 } = await page.evaluate(
    () => fetch('/api/version').then(response => response.json())
  );
  expect(keys).toContain(`nv-static-v${assetStampFor(releaseTreeSha256)}`);
  expect(keys).not.toContain('nv-api-perm');
});

test.describe('identity-boundary UI', () => {
  test.use({ serviceWorkers: 'block' });

test('offline repository access is opt-in and account switching purges scoped caches first', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await expect(page.getByRole('combobox', { name: 'Repository branch' }).locator('option')).toHaveCount(1);
  await page.evaluate(() => { void openSettings(); });
  const toggle = page.locator('#setOfflineRepo');
  await expect(toggle).toBeVisible();
  await toggle.check();
  await page.locator('#modalOk').click();

  const stored = await page.evaluate(scopeValue => localStorage.getItem(`nv_offline_repos:${scopeValue}`), scope);
  expect(JSON.parse(stored)).toContain('github:acme/demo');

  await page.evaluate(async () => {
    await caches.open('nv-api-scopeAlice_0123456789abcdefXYZ');
    await caches.open('nv-api-otherScope_0123456789abcdef');
  });
  await page.evaluate(() => document.querySelector('#accountBtn').click());
  await page.locator('[data-switch="1"]').click();
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('nv-api-scopeAlice_0123456789abcdefXYZ');
  const privateKeys = await page.evaluate(() => caches.keys().then(keys => keys.filter(key => key.startsWith('nv-api-'))));
  expect(privateKeys).toEqual([]);
});

test('failed remote logout still clears local private data and returns to login', async ({ page }) => {
  await mockApi(page, {
    'POST /api/logout': route => route.fulfill({ status: 503, json: { error: 'database unavailable' } })
  });
  await page.goto('/');
  await page.evaluate(async scopeValue => {
    sessionStorage.setItem('nv_me', JSON.stringify({ login: 'alice', offlineCacheScope: scopeValue }));
    localStorage.setItem(`nv_offline_repos:${scopeValue}`, JSON.stringify(['github:acme/demo']));
    await caches.open(`nv-api-${scopeValue}`);
  }, scope);
  /*
   * Two sign-out controls exist, one for each width, and only the one for the
   * current viewport is visible. Role queries skip hidden elements, so asking
   * for the button by name resolves to whichever is actually offered.
   */
  const logout = ui.button(page, 'Sign out');
  await logout.click();
  await expect(ui.screen(page, 'login')).toBeVisible();
  const result = await page.evaluate(() => ({ me: sessionStorage.getItem('nv_me'), caches: [] }));
  result.caches = await page.evaluate(() => caches.keys().then(keys => keys.filter(key => key.startsWith('nv-api-'))));
  expect(result.me).toBeNull();
  expect(result.caches).toEqual([]);
});

test('login boundary keeps the active offline identity while purging the sibling tab', async ({ page, context }) => {
  let activeAuthenticated = false;
  await mockApi(page, {
    'GET /api/me': route => activeAuthenticated
      ? route.fulfill({ json: { login: 'alice', name: 'Alice', avatar: '', provider: 'github', authMethod: 'token', caps: {}, offlineCacheScope: scope } })
      : route.fulfill({ status: 401, json: { error: 'sign in required', code: 'AUTH_REQUIRED' } }),
    'POST /api/login': route => {
      activeAuthenticated = true;
      return route.fulfill({ json: { login: 'alice', provider: 'github', authMethod: 'token' } });
    }
  });

  const sibling = await context.newPage();
  let siblingOnline = true;
  await mockApi(sibling, {
    'GET /api/me': route => siblingOnline
      ? route.fulfill({ json: { login: 'bob', name: 'Bob', avatar: '', provider: 'github', authMethod: 'token', caps: {}, offlineCacheScope: 'scopeBob_0123456789abcdefXYZ' } })
      : route.fulfill({ status: 503, json: { error: 'offline' } })
  });

  await sibling.goto('/');
  await expect(await ui.enterRepositories(sibling)).toBeVisible();
  await expect.poll(
    () => sibling.evaluate(() => JSON.parse(sessionStorage.getItem('nv_me') || 'null')?.login)
  ).toBe('bob');
  siblingOnline = false;

  await page.goto('/');
  await expect(ui.screen(page, 'login')).toBeVisible();
  await ui.secretField(page, 'GitHub Personal Access Token').fill('synthetic-login-token');
  await ui.button(ui.screen(page, 'login'), 'Enter orbit').click();
  await expect(await ui.enterRepositories(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('nv_me') || 'null')?.login)).toBe('alice');

  await expect(ui.screen(sibling, 'login')).toBeVisible();
  /*
   * Poll rather than read once. A single read assumes the sibling clears its
   * identity before it switches page; if the page switch lands first and the
   * clear follows in a later microtask, this observes the stale value and the
   * test fails for a reason that has nothing to do with the behaviour it checks.
   */
  await expect
    .poll(() => sibling.evaluate(() => sessionStorage.getItem('nv_me')))
    .toBeNull();
  await sibling.close();
});

});
