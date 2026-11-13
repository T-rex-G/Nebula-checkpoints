'use strict';
/*
 * Where the Neural map puts what it draws (features/neural/graph-layout.ts):
 * the panels each group is listed in, their order and size, the columns a
 * wide stage splits them into and the one a tall stage stacks them in, groups
 * folded and paged, panels the reader moved, and each node's target.
 */
const assert = require('node:assert/strict');
const { addNode } = require('../apps/web/src/features/neural/graph-model.ts');
const L = require('../apps/web/src/features/neural/graph-layout.ts');

/* A graph of the given groups: [type, count, severity?] each, with the hub. */
function graph(groups) {
  const map = new Map();
  addNode(map, 'repo:x', 'repo', 'acme/widget');
  for (const [type, count, severity = 'normal'] of groups) {
    for (let i = 0; i < count; i++) addNode(map, `${type}:${i}`, type, `${type} ${String(i).padStart(2, '0')}`, {}, severity);
  }
  return [...map.values()];
}
const WIDE = L.layoutAspect(1280, 720);
const TALL = L.layoutAspect(390, 844);
function place(nodes, input = {}) {
  return L.placeGraph({ nodes, expanded: new Set(), pages: new Map(), totals: {}, aspect: WIDE, placed: {}, ...input });
}
const panelOf = (layout, type) => layout.byType.get(type);
const ids = list => list.map(n => n.id);

/* ---- The stage's shape ---------------------------------------------------------------- */
assert.equal(L.layoutAspect(0, 720), .8, 'a stage not yet measured is taken as wide');
assert.equal(L.layoutAspect(1000, 100), .66, 'the shape is held between a very wide stage');
assert.equal(L.layoutAspect(100, 1000), 1.55, 'and a very tall one');
assert.equal(L.layoutAspect(1000, 1000), .92);
assert.deepEqual([L.layoutModeOf(1.05), L.layoutModeOf(1.06), L.layoutModeOf(WIDE), L.layoutModeOf(TALL)], ['split', 'stack', 'split', 'stack'],
  'past 1.05 the stage is tall and the panels stack; a phone held upright stacks, a desktop splits');
assert.deepEqual([L.worldRadius({ type: 'repo' }), L.worldRadius({ type: 'commit' })], [L.HUB_R, L.NODE_R], 'the hub is drawn larger than any node');

/* ---- Two columns on a wide stage ------------------------------------------------------- */
{
  const layout = place(graph([['commit', 3], ['user', 2], ['branch', 2], ['credential', 1]]));
  assert.deepEqual(layout.panels.map(p => p.type), ['user', 'credential', 'branch', 'commit'],
    'the panels follow the groups\' order: identities and what they hold first, then the repository\'s own history');
  const left = layout.panels.filter(p => p.side === 'left').map(p => p.type);
  assert.deepEqual(left, ['user', 'credential'], 'identities and credentials on the left, the history on the right');
  for (const p of layout.panels) {
    assert.equal(p.x, p.side === 'left' ? -L.COLUMN_GAP - L.PANEL_W : L.COLUMN_GAP, `${p.type} stands in its column`);
    assert.equal(p.nodeX, p.side === 'left' ? p.x + p.w - 30 : p.x + 30, `${p.type}'s nodes stand on the edge facing the hub`);
    assert.equal(p.h, L.HEAD_H + p.rows * L.ROW_H + L.PANEL_PAD, 'a panel is as tall as its header and rows');
    assert.equal(p.placed, false);
  }
  /* Each column is centred on the hub, its panels a gap apart. */
  for (const side of ['left', 'right']) {
    const column = layout.panels.filter(p => p.side === side);
    const height = column.reduce((sum, p) => sum + p.h, 0) + L.PANEL_GAP * (column.length - 1);
    assert.equal(column[0].y, -height / 2, `the ${side} column is centred on the hub`);
    for (let i = 1; i < column.length; i++) assert.equal(column[i].y, column[i - 1].y + column[i - 1].h + L.PANEL_GAP);
  }
  const branch = panelOf(layout, 'branch');
  branch.shown.forEach((n, i) => assert.deepEqual(layout.targets.get(n), { x: branch.nodeX, y: branch.y + L.HEAD_H + i * L.ROW_H + L.ROW_H / 2, folded: false }, 'each row\'s node is placed on its row'));
  const hub = graph([]).find(n => n.type === 'repo');
  const withHub = place([hub]);
  assert.deepEqual(withHub.targets.get(hub), { x: 0, y: 0, folded: false }, 'the repository is the hub, in the middle');
  assert.equal(withHub.panels.length, 0, 'and has no panel of its own');
}

/* ---- One column on a tall stage --------------------------------------------------------- */
{
  const layout = place(graph([['commit', 2], ['user', 1], ['workflow', 1]]), { aspect: TALL });
  assert.deepEqual(layout.panels.map(p => [p.type, p.side, p.x]), [['user', 'right', 64], ['commit', 'right', 64], ['workflow', 'right', 64]],
    'every panel stacks in one column beside the spine');
  assert.equal(layout.panels[0].y, L.HUB_R + 58, 'starting below the hub');
  assert.equal(layout.panels[1].y, layout.panels[0].y + layout.panels[0].h + L.PANEL_GAP);
}

/* ---- A panel's rows ------------------------------------------------------------------------- */
{
  const nodes = graph([['commit', 4]]);
  nodes.find(n => n.id === 'commit:3').severity = 'critical';
  nodes.find(n => n.id === 'commit:1').order = 0;
  nodes.find(n => n.id === 'commit:2').order = 5;
  assert.deepEqual(ids(panelOf(place(nodes), 'commit').members), ['commit:3', 'commit:1', 'commit:2', 'commit:0'],
    'critical first, then in the source\'s own order where it has one, then by name');
}
{
  const nodes = graph([['branch', 9]]);
  const layout = place(nodes, { totals: { branch: 40 } });
  const panel = panelOf(layout, 'branch');
  assert.deepEqual([panel.shown.length, panel.footer, panel.hiddenCount, panel.rows, panel.total], [L.MAX_ROWS - 1, 'more', 9 - (L.MAX_ROWS - 1), L.MAX_ROWS, 40],
    'a group longer than six rows shows five and folds the rest behind "+ n more"; its count is the reading\'s');
  assert.equal(panel.moreY, panel.y + L.HEAD_H + panel.slots * L.ROW_H + L.ROW_H / 2, 'the footer is the row after the last shown');
  for (const n of panel.members.slice(L.MAX_ROWS - 1)) assert.deepEqual(layout.targets.get(n), { x: panel.nodeX, y: panel.moreY, folded: true }, 'what is folded waits behind the footer');
  assert.equal(panelOf(place(nodes, { totals: { branch: 2 } }), 'branch').total, 9, 'a total the graph outgrows is not said');
  const six = panelOf(place(graph([['branch', 6]])), 'branch');
  assert.deepEqual([six.shown.length, six.footer, six.rows], [6, null, 6], 'six rows fit without a footer');
  const opened = panelOf(place(graph([['branch', 6]]), { expanded: new Set(['branch']) }), 'branch');
  assert.deepEqual([opened.shown.length, opened.footer], [6, null], 'opening a group that fits changes nothing');
}
{
  const nodes = graph([['commit', 23]]);
  const at = page => place(nodes, { expanded: new Set(['commit']), pages: new Map([['commit', page]]) });
  const first = at(0);
  const panel = panelOf(first, 'commit');
  assert.deepEqual([panel.footer, panel.page, panel.pages, panel.shown.length, panel.slots], ['pager', 0, 3, L.PAGE_ROWS, L.PAGE_ROWS], 'an opened group pages ten rows at a time');
  assert.deepEqual([...first.pages], [['commit', 0]], 'and says which page it is on');
  const last = panelOf(at(2), 'commit');
  assert.deepEqual([last.shown.length, last.slots, last.h], [3, L.PAGE_ROWS, panel.h], 'the last page keeps the first page\'s height, so the panels below never move');
  assert.deepEqual(ids(last.shown), ids(panel.members.slice(20)));
  assert.deepEqual([...at(9).pages], [['commit', 2]], 'a page past the last is the last');
  assert.deepEqual([...at(-3).pages], [['commit', 0]], 'and one before the first is the first');
  const second = at(1);
  for (const n of panelOf(second, 'commit').members) {
    const onPage = panelOf(second, 'commit').shown.includes(n);
    assert.equal(second.targets.get(n).folded, !onPage, 'what is off the page waits behind the pager');
  }
  const single = panelOf(place(graph([['commit', 8]]), { expanded: new Set(['commit']) }), 'commit');
  assert.deepEqual([single.pages, single.shown.length, single.slots], [1, 8, 8], 'one page is as tall as its rows');
}

/* ---- Columns kept level ------------------------------------------------------------------- */
{
  /* Eight groups on the left, two short ones on the right: groups without a
   * natural side cross; identities and credentials never do. */
  const layout = place(graph([['user', 6], ['credential', 6], ['session', 6], ['protected', 6], ['release', 3], ['tag', 3], ['scan', 1], ['snapshot', 1], ['branch', 1]]));
  const sides = Object.fromEntries(layout.panels.map(p => [p.type, p.side]));
  for (const type of ['user', 'credential', 'session', 'protected']) assert.equal(sides[type], 'left', `${type} stays on its side`);
  assert.ok(['release', 'tag', 'scan', 'snapshot'].some(type => sides[type] === 'right'), 'a group without a natural side crosses to the shorter column');
  const height = side => {
    const column = layout.panels.filter(p => p.side === side);
    return column.reduce((sum, p) => sum + p.h, 0) + L.PANEL_GAP * Math.max(0, column.length - 1);
  };
  const before = (() => {
    const all = layout.panels.filter(p => L.LEFT_GROUPS.includes(p.type));
    return all.reduce((sum, p) => sum + p.h, 0) + L.PANEL_GAP * (all.length - 1);
  })();
  assert.ok(Math.abs(height('left') - height('right')) < before - height('right'), 'and the columns end nearer level than they began');
  const lone = place(graph([['user', 9], ['credential', 9], ['leak', 9]]));
  assert.deepEqual(lone.panels.map(p => p.side), ['left', 'left', 'left'], 'with nothing that may cross, nothing does');
  const close = place(graph([['user', 6], ['credential', 6], ['leak', 6], ['release', 1], ['branch', 6], ['commit', 6], ['workflow', 5]]));
  assert.equal(panelOf(close, 'release').side, 'left', 'columns within a tenth of each other, and sixty pixels more, are level enough');
  const settled = place(graph([['safety', 6], ['commit', 1], ['integration', 6], ['external', 4]]));
  assert.deepEqual(settled.panels.map(p => [p.type, p.side]), [['safety', 'left'], ['commit', 'right'], ['integration', 'right'], ['external', 'left']],
    'an outside service crosses to the shorter column, and stays where that leaves the columns nearest level');
  const level = place(graph([['user', 2], ['branch', 2], ['release', 1]]));
  assert.equal(panelOf(level, 'release').side, 'left', 'a move that would leave the columns no nearer level is not made');
}

/* ---- Panels the reader moved --------------------------------------------------------------------- */
{
  const nodes = graph([['branch', 2], ['user', 1]]);
  const moved = place(nodes, { placed: { branch: { x: -500, y: 40 } } });
  const branch = panelOf(moved, 'branch');
  assert.deepEqual([branch.x, branch.y, branch.placed, branch.side], [-500, 40, true, 'left'], 'a moved panel stands where it was put, and faces the hub from there');
  assert.equal(branch.nodeX, -500 + L.PANEL_W - 30);
  assert.deepEqual(moved.targets.get(branch.shown[0]), { x: branch.nodeX, y: 40 + L.HEAD_H + L.ROW_H / 2, folded: false }, 'its rows go with it');
  const across = panelOf(place(nodes, { placed: { user: { x: 200, y: 0 } } }), 'user');
  assert.equal(across.side, 'right', 'an identity moved past the hub faces it from the right');
  const tall = panelOf(place(nodes, { aspect: TALL, placed: { branch: { x: -400, y: 300 } } }), 'branch');
  assert.equal(tall.side, 'left', 'on a tall stage a panel moved left of the spine faces it from the left');
  for (const bad of [{ x: 'a', y: 3 }, { x: NaN, y: 2 }, { x: Infinity, y: 0 }, { x: 4 }, null, { y: 9 }]) {
    const panel = panelOf(place(nodes, { placed: { branch: bad } }), 'branch');
    assert.deepEqual([panel.placed, panel.x], [false, L.COLUMN_GAP], `${JSON.stringify(bad)} is no place`);
  }
}

/* ---- What is drawn, and what is not ------------------------------------------------------------- */
{
  const nodes = graph([['commit', 3], ['user', 1]]);
  nodes.find(n => n.id === 'commit:1').visible = false;
  nodes.find(n => n.id === 'user:0').visible = false;
  const layout = place(nodes);
  assert.deepEqual(layout.panels.map(p => p.type), ['commit'], 'a group with nothing visible has no panel');
  assert.deepEqual(ids(panelOf(layout, 'commit').members), ['commit:0', 'commit:2'], 'and a hidden node is in none');
  assert.equal(layout.targets.has(nodes.find(n => n.id === 'commit:1')), false, 'nor given a place');
  assert.equal(layout.byType.get('commit'), layout.panels[0]);
}

/* ---- The whole picture ---------------------------------------------------------------------------- */
assert.deepEqual(L.layoutBounds([]), { minX: -L.HUB_R - 36, minY: -L.HUB_R - 46, maxX: L.HUB_R + 36, maxY: L.HUB_R + 66 }, 'the hub alone, with room around it');
assert.deepEqual(L.layoutBounds([{ x: -700, y: -300, w: 272, h: 900 }, { x: 300, y: -50, w: 272, h: 100 }]), { minX: -716, minY: -316, maxX: 588, maxY: 616 },
  'every panel inside the bounds, with a margin');

console.log('neural graph layout: ok');
