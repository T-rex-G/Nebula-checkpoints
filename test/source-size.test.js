'use strict';
/*
 * How long a file of the server may be.
 *
 * A file of the server's source -- apps/api/src, and the contracts in
 * packages/contracts/src -- holds at most 800 lines. The few that are longer
 * are recorded in test/oracles/source-sizes.json, each with the length it may
 * not exceed and why it is that long: an engine that is one algorithm, or a
 * file still to be divided. A recorded file may shrink but not grow, and one
 * that falls within the limit leaves the record, so the record only ever
 * names files that are long now.
 *
 * Lines are counted from the syntax tree's line map, as the editor counts
 * them.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const LIMIT = 800;
const RECORD = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracles', 'source-sizes.json'), 'utf8'));
const REASONS = new Set(['engine', 'to divide']);

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}
const linesOf = file => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return source.getLineAndCharacterOfPosition(source.end).line;
};

const sizes = new Map(['apps/api/src', 'packages/contracts/src']
  .flatMap(root => sources(path.join(ROOT, root)))
  .map(file => [path.relative(ROOT, file).split(path.sep).join('/'), linesOf(file)]));
assert(sizes.size > 250, `the server's files are found (${sizes.size})`);

const over = [];
for (const [file, lines] of sizes) {
  const recorded = RECORD.files[file];
  if (!recorded && lines > LIMIT) over.push(`${file}: ${lines} lines, over the ${LIMIT} a file may hold`);
  if (recorded && lines > recorded.lines) over.push(`${file}: ${lines} lines, over the ${recorded.lines} recorded`);
}
assert.deepEqual(over, [], 'divide the file, or keep it within its length');

const stale = Object.entries(RECORD.files).flatMap(([file, recorded]) => {
  if (!REASONS.has(recorded.reason)) return [`${file}: the reason "${recorded.reason}" is not one the record knows`];
  if (!sizes.has(file)) return [`${file}: recorded but gone`];
  if (sizes.get(file) <= LIMIT) return [`${file}: ${sizes.get(file)} lines, within the limit -- it leaves the record`];
  return [];
});
assert.deepEqual(stale, [], 'the record names only files that are long now');
assert.equal(RECORD.limit, LIMIT);

console.log(`source size: ${sizes.size} files, ${Object.keys(RECORD.files).length} recorded above ${LIMIT} lines`);
