'use strict';

/*
 * Settings, used by the page: the GitHub App's part of it as the invite-only
 * alpha sends it -- a connection named by its stable key and nothing that
 * names a person -- drawn from what was sent, refreshed and let go by that
 * key; a disconnect the server has not finished, said as one, with the
 * reader still signed in; and GitHub's answer read once and taken out of the
 * address. The modules are asked directly by test/page-settings.test.js.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const KEY = 'c'.repeat(64);
const connection = status => ({ connectionKey: KEY, accountType: 'User', repositorySelection: 'selected', status, lastVerifiedAt: '2026-11-01T10:00:00.000Z', active: true });

test('the alpha\'s installation is drawn from what was sent, refreshed and disconnected by its key', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let status = 'suspended';
  const sent = [];
  await page.route('**/api/github-app/status', route => route.fulfill({ json: { enabled: true, webhookConfigured: true, connections: [connection(status)] } }));
  await page.route('**/api/github-app/refresh', route => {
    sent.push(['refresh', route.request().postDataJSON()]);
    status = 'connected';
    return route.fulfill({ json: { connection: connection(status) } });
  });
  await page.route('**/api/github-app/disconnect', route => {
    sent.push(['disconnect', route.request().postDataJSON()]);
    return route.fulfill({ status: 202, json: { ok: false, status: 'pending', results: [] } });
  });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  const card = settings.locator('.github-app-connection');
  await expect(card).toContainText('Suspended');
  await expect(card.locator('.github-app-identity')).toHaveText(/GitHub installation\s*User/);
  await expect(card).not.toContainText(/NaN|Unknown|Authorized by/);
  await expect(card.locator('dd').first()).toHaveText('Selected repositories only');

  await ui.button(card, 'Refresh health').click();
  await expect(page.locator('.toast.ok').filter({ hasText: 'GitHub App installation health refreshed' })).toBeVisible();
  await expect(settings.locator('.github-app-health')).toHaveText('Healthy');
  expect(sent).toEqual([['refresh', { connectionKey: KEY }]]);

  page.once('dialog', dialog => dialog.accept());
  await ui.button(settings.locator('.github-app-connection'), 'Disconnect').click();
  await expect(page.locator('.toast').filter({ hasText: 'Provider cleanup is pending. Keep this session open and retry shortly.' })).toBeVisible();
  expect(sent).toEqual([['refresh', { connectionKey: KEY }], ['disconnect', { connectionKey: KEY }]]);
  /* Nothing was let go: the installation is still listed, its control is back, and the reader is still signed in. */
  await expect(page.locator('.toast').filter({ hasText: 'disconnected' })).toHaveCount(0);
  await expect(ui.button(settings.locator('.github-app-connection'), 'Disconnect')).toBeEnabled();
  await expect(settings.locator('.github-app-health')).toHaveText('Healthy');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(ui.screen(page, 'overview')).toBeVisible();
});

test('GitHub\'s answer is said once and taken out of the address', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/?githubApp=error&code=INSTALLATION_DENIED');
  await expect(page.locator('.toast.err').filter({ hasText: 'GitHub App connection was not completed (installation denied)' })).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('in light, a link drawn as a button reads as one, and the rows of an installation are ruled', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nv_theme', 'light'));
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/github-app/status', route => route.fulfill({ json: { enabled: true, webhookConfigured: true, connections: [{
    installationId: 42, accountLogin: 'acme', accountType: 'Organization', avatar: '', repositorySelection: 'all', permissions: {}, authorizedByLogin: 'octo',
    status: 'connected', lastVerifiedAt: '2026-11-01T10:00:00.000Z', installationUrl: 'https://github.com/settings/installations/42', active: true
  }] } }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  const manage = settings.getByRole('link', { name: 'Manage on GitHub' });
  await expect(manage).toHaveAttribute('href', 'https://github.com/settings/installations/42');
  await expect(manage).toHaveCSS('text-decoration-line', 'none');
  await expect(settings.getByRole('link', { name: /Support & feedback/ })).toHaveCSS('text-decoration-line', 'none');
  /* Each row is ruled off by a line the light page can show: ink, not white on white. */
  const rules = await settings.locator('.github-app-meta > div').evaluateAll(rows => rows.map(row => getComputedStyle(row).borderTopColor));
  expect(rules).toHaveLength(3);
  for (const rule of rules) {
    const [r, g, b] = rule.match(/[\d.]+/g).map(Number);
    expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, `${rule} is ink`).toBeLessThan(0.5);
  }
});
