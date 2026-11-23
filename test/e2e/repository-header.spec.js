'use strict';

/*
 * The repository header's controls as a reader meets them: Refresh reads the
 * repository, its tree and the tool open again and keeps the branch; an
 * answer read for a repository the reader has since left is not laid over the
 * one they opened; a branch created is switched to with its shield and its
 * address; and the archive is fetched for the branch open.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const SANDBOX = /^\/api\/repo\/sandbox\/demo$/;

async function openSandbox(page, prepare) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  if (prepare) await prepare(page);
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');
}

/* The sandbox with its main branch protected. */
const protectedMain = browser => browser.route(url => SANDBOX.test(url.pathname), route => (route.request().method() !== 'GET' ? route.fallback() : route.fulfill({
  json: { full_name: 'sandbox/demo', private: true, default_branch: 'main', homepage: null, branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }] }
})));

/* The side panel's own controls: standing on a desk, inside the files drawer on a phone. */
async function sideControl(page, id) {
  if (await page.locator('#bottomNav').isVisible()) {
    await page.locator('#bottomNav button[data-nav="files"]').click();
    await expect(page.locator('#side')).toHaveClass(/\bopen\b/);
  }
  return page.locator(id);
}

test('Refresh reads the repository, its tree and the tool open again, and keeps the branch', async ({ page }) => {
  const asked = [];
  await openSandbox(page, async browser => {
    browser.on('request', request => {
      const { pathname } = new URL(request.url());
      if (SANDBOX.test(pathname) || pathname === '/api/repo/sandbox/demo/tree') asked.push(pathname);
    });
  });
  await expect.poll(() => asked.filter(path => path.endsWith('/tree')).length).toBeGreaterThan(0);
  const before = { repository: asked.filter(path => SANDBOX.test(path)).length, tree: asked.filter(path => path.endsWith('/tree')).length };
  await page.locator('#syncBtn').click();
  await expect(page.locator('.toast').filter({ hasText: 'Refreshed \u2726' })).toBeVisible();
  expect(asked.filter(path => SANDBOX.test(path)).length).toBe(before.repository + 1);
  await expect.poll(() => asked.filter(path => path.endsWith('/tree')).length).toBe(before.tree + 1);
  await expect(page.locator('#branchSelect')).toHaveValue('main');
  await expect(page.locator('#branchShield')).toBeHidden();
});

/*
 * Refresh pressed on one repository and another opened before the answer
 * came: the answer used to be laid over the second, which took the first's
 * branches -- here, its unprotected main in place of the second's protected
 * one, so the shield went out on a protected branch.
 */
test('an answer read for a repository the reader has left is not laid over the one opened', async ({ page }) => {
  let holding = false;
  let held = null;
  await openSandbox(page, async browser => {
    await browser.route(url => SANDBOX.test(url.pathname), async route => {
      if (route.request().method() !== 'GET' || !holding || held) return route.fallback();
      held = route;
    });
  });
  holding = true;
  await page.locator('#syncBtn').click();
  await expect.poll(() => Boolean(held)).toBe(true);

  await page.locator('#backBtn').click();
  await expect(ui.screen(page, 'repos')).toBeVisible();
  const filter = page.locator('#repoFilter');
  await filter.fill('octo/spoon-knife');
  await filter.press('Enter');
  await page.locator('#page-work.active').waitFor();
  await expect(page.locator('#workRepoName')).toHaveText('Octo/Spoon-Knife');
  await expect(page.locator('#branchShield')).toBeVisible();

  const answered = page.waitForResponse(response => SANDBOX.test(new URL(response.url()).pathname));
  await held.fallback();
  await answered;
  await page.waitForTimeout(300);
  await expect(page.locator('#branchShield')).toBeVisible();
  await expect(page.locator('#workRepoName')).toHaveText('Octo/Spoon-Knife');
  await expect(page.locator('#workVisitorBadge')).toBeVisible();
  await expect(page.locator('.toast').filter({ hasText: 'Refreshed' })).toHaveCount(0);
});

/*
 * A branch created from a protected one is switched to: the shield used to
 * stay up over the new, unprotected branch, and the address kept naming the
 * branch it came from.
 */
test('a branch created is switched to, with its own shield and its address', async ({ page }) => {
  const created = [];
  await openSandbox(page, async browser => {
    await browser.route(url => SANDBOX.test(url.pathname), route => (route.request().method() !== 'GET' ? route.fallback() : route.fulfill({
      json: { full_name: 'sandbox/demo', private: true, default_branch: 'main', homepage: null, branches: [{ name: 'main', protected: true, sha: 'a'.repeat(40) }] }
    })));
    await browser.route(url => url.pathname === '/api/repo/sandbox/demo/branches', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      created.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { name: 'feature/starlight', sha: 'b'.repeat(40) } });
    });
  });
  await expect(page.locator('#branchShield')).toBeVisible();
  await (await sideControl(page, '#newBranchBtn')).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Created from main');
  await dialog.locator('#nbName').fill('feature/starlight');
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Branch feature/starlight created' })).toBeVisible();
  expect(created).toEqual([{ name: 'feature/starlight', from: 'main' }]);
  await expect(page.locator('#branchSelect')).toHaveValue('feature/starlight');
  await expect(page.locator('#branchShield')).toBeHidden();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toContain('@feature/starlight');
  /* Back to main: the shield returns with the protected branch. */
  await page.locator('#branchSelect').selectOption('main');
  await expect(page.locator('#branchShield')).toBeVisible();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toContain('@main');
});

test('the archive is fetched for the branch open', async ({ page }) => {
  await openSandbox(page, async browser => {
    await browser.route(url => url.pathname === '/api/repo/sandbox/demo/zip', route => route.fulfill({
      status: 200, body: 'PK', headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="demo.zip"' }
    }));
  });
  const download = page.waitForEvent('download');
  await (await sideControl(page, '#zipBtn')).click();
  const url = new URL((await download).url());
  expect(url.pathname).toBe('/api/repo/sandbox/demo/zip');
  expect(url.searchParams.get('ref')).toBe('main');
  await expect(page.locator('.toast').filter({ hasText: 'Preparing archive' })).toBeVisible();
});

/* A commit straight to a protected branch is asked about first, and once for that branch. */
test('a commit to a protected branch asks first, and the question is not asked again', async ({ page }) => {
  await openSandbox(page, protectedMain);
  await expect(page.locator('#branchShield')).toBeVisible();
  await ui.openFileByName(page, 'README.md');
  await expect(page.locator('.CodeMirror')).toBeVisible();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('# demo\n\nA change.\n'));
  await page.locator('#commitFileBtn').click();
  const warning = ui.dialog(page, 'Protected branch');
  await expect(warning).toContainText('main is protected');
  await ui.button(warning, 'Cancel').click();
  await expect(warning).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#commitFileBtn').click();
  await ui.button(ui.dialog(page, 'Protected branch'), 'Commit anyway').click();
  const commit = ui.dialog(page, 'Commit changes');
  await expect(commit).toContainText('Committing directly to main');
  await ui.button(commit, 'Cancel').click();
  await page.locator('#commitFileBtn').click();
  await expect(ui.dialog(page, 'Commit changes')).toBeVisible();
});

/* The bar's own files toggle folds the file list away and brings it back, on a desk; a phone has the files as a drawer instead. */
test('the files toggle in the bar folds the file list away and brings it back', async ({ page }) => {
  await openSandbox(page);
  const toggle = page.locator('#filesToggle');
  if (!(await toggle.isVisible())) {
    await expect(toggle).toBeHidden();
    return;
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Show files');
  await expect(page.locator('#side')).toHaveAttribute('inert', '');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#side')).not.toHaveAttribute('inert', '');
  expect(await page.evaluate(() => localStorage.getItem('nv_files_hidden'))).toBe('0');
});

/*
 * The branch picker's mark is drawn over the picker wherever it is shown, not
 * under the picker's glass, which dimmed and blurred it. Its glass made solid
 * for the check, the picker would hide a mark beneath it entirely.
 */
test('the branch picker\u2019s mark is drawn over the picker at every width that shows it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'widths are set here; one project covers them');
  await openSandbox(page);
  const mark = page.locator('#page-work .branch-pick-mark');
  const picker = page.locator('#page-work .branch-pick');
  await page.locator('#branchSelect').evaluate(select => { select.style.backgroundColor = 'rgb(255, 0, 0)'; });
  for (const width of [1280, 1000, 900, 800]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(mark).toBeVisible();
    const shown = await picker.screenshot({ animations: 'disabled' });
    await mark.evaluate(element => { element.style.visibility = 'hidden'; });
    const hidden = await picker.screenshot({ animations: 'disabled' });
    await mark.evaluate(element => { element.style.visibility = ''; });
    expect(shown.equals(hidden), `the mark is drawn over the picker at ${width}px`).toBe(false);
  }
});
