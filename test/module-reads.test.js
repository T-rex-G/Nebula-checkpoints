'use strict';
/*
 * How many statements still check the server by reading a module's source.
 *
 * D14 replaces the checks that read the server's source for the text that
 * implements a property with checks that ask the code itself: a module's
 * functions called with what they are handed, the composed server asked
 * through HTTP, or, for what neither can show, a rule over the syntax tree.
 * The composition's wiring is no longer read at all
 * (test/composition-reads.test.js). This counts what is left of the
 * modules': a statement reads a module when it reads a file of the server's
 * source -- apps/api/src, the CommonJS modules in src, or the contracts in
 * packages/contracts/src -- as text, uses a name bound to such text, or
 * calls a function whose body carries it, such as one that slices a route's
 * block out of its file.
 *
 * Found by the syntax tree, so a comment or a string that merely names a
 * module reads nothing. A file is a module's when the path it is read from
 * names one, directly or through a constant or a reader function of the same
 * file. Loading a module with require() reads nothing: that is asking it.
 *
 * The count is held to the record below, exactly. A new read fails here; a
 * converted one fails here too, until the record is lowered to match, so the
 * record always says how many remain. D14's fifteenth step brought it to none,
 * so the record now holds that no check of the server reads its text again.
 */
const assert = require('node:assert/strict');
const { sourceReads } = require('./helpers/source-reads');

const RECORDED = 0;

/*
 * A path that names the server's source, written whole or as path.join's
 * segments: apps/api/src, the contracts' packages/contracts/src, or src at
 * the tree's root -- never another app's src, such as the page's.
 */
const SERVER_PATH = new RegExp([
  /apps\/api\/src/,
  /['"`]apps['"`]\s*,\s*['"`]api['"`]\s*,\s*['"`]src['"`]/,
  /packages\/contracts\/src/,
  /['"`]packages['"`]\s*,\s*['"`]contracts['"`]/,
  /['"`](?:\.\.\/|\.\/)?src\//,
  /(?:\broot|\bROOT|__dirname\s*,\s*['"`]\.\.['"`])\s*,\s*['"`]src['"`]/
].map(pattern => pattern.source).join('|'));

const found = sourceReads(SERVER_PATH, __filename);

if (process.env.NV_MODULE_READS_LIST) console.log(found.join('\n'));
assert.equal(found.length, RECORDED,
  found.length > RECORDED
    ? `${found.length - RECORDED} more statement(s) read a module's source than the ${RECORDED} recorded; ask the module instead:\n${found.join('\n')}`
    : `${RECORDED - found.length} fewer statement(s) read a module's source than recorded: lower RECORDED to ${found.length}`);

console.log(`module reads: ${found.length} remain`);
