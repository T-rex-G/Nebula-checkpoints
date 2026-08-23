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
