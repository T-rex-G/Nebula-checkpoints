'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The file tree and an entry's menu, in the browser: a menu acts on the entry
 * it was opened for and nothing else, a reading that answers after another
 * repository was opened is not drawn over that one's tree, an answer that is
 * not a list is said as a failure, and a name with a quote in it is shown in
 * the rename field whole.
 */

const entry = (name, type = 'file') => ({ name, path: name, type, size: type === 'file' ? 12 : undefined, sha: 'a'.repeat(40) });

async function serveTree(page, answer) {
  await page.route('**/api/repo/acme/demo/tree**', route => (typeof answer === 'function' ? answer(route) : route.fulfill({ json: answer })));
}

/* On a phone the tree is in the drawer the bottom bar opens. */
async function showTree(page) {
  const files = page.locator('#bottomNav [data-nav="files"]');
  if (await files.isVisible().catch(() => false)) await files.click();
  await page.locator('#tree .tree-item').first().waitFor();
}

const rowOf = (page, name) => page.locator('#tree .tree-item').filter({ has: page.locator('.ti-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

test('a menu acts on the entry it was opened for, not on every entry whose menu was opened before', async ({ page }) => {
  await mockTask20Api(page);
  await serveTree(page, [entry('a.txt'), entry('b.txt')]);
  const protects = [];
  await page.route('**/api/safety', route => {
    if (route.request().method() === 'POST') {
      protects.push(route.request().postDataJSON().protect);
      return route.fulfill({ json: { readOnly: false, freezeSync: false, protected: { 'acme/demo': ['b.txt'] } } });
    }
    return route.fulfill({ json: { readOnly: false, freezeSync: false, protected: {} } });
  });
  await openRepository(page);
  await showTree(page);

  await rowOf(page, 'a.txt').dispatchEvent('contextmenu');
  await expect(page.locator('#modalTitle')).toHaveText('a.txt');
  await page.locator('#modalOk').click();
  await expect(page.locator('#modal')).toBeHidden();

  await rowOf(page, 'b.txt').dispatchEvent('contextmenu');
  await expect(page.locator('#modalTitle')).toHaveText('b.txt');
  await page.locator('#modalBody [data-mi="protect"]').click();
  await expect.poll(() => protects.length).toBe(1);
  await page.waitForTimeout(300);
  expect(protects).toEqual([{ repo: 'acme/demo', path: 'b.txt', on: true }]);
});

test('a tree read for a repository left behind is not drawn over the one opened since', async ({ page }) => {
  await mockTask20Api(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let asked = 0;
  await serveTree(page, async route => {
    asked += 1;
    if (asked === 1) await held;
    return route.fulfill({ json: [entry('demo-only.txt')] });
  });
  await page.route('**/api/repo/acme/other', route => route.fulfill({ json: { full_name: 'acme/other', private: true, default_branch: 'main', branches: [{ name: 'main', protected: false, sha: 'c'.repeat(40) }] } }));
  await page.route('**/api/repo/acme/other/tree**', route => route.fulfill({ json: [entry('other.txt')] }));
  await openRepository(page);
  await page.evaluate(() => { location.hash = '#/acme/other@main/editor'; });
  await expect(page.locator('#workRepoName')).toHaveText('acme/other');
  const files = page.locator('#bottomNav [data-nav="files"]');
  if (await files.isVisible().catch(() => false)) await files.click();
  await expect(page.locator('#tree .ti-name')).toHaveText(['other.txt']);

  release();
  await expect.poll(() => asked).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);
  await expect(page.locator('#tree .ti-name')).toHaveText(['other.txt']);
});

test('a tree answer that is not a list is said as a failure, not drawn as an empty repository', async ({ page }) => {
  await mockTask20Api(page);
  await serveTree(page, { entries: 'not a list' });
  await openRepository(page);
  const files = page.locator('#bottomNav [data-nav="files"]');
  if (await files.isVisible().catch(() => false)) await files.click();
  await expect(page.locator('#tree .tree-item')).toHaveText('⚠ The repository’s files could not be read.');
});

test('a file named with a quote is offered for renaming by its whole name, and adds nothing to the field', async ({ page }) => {
  const name = 'x" data-injected="1" y.txt';
  await mockTask20Api(page);
  await serveTree(page, [entry(name)]);
  await openRepository(page);
  await showTree(page);
  await rowOf(page, name).dispatchEvent('contextmenu');
  await page.locator('#modalBody [data-mi="rename"]').click();
  const field = page.locator('#rnTo2');
  await expect(field).toHaveValue(name);
  expect(await field.getAttribute('data-injected')).toBeNull();
});

test('a file pressed in the tree opens in the editor, and a folder opens beneath its row', async ({ page }) => {
  await mockTask20Api(page);
  await serveTree(page, async route => {
    const folder = new URL(route.request().url()).searchParams.get('path');
    return route.fulfill({ json: folder ? [entry(`${folder}/inner.txt`)].map(item => ({ ...item, name: 'inner.txt' })) : [entry('src', 'dir'), entry('a.txt'), entry('b.txt')] });
  });
  await page.route(url => url.pathname === '/api/repo/acme/demo/file', route => route.fulfill({ json: { content: 'hello', sha: 'f'.repeat(40), size: 5, encoding: 'utf-8' } }));
  await openRepository(page);
  await showTree(page);
  await expect(rowOf(page, 'a.txt').locator('.tree-size')).toHaveText('12 B');
  await expect(rowOf(page, 'src').locator('.tree-size')).toHaveCount(0);
  await rowOf(page, 'src').click();
  await expect(rowOf(page, 'inner.txt')).toBeVisible();
  await rowOf(page, 'a.txt').click();
  await expect(page.locator('#filePath')).toHaveText('a.txt');
  await showTree(page);
  await rowOf(page, 'b.txt').click();
  await expect(page.locator('#filePath')).toHaveText('b.txt');
  await expect(rowOf(page, 'b.txt')).toHaveClass(/\bactive\b/);
  await expect(rowOf(page, 'a.txt')).not.toHaveClass(/\bactive\b/);
});

test('a protected file offers to unprotect, and a rename sends the path typed', async ({ page }) => {
  await mockTask20Api(page);
  await serveTree(page, [entry('a.txt')]);
  await page.route('**/api/safety', route => route.fulfill({ json: { readOnly: false, freezeSync: false, protected: { 'acme/demo': ['a.txt'] } } }));
  const renames = [];
  await page.route(url => url.pathname === '/api/repo/acme/demo/rename', route => { renames.push(route.request().postDataJSON()); return route.fulfill({ json: { commit: 'c'.repeat(40) } }); });
  await openRepository(page);
  await showTree(page);
  await rowOf(page, 'a.txt').dispatchEvent('contextmenu');
  await expect(page.locator('#modalBody [data-mi="protect"]')).toHaveText('Unprotect file');
  await page.locator('#modalBody [data-mi="rename"]').click();
  await page.locator('#rnTo2').fill('docs/b.txt');
  await page.locator('#modalOk').click();
  await expect.poll(() => renames.length).toBe(1);
  expect(renames[0]).toMatchObject({ from: 'a.txt', to: 'docs/b.txt', branch: 'main' });
});
