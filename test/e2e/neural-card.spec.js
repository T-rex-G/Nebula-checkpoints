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

async function openGraph(page, { runs, refs } = {}) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  if (runs) {
    await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/actions', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runs) }));
  }
  if (refs) {
    await page.route(url => new URL(url).pathname === '/api/repo/sandbox/demo/refs-snapshot', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refs) }));
  }
  await page.goto('/#/sandbox/demo@main/neural');
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => (window.NebulaNeural ? window.NebulaNeural.state.nodes.filter(n => n.visible).length : 0))).toBeGreaterThan(2);
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

/* The groups list: in the rail on a wide screen, in the enlarged view's panel
 * on a phone. */
async function openGroups(page) {
  if (await page.locator('#neuralLegend').isVisible()) return;
  await page.locator('#neuralExpandBtn').click();
  const stage = page.locator('#neuralStage');
  if (!(await stage.evaluate(node => node.classList.contains('panel-open')))) await page.locator('#neuralPanelBtn').click();
  await expect(page.locator('#neuralLegend')).toBeVisible();
}

/* Where a panel's footer control is on the page: dx from the panel's left
 * edge, or from its right edge when negative. */
async function footerPoint(page, type, dx) {
  return page.evaluate(([kind, offset]) => {
    const s = window.NebulaNeural.state;
    const panel = s.panels.find(p => p.type === kind);
    if (!panel || panel.moreY == null) return null;
    const rect = s.canvas.getBoundingClientRect();
    const x = offset < 0 ? panel.x + panel.w + offset : panel.x + offset;
    return { x: rect.left + s.width / 2 + s.panX + x * s.zoom, y: rect.top + s.height / 2 + s.panY + panel.moreY * s.zoom };
  }, [type, dx]);
}
/* Brings a panel to the middle of the stage (test set-up: on a phone the
 * enlarged graph opens at the top of a long column). */
async function centrePanel(page, type) {
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
  await page.evaluate(kind => {
    const s = window.NebulaNeural.state;
    const panel = s.panels.find(p => p.type === kind);
    s.panX = -(panel.x + panel.w / 2) * s.zoom;
    s.panY = -(panel.y + panel.h / 2) * s.zoom;
  }, type);
}
const workflowRuns = count => Array.from({ length: count }, (_, i) => ({
  id: 700 + i, name: `Pipeline ${String(i + 1).padStart(2, '0')}`, number: i + 1, status: 'completed', conclusion: 'success',
  branch: 'main', event: 'push', created_at: new Date(Date.now() - i * 60000).toISOString()
}));

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
  await openGraph(page, { runs: workflowRuns(9) });
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
  /* Measure where the sheet rests, not where its entrance starts: it slides
   * up 24px as it opens, and a slow machine can read it mid-slide. */
  await expect.poll(() => card.evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
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

test('an opened group pages ten rows at a time, and a node on another page opens that page', async ({ page }) => {
  const refs = { defaultBranch: 'main', refs: [{ name: 'main', sha: 'c'.repeat(40), protected: false }], tags: [] };
  await openGraph(page, { runs: workflowRuns(14), refs });
  /* Enlarged, the whole stage is on screen, footer controls included. The
   * enlarged stage re-lays the graph for its new shape; wait for that. */
  await page.locator('#neuralExpandBtn').click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.width > window.innerWidth * .95)).toBe(true);
  /* The re-layout runs a moment after the resize settles. */
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => (window.NebulaNeural.state.panels.find(p => p.type === 'workflow') || { members: [] }).members.length)).toBe(14);
  const read = () => page.evaluate(() => {
    const p = window.NebulaNeural.state.panels.find(q => q.type === 'workflow');
    return { footer: p.footer, page: p.page, pages: p.pages, shown: p.shown.map(n => n.label), h: p.h };
  });
  expect((await read()).footer).toBe('more');
  await centrePanel(page, 'workflow');
  const more = await footerPoint(page, 'workflow', 60);
  await page.mouse.click(more.x, more.y);
  await expect.poll(async () => (await read()).pages).toBe(2);
  const first = await read();
  expect(first.shown).toHaveLength(10);
  /* Newest first: the runs keep the order the provider gave them. */
  expect(first.shown[0]).toBe('Pipeline 01');
  expect(first.shown[9]).toBe('Pipeline 10');
  await centrePanel(page, 'workflow');
  const next = await footerPoint(page, 'workflow', -26);
  await page.mouse.click(next.x, next.y);
  await expect.poll(async () => (await read()).page).toBe(1);
  const second = await read();
  expect(second.shown).toEqual(['Pipeline 11', 'Pipeline 12', 'Pipeline 13', 'Pipeline 14']);
  /* A short last page is as tall as the first, so nothing below it moves. */
  expect(second.h).toBe(first.h);
  await expect(page.locator('#neuralLive')).toContainText('11 to 14 of 14');

  /* A connection to a run on the other page turns to it. */
  await centrePanel(page, 'branch');
  const main = await nodePoint(page, n => n.id === 'branch:main');
  expect(main).not.toBeNull();
  await page.mouse.click(main.x, main.y);
  const link = page.locator('#neuralCard [data-neural-goto="workflow:702"]');
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.selected && window.NebulaNeural.state.selected.id)).toBe('workflow:702');
  expect((await read()).page).toBe(0);

  /* Page Down turns the selected node's group, and the selection keeps its row. */
  await page.locator('#neuralCanvas').focus();
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await read()).page).toBe(1);
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.selected && window.NebulaNeural.state.selected.label)).toBe('Pipeline 13');
});

test('the eye hides a group from the graph and the list keeps it to bring back', async ({ page }) => {
  await openGraph(page);
  await openGroups(page);
  const visibleTypes = () => page.evaluate(() => window.NebulaNeural.state.panels.map(p => p.type));
  const type = (await visibleTypes())[0];
  const eye = page.locator(`#neuralLegend [data-neural-toggle="${type}"]`);
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await eye.click();
  await expect.poll(visibleTypes).not.toContain(type);
  expect(await page.evaluate(t => window.NebulaNeural.state.nodes.some(n => n.type === t && n.visible), type)).toBe(false);
  await expect(page.locator(`#neuralLegend [data-neural-toggle="${type}"]`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`#neuralLegend .neural-group-row.is-hidden [data-neural-group="${type}"]`)).toBeVisible();
  /* Remembered in this browser, and "Show all" undoes it. */
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('nv_neural_hidden_groups')))).toEqual([type]);
  await page.locator('#neuralLegend [data-neural-groups="show"]').click();
  await expect.poll(visibleTypes).toContain(type);
  expect(await page.evaluate(() => localStorage.getItem('nv_neural_hidden_groups'))).toBeNull();
});

test('a repository with more branches than the graph holds says so', async ({ page }) => {
  const names = Array.from({ length: 80 }, (_, i) => `feature/${String(i).padStart(3, '0')}`);
  const refs = {
    defaultBranch: 'main',
    refs: [...names.map(name => ({ name, sha: 'a'.repeat(40) })), { name: 'main', sha: 'b'.repeat(40), protected: true }],
    tags: []
  };
  await openGraph(page, { refs });
  await expect.poll(() => page.evaluate(() => {
    const p = window.NebulaNeural.state.panels.find(q => q.type === 'branch');
    return p ? [p.members.length, p.total] : null;
  })).toEqual([60, 81]);
  /* The default branch leads, however the provider sorted the list. */
  expect(await page.evaluate(() => window.NebulaNeural.state.panels.find(q => q.type === 'branch').members[0].label)).toBe('main');
  await openGroups(page);
  await expect(page.locator('#neuralLegend [data-neural-group="branch"] small')).toHaveText('of 81');
});

test('a resting graph is not redrawn, and the effects layer never takes a press', async ({ page }) => {
  await openGraph(page);
  await page.locator('#neuralPlayBtn').click();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.paused)).toBe(true);
  /* Let anything still easing finish, then watch. */
  await expect.poll(() => page.evaluate(() => {
    const s = window.NebulaNeural.state;
    return !s.camTarget && s.nodes.every(n => !n.visible || (Math.abs(n.tx - n.x) <= .25 && Math.abs(n.ty - n.y) <= .25 && (n.appear ?? 1) >= 1));
  })).toBe(true);
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.NebulaNeural.state.frames);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.NebulaNeural.state.frames)).toBe(before);
  const fx = await page.evaluate(() => {
    const s = window.NebulaNeural.state;
    const r = s.canvas.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { pointer: getComputedStyle(document.getElementById('neuralFx')).pointerEvents, hitIsFx: hit && hit.id === 'neuralFx' };
  });
  expect(fx).toEqual({ pointer: 'none', hitIsFx: false });
});

test('zoomed in, a minimap shows the whole graph and moves the stage when pressed', async ({ page }) => {
  test.skip((page.viewportSize() || {}).width < 720, 'the minimap is for stages wide enough to hold it');
  await openGraph(page);
  await page.locator('#neuralExpandBtn').click();
  const minimap = page.locator('#neuralMinimap');
  for (let i = 0; i < 4; i++) await page.locator('#neuralZoomInBtn').click();
  await expect(minimap).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.camTarget)).toBeNull();
  const before = await page.evaluate(() => [window.NebulaNeural.state.panX, window.NebulaNeural.state.panY]);
  const box = await minimap.boundingBox();
  await page.mouse.click(box.x + 8, box.y + 8);
  const after = await page.evaluate(() => [window.NebulaNeural.state.panX, window.NebulaNeural.state.panY]);
  expect(after).not.toEqual(before);
  /* Back to the whole picture, the minimap has nothing to add and goes. */
  await page.locator('#neuralFitBtn').click();
  await expect(minimap).toBeHidden();
});

test('a search keeps the hub in view and selects the first match', async ({ page }) => {
  await openGraph(page, { runs: workflowRuns(14) });
  await page.locator('#neuralSearch').fill('Pipeline 12');
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.selected && window.NebulaNeural.state.selected.id)).toBe('workflow:711');
  const state = await page.evaluate(() => {
    const s = window.NebulaNeural.state;
    return { hub: s.nodes.some(n => n.type === 'repo' && n.visible), others: s.nodes.filter(n => n.visible && n.type !== 'repo').map(n => n.label) };
  });
  expect(state).toEqual({ hub: true, others: ['Pipeline 12'] });
  await page.locator('#neuralSearch').fill('');
  await expect.poll(() => page.evaluate(() => window.NebulaNeural.state.nodes.filter(n => n.visible && n.type === 'workflow').length)).toBe(14);
});
