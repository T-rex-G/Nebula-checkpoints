'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

/*
 * A folder moved or deleted from its menu, and a repository deleted, in the
 * browser: a folder's name offered whole however it is written, the palette
 * read again once a folder has moved, the tree read again after a deletion
 * that stopped partway, and a deleted repository no longer offered as one
 * opened recently.
 */

const entry = (name, type = 'file') => ({ name, path: name, type, size: type === 'file' ? 12 : undefined, sha: 'a'.repeat(40) });

/* On a phone the tree is in the drawer the bottom bar opens; it is opened only when it is not already showing. */
async function showTree(page) {
  const files = page.locator('#bottomNav [data-nav="files"]');
  const shown = await page.locator('#tree .tree-item').first().isVisible().catch(() => false);
  if (!shown && await files.isVisible().catch(() => false)) await files.click();
  await page.locator('#tree .tree-item').first().waitFor();
}
const rowOf = (page, name) => page.locator('#tree .tree-item').filter({ has: page.locator('.ti-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function folderMenu(page, name, choice) {
  await rowOf(page, name).dispatchEvent('contextmenu');
  await expect(page.locator('#modalTitle')).toHaveText(`${name}/`);
  await page.locator(`#modalBody [data-mi="${choice}"]`).click();
}

test('a folder named with a quote is offered whole to move', async ({ page }) => {
  await mockTask20Api(page);
  await page.route('**/api/repo/acme/demo/tree**', route => route.fulfill({ json: [entry('a"b onfocus="x', 'dir')] }));
  await openRepository(page);
  await showTree(page);
  await folderMenu(page, 'a"b onfocus="x', 'movedir');
  await expect(page.locator('#modalTitle')).toHaveText('Rename / move folder');
  const field = page.locator('#mvDirTo');
  await expect(field).toHaveValue('a"b onfocus="x');
  await expect(field).not.toHaveAttribute('onfocus');
});

/* The palette lists the branch's files from one list; a folder moved reads it again, so the old paths are not offered. */
test('a folder moved is offered in the palette where it went, not where it was', async ({ page }) => {
  await mockTask20Api(page);
  let moved = false;
  await page.route('**/api/repo/acme/demo/tree**', route => route.fulfill({ json: moved ? [entry('guides', 'dir'), entry('README.md')] : [entry('docs', 'dir'), entry('README.md')] }));
  await page.route('**/api/repo/acme/demo/files**', route => route.fulfill({ json: { files: moved ? ['guides/intro.md', 'README.md'] : ['docs/intro.md', 'README.md'] } }));
  const sent = [];
  await page.route('**/api/repo/acme/demo/move-dir', route => {
    sent.push(route.request().postDataJSON());
    moved = true;
    return route.fulfill({ json: { ok: true, commit: 'c'.repeat(40), moved: 1 } });
  });
  await openRepository(page);
  await showTree(page);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('intro');
  await expect(page.locator('#paletteList .pal-item').first()).toContainText('docs/intro.md');
  await page.keyboard.press('Escape');
  await expect(page.locator('#paletteScrim')).toBeHidden();
  await showTree(page);
  await folderMenu(page, 'docs', 'movedir');
  await page.locator('#mvDirTo').fill('guides');
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast', { hasText: '1 file moved to guides/' })).toBeVisible();
  expect(sent).toEqual([{ from: 'docs', to: 'guides', branch: 'main', message: 'Move docs -> guides', expectedHeadSha: 'b'.repeat(40) }]);
  await expect(rowOf(page, 'guides')).toBeVisible();
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('intro');
  await expect(page.locator('#paletteList .pal-item').first()).toContainText('guides/intro.md');
  await expect(page.locator('#paletteList .pal-item', { hasText: 'docs/intro.md' })).toHaveCount(0);
});

/* A deletion of many files goes in commits of a hundred; one refused partway leaves the tree read again for what landed. */
test('a folder deletion refused partway reads the tree again for what was deleted', async ({ page }) => {
  await mockTask20Api(page);
  const files = Array.from({ length: 150 }, (_, i) => `docs/f${i}.md`);
  let landed = 0;
  let trees = 0;
  await page.route('**/api/repo/acme/demo/tree**', route => { trees += 1; return route.fulfill({ json: landed ? [entry('docs', 'dir')] : [entry('docs', 'dir'), entry('README.md')] }); });
  await page.route('**/api/repo/acme/demo/files**', route => route.fulfill({ json: { files: [...files, 'README.md'] } }));
  const heads = [];
  await page.route('**/api/repo/acme/demo/batch', route => {
    heads.push(route.request().postDataJSON().expectedHeadSha);
    if (landed) return route.fulfill({ status: 409, json: { error: 'The branch changed since this view was loaded. Refresh the repository and retry so newer work is not overwritten.', code: 'BRANCH_CHANGED' } });
    landed += 1;
    return route.fulfill({ json: { ok: true, commit: 'd'.repeat(40), count: 100 } });
  });
  await openRepository(page);
  await showTree(page);
  await folderMenu(page, 'docs', 'delete');
  await expect(page.locator('#modalBody')).toContainText('This deletes 150 files under docs/ from main in 2 commits.');
  await page.locator('#delFolderName').fill('docs');
  const before = trees;
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast.err', { hasText: 'The branch changed since this view was loaded.' })).toBeVisible();
  expect(heads).toEqual(['b'.repeat(40), 'd'.repeat(40)]);
  await expect.poll(() => trees).toBeGreaterThan(before);
  await expect(rowOf(page, 'README.md')).toHaveCount(0);
});

/* A repository deleted is forgotten from those opened recently, so the picker never offers one that is gone. */
test('a deleted repository is no longer offered as one opened recently', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('nv_recent:repositories', JSON.stringify([{ owner: 'sandbox', name: 'demo' }, { owner: 'sandbox', name: 'other' }]));
      sessionStorage.setItem('seeded', '1');
    }
  });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/security/step-up', route => route.fulfill({ json: { grant: 'single-use-grant' } }));
  let deleted = 0;
  await page.route('**/api/repo/sandbox/demo', route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  await (await ui.action(page, 'Command palette')).click();
  await ui.palette(page).fill('Delete this repository');
  await ui.paletteOption(page, /Delete this repository/).click();
  const confirm = ui.dialog(page, 'Delete repository');
  await confirm.locator('#drName').fill('sandbox/demo');
  await ui.button(confirm, 'Delete forever').click();
  const stepUp = ui.dialog(page, 'Verify sensitive action');
  await ui.field(stepUp, /Type the active account login/).fill('alpha-tester');
  await ui.secretField(stepUp, /Re-enter the current provider token/).fill('provider-token-value');
  await ui.button(stepUp, 'Authorize once').click();
  await expect(page.locator('.toast', { hasText: 'Repository deleted' })).toBeVisible();
  expect(deleted).toBe(1);
  await expect(page.locator('#page-repos')).toHaveClass(/active/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nv_recent:repositories')))).toEqual([{ owner: 'sandbox', name: 'other' }]);
});

/* The head a move made is the branch's from then on: the next write claims it, not the head the page opened on. */
test('a write after a folder move lands on the head the move made', async ({ page }) => {
  await mockTask20Api(page);
  let moves = 0;
  await page.route('**/api/repo/acme/demo/tree**', route => route.fulfill({ json: moves ? [entry('guides', 'dir'), entry('notes', 'dir')] : [entry('docs', 'dir'), entry('notes', 'dir')] }));
  await page.route('**/api/repo/acme/demo/files**', route => route.fulfill({ json: { files: ['docs/a.md', 'notes/b.md'] } }));
  const heads = [];
  await page.route('**/api/repo/acme/demo/move-dir', route => {
    heads.push(route.request().postDataJSON().expectedHeadSha);
    moves += 1;
    return route.fulfill({ json: { ok: true, commit: String(moves + 2).repeat(40), moved: 1 } });
  });
  await openRepository(page);
  await showTree(page);
  await folderMenu(page, 'docs', 'movedir');
  await page.locator('#mvDirTo').fill('guides');
  await page.locator('#modalOk').click();
  await expect(rowOf(page, 'guides')).toBeVisible();
  await showTree(page);
  await folderMenu(page, 'notes', 'movedir');
  await page.locator('#mvDirTo').fill('memos');
  await page.locator('#modalOk').click();
  await expect.poll(() => heads.length).toBe(2);
  expect(heads).toEqual(['b'.repeat(40), '3'.repeat(40)]);
});
