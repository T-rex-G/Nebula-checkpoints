'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { mockTask20Api, openRepository } = require('./task20-fixtures');
test.use({ serviceWorkers: 'block' });

test('Exposure pages, searches beyond loaded rows and exports the whole consistent view', async ({ page }) => {
  const findings = Array.from({ length: 235 }, (_, index) => ({
    fingerprint: index.toString(16).padStart(64, '0'), rule: 'github-token',
    path: `src/fixture-${index}.js`, displayPath: `src/fixture-${index}.js`,
    placeholder: '<github-token #1>', disposition: 'open', inTree: true,
    occurrences: [{ line: 4, column: 1 }], occurrenceCount: 1,
    narration: { severity: 'critical', what: 'Fixture credential', consequence: 'Synthetic finding.', action: 'Review it.', where: `src/fixture-${index}.js` }
  }));
  let stale = false;
  let scansRequested = 0;
  const queries = [];
  await mockTask20Api(page);
  await page.route('**/api/repo/acme/demo/exposure/**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/scan')) scansRequested++;
    if (!url.pathname.endsWith('/findings')) return route.fulfill({ json: { scans: [] } });
    const params = url.searchParams;
    queries.push(Object.fromEntries(params));
    if (stale && params.has('cursor')) return route.fulfill({ status: 409, json: { code: 'EXPOSURE_CURSOR_STALE', error: 'The findings changed.' } });
    const all = findings.filter(finding => !params.get('q') || finding.displayPath.includes(params.get('q')));
    const start = Number(params.get('cursor') || 0);
    const limit = Number(params.get('limit') || 50);
    const items = all.slice(start, start + limit);
    const hasMore = start + items.length < all.length;
    return route.fulfill({ json: { findings: items, total: all.length,
      counts: { all: findings.length, bySeverity: { critical: findings.length }, byDisposition: { open: findings.length } },
      nextCursor: hasMore ? String(start + items.length) : null, hasMore, verifications: {}, probes: {} } });
  });
  await openRepository(page);
  await page.evaluate(() => window.switchTab('exposure'));
  const items = page.locator('#exposureList > .exposure-item');
  await expect(items).toHaveCount(50);
  await expect(page.locator('#exposureShown')).toHaveText('50 of 235 matching findings loaded (235 total)');
  await page.getByRole('button', { name: 'Load more findings' }).click();
  await expect(items).toHaveCount(100);
  const tools = page.locator('#exposureTools');
  await tools.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export SARIF' }).click();
  const exported = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
  expect(exported.runs[0].results).toHaveLength(235);
  expect(queries.some(query => query.limit === '200' && query.cursor === '200')).toBe(true);
  await page.getByRole('searchbox', { name: 'Search findings' }).fill('fixture-234');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('fixture-234.js');
  await expect(page.locator('#exposureShown')).toHaveText('1 of 1 matching findings loaded (235 total)');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(items).toHaveCount(50);
  stale = true;
  let downloads = 0;
  page.on('download', () => downloads++);
  await tools.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export SARIF' }).click();
  await expect(page.locator('#tab-exposure')).toContainText('Findings changed during export. Refresh and export again.');
  expect(downloads).toBe(0, 'a mixed or incomplete report is never downloaded');
  stale = false;
  await page.getByRole('button', { name: 'Reload findings', exact: true }).click();
  await expect(items).toHaveCount(50);
  await expect(page.locator('#exposureShown')).toHaveText('50 of 235 matching findings loaded (235 total)');
  await expect(page.locator('#tab-exposure')).not.toContainText('Findings changed during export');
  await expect(page.getByRole('status', { name: 'Exposure scan updates' })).toHaveText('Findings loaded.');
  expect(scansRequested).toBe(0, 'reloading findings does not start a provider scan');
  expect(await tools.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
});
