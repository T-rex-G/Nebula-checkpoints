'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * Every field that takes a name or a path the server matches exactly declines
 * what a phone keyboard does to text: iOS capitalises the first letter and
 * corrects words by default, and spellcheck="false" stops neither, so
 * "docs" arrives as "Docs" and "feature/x" as "Feature/x". These are the
 * fields the workbench draws itself; those its modules draw are asked of the
 * modules in test/overlay-motion.test.js, test/page-header.test.js and
 * test/corona-emergency.test.js.
 */

const SHA = 'a'.repeat(40);

async function declines(page, id) {
  const field = page.locator(`#${id}`);
  await expect(field).toBeVisible();
  for (const [name, value] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false']]) await expect(field, `${id} ${name}`).toHaveAttribute(name, value);
}
async function dismiss(page) {
  await page.locator('#modalClose').click();
  await expect(page.locator('#scrim')).toBeHidden();
}
async function command(page, label) {
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill(label);
  await ui.paletteOption(page, new RegExp(label)).first().click();
}

test('a new repository\u2019s name declines the phone keyboard', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', login: 'sandbox' });
  await page.goto('/');
  const repos = await ui.enterRepositories(page);
  await ui.button(repos, 'Create repository').click();
  await expect(ui.dialog(page, 'New repository')).toBeVisible();
  await declines(page, 'nrName');
});

test('a new file\u2019s path and a file\u2019s new path decline the phone keyboard; a path with a quote is offered whole', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/files', route => route.fulfill({ json: { files: ['README.md', 'docs/say "hi".md'] } }));
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/file', route => route.fulfill({ json: {
    path: new URL(route.request().url()).searchParams.get('path'), sha: 'c'.repeat(40), size: 0, content: '', binary: false
  } }));
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await command(page, 'New file');
  await declines(page, 'nfPath');
  await dismiss(page);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('say');
  await page.locator('#paletteList .pal-item', { hasText: 'docs/say "hi".md' }).first().click();
  await expect(page.locator('#renameFileBtn')).toBeVisible();
  await page.locator('#renameFileBtn').click();
  await declines(page, 'rnTo');
  await expect(page.locator('#rnTo')).toHaveValue('docs/say "hi".md');
});

test('a release\u2019s tag, and the Time Machine\u2019s path and branch, decline the phone keyboard', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/releases', route => route.fulfill({ json: [] }));
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/commits', route => route.fulfill({ json: [{ sha: SHA, message: 'First light', author: 'Ada', date: new Date().toISOString() }] }));
  await page.route(url => new URL(url).pathname === `/api/repo/sandbox/demo/commit/${SHA}`, route => route.fulfill({ json: { sha: SHA, message: 'First light', files: [] } }));
  await page.goto('/#/sandbox/demo@main/releases');
  await expect(page.locator('#newReleaseBtn')).toBeVisible();
  await page.locator('#newReleaseBtn').click();
  await declines(page, 'relTag');
  await dismiss(page);
  await page.goto('/#/sandbox/demo@main/commits');
  const commit = page.locator('#commitList .commit-item, #commitList > *').first();
  await expect(commit).toBeVisible();
  await commit.click();
  const paths = page.locator('[data-tm="paths"]');
  await expect(paths).toBeVisible();
  await paths.click();
  await declines(page, 'tmPath');
  await dismiss(page);
  await page.locator('[data-tm="reset"]').click();
  await declines(page, 'tmReset');
});
