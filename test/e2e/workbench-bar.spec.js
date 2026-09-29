'use strict';

/*
 * The workbench bar on a phone, with the read-only lock showing: the
 * repository name keeps room, Private is its shield alone, and nothing in
 * the brand runs on under the controls beside it.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

for (const width of [320, 360, 390, 430]) {
  test(`at ${width}px with read-only on, the name shows and nothing overlaps`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the phone bar');
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.route('**/api/safety', route => route.fulfill({ json: { readOnly: true, freezeSync: false, protected: {}, globalControls: false } }));
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#/sandbox/demo@main/editor');
    await page.locator('#page-work.active').waitFor();
    await expect(page.locator('#roChip')).toBeVisible();
    await expect(page.locator('#workRepoName')).toHaveText('sandbox/demo');
    await expect(page.locator('#workRepoName')).toHaveAttribute('title', 'sandbox/demo');

    const box = selector => page.locator(selector).boundingBox();
    const [name, brand, sync] = await Promise.all([box('#workRepoName'), box('#backBtn'), box('#syncBtn')]);
    expect(name.width, 'the repository name is never squeezed to nothing').toBeGreaterThan(20);
    expect(brand.x + brand.width, 'the brand ends before the refresh control').toBeLessThanOrEqual(sync.x);
    const badge = page.locator('#workPrivateBadge');
    if (width > 340) {
      await expect(badge).toBeVisible();
      const shield = await badge.boundingBox();
      expect(shield.width).toBeLessThanOrEqual(24);
      expect(shield.x + shield.width).toBeLessThanOrEqual(brand.x + brand.width);
      /* The word is gone from sight, not from the accessibility tree. */
      await expect(badge).toHaveAccessibleName(/Private/);
    } else {
      await expect(badge).toBeHidden();
    }
  });
}
