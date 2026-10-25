'use strict';

const { expect } = require('@playwright/test');

/*
 * The page, held still: its fonts loaded, no request in flight for a moment,
 * nothing moving, and the control where it was a few frames ago. Hovering
 * can start work of its own -- scrolling a control into view is what makes
 * the pull board read -- so this runs after the hover as well as before it.
 */
async function settle(page, control, inflight) {
  await page.evaluate(() => document.fonts.ready);
  let last = null;
  for (let round = 0; round < 40; round += 1) {
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter(animation => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {}))));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)))));
    const box = JSON.stringify(await control.boundingBox());
    if (inflight.size === 0 && box === last) return;
    last = box;
  }
  throw new Error('the page did not hold still long enough to press on it');
}

/* What an element is, for a failure that names where a press landed. */
function describe(element) {
  if (!element) return 'nothing';
  const classes = String(element.className || '').trim().split(/\s+/).filter(Boolean).map(name => `.${name}`).join('');
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes} "${(element.textContent || '').trim().slice(0, 40)}"`;
}

/*
 * Presses and holds the pointer on a control, once the page has settled, so
 * that what follows is a reading landing under a press, not a press that
 * missed. A route that finishes loading resets the scroll, a late font or a
 * reading moves what is on the page, and a press made before then lands on
 * whatever is at that point.
 */
async function pressOn(page, control) {
  const inflight = new Set();
  const started = request => inflight.add(request);
  const ended = request => inflight.delete(request);
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  try {
    await page.waitForLoadState('networkidle');
    await settle(page, control, inflight);
    await control.hover();
    await settle(page, control, inflight);
    /* A card that moved may have carried the control out of view; bring it back, and let that settle too. */
    await control.scrollIntoViewIfNeeded();
    await settle(page, control, inflight);
    /*
     * The hover left the pointer where the control was when it scrolled into
     * view. A reading the scroll started can move the card after that, so the
     * pointer goes to where the control is now, and that point is what is
     * checked and pressed. (CI's mobile slice pressed a severity bar beside a
     * repository's name this way.)
     */
    const box = await control.boundingBox();
    const point = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(point[0], point[1]);
    const under = await control.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)), point);
    const covering = under ? '' : await page.evaluate(`(${describe.toString()})(document.elementFromPoint(${point[0]}, ${point[1]}))`);
    expect(under, `the control is under the pointer${covering ? `, not ${covering}` : ''}`).toBe(true);
    /*
     * The press is seen where the page sees it: the pointerdown's target, read
     * at the window. `:active` is not set for a pointer on every emulated
     * device. The target is then looked for in the control as the locator
     * finds it now: a card may be rebuilt between the check above and the
     * press, and a listener on the element it replaced would never hear the
     * press its replacement received.
     */
    await page.evaluate(() => {
      window.__nvPressTarget = null;
      window.addEventListener('pointerdown', event => { window.__nvPressTarget = event.target; }, { once: true, capture: true });
    });
    await page.mouse.down();
    const pressed = await control.evaluate(element => element.contains(window.__nvPressTarget));
    const landed = pressed ? '' : await page.evaluate(`(${describe.toString()})(window.__nvPressTarget)`);
    expect(pressed, `the control is being pressed${landed ? `, but the press landed on ${landed}` : ''}`).toBe(true);
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
  }
}

module.exports = Object.freeze({ pressOn });
