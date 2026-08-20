'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_VERSION = require('../package.json').version;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[0-9]+$/;
const EXPECTED_GATE_NAMES = Object.freeze([
  'automated',
  'independentReview',
  'liveProvider',
  'hosted',
  'manualAccessibility',
  'finalRelease'
]);
const PENDING_GATE_NAMES = Object.freeze([
  'liveProvider',
  'hosted',
  'manualAccessibility',
  'finalRelease'
]);

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidCountSet(value, keys) {
  return hasExactKeys(value, keys)
    && keys.every(key => Number.isInteger(value[key]) && value[key] >= 0);
}

function invalid() {
  throw new Error('WORK_CONTINUITY.json is invalid');
}

function validateContinuity(value) {
  if (!hasExactKeys(value, [
    'schemaVersion',
    'project',
    'version',
    'acceptedTree',
    'recordedBaseline',
    'gates',
    'failedQualificationRuns',
    'limitations',
    'currentCandidate',
    'nextAuthorizedAction'
  ])) invalid();
  if (
    value.schemaVersion !== 4
    || value.project !== 'Nebulaverse-X'
    || value.version !== PACKAGE_VERSION
    || !SHA1_PATTERN.test(value.acceptedTree || '')
  ) invalid();

  const baseline = value.recordedBaseline;
  if (!hasExactKeys(baseline, [
    'repository',
    'branch',
    'pullRequest',
    'sourceCommit',
    'publishedCommit',
    'tree',
    'candidateSha256',
    'ciRunId',
    'qualificationRunId',
    'decision'
  ])) invalid();
  if (
    baseline.repository !== 'T-rex-G/Nebula-checkpoints'
    || baseline.branch !== 'agent/alpha17-evidence-integrity'
    || baseline.pullRequest !== 1
    || !SHA1_PATTERN.test(baseline.sourceCommit || '')
    || !SHA1_PATTERN.test(baseline.publishedCommit || '')
    || baseline.sourceCommit === baseline.publishedCommit
    || !SHA1_PATTERN.test(baseline.tree || '')
    || baseline.tree !== value.acceptedTree
    || !SHA256_PATTERN.test(baseline.candidateSha256 || '')
    || !RUN_ID_PATTERN.test(baseline.ciRunId || '')
    || !RUN_ID_PATTERN.test(baseline.qualificationRunId || '')
    || baseline.decision !== 'automated-qualified-independent-review-failed-public-alpha-no-go'
  ) invalid();
  if (!hasExactKeys(value.gates, EXPECTED_GATE_NAMES)) invalid();
  const independentReview = value.gates.independentReview;
  if (
    !hasExactKeys(independentReview, ['status', 'runId', 'actionable', 'nitpicks'])
    || independentReview.status !== 'failed'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(independentReview.runId || '')
    || !Number.isInteger(independentReview.actionable)
    || independentReview.actionable <= 0
    || !Number.isInteger(independentReview.nitpicks)
    || independentReview.nitpicks < 0
  ) invalid();

  const automated = value.gates.automated;
  if (!hasExactKeys(automated, [
    'status',
    'runId',
    'programs',
    'browser',
    'productionAuditVulnerabilities',
    'developmentAuditVulnerabilities',
    'deterministicArchive',
    'exactArchiveQualified'
  ])) invalid();
  if (
    automated.status !== 'passed'
    || automated.runId !== baseline.qualificationRunId
    || !isValidCountSet(automated.programs, ['total', 'passed', 'blocked', 'failed'])
    || automated.programs.total !== automated.programs.passed
    || automated.programs.blocked !== 0
    || automated.programs.failed !== 0
    || !isValidCountSet(automated.browser, ['total', 'passed', 'failed'])
    || automated.browser.total !== automated.browser.passed
    || automated.browser.failed !== 0
    || automated.productionAuditVulnerabilities !== 0
    || automated.developmentAuditVulnerabilities !== 0
    || automated.deterministicArchive !== true
    || automated.exactArchiveQualified !== true
  ) invalid();
  for (const name of PENDING_GATE_NAMES) {
    if (!hasExactKeys(value.gates[name], ['status']) || value.gates[name].status !== 'pending') invalid();
  }

  if (
    !Array.isArray(value.failedQualificationRuns)
    || value.failedQualificationRuns.length === 0
    || value.failedQualificationRuns.some(item =>
      !hasExactKeys(item, ['runId', 'failure', 'liveJobsSkipped'])
      || !RUN_ID_PATTERN.test(String(item.runId || ''))
      || !isNonEmptyString(item.failure)
      || item.liveJobsSkipped !== true
    )
  ) invalid();
  if (
    !Array.isArray(value.limitations)
    || value.limitations.length === 0
    || value.limitations.some(item => !isNonEmptyString(item))
  ) invalid();
  if (
    !hasExactKeys(value.currentCandidate, ['qualificationStatus', 'identitySource'])
    || value.currentCandidate.qualificationStatus !== 'not-qualified'
    || value.currentCandidate.identitySource !== 'external-qualification-evidence'
  ) invalid();
  if (
    !hasExactKeys(value.nextAuthorizedAction, ['type', 'description'])
    || value.nextAuthorizedAction.type !== 'qualify-review-remediation-successor'
    || !isNonEmptyString(value.nextAuthorizedAction.description)
  ) invalid();

  return value;
}

function readContinuity(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch {
    throw new Error('WORK_CONTINUITY.json is not valid JSON');
  }
  return validateContinuity(value);
}

function titleCaseStatus(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function failedQualificationRunLines(state) {
  return state.failedQualificationRuns.map(item =>
    `- run \`${item.runId}\`: ${item.failure} Live jobs skipped: ${item.liveJobsSkipped ? 'yes' : 'no'}.`
  );
}

function renderProjectState(state) {
  validateContinuity(state);
  const baseline = state.recordedBaseline;
  return [
    '# Nebulaverse-X Project State',
    '',
    '> Generated from `WORK_CONTINUITY.json`. Do not edit this file directly.',
    '',
    `Current authored version: **${state.version}**`,
    '',
    'Public alpha: **NO-GO**',
    '',
    '## Identity boundary',
    '',
    'The last automatically qualified immutable baseline has two transport-specific commit identities:',
    '',
    `- local source commit: \`${baseline.sourceCommit}\``,
    `- published draft-PR commit: \`${baseline.publishedCommit}\``,
    '',
    `with tree \`${baseline.tree}\` and candidate SHA-256`,
    `\`${baseline.candidateSha256}\` in \`${baseline.repository}\` draft PR #${baseline.pullRequest}.`,
    '',
    `Standard CI run: \`${baseline.ciRunId}\`. Exact-archive qualification run: \`${baseline.qualificationRunId}\`.`,
    '',
    `Independent review \`${state.gates.independentReview.runId}\` failed with ${state.gates.independentReview.actionable} actionable findings and ${state.gates.independentReview.nitpicks} nitpicks.`,
    '',
    '## Failed qualification attempts',
    '',
    ...failedQualificationRunLines(state),
    '',
    'The review-remediation successor is **not qualified**. Its commit, tree, archive SHA-256,',
    'and evidence hashes must be recorded externally after exact-candidate qualification; this',
    'archive cannot attest its own final identity.',
    '',
    '## Gate state',
    '',
    '| Gate | Status | Evidence boundary |',
    '|---|---|---|',
    `| Automated exact-archive qualification | ${titleCaseStatus(state.gates.automated.status)} | Recorded baseline run \`${state.gates.automated.runId}\`: ${state.gates.automated.programs.passed}/${state.gates.automated.programs.total} programs and ${state.gates.automated.browser.passed}/${state.gates.automated.browser.total} browser checks |`,
    `| Independent review | ${titleCaseStatus(state.gates.independentReview.status)} | Review \`${state.gates.independentReview.runId}\`: ${state.gates.independentReview.actionable} actionable findings and ${state.gates.independentReview.nitpicks} nitpicks |`,
    `| Live-provider qualification | ${titleCaseStatus(state.gates.liveProvider.status)} | Must target the externally qualified successor identity |`,
    `| Hosted qualification | ${titleCaseStatus(state.gates.hosted.status)} | Render/Neon execution has not been authorized for the successor |`,
    `| Manual accessibility | ${titleCaseStatus(state.gates.manualAccessibility.status)} | VoiceOver and desktop screen-reader evidence remain required |`,
    `| Final release | ${titleCaseStatus(state.gates.finalRelease.status)} | Requires every preceding gate for one exact candidate |`,
    '',
    '## Known limitations',
    '',
    ...state.limitations.map(item => `- ${item}`),
    '',
    '## Next authorized action',
    '',
    state.nextAuthorizedAction.description,
    '',
    'No merge, deployment, public cohort opening, or live-provider dispatch is authorized by',
    'this in-repository state.',
    '',
    '## Canonical read order',
    '',
    '1. `WORK_CONTINUITY.json`',
    '2. `docs/current/PROJECT_STATE.md`',
    '3. `docs/current/ROADMAP.md`',
    '4. `docs/release/RELEASE_SECURITY_GATES.md`',
    '5. `docs/release/EVIDENCE_INDEX.md`',
    '6. `docs/architecture/ARCHITECTURE_DECISIONS.md`',
    ''
  ].join('\n');
}

function renderContinuationPrompt(state) {
  validateContinuity(state);
  const baseline = state.recordedBaseline;
  return [
    '# Nebulaverse-X Continuation Prompt',
    '',
    '> Generated from `WORK_CONTINUITY.json`. Do not edit this file directly.',
    '',
    `Resume Nebulaverse-X ${state.version} from the independent-review remediation successor line.`,
    '',
    'Public alpha: **NO-GO**',
    '',
    'The last immutable baseline that may be cited as automatically qualified is:',
    '',
    `- repository: \`${baseline.repository}\``,
    `- draft PR: \`#${baseline.pullRequest}\``,
    `- local source commit: \`${baseline.sourceCommit}\``,
    `- published draft-PR commit: \`${baseline.publishedCommit}\``,
    `- tree: \`${baseline.tree}\``,
    `- candidate SHA-256: \`${baseline.candidateSha256}\``,
    `- CI run: \`${baseline.ciRunId}\``,
    `- qualification run: \`${baseline.qualificationRunId}\``,
    '',
    `Independent review \`${state.gates.independentReview.runId}\` failed with ${state.gates.independentReview.actionable} actionable findings and ${state.gates.independentReview.nitpicks} nitpicks.`,
    '',
    'Failed qualification attempts:',
    '',
    ...failedQualificationRunLines(state),
    '',
    'Do not reuse that identity for the remediation successor. The current candidate commit,',
    'tree, archive SHA-256, and evidence hashes are external qualification evidence and remain',
    'unknown until the successor is frozen and qualified.',
    '',
    'Read in order:',
    '',
    '1. `WORK_CONTINUITY.json`',
    '2. `docs/current/PROJECT_STATE.md`',
    '3. `docs/current/ROADMAP.md`',
    '4. `docs/release/RELEASE_SECURITY_GATES.md`',
    '5. `docs/release/EVIDENCE_INDEX.md`',
    '6. `docs/architecture/ARCHITECTURE_DECISIONS.md`',
    '',
    'Next authorized action:',
    '',
    state.nextAuthorizedAction.description,
    '',
    'Keep live-provider, hosted, manual-accessibility, and final-release gates pending. Do not',
    'merge, deploy, open the cohort, or dispatch live qualification from this prompt.',
    ''
  ].join('\n');
}

function generatedDocuments(state) {
  return {
    'docs/current/PROJECT_STATE.md': renderProjectState(state),
    'docs/current/CONTINUATION_PROMPT.md': renderContinuationPrompt(state)
  };
}

module.exports = Object.freeze({
  EXPECTED_GATE_NAMES,
  generatedDocuments,
  readContinuity,
  renderContinuationPrompt,
  renderProjectState,
  validateContinuity
});
