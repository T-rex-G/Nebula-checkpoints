'use strict';
/*
 * How the Neural map is drawn (features/neural: graph-paint, graph-scene,
 * graph-field, graph-strands, graph-renderer), asked on a recording canvas:
 * the palettes, the camera, what stays lit, the ground, the strands and their
 * signals, the panels, nodes and hub, and the minimap.
 */
const assert = require('node:assert/strict');
const { recordingCanvas } = require('./helpers/recording-canvas');
const { addNode, addEdge } = require('../apps/web/src/features/neural/graph-model.ts');
const L = require('../apps/web/src/features/neural/graph-layout.ts');
const P = require('../apps/web/src/features/neural/graph-paint.ts');
const S = require('../apps/web/src/features/neural/graph-scene.ts');
const F = require('../apps/web/src/features/neural/graph-field.ts');
const T = require('../apps/web/src/features/neural/graph-strands.ts');
const R = require('../apps/web/src/features/neural/graph-renderer.ts');

delete globalThis.Path2D;
/* The signals' sprites are drawn on canvases of their own. */
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return recordingCanvas().ctx; } };
const DARK = P.paletteFor('nebula', 'dark');
const LIGHT = P.paletteFor('nebula', 'light');
const EVERYWHERE = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };

function scene(nodes, extra = {}) {
  return {
    width: 1280, height: 720, dpr: 1, zoom: 1, panX: 0, panY: 0, nodes, edges: [], panels: [], panelByType: new Map(),
    layoutMode: 'split', selected: null, hover: null, focusGroup: null, highlightNodes: new Set(), highlightEdges: new Set(),
    interacting: false, ...extra
  };
}
/* A laid-out graph: [type, count, severity?] each, with the hub, every node at its target. */
function laidOut(groups, input = {}) {
  const map = new Map();
  addNode(map, 'repo:x', 'repo', 'acme/widget');
  for (const [type, count, severity = 'normal'] of groups) {
    for (let i = 0; i < count; i++) addNode(map, `${type}:${i}`, type, `${type} ${i}`, {}, severity);
  }
  const nodes = [...map.values()];
  const aspect = input.aspect ?? L.layoutAspect(1280, 720);
  const layout = L.placeGraph({ nodes, expanded: new Set(), pages: new Map(), totals: {}, aspect, placed: {}, ...input });
  for (const [n, t] of layout.targets) { n.tx = t.x; n.ty = t.y; n.folded = t.folded; n.x = t.x; n.y = t.y; }
  return scene(nodes, { panels: layout.panels, panelByType: layout.byType, layoutMode: L.layoutModeOf(aspect) });
}
const hubOf = s => s.nodes.find(n => n.type === 'repo');
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} against ${b}`);
const at = (p, q, message) => { close(p.x, q.x, `${message} (x)`); close(p.y, q.y, `${message} (y)`); };

/* ---- Palettes ---------------------------------------------------------------------------- */
{
  const themes = [['nebula', 'dark'], ['nebula', 'light'], ['obsidian', 'dark'], ['obsidian', 'light']].map(([d, t]) => P.paletteFor(d, t));
  assert.deepEqual(themes.map(c => [c.theme, c.light, c.glow]), [['nebula-dark', false, true], ['nebula-light', true, false], ['obsidian-dark', false, true], ['obsidian-light', true, false]],
    'each preset in each theme names itself, and only the dark grounds glow');
  assert.equal(DARK.ink('#8B5CF6'), '#8B5CF6', 'on a dark ground a group\'s colour is its ink');
  assert.equal(LIGHT.ink('#8B5CF6'), 'rgb(100,66,177)', 'on a light ground it is darkened into contrast');
  assert.deepEqual([LIGHT.ink('#E2E8F0'), themes[3].ink('#E2E8F0')], ['#475569', '#57534e'], 'a near-white colour is drawn in slate instead');
  close(P.luminanceOf('#ffffff'), 1, 'white is as light as a colour gets');
  assert.deepEqual([P.luminanceOf('#000000'), P.luminanceOf('teal')], [0, 0], 'black, and a colour it cannot read, are dark');
  assert.equal(P.darken('#808080', .5), 'rgb(64,64,64)');
  assert.equal(P.darken('#fff', .5), 'rgb(128,128,128)', 'three-digit colours too');
  assert.equal(P.hexAlpha('violet', .5), 'violet', 'a colour it cannot read is left as it is');
}

/* ---- The camera and what is in view --------------------------------------------------------- */
{
  const camera = { width: 800, height: 600, dpr: 2, zoom: 2, panX: 30, panY: -20 };
  assert.deepEqual(S.worldToScreen(camera, 0, 0), { x: 430, y: 280 }, 'the world\'s origin is the stage\'s centre, panned');
  assert.deepEqual(S.worldToScreen(camera, 10, 5), { x: 450, y: 290 }, 'scaled by the zoom');
  const back = S.screenToWorld(camera, 450, 290);
  assert.deepEqual(back, { x: 10, y: 5 }, 'and read back');
  assert.deepEqual(S.worldView(camera), { minX: -235, minY: -160, maxX: 205, maxY: 180 }, 'the view reaches 40 pixels past each edge');
  assert.equal(S.inView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 10, 10, 20, 20), true, 'touching counts');
  assert.equal(S.inView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 11, 0, 20, 5), false);
  const curve = { start: { x: 20, y: 0 }, c1: { x: 22, y: 0 }, c2: { x: 23, y: 0 }, end: { x: 24, y: 0 } };
  assert.equal(S.curveInView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, curve), true, 'a curve counts within 14 units of the view');
  assert.equal(S.curveInView({ minX: 0, minY: 0, maxX: 5, maxY: 10 }, curve), false);
  const canvas = recordingCanvas();
  S.worldSpace(canvas.ctx, camera);
  S.screenSpace(canvas.ctx, camera);
  assert.deepEqual(canvas.named('setTransform').map(c => c.args), [[4, 0, 0, 4, 860, 560], [2, 0, 0, 2, 0, 0]], 'world space scales by zoom and pixel ratio; screen space by the ratio alone');
  assert.equal(S.hashCode(''), 2166136261);
  assert.equal(S.hashCode('commit:1'), S.hashCode('commit:1'), 'a node\'s seed is fixed');
  assert.notEqual(S.hashCode('commit:1'), S.hashCode('commit:2'));
}

/* ---- What stays lit --------------------------------------------------------------------------- */
{
  const map = new Map();
  for (const id of ['repo:x', 'a', 'b', 'c']) addNode(map, id, id === 'repo:x' ? 'repo' : 'commit', id);
  addNode(map, 'u', 'user', 'u');
  const nodes = [...map.values()];
  const edges = [];
  addEdge(edges, 'a', 'b'); addEdge(edges, 'b', 'c'); addEdge(edges, 'a', 'u');
  for (const e of edges) e.visible = true;
  edges[2].visible = false;
  const s = scene(nodes, { edges });
  const at = id => nodes.find(n => n.id === id);
  assert.equal(S.focusSets(s), null, 'nothing chosen, nothing dimmed');
  assert.deepEqual([...S.focusSets({ ...s, hover: at('b') }).nodes].sort(), ['a', 'b', 'c'], 'a hovered node lights its neighbourhood');
  assert.deepEqual([...S.focusSets({ ...s, selected: at('a'), hover: at('c') }).nodes].sort(), ['a', 'b'], 'a selection outranks the hover, and a hidden relation lights nothing');
  const group = S.focusSets({ ...s, focusGroup: 'commit', hover: at('u') });
  assert.deepEqual([...group.nodes].sort(), ['a', 'b', 'c', 'repo:x'], 'a group chosen from the legend lights its members and the hub, whatever is hovered');
  assert.deepEqual([...group.edges].sort(), [edges[0].id, edges[1].id].sort());
  const path = S.focusSets({ ...s, selected: at('a'), highlightNodes: new Set(['c']), highlightEdges: new Set(['x']) });
  assert.deepEqual([[...path.nodes], [...path.edges]], [['c'], ['x']], 'an explained path outranks everything');
}

/* ---- The strands -------------------------------------------------------------------------------- */
{
  const wide = laidOut([['commit', 3], ['user', 2]]);
  const hub = hubOf(wide);
  for (const n of wide.nodes.filter(x => x.type !== 'repo')) {
    const geo = T.fiberGeometry(wide, hub, n);
    const sign = n.x >= hub.x ? 1 : -1;
    close(Math.hypot(geo.branch.start.x - hub.x, geo.branch.start.y - hub.y), L.HUB_R * .96, `${n.id} leaves the hub's rim`);
    assert.deepEqual(geo.branch.end, { x: n.x - sign * L.NODE_R, y: n.y }, `${n.id} arrives at its node's edge facing the hub`);
    assert.equal(geo.branch.c1.y, geo.branch.start.y, 'leaving level');
    assert.equal(geo.branch.c2.y, geo.branch.end.y, 'and arriving level');
    assert.equal(geo.segs.length, 1);
  }
  const tall = laidOut([['commit', 3], ['user', 2]], { aspect: 1.5 });
  const tallHub = hubOf(tall);
  const below = tall.nodes.find(n => n.id === 'commit:2');
  const geo = T.fiberGeometry(tall, tallHub, below);
  assert.equal(geo.segs.length, 2, 'on a tall stage a strand runs down the spine, then branches');
  assert.equal(geo.spine.rim.x, tallHub.x, 'the spine leaves the hub on its centre line');
  close(geo.spine.rim.y, tallHub.y + L.HUB_R * .98, 'from the bottom of the rim');
  assert.ok(geo.spine.bendY >= geo.spine.rim.y + 8, 'and branches below it');
  assert.equal(geo.tail.length, 1, 'the branch alone is the strand\'s tail');
  const placed = laidOut([['commit', 2]], { placed: { commit: { x: -700, y: 0 } } });
  const moved = placed.nodes.find(n => n.id === 'commit:0');
  const toPlaced = T.fiberGeometry(placed, hubOf(placed), moved);
  assert.equal(placed.panelByType.get('commit').side, 'left');
  assert.deepEqual(toPlaced.branch.end, { x: moved.x + L.NODE_R, y: moved.y }, 'a strand to a moved panel arrives from the side its rows face');
  close(Math.hypot(toPlaced.branch.start.x, toPlaced.branch.start.y), L.HUB_R * .96, 'leaving the rim toward it');
  /* Measured, a route can be walked from end to end. */
  const route = T.measurePath([{ line: [{ x: 0, y: 0 }, { x: 0, y: 30 }] }, { cubic: { start: { x: 0, y: 30 }, c1: { x: 0, y: 40 }, c2: { x: 10, y: 50 }, end: { x: 40, y: 50 } } }]);
  assert.equal(route.segs[0].len, 30);
  assert.ok(route.total > 30 + 40 && route.total < 30 + 60);
  at(T.pathPoint(route, 0), { x: 0, y: 0 }, 'a route begins where it leaves');
  at(T.pathPoint(route, 1), { x: 40, y: 50 }, 'and ends at its node');
  at(T.pathPoint(route, 7), { x: 40, y: 50 }, 'a step past the end stays at the end');
  at(T.pathPoint(route, 30 / route.total / 2), { x: 0, y: 15 }, 'the spine is walked at an even pace');
  assert.equal(T.measurePath([{ line: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }]).total, 1, 'a route of no length is still a route');
  assert.deepEqual(T.cubicPoint({ start: { x: 0, y: 0 }, c1: { x: 0, y: 10 }, c2: { x: 10, y: 10 }, end: { x: 10, y: 0 } }, .5), { x: 5, y: 7.5 });
}
{
  const s = laidOut([['commit', 2], ['user', 1]]);
  s.nodes.find(n => n.id === 'commit:1').visible = false;
  const canvas = recordingCanvas();
  T.drawFibers(canvas.ctx, s, DARK, null, hubOf(s), EVERYWHERE);
  const drawn = s.nodes.filter(n => n.curve);
  assert.deepEqual(drawn.map(n => n.id).sort(), ['commit:0', 'user:0'], 'a strand for every visible member, none for the hub or a hidden node');
  for (const n of drawn) assert.ok(n.path && n.path.total > 0 && n.onView === true && n.tail === null, `${n.id} keeps its route for the signals`);
  assert.equal(canvas.named('bezierCurveTo').length, 2 * 4, 'glowing, each strand is a glow, a line and two fine threads');
  assert.equal(canvas.written('globalCompositeOperation')[0], 'lighter');
  const still = recordingCanvas();
  T.drawFibers(still.ctx, { ...s, interacting: true }, LIGHT, null, hubOf(s), EVERYWHERE);
  assert.equal(still.named('bezierCurveTo').length, 2, 'on a light ground while moving: one line each, no glow, no threads');
  const far = recordingCanvas();
  T.drawFibers(far.ctx, { ...s, zoom: .4 }, LIGHT, null, hubOf(s), EVERYWHERE);
  assert.equal(far.named('bezierCurveTo').length, 2, 'zoomed far out, no threads');
  /* A selection lights its strand when it is joined to the hub, as a reader is to the repository. */
  const joined = [];
  addEdge(joined, 'user:0', 'repo:x', 'authenticated access');
  joined[0].visible = true;
  const focus = S.focusSets({ ...s, selected: s.nodes.find(n => n.id === 'user:0'), edges: joined });
  const lit = recordingCanvas();
  T.drawFibers(lit.ctx, s, LIGHT, focus, hubOf(s), EVERYWHERE);
  const widths = lit.named('stroke').map(c => c.state.lineWidth);
  assert.ok(widths.includes(2) && widths.includes(1.3), 'a selection lights its own strand and leaves the rest thin');
  const offscreen = recordingCanvas();
  T.drawFibers(offscreen.ctx, s, DARK, null, hubOf(s), { minX: 1e4, minY: 1e4, maxX: 2e4, maxY: 2e4 });
  assert.equal(offscreen.named('bezierCurveTo').length, 0, 'a strand off the stage is not drawn');
  assert.ok(s.nodes.filter(n => n.curve).every(n => n.onView === false), 'and says so to the signals');
}
{
  const tall = laidOut([['commit', 3], ['user', 2]], { aspect: 1.5 });
  const canvas = recordingCanvas();
  T.drawFibers(canvas.ctx, tall, DARK, null, hubOf(tall), EVERYWHERE);
  assert.equal(canvas.named('lineTo').length, 3, 'a tall stage draws one spine down from the hub and a band for each of its two groups');
  assert.ok(tall.nodes.filter(n => n.curve).every(n => n.tail && n.tail.total < n.path.total), 'each row\'s signal can run its branch alone');
  /* Signals: one along each strand, two along a lit one; a dimmed strand none. */
  const before = recordingCanvas();
  T.drawSignals(before.ctx, tall, 1000, DARK, null, hubOf(tall));
  assert.equal(before.named('drawImage').length, 5, 'one signal on every strand');
  const toHub = [];
  addEdge(toHub, 'commit:0', 'repo:x', 'in');
  toHub[0].visible = true;
  const focus = S.focusSets({ ...tall, edges: toHub, selected: tall.nodes.find(n => n.id === 'commit:0') });
  const chosen = recordingCanvas();
  T.drawSignals(chosen.ctx, tall, 1000, DARK, focus, hubOf(tall));
  assert.equal(chosen.named('drawImage').length, 2, 'with a node chosen, its two signals and nothing on the dimmed strands');
  const sizes = chosen.named('drawImage').map(c => c.args[3]);
  assert.deepEqual(sizes, [14, 14], 'drawn larger');
}
{
  const s = laidOut([['commit', 3], ['workflow', 1]]);
  const edges = [];
  addEdge(edges, 'commit:0', 'workflow:0', 'ran', 'critical');
  addEdge(edges, 'commit:1', 'repo:x', 'in');
  addEdge(edges, 'commit:2', 'workflow:0', 'ran');
  for (const e of edges) e.visible = true;
  const withEdges = { ...s, edges };
  const quiet = recordingCanvas();
  T.drawRelations(quiet.ctx, withEdges, 0, DARK, null, true);
  assert.equal(quiet.calls.length, 0, 'relations are drawn only for what is in focus');
  const focus = { nodes: new Set(), edges: new Set(edges.map(e => e.id)) };
  const shown = recordingCanvas();
  T.drawRelations(shown.ctx, withEdges, 1000, DARK, focus, true);
  assert.equal(shown.named('bezierCurveTo').length, 2, 'between members only: never to the hub');
  assert.deepEqual(shown.written('strokeStyle'), ['#F43F6E', '#a78bfa'], 'a critical relation in red');
  assert.deepEqual(shown.named('setLineDash').map(c => c.args[0]), [[6, 7], [], [6, 7], []], 'dashed and moving while animated');
  const held = recordingCanvas();
  T.drawRelations(held.ctx, withEdges, 1000, DARK, focus, false);
  assert.deepEqual(held.named('setLineDash').map(c => c.args[0]), [[], []], 'solid when motion is held');
}

/* ---- Panels, nodes and the hub ---------------------------------------------------------------- */
{
  const canvas = recordingCanvas();
  canvas.ctx.font = "500 13px 'Public Sans Variable', system-ui, sans-serif";
  assert.equal(R.fitText(canvas.ctx, 'short', 200), 'short');
  const long = 'a label far too long for the width it is given';
  const fitted = R.fitText(canvas.ctx, long, 120);
  assert.ok(fitted.endsWith('…') && fitted.length < long.length, 'a label too long ends in an ellipsis');
  assert.ok(canvas.ctx.measureText(fitted).width <= 120, 'and fits');
  const measured = canvas.calls.length;
  R.forgetFittedText();
  const again = recordingCanvas();
  again.ctx.font = canvas.ctx.font;
  assert.equal(R.fitText(again.ctx, long, 120), fitted, 'fitted again the same once forgotten');
  assert.equal(measured, canvas.calls.length);
  const fallback = recordingCanvas({ roundRect: false });
  R.roundRect(fallback.ctx, 0, 0, 40, 20, 5);
  assert.equal(fallback.named('arcTo').length, 4, 'a canvas without roundRect gets four rounded corners');
}
{
  const s = laidOut([['commit', 9], ['user', 1]], { totals: { commit: 40 } });
  const canvas = recordingCanvas();
  R.drawPanels(canvas.ctx, s, DARK, null, EVERYWHERE);
  const texts = canvas.named('fillText').map(c => c.args[0]);
  assert.ok(texts.includes('9/40'), 'a group the repository has more of says so in its pill');
  assert.ok(texts.includes('COMMITS') && texts.includes('IDENTITIES'), 'each panel is named in capitals');
  assert.ok(texts.includes('+ 4 more'), 'a folded group says how many it folds');
  assert.equal(canvas.named('fillText').filter(c => /^commit \d$/.test(c.args[0])).length, 5, 'and lists the rest');
  const left = canvas.named('fillText').find(c => c.args[0] === 'user 0');
  assert.equal(left.state.textAlign, 'right', 'a row on the left is set against the edge facing the hub');
  const user = s.panelByType.get('user');
  assert.equal(left.args[1], user.x + user.w - 58);
}
{
  const s = laidOut([['commit', 23]], { expanded: new Set(['commit']), pages: new Map([['commit', 1]]) });
  const canvas = recordingCanvas();
  R.drawPanels(canvas.ctx, s, LIGHT, null, EVERYWHERE);
  const texts = canvas.named('fillText').map(c => c.args[0]);
  assert.ok(texts.includes('Show fewer') && texts.includes('11–20 of 23'), 'an opened group pages, and says which rows are shown');
  const first = laidOut([['commit', 23]], { expanded: new Set(['commit']) });
  const firstCanvas = recordingCanvas();
  R.drawPanels(firstCanvas.ctx, first, LIGHT, null, EVERYWHERE);
  const alphas = firstCanvas.calls.filter(c => c.set === 'globalAlpha').map(c => c.value);
  assert.ok(alphas.includes(.3), 'on its first page, the way back is faint');
  const focused = S.focusSets({ ...s, focusGroup: 'user' });
  const dimmed = recordingCanvas();
  R.drawPanels(dimmed.ctx, s, LIGHT, focused, EVERYWHERE);
  assert.equal(dimmed.written('globalAlpha')[0], .4, 'a panel outside the focus is dimmed');
}
{
  const map = new Map();
  const n = addNode(map, 'leak:1', 'leak', 'key', {}, 'critical');
  const s = scene([n], { selected: n });
  const canvas = recordingCanvas();
  R.drawNode(canvas.ctx, s, n, false, DARK);
  const arcs = canvas.named('arc');
  const radius = L.NODE_R * 1.12;
  assert.equal(arcs[0].args[2], radius, 'a selected node is drawn larger');
  assert.ok(arcs.some(c => c.args[2] === radius + 5), 'with a ring around it');
  assert.equal(canvas.named('fillRect').length, 2, 'a critical node\'s badge carries an exclamation mark');
  const warning = recordingCanvas();
  R.drawNode(warning.ctx, scene([]), { ...n, severity: 'warning' }, false, DARK);
  assert.equal(warning.named('fillRect').length, 0, 'a warning\'s badge has none');
  const arriving = recordingCanvas();
  R.drawNode(arriving.ctx, scene([]), { ...n, severity: 'normal', appear: 0 }, true, DARK);
  assert.equal(arriving.named('arc')[0].args[2], L.NODE_R * .55, 'a node arriving grows from half its size');
  assert.equal(arriving.written('globalAlpha')[0], 0, 'and from nothing');
}
{
  const split = laidOut([['commit', 1]]);
  const tall = laidOut([['commit', 1]], { aspect: 1.5 });
  for (const [s, below] of [[split, true], [tall, false]]) {
    const canvas = recordingCanvas();
    R.drawHub(canvas.ctx, s, hubOf(s), DARK, false);
    const name = canvas.named('fillText').find(c => c.args[0] === 'acme/widget');
    assert.equal(name.args[2] > hubOf(s).y, below, below ? 'the repository is named under the hub' : 'and above it where the spine runs down');
  }
}

/* ---- The layers ----------------------------------------------------------------------------------- */
{
  const s = laidOut([['commit', 2, 'critical']]);
  const plain = recordingCanvas();
  R.drawStatic(plain.ctx, s, DARK, null, hubOf(s), S.worldView(s), false);
  const ground = recordingCanvas();
  R.drawStatic(ground.ctx, s, DARK, null, hubOf(s), S.worldView(s), true);
  assert.equal(plain.named('fillRect').length + 400 < ground.named('fillRect').length, true, 'without the field\'s canvas the graph keeps its dot grid');
  assert.equal(plain.named('setLineDash')[0].args[0].join(), '2,7', 'the hub\'s rings are dotted');
  const breath = recordingCanvas();
  R.drawAnimated(breath.ctx, s, 500, DARK, null, hubOf(s), S.worldView(s), true);
  const rings = breath.named('arc').filter(c => c.args[2] > L.NODE_R * 1.19 && c.args[2] < L.NODE_R * 2.11);
  assert.equal(rings.length, 2, 'each critical node breathes');
  const turning = breath.named('arc').filter(c => Math.abs(c.args[2] - L.HUB_R * 1.18) < 1e-9 || Math.abs(c.args[2] - L.HUB_R * 1.7) < 1e-9);
  assert.equal(turning.length, 4, 'and the hub\'s arcs turn');
  const held = recordingCanvas();
  R.drawAnimated(held.ctx, s, 500, DARK, null, hubOf(s), S.worldView(s), false);
  assert.equal(held.calls.length, 0, 'with motion held nothing moves');
}
{
  const s = laidOut([['commit', 9], ['user', 6], ['branch', 6]]);
  const near = { ...s, zoom: .3 };
  assert.equal(R.overflows(near), false, 'zoomed out, the whole picture is on the stage');
  const close2 = { ...s, zoom: 2.5 };
  assert.equal(R.overflows(close2), true, 'zoomed in, it is not');
  const canvas = recordingCanvas();
  const map = R.drawMinimap(canvas.ctx, close2, DARK, 156, 108);
  const bounds = L.layoutBounds(s.panels);
  assert.ok(map.scale * (bounds.maxX - bounds.minX) <= 136 + 1e-9 && map.scale * (bounds.maxY - bounds.minY) <= 88 + 1e-9, 'the minimap holds the whole picture inside its margin');
  assert.equal(canvas.named('roundRect').length, s.panels.length, 'a block for each panel');
  assert.equal(canvas.named('strokeRect').length, 1, 'and the stage outlined');
}

/* ---- The ground ------------------------------------------------------------------------------------- */
{
  const s = laidOut([['commit', 2]]);
  const state = () => ({ pointer: null, px: 0, py: 0, light: 0, ripples: [], sig: '' });
  const f = state();
  const first = recordingCanvas();
  F.drawField(first.ctx, s, f, DARK, 1000, 16, true);
  assert.equal(f.draws, 1);
  assert.ok(first.named('fillRect').length > 500, 'the field is a grid of dots');
  const settled = recordingCanvas();
  F.drawField(settled.ctx, s, f, DARK, 1100, 16, true);
  assert.equal(settled.calls.length, 0, 'a still field under a still pointer is not drawn again');
  F.drawField(recordingCanvas().ctx, { ...s, panX: 30 }, f, DARK, 1200, 16, true);
  assert.equal(f.draws, 2, 'a moved camera draws it again');
  F.drawField(recordingCanvas().ctx, { ...s, width: 0 }, f, DARK, 1300, 16, true);
  assert.equal(f.draws, 2, 'a stage without a size is not drawn');
  /* Dots stand clear of the panels and the hub, every one of them somewhere. */
  assert.ok(first.named('fillRect').every(c => Number.isFinite(c.args[0]) && Number.isFinite(c.args[1])), 'every dot is somewhere on the stage');
  const dots = first.named('fillRect').map(c => S.screenToWorld(s, c.args[0] + c.args[2] / 2, c.args[1] + c.args[3] / 2));
  for (const p of s.panels) assert.ok(!dots.some(d => d.x > p.x + 4 && d.x < p.x + p.w - 4 && d.y > p.y + 4 && d.y < p.y + p.h - 4), `no dot under the ${p.type} panel`);
  assert.ok(!dots.some(d => Math.hypot(d.x, d.y) < L.HUB_R * .9), 'nor under the hub');
  /* Under the pointer the field lights, and with motion held it does not. */
  const lit = { ...state(), pointer: { x: 640, y: 360 } };
  F.drawField(recordingCanvas().ctx, s, lit, DARK, 1000, 16, true);
  F.drawField(recordingCanvas().ctx, s, lit, DARK, 1120, 16, true);
  assert.ok(lit.light > .5 && lit.light < 1, 'the light rises under the hand, eased');
  const mesh = recordingCanvas();
  F.drawField(mesh.ctx, s, lit, DARK, 3000, 16, true);
  assert.equal(lit.light, 1);
  assert.ok(mesh.named('arc').length > 10, 'and lights the dots under it');
  assert.ok(mesh.named('lineTo').length > mesh.named('arc').length, 'joined into a mesh across and down');
  const still = { ...state(), pointer: { x: 640, y: 360 }, ripples: [{ wx: 0, wy: 0, at: 0 }] };
  F.drawField(recordingCanvas().ctx, s, still, DARK, 100, 16, false);
  assert.deepEqual([still.light, still.ripples.length], [0, 0], 'with motion held there is no light and no ripple');
  /* Ripples run their course, and only four at once. */
  const rippled = state();
  for (let i = 0; i < 6; i++) F.addRipple(rippled, s, 640 + i, 360, i);
  assert.equal(rippled.ripples.length, F.FIELD.maxRipples, 'no more than four ripples at once');
  assert.deepEqual(rippled.ripples[0], { wx: 2, wy: 0, at: 2 }, 'the oldest give way, each kept where it began in the world');
  F.drawField(recordingCanvas().ctx, s, rippled, DARK, 1000, 16, true);
  assert.equal(rippled.ripples.length, 4);
  F.drawField(recordingCanvas().ctx, s, rippled, DARK, 10 + F.FIELD.rippleLife, 16, true);
  assert.equal(rippled.ripples.length, 0, 'and fade after their life');
  /* Zoomed out, the pitch doubles rather than the grid thickening. */
  const pitch = zoom => {
    const canvas = recordingCanvas();
    F.drawField(canvas.ctx, { ...s, zoom, panels: [], nodes: [] }, state(), DARK, 0, 16, true);
    const xs = [...new Set(canvas.named('fillRect').map(c => Math.round(c.args[0] * 1000) / 1000))].sort((a, b) => a - b);
    return Math.round((xs[1] - xs[0]) * 1000) / 1000;
  };
  assert.equal(pitch(1), 28);
  assert.equal(pitch(.4), 22.4, 'at a fifth of the zoom the grid is twice as coarse');
}

console.log('neural graph drawing: ok');
