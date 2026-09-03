'use strict';

/*
 * A zip of more than a hundred files used to be accepted by the browser, queued
 * as a single batch, uploaded blob by blob, and only then refused by the server
 * -- which commits at most a hundred operations at once. Every one of those
 * uploads was wasted, and the failure arrived at the end of the wait rather
 * than the start of it.
 *
 * These assertions hold the two limits together and hold the plan to the truth
 * about how many commits a queue will actually take.
 */

const assert = require('assert');

let planning = {};
try { planning = require('../public/upload-planning'); } catch { /* asserted below */ }
for (const name of ['MAX_BATCH_ITEMS', 'planBatchCommits']) {
  assert(planning[name], `${name} must be implemented`);
}
const { MAX_BATCH_ITEMS, planBatchCommits } = planning;

const { ACTION_EXECUTION_CONTRACTS, normalizeFileBatch } = require('../src/mutation-coverage');

/* The drift guard. The browser plans against this number before it uploads
 * anything, so if the server's own limit moves and this one does not, the queue
 * goes back to being refused after the work rather than before it. */
assert.strictEqual(
  MAX_BATCH_ITEMS,
  ACTION_EXECUTION_CONTRACTS['file.batch'].maxItems,
  'the browser batch limit must equal the server file.batch limit'
);

/* And the server really does refuse one more than that, so the number is the
 * real boundary rather than a number that merely matches another number. */
const atLimit = Array.from({ length: MAX_BATCH_ITEMS }, (_, index) => ({ op: 'put', path: `f${index}.txt`, content: 'x' }));
assert.strictEqual(normalizeFileBatch(atLimit).items.length, MAX_BATCH_ITEMS);
assert.throws(
  () => normalizeFileBatch([...atLimit, { op: 'put', path: 'one-too-many.txt', content: 'x' }]),
  error => error.code === 'MUTATION_BATCH_SIZE',
  'the server must refuse one operation beyond the limit the browser plans against'
);

/* A queue that fits is one commit, and says so. */
const fits = planBatchCommits(MAX_BATCH_ITEMS);
assert.strictEqual(fits.commits, 1);
assert.strictEqual(fits.atomic, true);
assert.deepStrictEqual(fits.groups.map(group => group.size), [MAX_BATCH_ITEMS]);

/* A queue that does not fit is more than one commit, and says that too rather
 * than letting "all as one commit" stand. */
const overflows = planBatchCommits(MAX_BATCH_ITEMS + 1);
assert.strictEqual(overflows.commits, 2);
assert.strictEqual(overflows.atomic, false);
assert.deepStrictEqual(overflows.groups.map(group => group.size), [MAX_BATCH_ITEMS, 1]);

/* Every file is planned exactly once, with no gap and no overlap. */
for (const count of [1, 7, 99, 100, 101, 150, 250, 500]) {
  const plan = planBatchCommits(count);
  assert.strictEqual(plan.total, count);
  assert.strictEqual(
    plan.groups.reduce((sum, group) => sum + group.size, 0),
    count,
    `plan for ${count} files must cover every file`
  );
  let cursor = 0;
  for (const group of plan.groups) {
    assert.strictEqual(group.start, cursor, `plan for ${count} files must not skip or repeat a file`);
    assert(group.size >= 1 && group.size <= MAX_BATCH_ITEMS, `group of ${group.size} exceeds one commit`);
    cursor = group.end;
  }
  assert.strictEqual(cursor, count);
  assert.strictEqual(plan.commits, Math.ceil(count / MAX_BATCH_ITEMS));
}

const empty = planBatchCommits(0);
assert.strictEqual(empty.commits, 0);
assert.deepStrictEqual(empty.groups, []);

assert.throws(() => planBatchCommits(-1), TypeError);
assert.throws(() => planBatchCommits(1.5), TypeError);
assert.throws(() => planBatchCommits(10, 0), TypeError);

console.log('upload planning tests passed');
