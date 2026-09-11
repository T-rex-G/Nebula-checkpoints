'use strict';
const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function openOverview(page, motion = true) {
  await page.addInitScript(value => {
    if (!localStorage.getItem('nv_theme')) localStorage.setItem('nv_theme', 'light');
    if (!localStorage.getItem('nv_settings')) localStorage.setItem('nv_settings', JSON.stringify({ motion: value }));
  }, motion);
  await mockPublicAlphaApi(page);
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
}

test('light waves follow the real motion setting and keep the page usable', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openOverview(page);
  const canvas = page.locator('#lightWaves');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  await expect(canvas).toHaveCSS('pointer-events', 'none');
  await expect(canvas).toHaveAttribute('data-orientation', info.project.name === 'mobile' ? 'vertical' : 'horizontal');
  await expect(canvas).toHaveAttribute('data-wave-state', 'running');
  const moving = await canvas.evaluate(el => el.toDataURL());
  await expect.poll(() => canvas.evaluate(el => el.toDataURL())).not.toBe(moving);
  await (await ui.action(page, 'Settings')).click();
  const settings = ui.dialog(page, 'Settings');
  const motion = ui.checkbox(settings, 'Animated nebula background');
  await motion.uncheck();
  await expect(canvas).toHaveAttribute('data-wave-state', 'still');
  const frozen = await canvas.evaluate(el => el.toDataURL());
  // Deliberately sample across several possible animation frames: a paused
  // label is not proof that the pixels, or the work producing them, stopped.
  await page.waitForTimeout(200);
  expect(await canvas.evaluate(el => el.toDataURL())).toBe(frozen);
  await motion.check();
  await expect(canvas).toHaveAttribute('data-wave-state', 'running');
  await expect.poll(() => canvas.evaluate(el => el.toDataURL())).not.toBe(frozen);
  await motion.uncheck();
  await ui.button(settings, 'Done').click();
  await expect(settings).toBeHidden();
  await page.screenshot({ path: info.outputPath('light-waves-overview.png'), fullPage: false });
  await page.reload();
  await expect(canvas).toHaveAttribute('data-wave-state', 'still');
  await (await ui.action(page, 'Settings')).click();
  await ui.dialog(page, 'Settings').getByRole('switch', { name: 'Toggle dark or light theme' }).click();
  await expect(canvas).toBeHidden();
  await expect(canvas).toHaveAttribute('data-wave-state', 'hidden');
  expect(errors).toEqual([]);
});

test('reduced motion overrides an enabled setting and resizing preserves a still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openOverview(page);
  const canvas = page.locator('#lightWaves');
  await expect(canvas).toHaveAttribute('data-wave-state', 'still');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(canvas).toHaveAttribute('data-orientation', 'vertical');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(canvas).toHaveAttribute('data-orientation', 'horizontal');
  await expect(canvas).toHaveAttribute('data-wave-state', 'still');
  // The desktop shell adds its inset after the viewport changes. Wait for
  // ResizeObserver to repaint that new size before sampling a stopped frame.
  await expect(canvas).toHaveCSS('width', '1394px');
  const density = await page.evaluate(() => Math.min(window.devicePixelRatio, 1.5));
  await expect(canvas).toHaveAttribute('width', String(Math.round(1394 * density)));
  await expect(canvas).toHaveAttribute('height', String(Math.round(854 * density)));
  const frozen = await canvas.evaluate(el => el.toDataURL());
  await page.waitForTimeout(200);
  expect(await canvas.evaluate(el => el.toDataURL())).toBe(frozen);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(canvas).toHaveAttribute('data-wave-state', 'running');
});
