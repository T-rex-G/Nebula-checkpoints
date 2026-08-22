'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_VERSION = require('../package.json').version;

/*
 * Schema 5 separates the shape of the continuity record from the values it
 * happens to hold.
 *
 * Schema 4 encoded one moment as the schema itself: the review gate had to
 * read `failed`, the actionable count had to exceed zero, the candidate had to
 * be `not-qualified`, and the repository, branch, pull request and decision
 * were literals. Recording that a gate had advanced was therefore impossible
 * without editing this file, so the record could not track the work it exists
 * to describe, and the documents generated from it stated a position the
 * project had already left.
 *
 * What is enforced here instead are invariants that stay true whatever the
 * project's position is: exact field sets, digest and identifier formats,
 * cross-field agreement, and two policy rules — a gate never reports `passed`
 * without an evidence run behind it, and final release never reports `passed`
 * while any preceding gate has not.
 *
 * Commit identity is a set rather than a pair. One accepted tree can be
 * reached through several transport-specific commits: a local source commit
 * and its published counterpart, or a branch head and the pull-request merge
 * commit that carries the same tree into a workflow checkout. Naming exactly
 * two of them, and requiring them to differ, could not describe either case
 * honestly once the transports changed.
 */
const SCHEMA_VERSION = 5;

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[0-9]+$/;
const REVIEW_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_COMMIT_IDENTITIES = 8;

const GATE_STATUSES = Object.freeze(['passed', 'failed', 'pending']);
const EXPECTED_GATE_NAMES = Object.freeze([
  'automated',
  'independentReview',
  'liveProvider',
  'hosted',
  'manualAccessibility',
  'finalRelease'
]);
const STAGED_GATE_NAMES = Object.freeze([
  'liveProvider',
  'hosted',
  'manualAccessibility',
  'finalRelease'
]);
const COMMIT_ROLES = Object.freeze([
  'branch-head',
  'pull-request-merge',
  'local-source',
  'published'
]);
const COMMIT_ROLE_LABELS = Object.freeze({
  'branch-head': 'branch head',
  'pull-request-merge': 'pull-request merge',
  'local-source': 'local source',
  published: 'published'
});
const QUALIFICATION_STATUSES = Object.freeze(['qualified', 'not-qualified']);

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

function validateCommitIdentities(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_COMMIT_IDENTITIES
  ) invalid();
  const roles = new Set();
  const commits = new Set();
  for (const entry of value) {
    if (
      !hasExactKeys(entry, ['role', 'commit'])
      || !COMMIT_ROLES.includes(entry.role)
      || !SHA1_PATTERN.test(entry.commit || '')
      || /^0{40}$/.test(entry.commit)
      || roles.has(entry.role)
      || commits.has(entry.commit)
    ) invalid();
    roles.add(entry.role);
    commits.add(entry.commit);
  }
}

function validateAutomatedGate(gate, baseline) {
  if (!hasExactKeys(gate, [
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
    !GATE_STATUSES.includes(gate.status)
    || !RUN_ID_PATTERN.test(gate.runId || '')
    || gate.runId !== baseline.qualificationRunId
    || !isValidCountSet(gate.programs, ['total', 'passed', 'blocked', 'failed'])
    || !isValidCountSet(gate.browser, ['total', 'passed', 'failed'])
    || !Number.isInteger(gate.productionAuditVulnerabilities)
    || gate.productionAuditVulnerabilities < 0
    || !Number.isInteger(gate.developmentAuditVulnerabilities)
    || gate.developmentAuditVulnerabilities < 0
    || typeof gate.deterministicArchive !== 'boolean'
    || typeof gate.exactArchiveQualified !== 'boolean'
  ) invalid();
  /* A passing automated gate has to agree with the counts it reports. */
  if (gate.status === 'passed' && (
    gate.programs.total === 0
    || gate.programs.total !== gate.programs.passed
    || gate.programs.blocked !== 0
    || gate.programs.failed !== 0
    || gate.browser.total === 0
    || gate.browser.total !== gate.browser.passed
    || gate.browser.failed !== 0
    || gate.productionAuditVulnerabilities !== 0
    || gate.developmentAuditVulnerabilities !== 0
    || gate.deterministicArchive !== true
    || gate.exactArchiveQualified !== true
  )) invalid();
}

function validateIndependentReviewGate(gate) {
  if (!hasExactKeys(gate, ['status', 'runId', 'actionable', 'nitpicks'])) invalid();
  if (
    !GATE_STATUSES.includes(gate.status)
    || !Number.isInteger(gate.actionable)
    || gate.actionable < 0
    || !Number.isInteger(gate.nitpicks)
    || gate.nitpicks < 0
  ) invalid();
  /* A recorded review outcome names the review that produced it. */
  if (gate.status === 'pending') {
    if (gate.runId !== null) invalid();
  } else if (!REVIEW_ID_PATTERN.test(gate.runId || '')) invalid();
  /* The verdict and the finding count cannot disagree. */
  if (gate.status === 'passed' && gate.actionable !== 0) invalid();
  if (gate.status === 'failed' && gate.actionable === 0) invalid();
}

function validateStagedGate(gate) {
  if (!hasExactKeys(gate, ['status', 'runId'])) invalid();
  if (!GATE_STATUSES.includes(gate.status)) invalid();
  /* No staged gate reports success without an evidence run behind it. */
  if (gate.status === 'passed') {
    if (!RUN_ID_PATTERN.test(gate.runId || '')) invalid();
    return;
  }
  /* A gate that has not been attempted carries no run; one that was attempted
     and failed names the run that failed, so both remain recordable. */
  if (gate.status === 'pending' && gate.runId !== null) invalid();
  if (gate.status === 'failed' && gate.runId !== null && !RUN_ID_PATTERN.test(gate.runId)) invalid();
}

function validateGates(gates, baseline) {
  if (!hasExactKeys(gates, EXPECTED_GATE_NAMES)) invalid();
  validateAutomatedGate(gates.automated, baseline);
  validateIndependentReviewGate(gates.independentReview);
  for (const name of STAGED_GATE_NAMES) validateStagedGate(gates[name]);
  /* Final release is a ratchet over every preceding gate. */
  if (gates.finalRelease.status === 'passed') {
    const preceding = EXPECTED_GATE_NAMES.filter(name => name !== 'finalRelease');
    if (preceding.some(name => gates[name].status !== 'passed')) invalid();
  }
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
    value.schemaVersion !== SCHEMA_VERSION
    || value.project !== 'Nebulaverse-X'
    || value.version !== PACKAGE_VERSION
    || !SHA1_PATTERN.test(value.acceptedTree || '')
  ) invalid();

  const baseline = value.recordedBaseline;
  if (!hasExactKeys(baseline, [
    'repository',
    'branch',
    'pullRequest',
    'commits',
    'tree',
    'candidateSha256',
    'ciRunId',
    'qualificationRunId',
    'decision'
  ])) invalid();
  if (
    !REPOSITORY_PATTERN.test(baseline.repository || '')
    || !isNonEmptyString(baseline.branch)
    || !Number.isInteger(baseline.pullRequest)
    || baseline.pullRequest <= 0
    || !SHA1_PATTERN.test(baseline.tree || '')
    || baseline.tree !== value.acceptedTree
    || !SHA256_PATTERN.test(baseline.candidateSha256 || '')
    || !RUN_ID_PATTERN.test(baseline.ciRunId || '')
    || !RUN_ID_PATTERN.test(baseline.qualificationRunId || '')
    || !SLUG_PATTERN.test(baseline.decision || '')
  ) invalid();
  validateCommitIdentities(baseline.commits);

  validateGates(value.gates, baseline);

  if (
    !Array.isArray(value.failedQualificationRuns)
    || value.failedQualificationRuns.some(item =>
      !hasExactKeys(item, ['runId', 'failure', 'liveJobsSkipped'])
      || !RUN_ID_PATTERN.test(String(item.runId || ''))
      || !isNonEmptyString(item.failure)
      || typeof item.liveJobsSkipped !== 'boolean'
    )
  ) invalid();
  if (
    !Array.isArray(value.limitations)
    || value.limitations.length === 0
    || value.limitations.some(item => !isNonEmptyString(item))
  ) invalid();
  if (
    !hasExactKeys(value.currentCandidate, ['qualificationStatus', 'identitySource'])
    || !QUALIFICATION_STATUSES.includes(value.currentCandidate.qualificationStatus)
    || !SLUG_PATTERN.test(value.currentCandidate.identitySource || '')
  ) invalid();
  if (
    !hasExactKeys(value.nextAuthorizedAction, ['type', 'description'])
    || !SLUG_PATTERN.test(value.nextAuthorizedAction.type || '')
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

/*
 * Public alpha is a release position, not a stored flag: it follows the gate.
 *
 * The internal form assumes a record its caller has already validated; the
 * renderers validate at entry, so revalidating per call would be wasted work.
 * The exported form validates first, because a caller outside this module
 * could otherwise hand it a hand-built object and be told GO by a record that
 * never had to satisfy the gate contract.
 */
function releasePosition(state) {
  return state.gates.finalRelease.status === 'passed' ? 'GO' : 'NO-GO';
}

function publicAlphaPosition(state) {
  validateContinuity(state);
  return releasePosition(state);
}

function commitIdentityLines(baseline) {
  return baseline.commits.map(entry =>
    `- ${COMMIT_ROLE_LABELS[entry.role]} commit: \`${entry.commit}\``
  );
}

/*
 * What a staged gate still needs, stated only while it still needs it. Making
 * the status dynamic while leaving these sentences fixed would reproduce the
 * schema-4 defect one layer up: the table would report a gate as Passed beside
 * prose insisting its evidence is missing.
 */
const STAGED_GATE_LABELS = Object.freeze({
  liveProvider: 'Live-provider qualification',
  hosted: 'Hosted qualification',
  manualAccessibility: 'Manual accessibility',
  finalRelease: 'Final release'
});
const STAGED_GATE_OUTSTANDING_EVIDENCE = Object.freeze({
  liveProvider: 'Must target the externally qualified successor identity',
  hosted: 'Render/Neon execution has not been authorized for the successor',
  manualAccessibility: 'VoiceOver and desktop screen-reader evidence remain required',
  finalRelease: 'Requires every preceding gate for one exact candidate'
});

function stagedGateEvidence(name, gate) {
  if (gate.status === 'passed') return `Qualified by run \`${gate.runId}\``;
  if (gate.status === 'failed') {
    return gate.runId
      ? `Run \`${gate.runId}\` failed. ${STAGED_GATE_OUTSTANDING_EVIDENCE[name]}`
      : `Recorded as failed without a run. ${STAGED_GATE_OUTSTANDING_EVIDENCE[name]}`;
  }
  return STAGED_GATE_OUTSTANDING_EVIDENCE[name];
}

function outstandingStagedGates(state) {
  return STAGED_GATE_NAMES.filter(name => state.gates[name].status !== 'passed');
}

function joinLabels(labels) {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function stagedGateRestriction(state) {
  const outstanding = outstandingStagedGates(state);
  if (!outstanding.length) {
    return [
      'Every recorded gate has passed. Merging, deployment, cohort opening, and live dispatch',
      'remain separate operator decisions and are not authorized by this prompt.'
    ];
  }
  const labels = joinLabels(outstanding.map(name => STAGED_GATE_LABELS[name].toLowerCase()));
  return [
    `Keep the ${labels} ${outstanding.length === 1 ? 'gate' : 'gates'} as recorded. Do not merge,`,
    'deploy, open the cohort, or dispatch live qualification from this prompt.'
  ];
}

function reviewSentence(gate) {
  if (gate.status === 'pending') return 'No independent review has been recorded for this baseline.';
  const verdict = gate.status === 'passed' ? 'passed' : 'failed';
  return `Independent review \`${gate.runId}\` ${verdict} with ${gate.actionable} actionable `
    + `findings and ${gate.nitpicks} nitpicks.`;
}

function candidateSentence(state) {
  const qualified = state.currentCandidate.qualificationStatus === 'qualified';
  return [
    `The successor now in progress is **${qualified ? 'qualified' : 'not qualified'}**. Its commit,`,
    'tree, archive SHA-256, and evidence hashes remain external qualification evidence; this',
    'archive cannot attest its own final identity.'
  ].join('\n');
}

function failedQualificationRunLines(state) {
  if (!state.failedQualificationRuns.length) return ['- none recorded.'];
  return state.failedQualificationRuns.map(item =>
    `- run \`${item.runId}\`: ${item.failure} Live jobs skipped: ${item.liveJobsSkipped ? 'yes' : 'no'}.`
  );
}

function renderProjectState(state) {
  validateContinuity(state);
  const baseline = state.recordedBaseline;
  const automated = state.gates.automated;
  return [
    '# Nebulaverse-X Project State',
    '',
    '> Generated from `WORK_CONTINUITY.json`. Do not edit this file directly.',
    '',
    `Current authored version: **${state.version}**`,
    '',
    `Public alpha: **${releasePosition(state)}**`,
    '',
    '## Identity boundary',
    '',
    'The last automatically qualified immutable baseline is one accepted tree reached',
    'through these transport-specific commit identities:',
    '',
    ...commitIdentityLines(baseline),
    '',
    `with tree \`${baseline.tree}\` and candidate SHA-256`,
    `\`${baseline.candidateSha256}\` in \`${baseline.repository}\` draft PR #${baseline.pullRequest}.`,
    '',
    `Standard CI run: \`${baseline.ciRunId}\`. Exact-archive qualification run: \`${baseline.qualificationRunId}\`.`,
    '',
    reviewSentence(state.gates.independentReview),
    '',
    '## Failed qualification attempts',
    '',
    ...failedQualificationRunLines(state),
    '',
    candidateSentence(state),
    '',
    '## Gate state',
    '',
    '| Gate | Status | Evidence boundary |',
    '|---|---|---|',
    `| Automated exact-archive qualification | ${titleCaseStatus(automated.status)} | Recorded baseline run \`${automated.runId}\`: ${automated.programs.passed}/${automated.programs.total} programs and ${automated.browser.passed}/${automated.browser.total} browser checks |`,
    `| Independent review | ${titleCaseStatus(state.gates.independentReview.status)} | ${reviewSentence(state.gates.independentReview)} |`,
    ...STAGED_GATE_NAMES.map(name =>
      `| ${STAGED_GATE_LABELS[name]} | ${titleCaseStatus(state.gates[name].status)} | ${stagedGateEvidence(name, state.gates[name])} |`),
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
    `Resume Nebulaverse-X ${state.version} from the recorded qualified baseline.`,
    '',
    `Public alpha: **${releasePosition(state)}**`,
    '',
    'The last immutable baseline that may be cited as automatically qualified is:',
    '',
    `- repository: \`${baseline.repository}\``,
    `- branch: \`${baseline.branch}\``,
    `- draft PR: \`#${baseline.pullRequest}\``,
    ...commitIdentityLines(baseline),
    `- tree: \`${baseline.tree}\``,
    `- candidate SHA-256: \`${baseline.candidateSha256}\``,
    `- CI run: \`${baseline.ciRunId}\``,
    `- qualification run: \`${baseline.qualificationRunId}\``,
    `- decision: \`${baseline.decision}\``,
    '',
    reviewSentence(state.gates.independentReview),
    '',
    'Failed qualification attempts:',
    '',
    ...failedQualificationRunLines(state),
    '',
    'Do not reuse that identity for a successor. The current candidate commit, tree, archive',
    'SHA-256, and evidence hashes are external qualification evidence and remain unknown until',
    'the successor is frozen and qualified.',
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
    ...stagedGateRestriction(state),
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
  COMMIT_ROLES,
  EXPECTED_GATE_NAMES,
  GATE_STATUSES,
  SCHEMA_VERSION,
  generatedDocuments,
  publicAlphaPosition,
  readContinuity,
  renderContinuationPrompt,
  renderProjectState,
  validateContinuity
});
