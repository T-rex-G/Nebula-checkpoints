'use strict';

/*
 * The address follows the workbench, and the workbench follows the address:
 * a tab change is a step Back undoes, and a pasted or edited link moves the
 * open repository to the tab it names without reloading it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

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

/*
 * A link opened from elsewhere adds no steps of its own. Opening the
 * repository passes through the editor on its way to the tab the address
 * names; that passage is not the reader's history, so Back leaves the
 * workbench the way the reader came in.
 */
test('an opened link adds no steps of its own to the history', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('about:blank');
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/audit$/);
  await page.goBack();
  await expect.poll(() => page.url()).toBe('about:blank');
});

/*
 * A link to a file opens the repository on that file, and an address edited
 * to name another file opens that one in place.
 */
test('a link to a file opens it, and an edited address opens another in place', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor/README.md');
  await expect(page.locator('#filePath')).toHaveText('README.md');
  await page.evaluate(() => { location.hash = '#/sandbox/demo@main/editor/package.json'; });
  await expect(page.locator('#filePath')).toHaveText('package.json');
  await expect(page).toHaveURL(/#\/sandbox\/demo@main\/editor\/package\.json$/);
});

/*
 * A screen without an address has none. Leaving the workbench for the
 * overview clears the address, so a reload opens the overview the reader
 * went to rather than the repository left behind.
 */
test('leaving the workbench clears its address, and a reload stays where the reader went', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await ui.rail(page, 'overview');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await expect.poll(() => page.url()).not.toContain('#');
  await page.reload();
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await expect(page.locator('#page-work')).not.toHaveClass(/active/);
});
