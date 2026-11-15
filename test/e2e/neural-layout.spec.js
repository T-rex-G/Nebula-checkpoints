'use strict';

/*
 * How the graph fits the screen it is on, and the screen fits the graph.
 *
 * These came from a reader's report on a phone and a laptop: on a tall stage
 * the strands ran as a ribbon of more wires than there were rows, starting
 * under the hub rather than at it -- now one spine leaves the hub's rim and
 * each row branches from it; the zoom buttons were there before the full
 * view was; turned sideways, the tools ran off the top of the stage; on the
 * page the graph took every wheel and every swipe, so the page could not be
 * scrolled past it; and at 1024 pixels the graph was squeezed into the rail's
 * column. Each test reads the thing the reader saw.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');
const { canvasInk } = require('./canvas-ink');

test.use({ serviceWorkers: 'block' });
/* The graph's state is read through the read-only probe, which the harness marker asks for (ADR-092). */
test.beforeEach(async ({ page }) => { await ui.underHarness(page); });

async function openGraph(page, routes, options = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current', ...options });
  /* Routes added after the fixture's own are matched first. */
  if (routes) await routes(page);
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.__NV_PROBE__.read('neural') || { nodes: [] }).nodes.filter(n => n.visible).length)).toBeGreaterThan(2);
  await page.locator('#neuralStage').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
}

async function expand(page) {
  await page.locator('#neuralExpandBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').width > window.innerWidth * .95)).toBe(true);
  /* The re-layout for the new shape runs a moment after the resize settles. */
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
}

test('the zoom buttons belong to the full view', async ({ page }) => {
  await openGraph(page);
  await expect(page.locator('#neuralZoomInBtn')).toBeHidden();
  await expect(page.locator('#neuralZoomOutBtn')).toBeHidden();
  await expand(page);
  await expect(page.locator('#neuralZoomInBtn')).toBeVisible();
  await expect(page.locator('#neuralZoomOutBtn')).toBeVisible();
});

test('on a tall stage one spine leaves the hub at its rim, and each row branches from it once', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'the tall stage is a phone held upright');
  await openGraph(page);
  await expand(page);
  const wiring = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const hub = s.nodes.find(n => n.type === 'repo');
    const wired = s.nodes.filter(n => n.visible && !n.folded && n.type !== 'repo' && n.path);
    const starts = new Set();
    const rims = [];
    for (const n of wired) {
      const first = n.path.segs[0];
      if (!first.line) return { error: `${n.id} does not start on the spine` };
      starts.add(`${Math.round(first.line[0].x)},${Math.round(first.line[0].y)}`);
      rims.push(Math.hypot(first.line[0].x - hub.x, first.line[0].y - hub.y));
    }
    return {
      mode: s.layoutMode,
      centred: wired.every(n => Math.abs(n.path.segs[0].line[0].x - hub.x) < .5),
      rows: wired.length,
      branches: wired.filter(n => n.curve && n.path.segs.length === 2).length,
      starts: starts.size,
      rimMin: Math.min(...rims), rimMax: Math.max(...rims)
    };
  });
  expect(wiring.error).toBeUndefined();
  expect(wiring.mode).toBe('stack');
  /* One wire per row on screen, all from one point: no more strands than rows. */
  expect(wiring.branches).toBe(wiring.rows);
  expect(wiring.starts).toBe(1);
  /* On the hub's centre line, not beside it. */
  expect(wiring.centred).toBe(true);
  /* And that point is on the hub's edge, not below it. */
  expect(wiring.rimMin).toBeGreaterThan(54);
  expect(wiring.rimMax).toBeLessThanOrEqual(58);
});

test('turned sideways, every tool is inside the stage and clear of the search', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'turning is a phone gesture');
  await openGraph(page);
  await expand(page);
  await page.setViewportSize({ width: 851, height: 393 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').layoutMode)).toBe('split');
  await page.waitForTimeout(400);
  const layout = await page.evaluate(() => {
    const stage = document.getElementById('neuralStage').getBoundingClientRect();
    const search = document.querySelector('.neural-search-wrap').getBoundingClientRect();
    const tools = [...document.querySelectorAll('.neural-stage-tools > .neural-tool')]
      .filter(tool => getComputedStyle(tool).display !== 'none')
      .map(tool => ({ id: tool.id, r: tool.getBoundingClientRect() }));
    const inside = tools.filter(t => t.r.top >= stage.top && t.r.bottom <= stage.bottom && t.r.left >= stage.left && t.r.right <= stage.right).length;
    const underSearch = tools.filter(t => t.r.bottom > search.top && t.r.top < search.bottom && t.r.right > search.left && t.r.left < search.right).map(t => t.id);
    return { count: tools.length, inside, underSearch };
  });
  expect(layout.count).toBe(8);
  expect(layout.inside).toBe(layout.count);
  expect(layout.underSearch).toEqual([]);
});

/* A graph nobody can see draws nothing: leaving the tab stops its loop, its timer and its stream. */
test('leaving the Neural tab stops the graph', async ({ page }) => {
  await openGraph(page);
  const running = await ui.probe(page, 'neural');
  expect(running.active).toBe(true);
  await ui.openTab(page, 'editor');
  await expect.poll(async () => {
    const s = await ui.probe(page, 'neural');
    return { active: s.active, raf: s.raf };
  }).toEqual({ active: false, raf: 0 });
  const frames = (await ui.probe(page, 'neural')).frames;
  await page.waitForTimeout(400);
  expect((await ui.probe(page, 'neural')).frames).toBe(frames);
});

test('turning the phone re-lays the graph and keeps it moving', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'turning is a phone gesture');
  await openGraph(page);
  await expand(page);
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').layoutMode)).toBe('stack');
  await page.setViewportSize({ width: 851, height: 393 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').layoutMode)).toBe('split');
  /* While the graph re-lays itself the effects ride on the main canvas; once
   * it settles they are back on their own layer, and still being drawn. */
  await expect.poll(() => page.evaluate(() => !window.__NV_PROBE__.read('neural').interacting && !window.__NV_PROBE__.read('neural').camTarget)).toBe(true);
  const effects = () => page.evaluate(() => ({
    layer: getComputedStyle(document.getElementById('neuralFx')).visibility,
    drawn: window.__NV_PROBE__.read('neural').lastDraw
  }));
  const ink = () => canvasInk(page, '#neuralFx', { stride: 13 });
  const before = await effects();
  const first = await ink();
  await page.waitForTimeout(400);
  const after = await effects();
  expect([before.layer, after.layer], 'the effects are on their own layer, and stay there').toEqual(['visible', 'visible']);
  expect(after.drawn, 'and are drawn on through the wait').toBeGreaterThan(before.drawn);
  expect(first).toBeGreaterThan(0);
  await expect.poll(ink, { message: 'what they draw moves' }).not.toBe(first);
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').raf)).not.toBe(0);
  /* And back upright, the tall layout returns. */
  await page.setViewportSize({ width: 393, height: 727 });
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').layoutMode)).toBe('stack');
});

test('on the page a finger scrolls the page; in the full view it moves the graph', async ({ page }) => {
  await openGraph(page);
  expect(await page.locator('#neuralCanvas').evaluate(node => getComputedStyle(node).touchAction)).toBe('pan-x pan-y');
  await expand(page);
  expect(await page.locator('#neuralCanvas').evaluate(node => getComputedStyle(node).touchAction)).toBe('none');
});

test('on the page the wheel scrolls past the graph, and Ctrl with the wheel zooms it', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'a wheel is a desktop device');
  await page.setViewportSize({ width: 1280, height: 720 });
  await openGraph(page);
  const read = () => page.evaluate(() => ({
    zoom: window.__NV_PROBE__.read('neural').zoom,
    scroll: document.getElementById('tab-neural').scrollTop
  }));
  const box = await page.locator('#neuralCanvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 120);
  const before = await read();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const scrolled = await read();
  expect(scrolled.zoom).toBe(before.zoom);
  expect(scrolled.scroll).toBeLessThan(before.scroll);
  await expect(page.locator('#neuralGestureHint')).toBeVisible();
  /* The page moved under the pointer; aim at the graph again. */
  const moved = await page.locator('#neuralCanvas').boundingBox();
  const aim = { x: moved.width / 2, y: Math.min(moved.height / 2, 120) };
  const camera = () => page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    return { zoom: s.zoom, panX: s.panX, panY: s.panY, width: s.width, height: s.height, moving: !!s.camTarget };
  });
  await expect.poll(async () => (await camera()).moving).toBe(false);
  const was = await camera();
  await page.keyboard.down('Control');
  await page.mouse.move(moved.x + aim.x, moved.y + aim.y);
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await read()).zoom).toBeGreaterThan(before.zoom);
  /* About the pointer: the part of the graph under it stays under it. */
  const now = await camera();
  const wx = (aim.x - was.width / 2 - was.panX) / was.zoom, wy = (aim.y - was.height / 2 - was.panY) / was.zoom;
  expect(Math.abs(now.width / 2 + now.panX + wx * now.zoom - aim.x)).toBeLessThan(.5);
  expect(Math.abs(now.height / 2 + now.panY + wy * now.zoom - aim.y)).toBeLessThan(.5);
});

/* Over the stage the cursor says what a press would do there. */
test('the cursor says what a press would do: a node pressed, a header moved, the ground grabbed', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'a cursor is a mouse\'s');
  await openGraph(page);
  await expand(page);
  const spots = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const canvas = document.getElementById('neuralCanvas');
    const rect = canvas.getBoundingClientRect();
    const at = (x, y) => ({ x: rect.left + s.width / 2 + s.panX + x * s.zoom, y: rect.top + s.height / 2 + s.panY + y * s.zoom });
    const clear = p => document.elementFromPoint(p.x, p.y) === canvas;
    const panel = s.panels.find(p => p.shown.length && clear(at(p.x + p.w / 2, p.y + 26)) && clear(at(p.x + p.w / 2, p.y + 56 + 22)));
    const hub = s.nodes.find(n => n.type === 'repo');
    return {
      header: at(panel.x + panel.w / 2, panel.y + 26), row: at(panel.x + panel.w / 2, panel.y + 56 + 22),
      hub: at(hub.x, hub.y), ground: at(hub.x + 180, hub.y), groundClear: clear(at(hub.x + 180, hub.y))
    };
  });
  expect(spots.groundClear).toBe(true);
  const cursorAt = async spot => {
    await page.mouse.move(spot.x, spot.y);
    return page.locator('#neuralCanvas').evaluate(canvas => canvas.style.cursor);
  };
  expect(await cursorAt(spots.header)).toBe('move');
  expect(await cursorAt(spots.row)).toBe('pointer');
  expect(await cursorAt(spots.hub)).toBe('pointer');
  expect(await cursorAt(spots.ground)).toBe('grab');
});

/* A second press of Zoom in while the camera is still moving goes on from where the first was going. */
test('two quick presses of Zoom in go twice as far', async ({ page }) => {
  await openGraph(page);
  await expand(page);
  const zoom = () => page.evaluate(() => window.__NV_PROBE__.read('neural').zoom);
  const z0 = await zoom();
  await page.locator('#neuralZoomInBtn').click();
  await page.locator('#neuralZoomInBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  expect(await zoom()).toBeCloseTo(Math.min(2.6, z0 * 1.25 * 1.25), 6);
});

test('a panel dragged by its header stays where it was put, and Reset layout puts it back', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'dragging panels is exercised with a mouse');
  await openGraph(page);
  await expand(page);
  const grip = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const panel = s.panels[s.panels.length - 1];
    const rect = document.getElementById('neuralCanvas').getBoundingClientRect();
    return {
      type: panel.type, x0: panel.x, y0: panel.y,
      x: rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom,
      y: rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom
    };
  });
  const pan = await page.evaluate(() => [window.__NV_PROBE__.read('neural').panX, window.__NV_PROBE__.read('neural').panY]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 90, grip.y - 60, { steps: 10 });
  await page.mouse.up();
  const moved = await page.evaluate(type => {
    const s = window.__NV_PROBE__.read('neural');
    const panel = s.panels.find(p => p.type === type);
    return { x: panel.x, y: panel.y, rows: panel.shown.every(n => Math.abs(n.x - n.tx) < 1 && Math.abs(n.y - n.ty) < 1), pan: [s.panX, s.panY] };
  }, grip.type);
  /* The panel moved, its rows with it, and the stage did not pan. */
  expect(moved.x).toBeLessThan(grip.x0 - 40);
  expect(moved.y).toBeLessThan(grip.y0 - 20);
  expect(moved.rows).toBe(true);
  expect(moved.pan).toEqual(pan);
  await expect(page.locator('#neuralCard')).toBeHidden();

  /* Remembered in this browser for this repository, mode and shape. */
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_neural_layout')));
  expect(Object.keys(stored)).toEqual(['sandbox/demo|security|split']);
  expect(stored['sandbox/demo|security|split'][grip.type]).toBeTruthy();

  if (!(await page.locator('#neuralLegend').isVisible())) {
    if (!(await page.locator('#neuralStage').evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  }
  await page.locator('#neuralLegend [data-neural-groups="reset-layout"]').click();
  await expect.poll(() => page.evaluate(type => window.__NV_PROBE__.read('neural').panels.find(p => p.type === type).x, grip.type)).toBe(grip.x0);
  await expect(page.locator('#neuralLegend [data-neural-groups="reset-layout"]')).toHaveCount(0);
});

/*
 * An arrangement names a repository, so it is the account's: when the account
 * changes, the page purges it with the rest of what the account kept here.
 * The map held its own copy in memory, so the next account was shown the
 * last one's arrangement of the same repository, and the first panel it moved
 * wrote the last account's arrangements back into storage.
 */
const SECOND_ACCOUNT = Object.freeze({
  login: 'second-github', name: 'Second Account', avatar: '', provider: 'github', authMethod: 'token',
  offlineCacheScope: 'second-account-scope-0123456789',
  caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true }
});

/* Drags a panel the canvas itself can be pressed on, other than `except`, by its header. */
async function dragPanel(page, except = null) {
  const grip = await page.evaluate(skip => {
    const s = window.__NV_PROBE__.read('neural');
    const canvas = document.getElementById('neuralCanvas');
    const rect = canvas.getBoundingClientRect();
    for (const panel of s.panels.slice().reverse()) {
      if (panel.type === skip) continue;
      const x = rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom;
      const y = rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom;
      if (document.elementFromPoint(x, y) === canvas) return { type: panel.type, x0: panel.x, y0: panel.y, x, y };
    }
    return null;
  }, except);
  expect(grip).not.toBeNull();
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 90, grip.y - 60, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(type => !!window.__NV_PROBE__.read('neural').panels.find(p => p.type === type).placed, grip.type)).toBe(true);
  return grip;
}

test('a panel arranged under one account is neither shown to the next nor written back for it', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'dragging panels is exercised with a mouse');
  const session = { switched: false };
  await openGraph(page, async p => {
    await p.route('**/api/accounts', route => route.fulfill({ json: { active: 0, accounts: [
      { login: 'alpha-tester', provider: 'github' }, { login: 'second-github', provider: 'github' }
    ] } }));
    await p.route('**/api/accounts/switch-idx', route => { session.switched = true; return route.fulfill({ json: { ok: true, login: 'second-github' } }); });
    await p.route('**/api/me', route => (session.switched ? route.fulfill({ json: SECOND_ACCOUNT }) : route.fallback()));
  });
  await expand(page);
  const first = await dragPanel(page);
  const view = 'sandbox/demo|security|split';
  expect(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem('nv_neural_layout'))))).toEqual([view]);

  /* The account changes, in the same page: out of the full view, to the overview's account control, and Switch. */
  await page.locator('#neuralExpandBtn').click();
  await expect(page.locator('body')).not.toHaveClass(/neural-stage-expanded/);
  await ui.rail(page, 'overview');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await ui.button(page, 'Accounts').click();
  const sheet = ui.dialog(page, 'Accounts');
  await sheet.getByRole('button', { name: 'Switch' }).click();
  await expect(sheet).toBeHidden();
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await expect(page.locator('#ovWho')).toHaveText('Second Account');
  /* What the first account kept here is purged. */
  expect(await page.evaluate(() => localStorage.getItem('nv_neural_layout'))).toBeNull();

  /* The second account opens the same repository's map: the layout's own arrangement, and nothing to reset. */
  const repos = await ui.enterRepositories(page);
  await repos.getByRole('searchbox', { name: 'Filter repositories, or paste any public repository address' }).fill('sandbox/demo');
  await repos.getByRole('button', { name: /sandbox\/demo/ }).click();
  await expect(ui.screen(page, 'work')).toBeVisible();
  await ui.openTab(page, 'neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.__NV_PROBE__.read('neural') || { nodes: [] }).nodes.filter(n => n.visible).length)).toBeGreaterThan(2);
  await page.locator('#neuralStage').scrollIntoViewIfNeeded();
  await expand(page);
  expect(await page.evaluate(type => {
    const panel = window.__NV_PROBE__.read('neural').panels.find(item => item.type === type);
    return { x: panel.x, y: panel.y, placed: !!panel.placed };
  }, first.type)).toEqual({ x: first.x0, y: first.y0, placed: false });
  await expect(page.locator('#neuralLegend [data-neural-groups="reset-layout"]')).toHaveCount(0);

  /* What it arranges is kept, alone. */
  const second = await dragPanel(page, first.type);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_neural_layout')));
  expect(Object.keys(kept)).toEqual([view]);
  expect(Object.keys(kept[view])).toEqual([second.type]);
});

/* Where a reader puts a panel is kept for the shape of stage they put it on:
 * a wide stage's two columns and a tall stage's one are different pictures. */
test('a panel moved on a wide stage stays there, and a tall stage lays out its own', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'resizing a window is a desktop gesture');
  await openGraph(page);
  await expand(page);
  const grip = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const panel = s.panels[s.panels.length - 1];
    const rect = document.getElementById('neuralCanvas').getBoundingClientRect();
    return {
      type: panel.type,
      x: rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom,
      y: rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom
    };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 90, grip.y - 60, { steps: 10 });
  await page.mouse.up();
  const kept = await page.evaluate(type => JSON.parse(localStorage.getItem('nv_neural_layout'))['sandbox/demo|security|split'][type], grip.type);
  const panel = () => page.evaluate(type => {
    const s = window.__NV_PROBE__.read('neural');
    const p = s.panels.find(item => item.type === type);
    return { mode: s.layoutMode, x: p.x, y: p.y, placed: !!p.placed };
  }, grip.type);
  expect(await panel()).toEqual({ mode: 'split', x: kept.x, y: kept.y, placed: true });

  /* Turned tall, the stack is laid out afresh: the panel stands in its column. */
  await page.setViewportSize({ width: 700, height: 1100 });
  await expect.poll(panel).toMatchObject({ mode: 'stack', x: 64, placed: false });
  /* Turned back, it is where the reader put it. */
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(panel).toEqual({ mode: 'split', x: kept.x, y: kept.y, placed: true });
});

test('at 1024 pixels the graph has the pane to itself, not the rail\'s column', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'a laptop width');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openGraph(page);
  const sizes = await page.evaluate(() => ({
    stage: document.getElementById('neuralStage').getBoundingClientRect().width,
    pane: document.getElementById('tab-neural').clientWidth,
    stageH: document.getElementById('neuralStage').getBoundingClientRect().height,
    paneH: document.getElementById('tab-neural').clientHeight
  }));
  expect(sizes.stage).toBeGreaterThan(sizes.pane * .9);
  /* And no taller than the pane it scrolls in, so it can be seen whole. */
  expect(sizes.stageH).toBeLessThanOrEqual(sizes.paneH);
});

test('in the full view the status, search, tools and panel keep clear of a phone\'s clock and home bar', async ({ page }) => {
  await openGraph(page);
  await expand(page);
  /* A browser here has no notch, so the insets an iPhone reports are given
   * to the stage directly: 47px under the clock, 34px above the home bar. */
  await page.evaluate(() => {
    const stage = document.getElementById('neuralStage');
    stage.style.setProperty('--sat', '47px'); stage.style.setProperty('--sab', '34px');
  });
  const read = () => page.evaluate(() => {
    const top = el => document.querySelector(el).getBoundingClientRect();
    return {
      search: top('.neural-search-wrap').top, status: top('.neural-stream-state').top,
      tools: top('.neural-stage-tools').top, toolsBottom: window.innerHeight - top('.neural-stage-tools').bottom
    };
  });
  const clear = await read();
  expect(clear.search).toBeGreaterThanOrEqual(47);
  expect(clear.status).toBeGreaterThanOrEqual(47);
  expect(clear.tools).toBeGreaterThanOrEqual(47 + 38);
  expect(clear.toolsBottom).toBeGreaterThanOrEqual(34);
  /* And the modes panel starts below the clock rather than under it. */
  if (!(await page.locator('#neuralStage').evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  const firstMode = await page.locator('#neuralRail .neural-mode').first().boundingBox();
  expect(firstMode.y).toBeGreaterThanOrEqual(47);
  /* The fit frames the graph in what is left: below the search. */
  await page.locator('#neuralPanelBtn').click();
  await page.locator('#neuralCanvas').focus();
  await page.keyboard.press('f');
  const inset = await page.evaluate(() => window.__NV_PROBE__.read('neural').insets);
  expect(inset.top).toBeGreaterThanOrEqual(47 + 38);
  expect(inset.bottom).toBeGreaterThanOrEqual(34);
});

test('a refresh keeps the graph on screen and the camera where the reader left it', async ({ page }) => {
  await openGraph(page);
  await expand(page);
  await page.locator('#neuralZoomInBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  const before = await page.evaluate(() => ({ zoom: window.__NV_PROBE__.read('neural').zoom, panX: window.__NV_PROBE__.read('neural').panX }));
  let covered = false;
  await page.exposeFunction('__coverSeen', () => { covered = true; });
  await page.evaluate(() => {
    const cover = document.getElementById('neuralLoading');
    new MutationObserver(() => { if (!cover.hidden) window.__coverSeen(); }).observe(cover, { attributes: true });
  });
  /* The full view covers the header, so the refresh is sent to its control; it runs as the live stream's and the timer's do. */
  await page.locator('#neuralRefreshBtn').dispatchEvent('click');
  await page.waitForTimeout(400);
  expect(covered).toBe(false);
  const after = await page.evaluate(() => ({ zoom: window.__NV_PROBE__.read('neural').zoom, panX: window.__NV_PROBE__.read('neural').panX }));
  expect(after.zoom).toBeCloseTo(before.zoom, 3);
  expect(after.panX).toBeCloseTo(before.panX, 1);
});

test('the full view re-frames itself when the screen changes size, until the reader moves it', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'resizing a window is a desktop gesture');
  await openGraph(page);
  await expand(page);
  const zoom = () => page.evaluate(() => (window.__NV_PROBE__.read('neural').camTarget || window.__NV_PROBE__.read('neural')).zoom);
  const wide = await zoom();
  await page.setViewportSize({ width: 960, height: 720 });
  await expect.poll(zoom).toBeLessThan(wide - .01);
  /* Once the reader zooms, a resize leaves their view alone. */
  await page.locator('#neuralZoomInBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  const chosen = await zoom();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(500);
  expect(await zoom()).toBeCloseTo(chosen, 3);
  /* Fitting hands it back. */
  await page.locator('#neuralCanvas').focus();
  await page.keyboard.press('f');
  expect(await page.evaluate(() => window.__NV_PROBE__.read('neural').userCamera)).toBe(false);
});

test('credentials an Exposure scan found are in the graph, masked, and lead back to Exposure', async ({ page }) => {
  await openGraph(page, target => target.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/exposure/findings', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      findings: [
        { fingerprint: 'fp-live', rule: 'github-token', disposition: 'open', displayPath: 'scripts/release.sh', occurrences: [{ line: 14 }], inTree: true, narration: { severity: 'serious', what: 'A GitHub personal access token.' } },
        { fingerprint: 'fp-history', rule: 'aws-access-key', disposition: 'open', displayPath: 'config/settings.py', occurrences: [{ line: 7 }], inTree: false, introducedCommit: 'abc1234def', narration: { severity: 'serious', what: 'An AWS access key ID.' } },
        { fingerprint: 'fp-dead', rule: 'stripe-live-key', disposition: 'credential-rejected', displayPath: '.env.example', occurrences: [{ line: 3 }], inTree: true, narration: { severity: 'critical', what: 'A Stripe live secret key.' } }
      ],
      verifications: { 'fp-live': { state: 'verified', narration: 'The provider confirmed this credential is live.' } }
    })
  })));
  const leaks = await page.evaluate(() => window.__NV_PROBE__.read('neural').nodes.filter(n => n.type === 'leak')
    .map(n => ({ id: n.id, label: n.label, severity: n.severity, where: n.meta.where, foundIn: n.meta.foundIn })));
  expect(leaks).toHaveLength(3);
  const byId = Object.fromEntries(leaks.map(leak => [leak.id, leak]));
  /* Confirmed live by its provider: critical. Refused by it: quiet. */
  expect(byId['leak:fp-live'].severity).toBe('critical');
  expect(byId['leak:fp-dead'].severity).toBe('normal');
  expect(byId['leak:fp-history']).toMatchObject({ where: 'config/settings.py:7', foundIn: 'History only · abc1234' });
  expect(byId['leak:fp-live'].label).toBe('GitHub token · release.sh');
  /* Nothing on the node could be the secret: only the finding's own words. */
  expect(JSON.stringify(leaks)).not.toMatch(/ghp_|AKIA|sk_live/);
  await page.locator('#neuralSearch').fill('GitHub token');
  await expect(page.locator('#neuralCardTitle')).toHaveText('GitHub token · release.sh');
  await page.locator('#neuralCard [data-neural-action="exposure"]').click();
  await expect(page.locator('#tab-exposure')).toBeVisible();
});

test('the stage\'s light follows the pointer', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'a pointer that hovers');
  await openGraph(page);
  const box = await page.locator('#neuralStage').boundingBox();
  await page.mouse.move(box.x + 120, box.y + 90);
  await expect.poll(() => page.locator('#neuralLight').evaluate(node => node.style.getPropertyValue('--nv-mx'))).toBe('120px');
  expect(await page.locator('#neuralLight').evaluate(node => node.style.getPropertyValue('--nv-my'))).toBe('90px');
});

/*
 * Reported from a phone: after dragging panels about in the full view there
 * was no way back from the stage itself -- Reset layout lived only in the
 * groups rail, which is closed there. The stage now carries its own chip,
 * shown only while something has been moved.
 */
test('after a drag the stage offers Reset layout itself, and it puts everything back', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'dragging panels is exercised with a mouse');
  await openGraph(page);
  await expand(page);
  const chip = page.locator('#neuralResetLayout');
  await expect(chip).toBeHidden();
  const grip = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const panel = s.panels[s.panels.length - 1];
    const rect = document.getElementById('neuralCanvas').getBoundingClientRect();
    return {
      type: panel.type, x0: panel.x,
      x: rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom,
      y: rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom
    };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 90, grip.y - 60, { steps: 10 });
  await page.mouse.up();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect.poll(() => page.evaluate(type => window.__NV_PROBE__.read('neural').panels.find(p => p.type === type).x, grip.type)).toBe(grip.x0);
  await expect(chip).toBeHidden();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('nv_neural_layout') || '{}'));
  expect(Object.keys(stored)).toEqual([]);
});

/*
 * The search is one control -- icon, field and clear button -- so it is
 * focused as one. The field's own thick ring, hung a few pixels outside it,
 * drew a box inside the box.
 */
test('the node search is focused as one control, with no ring inside it', async ({ page }) => {
  await openGraph(page);
  await expand(page);
  const search = page.locator('#neuralSearch');
  await search.focus();
  await page.keyboard.type('ma');
  const focus = await page.evaluate(() => {
    const input = document.getElementById('neuralSearch');
    const wrap = input.closest('.neural-search-wrap');
    const own = getComputedStyle(input);
    return { outline: own.outlineStyle, inputShadow: own.boxShadow, wrapShadow: getComputedStyle(wrap).boxShadow };
  });
  expect(focus.outline).toBe('none');
  expect(focus.inputShadow).toBe('none');
  expect(focus.wrapShadow).not.toBe('none');
});

/*
 * The Neural view carries its own summary, so the workbench's repository trust
 * bar stands aside while it is open and comes back with the other tabs. The
 * header above the graph is one slim bar: its three controls share one row
 * on a phone, and the four readings are one strip whose values stay on one
 * line each, rather than four slabs with wrapped figures.
 */
test('the Neural view drops the trust bar and keeps its header to one compact band', async ({ page }) => {
  /* Measured with all three controls drawn, live events included: the narrowest the band has to hold. */
  await openGraph(page, null);
  await expect(page.locator('#trustSummary')).toBeHidden();

  const actions = await page.locator('.neural-head-actions .btn').evaluateAll(buttons =>
    buttons.map(button => {
      const box = button.getBoundingClientRect();
      return { top: Math.round(box.top), height: box.height, fits: button.scrollWidth <= button.clientWidth + 1 };
    }));
  expect(actions).toHaveLength(3);
  expect(new Set(actions.map(one => one.top)).size, 'the header controls wrap onto more than one row').toBe(1);
  for (const one of actions) {
    expect(one.fits, 'a header control clips its own label').toBe(true);
    expect(one.height).toBeLessThanOrEqual(48);
  }

  const values = await page.locator('.neural-kpi strong').evaluateAll(nodes =>
    nodes.map(node => ({
      text: node.textContent,
      lines: node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).fontSize),
      whole: node.scrollWidth <= node.clientWidth + 1
    })));
  for (const one of values) {
    expect(one.lines, `"${one.text}" wraps`).toBeLessThan(1.8);
    expect(one.whole, `"${one.text}" is cut short`).toBe(true);
  }
  /* Its state is a dot by the label, never the figure's own colour. */
  const inked = await page.locator('.neural-kpi strong').evaluateAll(nodes =>
    new Set(nodes.map(node => getComputedStyle(node).color)).size);
  expect(inked).toBe(1);

  /* Back to the editor by whichever control this width offers: the tab strip
     on a desk, the bottom bar on a phone. */
  const tab = page.locator('.tab[data-tab="editor"]');
  if (await tab.isVisible()) await tab.click();
  else await page.locator('#bottomNav button[data-nav="editor"]').click();
  await expect(page.locator('#trustSummary')).toBeVisible();
});

/*
 * With the file tree open beside a laptop-width pane the Neural columns stack,
 * and the rail used to come first: the graph began a thousand pixels down,
 * past the bottom of the window. The graph leads, and the mode descriptions
 * wrap rather than trail off in an ellipsis.
 */
test('beside an open file tree the graph leads the stacked Neural layout', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/neural');
  await expect(page.locator('#neuralStage')).toBeVisible();
  const layout = await page.evaluate(() => {
    const top = selector => document.querySelector(selector).getBoundingClientRect().top;
    const mode = document.querySelector('.neural-mode small');
    return { stage: top('#neuralStage'), rail: top('#neuralRail'), viewport: innerHeight, clipped: getComputedStyle(mode).textOverflow === 'ellipsis' };
  });
  expect(layout.stage, 'the graph comes before the rail').toBeLessThan(layout.rail);
  expect(layout.stage, 'and begins inside the window').toBeLessThan(layout.viewport - 200);
  expect(layout.clipped).toBe(false);
});

/* A tall stage stacks the groups in one column under the hub, read from the top down the way a list is: a fit starts at the hub, not at the column's middle. */
test('on a tall stage a fit starts the graph at its top, with the hub in view', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'the tall stage is a phone held upright');
  await page.setViewportSize({ width: 390, height: 600 });
  /* Sixty branches, opened: a column far longer than the stage. */
  const refs = {
    defaultBranch: 'main',
    refs: [...Array.from({ length: 59 }, (_, i) => ({ name: `feature/${String(i).padStart(3, '0')}`, sha: 'a'.repeat(40) })), { name: 'main', sha: 'b'.repeat(40), protected: true }],
    tags: []
  };
  await openGraph(page, async p => {
    await p.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/refs-snapshot', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refs) }));
  });
  await expand(page);
  /* The groups list is in the full view's panel: open it, if it is not. */
  if (!(await page.locator('#neuralStage').evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  /* Opening every group fits the graph again. */
  await page.locator('#neuralLegend [data-neural-groups="open"]').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').panels.some(p => p.footer === 'pager'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  const view = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const hub = s.nodes.find(n => n.type === 'repo');
    const bottom = Math.max(...s.panels.map(p => p.y + p.h));
    return {
      mode: s.layoutMode, height: s.height, hubTop: s.height / 2 + s.panY + (hub.y - 58) * s.zoom,
      hubY: s.height / 2 + s.panY + hub.y * s.zoom, overflows: s.height / 2 + s.panY + bottom * s.zoom > s.height
    };
  });
  expect(view.mode).toBe('stack');
  expect(view.overflows, 'the column is longer than the stage, so where a fit starts it matters').toBe(true);
  expect(view.hubTop).toBeGreaterThan(0);
  expect(view.hubY).toBeLessThan(view.height * .4);
});

/* On a wide screen the modes panel docks over the full view's left side; a fit frames the graph in what it leaves. */
test('in the full view a fit frames the graph clear of the docked modes panel', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'the panel docks over the stage on a wide screen');
  await openGraph(page);
  await expand(page);
  if (!(await page.locator('#neuralStage').evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  await page.locator('#neuralFitBtn').click();
  await expect.poll(() => page.evaluate(() => window.__NV_PROBE__.read('neural').camTarget)).toBeNull();
  const edges = await page.evaluate(() => {
    const s = window.__NV_PROBE__.read('neural');
    const rail = document.getElementById('neuralRail');
    const canvas = document.getElementById('neuralCanvas').getBoundingClientRect();
    return {
      docked: rail.classList.contains('is-docked'), railRight: rail.getBoundingClientRect().right,
      graphLeft: canvas.left + s.width / 2 + s.panX + Math.min(...s.panels.map(p => p.x)) * s.zoom
    };
  });
  expect(edges.docked).toBe(true);
  expect(edges.graphLeft).toBeGreaterThan(edges.railRight);
});

/*
 * Messages over the full view. On a phone a message drops from the top of the
 * screen, where the page has nothing else; in the full view the top is the
 * stage's -- its status and search, and the column of tools down the right --
 * and a message lay across the tools for as long as it showed. On a wider
 * screen messages keep to the bottom right, where in a short window the tools
 * run down to meet them. Whatever the shape, a message keeps clear of the
 * stage's controls.
 */
test('in the full view a message keeps clear of the stage\'s status, tools and panel', async ({ page }) => {
  const phone = (page.viewportSize() || {}).width <= 900;
  const sizes = phone ? [null, { width: 360, height: 640 }, { width: 844, height: 390 }, { width: 568, height: 320 }]
    : [null, { width: 1440, height: 420 }, { width: 960, height: 540 }];
  for (const size of sizes) {
    if (size) await page.setViewportSize(size);
    if (!size) await openGraph(page);
    else await page.locator('#neuralStage').scrollIntoViewIfNeeded();
    if (!(await page.locator('body').evaluate(body => body.classList.contains('neural-stage-expanded')))) await expand(page);
    /* One message at a time: the last size's has gone. */
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 10000 });
    await page.locator('#neuralDemoBtn').click();
    const message = page.locator('#toasts .toast').filter({ hasText: 'Demonstration incident injected' }).last();
    await expect(message).toBeVisible();
    /* Measured once it has finished arriving. */
    await page.waitForTimeout(400);
    const overlap = await page.evaluate(() => {
      const toasts = [...document.querySelectorAll('#toasts .toast')].map(t => t.getBoundingClientRect());
      const furniture = [...document.querySelectorAll('#neuralStage .neural-stage-tools > *, #neuralStage .neural-stage-top > *, #neuralStage .neural-minimap, #neuralStage .neural-reset-chip, #neuralRail')]
        .filter(el => el.getClientRects().length && !el.hidden && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none')
        .map(el => ({ name: el.id || el.className, rect: el.getBoundingClientRect() }))
        .filter(f => f.rect.width && f.rect.height && f.rect.right > 0 && f.rect.left < innerWidth);
      const hits = [];
      for (const t of toasts) for (const f of furniture) {
        const r = f.rect;
        if (t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top) hits.push(f.name);
      }
      const inside = toasts.every(t => t.left >= 0 && t.right <= innerWidth && t.top >= 0 && t.bottom <= innerHeight);
      return { hits, inside, count: toasts.length };
    });
    expect(overlap.count).toBeGreaterThan(0);
    expect(overlap.hits, `${JSON.stringify(size || page.viewportSize())}: a message lies across the stage's controls`).toEqual([]);
    expect(overlap.inside, `${JSON.stringify(size || page.viewportSize())}: the message is on screen`).toBe(true);
  }
});
