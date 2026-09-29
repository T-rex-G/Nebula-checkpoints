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
