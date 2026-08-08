'use strict';

const assert = require('assert');
const { buildLoadPlan, percentile, readSafeJson } = require('../scripts/alpha-load');

const plan = buildLoadPlan({ testers: 5, readsPerTester: 10, mutations: 1 });
assert.strictEqual(plan.readWorkers.length, 5);
assert.strictEqual(plan.readWorkers.flat().length, 50);
assert.strictEqual(plan.mutations.length, 1);
assert(Object.isFrozen(plan));
assert.throws(() => buildLoadPlan({ testers: 6, readsPerTester: 10, mutations: 1 }), /maximum 5/);
assert.throws(() => buildLoadPlan({ testers: 5, readsPerTester: 11, mutations: 1 }), /maximum 10/);
assert.throws(() => buildLoadPlan({ testers: 5, readsPerTester: 10, mutations: 2 }), /one mutation/);
assert.strictEqual(percentile([10, 40, 20, 30], 0.5), 20);
assert.strictEqual(percentile([10, 40, 20, 30], 0.95), 40);

(async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 100) return controller.close();
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() { cancelled = true; }
  });
  const parsed = await readSafeJson(new Response(body));
  assert.strictEqual(parsed, null);
  assert(pulls <= 66, `bounded JSON reader consumed ${pulls} KiB`);
  assert.strictEqual(cancelled, true);
  console.log('alpha load planner tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
