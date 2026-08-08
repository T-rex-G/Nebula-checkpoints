'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');

test.describe('Task 20 browser and accessibility staging', () => {
  test.use({ serviceWorkers: 'block' });

  test('keyboard dialog traps focus and restores it to the invoking control', async ({ page }) => {
    await mockTask20Api(page);
    await openRepository(page);

    const settingsButton = page.locator('#settingsBtnWork');
    const trigger = await settingsButton.isVisible() ? settingsButton : page.locator('#paletteBtn');
    await trigger.focus();
    if (await settingsButton.isVisible()) await page.keyboard.press('Enter');
    else await page.evaluate(() => { void openSettings(); });

    const scrim = page.locator('#scrim');
    const dialog = page.locator('#modal');
    await expect(scrim).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'modalTitle');
    await expect(page.locator('#modalTitle')).toHaveText('Settings');
    await expect.poll(() => page.evaluate(() => document.querySelector('#modal').contains(document.activeElement))).toBe(true);

    const firstFocusable = dialog.locator('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])').first();
    await page.locator('#modalOk').focus();
    await page.keyboard.press('Tab');
    await expect(firstFocusable).toBeFocused();

    await firstFocusable.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#modalOk')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(scrim).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('mobile More navigation activates the live Governance workspace', async ({ page }) => {
    const state = {};
    await page.setViewportSize({ width: 393, height: 851 });
    await mockTask20Api(page, state);
    await openRepository(page);

    await page.locator('#bottomNav [data-nav="more"]').click();
    await expect(page.locator('#sheetScrim')).toBeVisible();
    await page.locator('#sheet .sheet-item[data-act="governance"]').click();

    await expect(page.locator('#sheetScrim')).toBeHidden();
    await expect(page.locator('#tab-governance')).toHaveClass(/active/);
    await expect(page.locator('#tab-governance h2')).toHaveText('Policy Digital Twin');
    await expect(page.locator('#govDeliveryTitle')).toBeVisible();
    expect(state.governanceRequests).toBeGreaterThanOrEqual(4);
  });

  test('offline refresh cannot reuse governance API responses from Cache Storage', async ({ page, context }) => {
    await mockTask20Api(page);
    await openRepository(page);
    const governanceTab = page.locator('.tab[data-tab="governance"]');
    if (await governanceTab.isVisible()) {
      await governanceTab.click();
    } else {
      await page.locator('#bottomNav [data-nav="more"]').click();
      await page.locator('#sheet .sheet-item[data-act="governance"]').click();
    }
    await expect(page.locator('#tab-governance h2')).toHaveText('Policy Digital Twin');

    const cachedGovernanceUrls = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          if (request.url.includes('/governance/')) urls.push(request.url);
        }
      }
      return urls;
    });
    expect(cachedGovernanceUrls).toEqual([]);

    await page.unroute('**/api/**');
    await context.setOffline(true);
    await page.locator('[data-gov-action="refresh"]').click();

    await expect(page.getByRole('alert')).toContainText('Governance evidence unavailable');
    await expect(page.locator('#govLive')).not.toHaveText('Policy Digital Twin and delivery evidence refreshed');
  });
});

test.describe('Task 20 governance service-worker boundary', () => {
  test.use({ serviceWorkers: 'allow' });

  test('offline service worker keeps governance API responses live-only', async ({ page, context }) => {
    const governanceUrl = '/api/repo/acme/demo/governance/digital-twin';
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    const onlineStatus = await page.evaluate(async url => (await fetch(url)).status, governanceUrl);
    expect(onlineStatus).toBe(401);

    const cachedWhileOnline = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          if (request.url.includes('/governance/')) urls.push(request.url);
        }
      }
      return urls;
    });
    expect(cachedWhileOnline).toEqual([]);

    await context.setOffline(true);
    const offlineResponse = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, body: await response.json() };
    }, governanceUrl);
    expect(offlineResponse.status).toBe(503);
    expect(offlineResponse.body.error).toContain('live connection');

    const cachedWhileOffline = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          if (request.url.includes('/governance/')) urls.push(request.url);
        }
      }
      return urls;
    });
    expect(cachedWhileOffline).toEqual([]);
  });
});
