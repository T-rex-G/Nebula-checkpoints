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
 * test/neural-graph-model.test.js; the canvas's half stays here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'visualizations', 'neural.js'), 'utf8');

/*
 * That every style offers exactly one thing to draw, and that every node the
 * builder makes carries it, is asked of the builder itself
 * (test/neural-graph-model.test.js). What the canvas does with an absent
 * letter is still the drawing's, read below.
 */

/* And the canvas must never be asked to paint an absent glyph. */
assert(
  /else if \(node\.glyph\) \{/.test(source),
  'an absent glyph must not be passed to fillText'
);
assert(
  !/\}\s*else \{\s*ctx\.font = `\$\{Math\.max\(7, radius/.test(source),
  'the unguarded glyph branch must be gone'
);

/*
 * The pager's "next" button painted as a filled disc with its chevron gone.
 * The light palettes hand group colours over as rgb() strings, and the
 * translucency helper returned anything it could not read as hex unchanged --
 * so the button's "faint" fill was the chevron's own solid colour. Evaluated
 * here from the source, so the check is on the function the page runs.
 */
const helper = source.match(/function hexAlpha\(hex, alpha\) \{[\s\S]*?\n  \}\n/);
assert(helper, 'neural.js must define hexAlpha');
const hexAlpha = new Function(`${helper[0]}; return hexAlpha;`)();
assert.strictEqual(hexAlpha('rgb(76, 29, 149)', 0.1), 'rgba(76,29,149,0.1)', 'rgb() ink must take the requested alpha');
assert.strictEqual(hexAlpha('rgba(10,20,30,.9)', 0.25), 'rgba(10,20,30,0.25)', 'rgba() ink must take the requested alpha');
assert.strictEqual(hexAlpha('#8B5CF6', 0.5), 'rgba(139,92,246,0.5)');
assert.strictEqual(hexAlpha('#abc', 1), 'rgba(170,187,204,1)');

/*
 * The repository hub is the product's violet mark. It was drawn under a blue
 * halo, with a white highlight, a pale blue rim and a white-and-blue N -- read
 * on a phone as layers stacked on the node. Nothing in it may be white or
 * blue again.
 */
const hub = source.match(/function drawHub\([\s\S]*?\n  \}\n/);
assert(hub, 'neural.js must define drawHub');
const hubBody = hub[0].slice(0, hub[0].indexOf("The repository's name"));
for (const banned of ['#ffffff', '#fff\'', '255,255,255', '224,231,255', '191,219,254', '96,165,250', '#818cf8', '#60a5fa', '#38bdf8']) {
  assert(!hubBody.toLowerCase().includes(banned), `the hub still paints ${banned}`);
}
/* Its colours come from the preset's palette; Nebula's two (dark and light)
 * are violet only. Obsidian's hub is graphite and silver by design. */
const hubTones = [...source.matchAll(/hub: \{[\s\S]*?\n\s*\}/g)].map(match => match[0]);
assert.strictEqual(hubTones.length, 4, 'every palette must say how its hub is drawn');
for (const tone of hubTones.slice(0, 2)) {
  for (const banned of ['#fff', '255,255,255', '224,231,255', '191,219,254', '96,165,250', '#818cf8', '#60a5fa', '#38bdf8']) {
    assert(!tone.toLowerCase().includes(banned), `Nebula's hub still paints ${banned}`);
  }
}
const arcs = source.slice(source.indexOf('if (hub) {'), source.indexOf('if (hub) {') + 900);
assert(!/818cf8|60a5fa|38bdf8/i.test(arcs), 'the hub\'s turning arcs are still blue');

console.log('neural node mark tests passed');
