'use strict';

/*
 * Only what is Supported is offered.
 *
 * Once the server has said what this connection can do, a control for
 * anything it cannot -- an installation connection cannot create a personal
 * repository -- is not drawn at all: no dimmed button, no Experimental or
 * Unavailable badge, nothing in the accessibility tree. The server refuses
 * the request regardless.
 *
 * Before that answer, or when asking for it failed, nothing is hidden. That
 * is an outage, not a verdict, and the controls stay where they are, refused
 * out loud from pointer and keyboard alike -- a dimmed control that does
 * nothing, with no way to find out why, is what this file was first written
 * to prevent.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function repositoriesScreen(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', authMethod: 'github-app' });
  await page.goto('/');
  return ui.enterRepositories(page);
}

/*
 * Pressed the way a reader presses it: a real pointer, at the control's own
 * coordinates. locator.click() cannot be used here, because Playwright reads
 * aria-disabled as disabled and would wait forever for a control that is meant
 * to stay pressable -- and a dispatched event would pass against a control the
 * browser never delivers a press to, which is the whole failure being tested.
 *
 * The wait is for the press to be deliverable rather than for a duration: a
 * screen arriving under its own entrance animation is not hit-testable for the
 * length of it, and that has nothing to do with what is being asserted.
 */
async function pressWithPointer(page, locator) {
  /*
   * Brought into view before its coordinates are read. The poll below asks
   * whether a pointer at the control's own centre lands on it, which is only
   * a question about layering if the control is on screen at all -- a control
   * further down the page answers "no" for the ordinary reason that nothing is
   * there, and the press being tested is one a reader makes after scrolling to
   * it. locator.click() is still avoided: it treats aria-disabled as disabled
   * and would wait forever for a control that is meant to stay pressable.
   */
  await locator.scrollIntoViewIfNeeded();
  await expect
    .poll(() => locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return !!hit && element.contains(hit);
    }), { message: 'the control never came within reach of a pointer' })
    .toBe(true);
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('a capability this connection does not have is not drawn at all', async ({ page }) => {
  const repos = await repositoriesScreen(page);
  await expect(ui.button(repos, 'Settings')).toBeVisible();
  await expect(repos.getByRole('button', { name: 'Create repository' })).toHaveCount(0);
  await expect(page.locator('#newRepoBtnRepos')).toBeHidden();
  /* No badge stands in for it either. */
  await expect(page.locator('.capability-state', { hasText: /Experimental|Unavailable/ })).toHaveCount(0);
  await expect(repos).not.toContainText(/\b(?:Experimental|Unavailable)\b/);
});

async function repositoriesDuringOutage(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', authMethod: 'github-app' });
  await page.route('**/api/account/capabilities**', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.goto('/');
  return ui.enterRepositories(page);
}

test('during a capability outage a refused action stays in place and says why when pressed', async ({ page }) => {
  const repos = await repositoriesDuringOutage(page);
  const create = ui.button(repos, 'Create repository');
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await pressWithPointer(page, create);
  await expect(ui.status(page, 'Notifications'), 'the press was swallowed with no reason given')
    .toContainText(/could not be loaded/i);
  /* Voicing the refusal is not permission to perform it. */
  await expect(ui.dialog(page, /New repository/i)).toHaveCount(0);
});

test('during a capability outage a refused action can be reached and refused from the keyboard', async ({ page }) => {
  const repos = await repositoriesDuringOutage(page);
  const create = ui.button(repos, 'Create repository');
  await create.focus();
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ui.status(page, 'Notifications')).toContainText(/could not be loaded/i);
  await expect(ui.dialog(page, /New repository/i)).toHaveCount(0);
});

test('an action the deployment allows is untouched', async ({ page }) => {
  /* The refusal path must not cost the ordinary one. Settings sits on the same
   * bar, carries no capability of its own, and opening it changes nothing. */
  const repos = await repositoriesScreen(page);
  const settings = ui.button(repos, 'Settings');
  await pressWithPointer(page, settings);
  await expect(ui.dialog(page, /Settings/i)).toBeVisible();
});
