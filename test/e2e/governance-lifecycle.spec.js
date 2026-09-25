'use strict';

/*
 * The governance lifecycle controls send what the server expects.
 *
 * The server refuses a stale revision, a missing reason and a missing
 * Idempotency-Key, so a control that sends any of them wrong looks like it
 * works -- the modal closes -- and then does nothing. These press each control
 * and read the request that actually left the page.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

const ALPHA = '10000000-0000-4000-8000-000000000001';
const ZETA = '20000000-0000-4000-8000-000000000002';

async function openGovernance(page) {
  const sent = [];
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await page.route(/\/governance\/(policies\/[^/]+\/(deactivate|archive|restore|drafts\/[^/]+|versions\/[^/]+\/withdraw)|reset)$/, route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    sent.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
      idempotencyKey: request.headers()['idempotency-key'] || ''
    });
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => window.switchTab('governance'));
  await expect(page.locator('[data-gov-action="deactivate-policy"]')).toBeVisible();
  return sent;
}

async function confirm(page, reason) {
  if (reason !== undefined) await page.locator('#govLifecycleReason').fill(reason);
  await page.locator('#modalOk').click();
}

test('switching a policy off sends its revision, a reason and an idempotency key', async ({ page }) => {
  const sent = await openGovernance(page);
  await page.locator(`[data-gov-action="deactivate-policy"][data-policy-id="${ALPHA}"]`).click();
  await expect(page.locator('#modal')).toContainText('Enforcement stops at once');
  await confirm(page, 'Pausing during the migration.');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].method).toBe('POST');
  expect(sent[0].path).toBe(`/api/repo/sandbox/demo/governance/policies/${ALPHA}/deactivate`);
  expect(sent[0].body).toEqual({ expectedRevision: 3, reason: 'Pausing during the migration.' });
  expect(sent[0].idempotencyKey).toMatch(/^governance-ui:policy-deactivate:/);
});

test('a lifecycle action without a reason is refused before anything is sent', async ({ page }) => {
  const sent = await openGovernance(page);
  await page.locator(`[data-gov-action="archive-policy"][data-policy-id="${ALPHA}"]`).click();
  await expect(page.locator('#modal')).toContainText('It is switched off first');
  await confirm(page, '   ');
  await expect(page.locator('.toast').last()).toContainText('A reason is required');
  expect(sent).toEqual([]);
});

test('archive, restore, discard and withdraw each reach their own route', async ({ page }) => {
  const sent = await openGovernance(page);

  await page.locator(`[data-gov-action="archive-policy"][data-policy-id="${ZETA}"]`).click();
  await confirm(page, 'Replaced.');
  await expect.poll(() => sent.length).toBe(1);

  await page.locator('.gov-archived > summary').click();
  await page.locator('[data-gov-action="restore-policy"]').click();
  await expect(page.locator('#modal')).toContainText('comes back switched off');
  await confirm(page, 'Needed again.');
  await expect.poll(() => sent.length).toBe(2);

  await page.locator('[data-gov-action="discard-draft"]').click();
  await confirm(page);
  await expect.poll(() => sent.length).toBe(3);

  await page.locator('[data-gov-action="withdraw-version"]').click();
  await confirm(page, 'Superseded.');
  await expect.poll(() => sent.length).toBe(4);

  expect(sent.map(item => `${item.method} ${item.path.replace('/api/repo/sandbox/demo/governance', '')}`)).toEqual([
    `POST /policies/${ZETA}/archive`,
    'POST /policies/80000000-0000-4000-8000-000000000008/restore',
    `DELETE /policies/${ALPHA}/drafts/60000000-0000-4000-8000-000000000006`,
    `POST /policies/${ALPHA}/versions/40000000-0000-4000-8000-000000000004/withdraw`
  ]);
  expect(sent[0].body).toEqual({ expectedRevision: 2, reason: 'Replaced.' });
  expect(sent[2].body).toEqual({ expectedRevision: 1 });
});

test('the reset asks for the repository name and sends nothing when it is wrong', async ({ page }) => {
  const sent = await openGovernance(page);
  const reset = page.locator('[data-gov-action="reset-governance"]');
  await reset.scrollIntoViewIfNeeded();
  await reset.click();
  await expect(page.locator('#modal')).toContainText('Kept: the evidence ledger');
  await page.locator('#govLifecycleReason').fill('Start again.');
  await page.locator('#govResetConfirm').fill('sandbox/other');
  await page.locator('#modalOk').click();
  await expect(page.locator('.toast').last()).toContainText('Type sandbox/demo exactly');
  expect(sent).toEqual([]);
});
