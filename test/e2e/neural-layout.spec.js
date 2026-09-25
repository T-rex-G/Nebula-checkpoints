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

test.use({ serviceWorkers: 'block' });

async function openGraph(page, routes) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  /* Routes added after the fixture's own are matched first. */
  if (routes) await routes(page);
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.nodes.filter(n => n.visible).length)).toBeGreaterThan(2);
  await page.locator('#neuralStage').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
}

async function expand(page) {
  await page.locator('#neuralExpandBtn').click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.width > window.innerWidth * .95)).toBe(true);
  /* The re-layout for the new shape runs a moment after the resize settles. */
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
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
    const s = window.NebulaNeural.state;
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
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.layoutMode)).toBe('split');
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

test('turning the phone re-lays the graph and keeps it moving', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'turning is a phone gesture');
  await openGraph(page);
  await expand(page);
  expect(await page.evaluate(() => window.NebulaNeural.state.layoutMode)).toBe('stack');
  await page.setViewportSize({ width: 851, height: 393 });
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.layoutMode)).toBe('split');
  /* While the graph re-lays itself the effects ride on the main canvas; once
   * it settles they are back on their own layer, and still being drawn. */
  await expect.poll(() => page.evaluate(() => !window.NebulaNeural.state.interacting && !window.NebulaNeural.state.camTarget)).toBe(true);
  const sample = () => page.evaluate(() => {
    const fx = document.getElementById('neuralFx');
    const data = fx.getContext('2d').getImageData(0, 0, fx.width, fx.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4 * 13) sum += data[i];
    return sum;
  });
  const first = await sample();
  await page.waitForTimeout(400);
  const second = await sample();
  expect(first).toBeGreaterThan(0);
  expect(second).not.toBe(first);
  expect(await page.evaluate(() => window.NebulaNeural.state.raf)).not.toBe(0);
  /* And back upright, the tall layout returns. */
  await page.setViewportSize({ width: 393, height: 727 });
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.layoutMode)).toBe('stack');
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
    zoom: window.NebulaNeural.state.zoom,
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
  await page.keyboard.down('Control');
  await page.mouse.move(moved.x + moved.width / 2, moved.y + Math.min(moved.height / 2, 120));
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await read()).zoom).toBeGreaterThan(before.zoom);
});

test('a panel dragged by its header stays where it was put, and Reset layout puts it back', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'dragging panels is exercised with a mouse');
  await openGraph(page);
  await expand(page);
  const grip = await page.evaluate(() => {
    const s = window.NebulaNeural.state;
    const panel = s.panels[s.panels.length - 1];
    const rect = s.canvas.getBoundingClientRect();
    return {
      type: panel.type, x0: panel.x, y0: panel.y,
      x: rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom,
      y: rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom
    };
  });
  const pan = await page.evaluate(() => [window.NebulaNeural.state.panX, window.NebulaNeural.state.panY]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 90, grip.y - 60, { steps: 10 });
  await page.mouse.up();
  const moved = await page.evaluate(type => {
    const s = window.NebulaNeural.state;
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
  await expect.poll(() => page.evaluate(type => window.NebulaNeural.state.panels.find(p => p.type === type).x, grip.type)).toBe(grip.x0);
  await expect(page.locator('#neuralLegend [data-neural-groups="reset-layout"]')).toHaveCount(0);
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
  const inset = await page.evaluate(() => window.NebulaNeural.state.insets);
  expect(inset.top).toBeGreaterThanOrEqual(47 + 38);
  expect(inset.bottom).toBeGreaterThanOrEqual(34);
});

test('a refresh keeps the graph on screen and the camera where the reader left it', async ({ page }) => {
  await openGraph(page);
  await expand(page);
  await page.locator('#neuralZoomInBtn').click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
  const before = await page.evaluate(() => ({ zoom: window.NebulaNeural.state.zoom, panX: window.NebulaNeural.state.panX }));
  let covered = false;
  await page.exposeFunction('__coverSeen', () => { covered = true; });
  await page.evaluate(() => {
    const cover = document.getElementById('neuralLoading');
    new MutationObserver(() => { if (!cover.hidden) window.__coverSeen(); }).observe(cover, { attributes: true });
  });
  await page.evaluate(() => window.NebulaNeural.refresh());
  await page.waitForTimeout(400);
  expect(covered).toBe(false);
  const after = await page.evaluate(() => ({ zoom: window.NebulaNeural.state.zoom, panX: window.NebulaNeural.state.panX }));
  expect(after.zoom).toBeCloseTo(before.zoom, 3);
  expect(after.panX).toBeCloseTo(before.panX, 1);
});

test('the full view re-frames itself when the screen changes size, until the reader moves it', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 900, 'resizing a window is a desktop gesture');
  await openGraph(page);
  await expand(page);
  const zoom = () => page.evaluate(() => (window.NebulaNeural.state.camTarget || window.NebulaNeural.state).zoom);
  const wide = await zoom();
  await page.setViewportSize({ width: 960, height: 720 });
  await expect.poll(zoom).toBeLessThan(wide - .01);
  /* Once the reader zooms, a resize leaves their view alone. */
  await page.locator('#neuralZoomInBtn').click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
  const chosen = await zoom();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(500);
  expect(await zoom()).toBeCloseTo(chosen, 3);
  /* Fitting hands it back. */
  await page.locator('#neuralCanvas').focus();
  await page.keyboard.press('f');
  expect(await page.evaluate(() => window.NebulaNeural.state.userCamera)).toBe(false);
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
  const leaks = await page.evaluate(() => window.NebulaNeural.state.nodes.filter(n => n.type === 'leak')
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
