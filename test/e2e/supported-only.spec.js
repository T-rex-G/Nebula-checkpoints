'use strict';

/*
 * Only what is Supported is offered.
 *
 * Every capability in the GitHub registry is Supported now, the last four on
 * live-provider and hosted evidence, so the real registry shows the rule only
 * from one side: what it promoted is offered. The other side is shown on a
 * projection that holds capabilities back. Every control bound to one is out
 * of the page and the accessibility tree, on the repositories screen and
 * across the workbench, and nothing anywhere says Experimental or
 * Unavailable, while the Supported controls are still there to be used.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');
const registry = require('../../config/public-alpha-capabilities.json');

test.use({ serviceWorkers: 'block' });

const features = registry.providers.github['hosted-alpha'];
/* The four promoted last, each with a control of its own on these screens. */
const heldBack = ['repository.create', 'repository.delete', 'notifications', 'live-events'];

async function inventory(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-feature]')].map(element => ({
    feature: element.dataset.feature,
    id: element.id || element.textContent.trim().slice(0, 40),
    rendered: element.offsetParent !== null || getComputedStyle(element).position === 'fixed',
    hidden: element.hidden === true || element.closest('[hidden]') !== null
  })));
}

async function screens(page) {
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await expect(repos.getByRole('button', { name: 'Settings' })).toBeVisible();
  const seen = [await inventory(page)];
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await expect(page.locator('#page-work')).toBeVisible();
  seen.push(await inventory(page));
  return seen;
}

test('the registry offers every GitHub capability as Supported', async ({ page }) => {
  expect(Object.keys(features).filter(feature => features[feature][0] !== 'Supported'),
    'a capability that is not Supported has to be proven or held back by name here').toEqual([]);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const [repositories] = await screens(page);
  const offered = new Set(repositories.filter(control => control.rendered && !control.hidden).map(control => control.feature));
  expect(offered.has('repository.create') && offered.has('notifications'),
    'the repositories screen offers creation and notifications').toBe(true);
  await expect(page.locator('body')).not.toContainText(/\b(?:Experimental|Unavailable)\b/);

  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await expect(ui.paletteOption(page, /Delete this repository/)).toHaveCount(1);
});

test('nothing held back is drawn, named or reachable', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', demote: heldBack });
  const seen = await screens(page);

  for (const controls of seen) {
    const offered = controls.filter(control => heldBack.includes(control.feature) && control.rendered && !control.hidden);
    expect(offered, 'controls for capabilities that are not Supported must not be rendered').toEqual([]);
  }
  expect(seen.flat().some(control => heldBack.includes(control.feature)),
    'the held-back controls exist in the page, so their absence is the rule at work').toBe(true);
  expect(seen[1].some(control => !heldBack.includes(control.feature) && control.rendered && !control.hidden),
    'the workbench still offers its Supported controls').toBe(true);
  await expect(page.locator('body')).not.toContainText(/\b(?:Experimental|Unavailable)\b/);
  for (const feature of heldBack) {
    await expect(page.locator(`[data-feature="${feature}"]:visible`), `${feature} is reachable`).toHaveCount(0);
  }

  /* The palette offers none of them either. */
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await expect(ui.paletteOption(page, /Delete this repository/)).toHaveCount(0);
});
