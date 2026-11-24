'use strict';

/*
 * The repository list in the page (features/repositories/repository-list-
 * controller.ts): a further page that cannot be read leaves the list as it
 * was; the filter narrows every card drawn, the next page's too; a stray
 * percent sign does not stop the filter; and a doubled press asks for one
 * page.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const repo = i => ({ full_name: `sandbox/repo-${i}`, name: `repo-${i}`, owner: 'sandbox', private: false, description: '', language: 'JavaScript', stars: 0, forks: 0, pushed_at: new Date().toISOString() });

/* Thirty repositories a page, for as many pages as asked; `refuse` names a page that cannot be read. */
async function manyRepositories(page, { refuse = 0, delay = 0 } = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const asked = [];
  await page.route('**/api/repos?*', async route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    asked.push(number);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (number === refuse) return route.fulfill({ status: 503, json: { error: 'The repository list could not be read.', code: 'OPERATION_FAILED' } });
    return route.fulfill({ json: Array.from({ length: 30 }, (_, k) => repo((number - 1) * 30 + k + 1)) });
  });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await expect(repos.locator('.repo-card')).toHaveCount(30);
  return asked;
}

const shown = page => page.locator('#repoGrid .repo-card:visible');

test('a further page that cannot be read leaves the list as it was, and can be asked for again', async ({ page }) => {
  await manyRepositories(page, { refuse: 2 });
  await page.locator('#moreReposBtn').click();
  await expect(page.locator('.toast').filter({ hasText: 'The repository list could not be read.' })).toBeVisible();
  /* It used to empty the whole list, and the pulse with it. */
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(30);
  await expect(page.locator('#moreReposBtn')).toBeVisible();
});

test('the filter narrows the next page too', async ({ page }) => {
  await manyRepositories(page);
  await page.locator('#repoFilter').fill('repo-1');
  await expect(shown(page)).toHaveCount(11);
  await page.locator('#moreReposBtn').click();
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(60);
  /* repo-31 to repo-60: none of them is repo-1-anything. */
  await expect(shown(page)).toHaveCount(11);
});

test('a percent sign in the filter narrows like any other character', async ({ page }) => {
  await manyRepositories(page);
  await page.locator('#repoFilter').fill('sandbox/repo-1');
  await expect(shown(page)).toHaveCount(11);
  /* Read as an address it is a malformed escape, which used to stop the filter where it stood. */
  await page.locator('#repoFilter').fill('sandbox/repo-1%');
  await expect(shown(page)).toHaveCount(0);
});

test('a doubled press on More asks for one page', async ({ page }) => {
  const asked = await manyRepositories(page, { delay: 500 });
  await page.locator('#moreReposBtn').dblclick();
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(60);
  await page.waitForTimeout(800);
  expect(asked).toEqual([1, 2]);
  await expect(page.locator('#repoGrid .repo-card')).toHaveCount(60);
});
