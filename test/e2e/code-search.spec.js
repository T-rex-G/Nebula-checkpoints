'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * Code search, from the files panel: the paths whose contents match drawn in
 * the tree's place, each opening its file with the words to find; on another
 * branch the list says the provider searched the default branch; a search
 * answered after another repository was opened is not drawn in that one's
 * tree; and what the tree says rather than lists is read, not pressed.
 */

const at = (repo, name) => url => new URL(url).pathname === `/api/repo/sandbox/${repo}/${name}`;

/* On a phone the tree and its search are in the drawer the bottom bar opens. */
async function showTree(page) {
  await page.locator('#tree .tree-item').first().waitFor();
  const files = page.locator('#bottomNav [data-nav="files"]');
  if (await files.isVisible().catch(() => false)) await files.click();
  await expect(page.locator('#codeSearch')).toBeInViewport();
}
async function search(page, words) {
  await page.locator('#codeSearch').fill(words);
  await page.locator('#codeSearch').press('Enter');
}
async function sandbox(page, branches = [{ name: 'main', protected: true, sha: 'a'.repeat(40) }]) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo', route => route.fulfill({ json: { full_name: 'sandbox/demo', private: true, default_branch: 'main', branches } }));
  await page.route('**/api/repo/sandbox/demo/branch-protection**', route => route.fulfill({ json: {
    provider: 'github', branch: new URL(route.request().url()).searchParams.get('branch'), protected: false, access: 'full', sources: [], controls: [], enforced: 0, known: 0, settingsUrl: null
  } }));
}
const hits = page => page.locator('#tree .tree-item:not(.tree-note) .ti-name');

test('a match opens its file with the words to find', async ({ page }) => {
  await sandbox(page);
  const asked = [];
  await page.route(at('demo', 'search'), route => { asked.push(new URL(route.request().url()).searchParams.get('q')); return route.fulfill({ json: [{ name: 'app.js', path: 'src/app.js' }] }); });
  await page.route(at('demo', 'file'), route => route.fulfill({ json: { path: 'src/app.js', sha: 'c'.repeat(40), size: 18, content: Buffer.from('const needle = 1;\n').toString('base64'), binary: false } }));
  await page.goto('/#/sandbox/demo@main/editor');
  await showTree(page);
  await search(page, '  needle  ');
  await expect(hits(page)).toHaveText(['src/app.js']);
  expect(asked).toEqual(['needle']);
  await expect(page.locator('#tree .tree-note')).toHaveCount(0);
  await hits(page).first().click();
  await expect(page.locator('#findBar')).toBeVisible();
  await expect(page.locator('#findInput')).toHaveValue('needle');
});

test('on another branch the matches say they are the default branch’s', async ({ page }) => {
  await sandbox(page, [{ name: 'main', protected: true, sha: 'a'.repeat(40) }, { name: 'dev', protected: false, sha: 'b'.repeat(40) }]);
  await page.route(at('demo', 'search'), route => route.fulfill({ json: [{ name: 'app.js', path: 'src/app.js' }] }));
  await page.goto('/#/sandbox/demo@dev/editor');
  await showTree(page);
  await search(page, 'needle');
  await expect(hits(page)).toHaveText(['src/app.js']);
  await expect(page.locator('#tree .tree-note')).toHaveText('Matches on main, the branch the provider searches');
});

test('a search answered after another repository was opened is not drawn in that one’s tree', async ({ page }) => {
  await sandbox(page);
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [{ name: 'OTHER.md', path: 'OTHER.md', type: 'file', size: 3, sha: 'e'.repeat(40) }] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: ['OTHER.md'] } });
    return route.fulfill({ json: {} });
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let asked = false;
  await page.route(at('demo', 'search'), async route => { asked = true; await gate; return route.fulfill({ json: [{ name: 'stale.js', path: 'stale.js' }] }); });
  await page.goto('/#/sandbox/demo@main/editor');
  await showTree(page);
  await search(page, 'needle');
  await expect.poll(() => asked).toBe(true);
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/editor'; });
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await expect(page.locator('#tree')).toContainText('OTHER.md');
  const answered = page.waitForResponse(response => at('demo', 'search')(response.url()));
  release();
  await (await answered).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#tree')).not.toContainText('stale.js');
  await expect(page.locator('#tree')).toContainText('OTHER.md');
});

test('what the tree says rather than lists is read, not pressed: it wraps and does not offer itself', async ({ page }) => {
  await sandbox(page);
  await page.route(at('demo', 'search'), route => route.fulfill({ json: [] }));
  await page.goto('/#/sandbox/demo@main/editor');
  await showTree(page);
  await search(page, 'nothing here at all');
  const said = page.locator('#tree .tree-item', { hasText: 'No matches' });
  await expect(said).toBeInViewport();
  expect(await said.evaluate(node => [getComputedStyle(node).cursor, getComputedStyle(node).whiteSpace])).toEqual(['default', 'normal']);
  const box = await said.boundingBox();
  const tree = await page.locator('#tree').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(tree.x + tree.width + 0.5);
  expect(await said.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
