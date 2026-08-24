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

process.stdout.write('repository sigil tests passed\n');
