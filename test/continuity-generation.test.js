'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const {
  generatedDocuments,
  readContinuity,
  renderContinuationPrompt,
  renderProjectState,
  validateContinuity
} = require('../src/work-continuity');

const statePath = path.join(root, 'WORK_CONTINUITY.json');
const generatorPath = path.join(root, 'scripts', 'generate-continuity-docs.js');
const projectStatePath = path.join(root, 'docs', 'current', 'PROJECT_STATE.md');
const promptPath = path.join(root, 'docs', 'current', 'CONTINUATION_PROMPT.md');
const state = readContinuity(statePath);

assert.strictEqual(state.schemaVersion, 4);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.version, pkg.version);
assert.strictEqual(state.acceptedTree, '7bcc2c27029cc1013f176d1070e2cd38a8e69811');
assert.deepStrictEqual(state.recordedBaseline, {
  repository: 'T-rex-G/Nebula-checkpoints',
  branch: 'agent/alpha17-evidence-integrity',
  pullRequest: 1,
  sourceCommit: 'c67d92edb8c63f11ada74cfdc7835f8a4b387a1c',
  publishedCommit: 'd6628de48a32c3a2790dabeec60ec7b7b2ebab49',
  tree: '7bcc2c27029cc1013f176d1070e2cd38a8e69811',
  candidateSha256: '1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed',
  ciRunId: '31494468827',
  qualificationRunId: '31494468853',
  decision: 'automated-qualified-independent-review-failed-public-alpha-no-go'
});
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(state.gates).map(([name, gate]) => [name, gate.status])),
  {
    automated: 'passed',
    independentReview: 'failed',
    liveProvider: 'pending',
    hosted: 'pending',
    manualAccessibility: 'pending',
    finalRelease: 'pending'
  }
);
assert.deepStrictEqual(state.gates.automated.programs, { total: 141, passed: 141, blocked: 0, failed: 0 });
assert.deepStrictEqual(state.gates.automated.browser, { total: 56, passed: 56, failed: 0 });
assert.deepStrictEqual(state.gates.independentReview, {
  status: 'failed',
  runId: '04b93d36-47ea-402d-abda-ca6dfb2a9290',
  actionable: 30,
  nitpicks: 9
});
assert.strictEqual(state.gates.automated.productionAuditVulnerabilities, 0);
assert.strictEqual(state.gates.automated.developmentAuditVulnerabilities, 0);
assert.strictEqual(state.gates.automated.deterministicArchive, true);
assert.strictEqual(state.gates.automated.exactArchiveQualified, true);
assert.deepStrictEqual(state.currentCandidate, {
  qualificationStatus: 'not-qualified',
  identitySource: 'external-qualification-evidence'
});

const projectState = renderProjectState(state);
const continuationPrompt = renderContinuationPrompt(state);
assert.strictEqual(projectState, fs.readFileSync(projectStatePath, 'utf8'));
assert.strictEqual(continuationPrompt, fs.readFileSync(promptPath, 'utf8'));
assert.strictEqual(renderProjectState(state), projectState, 'project-state rendering must be deterministic');
assert.strictEqual(renderContinuationPrompt(state), continuationPrompt, 'prompt rendering must be deterministic');
assert.deepStrictEqual(generatedDocuments(state), {
  'docs/current/PROJECT_STATE.md': projectState,
  'docs/current/CONTINUATION_PROMPT.md': continuationPrompt
});

for (const document of [projectState, continuationPrompt]) {
  assert(document.includes('Generated from `WORK_CONTINUITY.json`'));
  assert(document.includes('Public alpha: **NO-GO**'));
  assert(document.includes('1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed'));
  assert(document.includes('04b93d36-47ea-402d-abda-ca6dfb2a9290'));
  assert(!document.includes('Task 21 is in progress'));
  assert(!document.includes('Current candidate SHA-256'));
  assert(!document.includes('Current candidate commit'));
}
assert(projectState.includes('| Automated exact-archive qualification | Passed |'));
assert(projectState.includes('| Live-provider qualification | Pending |'));
assert(projectState.includes('| Hosted qualification | Pending |'));
assert(projectState.includes('| Manual accessibility | Pending |'));
assert(projectState.includes('| Final release | Pending |'));
assert(continuationPrompt.includes('docs/current/PROJECT_STATE.md'));
assert(continuationPrompt.includes('docs/release/RELEASE_SECURITY_GATES.md'));
assert(continuationPrompt.includes(state.nextAuthorizedAction.description));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const mutate of [
  candidate => { candidate.schemaVersion = 3; },
  candidate => { candidate.version = '5.3.0-alpha.16.3'; },
  candidate => { delete candidate.recordedBaseline.candidateSha256; },
  candidate => { candidate.recordedBaseline.publishedCommit = candidate.recordedBaseline.sourceCommit; },
  candidate => { candidate.gates.independentReview.status = 'passed'; },
  candidate => { candidate.gates.liveProvider.status = 'passed'; },
  candidate => { candidate.gates.automated.programs.failed = 1; },
  candidate => { candidate.currentCandidate.commit = '0'.repeat(40); },
  candidate => { candidate.nextAuthorizedAction.description = ''; }
]) {
  const candidate = clone(state);
  mutate(candidate);
  assert.throws(() => validateContinuity(candidate), /WORK_CONTINUITY\.json is invalid/);
}

const cleanCheck = spawnSync(process.execPath, [generatorPath, '--check'], {
  cwd: root,
  encoding: 'utf8'
});
assert.strictEqual(cleanCheck.status, 0, cleanCheck.stderr || cleanCheck.stdout);

const originalProjectState = fs.readFileSync(projectStatePath);
try {
  fs.writeFileSync(projectStatePath, Buffer.concat([originalProjectState, Buffer.from('\n')]));
  const driftCheck = spawnSync(process.execPath, [generatorPath, '--check'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.notStrictEqual(driftCheck.status, 0, 'generated-file drift must fail the check');
  assert.match(driftCheck.stderr, /Generated continuity document is stale: docs\/current\/PROJECT_STATE\.md/);
} finally {
  fs.writeFileSync(projectStatePath, originalProjectState);
}

const unknownArgument = spawnSync(process.execPath, [generatorPath, '--unknown'], {
  cwd: root,
  encoding: 'utf8'
});
assert.notStrictEqual(unknownArgument.status, 0);
assert.match(unknownArgument.stderr, /Unknown argument: --unknown/);

const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulaverse-generated-continuity-'));
try {
  fs.mkdirSync(path.join(archiveRoot, 'src'));
  fs.mkdirSync(path.join(archiveRoot, 'scripts'));
  fs.mkdirSync(path.join(archiveRoot, 'docs', 'current'), { recursive: true });
  for (const relative of [
    'package.json',
    'WORK_CONTINUITY.json',
    'src/work-continuity.js',
    'scripts/generate-continuity-docs.js',
    'docs/current/PROJECT_STATE.md',
    'docs/current/CONTINUATION_PROMPT.md'
  ]) {
    fs.copyFileSync(path.join(root, relative), path.join(archiveRoot, relative));
  }
  const archiveCheck = execFileSync(
    process.execPath,
    [path.join(archiveRoot, 'scripts', 'generate-continuity-docs.js'), '--check'],
    { cwd: archiveRoot, encoding: 'utf8' }
  );
  assert.match(archiveCheck, /Generated continuity documents are current/);
} finally {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
}

console.log('continuity generation tests passed');
