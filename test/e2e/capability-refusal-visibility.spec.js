'use strict';

/*
 * A refused capability is refused in two different ways, and which one a
 * reader gets depends on nothing but the element the action happens to be
 * drawn as.
 *
 * The palette and the floating menu draw their entries as divs. capability-ui
 * cannot set a `disabled` property on a div, so the click arrives and
 * runCapabilityAction says, out loud, why the action is refused. The
 * repositories top bar draws the same class of action as a <button>, so
 * capability-ui sets `disabled` -- and the browser then stops the press before
 * any of this code runs. The reason is on the control, but only as an
 * accessible description pointing at a note that is clipped out of the layout;
 * and `disabled` also takes the control out of the tab order, so the keyboard
 * reader the description was written for cannot reach it either.
 *
 * What is left is a dimmed + that does nothing, forever, with no way to find
 * out why. Reported from the hosted alpha as "the + button to create a repo
 * not working".
 *
 * A personal repository cannot be created through an installation connection.
 * The unavailable-connection fixture preserves this refusal coverage while
 * ordinary personal accounts can now use experimental creation.
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

test('a refused primary action says why when it is pressed', async ({ page }) => {
  const repos = await repositoriesScreen(page);
  const create = ui.button(repos, 'Create repository');

  /* The precondition is the point: if the deployment allowed creation there
   * would be no refusal to voice, and this would pass for the wrong reason. */
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute('aria-disabled', 'true');

  await pressWithPointer(page, create);

  await expect(
    ui.status(page, 'Notifications'),
    'the press was swallowed with no reason given'
  ).toContainText(/personal GitHub connection/i);

  /* Voicing the refusal is not permission to perform it. */
  await expect(ui.dialog(page, /New repository/i)).toHaveCount(0);
});

test('a refused primary action can be reached and refused from the keyboard', async ({ page }) => {
  const repos = await repositoriesScreen(page);
  const create = ui.button(repos, 'Create repository');

  /* `disabled` removes a control from the tab order, so the description
   * written for a screen reader was attached to something a screen reader
   * could never land on. */
  await create.focus();
  await expect(create).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(ui.status(page, 'Notifications')).toContainText(/personal GitHub connection/i);
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
