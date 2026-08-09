'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'resume-work.js');
const output = execFileSync(process.execPath, [scriptPath, '--json'], { cwd: root, encoding: 'utf8' });
const state = JSON.parse(output);
const serialized = JSON.stringify(state);
const sourceControlExpected = fs.existsSync(path.join(root, '.git'));

assert.strictEqual(state.schemaVersion, 2);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.version, '5.3.0-alpha.17.0');
assert.strictEqual(state.acceptedTree, '673737fc9a51aeffd54e068d5148de061fb559b2');
assert.strictEqual(Object.hasOwn(state, 'acceptedThrough'), false);
assert.deepStrictEqual(state.publishedBaseline, {
  repository: 'T-rex-G/Nebula-checkpoints',
  branch: 'sandbox/alpha17-live-qualification',
  commit: '315a88406487117fe32449e59eb3dfce4067b444',
  parent: '7f721a770df8e658e00163e05ebc259502f99c09',
  tree: '673737fc9a51aeffd54e068d5148de061fb559b2',
  candidateSha256: '6d29b357eca034afa413940f07d27352889c4a619be9483fc00a78d08da8b72d',
  qualificationDecision: 'no-go-evidence-integrity-correction-required'
});
assert.deepStrictEqual(
  state.failedQualificationRuns.map(item => item.runId),
  ['31290968279', '31314330832', '31321447041']
);
assert.strictEqual(
  state.nextAction,
  'Qualify the current immutable branch head only after the local evidence-integrity matrix and archive-root verification pass; dispatch at most one serialized provider stage and do not claim public-alpha GO'
);
assert(!serialized.includes('lastPushedCommit'));
assert(!serialized.includes('lastPushedSourceCommit'));
assert(!serialized.includes('pending_publication'));
assert.strictEqual(state.sourceControlAvailable, sourceControlExpected);
if (sourceControlExpected) {
  assert.match(state.currentHead, /^[0-9a-f]{40}$/);
  assert.strictEqual(state.acceptedBoundaryValid, true);
  assert.strictEqual(typeof state.worktreeClean, 'boolean');
} else {
  assert.strictEqual(state.currentHead, null);
  assert.strictEqual(state.acceptedBoundaryValid, null);
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
  fs.mkdirSync(path.join(archiveRoot, 'scripts'));
  fs.copyFileSync(path.join(root, 'WORK_CONTINUITY.json'), path.join(archiveRoot, 'WORK_CONTINUITY.json'));
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
  assert.strictEqual(archiveState.worktreeClean, null);
  assert.deepStrictEqual(archiveState.dirtyPaths, []);
} finally {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-continuity-git-'));
try {
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
  fs.writeFileSync(path.join(fixtureRoot, 'seed.txt'), 'seed\n');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'seed.txt'], { cwd: fixtureRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=Nebulaverse Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'seed'],
    { cwd: fixtureRoot, stdio: 'ignore' }
  );
  const acceptedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: fixtureRoot,
    encoding: 'utf8'
  }).trim();
  const fixtureState = {
    ...JSON.parse(fs.readFileSync(path.join(root, 'WORK_CONTINUITY.json'), 'utf8')),
    acceptedTree
  };
  delete fixtureState.acceptedThrough;
  fs.copyFileSync(scriptPath, path.join(fixtureRoot, 'scripts', 'resume-work.js'));
  fs.writeFileSync(
    path.join(fixtureRoot, 'WORK_CONTINUITY.json'),
    `${JSON.stringify(fixtureState, null, 2)}\n`
  );
  execFileSync('git', ['add', 'WORK_CONTINUITY.json', 'scripts/resume-work.js'], {
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
  const unrelatedHead = execFileSync(
    'git',
    ['commit-tree', `${fixtureHead}^{tree}`],
    { cwd: fixtureRoot, encoding: 'utf8', input: 'unrelated root\n', env: gitIdentity }
  ).trim();
  execFileSync('git', ['checkout', '--detach', unrelatedHead], { cwd: fixtureRoot, stdio: 'ignore' });
  const unrelatedBoundary = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'resume-work.js'), '--json'],
    { cwd: fixtureRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(unrelatedBoundary.status, 0);
  assert.match(unrelatedBoundary.stderr, /Accepted continuity tree is not present in HEAD ancestry/);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('work continuity tests passed');
