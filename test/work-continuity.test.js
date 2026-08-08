'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = execFileSync(
  process.execPath,
  [path.join(root, 'scripts', 'resume-work.js'), '--json'],
  { cwd: root, encoding: 'utf8' }
);
const state = JSON.parse(output);

assert.strictEqual(state.schemaVersion, 1);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.branch, 'public-alpha/alpha17-foundation');
assert.match(state.currentHead, /^[0-9a-f]{40}$/);
assert.strictEqual(typeof state.worktreeClean, 'boolean');
assert(Array.isArray(state.dirtyPaths));
assert(state.dirtyPaths.every(file => !file.startsWith('ORK_CONTINUITY')),
  'porcelain paths must preserve their first character');
assert.strictEqual(state.acceptedBoundaryValid, true);
assert.deepStrictEqual(
  state.completedPlans.map(plan => [plan.number, plan.status]),
  [[1, 'completed'], [2, 'completed'], [3, 'completed'], [4, 'completed']]
);
assert.strictEqual(state.acceptedThrough, 'aacb808d96587d61b795bfc98e8bdefc8367bfc6');
assert.strictEqual(state.completedPlans[3].acceptedThrough, state.acceptedThrough);
assert.strictEqual(state.activePlan.number, 5);
assert.strictEqual(state.activePlan.status, 'in_progress');
for (const number of ['1', '2', '3', '4', '5', '6', '7', '8']) {
  assert.strictEqual(state.activePlan.tasks[number].status, 'pending');
}
assert.strictEqual(state.nextAction, 'Request explicit approval to publish the accepted Plan 4 checkpoint, then execute Plan 5 Task 1 locally');
assert.strictEqual(state.verification.browserMatrixDesktopAndMobile, '56_passed');
assert.strictEqual(state.verification.manualAccessibilityAudit, 'not_executed');
assert.strictEqual(state.remote.status, 'checkpoint_pending_approval');
assert.strictEqual(state.remote.repository, 'T-rex-G/Nebula-checkpoints');
assert.strictEqual(state.remote.lastPushedSourceCommit, '2d1aacd');

console.log('work continuity tests passed');
