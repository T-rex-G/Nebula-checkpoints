'use strict';

/*
 * Four-way design review: dark and light, desktop and mobile.
 *
 * Written because eyeballing one view proved worthless twice over. Checking
 * only dark desktop hid a light palette that was still running on dark tokens;
 * and a harness that set the active screen by hand skipped the app's own
 * navigation, so every screenshot was taken with the sidebar hidden and the
 * session sitting on the login screen. Both looked like design problems and
 * neither was.
 *
 * So this drives the real thing: it signs in through the interface with the
 * browser fixtures the suite uses, waits for the screen to settle, and shoots
 * each combination. It asserts nothing -- it exists so a person can look.
 *
 * Note on reading the output: this runs with a software rasteriser so the
 * artwork draws at all, and Chromium's compositor ghosts previously-painted
 * screens through backdrop-filtered surfaces under it. That faint duplicate of
 * the sign-in screen is an artifact of the renderer, not of the product -- on
 * hardware, and with the artwork left off, it is not there.
 *
 * Service workers are blocked here. The product's worker re-issues API GETs
 * from its own scope, and requests that originate there never pass through the
 * page's route table -- so the fixtures missed them, the real server answered
 * "Not signed in", and the overview drew itself with no repositories and a
 * failure toast. That was the harness losing the fixtures, not the product
 * losing its session.
 *
 * Reading the -full.png captures: the application shell is one fixed plate, and
 * a full-page capture paints a fixed layer only over the first viewport. Below
 * that line the plate is missing, so translucent cards lose their ground and
 * appear to be cut across by a hard horizontal edge. That edge sits exactly at
 * the viewport height and is the capture, not the product -- scroll the real
 * page and it is not there. The full captures are still worth having: every
 * composition defect found so far has been below the fold.
 *
 *   node scripts/design-review.js [outputDirectory]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { mockPublicAlphaApi } = require('../test/e2e/public-alpha-fixtures');

const MODES = Object.freeze([
  { name: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { name: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { name: 'mobile-dark', width: 390, height: 820, theme: 'dark' },
  { name: 'mobile-light', width: 390, height: 820, theme: 'light' }
]);

const SCREENS = Object.freeze(['overview', 'repos']);

/*
 * The command palette lives on the repository workspace, and on a narrow
 * screen its only entry point is the floating action -- the top bar has no
 * room for it there. So the mobile capture opens a repository and presses the
 * control a thumb would, then shoots the palette open over the workspace.
 *
 * The workspace is entered by its own route rather than by tapping through the
 * inventory. Tapping works, but boot finishes a moment later and moves the
 * screen out from under the capture; restoring the route puts the workspace up
 * as the settled destination instead of as a place the app is passing through.
 * That the tapped route does not hold is a defect in the product, not in this
 * script -- it is worth fixing, and worth not hiding behind a longer wait here.
 */
async function captureMobilePalette(context, out, mode) {
  const page = await context.newPage();
  await presentAsHardwareRenderer(page);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor({ timeout: 20000 });
  await page.evaluate(theme => {
    document.documentElement.dataset.theme = theme;
    if (window.NebulaVisuals) window.NebulaVisuals.repaint();
  }, mode.theme);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(out, `work-${mode.name}.png`) });
  process.stdout.write(`work-${mode.name}\n`);

  /*
   * The floating action now opens a menu, so there are two things worth
   * photographing: the menu a thumb reaches, and the palette one of its
   * entries opens.
   */
  const fab = page.locator('#paletteFab');
  await fab.waitFor({ state: 'visible' });
  await fab.click();
  await page.locator('#fabMenu:not([hidden])').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `actions-${mode.name}.png`) });
  process.stdout.write(`actions-${mode.name}\n`);

  await page.locator('#fabMenu .nv-fab-item', { hasText: 'Command palette' }).click();
  await page.locator('#paletteScrim:not([hidden])').waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `palette-${mode.name}.png`) });
  process.stdout.write(`palette-${mode.name}\n`);
}

/*
 * The container has no GPU, and the product declines software rasterisers on
 * purpose, so a review that wants to see the artwork has to present itself as
 * a machine that can draw it. This is a lie told to the probe, never shipped.
 */
async function presentAsHardwareRenderer(page) {
  await page.addInitScript(() => {
    for (const proto of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!proto) continue;
      const original = proto.prototype.getParameter;
      proto.prototype.getParameter = function getParameter(name) {
        const value = original.call(this, name);
        return typeof value === 'string' && /swiftshader|llvmpipe/i.test(value)
          ? 'Design Review Renderer'
          : value;
      };
    }
  });
}

async function signIn(page) {
  await mockPublicAlphaApi(page, {
    access: 'required', ready: 'ready', provider: 'github', repositoryState: 'current'
  });
  await page.goto(`${process.env.NV_REVIEW_URL || 'http://127.0.0.1:21999'}/`);
  await page.getByLabel('One-time invitation').fill('design-review-invitation');
  await page.getByRole('checkbox', { name: /I accept/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('GitHub Personal Access Token').fill('design-review-credential');
  await page.getByRole('button', { name: 'Enter orbit' }).click();
  await page.getByRole('main', { name: 'Workspace overview' }).waitFor({ state: 'visible' });
}

async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'design-review'));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
  });
  try {
    for (const mode of MODES) {
      const context = await browser.newContext({
        viewport: { width: mode.width, height: mode.height },
        baseURL: process.env.NV_REVIEW_URL || 'http://127.0.0.1:21999',
        serviceWorkers: 'block'
      });
      const page = await context.newPage();
      await presentAsHardwareRenderer(page);
      await signIn(page);
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        if (window.NebulaVisuals) window.NebulaVisuals.repaint();
      }, mode.theme);

      for (const screen of SCREENS) {
        /* Navigate the way a reader does, so the chrome paints as it really would. */
        if (screen === 'repos') {
          await page.getByRole('button', { name: 'Repositories', exact: true }).click();
          await page.getByRole('main', { name: 'Your galaxies' }).waitFor({ state: 'visible' });
        }
        await page.waitForTimeout(2600);
        await page.screenshot({ path: path.join(out, `${screen}-${mode.name}.png`) });
        /*
         * And the whole scroll, not just the fold. Every defect found by
         * looking at these so far has been below it -- a row that stopped
         * short of the width, a card that kept the previous palette -- and a
         * viewport-sized shot is exactly the evidence that hides them.
         */
        await page.screenshot({ path: path.join(out, `${screen}-${mode.name}-full.png`), fullPage: true });
        process.stdout.write(`${screen}-${mode.name}\n`);
      }
      /*
       * The sidebar collapse is photographed because the reflow it causes is
       * the point of it: the shell has to give the freed width back to the
       * cards rather than leave it as margin. A still of the collapsed rail
       * shows whether it did.
       */
      if (mode.width >= 900) {
        await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Overview' }).click();
        await page.getByRole('main', { name: 'Workspace overview' }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
        await page.waitForTimeout(1400);
        await page.screenshot({ path: path.join(out, `collapsed-${mode.name}.png`) });
        process.stdout.write(`collapsed-${mode.name}\n`);
      }

      await context.close();

      /*
       * A context of its own. Reusing the signed-in one carried its session
       * into the fixture's own entry, which then landed somewhere the entry
       * did not expect and waited for a control that screen does not show.
       */
      if (mode.width < 900) {
        const fresh = await browser.newContext({
          viewport: { width: mode.width, height: mode.height },
          baseURL: process.env.NV_REVIEW_URL || 'http://127.0.0.1:21999',
          serviceWorkers: 'block'
        });
        await captureMobilePalette(fresh, out, mode);
        await fresh.close();
      }
    }
  } finally {
    await browser.close();
  }
  const written = fs.readdirSync(out).filter(name => name.endsWith('.png')).length;
  process.stdout.write(`\nWrote ${written} views to ${out}\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
