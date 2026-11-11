'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi, openConnectedRepository, startNewFileAction } = require('./public-alpha-fixtures');
const ui = require('./semantic');

/*
 * "No success was claimed" is the assertion these states share. Outcome used
 * to be a colour class on the toast; it is announced text now, so the check
 * reads the notifications region for the word a listener would hear rather
 * than counting elements carrying a green style.
 */
function claimedSuccess(page) {
  return ui.status(page, 'Notifications').getByText(/^Success:/);
}

test.use({ serviceWorkers: 'block' });

test('cold start shows a waking state and a safe access action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'required', ready: 'waking' });
  await page.goto('/');
  await expect(ui.status(page, 'Service readiness')).toContainText(/Waking database|Ready/);
  const access = ui.screen(page, 'access');
  await expect(ui.heading(access, ui.SCREENS.access)).toBeVisible();
  await expect(ui.button(access, 'Continue')).toBeVisible();
  await expect(claimedSuccess(page)).toHaveCount(0);
});

test('loading state names checks in progress and preserves a next action', async ({ page }) => {
  /* The trust endpoints are held open, so the loading state is asserted rather than raced. */
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', trust: 'pending' });
  await page.goto('/');
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  await ui.openTrustDetail(page);
  await expect(ui.trustArticle(page, 'Connection trust')).toContainText('Checking provider');
  await expect(ui.trustArticle(page, 'Next action')).toContainText('Waiting for verified');
  /*
   * The phone layout folds the five fields behind one line: the count of
   * their states, named for the weakest. Above the breakpoint the line is not
   * drawn, and what it says is the same.
   */
  await expect(page.locator('#trustRollupStates')).toHaveText('5 inferred');
  await expect(page.locator('#trustSummary')).toHaveAttribute('data-trust-worst', 'Inferred');
  await expect(claimedSuccess(page)).toHaveCount(0);
});

test('empty state names the status and preserves a next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'empty' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await expect(repos).toContainText('No repositories yet');
  await expect(repos).toContainText('Create one');
  await expect(claimedSuccess(page)).toHaveCount(0);
});

for (const [repositoryState, assertion, action] of [
  ['current', 'Repository is current', 'Continue with the golden path'],
  ['stale', 'Treat the pipeline as stale', 'Re-verify the evidence chain'],
  ['partial', 'Access inventory is partial', 'Refresh the access inventory'],
  ['degraded', 'pipeline is degraded', 'Connect durable evidence storage']
]) {
  test(`${repositoryState} repository state is explicit and does not overclaim success`, async ({ page }) => {
    await openConnectedRepository(page, { repositoryState });
    const trust = ui.trust(page);
    await expect(trust).toBeVisible();
    await expect(trust).toContainText(assertion);
    await ui.openTrustDetail(page);
    await expect(ui.trustArticle(page, 'Next action')).toContainText(action);
    /* What a screen reader hears when the summary lands. */
    await expect(ui.status(page, 'Workspace updates')).toHaveText(/^Repository trust summary updated/);
    if (repositoryState !== 'current') await expect(trust).not.toContainText('verified success');
  });
}

test('recoverable repository error shows safe state and next action', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'error' });
  await page.goto('/');
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  await expect(page.locator('.trust-error-dialog')).toBeVisible();
  await expect(page.locator('.trust-error-dialog')).toContainText('Safe state now');
  await expect(page.locator('.trust-error-dialog')).toContainText('Retry opening');
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await expect(claimedSuccess(page)).toHaveCount(0);
});

/*
 * The dialog says every part of a failure in its own place, as text: what
 * happened, whether the provider or repository changed, the safe state, the
 * next action, and the correlation ID a reader can copy for support.
 */
test('a failed action is said in full, its correlation ID can be copied, and its words stay words', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'error' });
  await page.goto('/');
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  const dialog = page.getByRole('dialog', { name: 'The action was not completed' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const fields = await dialog.locator('.trust-error-field').evaluateAll(groups => groups.map(group => [
    group.querySelector('h3').textContent, (group.querySelector('p, code') || {}).textContent
  ]));
  expect(fields).toEqual([
    ['What happened', 'The sandbox repository could not be opened.'],
    ['Provider/repository changed', 'no'],
    ['Safe state now', 'The sandbox repository remains at the previously verified head.'],
    ['Next action', 'Retry opening the allowlisted sandbox repository.'],
    ['Correlation ID', 'fixture-provider-unavailable']
  ]);
  await expect(dialog.locator('details code')).toHaveText('PROVIDER_UNAVAILABLE');
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fixture-provider-unavailable');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  /* Whatever a provider says is shown as what it said: markup in it is text, never elements. */
  await page.route('**/api/repo/sandbox/demo', route => route.fulfill({
    status: 503,
    json: {
      error: 'Refused <img src=x onerror="document.title=\'owned\'"> by <b>upstream</b>',
      code: 'PROVIDER_UNAVAILABLE',
      correlationId: 'fixture-markup',
      providerChanged: 'no',
      safeState: 'Nothing changed <script>document.title="owned"</script>',
      nextAction: 'Retry.'
    }
  }));
  await ui.button(await ui.enterRepositories(page), /^Open repository /).first().click();
  await expect(dialog).toContainText('Refused <img src=x onerror="document.title=\'owned\'"> by <b>upstream</b>');
  await expect(dialog).toContainText('Nothing changed <script>document.title="owned"</script>');
  expect(await dialog.locator('img, b, script').count()).toBe(0);
  expect(await page.title()).not.toBe('owned');
});

for (const [mutation, expectedText, verified] of [
  ['blocked', 'blocked by the active policy', false],
  ['failed-unchanged', 'previously verified head', false],
  ['unknown', 'Do not retry', false],
  ['verified', 'Created verified.txt', true]
]) {
  test(`${mutation} controlled action has a truthful outcome`, async ({ page }) => {
    await openConnectedRepository(page, { mutation });
    await startNewFileAction(page, `${mutation}.txt`);
    if (verified) {
      await expect(ui.status(page, 'Notifications')).toContainText(expectedText);
      await expect(page.locator('.trust-error-dialog')).toHaveCount(0);
    } else {
      await expect(page.locator('.trust-error-dialog')).toContainText(expectedText);
      await expect(claimedSuccess(page)).toHaveCount(0);
    }
  });
}

/*
 * A capability the account cannot use is not offered: its control is not
 * drawn, no Unavailable badge stands in for it, and the server still refuses
 * it with its typed error. Repository creation is Supported, so the only
 * reason it is missing here is the account's limitation.
 */
test('unavailable GitHub account capability is not drawn and is refused by the server', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', capabilities: 'limited' });
  await page.goto('/');
  await expect(page.locator('#newRepoBtnRepos')).toBeHidden();
  await expect(page.locator('#newRepoBtnRepos + .capability-state')).toHaveCount(0);
  await expect(page.locator('.capability-state', { hasText: /Experimental|Unavailable/ })).toHaveCount(0);
});

for (const [access, message] of [
  ['revoked', 'access was revoked'],
  ['expired', 'session expired']
]) {
  test(`${access} access returns to the invitation gate with a safe next action`, async ({ page }) => {
    await mockPublicAlphaApi(page, { access });
    await page.goto('/');
    const gate = ui.screen(page, 'access');
    await expect(gate).toBeVisible();
    await expect(ui.alert(gate)).toContainText(message);
    await expect(ui.button(gate, 'Continue')).toBeVisible();
    await expect(claimedSuccess(page)).toHaveCount(0);
  });
}
