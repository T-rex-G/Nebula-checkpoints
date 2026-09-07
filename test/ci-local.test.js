'use strict';

/*
 * The local CI runner is only worth having if it reaches every gate the
 * workflow does. A runner that quietly misses one reports a pass for a check
 * that never ran, which is worse than not having it -- it is the same mistake
 * it exists to prevent, wearing a green tick.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readRunSteps, localise, SKIPPED, WORKFLOW } = require('../scripts/ci-local');

const source = fs.readFileSync(WORKFLOW, 'utf8');
const steps = readRunSteps(source);

/*
 * Counted independently of the parser. If the parser silently stops matching
 * -- an indentation change, a block scalar, a second job -- these disagree,
 * rather than the runner reporting a clean pass over a shorter list.
 */
const declared = (source.match(/^\s*-\s+run:/gm) || []).length;
assert.strictEqual(steps.length, declared,
  `parsed ${steps.length} run steps but the workflow declares ${declared}`);
assert(steps.length >= 10, `expected the verify job to have many gates, found ${steps.length}`);

/* Order is the contract: lint before test before packaging, as the job has it. */
const index = pattern => steps.findIndex(step => pattern.test(step));
assert(index(/npm ci\b/) === 0, 'the install step must come first');
assert(index(/run lint/) < index(/npm test/), 'lint runs before the tests');
assert(index(/npm test/) < index(/test:e2e/), 'unit tests run before the browser suite');
assert(index(/test:e2e/) < index(/package:release/), 'packaging is last');

/*
 * Every gate is either run or skipped for a stated reason. This is the
 * assertion that actually matters: a new step added to the workflow is picked
 * up by the runner without anyone editing it, and cannot be dropped silently.
 */
for (const step of steps) {
  const skip = SKIPPED.find(entry => entry.match.test(step));
  if (skip) {
    assert(typeof skip.why === 'string' && skip.why.length > 20,
      `skipping ${step} needs a stated reason`);
  }
}
const skipped = steps.filter(step => SKIPPED.some(entry => entry.match.test(step)));
assert.strictEqual(skipped.length, SKIPPED.length,
  'every declared skip must match exactly one workflow step, and no step may match two');

/*
 * The gates a change like this one is most likely to skip by hand. Named so
 * that removing any of them from the workflow is a deliberate act with a
 * failing test attached, not a silent loss of coverage.
 */
for (const required of [/run docs:check/, /run check:syntax/, /run lint/, /^npm test$/,
  /run test:migrations/, /audit-production/, /run check:secrets/, /run test:staging:gate/,
  /run test:release/, /run test:e2e/, /run package:release/]) {
  assert(steps.some(step => required.test(step)),
    `the workflow no longer runs ${required}; the local runner would stop covering it`);
}

/* The one step that is not a bare command must still be runnable locally. */
const packaging = steps.find(step => /package:release/.test(step));
assert(/\$\{RUNNER_TEMP\}|\$\{\{\s*runner\.temp\s*\}\}/.test(packaging),
  'the packaging step is expected to write to the runner temp directory');
const localised = localise(packaging, '/tmp/example-release');
assert(localised.includes('/tmp/example-release'), 'the runner temp path must be substituted');
assert(!/RUNNER_TEMP|runner\.temp/.test(localised),
  'no runner placeholder may survive into the command that is executed');

/* A parser that finds nothing must say so rather than report an empty pass. */
assert.deepStrictEqual(readRunSteps('jobs:\n  verify:\n    steps:\n      - uses: actions/checkout\n'), []);

console.log(`local CI runner tests passed (${steps.length} workflow gates, ${skipped.length} skipped with reasons)`);
