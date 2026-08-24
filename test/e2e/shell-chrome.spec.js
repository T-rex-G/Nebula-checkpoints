'use strict';

/*
 * The application shell: a sidebar a reader can narrow, and one floating
 * action that carries whatever the screen in front of them actually needs.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function openWorkspace(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
}

test.describe('desktop shell', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the sidebar exists above 1140px');

  test('the sidebar narrows and remembers that it was narrowed', async ({ page }) => {
    await openWorkspace(page);
    const rail = page.getByRole('navigation', { name: 'Primary' });
    const expanded = (await rail.boundingBox()).width;

    /*
     * The rail animates to its narrow width, so its box has to be read once it
     * has settled rather than on the frame after the click -- measuring
     * immediately caught it still at its full width and reported a working
     * collapse as a broken one.
     */
    await ui.button(page, 'Collapse the sidebar').click();
    await expect.poll(async () => (await rail.boundingBox()).width,
      { message: 'collapsing must actually narrow the rail' }).toBeLessThan(expanded - 80);
    const collapsed = (await rail.boundingBox()).width;

    /*
     * Narrowed to marks, the entries still have to say what they are: a rail
     * of unlabelled icons is unusable by anyone navigating with a screen
     * reader, and unguessable for everyone else.
     */
    const entry = page.getByRole('button', { name: 'Repositories', exact: false }).first();
    await expect(entry).toHaveAttribute('title', /Repositories/i);
    await expect(ui.button(page, 'Expand the sidebar')).toBeVisible();

    /* The preference is the reader's, so it survives a reload. */
    await page.reload();
    await expect(ui.screen(page, 'overview')).toBeVisible();
    await expect.poll(async () => (await rail.boundingBox()).width).toBeLessThan(expanded - 80);

    await ui.button(page, 'Expand the sidebar').click();
    await expect.poll(async () => (await rail.boundingBox()).width).toBeGreaterThan(collapsed + 80);
  });
});

test('the floating action carries the action of the screen it is on', async ({ page }) => {
  await openWorkspace(page);
  const fab = page.locator('#paletteFab');

  /*
   * One control, three jobs. The overview's next step is the inventory, the
   * inventory's is a new repository, and the workspace's is the palette --
   * and the control says which it is, rather than being a fixed icon whose
   * meaning a reader has to learn.
   */
  await expect(fab).toHaveAttribute('aria-label', 'Open repository browser');

  await ui.button(page, 'Open repository browser').first().click();
  await expect(ui.screen(page, 'repos')).toBeVisible();
  await expect(fab).toHaveAttribute('aria-label', 'Create repository');

  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  await expect(fab).toHaveAttribute('aria-label', 'Command palette');
});

/*
 * Every screen inside the plate, not just the two that were remembered. The
 * workbench read no inset at all, so its file tree spent every desktop session
 * underneath the sidebar -- present in the accessibility tree, reachable by
 * keyboard, and completely hidden from anyone looking at the screen. The guard
 * is the same for all three: whatever the rail's width, the content region
 * begins where the rail ends.
 */
test.describe('desktop shell regions', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the sidebar exists above 1140px');

  test('no screen lays its content underneath the sidebar', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    const rail = page.getByRole('navigation', { name: 'Primary' });
    const regions = [
      {
        name: 'workbench',
        open: async () => {
          await rail.getByRole('button', { name: 'Classic workbench' }).click();
          await page.locator('#page-work.active').waitFor();
        },
        locator: page.locator('#page-work .workspace')
      },
      {
        name: 'overview',
        open: async () => {
          await rail.getByRole('button', { name: 'Overview' }).click();
          await expect(ui.screen(page, 'overview')).toBeVisible();
        },
        locator: page.locator('#page-overview .container')
      },
      {
        name: 'repositories',
        open: async () => {
          await rail.getByRole('button', { name: 'Repositories' }).click();
          await expect(ui.screen(page, 'repos')).toBeVisible();
        },
        locator: page.locator('#page-repos .container')
      }
    ];

    for (const collapsed of [false, true]) {
      if (collapsed) await ui.button(page, 'Collapse the sidebar').click();
      for (const region of regions) {
        await region.open();
        /* Polled, because the inset animates: the frame after a click still
         * holds the previous width. */
        await expect.poll(async () => {
          const edge = await rail.boundingBox();
          const content = await region.locator.boundingBox();
          return content ? Math.round(content.x - (edge.x + edge.width)) : null;
        }, { message: `${region.name} must start after the rail ends` }).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/*
 * The plate is the application's ground -- the surface the sidebar and every
 * screen sit on. It was a pseudo-element that another rule already claimed:
 * body::after belongs to the standalone status-bar backdrop as well, and an
 * element has only one. The two declarations merged, the status bar's
 * height:env(safe-area-inset-top) survived because nothing in the plate's own
 * rule set a height, and an explicit height beats a bottom offset -- so the
 * plate computed to zero pixels tall. All that ever reached the screen was its
 * two borders, a 2px band across the top of the page whose corner radii CSS
 * clamps away at that height. The ground was never drawn, which is exactly
 * what it looked like.
 */
test.describe('the application plate', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the plate is drawn above 1140px');

  test('is a surface with real height and corners, not a hairline', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/');
    await expect(ui.screen(page, 'overview')).toBeVisible();

    const plate = page.locator('#shellPlate');
    const box = await plate.boundingBox();
    const viewport = page.viewportSize();

    /* It has to cover the workspace, not sit on top of it as a strip. */
    expect(box.height).toBeGreaterThan(viewport.height * 0.8);
    expect(box.width).toBeGreaterThan(viewport.width * 0.8);

    /*
     * And its corners have to be round. CSS scales border radii down when the
     * box is too small to hold them, so a collapsed plate reports a radius it
     * does not draw -- comparing the declared radius against the box is what
     * catches that, not reading the radius alone.
     */
    const radius = await plate.evaluate(node => parseFloat(getComputedStyle(node).borderTopRightRadius));
    expect(radius).toBeGreaterThan(8);
    expect(box.height).toBeGreaterThan(radius * 2);
    expect(box.width).toBeGreaterThan(radius * 2);

    /* The sidebar sits on the plate; it must not hang off it. */
    const rail = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
    expect(rail.x).toBeGreaterThanOrEqual(box.x);
    expect(rail.y).toBeGreaterThanOrEqual(box.y);
  });
});
