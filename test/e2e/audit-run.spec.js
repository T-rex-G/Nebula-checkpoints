'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * An audit run, from the Audit tab: an answer that is not an audit -- no
 * findings in it -- is said as a failure the reader can act on, not drawn as
 * a result, and the page throws nothing; and a run the network never carried
 * is said as the connection's, in words that say what to do.
 */

test('an audit answered without its findings is said as a failure, not drawn as a result', async ({ page }) => {
  const thrown = [];
  page.on('pageerror', error => thrown.push(String(error)));
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/code-audit', route => {
    const run = new URL(route.request().url()).searchParams.get('run');
    return run
      ? route.fulfill({ json: { state: 'done', grade: 'A' } })
      : route.fulfill({ status: 202, json: { state: 'running', run: 'r1', stage: 'resolving', done: 0, total: 0, position: null, limit: null, elapsedMs: 5 } });
  });
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane).toContainText('The audit answered without its findings.', { timeout: 15000 });
  await expect(pane.locator('.audit-grade')).toHaveAttribute('aria-label', 'Not audited');
  await expect(pane.getByRole('button', { name: 'Audit this branch' })).toBeEnabled();
  expect(thrown).toEqual([]);
});

test('an audit the network never carried is said as the connection\u2019s', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/code-audit', route => route.abort('internetdisconnected'));
  await page.goto('/#/sandbox/demo@main/audit');
  const pane = page.locator('#tab-audit');
  await pane.getByRole('button', { name: 'Audit this branch' }).click();
  await expect(pane).toContainText('The server could not be reached. Check the connection, then try again.', { timeout: 15000 });
  await expect(pane.getByRole('button', { name: 'Audit this branch' })).toBeEnabled();
});
