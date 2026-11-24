'use strict';

/*
 * Four node types were moved from a typed character to a drawn mark, and the
 * node builder was left copying only the character. Those four then reached the
 * canvas with no mark and no glyph, and `fillText(undefined)` paints the word
 * "undefined" in the middle of the node -- on the repository itself, which is
 * the largest node on the screen.
 *
 * The defect needed both halves to be wrong: every style must offer something
 * to draw, and the builder must carry whichever one the style offers. Both are
 * the graph model's now (features/neural/graph-model.ts), asked in
 * test/neural-graph-model.test.js. The canvas's half is asked here of the
 * drawing itself (features/neural/graph-renderer.ts), on a recording canvas.
 */

const assert = require('assert');
const { recordingCanvas, RecordedPath } = require('./helpers/recording-canvas');
const { addNode } = require('../apps/web/src/features/neural/graph-model.ts');
const { paletteFor, hexAlpha } = require('../apps/web/src/features/neural/graph-paint.ts');
const { drawNode, drawHub, drawAnimated } = require('../apps/web/src/features/neural/graph-renderer.ts');

const scene = (nodes, extra = {}) => ({
  width: 800, height: 600, dpr: 1, zoom: 1, panX: 0, panY: 0, nodes, edges: [], panels: [], panelByType: new Map(),
  layoutMode: 'split', selected: null, hover: null, focusGroup: null, highlightNodes: new Set(), highlightEdges: new Set(),
  interacting: false, ...extra
});
const node = (type, extra = {}) => {
  const map = new Map();
  return { ...addNode(map, `${type}:1`, type, `${type} one`), ...extra };
};
const NEBULA = [paletteFor('nebula', 'dark'), paletteFor('nebula', 'light')];

/* ---- The canvas never paints an absent glyph ----------------------------------------- */
{
  /* Without Path2D no icon can be drawn: the node falls back to its mark, then its letter. */
  delete globalThis.Path2D;
  const colors = paletteFor('nebula', 'dark');
  const bare = recordingCanvas();
  drawNode(bare.ctx, scene([]), node('commit', { glyph: undefined, mark: undefined }), false, colors);
  assert.deepStrictEqual(bare.named('fillText'), [], 'an absent glyph must not be passed to fillText');
  assert.ok(bare.named('arc').length > 0, 'and the node is still drawn');

  const letter = recordingCanvas();
  drawNode(letter.ctx, scene([]), node('commit', { glyph: 'C', mark: undefined }), false, colors);
  assert.deepStrictEqual(letter.named('fillText').map(entry => entry.args[0]), ['C'], 'a glyph is set as its letter');

  const marked = recordingCanvas();
  drawNode(marked.ctx, scene([]), node('snapshot', { glyph: undefined, mark: 'restore' }), false, colors);
  assert.deepStrictEqual(marked.named('fillText'), [], 'a drawn mark sets no letter');
  assert.ok(marked.named('lineTo').length >= 2, 'it is drawn as a path');
}

/*
 * ---- Translucent ink -------------------------------------------------------------------
 * The pager's "next" button painted as a filled disc with its chevron gone.
 * The light palettes hand group colours over as rgb() strings, and the
 * translucency helper returned anything it could not read as hex unchanged --
 * so the button's "faint" fill was the chevron's own solid colour.
 */
assert.strictEqual(hexAlpha('rgb(76, 29, 149)', 0.1), 'rgba(76,29,149,0.1)', 'rgb() ink must take the requested alpha');
assert.strictEqual(hexAlpha('rgba(10,20,30,.9)', 0.25), 'rgba(10,20,30,0.25)', 'rgba() ink must take the requested alpha');
assert.strictEqual(hexAlpha('#8B5CF6', 0.5), 'rgba(139,92,246,0.5)');
assert.strictEqual(hexAlpha('#abc', 1), 'rgba(170,187,204,1)');
for (const colors of [paletteFor('nebula', 'light'), paletteFor('obsidian', 'light')]) {
  const ink = colors.ink('#8B5CF6');
  assert.match(ink, /^rgb\(/, 'the light palettes darken a group\'s colour into rgb() ink');
  assert.match(hexAlpha(ink, .12), /^rgba\(\d+,\d+,\d+,0\.12\)$/, 'which still takes a translucency');
}

/*
 * ---- The hub is the product's violet mark --------------------------------------------
 * It was drawn under a blue halo, with a white highlight, a pale blue rim and a
 * white-and-blue N -- read on a phone as layers stacked on the node. On
 * Nebula nothing in it may be white or blue again; Obsidian's hub is graphite
 * and silver by design.
 */
const BANNED = ['#ffffff', '#fff', '255,255,255', '224,231,255', '191,219,254', '96,165,250', '#818cf8', '#60a5fa', '#38bdf8', '129,140,248', '56,189,248'];
const banned = colour => BANNED.some(value => String(colour).toLowerCase().replace(/\s/g, '').includes(value) && (value !== '#fff' || /^#fff$/i.test(colour)));
globalThis.Path2D = RecordedPath;
for (const colors of NEBULA) {
  for (const active of [false, true]) {
    const hub = node('repo');
    const canvas = recordingCanvas();
    drawHub(canvas.ctx, scene([hub], active ? { selected: hub } : {}), hub, colors, false);
    /* The mark itself: everything drawn before the repository's name is set. */
    const label = canvas.calls.findIndex(entry => entry.set === 'font');
    const colours = canvas.calls.slice(0, label).flatMap(entry => {
      if (entry.set === 'fillStyle' || entry.set === 'strokeStyle' || entry.set === 'shadowColor') {
        return typeof entry.value === 'string' ? [entry.value] : entry.value && entry.value.stops ? entry.value.stops.map(stop => stop[1]) : [];
      }
      return [];
    });
    assert.ok(colours.length >= 8, 'the halo, the orb, its rim and the mark are drawn');
    for (const colour of colours) assert.ok(!banned(colour), `${colors.theme}'s hub paints ${colour}`);
    assert.strictEqual(canvas.named('fill').filter(entry => entry.args[0] instanceof RecordedPath).length, 4, 'the mark is its four plates');
  }
}
for (const design of ['nebula', 'obsidian']) {
  for (const theme of ['dark', 'light']) {
    const hub = paletteFor(design, theme).hub;
    for (const key of ['halo', 'orb', 'glow', 'rim', 'rimOn', 'arc', 'arcOuter', 'light', 'deep', 'label']) {
      assert.ok(hub[key], `${design} ${theme} must say how its hub's ${key} is drawn`);
    }
  }
}
for (const colors of NEBULA) {
  for (const value of JSON.stringify(colors.hub).match(/#[0-9a-f]{3,6}\b|\d+,\d+,\d+/gi)) assert.ok(!banned(value), `Nebula's hub tone holds ${value}`);
  /* And its turning arcs. */
  const hub = node('repo');
  const canvas = recordingCanvas();
  drawAnimated(canvas.ctx, scene([hub]), 1234, colors, null, hub, { minX: -1e4, minY: -1e4, maxX: 1e4, maxY: 1e4 }, true);
  const arcs = canvas.written('strokeStyle');
  assert.ok(arcs.length >= 2, 'the arcs are drawn');
  for (const colour of arcs) assert.ok(!banned(colour), `the hub's turning arcs are ${colour}`);
}
delete globalThis.Path2D;

console.log('neural node mark tests passed');
