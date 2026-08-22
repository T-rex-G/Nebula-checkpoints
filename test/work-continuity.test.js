'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'resume-work.js');
const { validateHistoryResult } = require('../scripts/resume-work');
const {
  renderContinuationPrompt,
  renderProjectState,
  validateContinuity
} = require('../src/work-continuity');

const continuityDocument = JSON.parse(fs.readFileSync(path.join(root, 'WORK_CONTINUITY.json'), 'utf8'));
assert.throws(
  () => validateContinuity({ ...continuityDocument, gates: null }),
  error => error instanceof Error && error.message === 'WORK_CONTINUITY.json is invalid',
  'a null gates object must fail through the continuity validator instead of throwing a TypeError'
);

assert.throws(
  () => validateHistoryResult(
    { status: 9, stdout: '', stderr: 'synthetic history failure' },
    { commits: [{ role: 'local-source', commit: 'a'.repeat(40) }, { role: 'published', commit: 'b'.repeat(40) }] },
    'c'.repeat(40)
  ),
  /Git history discovery failed.*exit 9.*synthetic history failure/i
);
assert.strictEqual(
  validateHistoryResult(
    { status: 0, stdout: `${'a'.repeat(40)}\t${'c'.repeat(40)}\n`, stderr: '' },
    { commits: [{ role: 'local-source', commit: 'a'.repeat(40) }, { role: 'published', commit: 'b'.repeat(40) }] },
    'c'.repeat(40)
  ),
  'a'.repeat(40)
);
assert.strictEqual(
  validateHistoryResult(
    { status: 0, stdout: `${'b'.repeat(40)}\t${'c'.repeat(40)}\n`, stderr: '' },
    { commits: [{ role: 'local-source', commit: 'a'.repeat(40) }, { role: 'published', commit: 'b'.repeat(40) }] },
    'c'.repeat(40)
  ),
  'b'.repeat(40),
  'the recorded published commit with the accepted tree must satisfy continuity'
);
assert.strictEqual(validateHistoryResult(
  { status: 0, stdout: `${'d'.repeat(40)}\t${'c'.repeat(40)}\n`, stderr: '' },
  { commits: [{ role: 'local-source', commit: 'a'.repeat(40) }, { role: 'published', commit: 'b'.repeat(40) }] },
  'c'.repeat(40)
), null, 'an unrelated commit with the accepted tree must not satisfy continuity');

const output = execFileSync(process.execPath, [scriptPath, '--json'], { cwd: root, encoding: 'utf8' });
const state = JSON.parse(output);
const serialized = JSON.stringify(state);
const sourceControlExpected = fs.existsSync(path.join(root, '.git'));

assert.strictEqual(state.schemaVersion, 5);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.version, '5.3.0-alpha.17.0');
assert.strictEqual(state.acceptedTree, 'b0945a403beaa4c4242a1d6526aa7c3d80d48f08');
assert.strictEqual(Object.hasOwn(state, 'acceptedThrough'), false);
assert.deepStrictEqual(state.recordedBaseline, {
  repository: 'T-rex-G/Nebula-checkpoints',
  branch: 'agent/alpha17-evidence-integrity',
  pullRequest: 1,
  commits: [
    { role: 'branch-head', commit: '3995a81e64ced1011f7e5c0662307f270c67e2b8' },
    { role: 'pull-request-merge', commit: '379f96daa85709bbc4c002f60501819690b00de2' }
  ],
  tree: 'b0945a403beaa4c4242a1d6526aa7c3d80d48f08',
  candidateSha256: '58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711',
  ciRunId: '32540542681',
  qualificationRunId: '32540542682',
  decision: 'automated-qualified-independent-review-passed-public-alpha-no-go'
});
assert.deepStrictEqual(
  state.failedQualificationRuns.map(item => item.runId),
  ['31290968279', '31314330832', '31321447041']
);
for (const rendered of [
  renderProjectState(continuityDocument),
  renderContinuationPrompt(continuityDocument)
]) {
  for (const failedRun of continuityDocument.failedQualificationRuns) {
    assert(rendered.includes(`run \`${failedRun.runId}\``),
      `generated continuity document must render failed run ${failedRun.runId}`);
    assert(rendered.includes(failedRun.failure),
      `generated continuity document must render the failure for ${failedRun.runId}`);
  }
}
assert.deepStrictEqual(state.gates.independentReview, {
  status: 'passed',
  runId: '4d47a6a5-e9d9-4a92-8a59-3883615069e8',
  actionable: 0,
  nitpicks: 0
});
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(state.gates).map(([name, gate]) => [name, gate.status])),
  {
    automated: 'passed',
    independentReview: 'passed',
    liveProvider: 'pending',
    hosted: 'pending',
    manualAccessibility: 'pending',
    finalRelease: 'pending'
  }
);
assert.strictEqual(state.nextAuthorizedAction.type, 'qualify-continuity-schema-successor');
/* The description is free text; assert it still states the pending posture. */
assert.match(state.nextAuthorizedAction.description, /pending/i);
assert(!serialized.includes('lastPushedCommit'));
assert(!serialized.includes('lastPushedSourceCommit'));
assert(!serialized.includes('pending_publication'));
assert.strictEqual(state.sourceControlAvailable, sourceControlExpected);
if (sourceControlExpected) {
  assert.match(state.currentHead, /^[0-9a-f]{40}$/);
  assert.strictEqual(state.acceptedBoundaryValid, true);
  assert(
    state.recordedBaseline.commits.some(entry => entry.commit === state.acceptedBoundaryCommit),
    'accepted boundary must be one of the recorded transport-specific commits'
  );
  assert.strictEqual(typeof state.worktreeClean, 'boolean');
} else {
  assert.strictEqual(state.currentHead, null);
  assert.strictEqual(state.acceptedBoundaryValid, null);
  assert.strictEqual(state.acceptedBoundaryCommit, null);
  assert.strictEqual(state.worktreeClean, null);
}
assert(Array.isArray(state.dirtyPaths));
assert(state.dirtyPaths.every(file => !file.startsWith('ORK_CONTINUITY')),
  'porcelain paths must preserve their first character');

const unknownArgument = spawnSync(process.execPath, [scriptPath, '--unknown'], {
  cwd: root,
  encoding: 'utf8'
});
assert.notStrictEqual(unknownArgument.status, 0);
assert.match(unknownArgument.stderr, /unknown argument/i);

const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-continuity-archive-'));
try {
  fs.mkdirSync(path.join(archiveRoot, 'src'));
  fs.mkdirSync(path.join(archiveRoot, 'scripts'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(archiveRoot, 'package.json'));
  fs.copyFileSync(path.join(root, 'WORK_CONTINUITY.json'), path.join(archiveRoot, 'WORK_CONTINUITY.json'));
  fs.copyFileSync(
    path.join(root, 'src', 'work-continuity.js'),
    path.join(archiveRoot, 'src', 'work-continuity.js')
  );
  fs.copyFileSync(scriptPath, path.join(archiveRoot, 'scripts', 'resume-work.js'));
  const archiveState = JSON.parse(execFileSync(
    process.execPath,
    [path.join(archiveRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: archiveRoot, encoding: 'utf8' }
  ));
  assert.strictEqual(archiveState.sourceControlAvailable, false);
  assert.strictEqual(archiveState.branch, null);
  assert.strictEqual(archiveState.currentHead, null);
  assert.strictEqual(archiveState.acceptedBoundaryValid, null);
  assert.strictEqual(archiveState.acceptedBoundaryCommit, null);
  assert.strictEqual(archiveState.worktreeClean, null);
  assert.deepStrictEqual(archiveState.dirtyPaths, []);
} finally {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-continuity-git-'));
try {
  fs.mkdirSync(path.join(fixtureRoot, 'src'));
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
  fs.writeFileSync(path.join(fixtureRoot, 'seed.txt'), 'seed\n');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'seed.txt'], { cwd: fixtureRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=Nebulaverse Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'seed'],
    { cwd: fixtureRoot, stdio: 'ignore' }
  );
  const acceptedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixtureRoot,
    encoding: 'utf8'
  }).trim();
  const acceptedTree = execFileSync('git', ['rev-parse', `${acceptedCommit}^{tree}`], {
    cwd: fixtureRoot,
    encoding: 'utf8'
  }).trim();
  const sourceState = JSON.parse(fs.readFileSync(path.join(root, 'WORK_CONTINUITY.json'), 'utf8'));
  const fixtureState = {
    ...sourceState,
    acceptedTree,
    recordedBaseline: {
      ...sourceState.recordedBaseline,
      commits: [
        { role: 'local-source', commit: 'f'.repeat(40) },
        { role: 'published', commit: acceptedCommit }
      ],
      tree: acceptedTree
    }
  };
  delete fixtureState.acceptedThrough;
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fixtureRoot, 'package.json'));
  fs.copyFileSync(
    path.join(root, 'src', 'work-continuity.js'),
    path.join(fixtureRoot, 'src', 'work-continuity.js')
  );
  fs.copyFileSync(scriptPath, path.join(fixtureRoot, 'scripts', 'resume-work.js'));
  fs.writeFileSync(
    path.join(fixtureRoot, 'WORK_CONTINUITY.json'),
    `${JSON.stringify(fixtureState, null, 2)}\n`
  );
  execFileSync('git', [
    'add',
    'package.json',
    'WORK_CONTINUITY.json',
    'src/work-continuity.js',
    'scripts/resume-work.js'
  ], {
    cwd: fixtureRoot,
    stdio: 'ignore'
  });
  execFileSync(
    'git',
    ['-c', 'user.name=Nebulaverse Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture'],
    { cwd: fixtureRoot, stdio: 'ignore' }
  );
  const fixtureHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixtureRoot,
    encoding: 'utf8'
  }).trim();
  execFileSync('git', ['checkout', '--detach', fixtureHead], { cwd: fixtureRoot, stdio: 'ignore' });
  const cleanState = JSON.parse(execFileSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'resume-work.js'), '--require-clean', '--json'],
    { cwd: fixtureRoot, encoding: 'utf8' }
  ));
  assert.strictEqual(cleanState.branch, null);
  assert.strictEqual(cleanState.currentHead, fixtureHead);
  assert.strictEqual(cleanState.acceptedBoundaryCommit, acceptedCommit);
  assert.strictEqual(cleanState.worktreeClean, true);

  fs.writeFileSync(path.join(fixtureRoot, 'dirty.txt'), 'dirty\n');
  const dirtyState = JSON.parse(execFileSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: fixtureRoot, encoding: 'utf8' }
  ));
  assert.strictEqual(dirtyState.worktreeClean, false);
  assert(dirtyState.dirtyPaths.includes('dirty.txt'));
  const dirtyRequired = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'resume-work.js'), '--require-clean', '--json'],
    { cwd: fixtureRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(dirtyRequired.status, 0);
  assert.match(dirtyRequired.stderr, /clean worktree/i);
  fs.unlinkSync(path.join(fixtureRoot, 'dirty.txt'));

  const gitIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Nebulaverse Test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Nebulaverse Test',
    GIT_COMMITTER_EMAIL: 'test@localhost'
  };
  const unrelatedBoundaryCommit = execFileSync(
    'git',
    ['commit-tree', acceptedTree],
    { cwd: fixtureRoot, encoding: 'utf8', input: 'unrelated root\n', env: gitIdentity }
  ).trim();
  const unrelatedHead = execFileSync(
    'git',
    ['commit-tree', `${fixtureHead}^{tree}`, '-p', unrelatedBoundaryCommit],
    { cwd: fixtureRoot, encoding: 'utf8', input: 'unrelated child\n', env: gitIdentity }
  ).trim();
  execFileSync('git', ['checkout', '--detach', unrelatedHead], { cwd: fixtureRoot, stdio: 'ignore' });
  const unrelatedBoundary = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: fixtureRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(unrelatedBoundary.status, 0);
  assert.match(unrelatedBoundary.stderr, /Accepted continuity commit\/tree pair is not present in HEAD ancestry/);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('work continuity tests passed');
