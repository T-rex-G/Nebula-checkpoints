'use strict';

/*
 * The repository mark is generated, so what has to hold is not how it looks
 * but that it is derived: the same name always draws the same mark, different
 * names draw marks a person can tell apart, and nothing about it depends on
 * state that could differ between two sessions or two devices.
 */

const assert = require('node:assert/strict');
const sigil = require('../public/repo-sigil.js');

function inventory() {
  const names = [];
  for (const owner of ['acme', 'sandbox', 'nebula', 'core', 'ops']) {
    for (const repo of ['api', 'api-2', 'web', 'web-2', 'infra', 'docs', 'cli', 'sdk', 'auth', 'billing', 'edge', 'proxy']) {
      names.push(`${owner}/${repo}`);
    }
  }
  return names;
}

/* Derived, not chosen: the same repository draws the same mark, always. */
assert.deepEqual(sigil.plan('sandbox/demo'), sigil.plan('sandbox/demo'));
assert.deepEqual(sigil.plan('acme/api'), sigil.plan('acme/api'));

/*
 * And two repositories are told apart. The bar is not "the plans differ" --
 * two marks can differ in a field no one perceives -- but that no two are
 * drawn the same way: same hue, same facet count, same rotation and the same
 * wedges is one mark wearing two names.
 */
const names = inventory();
const drawn = new Map();
for (const name of names) {
  const shape = sigil.plan(name);
  const signature = JSON.stringify([shape.hue, shape.facets, shape.spin, shape.wedges]);
  const twin = drawn.get(signature);
  assert.equal(twin, undefined, `${name} draws the same mark as ${twin}`);
  drawn.set(signature, name);
}

/*
 * Names in an inventory differ by very little. A one-character difference has
 * to move the mark, or the two entries that are easiest to confuse by name are
 * also the two hardest to tell apart by sight.
 */
for (const [a, b] of [['acme/api', 'acme/api-2'], ['acme/web', 'acme/web-2'], ['a', 'b'], ['x/y', 'x/z']]) {
  assert.notDeepEqual(sigil.plan(a), sigil.plan(b), `${a} and ${b} draw the same mark`);
}

/* The rotation is on a grid coarse enough to see. A free rotation put pairs
   nine degrees apart, which reads as no difference at the size drawn. */
for (const name of names) {
  const { spin } = sigil.plan(name);
  assert.equal(spin % 24, 0, `${name} has an off-grid rotation`);
  assert.ok(spin >= 0 && spin < 360, `${name} has a rotation outside one turn`);
}

/* Hues come from the palette, not the whole wheel: a mark that can be any
   colour stops reading as part of this product. */
for (const name of names) {
  const shape = sigil.plan(name);
  assert.ok(sigil.HUES.includes(shape.hue), `${name} uses a hue outside the palette`);
  assert.ok(sigil.HUES.includes(shape.hueLift), `${name} lifts to a hue outside the palette`);
}

/*
 * Every facet has to be drawable, and drawable inside the frame. The first
 * version reached as far as 37 units from a centre 24 units into a 48-unit
 * box, so the longest facets were silently clipped by the viewBox and the
 * marks read as scattered slivers rather than as one shape. A wedge that
 * cannot be seen and a wedge that cannot fit are the same defect.
 */
const FRAME = 48;
const CENTRE = FRAME / 2;
for (const name of names) {
  const shape = sigil.plan(name);
  assert.ok(shape.facets >= 3 && shape.facets <= 5, `${name} has ${shape.facets} facets`);
  assert.equal(shape.wedges.length, shape.facets);
  for (const wedge of shape.wedges) {
    assert.ok(wedge.reach > 8, `${name} has a wedge too short to see`);
    assert.ok(wedge.reach <= CENTRE - 2, `${name} has a wedge that leaves the frame`);
    assert.ok(wedge.waist > 0, `${name} has a wedge with no width`);
  }
}


/*
 * Fitted to its tile.
 *
 * Facets radiate at whatever angles the name chooses, so the ink lands
 * wherever those angles point: drawn into a fixed frame, a mark with three
 * facets in one quadrant covered a third of it and sat off to one side, while
 * another filled it. A wall of them then read as small specks of different
 * sizes adrift by different amounts -- which is what made distinct marks look
 * like the same mark repeated. The frame is fitted to what was actually drawn,
 * so every mark carries the same weight and the same centre.
 */
function frameOf(name) {
  const elements = [];
  const doc = {
    createElementNS(_ns, tag) {
      const node = {
        tag, attributes: {}, children: [],
        setAttribute(key, value) { this.attributes[key] = String(value); },
        appendChild(child) { this.children.push(child); return child; }
      };
      elements.push(node);
      return node;
    }
  };
  const root = sigil.render(name, doc);
  const [x, y, width, height] = root.attributes.viewBox.split(/\s+/).map(Number);
  const xs = [];
  const ys = [];
  for (const node of elements) {
    if (node.tag === 'polygon') {
      for (const pair of node.attributes.points.trim().split(/\s+/)) {
        const [px, py] = pair.split(',').map(Number);
        xs.push(px);
        ys.push(py);
      }
    }
    if (node.tag === 'circle') {
      const cx = Number(node.attributes.cx);
      const cy = Number(node.attributes.cy);
      const r = Number(node.attributes.r);
      xs.push(cx - r, cx + r);
      ys.push(cy - r, cy + r);
    }
  }
  return {
    frame: { x, y, width, height },
    ink: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  };
}

for (const name of names) {
  const { frame, ink } = frameOf(name);

  /* Square, so a wide mark and a tall one are drawn at the same scale. */
  assert.equal(Math.round(frame.width), Math.round(frame.height), `${name} is drawn in a non-square frame`);

  /* Everything drawn is inside the frame. */
  assert.ok(ink.minX >= frame.x - 0.01, `${name} draws left of its frame`);
  assert.ok(ink.maxX <= frame.x + frame.width + 0.01, `${name} draws right of its frame`);
  assert.ok(ink.minY >= frame.y - 0.01, `${name} draws above its frame`);
  assert.ok(ink.maxY <= frame.y + frame.height + 0.01, `${name} draws below its frame`);

  /* And fills it: the longer side of the mark spans most of the frame, so no
     mark is a speck floating in a tile the next one fills. */
  const spans = Math.max(ink.maxX - ink.minX, ink.maxY - ink.minY) / frame.width;
  assert.ok(spans > 0.8, `${name} fills only ${Math.round(spans * 100)}% of its frame`);

  /* Centred, so a row of them sits on one line rather than wandering. */
  const offX = Math.abs((ink.minX + ink.maxX) / 2 - (frame.x + frame.width / 2)) / frame.width;
  const offY = Math.abs((ink.minY + ink.maxY) / 2 - (frame.y + frame.height / 2)) / frame.height;
  assert.ok(offX < 0.02 && offY < 0.02, `${name} is off-centre in its frame`);
}

process.stdout.write('repository sigil tests passed\n');
