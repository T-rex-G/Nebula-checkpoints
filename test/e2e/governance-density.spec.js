'use strict';

/*
 * The governance pane already has a guard for hanging off the side of a 320px
 * screen. Nothing guarded the other axis, and that is where it failed.
 *
 * Reported from a phone with two collisions on one screen: the pane's own
 * intro line sat behind the sticky repository toolbar, and the read-model hash
 * -- the identity of the twin the whole page describes -- sat under the
 * floating action button. Both are content the reader cannot get to by
 * scrolling, because the chrome that covers them is fixed and travels with the
 * viewport.
 *
 * Horizontal overflow is loud: the page scrolls sideways and everything looks
 * wrong. This is quiet. The layout is intact, the text is rendered, and it is
 * simply underneath something else, which is why it survived to a screenshot.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });
test.skip(({ viewport }) => !viewport || viewport.width > 900, 'the collisions are with phone chrome');

async function openGovernance(page) {
  /*
   * 'populated' matters. Without it the pane renders "Governance evidence
   * unavailable" -- one card, no timeline, no exports, no webhooks -- and this
   * guard would pass by having almost nothing to collide with.
   */
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', governance: 'populated' });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.reload();
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => window.switchTab('governance'));
  await page.locator('#tab-governance').waitFor();
  await page.waitForTimeout(900);
}

/*
 * Only chrome that actually paints over the pane counts. A full-viewport
 * backdrop at z-index -2 overlaps every element on the page and hides none of
 * them; counting it would report a collision on every healthy screen and make
 * this guard useless. So the layer has to be positioned, painted above the
 * content, and opaque enough to hide what is under it.
 *
 * Each layer is also classified by which edge it is anchored to, because that
 * is what decides when it is a fault. Content passing under a sticky header
 * while the reader scrolls is not a fault -- another scroll brings it back
 * out. Content that is under the header at the TOP of the scroll, or under the
 * dock at the BOTTOM of it, has nowhere left to go: no gesture will ever
 * reveal it. That is the whole difference between a header doing its job and
 * the page burying its own content, and the first version of this guard could
 * not tell them apart -- it reported twenty-seven collisions, most of them
 * healthy transit.
 */
const COLLIDING_CHROME = `() => {
  const layers = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (Number(cs.opacity) < 0.5) continue;
    if ((Number(cs.zIndex) || 0) < 1) continue;
    if (el.closest('#tab-governance')) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    const viewport = document.documentElement.clientHeight;
    /* Which edge it is pinned to, by which half of the screen it occupies. */
    const edge = box.top + box.height / 2 < viewport / 2 ? 'top' : 'bottom';
    layers.push({ box, edge, name: el.id || String(el.className).slice(0, 32) || el.tagName.toLowerCase() });
  }
  return layers;
}`;

/*
 * The pane's own leaf text and controls. Containers are skipped because their
 * boxes span their children and would report one collision several times.
 */
const BURIED_UNDER = `(edge) => {
  const layers = (${COLLIDING_CHROME})().filter(layer => layer.edge === edge);
  const buried = [];
  for (const node of document.querySelectorAll('#tab-governance *')) {
    if (!node.textContent || !node.textContent.trim()) continue;
    if (node.querySelector('*')) continue;
    const position = getComputedStyle(node).position;
    if (position === 'fixed' || position === 'sticky') continue;
    const box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    for (const layer of layers) {
      /* Two pixels of tolerance: a rounded corner grazing the chrome hides
       * nothing legible. */
      const overlapY = Math.min(box.bottom, layer.box.bottom) - Math.max(box.top, layer.box.top);
      const overlapX = Math.min(box.right, layer.box.right) - Math.max(box.left, layer.box.left);
      if (overlapY > 2 && overlapX > 2) {
        buried.push(node.textContent.trim().slice(0, 44) + '  <-  ' + layer.name);
      }
    }
  }
  return [...new Set(buried)];
}`;

test('the top of the governance pane is not stuck under the header', async ({ page }) => {
  await openGovernance(page);
  const buried = await page.evaluate(`(() => {
    document.scrollingElement.scrollTop = 0;
    return (${BURIED_UNDER})('top');
  })()`);
  expect(
    buried,
    'scrolled fully up, this content is behind the top chrome and no gesture can reveal it'
  ).toEqual([]);
});

test('the end of the governance pane is not stuck under the dock', async ({ page }) => {
  await openGovernance(page);
  const buried = await page.evaluate(`(() => {
    const scroller = document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
    return (${BURIED_UNDER})('bottom');
  })()`);
  expect(
    buried,
    'scrolled fully down, this content is behind the bottom dock and no gesture can reveal it'
  ).toEqual([]);
});

/*
 * The pane's existing width guard resizes to 320px while the pane is showing
 * its evidence FAILURE -- one short card. The populated page is a different
 * layout with different content: policy cards, four-column fact grids, hash
 * strings with no break opportunities, and button rows three wide. None of it
 * had ever been measured at any width, and this run added padding to it.
 *
 * Resized rather than loaded at 320, because that is what rotating a device
 * does, and the pane's earlier blowout only appeared on resize.
 */
test('the populated governance pane fits a 320px screen', async ({ page }) => {
  await openGovernance(page);
  await page.setViewportSize({ width: 320, height: 560 });
  await page.waitForTimeout(900);

  const reading = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const escaping = [];
    for (const node of document.querySelectorAll('#tab-governance *')) {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.right > limit + 2 && getComputedStyle(node).position !== 'fixed') {
        escaping.push(`${node.tagName.toLowerCase()}.${String(node.className).slice(0, 24)} ${Math.round(box.width)}px`);
      }
    }
    return { limit, documentOverflow: document.body.scrollWidth - limit, escaping: escaping.slice(0, 5) };
  });

  expect(reading.limit).toBe(320);
  expect(reading.escaping, 'nothing in the populated governance pane may hang off a 320px screen').toEqual([]);
  expect(reading.documentOverflow, 'the page must not scroll sideways at 320px').toBeLessThanOrEqual(2);
});
