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
assert.strictEqual(state.activePlan.number, 3);
assert.strictEqual(state.activePlan.status, 'completed');
assert.strictEqual(state.activePlan.tasks['3'].status, 'completed');
for (const number of ['4', '5', '6', '7']) {
  assert.strictEqual(state.activePlan.tasks[number].status, 'completed');
}
assert.strictEqual(state.nextAction, 'Create and push the private recovery remote after GitHub authentication');
assert.strictEqual(state.remote.status, 'blocked_authentication');

console.log('work continuity tests passed');
