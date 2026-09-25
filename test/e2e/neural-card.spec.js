'use strict';

/*
 * Pressing a node explains it where it is.
 *
 * The graph is a hub and one panel per group, each node a row in its group's
 * panel. The details used to fill a panel beside the graph -- below it on
 * anything narrower than a wide desktop, often off screen -- so what was
 * pressed and what it meant were in two different places. The card now opens
 * beside the node's panel, joined to its row, and moves with it; on a phone it
 * is a sheet over the page. These press real rows on the real canvas and read
 * what opened.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function openGraph(page, { runs } = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  if (runs) {
    await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/actions', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runs) }));
  }
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.nodes.filter(n => n.visible).length)).toBeGreaterThan(2);
  await page.locator('#neuralStage').scrollIntoViewIfNeeded();
  /* Let the layout finish easing so a node is where the test aims. */
  await page.waitForTimeout(900);
}

/* Where a node is on the page right now, in CSS pixels: the first matching
 * node that has a row of its own (not folded into "+ n more") and is on
 * screen, so a press lands on the canvas rather than on the page around it. */
async function nodePoint(page, predicate) {
  return page.evaluate(source => {
    const s = window.NebulaNeural.state;
    const test = new Function('n', `return (${source})(n);`);
    const rect = s.canvas.getBoundingClientRect();
    for (const node of s.nodes) {
      if (!node.visible || node.folded || !test(node)) continue;
      const x = s.width / 2 + s.panX + node.x * s.zoom, y = s.height / 2 + s.panY + node.y * s.zoom;
      if (x < 24 || y < 24 || x > s.width - 90 || y > s.height - 24) continue;
      const px = rect.left + x, py = rect.top + y;
      if (py < 10 || py > window.innerHeight - 10 || document.elementFromPoint(px, py) !== s.canvas) continue;
      return { id: node.id, label: node.label, x: px, y: py };
    }
    return null;
  }, predicate.toString());
}

/* A point on the canvas with nothing under it: no node, no panel, nothing
 * painted over the canvas. */
async function emptyPoint(page) {
  /* Wait for the camera to settle, or the point is where empty ground was. */
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
  return page.evaluate(() => {
    const s = window.NebulaNeural.state;
    const rect = s.canvas.getBoundingClientRect();
    const toScreen = (x, y) => ({ x: s.width / 2 + s.panX + x * s.zoom, y: s.height / 2 + s.panY + y * s.zoom });
    const panels = (s.panels || []).map(panel => {
      const a = toScreen(panel.x, panel.y), b = toScreen(panel.x + panel.w, panel.y + panel.h);
      return { l: a.x - 12, t: a.y - 12, r: b.x + 12, b: b.y + 12 };
    });
    for (let y = 120; y < s.height - 60; y += 23) {
      for (let x = 40; x < s.width - 90; x += 29) {
        const onScreen = rect.top + y > 10 && rect.top + y < window.innerHeight - 10;
        const clear = s.nodes.every(n => {
          if (!n.visible) return true;
          const p = toScreen(n.x, n.y);
          return Math.hypot(p.x - x, p.y - y) > (n.type === 'repo' ? 110 : 48);
        }) && panels.every(p => x < p.l || x > p.r || y < p.t || y > p.b);
        const top = onScreen && document.elementFromPoint(rect.left + x, rect.top + y);
        if (onScreen && clear && top === s.canvas) return { x: rect.left + x, y: rect.top + y };
      }
    }
    return null;
  });
}

test('pressing a node opens its card, named for it, with its connections', async ({ page }) => {
  await openGraph(page);
  const target = await nodePoint(page, n => n.type !== 'repo');
  expect(target).not.toBeNull();
  await page.mouse.click(target.x, target.y);

  const card = page.locator('#neuralCard');
  await expect(card).toBeVisible();
  await expect(card.locator('#neuralCardTitle')).toHaveText(target.label);
  await expect(card).toHaveAttribute('role', 'dialog');
  await expect(card.locator('.neural-card-links button').first()).toBeVisible();

  /* A connection is a way to move: pressing it selects that node instead. */
  const next = await card.locator('.neural-card-links button').first().getAttribute('data-neural-goto');
  await card.locator('.neural-card-links button').first().click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.selected && window.NebulaNeural.state.selected.id)).toBe(next);

  /* And the card goes away the way a card should. */
  await card.locator('[data-neural-card-close]').click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.NebulaNeural.state.selected)).toBeNull();
});

test('dragging from a row moves the stage, keeps the node in its row, and opens nothing', async ({ page }) => {
  await openGraph(page);
  const target = await nodePoint(page, n => n.type !== 'repo');
  expect(target).not.toBeNull();
  const read = () => page.evaluate(id => {
    const s = window.NebulaNeural.state;
    const n = s.nodes.find(x => x.id === id);
    return { node: [n.x, n.y], pan: [s.panX, s.panY] };
  }, target.id);
  const before = await read();
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 50, target.y + 35, { steps: 8 });
  await page.mouse.up();
  const after = await read();
  expect(after.node).toEqual(before.node);
  expect(after.pan[0] - before.pan[0]).toBeGreaterThan(20);
  await expect(page.locator('#neuralCard')).toBeHidden();
});

test('a group panel folds past six rows and opens on "+ n more"', async ({ page }) => {
  const runs = Array.from({ length: 9 }, (_, i) => ({
    id: 700 + i, name: `Pipeline ${i + 1}`, number: i + 1, status: 'completed', conclusion: 'success',
    branch: 'main', event: 'push', created_at: new Date(Date.now() - i * 60000).toISOString()
  }));
  await openGraph(page, { runs });
  await expect.poll(() => page.evaluate(() => {
    const panel = (window.NebulaNeural.state.panels || []).find(p => p.type === 'workflow');
    return panel ? panel.members.length : 0;
  })).toBe(9);
  const folded = await page.evaluate(() => {
    const panel = window.NebulaNeural.state.panels.find(p => p.type === 'workflow');
    return { type: panel.type, total: panel.members.length, shown: panel.shown.length };
  });
  /* Five rows and a sixth that says how many more there are. */
  expect(folded.shown).toBe(5);
  const more = await page.evaluate(type => {
    const s = window.NebulaNeural.state;
    const panel = s.panels.find(p => p.type === type);
    const rect = s.canvas.getBoundingClientRect();
    return {
      x: rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom,
      y: rect.top + s.height / 2 + s.panY + panel.moreY * s.zoom
    };
  }, folded.type);
  await page.mouse.click(more.x, more.y);
  await expect.poll(() => page.evaluate(type => window.NebulaNeural.state.panels.find(p => p.type === type).shown.length, folded.type)).toBe(folded.total);
});

test('a drag on empty ground pans rather than selecting anything', async ({ page }) => {
  await openGraph(page);
  const empty = await emptyPoint(page);
  expect(empty).not.toBeNull();
  const before = await page.evaluate(() => [window.NebulaNeural.state.panX, window.NebulaNeural.state.panY]);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 40, empty.y + 25, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => [window.NebulaNeural.state.panX, window.NebulaNeural.state.panY]);
  expect(after[0] - before[0]).toBeGreaterThan(20);
  await expect(page.locator('#neuralCard')).toBeHidden();
});

test('the keyboard walks the graph and every step is announced', async ({ page }) => {
  await openGraph(page);
  await page.locator('#neuralCanvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#neuralCard')).toBeVisible();
  const first = await page.evaluate(() => window.NebulaNeural.state.selected.id);
  expect(first).toBe('repo:current');

  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key);
    const moved = await page.evaluate(() => window.NebulaNeural.state.selected && window.NebulaNeural.state.selected.id);
    if (moved && moved !== first) break;
  }
  const selected = await page.evaluate(() => window.NebulaNeural.state.selected);
  expect(selected && selected.id).not.toBe(first);
  await expect(page.locator('#neuralLive')).toContainText(selected.label);

  await page.keyboard.press('Escape');
  await expect(page.locator('#neuralCard')).toBeHidden();
});

test('each group chip names a group on screen and lights it when pressed', async ({ page }) => {
  await openGraph(page);
  const panel = page.locator('#neuralStage');
  if (!(await page.locator('#neuralLegend').isVisible())) {
    /* On a phone the chips live in the enlarged view's panel, like the filters. */
    await page.locator('#neuralExpandBtn').click();
    if (!(await panel.evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  }
  const chips = page.locator('#neuralLegend .neural-chip');
  await expect(chips.first()).toBeVisible();
  const counts = await page.evaluate(() => {
    const s = window.NebulaNeural.state;
    const byType = {};
    for (const n of s.nodes) if (n.visible && n.type !== 'repo') byType[n.type] = (byType[n.type] || 0) + 1;
    return byType;
  });
  const chipTypes = await chips.evaluateAll(nodes => nodes.map(node => [node.dataset.neuralGroup, Number(node.querySelector('b').textContent)]));
  expect(Object.fromEntries(chipTypes)).toEqual(counts);

  const chip = chips.first();
  await chip.click();
  await expect(page.locator(`#neuralLegend .neural-chip[data-neural-group="${chipTypes[0][0]}"]`)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.NebulaNeural.state.focusGroup)).toBe(chipTypes[0][0]);
});

test('pressing a panel header lights that group, and empty ground lets it go', async ({ page }) => {
  await openGraph(page);
  const header = await page.evaluate(() => {
    const s = window.NebulaNeural.state;
    const rect = s.canvas.getBoundingClientRect();
    for (const panel of s.panels || []) {
      const x = rect.left + s.width / 2 + s.panX + (panel.x + panel.w / 2) * s.zoom;
      const y = rect.top + s.height / 2 + s.panY + (panel.y + 26) * s.zoom;
      if (y > 10 && y < window.innerHeight - 10 && document.elementFromPoint(x, y) === s.canvas) return { type: panel.type, x, y };
    }
    return null;
  });
  expect(header).not.toBeNull();
  await page.mouse.click(header.x, header.y);
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.focusGroup)).toBe(header.type);
  await expect(page.locator('#neuralCard')).toBeHidden();
  const empty = await emptyPoint(page);
  expect(empty).not.toBeNull();
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.focusGroup)).toBeNull();
});

test('on a phone the card is a sheet over the page, not a strip inside the graph', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width >= 720, 'the sheet is the narrow-screen form');
  await openGraph(page);
  const target = await nodePoint(page, n => n.type !== 'repo');
  expect(target).not.toBeNull();
  await page.mouse.click(target.x, target.y);
  const card = page.locator('#neuralCard');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/is-sheet/);
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  /* Escape closes it from anywhere, not only from inside the canvas. */
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});
