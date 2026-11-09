'use strict';
/*
 * How many statements still check the page by reading its source.
 *
 * Phase E rebuilds the page as React components in strict TypeScript, and
 * every line of apps/web/src changes beneath its tests. A check that reads a
 * file of the page for the text that implements a property -- a call, a
 * name, a string -- holds only as long as that text does, and says nothing
 * once it is gone. Each is replaced, as the server's were in D14, by a check
 * that asks the code: a module imported and called, the page driven in a
 * browser, or, for what neither can show, a rule over the syntax tree.
 *
 * Counted as the server's reads are (test/helpers/source-reads.js): a
 * statement reads the page when it reads a file of apps/web/src as text, uses
 * a name bound to such text, or calls a function whose body carries it. The
 * count is held to the record below, exactly. A new read fails here; a
 * converted one fails here too, until the record is lowered to match, so the
 * record always says how many remain.
 *
 * NV_PAGE_READS_LIST=1 lists them.
 */
const assert = require('node:assert/strict');
const { sourceReads } = require('./helpers/source-reads');

const RECORDED = 545;

/* A path that names the page's source, written whole or as path.join's segments. */
const PAGE_PATH = new RegExp([
  /apps\/web\/src/,
  /['"`]apps['"`]\s*,\s*['"`]web['"`]\s*,\s*['"`]src['"`]/,
  /['"`]web['"`]\s*,\s*['"`]src['"`]/
].map(pattern => pattern.source).join('|'));

const found = sourceReads(PAGE_PATH, __filename);

if (process.env.NV_PAGE_READS_LIST) console.log(found.join('\n'));
assert.equal(found.length, RECORDED,
  found.length > RECORDED
    ? `${found.length - RECORDED} more statement(s) read the page's source than the ${RECORDED} recorded; ask the page instead:\n${found.join('\n')}`
    : `${RECORDED - found.length} fewer statement(s) read the page's source than recorded: lower RECORDED to ${found.length}`);

console.log(`page reads: ${found.length} remain`);
