'use strict';
const { test, expect } = require('@playwright/test');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

test('PAT sensitive mutation obtains a scoped grant and sends both CSRF and step-up headers', async ({ page }) => {
  let stepUpRequest = null;
  let mutationHeaders = null;

  await page.route('**/readyz', route => route.fulfill({ json: { ok: true, database: 'ready' } }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/alpha/status') return route.fulfill({ json: { mode: 'off', authenticated: true, access: 'active' } });
    if (url.pathname === '/api/config') return route.fulfill({ json: { oauth: false, uploadMaxMb: 2048, gitDataMaxMb: 64, nativePushMaxMb: 64 } });
    if (url.pathname === '/api/me') return route.fulfill({ json: {
      login: 'alice', name: 'Alice', avatar: '', provider: 'github', authMethod: 'token',
      caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true },
      offlineCacheScope: 'scopeAlice_0123456789abcdefXYZ'
    } });
    if (url.pathname === '/api/repos') return route.fulfill({ json: [] });
    if (url.pathname === '/api/security/csrf') return route.fulfill({ json: {
      token: 'csrf-test-token', expiresAt: new Date(Date.now() + 600000).toISOString()
    } });
    if (url.pathname === '/api/security/step-up') {
      stepUpRequest = { body: request.postDataJSON(), headers: request.headers() };
      return route.fulfill({ json: {
        grant: 'single-use-grant', action: 'repository.delete', assurance: 'credential',
        expiresAt: new Date(Date.now() + 300000).toISOString()
      } });
    }
    if (request.method() === 'DELETE' && url.pathname === '/api/repo/acme/demo') {
      mutationHeaders = request.headers();
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${request.method()} ${url.pathname}` } });
  });

  await page.goto('/');
  await expect(ui.screen(page, 'repos')).toBeVisible();

  await page.evaluate(() => {
    window.__sensitiveResult = stepUpApi(
      'repository.delete',
      { owner: 'acme', repo: 'demo' },
      '/api/repo/acme/demo',
      { method: 'DELETE' },
      'Delete repository acme/demo'
    );
  });

  /*
   * The step-up fields are reached by their labels. Both labels were present
   * but unassociated, so neither field had an accessible name until this
   * conversion required one -- in the flow that re-authenticates a sensitive
   * mutation.
   */
  const stepUp = ui.dialog(page, 'Verify sensitive action');
  const loginField = ui.field(stepUp, /Type the active account login/);
  await expect(loginField).toBeVisible();
  await loginField.fill('alice');
  await ui.secretField(stepUp, /Re-enter the current provider token/).fill('provider-token-value');
  await ui.button(stepUp, 'Authorize once').click();
  await expect.poll(() => page.evaluate(() => window.__sensitiveResult)).toEqual({ ok: true });

  expect(stepUpRequest.body).toEqual({
    action: 'repository.delete',
    scope: { owner: 'acme', repo: 'demo' },
    confirm: 'alice',
    credential: 'provider-token-value'
  });
  expect(stepUpRequest.headers['x-nv-csrf']).toBe('csrf-test-token');
  expect(stepUpRequest.headers['x-nv']).toBe('1');
  expect(mutationHeaders['x-nv-step-up']).toBe('single-use-grant');
  expect(mutationHeaders['x-nv-csrf']).toBe('csrf-test-token');
});
