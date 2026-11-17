'use strict';

/*
 * The ground under the graph is a field.
 *
 * Its dots stand clear of the panels and of the hub, light and join into a
 * mesh under the pointer, and ripple from a press. It is its own canvas and
 * redraws only while something in it moves: a still graph under a still
 * pointer draws nothing. With motion off the light and the ripples stay out,
 * and the field is still there.
 *
 * Read from the field canvas's own pixels and from the renderer's state, so
 * the checks are on what is drawn rather than on how.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');
const { canvasInk } = require('./canvas-ink');

test.use({ serviceWorkers: 'block' });
/* The graph's state is read through the read-only probe, which the harness marker asks for (ADR-092). */
test.beforeEach(async ({ page }) => { await ui.underHarness(page); });

async function openGraph(page, motion = true) {
  await page.addInitScript(on => {
    localStorage.setItem('nv_settings', JSON.stringify({ fontSize: 14, wrap: true, motion: on, design: 'nebula' }));
  }, motion);
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.__NV_PROBE__.read('neural') || { nodes: [] }).nodes.filter(n => n.visible).length)).toBeGreaterThan(2);
  await page.locator('#neuralStage').scrollIntoViewIfNeeded();
  await page.locator('#neuralExpandBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  await page.waitForTimeout(300);
}

/* Screen points, in the page, for empty ground beside the hub and for the
 * middle of a panel. */
function landmarks(page) {
  return page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const box = document.getElementById('neuralCanvas').getBoundingClientRect();
    const toScreen = (x, y) => ({ x: box.left + s.width / 2 + s.panX + x * s.zoom, y: box.top + s.height / 2 + s.panY + y * s.zoom });
    const hub = s.nodes.find(n => n.type === 'repo');
    const panel = s.panels[0];
    const inPanel = q => s.panels.some(r => {
      const a = toScreen(r.x, r.y);
      return q.x > a.x - 30 && q.x < a.x + r.w * s.zoom + 30 && q.y > a.y - 30 && q.y < a.y + r.h * s.zoom + 30;
    });
    /* Walk up from the hub until the point is clear of every panel. */
    const h = toScreen(hub.x, hub.y);
    let ground = { x: h.x, y: h.y - 150 };
    for (let dy = 150; dy < 400 && inPanel(ground); dy += 20) ground = { x: h.x, y: h.y - dy };
    const a = toScreen(panel.x, panel.y);
    return { ground, panel: { x: a.x + panel.w * s.zoom / 2, y: a.y + panel.h * s.zoom / 2 }, box: { left: box.left, top: box.top } };
  });
}

/* Summed alpha of the field canvas in a square around a page point. */
async function inkAround(page, point, half = 40) {
  const square = await page.evaluate(({ point, half }) => {
    const canvas = document.getElementById('neuralField');
    const box = canvas.getBoundingClientRect();
    const scale = canvas.width / box.width;
    const size = Math.round(half * 2 * scale);
    return {
      x: Math.max(0, Math.round((point.x - box.left - half) * scale)),
      y: Math.max(0, Math.round((point.y - box.top - half) * scale)),
      w: size, h: size
    };
  }, { point, half });
  return canvasInk(page, '#neuralField', square);
}

test('the ground is drawn under the graph, clear of the panels', async ({ page }) => {
  await openGraph(page);
  const spots = await landmarks(page);
  expect(await inkAround(page, spots.ground)).toBeGreaterThan(0);
  expect(await inkAround(page, spots.panel, 24)).toBe(0);
  /* It is under the graph and takes no pointer events. */
  const layer = await page.evaluate(() => {
    const field = getComputedStyle(document.getElementById('neuralField'));
    return { events: field.pointerEvents, z: Number(field.zIndex), graph: Number(getComputedStyle(document.getElementById('neuralCanvas')).zIndex) };
  });
  expect(layer.events).toBe('none');
  expect(layer.z).toBeLessThan(layer.graph);
});

test('under the pointer the field lights and joins; a press ripples through it', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'the resting pointer is a mouse');
  await openGraph(page);
  const spots = await landmarks(page);
  const before = await inkAround(page, spots.ground);
  await page.mouse.move(spots.ground.x + 20, spots.ground.y + 10, { steps: 4 });
  await page.mouse.move(spots.ground.x, spots.ground.y, { steps: 4 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.light)).toBe(1);
  expect(await inkAround(page, spots.ground)).toBeGreaterThan(before * 2);

  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.ripples.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.ripples.length), { timeout: 4000 }).toBe(0);

  /* Off the stage, the light fades out. */
  await page.mouse.move(2, 2);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.light), { timeout: 10000 }).toBe(0);
});

test('a still field under a still pointer draws nothing', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'the resting pointer is a mouse');
  await openGraph(page);
  const spots = await landmarks(page);
  await page.mouse.move(spots.ground.x, spots.ground.y, { steps: 4 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.light)).toBe(1);
  /*
   * A field that redraws while still redraws in every window. One that is
   * idle has windows with no draws at all -- though the stage may still take
   * a single legitimate redraw as it settles (a pixel of resize after the
   * full view opens), so the claim is a fully quiet window within a few,
   * not the first one being quiet.
   */
  const drawsIn = async ms => {
    const before = await page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.draws);
    await page.waitForTimeout(ms);
    return (await page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.draws)) - before;
  };
  const windows = [];
  for (let i = 0; i < 4 && !windows.includes(0); i++) windows.push(await drawsIn(700));
  expect(windows, `draws in each 700ms window of stillness: ${windows.join(', ')}`).toContain(0);
  const settled = await page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.draws);
  /* Moving the hand redraws it. */
  await page.mouse.move(spots.ground.x + 30, spots.ground.y + 20, { steps: 3 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').fieldState.draws)).toBeGreaterThan(settled);
});

test('with motion off the field stays, without the light or the ripples', async ({ page }) => {
  await openGraph(page, false);
  const spots = await landmarks(page);
  expect(await inkAround(page, spots.ground)).toBeGreaterThan(0);
  await page.mouse.move(spots.ground.x, spots.ground.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  const field = await page.evaluate(() => ({ light: window.__NV_PROBE__.read('neural').fieldState.light, ripples: window.__NV_PROBE__.read('neural').fieldState.ripples.length }));
  expect(field).toEqual({ light: 0, ripples: 0 });
});
