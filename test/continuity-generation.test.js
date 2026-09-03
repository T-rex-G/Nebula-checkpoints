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
  publicAlphaPosition,
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

assert.strictEqual(state.schemaVersion, 5);
assert.strictEqual(state.project, 'Nebulaverse-X');
assert.strictEqual(state.version, pkg.version);
assert.strictEqual(state.acceptedTree, 'b0945a403beaa4c4242a1d6526aa7c3d80d48f08');
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
assert.deepStrictEqual(state.gates.automated.programs, { total: 142, passed: 142, blocked: 0, failed: 0 });
assert.deepStrictEqual(state.gates.automated.browser, { total: 60, passed: 60, failed: 0 });
assert.deepStrictEqual(state.gates.independentReview, {
  status: 'passed',
  runId: '4d47a6a5-e9d9-4a92-8a59-3883615069e8',
  actionable: 0,
  nitpicks: 0
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
  assert(document.includes('58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711'));
  assert(document.includes('4d47a6a5-e9d9-4a92-8a59-3883615069e8'));
  assert(!document.includes('Task 21 is in progress'));
  assert(!document.includes('Current candidate SHA-256'));
  assert(!document.includes('Current candidate commit'));
}
assert(projectState.includes('| Automated exact-archive qualification | Passed |'));
assert(projectState.includes('| Independent review | Passed |'));
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

/*
 * Schema 5 no longer freezes the project's position, so these exercise the
 * invariants that must hold at any position rather than one snapshot of it.
 */
for (const mutate of [
  candidate => { candidate.schemaVersion = 4; },
  candidate => { candidate.version = '5.3.0-alpha.16.3'; },
  candidate => { delete candidate.recordedBaseline.candidateSha256; },
  candidate => { candidate.recordedBaseline.tree = 'f'.repeat(40); },
  candidate => { candidate.recordedBaseline.commits = []; },
  candidate => { candidate.recordedBaseline.commits.push(candidate.recordedBaseline.commits[0]); },
  candidate => { candidate.recordedBaseline.commits[0].role = 'not-a-transport'; },
  candidate => { candidate.recordedBaseline.decision = 'Not A Slug'; },
  candidate => { candidate.gates.automated.runId = '999'; },
  candidate => { candidate.gates.automated.programs.failed = 1; },
  candidate => { candidate.gates.independentReview.actionable = 3; },
  candidate => { candidate.gates.independentReview.status = 'failed'; },
  candidate => { candidate.gates.independentReview.status = 'unknown'; },
  candidate => { candidate.gates.liveProvider.status = 'passed'; },
  candidate => { candidate.gates.finalRelease = { status: 'passed', runId: '32540542682' }; },
  candidate => { candidate.currentCandidate.commit = '0'.repeat(40); },
  candidate => { candidate.nextAuthorizedAction.description = ''; }
]) {
  const candidate = clone(state);
  mutate(candidate);
  assert.throws(() => validateContinuity(candidate), /WORK_CONTINUITY\.json is invalid/);
}

/*
 * The point of schema 5 is that the record can move. Schema 4 rejected every
 * one of these as malformed, which is why the shipped documents kept asserting
 * a position the project had already left.
 */
for (const [label, advance] of [
  ['a live gate that passed with evidence', candidate => {
    candidate.gates.liveProvider = { status: 'passed', runId: '32540542682' };
  }],
  ['a live gate that failed and names its run', candidate => {
    candidate.gates.liveProvider = { status: 'failed', runId: '32540542682' };
  }],
  ['a single recorded commit identity', candidate => {
    candidate.recordedBaseline.commits = [candidate.recordedBaseline.commits[0]];
  }],
  ['a qualified candidate', candidate => {
    candidate.currentCandidate.qualificationStatus = 'qualified';
  }],
  ['every gate passed through to final release', candidate => {
    for (const name of ['liveProvider', 'hosted', 'manualAccessibility', 'finalRelease']) {
      candidate.gates[name] = { status: 'passed', runId: '32540542682' };
    }
  }]
]) {
  const candidate = clone(state);
  advance(candidate);
  assert.doesNotThrow(() => validateContinuity(candidate), `continuity must be able to record ${label}`);
  assert.doesNotThrow(() => renderProjectState(candidate), `project state must render ${label}`);
  assert.doesNotThrow(() => renderContinuationPrompt(candidate), `prompt must render ${label}`);
}

/*
 * Rendering must follow gate state, not merely avoid throwing. A document that
 * reports a gate as Passed beside prose insisting its evidence is missing would
 * reproduce the schema-4 defect one layer up, so assert the advanced wording
 * appears and the outstanding wording is gone.
 */
const released = clone(state);
for (const name of ['liveProvider', 'hosted', 'manualAccessibility', 'finalRelease']) {
  released.gates[name] = { status: 'passed', runId: '32540542682' };
}
const releasedState = renderProjectState(released);
const releasedPrompt = renderContinuationPrompt(released);

assert(releasedState.includes('Public alpha: **GO**'));
assert(renderProjectState(state).includes('Public alpha: **NO-GO**'));

/*
 * The exported position helper is the one path into the release verdict that
 * does not arrive through a renderer, so it has to enforce the record contract
 * itself. Without that a caller could hand it an object that never satisfied
 * the gate schema and be told GO on the strength of a single hand-written key.
 */
assert.strictEqual(publicAlphaPosition(state), 'NO-GO');
assert.strictEqual(publicAlphaPosition(released), 'GO');
for (const [label, forged] of [
  ['a hand-built object carrying only a passed final gate', { gates: { finalRelease: { status: 'passed' } } }],
  ['a record whose final gate claims success without a run', (() => {
    const candidate = clone(released);
    candidate.gates.finalRelease = { status: 'passed', runId: null };
    return candidate;
  })()],
  ['a record whose final gate outruns its predecessors', (() => {
    const candidate = clone(state);
    candidate.gates.finalRelease = { status: 'passed', runId: '32540542682' };
    return candidate;
  })()]
]) {
  assert.throws(
    () => publicAlphaPosition(forged),
    error => error instanceof Error && error.message === 'WORK_CONTINUITY.json is invalid',
    `the exported position must refuse to report a verdict for ${label}`
  );
}

for (const row of [
  '| Live-provider qualification | Passed | Qualified by run `32540542682` |',
  '| Hosted qualification | Passed | Qualified by run `32540542682` |',
  '| Manual accessibility | Passed | Qualified by run `32540542682` |',
  '| Final release | Passed | Qualified by run `32540542682` |'
]) assert(releasedState.includes(row), `advanced gate table must render ${row}`);

for (const outstanding of [
  'Must target the externally qualified successor identity',
  'Render/Neon execution has not been authorized for the successor',
  'VoiceOver and desktop screen-reader evidence remain required',
  'Requires every preceding gate for one exact candidate'
]) {
  assert(!releasedState.includes(outstanding),
    `a passed gate must not still claim: ${outstanding}`);
  assert(renderProjectState(state).includes(outstanding),
    `an outstanding gate must still state: ${outstanding}`);
}

assert(releasedPrompt.includes('Every recorded gate has passed'));
assert(!releasedPrompt.includes('Do not merge'),
  'a fully passed record must not instruct the reader to hold every gate');
assert(renderContinuationPrompt(state).includes('Do not merge'),
  'an outstanding record must keep the restriction');

/* A failed gate names the run that failed and still states what it needs. */
const regressed = clone(state);
regressed.gates.hosted = { status: 'failed', runId: '31716799288' };
const regressedState = renderProjectState(regressed);
assert(regressedState.includes(
  '| Hosted qualification | Failed | Run `31716799288` failed. Render/Neon execution has not been authorized for the successor |'
));
assert(renderContinuationPrompt(regressed).includes('Do not merge'));

const cleanCheck = spawnSync(process.execPath, [generatorPath, '--check'], {
  cwd: root,
  encoding: 'utf8'
});
assert.strictEqual(cleanCheck.status, 0, cleanCheck.stderr || cleanCheck.stdout);

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

  const archiveProjectStatePath = path.join(archiveRoot, 'docs', 'current', 'PROJECT_STATE.md');
  fs.appendFileSync(archiveProjectStatePath, '\n');
  const driftCheck = spawnSync(
    process.execPath,
    [path.join(archiveRoot, 'scripts', 'generate-continuity-docs.js'), '--check'],
    { cwd: archiveRoot, encoding: 'utf8' }
  );
  assert.notStrictEqual(driftCheck.status, 0, 'generated-file drift must fail the check');
  assert.match(driftCheck.stderr, /Generated continuity document is stale: docs\/current\/PROJECT_STATE\.md/);
} finally {
  fs.rmSync(archiveRoot, { recursive: true, force: true });
}

console.log('continuity generation tests passed');
