'use strict';

const { test, expect } = require('./app-fixture');
const ui = require('../e2e/semantic');

test('browser login, repository edit and sign-out cross the real server and PostgreSQL', async ({ page, context, application }, testInfo) => {
  const { origin, provider, query } = application;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  const login = ui.screen(page, 'login');
  await expect(login).toBeVisible();

  // Negative control: a credential the upstream service rejects must never
  // produce a session, even though the same browser can reach the application.
  await ui.secretField(page, 'GitHub Personal Access Token').fill('integration-invalid-credential');
  const rejected = page.waitForResponse(response => response.url() === `${origin}/api/login` && response.request().method() === 'POST');
  await ui.button(login, 'Enter orbit').click();
  expect((await rejected).status()).toBe(401);
  expect((await query('SELECT count(*)::int AS count FROM nv_sessions')).rows[0].count).toBe(0);
  await expect(login).toBeVisible();
  await page.locator('#trustErrorBackdrop').getByRole('button', { name: 'Close', exact: true }).click();

  await ui.secretField(page, 'GitHub Personal Access Token').fill(provider.token);
  await ui.button(login, 'Enter orbit').click();
  const repos = await ui.enterRepositories(page);
  await ui.button(repos, `Open repository ${provider.repository}`).click();
  await expect(ui.screen(page, 'work')).toBeVisible();
  await page.locator('#tree .tree-item', { hasText: 'README.md' }).click();
  await expect(page.locator('#filePath')).toHaveText('README.md');
  await expect(page.locator('.CodeMirror-code')).toContainText('Read through the real server.');
  const sessionRows = await query('SELECT data, cardinality(identity_keys) AS identities FROM nv_sessions');
  expect(sessionRows.rows).toHaveLength(1);
  expect(sessionRows.rows[0].identities).toBe(1);
  expect(sessionRows.rows[0].data).not.toContain(provider.token);

  const changedText = `# Verified ${testInfo.project.name}\n\nWritten through the browser, server, and provider boundary.\nUnicode survives: orbit Ω.\n`;
  await page.locator('.CodeMirror').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(changedText);
  await ui.screen(page, 'work').getByRole('button', { name: 'Commit', exact: true }).click();
  const commit = ui.dialog(page, 'Commit changes');
  await expect(commit).toBeVisible();
  await ui.field(commit, 'Commit message').fill('Verify real browser integration');
  const committed = page.waitForResponse(response => response.url() === `${origin}/api/repo/${provider.repository}/file` && response.request().method() === 'PUT');
  await ui.button(commit, 'Commit ✦').click();
  const commitResponse = await committed;
  expect(commitResponse.status(), await commitResponse.text()).toBe(200);
  await expect(ui.status(page, 'Notifications')).toContainText('Committed');
  expect((await provider.readFile('README.md')).text).toBe(changedText);
  expect(provider.requests.some(request => request.method === 'POST' && request.path.endsWith('/git/commits') && request.status === 201)).toBe(true);
  expect(provider.requests.some(request => request.method === 'PATCH' && request.path.endsWith('/git/refs/heads/main') && request.status === 200)).toBe(true);

  // A fresh page must read committed provider data and its server-side session,
  // rather than succeeding solely because the editor holds unsaved bytes.
  await page.reload();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(ui.screen(page, 'work')).toBeVisible();
  await expect(page.locator('#filePath')).toHaveText('README.md');
  await expect(page.locator('.CodeMirror-code')).toContainText('Unicode survives: orbit Ω.');
  const savedCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'nv_session');
  expect(savedCookie).toBeTruthy();
  expect(savedCookie.httpOnly).toBe(true);
  await page.locator('#navRail [data-rail="repos"]').click();
  await ui.button(ui.screen(page, 'repos'), 'Sign out').click();
  await expect(login).toBeVisible();
  expect((await query('SELECT count(*)::int AS count FROM nv_sessions')).rows[0].count).toBe(0);
  const replay = await fetch(`${origin}/api/accounts`, { headers: { Cookie: `nv_session=${savedCookie.value}` } });
  expect(replay.status).toBe(401);
  await replay.body.cancel();
  await page.reload();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(login).toBeVisible();
  expect(pageErrors).toEqual([]);
  await testInfo.attach('integration-evidence', {
    body: JSON.stringify({
      browser: testInfo.project.name, realApplicationRoutes: true, database: 'PostgreSQL scratch database',
      provider: 'disposable synthetic GitHub HTTP boundary', browserApiInterception: false,
      invalidCredentialRejected: true, sessionPersistedEncrypted: true, providerReadback: true,
      logoutRevokedSavedCookie: true, manualAssistiveTechnology: 'not assessed'
    }, null, 2),
    contentType: 'application/json'
  });
});
