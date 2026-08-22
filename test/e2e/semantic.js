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

function alert(target) {
  return target.getByRole('alert');
}

function status(target) {
  return target.getByRole('status');
}

module.exports = Object.freeze({
  PRODUCT_NAME,
  SCREENS,
  alert,
  button,
  checkbox,
  field,
  heading,
  screen,
  secretField,
  status
});
