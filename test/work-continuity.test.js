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
  [[1, 'completed'], [2, 'completed'], [3, 'completed'], [4, 'completed'], [5, 'completed']]
);
assert.strictEqual(state.acceptedThrough, '0f4d9983d08f2b6316e4195e2e7dddd955f207e5');
assert.strictEqual(state.completedPlans[4].acceptedThrough, '8c2e45a98708f5204c6017194ba4214d4c12e969');
assert.strictEqual(state.activePlan.number, 6);
assert.strictEqual(state.activePlan.status, 'in_progress');
assert.strictEqual(state.activePlan.tasks['1'].status, 'completed');
assert.strictEqual(state.activePlan.tasks['1'].acceptedThrough, '0d4d179e596cc8ce27e7aebe6a6f34a71acefeae');
assert.strictEqual(state.activePlan.tasks['2'].status, 'completed');
assert.strictEqual(state.activePlan.tasks['2'].acceptedThrough, 'bea3f9b209c22a7dbe98bbed6e4ee394f96177c8');
for (const [number, acceptedThrough] of [
  ['3', '13b800ac47e5fba97705bea7aafb4a0ef126764f'],
  ['4', '695ff3c7484d91a425d5797a82f06def92e78fdc'],
  ['5', '3d4163d79ae9b42187626f8e64dec123f59ce72c'],
  ['6', '2e2a452d86b8f4830b4263f13d8e23c281d17d8e'],
  ['7', state.acceptedThrough]
]) {
  assert.strictEqual(state.activePlan.tasks[number].status, 'completed');
  assert.strictEqual(state.activePlan.tasks[number].acceptedThrough, acceptedThrough);
}
for (const number of ['8', '9', '10']) {
  assert.strictEqual(state.activePlan.tasks[number].status, 'pending');
}
assert.strictEqual(state.nextAction, 'Execute Plan 6 Task 8 deterministic candidate freeze locally; do not run live, hosted, or manual gates');
assert.strictEqual(state.verification.plan6Tasks1Through7, 'passed');
assert.strictEqual(state.verification.deterministicCandidate, 'pending');
assert.strictEqual(state.verification.manualAccessibilityAudit, 'not_executed');
assert.strictEqual(state.remote.status, 'plan5_checkpoint_published');
assert.strictEqual(state.remote.repository, 'T-rex-G/Nebula-checkpoints');
assert.strictEqual(state.remote.lastPushedCommit, '0d1c9eeb3768e80baa1525f12efd35d4e76082a4');
assert.strictEqual(state.remote.lastPushedSourceCommit, '1a1807607e3d7db5ed910aa046323f39386bf73a');

console.log('work continuity tests passed');
