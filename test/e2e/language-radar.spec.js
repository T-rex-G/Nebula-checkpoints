'use strict';
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');
test.use({ serviceWorkers: 'block' });

const repo = (name, language) => ({
  full_name: `acme/${name}`, name, owner: 'acme', private: false, language,
  pushed_at: new Date().toISOString()
});

async function repositories(page, languages) {
  await mockPublicAlphaApi(page, { access: 'active' });
  await page.route(/\/api\/repos(\?|$)/, route => route.fulfill({
    json: languages.map((language, index) => repo(`r${index}`, language))
  }));
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await ui.enterRepositories(page);
  await expect(page.locator('#reposPulse')).toBeVisible();
}

/*
 * "Languages 7" is true and it is not an answer: it cannot say which seven,
 * nor that one of them is nearly the whole estate while the rest are a file
 * each. The radar puts every language on its own spoke against a shared scale.
 */
test('languages are a shape, not a count', async ({ page }) => {
  await repositories(page, ['JavaScript', 'JavaScript', 'Python', 'Go', 'Rust']);
  await expect(page.locator('.wp-radar')).toBeVisible();
  await expect(page.locator('.wp-radar-spoke')).toHaveCount(4);
  /* Count descending, then alphabetical: the three singletons tie, so Go
     precedes Python. Ranking by frequency is what makes the shape mean
     something -- alphabetical spokes would be a word list in a circle. */
  await expect(page.locator('.wp-radar-label')).toHaveText(['JavaScript', 'Go', 'Python', 'Rust']);
  /* The bare count it replaced is gone, not drawn beside it. */
  const numbered = await page.evaluate(() => [...document.querySelectorAll('#reposPulseGrid dt')]
    .filter(dt => dt.textContent === 'Languages')
    .map(dt => !!dt.parentElement.querySelector('.gx-pulse-value')));
  expect(numbered).toEqual([false]);
});

/*
 * A polygon needs three corners. With one or two languages the chart is a line
 * pretending to be a shape, so the count stays instead.
 */
test('under three languages the count stays and no radar is drawn', async ({ page }) => {
  await repositories(page, ['JavaScript', 'JavaScript', 'Python']);
  await expect(page.locator('.wp-radar')).toHaveCount(0);
  await expect(page.locator('#reposPulseGrid').getByText('Languages')).toBeVisible();
});

/*
 * Past eight spokes the labels collide and every extra spoke is a slice of
 * angle nobody can measure, so the tail folds into one spoke that says how
 * many it stands for.
 */
test('a long tail folds into one spoke that says what it stands for', async ({ page }) => {
  await repositories(page, ['JavaScript', 'Python', 'Go', 'Rust', 'Swift', 'Ruby', 'C', 'Zig', 'Elixir', 'Nim']);
  await expect(page.locator('.wp-radar-spoke')).toHaveCount(8);
  await expect(page.locator('.wp-radar-label').last()).toHaveText('Other');
  await expect(page.locator('#reposPulse')).toContainText('grouped');
});
