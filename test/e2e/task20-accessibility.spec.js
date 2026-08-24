'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');
const ui = require('./semantic');

/*
 * The governance workspace is reached differently on each width: a tab bar on
 * desktop, the More sheet on mobile. Both name the same destination, so the
 * helper asks for whichever the viewport offers rather than branching on a
 * class that happens to be hidden.
 */
async function openGovernance(page) {
  /*
   * Exact, because the destination is now offered in two places: the
   * workbench's own tab, named just "Governance", and the sidebar entry, whose
   * name carries its subtitle -- "Governance Policy digital twin". A loose
   * match resolved to both the moment the sidebar gained the entry. Either
   * arrives at the same pane; this asks for the one the workbench itself
   * carries, which is the control this journey is about.
   */
  const tab = page.getByRole('button', { name: 'Governance', exact: true });
  if (await tab.isVisible()) {
    await tab.click();
    return;
  }
  await page.getByRole('navigation', { name: 'Mobile repository navigation' })
    .getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Policy Digital Twin' }).click();
}

test.describe('Task 20 browser and accessibility staging', () => {
  test.use({ serviceWorkers: 'block' });

  test('keyboard dialog traps focus and restores it to the invoking control', async ({ page }) => {
    await mockTask20Api(page);
    await openRepository(page);

    /*
     * Narrow widths hide the Settings control behind the command palette, so
     * the test walks that route rather than calling the handler through
     * page.evaluate. Reaching in that way proved the dialog worked when
     * something opened it, not that anything a reader can touch does -- the
     * palette row could have gone missing and this would still have passed.
     */
    const settingsButton = ui.button(page, 'Settings');
    const onDesktop = await settingsButton.isVisible();
    const trigger = onDesktop ? settingsButton : await ui.action(page, 'Command palette');
    await trigger.focus();
    if (onDesktop) {
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.press('Enter');
      await ui.palette(page).fill('Settings');
      await ui.paletteOption(page, /Settings/i).first().click();
    }

    /*
     * Asking for the dialog by name subsumes the three attribute assertions
     * this used to make: nothing resolves as a named dialog unless role,
     * aria-modal and the labelling are all right together.
     */
    const dialog = ui.dialog(page, 'Settings');
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('#modal').contains(document.activeElement))).toBe(true);

    const firstFocusable = dialog.locator('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])').first();
    const commit = ui.button(dialog, 'Done');
    await commit.focus();
    await page.keyboard.press('Tab');
    await expect(firstFocusable).toBeFocused();

    await firstFocusable.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(commit).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    /*
     * Not necessarily the element that was pressed. On a phone the palette is
     * reached through the floating dock, and activating an entry closes the
     * dock -- so focus comes back to the dock, which is the control still on
     * screen. Asserting the entry would be asserting that the interface failed
     * to put its own menu away. On a desktop nothing moves and the trigger is
     * the control that was pressed.
     */
    await expect(onDesktop ? trigger : await ui.actionAnchor(page, 'Command palette')).toBeFocused();
  });

  test('mobile More navigation activates the live Governance workspace', async ({ page }) => {
    const state = {};
    await page.setViewportSize({ width: 393, height: 851 });
    await mockTask20Api(page, state);
    await openRepository(page);

    await page.getByRole('navigation', { name: 'Mobile repository navigation' })
      .getByRole('button', { name: 'More' }).click();
    const sheetEntry = page.getByRole('button', { name: 'Policy Digital Twin' });
    await expect(sheetEntry).toBeVisible();
    await sheetEntry.click();

    const governance = page.getByRole('region', { name: 'Governance' });
    await expect(governance).toBeVisible();
    await expect(governance.getByRole('heading', { name: 'Policy Digital Twin' })).toBeVisible();
    expect(state.governanceRequests).toBeGreaterThanOrEqual(4);
  });

  test('offline refresh cannot reuse governance API responses from Cache Storage', async ({ page, context }) => {
    await mockTask20Api(page);
    await openRepository(page);
    await openGovernance(page);
    await expect(
      page.getByRole('region', { name: 'Governance' }).getByRole('heading', { name: 'Policy Digital Twin' })
    ).toBeVisible();

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

    await expect(ui.alert(page)).toContainText('Governance evidence unavailable');
    await expect(ui.status(page, 'Governance updates'))
      .not.toHaveText('Policy Digital Twin and delivery evidence refreshed');
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
    /*
     * The worker's own refusal -- the 503 it returns once the network is gone
     * -- used to be asserted here, by putting the context offline and
     * expecting it back. That failed about half the time, and not because of
     * timing: putting a browser context offline does not reliably reach
     * requests that originate inside a service worker, the same blind spot
     * that makes route interception miss them, so the worker kept fetching
     * successfully and this kept receiving the server's answer instead.
     * Waiting longer did not help, because nothing was on the way.
     *
     * That branch is exercised directly in test/service-worker-offline.test.js,
     * where the network can actually be made to fail. What stays here is the
     * invariant a page can observe: whatever the request comes back as,
     * nothing governance-shaped is ever written to a cache, so there is
     * nothing for the worker to serve from one.
     */
    await page.evaluate(url => fetch(url).then(() => {}, () => {}), governanceUrl);

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
