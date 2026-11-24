'use strict';

/*
 * Opening another repository clears every section that belonged to the last
 * one before anything is asked, and nothing still in flight for the last one
 * -- an audit being followed, a result on its way -- is drawn under the new
 * one's name.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/* A second repository, answered only when the test lets it, so the moment between the two is observable. */
async function secondRepository(page) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/repo\/sandbox\/other(\/.*)?(\?.*)?$/, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/repo/sandbox/other') {
      await gate;
      return route.fulfill({ json: { full_name: 'sandbox/other', private: false, default_branch: 'main', homepage: '', branches: [{ name: 'main', protected: false, sha: 'd'.repeat(40) }] } });
    }
    if (pathname.endsWith('/tree')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/files')) return route.fulfill({ json: { files: [] } });
    if (pathname.endsWith('/code-audit')) return route.fulfill({ status: 202, json: { state: 'running', run: 'other-1', stage: 'resolving', done: 0, total: 0, position: null, limit: null, elapsedMs: 5 } });
    return route.fulfill({ json: {} });
  });
  return () => release();
}

test('another repository opens onto clean sections, never the last one’s audit', async ({ page }) => {
  /* Each section is taken down by its own component, so nothing is torn from under it: the page throws nothing. */
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', /^Grade F/, { timeout: 15000 });
  await expect(page.locator('#workPrivateBadge')).toBeVisible();

  const release = await secondRepository(page);
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/audit'; });

  /* While the new repository has not answered: its name, and nothing of the last one. */
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await expect(page.locator('#auditRoot .audit-grade')).toHaveCount(0);
  await expect(page.locator('#auditRoot')).not.toContainText('critical issue');
  await expect(page.locator('#workPrivateBadge')).toBeHidden();

  release();
  await expect(pane).toBeVisible();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');
  await expect(pane).not.toContainText('critical issue');
  await expect(pane.locator('.audit-findings')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('an audit still being followed for the last repository never lands on the new one', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let releasePoll;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  await page.route(/\/api\/repo\/sandbox\/demo\/code-audit\?.*run=/, async route => { await pollGate; await route.fallback(); });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane.locator('.audit-progress')).toBeVisible();

  const release = await secondRepository(page);
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/audit'; });
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await expect(page.locator('#auditRoot .audit-progress')).toHaveCount(0);
  release();
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');

  /* The last repository's answer arrives now, and is dropped. */
  releasePoll();
  await page.waitForTimeout(3000);
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');
  await expect(pane).not.toContainText('critical issue');
  await expect(pane.getByRole('button', { name: 'Audit this branch' })).toBeEnabled();
});

/*
 * A repository opened from the list arrives on its editor, with its address
 * saved, and the comparison set up between its default branch and another.
 */
test('a repository opened from the list arrives on its editor, its address saved and its comparison set apart', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(/\/api\/repo\/sandbox\/demo(\?.*)?$/, route => route.fulfill({ json: {
    full_name: 'sandbox/demo', private: true, default_branch: 'main', homepage: '', permission: 'admin',
    branches: [{ name: 'main', protected: false, sha: 'a'.repeat(40) }, { name: 'feature/x', protected: false, sha: 'b'.repeat(40) }]
  } }));
  await page.goto('/');
  await page.locator('#ovGoRepos').click();
  await page.locator('#repoGrid .repo-card').filter({ hasText: 'demo' }).first().click();
  await expect(page.locator('#tab-editor')).toBeVisible();
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');
  await expect(page).toHaveURL(/#\/sandbox\/demo@main/);
  await expect(page.locator('#cmpBase')).toHaveValue('main');
  await expect(page.locator('#cmpHead')).toHaveValue('feature/x');
  await expect(page.locator('#workPrivateBadge')).toBeVisible();
  await expect(page.locator('#workVisitorBadge')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/repo-visitor/);
});

/*
 * A repository opened from the list arrives on its editor, whatever tool the
 * last one was showing.
 */
test('a repository opened from the list arrives on its editor, whatever tool was open before', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/audit');
  await expect(page.locator('#tab-audit')).toBeVisible();
  await page.locator('.nv-rail-item[data-rail="repos"]').dispatchEvent('click');
  await page.locator('#repoGrid .repo-card').filter({ hasText: 'demo' }).first().click();
  await expect(page.locator('#tab-editor')).toBeVisible();
  await expect(page.locator('#tab-audit')).toBeHidden();
});

/*
 * A tool chosen from the rail while a repository is still opening is for that
 * repository: when another is opened before it answers, the choice is not
 * carried to the other one.
 */
test('a tool chosen while a repository opens is not carried to another opened meanwhile', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let holding = true;
  await page.route(/\/api\/repo\/sandbox\/demo(\?.*)?$/, async route => { if (holding) await gate; return route.fallback(); });
  await page.goto('/');
  await page.locator('#ovGoRepos').click();
  await page.locator('#repoGrid .repo-card').filter({ hasText: 'demo' }).first().click();
  await page.locator('.nv-rail-item[data-rail="audit"]').dispatchEvent('click');
  const other = await secondRepository(page);
  other();
  await page.evaluate(() => { location.hash = '#/sandbox/other@main/editor'; });
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await expect(page.locator('#tab-editor')).toBeVisible();
  holding = false;
  release();
  await page.waitForTimeout(600);
  await expect(page.locator('#workRepoName')).toHaveText('sandbox/other');
  await expect(page.locator('#tab-editor')).toBeVisible();
  await expect(page.locator('#tab-audit')).toBeHidden();
});
