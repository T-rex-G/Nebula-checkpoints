'use strict';

/*
 * The address follows the workbench, and the workbench follows the address:
 * a tab change is a step Back undoes, and a pasted or edited link moves the
 * open repository to the tab it names without reloading it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

test('back and forward move between tabs, and an edited address is followed', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();

  /* An address typed or pasted while the repository is open switches the tab in place. */
  await page.evaluate(() => { location.hash = '#/sandbox/demo@main/governance'; });
  await expect(page.locator('#tab-governance')).toBeVisible();
  await expect(page.locator('#tab-audit')).toBeHidden();

  /* A tab chosen in the app is a step in the history. */
  await page.evaluate(() => document.querySelector('.tab[data-tab="commits"]').click());
  await expect(page.locator('#tab-commits')).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/commits$/);

  await page.goBack();
  await expect(page.locator('#tab-governance')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#tab-audit')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#tab-governance')).toBeVisible();

  /* A name that is not a tab leaves the workbench as it was. */
  await page.evaluate(() => { location.hash = '#/sandbox/demo@main/nothing'; });
  await expect(page.locator('#tab-governance')).toBeVisible();
});
