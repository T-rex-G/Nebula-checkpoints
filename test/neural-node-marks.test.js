'use strict';

/*
 * Four node types were moved from a typed character to a drawn mark, and the
 * node builder was left copying only the character. Those four then reached the
 * canvas with no mark and no glyph, and `fillText(undefined)` paints the word
 * "undefined" in the middle of the node -- on the repository itself, which is
 * the largest node on the screen.
 *
 * Two assertions, because the defect needed both halves to be wrong: every
 * style must offer something to draw, and the builder must carry whichever one
 * the style offers.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'neural.js'), 'utf8');

const tableStart = source.indexOf('TYPE_STYLE');
assert(tableStart > 0, 'neural.js must define a node style table');
const tableEnd = source.indexOf('};', tableStart);
assert(tableEnd > tableStart, 'the node style table must be bounded');
const table = source.slice(tableStart, tableEnd);

const rows = [...table.matchAll(/^\s{4}([a-z]+):\s*\{([^}]*)\}/gm)].map(match => ({
  type: match[1],
  body: match[2]
}));
assert(rows.length >= 15, `expected the full node style table, found ${rows.length} rows`);

const withMark = [];
for (const row of rows) {
  const hasMark = /\bmark:\s*'/.test(row.body);
  const hasGlyph = /\bglyph:\s*'/.test(row.body);
  assert(
    hasMark || hasGlyph,
    `node type ${row.type} has neither a drawn mark nor a glyph, so it would render as nothing or as text`
  );
  assert(!(hasMark && hasGlyph), `node type ${row.type} declares both a mark and a glyph`);
  if (hasMark) withMark.push(row.type);
}
assert(withMark.length >= 4, `expected the drawn-mark node types, found ${withMark.join(', ') || 'none'}`);
for (const type of ['repo', 'snapshot', 'safety', 'scan']) {
  assert(withMark.includes(type), `${type} must keep its drawn mark`);
}

/* The builder has to carry the mark, or a marked type arrives at the canvas
 * with nothing to draw. */
assert(
  /color: st\.color, glyph: st\.glyph, mark: st\.mark, r: st\.radius/.test(source),
  'the node builder must copy the drawn mark alongside the glyph'
);

/* And the canvas must never be asked to paint an absent glyph. */
assert(
  /else if \(node\.glyph\) \{/.test(source),
  'an absent glyph must not be passed to fillText'
);
assert(
  !/\}\s*else \{\s*ctx\.font = `\$\{Math\.max\(7, radius/.test(source),
  'the unguarded glyph branch must be gone'
);

console.log('neural node mark tests passed');
