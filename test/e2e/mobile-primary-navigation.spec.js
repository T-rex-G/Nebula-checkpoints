'use strict';

/*
 * The primary rail carries the destinations the product is organised around.
 * It is drawn above 1140px and hidden below, and the comment above it says the
 * bottom navigation takes over -- but that bar lives inside the repository
 * workspace and carries workspace destinations: Files, Code, Push, History,
 * More. The two sets have nothing in common.
 *
 * So on a phone, Neural and Governance had no control at all. Overview and
 * Repositories survived only because the overview's own top bar happens to
 * carry them, and the rail's own test skips below 1140px, so nothing said so.
 *
 * Reachability is the claim, not the presence of a button: each destination
 * has to actually arrive.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });
test.skip(({ viewport }) => !viewport || viewport.width >= 1140, 'the rail draws itself above 1140px');

const DESTINATIONS = ['overview', 'repos', 'neural', 'governance'];

async function signedIn(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/overview');
  await page.getByRole('main').first().waitFor({ state: 'visible' });
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
}

async function insideRepository(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.reload();
  await expect(page.locator('#page-work')).toHaveClass(/active/);
}

const menuButton = page => page.getByRole('button', { name: /open navigation/i }).first();

test('a phone can open the primary navigation from the bar it is looking at', async ({ page }) => {
  await signedIn(page);

  const menu = menuButton(page);
  await expect(menu, 'no control opens the primary navigation on a phone').toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');

  /* Every destination the rail offers, not merely the two the overview's top
   * bar happens to duplicate. */
  for (const rail of DESTINATIONS) {
    await expect(
      page.locator(`#navRail [data-rail="${rail}"]`),
      `the ${rail} destination is not offered on a phone`
    ).toBeVisible();
  }
});

test('every primary destination arrives, and closes the menu behind it', async ({ page }) => {
  /*
   * From inside a repository, because Neural, Governance and the workbench are
   * views of an open repository and refuse when there is none. Reaching them
   * is the claim; inventing a repository to show is not.
   */
  const expectedPage = { overview: 'page-overview', repos: 'page-repos' };

  for (const rail of DESTINATIONS) {
    await insideRepository(page);
    await menuButton(page).click();
    await page.locator(`#navRail [data-rail="${rail}"]`).click();

    await expect(
      page.locator(`#${expectedPage[rail] || 'page-work'}`),
      `${rail} did not arrive`
    ).toHaveClass(/active/);

    /* A menu left open over the destination it just chose has not finished. */
    await expect(page.locator('#navRail')).not.toBeVisible();
  }
});

test('the menu can be dismissed without choosing anything', async ({ page }) => {
  await signedIn(page);
  const menu = page.getByRole('button', { name: /open navigation/i }).first();

  await menu.click();
  await expect(page.locator('#navRail')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#navRail')).not.toBeVisible();

  /* Focus goes back where it came from, or a keyboard reader is stranded at
   * the top of the document. */
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await menu.click();
  /* Beyond the drawer's own width, or the click lands on the drawer rather
   * than the scrim behind it. */
  const width = page.viewportSize().width;
  await page.locator('#navScrim').click({ position: { x: width - 20, y: 400 } });
  await expect(page.locator('#navRail')).not.toBeVisible();
});
