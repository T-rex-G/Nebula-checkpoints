'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = execFileSync(
  process.execPath,
  [path.join(root, 'scripts', 'resume-work.js'), '--json'],
  { cwd: root, encoding: 'utf8' }
);
const state = JSON.parse(output);
const sourceControlExpected = fs.existsSync(path.join(root, '.git'));

assert.strictEqual(state.schemaVersion, 1);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.sourceControlAvailable, sourceControlExpected);
if (sourceControlExpected) {
  assert.strictEqual(state.branch, 'public-alpha/alpha17-foundation');
  assert.match(state.currentHead, /^[0-9a-f]{40}$/);
  assert.strictEqual(typeof state.worktreeClean, 'boolean');
  assert.strictEqual(state.acceptedBoundaryValid, true);
} else {
  assert.strictEqual(state.branch, null);
  assert.strictEqual(state.currentHead, null);
  assert.strictEqual(state.worktreeClean, null);
  assert.strictEqual(state.acceptedBoundaryValid, null);
}
assert(Array.isArray(state.dirtyPaths));
assert(state.dirtyPaths.every(file => !file.startsWith('ORK_CONTINUITY')),
  'porcelain paths must preserve their first character');
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
assert.strictEqual(state.nextAction, 'Re-freeze Plan 6 Task 8 after the exact-target authorization correction; do not run live, hosted, or manual gates');
assert.strictEqual(state.verification.plan6Tasks1Through7, 'passed');
assert.strictEqual(state.verification.deterministicCandidate, 'pending_refreeze_after_target_binding_correction');
assert.strictEqual(state.verification.liveTargetAuthorization, 'focused_contracts_passed_node_22_23_1');
assert.strictEqual(state.verification.manualAccessibilityAudit, 'not_executed');
assert.deepStrictEqual(state.correctiveRefreeze, {
  reason: 'live_target_authorization_binding',
  acceptedThrough: 'f6ba0a4fc6587863125ee56d997825c248b04dca',
  releaseTestAcceptedThrough: '114062fc9d77348922ea78bb4189f8c6fae7ae69',
  archiveContinuityAcceptedThrough: '2c614633c82a9400d1f2d18420135ccaf2c272be',
  archiveTestAcceptedThrough: '9efa0250e57f9d5272e57d664fe70e56f8173922',
  authorizationSchema: '1.1.0',
  previousCandidateSha256: 'd686c037e33524688357e2480b92fa12717a3fc496c90375437e9329e7c54707',
  previousCandidateStatus: 'invalidated',
  intermediateCandidateSha256: '1b90c3cd28679f2f3d2ccc06daef93ea184921482132874d870c40a5f3837333',
  intermediateCandidateStatus: 'invalidated_by_extraction_test_defect',
  matrixCandidateSha256: '55f3db62528df3b06d1a8ddd2818d7109f8f7affa9ce0ea08a927297e2bbe66e',
  matrixCandidateStatus: 'invalidated_by_archive_continuity_defect',
  archiveTestCandidateSha256: '19b620e0c85126f2972ed9a47a560dd5643668180172119ea731c6cead61ad67',
  archiveTestCandidateStatus: 'invalidated_by_archive_test_expectation_defect'
});
assert.strictEqual(state.verification.freshExtractionReleaseTest, 'passed_node_22_23_1');
assert.strictEqual(state.verification.freshExtractionMatrix, 'pending_refreeze_after_archive_continuity_correction');
assert.strictEqual(state.remote.status, 'plan6_sandbox_checkpoint_published_refreeze_pending');
assert.strictEqual(state.remote.repository, 'T-rex-G/Nebula-checkpoints');
assert.strictEqual(state.remote.branch, 'sandbox/alpha17-live-qualification');
assert.strictEqual(state.remote.lastPushedCommit, 'b593cda334898ad76fea0d6764465e0509e66c20');
assert.strictEqual(state.remote.lastPushedSourceCommit, 'bc489506427ee8d736f6580f6d2700791921ceee');

const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-continuity-archive-'));
try {
  fs.mkdirSync(path.join(archiveRoot, 'scripts'));
  fs.copyFileSync(path.join(root, 'WORK_CONTINUITY.json'), path.join(archiveRoot, 'WORK_CONTINUITY.json'));
  fs.copyFileSync(
    path.join(root, 'scripts', 'resume-work.js'),
    path.join(archiveRoot, 'scripts', 'resume-work.js')
  );
  const archiveOutput = execFileSync(
    process.execPath,
    [path.join(archiveRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: archiveRoot, encoding: 'utf8' }
  );
  const archiveState = JSON.parse(archiveOutput);
  assert.strictEqual(archiveState.sourceControlAvailable, false);
  assert.strictEqual(archiveState.branch, null);
  assert.strictEqual(archiveState.currentHead, null);
  assert.strictEqual(archiveState.acceptedBoundaryValid, null);
  assert.strictEqual(archiveState.worktreeClean, null);
  assert.deepStrictEqual(archiveState.dirtyPaths, []);
} finally {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
}

console.log('work continuity tests passed');
