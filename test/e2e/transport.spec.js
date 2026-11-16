'use strict';

/*
 * How the page asks its server, seen from the network: a write refused because
 * its branch moved has the repository read again; reads of a repository the
 * reader keeps for offline use, and the account's repository list while any
 * is kept, carry the headers that let the service worker keep them, and no
 * other read does; and a refresh asks again rather than answering from the
 * page's memory. platform/transport.ts is asked directly by
 * test/transport.test.js; this is the page using it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

const RUNS = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', branch: 'main', event: 'push', created_at: new Date().toISOString(), html_url: 'https://example.test/run/1' }];

async function openRepository(page) {
  await page.goto('/');
  await ui.enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
}

test('a request refused because the branch moved has the repository read again', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  const metadata = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repo/sandbox/demo' && request.method() === 'GET') metadata.push(Date.now()); });
  let refused = false;
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/commits', route => {
    if (refused) return route.fallback();
    refused = true;
    return route.fulfill({ status: 409, json: { error: 'The branch moved while this was being read.', code: 'BRANCH_CHANGED' } });
  });
  await openRepository(page);
  await expect.poll(() => metadata.length).toBeGreaterThan(0);
  const before = metadata.length;
  await ui.openTab(page, 'commits');
  await expect.poll(() => refused).toBe(true);
  await expect.poll(() => metadata.length).toBe(before + 1);
});

test('reads of a repository kept for offline use carry the keeping headers, and no other read does', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/actions', route => route.fulfill({ json: RUNS }));
  const seen = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const headers = request.headers();
    seen.push({ path: url.pathname, method: request.method(), scope: headers['x-nv-offline-scope'] || '', repo: headers['x-nv-offline-repo'] || '' });
  });
  await openRepository(page);
  /* Nothing is kept yet: no read is marked. */
  expect(seen.filter(entry => entry.scope || entry.repo)).toEqual([]);
  await (await ui.action(page, 'Settings')).click();
  await page.locator('#setOfflineRepo').check();
  await page.locator('#modalOk').click();
  const scope = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('nv_offline_repos:')).slice('nv_offline_repos:'.length));
  expect(scope).toBeTruthy();
  seen.length = 0;
  await ui.openTab(page, 'actions');
  await expect.poll(() => seen.some(entry => entry.path === '/api/repo/sandbox/demo/actions')).toBe(true);
  expect(seen.find(entry => entry.path === '/api/repo/sandbox/demo/actions')).toMatchObject({ method: 'GET', scope, repo: 'github:sandbox/demo' });
  /* A read of anything else, or any write, is not marked. */
  expect(seen.filter(entry => (entry.scope || entry.repo) && !entry.path.startsWith('/api/repo/sandbox/demo') && entry.path !== '/api/repos')).toEqual([]);
  expect(seen.filter(entry => entry.method !== 'GET' && (entry.scope || entry.repo))).toEqual([]);
  /* The account's repository list is kept while any repository is: read afresh, it carries the account's mark. */
  seen.length = 0;
  await page.goto('/');
  await ui.enterRepositories(page);
  await expect.poll(() => seen.find(entry => entry.path === '/api/repos')).toMatchObject({ scope, repo: 'account' });
});

test('refreshing the workflow runs asks again instead of answering from the page\'s memory', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  let asked = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repo/sandbox/demo/actions') asked++; });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/actions', route => route.fulfill({ json: RUNS }));
  await openRepository(page);
  await ui.openTab(page, 'actions');
  await expect.poll(() => asked).toBe(1);
  /* Opening the tab asks for the runs twice over; the second is answered from memory, or shares the first's request. */
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
  /* Opened again within half a minute: answered from memory. */
  await ui.openTab(page, 'commits');
  await ui.openTab(page, 'actions');
  await page.waitForTimeout(300);
  expect(asked).toBe(1);
  await page.locator('#actionsRefreshBtn').click();
  await expect.poll(() => asked).toBe(2);
});
