'use strict';

/*
 * The page's look, used by the page: settings kept by an older page or by
 * hand -- a size that is a word, a font the editor does not offer, a design
 * that is not one -- are read past, so the editor keeps a size and a font it
 * can show; a kept theme is dark or light and nothing else; and the light on
 * a card follows a fine pointer in the card's own box. The modules are asked
 * directly by test/page-appearance.test.js.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

test('settings that are not settings are read past, and the editor keeps a size and font it can show', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.addInitScript(() => {
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 'huge', editorFont: "x', serif; color: red", design: 'neon', wrap: 'no' }));
    localStorage.setItem('nv_theme', 'blue');
  });
  await page.goto('/#/sandbox/demo@main/editor');
  await expect(page.locator('#page-work')).toHaveClass(/active/);
  const look = await page.evaluate(() => {
    const root = document.documentElement;
    return { font: root.style.getPropertyValue('--ed-font'), family: root.style.getPropertyValue('--ed-family'), design: root.dataset.design, theme: root.dataset.theme };
  });
  expect(look).toEqual({ font: '0.875rem', family: "'DM Mono', ui-monospace, monospace", design: 'nebula', theme: 'dark' });
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_settings')));
  expect(kept).toMatchObject({ fontSize: 14, editorFont: 'DM Mono', design: 'nebula', wrap: true });
});

test('the light on a card follows a fine pointer, and rests when it leaves', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'a touch screen has no pointer between presses to follow');
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  const card = page.locator('#wpTrust');
  await expect(card).toBeVisible();
  /* The card under the pointer, read as the pointer moves: a card the screen draws again is lit again by the next move. */
  const lightAt = async (fx, fy) => {
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;
    await page.mouse.move(x, y);
    return page.evaluate(([px, py]) => {
      const under = document.elementFromPoint(px, py);
      const lit = under && under.closest('.card');
      return lit ? [lit.style.getPropertyValue('--mx'), lit.style.getPropertyValue('--my')] : null;
    }, [x, y]);
  };
  /* The pointer lands on whole pixels: the light is within half a percent of a quarter across and three quarters down. */
  await expect.poll(async () => {
    const light = await lightAt(0.25, 0.75);
    return light && light.every(value => /^\d+\.\d%$/.test(value)) ? light.map(value => Math.round(parseFloat(value) * 2) / 2) : light;
  }).toEqual([25, 75]);
  await page.mouse.move(2, 2);
  await expect.poll(() => card.evaluate(node => [node.style.getPropertyValue('--mx'), node.style.getPropertyValue('--my')])).toEqual(['50%', '0%']);
});
