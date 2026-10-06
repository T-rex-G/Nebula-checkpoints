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
for (const skip of SKIPPED) assert(steps.some(step => skip.match.test(step)), 'every skip rule must match an actual provisioning step');
for (const step of steps) assert(SKIPPED.filter(skip => skip.match.test(step)).length <= 1,
  'no workflow step may match two skip rules');
assert(skipped.every(step => /^npm ci$|^bash ci\/install-(?:browser|postgres-client)\.sh(?:\s|$)|^npx playwright install/.test(step)),
  'only provisioning may be skipped; integration and database gates must execute');

/*
 * The gates a change like this one is most likely to skip by hand. Named so
 * that removing any of them from the workflow is a deliberate act with a
 * failing test attached, not a silent loss of coverage.
 */
for (const required of [/run docs:check/, /run check:syntax/, /run lint/, /^npm test$/,
  /run test:migrations/, /run test:database-resilience/, /run test:restore-integration/, /run test:integration/, /audit-production/, /run check:secrets/, /run test:staging:gate/,
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

/*
 * Type checking is worth having only if it is reported before the gates that
 * cost minutes. A type error found after fifteen minutes of Playwright has
 * been paid for at the wrong price, so the order is part of the contract
 * rather than a preference about how the file reads.
 */
const typecheckAt = steps.findIndex(step => /run typecheck/.test(step));
assert(typecheckAt >= 0, 'the workflow must type-check');
for (const expensive of [/run test:e2e/, /install-browser/, /run package:release/]) {
  const at = steps.findIndex(step => expensive.test(step));
  assert(
    at === -1 || typecheckAt < at,
    `type checking must run before ${expensive}: seconds of feedback are worth nothing after minutes of it`
  );
}

/*
 * The browser suite runs as parallel slices. Three things keep that honest:
 * the slices together are the whole suite, no browser time is spent before the
 * fast gates pass, and nothing is packaged until every slice has passed.
 */
function job(name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert(start >= 0, `the workflow has no ${name} job`);
  const rest = source.slice(start + name.length + 5);
  const next = rest.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}
const browserJob = job('browser');
const shards = /shard:\s*\[([^\]]+)\]/.exec(browserJob);
assert(shards, 'the browser job must declare its slices');
const slices = shards[1].split(',').map(value => Number(value.trim()));
assert.deepStrictEqual(slices, slices.map((_, at) => at + 1), 'slices must be numbered 1..n with none missing');
assert(browserJob.includes(`NV_E2E_SHARD: \${{ matrix.shard }}/${slices.length}`),
  'every slice must name the same total as the matrix has slices, or part of the suite never runs');
assert(/run: npm run test:e2e/.test(browserJob), 'the slices must run the same command a local run does');
assert(/fail-fast: false/.test(browserJob), 'one slice failing must not cancel the others');
assert(/^    needs: verify$/m.test(browserJob), 'browser time is spent only after the fast gates pass');
assert(!/run test:e2e/.test(job('verify')), 'the single-worker suite must not come back to the verify job');
assert(/^    needs: \[verify, browser\]$/m.test(job('release')), 'packaging waits for every gate and every slice');
assert(/run package:release/.test(job('release')), 'the release job packages');

/* The config reads the slice; unset it is the whole suite, malformed it refuses to run. */
const { execFileSync } = require('child_process');
const shardOf = value => execFileSync(process.execPath, ['-e',
  "process.stdout.write(JSON.stringify(require('./playwright.config').shard))"],
{ cwd: path.join(__dirname, '..'), env: { ...process.env, NV_E2E_SHARD: value }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
assert.strictEqual(shardOf(''), 'null');
assert.deepStrictEqual(JSON.parse(shardOf('3/4')), { current: 3, total: 4 });
for (const malformed of ['5/4', '0/4', '2', 'all', '1/4 ']) {
  assert.throws(() => shardOf(malformed), `NV_E2E_SHARD=${JSON.stringify(malformed)} must stop the run`);
}

/* A parser that finds nothing must say so rather than report an empty pass. */
assert.deepStrictEqual(readRunSteps('jobs:\n  verify:\n    steps:\n      - uses: actions/checkout\n'), []);

console.log(`local CI runner tests passed (${steps.length} workflow gates, ${skipped.length} skipped with reasons)`);
