'use strict';

const { expect } = require('@playwright/test');

/*
 * Presses and holds the pointer on a control, once the page has settled: no
 * reading still in flight, nothing still moving, and the control itself under
 * the pointer and being pressed -- so what follows is a reading landing under
 * a press, not a press that missed. A route that finishes loading resets the
 * scroll, and a press made before then lands on whatever is at that point.
 */
async function pressOn(page, control) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
    .map(animation => animation.finished.catch(() => {}))));
  await control.hover();
  const box = await control.boundingBox();
  const under = await control.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2]);
  expect(under, 'the control is under the pointer').toBe(true);
  await page.mouse.down();
  expect(await control.evaluate(element => element.matches(':active')), 'the control is being pressed').toBe(true);
}

module.exports = Object.freeze({ pressOn });
