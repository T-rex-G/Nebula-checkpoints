'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * A recovery snapshot and the recovery workflow, from the Safeguards screen:
 * a snapshot taken without durable evidence is kept locally, said so, and
 * named on its tile at once; one that cannot be read is said so and not kept; and
 * once branches are restored the repository is read again, a report that
 * cannot be read said as such.
 */

const SHA = 'a'.repeat(40);
const snapshot = (fields = {}) => ({ kind: 'nebulaverse-snapshot', repo: 'demo', capturedAt: new Date().toISOString(), refs: [{ name: 'main', sha: SHA, protected: true }], tags: [], ...fields });
const at = name => url => new URL(url).pathname === `/api/repo/sandbox/demo/${name}`;

test('a snapshot taken without durable evidence is kept locally, said so, and named on its tile at once', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(at('signed-snapshot'), route => route.fulfill({ status: 503, json: { error: 'Signed snapshots require the existing Neon DATABASE_URL' } }));
  await page.route(at('refs-snapshot'), route => route.fulfill({ json: snapshot() }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgSnap')).toContainText('None taken yet');
  const download = page.waitForEvent('download');
  await section.locator('#sgSnap').click();
  expect((await download).suggestedFilename()).toBe(`demo-${new Date().toISOString().slice(0, 10)}.nvsnap.json`);
  const dialog = page.locator('#modal');
  await expect(page.locator('#modalTitle')).toHaveText('Recovery snapshot captured');
  await expect(dialog).toContainText('Saved locally because durable Neon evidence was unavailable.');
  await expect(dialog).not.toContainText('Signed');
  await page.locator('#modalOk').click();
  await expect(section.locator('#sgSnap')).toContainText('Last just now');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nv_snap_sandbox/demo')).refs.length)).toBe(1);
});

test('a snapshot that cannot be read is said so and not kept', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(at('signed-snapshot'), route => route.fulfill({ status: 503, json: { error: 'Signed snapshots require the existing Neon DATABASE_URL' } }));
  await page.route(at('refs-snapshot'), route => route.fulfill({ json: snapshot({ refs: undefined }) }));
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await section.locator('#sgSnap').click();
  await expect(page.locator('.toast.err', { hasText: 'The snapshot could not be read, so it was not kept.' })).toBeVisible();
  await expect(page.locator('#modalTitle')).not.toHaveText('Recovery snapshot captured');
  expect(await page.evaluate(() => localStorage.getItem('nv_snap_sandbox/demo'))).toBeNull();
  await expect(section.locator('#sgSnap')).toContainText('None taken yet');
});

test('branches restored read the repository again, and a report that cannot be read is said so', async ({ page }) => {
  await page.addInitScript(json => localStorage.setItem('nv_snap_sandbox/demo', json), JSON.stringify(snapshot()));
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route(at('snapshot-compare'), route => route.fulfill({ json: { comparison: { counts: { refsToMove: 1, refsToRecreate: 0, newerRefsPreserved: 0 } } } }));
  await page.route(at('restore-preview'), route => route.fulfill({ json: { canRestore: true, authorization: 'preview-authorization', warnings: [], actions: [{ name: 'main', action: 'move', to: 'b'.repeat(40) }] } }));
  const restored = [];
  await page.route(at('restore-refs'), route => { restored.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/repo/sandbox/demo') reads += 1; });
  await page.goto('/#/sandbox/demo@main/safeguards');
  const section = page.getByRole('region', { name: 'Safeguards' });
  await expect(section.locator('#sgRecover')).toBeVisible();
  await section.locator('#sgRecover').click();
  await expect(page.locator('#modalTitle')).toHaveText('Verified recovery workflow');
  await expect(page.locator('#modal')).toContainText('Leave empty to use the last snapshot captured on this device.');
  await page.locator('#modalOk').click();
  await expect(page.locator('#modalTitle')).toHaveText('Recovery impact preview');
  await expect(page.locator('#modal')).toContainText('1 branch(es) would move');
  await page.locator('#modalOk').click();
  await expect(page.locator('#modalTitle')).toHaveText('Confirm branch reference recovery');
  await page.locator('#recConfirm').fill('RESTORE');
  const before = reads;
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast.err', { hasText: 'The branches were sent to be restored, but the answer could not be read.' })).toBeVisible();
  expect(restored).toEqual([{ confirm: 'RESTORE', authorization: 'preview-authorization' }]);
  await expect.poll(() => reads).toBeGreaterThan(before);
});
