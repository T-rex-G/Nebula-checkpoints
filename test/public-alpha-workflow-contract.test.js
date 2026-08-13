'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  encodeAuthorizationEnvelope,
  hashLiveTarget,
  verifyLiveTargetBinding,
  verifyAuthorizationEnvelope
} = require('../ci/verify-alpha17-authorization');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const now = new Date('2026-07-29T20:00:00.000Z');
function expectedTargetHash(jobName, target) {
  return crypto.createHash('sha256').update(JSON.stringify({
    apiUrl: target.apiUrl,
    jobName,
    repository: target.repository
  })).digest('hex');
}
const targets = {
  github: {
    repository: 'fixture-owner/nvx-alpha17-github-qualification',
    apiUrl: 'https://api.github.com'
  },
  gitlab: {
    repository: 'fixture-owner/nvx-alpha17-gitlab-qualification',
    apiUrl: 'https://gitlab.com/api/v4'
  }
};
const targetHashes = Object.fromEntries(
  Object.entries(targets).map(([jobName, target]) => [jobName, expectedTargetHash(jobName, target)])
);
for (const [jobName, target] of Object.entries(targets)) {
  assert.strictEqual(hashLiveTarget(jobName, target), targetHashes[jobName]);
}
const payload = {
  schemaVersion: '1.2.0',
  workflow: '.github/workflows/public-alpha-alpha17.yml',
  repository: 'fixture-owner/fixture-repository',
  event: 'workflow_dispatch',
  sourceParent: 'c'.repeat(40),
  sourceCommit: 'b'.repeat(40),
  subjectSha256: 'a'.repeat(64),
  authorizedJobs: ['github', 'gitlab'],
  targetHashes,
  authorizationId: 'approval-2048',
  expiresAt: '2026-07-29T20:15:00.000Z'
};
const token = encodeAuthorizationEnvelope(payload, privateKey);
const verified = verifyAuthorizationEnvelope(token, {
  publicKeyBase64,
  expectedWorkflow: payload.workflow,
  expectedRepository: payload.repository,
  expectedEvent: payload.event,
  expectedSourceParent: payload.sourceParent,
  expectedSourceCommit: payload.sourceCommit,
  expectedSubjectHash: payload.subjectSha256,
  requestedJobs: ['github', 'gitlab'],
  expectedTargets: targets,
  now
});
assert.deepStrictEqual(verified.authorizedJobs, ['github', 'gitlab']);
assert.deepStrictEqual(verified.targetHashes, targetHashes);
assert.match(verified.envelopeHash, /^[0-9a-f]{64}$/);
assert(!JSON.stringify(verified).includes(token));

assert.deepStrictEqual(
  verifyLiveTargetBinding({
    jobName: 'github',
    target: targets.github,
    signedTargetHash: targetHashes.github
  }),
  { ok: true, jobName: 'github', targetHash: targetHashes.github }
);

const hostedTarget = {
  baseUrl: 'https://alpha17.example.test',
  renderServiceId: 'fixture-owner/nvx-alpha17-render',
  neonProjectId: 'quiet-rain-12345678',
  cohortNeonBranchId: 'br-cohort-111111',
  restoreNeonProjectId: 'quiet-rain-12345678',
  restoreNeonBranchId: 'br-restore-222222',
  restoreTargetKind: 'isolated-neon-branch',
  restoreTargetFingerprint: 'f'.repeat(64)
};
const hostedTargetHash = crypto.createHash('sha256').update(JSON.stringify({
  baseUrl: hostedTarget.baseUrl,
  cohortNeonBranchId: hostedTarget.cohortNeonBranchId,
  jobName: 'hosted',
  neonProjectId: hostedTarget.neonProjectId,
  renderServiceId: hostedTarget.renderServiceId,
  restoreNeonBranchId: hostedTarget.restoreNeonBranchId,
  restoreNeonProjectId: hostedTarget.restoreNeonProjectId,
  restoreTargetFingerprint: hostedTarget.restoreTargetFingerprint,
  restoreTargetKind: hostedTarget.restoreTargetKind
})).digest('hex');
assert.strictEqual(hashLiveTarget('hosted', hostedTarget), hostedTargetHash);
assert.deepStrictEqual(
  verifyLiveTargetBinding({ jobName: 'hosted', target: hostedTarget, signedTargetHash: hostedTargetHash }),
  { ok: true, jobName: 'hosted', targetHash: hostedTargetHash }
);
assert.throws(
  () => verifyLiveTargetBinding({
    jobName: 'hosted',
    target: { ...hostedTarget, restoreTargetFingerprint: 'e'.repeat(64) },
    signedTargetHash: hostedTargetHash
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
);

assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: 'd'.repeat(64),
    requestedJobs: ['github', 'gitlab'],
    expectedTargets: targets,
    now
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_SUBJECT_MISMATCH'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github', 'gitlab'],
    expectedTargets: targets,
    now: new Date('2026-07-29T20:16:00.000Z')
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_EXPIRED'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github', 'gitlab'],
    expectedTargets: {
      ...targets,
      github: { ...targets.github, repository: 'fixture-owner/nvx-alpha17-a-different-repository' }
    },
    now
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github'],
    expectedTargets: { github: targets.github },
    now
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_JOBS_INVALID'
);
assert.throws(
  () => verifyLiveTargetBinding({
    jobName: 'github',
    target: { ...targets.github, repository: 'fixture-owner/nvx-alpha17-a-different-repository' },
    signedTargetHash: targetHashes.github
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
);
const duplicateJobsToken = encodeAuthorizationEnvelope({
  ...payload,
  authorizedJobs: ['github', 'github', 'gitlab']
}, privateKey);
assert.throws(
  () => verifyAuthorizationEnvelope(duplicateJobsToken, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github', 'gitlab'],
    expectedTargets: targets,
    now
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_JOBS_INVALID'
);

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'public-alpha-alpha17.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const ciWorkflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8'
);

function remoteActionReferences(source) {
  return [...source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map(match => match[1])
    .filter(reference => !reference.startsWith('./'));
}

function assertImmutableActionReference(reference, workflowName) {
  if (reference.startsWith('docker://')) {
    assert.match(
      reference,
      /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/,
      `${workflowName} Docker action ${reference} must use an immutable SHA-256 digest`
    );
    return;
  }
  const separator = reference.lastIndexOf('@');
  assert(separator > 0, `${workflowName} remote action ${reference} must include a ref`);
  assert.match(
    reference.slice(separator + 1),
    /^[0-9a-f]{40}$/,
    `${workflowName} remote action ${reference} must use a full immutable commit SHA`
  );
}

function actionStepBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+uses:\s*([^\s#]+)/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    let end = index + 1;
    while (end < lines.length && !new RegExp(`^\\s{${indentation}}-\\s+`).test(lines[end])) end += 1;
    blocks.push({ reference: match[2], source: lines.slice(index, end).join('\n') });
  }
  return blocks;
}

for (const [name, source] of [
  ['CI', ciWorkflow],
  ['alpha.17 qualification', workflow]
]) {
  for (const reference of remoteActionReferences(source)) {
    assertImmutableActionReference(reference, name);
  }
  for (const block of actionStepBlocks(source).filter(item => item.reference.startsWith('actions/checkout@'))) {
    assert(
      /^\s+persist-credentials:\s*false\s*$/m.test(block.source),
      `${name} checkout must not persist Git credentials`
    );
  }
}
assert.doesNotThrow(() => assertImmutableActionReference(
  `docker://example.invalid/qualifier@sha256:${'a'.repeat(64)}`,
  'fixture'
));
assert.throws(
  () => assertImmutableActionReference('docker://example.invalid/qualifier:latest', 'fixture'),
  /immutable SHA-256 digest/i
);

assert(/^on:\n(?:[\s\S]*\n)?  pull_request:/m.test(workflow), 'pull_request trigger is required');
assert(/^  workflow_dispatch:/m.test(workflow), 'workflow_dispatch trigger is required');
assert(!/^\s{2}push:/m.test(workflow), 'qualification must not run on push');
assert(/^permissions:\n  contents: read$/m.test(workflow), 'default permissions must be contents: read');
assert(/node-version:\s*['"]?22\.23\.1['"]?/m.test(workflow), 'exact Node 22.23.1 setup is required');
assert(!/group:[^\n]*github\.run_id/.test(workflow), 'live runs must not use a run-unique concurrency group');
assert(workflow.includes('live-shared-targets'), 'all live dispatches must share one concurrency group');
assert(/^  cancel-in-progress: false$/m.test(workflow), 'a running destructive qualification must not be cancelled');
assert.strictEqual((workflow.match(/runs-on: ubuntu-24\.04/g) || []).length, 6, 'every job must pin ubuntu-24.04');
const actionPins = {
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093'
};
for (const [action, commit] of Object.entries(actionPins)) {
  assert(workflow.includes(`uses: ${action}@${commit}`), `${action} must use its reviewed immutable commit`);
}
for (const input of [
  'subject_sha256', 'source_commit', 'run_github', 'run_gitlab',
  'run_gitea', 'run_hosted', 'authorization_token'
]) {
  assert(new RegExp(`^      ${input}:`, 'm').test(workflow), `missing dispatch input ${input}`);
}

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert(start >= 0, `missing workflow job ${name}`);
  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

const automated = job('automated');
assert(!automated.includes('${{ secrets.'), 'credential-free job must not reference secrets');
assert(
  new RegExp(`uses: actions/checkout@${actionPins['actions/checkout']}[\\s\\S]*?fetch-depth:\\s*0`).test(automated),
  'automated continuity verification requires a full-history checkout'
);
for (const command of [
  'npm ci',
  'node scripts/resume-work.js --require-clean --json',
  'npm run check:syntax',
  'npm run check:secrets',
  'npm audit --omit=dev --audit-level=high',
  'npm audit --json',
  'npm run test:runtime:matrix',
  'npm run test:e2e'
]) assert(automated.includes(command), `automated job omits ${command}`);
const qualificationDocsCheck = automated.indexOf('npm run docs:check');
const qualificationPackage = automated.indexOf('npm run package:release');
assert(
  qualificationDocsCheck >= 0 && qualificationDocsCheck < qualificationPackage,
  'qualification must check generated documentation before package creation'
);
assert((automated.match(/npm run package:release/g) || []).length >= 2, 'candidate must be built twice');
assert(automated.includes('cmp '), 'double package bytes must be compared');
assert(
  automated.includes('node scripts/qualify-candidate-archive.js'),
  'the extracted candidate must own the qualification matrix execution'
);
for (const argument of [
  '--browser-report', '--evidence', '--source-commit', '--origin-id'
]) assert(automated.includes(argument), `candidate qualifier must bind ${argument}`);
assert(automated.includes('automated.json'), 'the exact candidate must emit an automated evidence envelope');
assert(
  !/NV_STAGING_SUBJECT_SHA256="\$\{subject_sha256\}" npm run test:public-alpha:matrix/.test(automated),
  'the checkout must not run the packaged-candidate matrix'
);

const authorization = job('authorize-live');
assert(authorization.includes("github.event_name == 'workflow_dispatch'"));
assert(authorization.includes('ci/verify-alpha17-authorization.js'));
assert(!authorization.includes('${{ secrets.'), 'authorization job must verify before secrets are read');
for (const variable of [
  'ALPHA17_GITHUB_REPOSITORY', 'ALPHA17_GITLAB_REPOSITORY',
  'ALPHA17_GITEA_REPOSITORY', 'ALPHA17_GITEA_API_URL',
  'ALPHA17_HOSTED_BASE_URL', 'ALPHA17_RENDER_SERVICE_ID',
  'ALPHA17_NEON_PROJECT_ID', 'ALPHA17_COHORT_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_NEON_PROJECT_ID', 'ALPHA17_RESTORE_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_TARGET_FINGERPRINT'
]) assert(authorization.includes(variable), `authorization job must bind ${variable}`);

for (const name of ['github-live', 'gitlab-live', 'gitea-live', 'hosted-live']) {
  const block = job(name);
  assert(block.includes("github.event_name == 'workflow_dispatch'"), `${name} must be dispatch-only`);
  assert(block.includes('needs: [automated, authorize-live]'), `${name} must depend on automated and authorization gates`);
  assert(block.includes('inputs.subject_sha256'), `${name} must bind the subject hash`);
  assert(block.includes('inputs.source_commit'), `${name} must bind the source commit`);
  assert(block.includes(`actions/setup-node@${actionPins['actions/setup-node']}`), `${name} must pin Node before candidate execution`);
  assert(/node-version:\s*['"]?22\.23\.1['"]?/.test(block), `${name} must execute with Node 22.23.1`);
  const preflightIndex = block.indexOf('Verify signed live target');
  const firstSecretIndex = block.indexOf('${{ secrets.');
  assert(preflightIndex >= 0, `${name} must run a signed-target preflight`);
  assert(firstSecretIndex > preflightIndex, `${name} must not reference credentials before target preflight`);
  const hashIndex = block.indexOf('sha256sum -c');
  const extractIndex = block.indexOf('unzip ');
  assert(hashIndex >= 0 && extractIndex > hashIndex, `${name} must verify the archive before extraction`);
}

const hosted = job('hosted-live');
const hostedPreflightIndex = hosted.indexOf('Verify signed live target');
const hostedInstallIndex = hosted.indexOf('Install hosted runner dependencies without lifecycle scripts');
const hostedRestoreIndex = hosted.indexOf('Execute isolated restore and create runner attestation');
const hostedValidationIndex = hosted.indexOf('Run hosted gate from runner and signed operator records');
const hostedFirstSecretIndex = hosted.indexOf('${{ secrets.');
assert(
  hostedInstallIndex > hostedPreflightIndex && hostedInstallIndex < hostedFirstSecretIndex,
  'hosted dependencies must be installed without credentials after signed-target preflight'
);
assert(
  hosted.includes('npm ci --ignore-scripts --no-audit --no-fund'),
  'hosted dependency installation must suppress lifecycle scripts and unrelated network checks'
);
assert(
  hostedRestoreIndex > hostedInstallIndex && hostedValidationIndex > hostedRestoreIndex,
  'the workflow runner must execute and attest restore before the hosted gate consumes the proof'
);
for (const binding of [
  'ALPHA17_DATABASE_URL',
  'ALPHA17_RESTORE_DATABASE_URL',
  'ALPHA17_BACKUP_KEY_BASE64',
  'ALPHA17_NEON_API_KEY',
  'ALPHA17_COHORT_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_NEON_PROJECT_ID',
  'ALPHA17_RESTORE_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_TARGET_FINGERPRINT'
]) assert(hosted.includes(binding), `hosted restore execution must bind ${binding}`);
assert(hosted.includes('ci/run-alpha17-restore-validation.js'));
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION_PATH'));
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION'));
assert(
  !/path:[^\n]*restore-attestation/.test(hosted),
  'the standalone runner restore attestation must not be uploaded outside the sanitized hosted envelope'
);

for (const artifact of [
  'alpha17-automated-evidence',
  'alpha17-github-evidence',
  'alpha17-gitlab-evidence',
  'alpha17-gitea-evidence',
  'alpha17-hosted-evidence'
]) assert(workflow.includes(`name: ${artifact}`), `missing sanitized artifact ${artifact}`);
assert(workflow.includes('scripts/check-secrets.js'));

const ciDocsCheck = ciWorkflow.indexOf('npm run docs:check');
const ciPackage = ciWorkflow.indexOf('npm run package:release');
assert(
  ciDocsCheck >= 0 && ciDocsCheck < ciPackage,
  'standard CI must check generated documentation before package creation'
);

console.log('public alpha workflow contract tests passed');
