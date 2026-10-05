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

/*
 * A long-lived repository's governance: a ledger of dozens of entries, an
 * inbox of thirty notifications, fourteen exports. One list at a time, a
 * page at a time, filtered by outcome; cleared from view without touching
 * the ledger, and brought back in one press; notifications cleared on the
 * server.
 */
test('a long governance history reads a page at a time and clears from view', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'busy' });
  await page.goto('/#/sandbox/demo@main/governance');
  const pane = page.locator('#tab-governance');
  const ledger = pane.locator('.gov-ledger');
  await expect(ledger).toBeVisible({ timeout: 15000 });

  /* Runtime decisions first, eight at a time, with more behind them on the server. */
  await expect(ledger.getByRole('tab', { name: /Runtime decisions/ })).toHaveAttribute('aria-selected', 'true');
  await expect(ledger.getByRole('tab', { name: /Runtime decisions/ })).toContainText('25+');
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(8);
  await expect(ledger.locator('.gov-ledger-shown')).toHaveText('Showing 8 of 25');
  await ledger.getByRole('button', { name: 'Show 8 more' }).click();
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(16);

  /* Filtered by outcome: only what was blocked. */
  await ledger.getByRole('button', { name: /^Blocked 5$/ }).click();
  await expect(ledger.getByRole('button', { name: /^Blocked 5$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(5);
  await expect(ledger.locator('.gov-ledger-row[data-tone="block"]')).toHaveCount(5);

  /* Activations: the running version is marked current, an earlier one offers to roll back by name, not as a full-width button. */
  await ledger.getByRole('tab', { name: /Activations/ }).click();
  await expect(ledger.getByRole('tab', { name: /Activations/ })).toHaveAttribute('aria-selected', 'true');
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(8);
  await expect(ledger.locator('.gov-ledger-act').first()).toHaveAttribute('aria-label', /^(Roll back to|Turn back on) (alpha|zeta) version [0-9a-f]{8}$/);
  const act = await ledger.locator('.gov-ledger-act').first().boundingBox();
  expect(act.width).toBeLessThanOrEqual(40);

  /* Cleared from view, and back; the count of what was cleared is said, and it stays cleared on the next visit. */
  await ledger.getByRole('button', { name: 'Clear from view' }).click();
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(0);
  await expect(ledger).toContainText('All 34 cleared from view. They are still in the ledger.');
  await expect(ledger.locator('.gov-ledger-note')).toContainText('The ledger is immutable');
  await expect(ledger.getByRole('button', { name: 'Show 34 cleared' })).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nv_view:ledger:sandbox/demo') || '{}').activations)).toBe(100);
  await ledger.getByRole('button', { name: 'Show 34 cleared' }).click();
  await expect(ledger.locator('.gov-ledger-row[data-cleared="true"]')).toHaveCount(8);
  await ledger.getByRole('button', { name: 'Hide cleared' }).click();
  await expect(ledger.locator('.gov-ledger-row')).toHaveCount(0);

  /* The inbox: unread first, six at a time; Clear marks them read on the server and puts them away. */
  const inbox = pane.locator('.gov-inbox');
  await expect(inbox.locator('.gov-inbox-row')).toHaveCount(6);
  await expect(inbox).toContainText('30 unread');
  await inbox.getByRole('button', { name: 'Clear 30' }).click();
  await expect(inbox).toContainText('0 unread');
  await expect(inbox).toContainText('All caught up. Nothing unread.');
  await inbox.getByRole('button', { name: 'Show 30 read' }).click();
  await expect(inbox.locator('.gov-inbox-row[data-read="true"]')).toHaveCount(6);

  /* Exports: the latest four, the rest one press away. */
  const exportsCard = pane.locator('.gov-exports');
  await expect(exportsCard.locator('.gov-export-row')).toHaveCount(4);
  await exportsCard.getByRole('button', { name: 'Show all 14' }).click();
  await expect(exportsCard.locator('.gov-export-row')).toHaveCount(14);
});
