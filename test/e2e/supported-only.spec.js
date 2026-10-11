'use strict';

/*
 * Only what is Supported is offered.
 *
 * With the real registry projected for a GitHub account, every control bound
 * to a capability that is not Supported is out of the page and the
 * accessibility tree, on the repositories screen and across the workbench,
 * and nothing anywhere says Experimental or Unavailable. A control bound to a
 * Supported capability is still there to be used.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');
const registry = require('../../config/public-alpha-capabilities.json');

test.use({ serviceWorkers: 'block' });

const features = registry.providers.github['hosted-alpha'];
const notSupported = Object.keys(features).filter(feature => features[feature][0] !== 'Supported');

async function inventory(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-feature]')].map(element => ({
    feature: element.dataset.feature,
    id: element.id || element.textContent.trim().slice(0, 40),
    rendered: element.offsetParent !== null || getComputedStyle(element).position === 'fixed',
    hidden: element.hidden === true || element.closest('[hidden]') !== null
  })));
}

test('nothing that is not Supported is drawn, named or reachable', async ({ page }) => {
  expect(notSupported.length, 'the registry still carries capabilities awaiting qualification').toBeGreaterThan(0);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await expect(repos.getByRole('button', { name: 'Settings' })).toBeVisible();

  const screens = [];
  screens.push(await inventory(page));
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await expect(page.locator('#page-work')).toBeVisible();
  screens.push(await inventory(page));

  for (const controls of screens) {
    const offered = controls.filter(control => notSupported.includes(control.feature) && (control.rendered && !control.hidden));
    expect(offered, 'controls for capabilities that are not Supported must not be rendered').toEqual([]);
  }
  expect(screens[1].some(control => !notSupported.includes(control.feature) && control.rendered && !control.hidden),
    'the workbench still offers its Supported controls').toBe(true);
  await expect(page.locator('body')).not.toContainText(/\b(?:Experimental|Unavailable)\b/);
  for (const feature of notSupported) {
    await expect(page.locator(`[data-feature="${feature}"]:visible`), `${feature} is reachable`).toHaveCount(0);
  }

  /* The palette offers none of them either. */
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await expect(ui.paletteOption(page, /Delete this repository/)).toHaveCount(0);
});
