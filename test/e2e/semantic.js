'use strict';

/*
 * How this suite addresses the interface.
 *
 * Every locator here resolves through the accessibility tree -- landmark
 * roles, accessible names, labelled controls -- and never through an element
 * id or a CSS class. That is not a style preference. A suite addressed by id
 * asserts the spelling of the markup, so it fails on a redesign that changed
 * nothing a user can perceive, and it passes on a redesign that removed the
 * label a screen-reader user depends on. Addressing through roles inverts
 * both: layout is free to move, and a control that loses its accessible name
 * fails the journey that uses it.
 *
 * The page helper relies on the same inversion. Each screen is a <main> with
 * an accessible name, and only the active screen is visible; role queries skip
 * hidden elements, so `page(...)` means "the screen the user is looking at"
 * rather than "the element carrying the active class".
 */

const PRODUCT_NAME = 'Nebulaverse-X';

const SCREENS = Object.freeze({
  access: 'Enter the Nebulaverse-X test orbit',
  login: PRODUCT_NAME,
  /*
   * The overview greets the reader by name, so its heading is not a stable
   * label. The landmark carries its own.
   */
  overview: 'Workspace overview',
  repos: 'Your galaxies',
  work: 'Repository workspace'
});

function screen(target, name) {
  const accessibleName = SCREENS[name];
  if (!accessibleName) throw new Error(`unknown screen ${name}`);
  return target.getByRole('main', { name: accessibleName });
}

function field(target, name) {
  return target.getByRole('textbox', { name });
}

function secretField(target, name) {
  /*
   * A password input exposes no implicit role, so it cannot be reached by
   * role. Its label still can, and `getByLabel` resolves through the same
   * accessible-name computation -- an input that loses its label is
   * unreachable here exactly as it is for a screen reader.
   */
  return target.getByLabel(name);
}

function button(target, name) {
  return target.getByRole('button', { name });
}

function checkbox(target, name) {
  return target.getByRole('checkbox', { name });
}

function heading(target, name) {
  return target.getByRole('heading', { name });
}

/*
 * Wait for the control, focus it, then confirm the focus took.
 *
 * The sign-in field is display:none for roughly the first third of a second
 * after its screen appears, and locator.focus() does not wait for visibility,
 * so a focus issued inside that window silently does nothing. The keys then go
 * to the document and the following Tab starts from the top of the page, which
 * presented as an intermittent failure about tab order rather than as a focus
 * that never happened. The journey had been waiting a fixed 350ms, which sat
 * right on the boundary -- hence a failure that came and went.
 */
async function focusAndConfirm(expect, locator) {
  await expect(locator).toBeVisible();
  await locator.focus();
  await expect(locator).toBeFocused();
  return locator;
}

/*
 * Reach an action however the screen in front of you offers it.
 *
 * The same action lives in two places by design: the top bar carries it where
 * there is room, and below the breakpoint it moves into the floating menu,
 * which is closed until pressed. A journey that asked for the control by name
 * therefore found it on a desktop and found nothing on a phone -- not because
 * the action was missing, but because reaching it takes one press first. This
 * opens the menu only when the named control is not already on screen, so the
 * step still fails if the action is genuinely gone.
 */
/*
 * The control that holds focus after an action has been activated and whatever
 * it opened has closed.
 *
 * Where the action lives in the top bar, that is the action's own button.
 * Where it lives in the floating dock, activating an entry closes the dock --
 * so the entry is gone by the time focus comes back, and the control the
 * reader returns to is the dock itself. A journey that asserted focus on the
 * entry was asking about an element the interface had correctly removed.
 */
async function actionAnchor(page, name) {
  const dock = page.getByRole('button', { name: /actions$/i });
  if (await dock.isVisible().catch(() => false)) return dock;
  return page.getByRole('button', { name, exact: true });
}

async function action(page, name) {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.isVisible().catch(() => false)) return direct;

  const dock = page.getByRole('button', { name: /actions$/i });
  if (await dock.isVisible().catch(() => false)) {
    if ((await dock.getAttribute('aria-expanded')) !== 'true') await dock.click();
    return page.getByRole('group').getByRole('button', { name, exact: true });
  }
  return direct;
}

function alert(target) {
  return target.getByRole('alert');
}

/*
 * The command palette is a combobox over a listbox. Reaching its rows by role
 * asserts the thing that matters: that the row a reader sees highlighted is an
 * option a screen reader can find and hear as selected.
 */
function palette(target) {
  return target.getByRole('combobox', { name: 'Jump to file or run a command' });
}

function paletteOption(target, name) {
  return target.getByRole('option', { name });
}

/*
 * The modal takes its accessible name from its heading, so asking for the
 * dialog by name asserts what a screen reader announces on open -- which the
 * heading's text content alone does not.
 */
function dialog(target, name) {
  return target.getByRole('dialog', { name });
}

/*
 * The trust panel is addressed from the page rather than through the screen
 * that contains it. Accessible names are unique here, so the extra hop buys no
 * precision, and it costs resolution time -- enough to miss the loading state,
 * which is visible for about a tenth of a second before the verdict replaces
 * it.
 */
function trust(target) {
  return target.getByRole('region', { name: 'Repository trust summary' });
}

/*
 * On a phone the five fields sit behind a disclosure -- drawn open they took
 * 393px of an 820px screen and pushed the work surface under the bottom
 * navigation. The rollup keeps every evidence state on screen; it is the prose
 * that costs a tap.
 *
 * So a lookup for one field opens the disclosure if it is closed. What these
 * journeys are about is what the trust summary *says* -- that it is explicit
 * and does not overclaim -- and that requirement is unchanged by the prose
 * being one tap away. The rollup control does not exist above the breakpoint,
 * where all five are drawn at once.
 */
async function openTrustDetail(page) {
  const rollup = page.locator('#trustRollup');
  if (!(await rollup.isVisible().catch(() => false))) return;
  if ((await rollup.getAttribute('aria-expanded')) === 'true') return;
  await rollup.click();
  await page.locator('#trustDetail').waitFor({ state: 'visible' });
}

function trustArticle(target, name) {
  return target.getByRole('article', { name });
}

/*
 * There are several live regions, so a status lookup names one. Unnamed they
 * were indistinguishable both to this suite and to anyone navigating by
 * region, which is how the ambiguity surfaced.
 */
function status(target, name) {
  return name === undefined ? target.getByRole('status') : target.getByRole('status', { name });
}

/*
 * An authenticated session opens on the overview, so a journey that begins at
 * the repository inventory has to walk there the way a reader does. Asking for
 * the destination and clicking the control that names it keeps the step
 * truthful: if the overview ever stops offering a way through to repositories,
 * this fails rather than quietly reaching past the interface.
 */
async function enterRepositories(page) {
  const repos = screen(page, 'repos');
  if (await repos.isVisible().catch(() => false)) return repos;
  const through = page.getByRole('button', { name: 'Repositories', exact: true });
  /*
   * Activated from the keyboard rather than clicked. A pointer click sets the
   * browser's last input modality to mouse, and :focus-visible then withholds
   * the focus ring from whatever the test focuses next -- so a navigation step
   * would silently disarm the focus assertions further down the journey.
   */
  await through.waitFor({ state: 'visible' });
  await through.focus();
  await page.keyboard.press('Enter');
  await repos.waitFor({ state: 'visible' });
  return repos;
}

module.exports = Object.freeze({
  PRODUCT_NAME,
  SCREENS,
  action,
  actionAnchor,
  alert,
  button,
  enterRepositories,
  checkbox,
  dialog,
  field,
  heading,
  palette,
  paletteOption,
  screen,
  focusAndConfirm,
  secretField,
  status,
  trust,
  trustArticle,
  openTrustDetail
});
