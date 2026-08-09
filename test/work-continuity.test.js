'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
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
const activeBranch = sourceControlExpected
  ? execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
  : '';

assert.strictEqual(state.schemaVersion, 1);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.sourceControlAvailable, sourceControlExpected);
if (sourceControlExpected) {
  assert.strictEqual(state.branch, activeBranch || null);
  if (activeBranch) assert.strictEqual(activeBranch, 'public-alpha/alpha17-foundation');
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
assert.strictEqual(
  state.nextAction,
  'Publish the full-history qualification checkout correction to the isolated sandbox branch, rebuild the exact candidate, and rerun GitHub-only qualification; do not run GitLab, Gitea, hosted, or manual gates'
);
assert.strictEqual(state.verification.plan6Tasks1Through7, 'passed');
assert.strictEqual(state.verification.deterministicCandidate, 'pending_refreeze_after_full_history_checkout_correction');
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
  archiveTestCandidateStatus: 'invalidated_by_archive_test_expectation_defect',
  failedQualificationCandidateSha256: '95c9cc2ef96b02874b8592baaa4e56b398e22328ea77103cd6c6b244ecc1d05e',
  failedQualificationCandidateStatus: 'invalidated_by_detached_checkout_continuity_contract',
  failedQualificationRunId: '31290968279',
  detachedCheckoutCorrectionStatus: 'published_and_retried',
  detachedCheckoutCorrectionCommit: '7f721a770df8e658e00163e05ebc259502f99c09',
  shallowQualificationCandidateSha256: '5c84836bee1ed6dec30591285a05a38f5a0078d1280e75b4585be245e61f1887',
  shallowQualificationCandidateStatus: 'invalidated_by_shallow_checkout_history',
  shallowQualificationRunId: '31314330832',
  shallowCheckoutCorrectionStatus: 'pending_publication'
});
assert.strictEqual(state.verification.freshExtractionReleaseTest, 'passed_node_22_23_1');
assert.strictEqual(state.verification.freshExtractionMatrix, 'pending_refreeze_after_full_history_checkout_correction');
assert.strictEqual(
  state.verification.detachedCheckoutContinuity,
  'passed_full_history_locally_failed_in_shallow_hosted_checkout'
);
assert.strictEqual(
  state.verification.qualificationRun31290968279,
  'failed_pre_authorization_detached_checkout_continuity_contract_live_jobs_skipped'
);
assert.strictEqual(
  state.verification.qualificationRun31314330832,
  'failed_pre_authorization_shallow_checkout_history_live_jobs_skipped'
);
assert.strictEqual(
  state.verification.qualificationCheckoutHistory,
  'fetch_depth_2_confirmed_incompatible_with_accepted_boundary_ancestry'
);
assert.strictEqual(
  state.remote.status,
  'github_qualification_failed_pre_authorization_shallow_history_correction_pending_publication'
);
assert.strictEqual(state.remote.repository, 'T-rex-G/Nebula-checkpoints');
assert.strictEqual(state.remote.branch, 'sandbox/alpha17-live-qualification');
assert.strictEqual(state.remote.lastPushedCommit, '7f721a770df8e658e00163e05ebc259502f99c09');
assert.strictEqual(state.remote.lastPushedSourceCommit, 'a696fea4a1201a2c0b5526648083f1fc43ef1ccb');

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

const detachedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-continuity-detached-'));
try {
  fs.mkdirSync(path.join(detachedRoot, 'scripts'));
  fs.writeFileSync(path.join(detachedRoot, 'seed.txt'), 'seed\n');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: detachedRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'seed.txt'], { cwd: detachedRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=Nebulaverse Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'seed'],
    { cwd: detachedRoot, stdio: 'ignore' }
  );
  const acceptedThrough = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: detachedRoot, encoding: 'utf8' }
  ).trim();
  const detachedFixture = {
    ...JSON.parse(fs.readFileSync(path.join(root, 'WORK_CONTINUITY.json'), 'utf8')),
    branch: 'main',
    acceptedThrough
  };
  fs.copyFileSync(
    path.join(root, 'scripts', 'resume-work.js'),
    path.join(detachedRoot, 'scripts', 'resume-work.js')
  );
  fs.writeFileSync(
    path.join(detachedRoot, 'WORK_CONTINUITY.json'),
    `${JSON.stringify(detachedFixture, null, 2)}\n`
  );
  execFileSync('git', ['add', 'WORK_CONTINUITY.json', 'scripts/resume-work.js'], {
    cwd: detachedRoot,
    stdio: 'ignore'
  });
  execFileSync(
    'git',
    ['-c', 'user.name=Nebulaverse Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture'],
    { cwd: detachedRoot, stdio: 'ignore' }
  );
  execFileSync('git', ['checkout', '-b', 'unexpected'], { cwd: detachedRoot, stdio: 'ignore' });
  const namedBranchMismatch = spawnSync(
    process.execPath,
    [path.join(detachedRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: detachedRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(namedBranchMismatch.status, 0);
  assert.match(namedBranchMismatch.stderr, /Continuity branch mismatch: expected main, found unexpected/);
  execFileSync('git', ['checkout', 'main'], { cwd: detachedRoot, stdio: 'ignore' });
  const detachedHead = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: detachedRoot, encoding: 'utf8' }
  ).trim();
  execFileSync('git', ['checkout', '--detach', detachedHead], { cwd: detachedRoot, stdio: 'ignore' });

  const detachedOutput = execFileSync(
    process.execPath,
    [path.join(detachedRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: detachedRoot, encoding: 'utf8' }
  );
  const detachedState = JSON.parse(detachedOutput);
  assert.strictEqual(detachedState.sourceControlAvailable, true);
  assert.strictEqual(detachedState.branch, null);
  assert.strictEqual(detachedState.currentHead, detachedHead);
  assert.strictEqual(detachedState.acceptedBoundaryValid, true);
  assert.strictEqual(detachedState.worktreeClean, true);
  assert.deepStrictEqual(detachedState.dirtyPaths, []);

  const detachedHumanOutput = execFileSync(
    process.execPath,
    [path.join(detachedRoot, 'scripts', 'resume-work.js')],
    { cwd: detachedRoot, encoding: 'utf8' }
  );
  assert.match(detachedHumanOutput, /^Source control: available$/m);
  assert.match(detachedHumanOutput, /^Branch: detached HEAD$/m);

  const gitIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Nebulaverse Test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Nebulaverse Test',
    GIT_COMMITTER_EMAIL: 'test@localhost'
  };
  const unrelatedHead = execFileSync(
    'git',
    ['commit-tree', `${detachedHead}^{tree}`],
    { cwd: detachedRoot, encoding: 'utf8', input: 'unrelated root\n', env: gitIdentity }
  ).trim();
  execFileSync('git', ['checkout', '--detach', unrelatedHead], { cwd: detachedRoot, stdio: 'ignore' });
  const unrelatedBoundary = spawnSync(
    process.execPath,
    [path.join(detachedRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: detachedRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(unrelatedBoundary.status, 0);
  assert.match(unrelatedBoundary.stderr, /Accepted continuity boundary is not an ancestor of HEAD/);
} finally {
  fs.rmSync(detachedRoot, { recursive: true, force: true });
}

console.log('work continuity tests passed');
