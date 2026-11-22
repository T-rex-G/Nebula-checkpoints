'use strict';

/*
 * A security tool chosen before a repository is. The rail used to refuse
 * with "Open a repository first"; now it asks which repository, filters as
 * the reader types, opens with the keyboard, and lands in the tool that was
 * chosen. The recent list it keeps holds names only, under the prefix the
 * account-boundary purge removes.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function chooseFromRail(page, target, prepare) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  if (prepare) await prepare(page);
  await page.goto('/');
  await expect(page.locator('#page-overview')).toBeVisible();
  const item = page.locator(`.nv-rail-item[data-rail="${target}"]`);
  if (!(await item.isVisible())) await page.locator('.page.active .nav-menu-btn').click();
  await item.click();
  const dialog = page.locator('#modal');
  await expect(dialog.getByRole('heading', { name: 'Choose a repository' })).toBeVisible();
  return dialog;
}

test('a security tool without a repository asks which one and lands in the tool', async ({ page }) => {
  const dialog = await chooseFromRail(page, 'audit');
  await expect(dialog.locator('.rp-pick-tool-name')).toHaveText('Audit');
  const search = dialog.getByRole('combobox', { name: 'Search repositories' });
  const options = dialog.getByRole('option');
  await expect(options.first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open Audit' })).toBeEnabled();

  /* Nothing matches: it says so, and there is nothing to open. */
  await search.fill('no-such-repository');
  await expect(dialog.locator('.rp-pick-empty')).toHaveText('No repository matches “no-such-repository”.');
  await expect(dialog.getByRole('button', { name: 'Open Audit' })).toBeDisabled();

  /* Typing narrows, the first match is the highlighted one, Enter opens it in the tool. */
  await search.fill('demo');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.first()).toContainText('sandbox/demo');
  await expect(search).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id'));
  await search.press('Enter');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');

  /* The repository is remembered as a name only, under the purged prefix. */
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_recent:repositories')));
  expect(recent).toEqual([{ owner: 'sandbox', name: 'demo' }]);
});

test('the picker is dismissed without opening anything', async ({ page }) => {
  const dialog = await chooseFromRail(page, 'exposure');
  await expect(dialog.locator('.rp-pick-tool-name')).toHaveText('Exposure');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#page-work')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('nv_recent:repositories'))).toBeNull();
});

test('a repository opened before is offered first, and a click opens the tool', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nv_recent:repositories', JSON.stringify([{ owner: 'sandbox', name: 'demo' }])));
  const dialog = await chooseFromRail(page, 'safeguards');
  await expect(dialog.locator('.rp-pick-group').first()).toHaveText('Recent');
  await dialog.getByRole('option').first().click();
  await expect(page.locator('#tab-safeguards')).toBeVisible();
});

/*
 * The dialog as a reader meets it: the rail's own mark beside the tool's
 * name, the search field ready for typing where a keyboard is the way in,
 * each repository with its sigil, what is known of it and who can see it,
 * and a listing longer than a page read on with "Load more".
 */
test('the picker carries the rail\u2019s mark, lists each repository as known, and reads on past a page', async ({ page }) => {
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const listing = Array.from({ length: 30 }, (_, at) => ({
    full_name: `sandbox/repo-${at}`, name: `repo-${at}`, owner: 'sandbox', private: at % 2 === 0, description: `Repository ${at}`, pushed_at: hourAgo
  }));
  const asked = [];
  const dialog = await chooseFromRail(page, 'neural', async browser => {
    await browser.route(url => url.pathname === '/api/repos', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const number = Number(new URL(route.request().url()).searchParams.get('page') || '1');
      asked.push(number);
      return route.fulfill({ json: number === 1 ? listing : [{ full_name: 'sandbox/late', name: 'late', owner: 'sandbox', private: false, description: 'Read on the second page', pushed_at: hourAgo }] });
    });
  });
  await expect(dialog.locator('.rp-pick-tool-name')).toHaveText('Neural');
  await expect(dialog.locator('.rp-pick-mark .nv-rail-i')).toHaveCount(1);
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  if (coarse) await expect(dialog.locator('#rpPickQuery')).not.toBeFocused();
  else await expect(dialog.locator('#rpPickQuery')).toBeFocused();

  const first = dialog.locator('.rp-pick-item', { hasText: 'sandbox/repo-0' });
  await expect(first.locator('.rp-pick-sigil svg')).toHaveCount(1);
  await expect(first.locator('.rp-pick-meta')).toHaveText(/^Repository 0 \u00b7 updated \S/);
  await expect(first.locator('.rp-pick-vis')).toHaveAttribute('data-visibility', 'private');
  await expect(first.locator('.rp-pick-vis')).toHaveAttribute('title', 'Private');
  const second = dialog.locator('.rp-pick-item').filter({ has: page.locator('.rp-pick-name', { hasText: /^sandbox\/repo-1$/ }) });
  await expect(second.locator('.rp-pick-vis')).toHaveAttribute('data-visibility', 'public');

  await expect(dialog.locator('#rpPickFoot')).toContainText('30 repositories loaded');
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.locator('#rpPickFoot')).toHaveText('31 repositories loaded');
  await expect(dialog.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await expect(dialog.locator('.rp-pick-item', { hasText: 'sandbox/late' })).toContainText('Read on the second page');
  expect(asked).toContain(2);
});
