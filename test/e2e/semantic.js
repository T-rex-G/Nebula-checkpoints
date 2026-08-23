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
  trustArticle
});
