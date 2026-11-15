'use strict';
/*
 * How the Neural map answers the reader's hand (features/neural): where the
 * camera goes (graph-camera.ts) and how it and the nodes ease there
 * (graph-motion.ts), what a point on the stage is on and where an arrow key
 * goes (graph-pointer.ts), and how two nodes are connected (graph-path.ts).
 */
const assert = require('node:assert/strict');
const { addNode, addEdge } = require('../apps/web/src/features/neural/graph-model.ts');
const L = require('../apps/web/src/features/neural/graph-layout.ts');
const S = require('../apps/web/src/features/neural/graph-scene.ts');
const C = require('../apps/web/src/features/neural/graph-camera.ts');
const M = require('../apps/web/src/features/neural/graph-motion.ts');
const P = require('../apps/web/src/features/neural/graph-pointer.ts');
const { shortestPath } = require('../apps/web/src/features/neural/graph-path.ts');

const close = (a, b, what, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${what}: ${a} is not ${b}`);
const camera = (over = {}) => ({ width: 1000, height: 600, dpr: 1, zoom: 1, panX: 0, panY: 0, ...over });
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

/* ---- What covers the stage's edges -------------------------------------------------------- */
{
  const stage = rect(100, 50, 1000, 600);
  assert.deepEqual(C.stageInsets(stage, null, null, null), C.DEFAULT_INSETS, 'nothing measured: room for the status above and the tools on the right');
  assert.deepEqual(C.DEFAULT_INSETS, { left: 16, right: 64, top: 64, bottom: 20 });
  assert.ok(Object.isFrozen(C.DEFAULT_INSETS));
  const top = rect(118, 62, 300, 40);
  assert.deepEqual(C.stageInsets(stage, top, null, null), { left: 21, right: 64, top: 62, bottom: 20 },
    'below the status and search, and in from the left where they start');
  assert.deepEqual(C.stageInsets(stage, rect(118, 62, 300, 0), null, null), C.DEFAULT_INSETS, 'a status with no height covers nothing');
  assert.deepEqual(C.stageInsets(stage, rect(100, 50, 300, 4), null, null).top, 24, 'and never less than 24 from the top');
  const tools = rect(1052, 110, 40, 240);
  assert.deepEqual(C.stageInsets(stage, null, tools, null), { left: 16, right: 58, top: 64, bottom: 306 }, 'clear of the tools, beside and above');
  assert.deepEqual(C.stageInsets(stage, null, rect(1100, 110, 40, 540), null), { left: 16, right: 16, top: 64, bottom: 16 }, 'never closer than 16 to an edge');
  assert.deepEqual(C.stageInsets(stage, null, rect(1052, 110, 0, 240), null), C.DEFAULT_INSETS, 'tools with no width cover nothing');
  assert.equal(C.stageInsets(stage, top, tools, rect(100, 50, 320, 600)).left, 336, 'a docked rail over the stage pushes the left edge past it');
  assert.equal(C.stageInsets(stage, rect(500, 62, 300, 40), null, rect(100, 50, 320, 600)).left, 403, 'unless the status starts further in');
}

/* ---- Zooming ---------------------------------------------------------------------------------- */
{
  const at = C.zoomAround(camera(), 700, 200, 2);
  assert.deepEqual(at, { zoom: 2, panX: -200, panY: 100 }, 'zoomed about a point, what is under it stays under it');
  for (const [x, y, zoom, from] of [[0, 0, 1.7, camera({ zoom: .5, panX: 40, panY: -30 })], [999, 599, .4, camera({ zoom: 2.2, panX: -300, panY: 120 })], [313.5, 17.25, 2.6, camera({ zoom: 1.13 })]]) {
    const before = S.screenToWorld(from, x, y);
    const next = C.zoomAround(from, x, y, zoom);
    const after = S.screenToWorld({ ...from, ...next }, x, y);
    close(after.x, before.x, 'the world point under the hand, across'); close(after.y, before.y, 'and down');
  }
  assert.equal(C.zoomAround(camera(), 500, 300, 10).zoom, C.ZOOM.max, 'no closer than 2.6');
  assert.equal(C.zoomAround(camera(), 500, 300, .01).zoom, C.ZOOM.min, 'no further than .35');
  assert.deepEqual([C.ZOOM.min, C.ZOOM.max], [.35, 2.6]);
  const held = C.zoomAround(camera({ panX: 30 }), 800, 100, 9);
  const world = S.screenToWorld(camera({ panX: 30 }), 800, 100);
  close(S.screenToWorld({ ...camera(), ...held }, 800, 100).x, world.x, 'held at the limit, the point still stays');

  assert.deepEqual(C.zoomStep({ zoom: 1, panX: 100, panY: -50 }, 2), { zoom: 2, panX: 200, panY: -100 }, 'a step scales about the stage\'s centre');
  const near = C.zoomStep({ zoom: 2.5, panX: 100, panY: -50 }, 1.25);
  assert.equal(near.zoom, 2.6, 'stopped at the limit');
  close(near.panX, 104, 'and the pan scaled only as far as the zoom went'); close(near.panY, -52, 'down too');
  assert.deepEqual(C.zoomStep({ zoom: 2.6, panX: 100, panY: -50 }, 1.25), { zoom: 2.6, panX: 100, panY: -50 }, 'at the limit a step in moves nothing');
  assert.equal(C.zoomStep({ zoom: .4, panX: 0, panY: 0 }, 1 / 1.25).zoom, .35);
}

/* ---- Framing ---------------------------------------------------------------------------------- */
{
  const frame = { width: 1000, height: 600, insets: C.DEFAULT_INSETS, layoutMode: 'split' };
  const freeCentre = f => ({ x: f.insets.left + (f.width - f.insets.left - f.insets.right) / 2, y: f.insets.top + (f.height - f.insets.top - f.insets.bottom) / 2 });
  const landed = (target, f, x, y) => S.worldToScreen({ ...f, dpr: 1, ...target }, x, y);
  const fit = C.frameBox(frame, { minX: -400, minY: -200, maxX: 400, maxY: 200 });
  assert.equal(fit.zoom, 1.15, 'as large as the box\'s width allows in the free area (920 for 800)');
  const centre = landed(fit, frame, 0, 0);
  close(centre.x, freeCentre(frame).x, 'centred in the part of the stage nothing covers'); close(centre.y, freeCentre(frame).y, 'across and down');

  assert.equal(C.frameBox(frame, { minX: -5, minY: -5, maxX: 5, maxY: 5 }).zoom, C.FIT.max, 'a small box is not blown up past 1.35');
  assert.equal(C.frameBox(frame, { minX: -5, minY: -5, maxX: 5, maxY: 5 }, 1.2).zoom, 1.2, 'or past the caller\'s own limit');
  assert.equal(C.frameBox(frame, { minX: -400, minY: -1500, maxX: 400, maxY: 1500 }).zoom, C.FIT.readable,
    'a graph far taller than the stage stops where a row can be read, rather than shrinking to fit its height');
  assert.equal(C.frameBox(frame, { minX: -1000, minY: -1500, maxX: 1000, maxY: 1500 }).zoom, .46, 'one wider than the stage as well is fitted to its width');
  assert.equal(C.frameBox(frame, { minX: -2000, minY: -1500, maxX: 2000, maxY: 1500 }).zoom, C.FIT.min, 'and never further out than .3');
  assert.equal(C.frameBox(frame, { minX: -400, minY: -1500, maxX: 400, maxY: 1500 }, C.FIT.max, true).zoom, C.FIT.min, 'framed whole, it shrinks as far as .3 and no further');
  assert.deepEqual([C.FIT.min, C.FIT.max, C.FIT.tall, C.FIT.readable], [.3, 1.35, 1.1, .78]);

  const tall = { ...frame, layoutMode: 'stack' };
  const column = { minX: -150, minY: -100, maxX: 150, maxY: 2900 };
  const read = C.frameBox(tall, column);
  assert.equal(read.zoom, C.FIT.tall, 'a tall stack is framed by its width, no closer than 1.1');
  close(landed(read, tall, 0, column.minY).y, tall.insets.top, 'and read from the top down: its top at the top of the free area');
  close(landed(read, tall, 0, 0).x, freeCentre(tall).x, 'centred across');
  const short = C.frameBox(tall, { minX: -150, minY: -100, maxX: 150, maxY: 200 });
  close(landed(short, tall, 0, 50).y, freeCentre(tall).y, 'a stack that fits is centred like anything else');
  const whole = C.frameBox(tall, column, 1.2, true);
  assert.equal(whole.zoom, Math.max(C.FIT.min, 516 / 3000), 'framed whole, even a tall stack is shown entire');

  const railed = { ...frame, insets: { ...C.DEFAULT_INSETS, left: 336 } };
  close(landed(C.frameBox(railed, { minX: -100, minY: -100, maxX: 100, maxY: 100 }), railed, 0, 0).x, freeCentre(railed).x, 'beside a docked rail, the frame moves over');
  assert.deepEqual(C.frameBox({ ...frame, width: 50, height: 40 }, { minX: 0, minY: 0, maxX: 0, maxY: 0 }).zoom, C.FIT.max, 'a stage too small still frames, from 80 pixels of room');

  const panel = { x: 300, y: -100, w: 272, h: 200 };
  assert.deepEqual(C.panelBox(panel), { minX: 270, minY: -130, maxX: 602, maxY: 130 }, 'an opened group, with room round it');
  assert.deepEqual(C.groupBox(panel), { minX: -88, minY: -130, maxX: 602, maxY: 130 }, 'a chosen group with the hub it hangs from');
  assert.deepEqual(C.groupBox({ x: -700, y: 40, w: 272, h: 60 }), { minX: -730, minY: -88, maxX: 88, maxY: 130 });
}

/* ---- Bringing a node beside its card ---------------------------------------------------------- */
{
  let measured = 0;
  const insets = () => { measured += 1; return C.DEFAULT_INSETS; };
  const view = (over = {}) => ({ camera: camera(), heading: null, docked: true, insets, cardWidth: 312, panel: null, ...over });
  assert.equal(C.approach(view({ camera: camera({ width: 0 }) }), { type: 'commit', x: 0, y: 0 }), null, 'an unmeasured stage sends the camera nowhere');
  assert.equal(C.approach(view(), { type: 'commit', x: 0, y: -100 }), null, 'a node already in the upper part of a docked card\'s stage stays put');
  assert.equal(measured, 0, 'and nothing was measured to decide it');
  const below = C.approach(view(), { type: 'commit', x: 0, y: 200 });
  assert.deepEqual(below, { zoom: 1, panX: 0, panY: -338 }, 'one the docked card would cover is brought up');
  close(S.worldToScreen({ ...camera(), ...below }, 0, 200).y, 600 * .27, 'to a little above the top third');
  assert.notEqual(C.approach(view(), { type: 'commit', x: 0, y: 100 }), null, 'one on screen but low, where the docked card opens, is brought up too');
  assert.notEqual(C.approach(view(), { type: 'commit', x: -400, y: -100 }), null, 'and one near the stage\'s side');
  assert.equal(C.approach(view({ camera: camera({ zoom: .5 }) }), { type: 'commit', x: 0, y: -100 }).zoom, .75, 'and never read further out than .75');
  assert.equal(C.approach(view({ camera: camera({ zoom: .5 }), heading: { zoom: 2, panX: 0, panY: 0 } }), { type: 'commit', x: 0, y: -100 }).zoom, 2,
    'a camera on its way somewhere keeps the zoom it was going to');
  assert.deepEqual(C.approach(view(), { type: 'commit', x: 900, y: 900, tx: 0, ty: -100 }), null, 'a node is judged where it is going, not where an easing frame has it');

  const wide = (over = {}) => view({ camera: camera({ width: 1400, height: 800 }), docked: false, ...over });
  const panel = { x: 300, w: 272 };
  measured = 0;
  const beside = C.approach(wide({ panel }), { type: 'commit', x: 330, y: 0 });
  assert.ok(measured >= 1, 'beside a floating card the free area is measured');
  const at = S.worldToScreen({ ...camera({ width: 1400, height: 800 }), ...beside }, 330, 0);
  close(at.x, 766, 'the node lands so its panel\'s right edge stops just short of the card');
  close(at.x + (panel.x + panel.w - 330), 1400 - 64 - 312 - 16, 'the card\'s left edge, less its margin');
  close(at.y, 400, 'at the stage\'s middle height');
  assert.equal(C.approach(wide(), { type: 'repo', x: 0, y: 0 }), null, 'the hub in the middle of a wide stage is clear of the card');
  const hub = C.approach(wide({ camera: camera({ width: 1400, height: 800, panX: 900 }) }), { type: 'repo', x: 0, y: 0 });
  close(S.worldToScreen({ ...camera({ width: 1400, height: 800 }), ...hub }, 0, 0).x, 1400 * .6, 'off the stage, a node in no panel comes back no further right than 60%');
  const middling = C.approach(wide({ camera: camera({ width: 1000, height: 800, panX: 900 }) }), { type: 'repo', x: 0, y: 0 });
  close(S.worldToScreen({ ...camera({ width: 1000, height: 800 }), ...middling }, 0, 0).x, 1000 - 64 - 312 - 16 - L.HUB_R, 'the hub stops its own radius short of the card');
  const narrow = C.approach(wide({ camera: camera({ width: 500, height: 800 }), panel }), { type: 'commit', x: 330, y: 300 });
  close(S.worldToScreen({ ...camera({ width: 500, height: 800 }), ...narrow }, 330, 300).x, C.DEFAULT_INSETS.left + 50, 'and no further left than the free area\'s edge');
  assert.equal(C.approach(wide({ camera: camera({ width: 1400, height: 800, panX: -400 }), panel }), { type: 'commit', x: 330, y: 0 }), null,
    'a node whose whole panel is already clear of the card stays put');
  assert.notEqual(C.approach(wide({ camera: camera({ width: 1400, height: 800, panX: -200 }), panel }), { type: 'commit', x: 330, y: 0 }), null,
    'one whose panel runs under where the card opens is moved, though the node itself is clear');
}

/* ---- Easing ----------------------------------------------------------------------------------- */
{
  const node = (over = {}) => ({ visible: true, x: 0, y: 0, tx: 100, ty: 50, appear: 1, ...over });
  const still = node({ x: 100, y: 50 });
  assert.equal(M.easeNodes([still], 16, true), false, 'a node at its place does not move');
  const cut = node();
  assert.equal(M.easeNodes([cut], 16, false), true, 'with motion off a node arrives at once');
  assert.deepEqual([cut.x, cut.y], [100, 50]);
  assert.equal(M.easeNodes([cut], 16, false), false, 'and is still from then on');
  const eased = node();
  M.easeNodes([eased], 16, true);
  const k = 1 - Math.exp(-16 / 130);
  close(eased.x, 100 * k, 'with motion on it eases, a share of the way each frame'); close(eased.y, 50 * k, 'down too');
  const upright = node({ x: 100, y: 0 });
  M.easeNodes([upright], 16, true);
  close(upright.y, 50 * k, 'a node moving only up or down eases as well');
  const later = node();
  M.easeNodes([later], 40, true);
  assert.ok(later.x > eased.x, 'a longer frame goes further');
  const last = node({ x: 99.8, y: 50.1 });
  assert.equal(M.easeNodes([last], 16, true), true);
  assert.deepEqual([last.x, last.y], [100, 50], 'the last quarter pixel is not eased: it lands');
  const hidden = node({ visible: false });
  assert.equal(M.easeNodes([hidden], 16, true), false);
  assert.deepEqual([hidden.x, hidden.y], [0, 0], 'a hidden node is left where it is');
  const unplaced = { visible: true, x: 7, y: 8 };
  assert.equal(M.easeNodes([unplaced], 16, true), false, 'a node with no place yet takes the one it has');
  assert.deepEqual([unplaced.tx, unplaced.ty], [7, 8]);
  const arriving = node({ x: 100, y: 50, appear: 0 });
  assert.equal(M.easeNodes([arriving], 140, true), true, 'a node arriving grows in');
  assert.equal(arriving.appear, .5, 'over 280 milliseconds');
  M.easeNodes([arriving], 1000, true);
  assert.equal(arriving.appear, 1, 'and no further than whole');
  const shown = node({ x: 100, y: 50, appear: .2 });
  M.easeNodes([shown], 16, false);
  assert.equal(shown.appear, 1, 'with motion off it is whole at once');
  assert.equal(M.easeNodes([still, cut, node({ x: 100, y: 50, appear: undefined })], 16, true), false, 'none moving, none reported');

  const cam = { zoom: 1, panX: 0, panY: 0 };
  assert.equal(M.easeCamera(cam, { zoom: 2, panX: 100, panY: -40 }, 16, false), true, 'with motion off the camera arrives at once');
  assert.deepEqual(cam, { zoom: 2, panX: 100, panY: -40 });
  const moving = { zoom: 1, panX: 0, panY: 0 };
  assert.equal(M.easeCamera(moving, { zoom: 2, panX: 100, panY: -40 }, 16, true), false, 'with motion on it eases');
  const c = 1 - Math.exp(-16 / 110);
  close(moving.zoom, 1 + c, 'the zoom a share of the way'); close(moving.panX, 100 * c, 'and the pan');
  const nearly = { zoom: 1.9995, panX: 99.7, panY: -39.6 };
  assert.equal(M.easeCamera(nearly, { zoom: 2, panX: 100, panY: -40 }, 16, true), true, 'close enough, it lands exactly');
  assert.deepEqual(nearly, { zoom: 2, panX: 100, panY: -40 });
}

/* ---- What the hand is on ----------------------------------------------------------------------- */
const spot = (id, type, x, y, over = {}) => ({ id, type, x, y, tx: x, ty: y, visible: true, folded: false, ...over });
{
  const ground = nodes => ({ ...camera(), nodes, panels: [] });
  const at = (g, x, y) => S.worldToScreen(g, x, y);
  const lone = ground([spot('c', 'commit', 0, 0)]);
  const hit = (g, x, y) => { const p = at(g, x, y); const n = P.hitNode(g, p.x, p.y); return n && n.id; };
  assert.equal(hit(lone, 22.9, 0), 'c', 'a node is hit a little beyond its disc');
  assert.equal(hit(lone, 23.1, 0), null, 'and not further');
  const hub = ground([spot('r', 'repo', 0, 0)]);
  assert.equal(hit(hub, 0, 67.9), 'r', 'the hub, larger, with more to spare');
  assert.equal(hit(hub, 0, 68.1), null);
  const zoomed = { ...lone, zoom: 2 };
  assert.equal(P.hitNode(zoomed, 500 + 45, 300), lone.nodes[0], 'measured in the world: zoomed in, the target grows on screen');
  assert.equal(P.hitNode(zoomed, 500 + 47, 300), null);
  const pair = ground([spot('a', 'commit', 100, 0), spot('b', 'commit', 120, 0)]);
  assert.equal(hit(pair, 108, 0), 'a', 'of two discs, the nearer centre');
  assert.equal(hit(pair, 112, 0), 'b');
  assert.equal(hit(ground([spot('f', 'commit', 0, 0, { folded: true })]), 0, 0), null, 'a node folded behind its footer is not there to hit');
  assert.equal(hit(ground([spot('h', 'commit', 0, 0, { visible: false })]), 0, 0), null, 'nor a hidden one');
}

/* A graph laid out by the real layout, at rest, under a camera on a 1280 by 720 stage. */
function laid(groups, input = {}) {
  const map = new Map();
  addNode(map, 'repo:x', 'repo', 'acme/widget');
  for (const [type, count] of groups) for (let i = 0; i < count; i++) addNode(map, `${type}:${i}`, type, `${type} ${String(i).padStart(2, '0')}`);
  const nodes = [...map.values()];
  const layout = L.placeGraph({ nodes, expanded: new Set(), pages: new Map(), totals: {}, aspect: L.layoutAspect(1280, 720), placed: {}, ...input });
  for (const [n, t] of layout.targets) Object.assign(n, { tx: t.x, ty: t.y, x: t.x, y: t.y, folded: t.folded });
  return { width: 1280, height: 720, dpr: 1, zoom: .9, panX: -40, panY: 25, nodes, panels: layout.panels, byType: layout.byType };
}
{
  const g = laid([['commit', 3], ['user', 2]]);
  const panel = g.byType.get('commit');
  const row = r => panel.y + L.HEAD_H + r * L.ROW_H + L.ROW_H / 2;
  const point = (x, y) => S.worldToScreen(g, x, y);
  const nodeAt = (x, y) => { const p = point(x, y); const n = P.hitNode(g, p.x, p.y); return n && n.id; };
  const partAt = (x, y) => { const p = point(x, y); return P.panelHitAt(g, p.x, p.y); };
  assert.equal(nodeAt(panel.x + 140, row(1)), panel.shown[1].id, 'a node is hit anywhere on its row: its name is a target too');
  assert.equal(nodeAt(panel.x + 140, row(0) - L.ROW_H / 2 + .5), panel.shown[0].id, 'from the row\'s top');
  assert.equal(nodeAt(panel.x + 140, row(2) + L.ROW_H / 2 - .5), panel.shown[2].id, 'to the last row\'s bottom');
  assert.equal(nodeAt(panel.x + 5, row(1)), null, 'not on the panel\'s very edge');
  assert.equal(nodeAt(panel.x + panel.w - 5, row(1)), null, 'either edge');
  assert.equal(nodeAt(panel.x + 140, panel.y + 20), null, 'not on the header');
  const hubNode = g.nodes.find(n => n.type === 'repo');
  assert.equal(nodeAt(hubNode.x, hubNode.y), hubNode.id, 'the hub where it stands');
  assert.equal(nodeAt(panel.nodeX, row(2)), panel.shown[2].id, 'a row\'s node on its disc');

  assert.deepEqual(partAt(panel.x + 140, panel.y + 20), { kind: 'header', type: 'commit' }, 'the header is the panel\'s handle');
  assert.deepEqual(partAt(panel.x + 140, panel.y + L.HEAD_H - .5).kind, 'header', 'the header, to its bottom edge');
  assert.deepEqual(partAt(panel.x + 140, panel.y + L.HEAD_H + .5).kind, 'body');
  assert.deepEqual(partAt(panel.x + 140, row(1)), { kind: 'body', type: 'commit' }, 'the rows, for what a press there means away from a node, are ground');
  assert.deepEqual(partAt(panel.x - 1, row(1)), null, 'outside every panel, nothing');
  assert.deepEqual(partAt(panel.x + 140, panel.y + panel.h + 1), null);
  assert.equal(P.panelHitAt({ ...g, panels: null }, 0, 0), null, 'no panels, no part');

  const folded = laid([['commit', 8]]);
  const fp = folded.byType.get('commit');
  const fpoint = (x, y) => { const p = S.worldToScreen(folded, x, y); return P.panelHitAt(folded, p.x, p.y); };
  assert.equal(fp.footer, 'more');
  assert.deepEqual(fpoint(fp.x + 200, fp.moreY), { kind: 'more', type: 'commit' }, 'a folded group\'s footer opens it, anywhere along it');
  assert.deepEqual(fpoint(fp.x + 30, fp.moreY - L.ROW_H / 2), { kind: 'more', type: 'commit' }, 'its whole row, edge to edge');
  assert.deepEqual(fpoint(fp.x + 30, fp.moreY + L.ROW_H / 2 + .5), { kind: 'body', type: 'commit' }, 'and no further');

  const paged = laid([['commit', 14]], { expanded: new Set(['commit']) });
  const pp = paged.byType.get('commit');
  const ppoint = (x, y) => { const p = S.worldToScreen(paged, x, y); return P.panelHitAt(paged, p.x, p.y); };
  const right = pp.x + pp.w;
  assert.equal(pp.pages, 2);
  assert.deepEqual(ppoint(pp.x + 40, pp.moreY), { kind: 'less', type: 'commit' }, 'an opened group\'s footer folds it again from the left');
  assert.deepEqual(ppoint(pp.x + L.FOOTER.lessEnd - .5, pp.moreY).kind, 'less');
  assert.deepEqual(ppoint(right + L.FOOTER.prevX, pp.moreY), { kind: 'prev', type: 'commit' }, 'its pager goes back');
  assert.deepEqual(ppoint(right + L.FOOTER.prevX + L.FOOTER.hit - .01, pp.moreY).kind, 'prev', 'within a chevron\'s reach');
  const square = { ...paged, zoom: 1, panX: 0, panY: 0 };
  const exact = S.worldToScreen(square, right + L.FOOTER.prevX + L.FOOTER.hit, pp.moreY);
  assert.deepEqual(P.panelHitAt(square, exact.x, exact.y).kind, 'prev', 'to its very edge');
  const exactNext = S.worldToScreen(square, right + L.FOOTER.nextX - L.FOOTER.hit, pp.moreY);
  assert.deepEqual(P.panelHitAt(square, exactNext.x, exactNext.y).kind, 'next');
  assert.deepEqual(ppoint(right + L.FOOTER.prevX + L.FOOTER.hit + .5, pp.moreY).kind, 'body', 'and not beyond');
  assert.deepEqual(ppoint(right + L.FOOTER.nextX, pp.moreY), { kind: 'next', type: 'commit' }, 'and on');
  assert.deepEqual(ppoint(right + L.FOOTER.nextX - L.FOOTER.hit - .5, pp.moreY).kind, 'body');
  assert.deepEqual(ppoint(right + L.FOOTER.rangeX, pp.moreY).kind, 'body', 'the range between them is only words');
  const single = laid([['commit', 8]], { expanded: new Set(['commit']) });
  const sp = single.byType.get('commit');
  const spoint = (x, y) => { const p = S.worldToScreen(single, x, y); return P.panelHitAt(single, p.x, p.y); };
  assert.equal(sp.pages, 1);
  assert.deepEqual(spoint(sp.x + 40, sp.moreY).kind, 'less', 'one page opened still folds again');
  assert.deepEqual(spoint(sp.x + sp.w + L.FOOTER.prevX, sp.moreY).kind, 'body', 'but has no pager to press');
  assert.deepEqual(spoint(sp.x + sp.w + L.FOOTER.nextX, sp.moreY).kind, 'body');

  assert.equal(P.cursorFor(g.nodes[0], null), 'pointer', 'a node is pressed');
  for (const kind of ['more', 'less', 'prev', 'next']) assert.equal(P.cursorFor(null, { kind, type: 'commit' }), 'pointer', `"${kind}" is pressed`);
  assert.equal(P.cursorFor(null, { kind: 'header', type: 'commit' }), 'move', 'a header is moved');
  assert.equal(P.cursorFor(null, { kind: 'body', type: 'commit' }), 'grab', 'the rest is ground to grab');
  assert.equal(P.cursorFor(null, null), 'grab');
  assert.equal(P.DRAG_THRESHOLD, 5, 'a press moved more than 5 pixels is a drag');
}

/* ---- The arrow keys --------------------------------------------------------------------------- */
{
  assert.deepEqual([P.walkStep('ArrowRight'), P.walkStep('ArrowLeft'), P.walkStep('ArrowDown'), P.walkStep('ArrowUp')], [[1, 0], [-1, 0], [0, 1], [0, -1]]);
  for (const key of ['Enter', 'a', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '']) assert.equal(P.walkStep(key), null, `"${key}" is no arrow`);
  const from = spot('o', 'commit', 0, 0);
  const walk = (nodes, dx, dy) => { const n = P.walk([from, ...nodes], from, dx, dy); return n && n.id; };
  assert.equal(walk([spot('far', 'commit', 100, 0), spot('off', 'commit', 60, 50)], 1, 0), 'far', 'right: the nearest along the line, off it counting more');
  assert.equal(walk([spot('far', 'commit', 100, 0), spot('near', 'commit', 50, 10)], 1, 0), 'near', 'a little off the line and much nearer wins');
  assert.equal(walk([spot('far', 'commit', 100, 0), spot('diagonal', 'commit', 50, 30)], 1, 0), 'far', 'off the line counts 2.2 times what along it does');
  assert.equal(walk([spot('back', 'commit', -50, 0)], 1, 0), null, 'nothing that way, nowhere to go');
  assert.equal(walk([spot('beside', 'commit', 1, -60)], 1, 0), null, 'a node level with it is not ahead');
  assert.equal(walk([spot('up', 'commit', 0, -40), spot('down', 'commit', 0, 40)], 0, -1), 'up', 'up is up the stage');
  assert.equal(walk([spot('up', 'commit', 0, -40), spot('down', 'commit', 0, 40)], 0, 1), 'down');
  assert.equal(walk([spot('f', 'commit', 30, 0, { folded: true }), spot('h', 'commit', 40, 0, { visible: false }), spot('n', 'commit', 90, 0)], 1, 0), 'n',
    'folded and hidden nodes are stepped over');
  assert.equal(walk([spot('moving', 'commit', 900, 0, { tx: 30, ty: 0 }), spot('n', 'commit', 50, 0)], 1, 0), 'moving', 'measured between places, not easing frames');
  assert.equal(walk([{ ...spot('new', 'commit', 30, 0), tx: undefined, ty: undefined }, spot('n', 'commit', 50, 0)], 1, 0), 'n', 'a node not yet placed is not walked to');
  assert.equal(P.walk([from, spot('n', 'commit', 50, 0)], { ...from, tx: undefined }, 1, 0), null, 'nor from');
}

/* ---- Explaining a connection ------------------------------------------------------------------- */
{
  const map = new Map();
  for (const id of ['a', 'b', 'c', 'd', 'lone']) addNode(map, `commit:${id}`, 'commit', id);
  const nodes = [...map.values()];
  const edges = [];
  addEdge(edges, 'commit:a', 'commit:b', 'parent');
  addEdge(edges, 'commit:c', 'commit:b', 'parent', 'critical');
  addEdge(edges, 'commit:a', 'commit:d', 'parent');
  addEdge(edges, 'commit:d', 'commit:c', 'parent');
  addEdge(edges, 'commit:a', 'commit:ghost', 'parent');
  addEdge(edges, 'commit:a', 'commit:a', 'self');
  const path = shortestPath(nodes, edges, 'commit:a', 'commit:c');
  assert.deepEqual(path.nodeIds, ['commit:a', 'commit:b', 'commit:c'], 'the fewest steps; of two as short, the one whose relations come first');
  assert.equal(path.edges[0], edges[0], 'a relation walked its own way is the relation itself');
  assert.equal(path.edges[0].reversed, undefined);
  assert.equal(path.edges[1].id, edges[1].id, 'one walked against its direction is the same relation');
  assert.equal(path.edges[1].reversed, true, 'marked reversed');
  assert.equal(edges[1].reversed, undefined, 'and the graph\'s own is left as it was');
  assert.equal(path.edges[1].severity, 'critical', 'with everything it says');
  assert.deepEqual(shortestPath(nodes, edges, 'commit:c', 'commit:a').nodeIds, ['commit:c', 'commit:b', 'commit:a'], 'either way round');
  assert.deepEqual(shortestPath(nodes, edges, 'commit:a', 'commit:d').edges.map(e => e.id), [edges[2].id], 'one step');
  assert.equal(shortestPath(nodes, edges, 'commit:a', 'commit:lone'), null, 'nothing joins them');
  assert.equal(shortestPath(nodes, edges, 'commit:a', 'commit:ghost'), null, 'a node the graph does not hold');
  assert.equal(shortestPath(nodes, edges, 'commit:nowhere', 'commit:a'), null);
  assert.equal(shortestPath(nodes, edges, 'commit:a', 'commit:a'), null, 'a node is not connected to itself by a path');
  const long = [];
  const chain = new Map();
  for (let i = 0; i < 400; i++) addNode(chain, `commit:${i}`, 'commit', `${i}`);
  for (let i = 0; i < 399; i++) addEdge(long, `commit:${i}`, `commit:${i + 1}`, 'parent');
  assert.equal(shortestPath([...chain.values()], long, 'commit:0', 'commit:399').edges.length, 399, 'a long chain is followed to its end');
}

console.log('neural graph interaction: ok');
