'use strict';
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * Deleting a repository is a sensitive mutation, asked for the way a reader
 * asks for it: from the command palette, confirmed by name, then verified by
 * re-entering the provider token. The grant the step-up returns is for this
 * action and this repository, and the deletion carries it beside the CSRF
 * token.
 */
test('PAT sensitive mutation obtains a scoped grant and sends both CSRF and step-up headers', async ({ page }) => {
  let stepUpRequest = null;
  let mutation = null;
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/security/csrf', route => route.fulfill({ json: {
    token: 'csrf-test-token', expiresAt: new Date(Date.now() + 600000).toISOString()
  } }));
  await page.route('**/api/security/step-up', route => {
    const request = route.request();
    stepUpRequest = { body: request.postDataJSON(), headers: request.headers() };
    return route.fulfill({ json: {
      grant: 'single-use-grant', action: 'repository.delete', assurance: 'credential',
      expiresAt: new Date(Date.now() + 300000).toISOString()
    } });
  });
  await page.route('**/api/repo/sandbox/demo', route => {
    const request = route.request();
    if (request.method() !== 'DELETE') return route.fallback();
    mutation = { headers: request.headers(), body: request.postDataJSON() };
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await ui.paletteOption(page, /Delete this repository/).click();
  const confirm = ui.dialog(page, 'Delete repository');
  await confirm.locator('#drName').fill('sandbox/demo');
  await ui.button(confirm, 'Delete forever').click();

  /*
   * The step-up fields are reached by their labels. Both labels were present
   * but unassociated, so neither field had an accessible name until this
   * conversion required one -- in the flow that re-authenticates a sensitive
   * mutation.
   */
  const stepUp = ui.dialog(page, 'Verify sensitive action');
  const loginField = ui.field(stepUp, /Type the active account login/);
  await expect(loginField).toBeVisible();
  await loginField.fill('alpha-tester');
  await ui.secretField(stepUp, /Re-enter the current provider token/).fill('provider-token-value');
  await ui.button(stepUp, 'Authorize once').click();
  await expect(page.locator('.toast').last()).toContainText('Repository deleted');

  expect(stepUpRequest.body).toEqual({
    action: 'repository.delete',
    scope: { owner: 'sandbox', repo: 'demo' },
    confirm: 'alpha-tester',
    credential: 'provider-token-value'
  });
  expect(stepUpRequest.headers['x-nv-csrf']).toBe('csrf-test-token');
  expect(stepUpRequest.headers['x-nv']).toBe('1');
  expect(mutation.headers['x-nv-step-up']).toBe('single-use-grant');
  expect(mutation.headers['x-nv-csrf']).toBe('csrf-test-token');
  expect(mutation.body).toEqual({ confirmation: 'sandbox/demo' });
});
