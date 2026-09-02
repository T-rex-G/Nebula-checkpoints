'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AUTHORIZATION_SCHEMA_VERSION,
  encodeAuthorizationEnvelope,
  fileClaimLedger,
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
  schemaVersion: '1.3.0',
  workflow: '.github/workflows/public-alpha-alpha17.yml',
  repository: 'fixture-owner/fixture-repository',
  ref: 'refs/heads/sandbox/alpha17-live-qualification',
  event: 'workflow_dispatch',
  sourceParent: 'c'.repeat(40),
  sourceCommit: 'b'.repeat(40),
  subjectSha256: 'a'.repeat(64),
  authorizedJobs: ['github', 'gitlab'],
  targetHashes,
  authorizationId: 'approval-2048',
  expiresAt: '2026-07-29T20:15:00.000Z'
};
assert.strictEqual(AUTHORIZATION_SCHEMA_VERSION, payload.schemaVersion);

/*
 * Every activation envelope is spendable exactly once, so a verification that
 * shares a ledger with another verification is a different test from one that
 * does not. Each assertion below therefore gets its own ledger unless it is
 * deliberately probing replay, and the replay assertions name their shared
 * ledger explicitly.
 */
function memoryClaimLedger() {
  const spent = new Set();
  return {
    spent,
    record(id) {
      assert.match(id, /^[0-9a-f]{64}$/, 'the ledger must receive an opaque fixed-width claim identifier');
      if (spent.has(id)) return false;
      spent.add(id);
      return true;
    }
  };
}

function verifyOptions(overrides = {}) {
  return {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedRef: payload.ref,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github', 'gitlab'],
    expectedTargets: targets,
    claims: memoryClaimLedger(),
    now,
    ...overrides
  };
}

const token = encodeAuthorizationEnvelope(payload, privateKey);
const verified = verifyAuthorizationEnvelope(token, verifyOptions());
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
  restoreTargetFingerprint: 'f'.repeat(64),
  restoreAppBaseUrl: 'https://restore-alpha17.example.test',
  restoreAppDeployId: 'deploy-restore-alpha17'
};
const hostedTargetHash = crypto.createHash('sha256').update(JSON.stringify({
  baseUrl: hostedTarget.baseUrl,
  cohortNeonBranchId: hostedTarget.cohortNeonBranchId,
  jobName: 'hosted',
  neonProjectId: hostedTarget.neonProjectId,
  renderServiceId: hostedTarget.renderServiceId,
  restoreAppBaseUrl: hostedTarget.restoreAppBaseUrl,
  restoreAppDeployId: hostedTarget.restoreAppDeployId,
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
  () => hashLiveTarget('hosted', {
    ...hostedTarget,
    restoreAppBaseUrl: hostedTarget.baseUrl
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_INVALID',
  'the restore-backed application must not reuse the cohort application origin'
);

assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({
    expectedSubjectHash: 'd'.repeat(64)
  })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_SUBJECT_MISMATCH'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({
    now: new Date('2026-07-29T20:16:00.000Z')
  })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_EXPIRED'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({
    expectedTargets: {
      ...targets,
      github: { ...targets.github, repository: 'fixture-owner/nvx-alpha17-a-different-repository' }
    }
  })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({
    requestedJobs: ['github'],
    expectedTargets: { github: targets.github }
  })),
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
  () => verifyAuthorizationEnvelope(duplicateJobsToken, verifyOptions()),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_JOBS_INVALID'
);

/*
 * Single use.
 *
 * The envelope is a workflow_dispatch input, so it is recorded in the run's
 * event payload and readable by anyone who can read the run. It is therefore
 * not a secret after its first use, and every field it binds -- workflow,
 * repository, ref, event, source parent and commit, subject, jobs, targets --
 * is identical across repeated dispatches of the same candidate. Expiry alone
 * leaves a window in which a captured envelope activates the live targets
 * again. The signer's authorizationId is the nonce that closes it, and these
 * assertions are what make it one.
 */
const sharedLedger = memoryClaimLedger();
assert.strictEqual(
  verifyAuthorizationEnvelope(token, verifyOptions({ claims: sharedLedger })).authorizationId,
  payload.authorizationId
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({ claims: sharedLedger })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_REPLAYED',
  'the same envelope must not activate live targets twice'
);

/*
 * The claim is on the signer's identifier, not on the bytes that carry it.
 * Re-signing the same approval with a later expiry produces different bytes,
 * and a byte-keyed ledger would admit it.
 */
const resignedToken = encodeAuthorizationEnvelope(
  { ...payload, expiresAt: '2026-07-29T20:20:00.000Z' },
  privateKey
);
assert.notStrictEqual(resignedToken, token);
assert.throws(
  () => verifyAuthorizationEnvelope(resignedToken, verifyOptions({ claims: sharedLedger })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_REPLAYED',
  're-signing a spent approval identifier must not mint a second activation'
);

const freshApprovalToken = encodeAuthorizationEnvelope(
  { ...payload, authorizationId: 'approval-2049' },
  privateKey
);
assert.strictEqual(
  verifyAuthorizationEnvelope(freshApprovalToken, verifyOptions({ claims: sharedLedger })).authorizationId,
  'approval-2049',
  'a distinct approval must still activate'
);

/*
 * A rejected envelope must not spend its identifier. Otherwise any reader of
 * the run could burn a pending approval by dispatching it against the wrong
 * subject, and the operator would have to re-sign to recover.
 */
const survivingLedger = memoryClaimLedger();
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({
    claims: survivingLedger,
    expectedSubjectHash: 'd'.repeat(64)
  })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_SUBJECT_MISMATCH'
);
assert.strictEqual(survivingLedger.spent.size, 0, 'a rejected envelope must not spend its approval identifier');
assert.strictEqual(
  verifyAuthorizationEnvelope(token, verifyOptions({ claims: survivingLedger })).authorizationId,
  payload.authorizationId
);

/*
 * Fail closed. A verifier that cannot record the spend cannot claim the
 * envelope is unspent, so an absent or broken ledger is a refusal and not a
 * silent downgrade to expiry-only checking.
 */
for (const [label, claims] of [
  ['an absent ledger', undefined],
  ['a ledger with no record method', {}],
  ['a throwing ledger', { record() { throw new Error('cache unavailable'); } }],
  ['a ledger that does not report novelty', { record() { return 'yes'; } }]
]) {
  assert.throws(
    () => verifyAuthorizationEnvelope(token, verifyOptions({ claims })),
    error => error && error.code === 'ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE',
    `${label} must refuse activation`
  );
}

/*
 * The dispatch ref is bound because the ledger is only durable within one
 * cache scope. Without this, the same commit pushed to a second branch would
 * be dispatched against a ledger that has never seen the approval.
 */
assert.throws(
  () => verifyAuthorizationEnvelope(token, verifyOptions({ expectedRef: 'refs/heads/other-branch' })),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH',
  'an envelope must not activate on a ref it does not name'
);
for (const badRef of ['', 'sandbox/alpha17-live-qualification', 'refs/heads/../../etc', 'refs/heads/a//b']) {
  assert.throws(
    () => verifyAuthorizationEnvelope(
      encodeAuthorizationEnvelope({ ...payload, ref: badRef }, privateKey),
      verifyOptions({ expectedRef: badRef })
    ),
    error => error && error.code === 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH',
    `ref ${JSON.stringify(badRef)} must be rejected`
  );
}

/*
 * An envelope signed under the previous schema must not verify. Only the
 * schema value differs: an envelope that also dropped `ref` would be refused
 * by the completeness check below, which raises the same code, and the
 * assertion would pass without the schema comparison ever running.
 */
assert.throws(
  () => verifyAuthorizationEnvelope(
    encodeAuthorizationEnvelope({ ...payload, schemaVersion: '1.2.0' }, privateKey),
    verifyOptions()
  ),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_INVALID',
  'an envelope declaring the previous schema must not verify'
);

/*
 * An omitted field is malformed, not a scope failure. Without an explicit
 * completeness check an absent ref reaches the ref comparison and is reported
 * as a mismatched ref, which sends an operator looking for a branch problem
 * that does not exist. Each field is deleted from an otherwise valid envelope
 * so the check cannot be satisfied by whichever downstream check happens to
 * notice first.
 */
for (const field of Object.keys(payload)) {
  const incomplete = { ...payload };
  delete incomplete[field];
  assert.throws(
    () => verifyAuthorizationEnvelope(
      encodeAuthorizationEnvelope(incomplete, privateKey),
      verifyOptions()
    ),
    error => error && error.code === 'ALPHA17_AUTHORIZATION_INVALID',
    `an envelope omitting ${field} must be rejected as malformed`
  );
}

/*
 * The shipped ledger. It claims by exclusive create, so the record and the
 * novelty answer are one filesystem operation rather than a check followed by
 * a write that a concurrent dispatch could interleave with.
 */
const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha17-claims-'));
const fileLedger = fileClaimLedger(ledgerRoot);
const sampleClaim = 'a1'.repeat(32);
assert.strictEqual(fileLedger.record(sampleClaim), true);
assert.strictEqual(fileLedger.record(sampleClaim), false, 'a recorded claim must report itself as spent');
assert.strictEqual(fs.readdirSync(ledgerRoot).length, 1);
assert.throws(() => fileLedger.record('not-a-claim-identifier'), TypeError);
assert.throws(
  () => fileClaimLedger(path.join(ledgerRoot, 'absent')).record(sampleClaim),
  error => error && error.code === 'ENOENT',
  'an unwritable ledger must surface as unavailable rather than as an unspent claim'
);
assert.throws(() => fileClaimLedger(''), TypeError);
const claimedIdentifiers = new Set();
for (const approvalId of ['approval-2048', 'approval-2049', '........']) {
  const ledger = { record(id) { claimedIdentifiers.add(id); return true; } };
  verifyAuthorizationEnvelope(
    encodeAuthorizationEnvelope({ ...payload, authorizationId: approvalId }, privateKey),
    verifyOptions({ claims: ledger })
  );
}
assert.strictEqual(claimedIdentifiers.size, 3);
for (const id of claimedIdentifiers) {
  assert.match(id, /^[0-9a-f]{64}$/, 'approval identifiers must never reach the ledger as path segments');
}

/*
 * The command line is what the workflow actually runs, so the refusal is
 * exercised through it rather than only through the exported function. The
 * two runs below differ in nothing but the ledger they share.
 */
const cliLedgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha17-cli-claims-'));
/* main() reads the real clock, so this envelope expires against it. */
const cliToken = encodeAuthorizationEnvelope({
  ...payload,
  authorizationId: 'approval-cli-1',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
}, privateKey);
function runVerifierCli(input, env = {}) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'ci', 'verify-alpha17-authorization.js')],
    {
      input,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NV_ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64: publicKeyBase64,
        NV_ALPHA17_AUTHORIZATION_CLAIM_DIR: cliLedgerRoot,
        NV_ALPHA17_EXPECTED_WORKFLOW: payload.workflow,
        NV_ALPHA17_EXPECTED_REPOSITORY: payload.repository,
        NV_ALPHA17_EXPECTED_REF: payload.ref,
        NV_ALPHA17_EXPECTED_EVENT: payload.event,
        NV_ALPHA17_EXPECTED_SOURCE_PARENT: payload.sourceParent,
        NV_ALPHA17_EXPECTED_SOURCE_COMMIT: payload.sourceCommit,
        NV_ALPHA17_EXPECTED_SUBJECT_SHA256: payload.subjectSha256,
        NV_ALPHA17_REQUESTED_JOBS: 'github,gitlab',
        NV_ALPHA17_GITHUB_REPOSITORY: targets.github.repository,
        NV_ALPHA17_GITHUB_API_URL: targets.github.apiUrl,
        NV_ALPHA17_GITLAB_REPOSITORY: targets.gitlab.repository,
        NV_ALPHA17_GITLAB_API_URL: targets.gitlab.apiUrl,
        ...env
      }
    }
  );
}
const firstCliRun = runVerifierCli(cliToken);
assert.strictEqual(firstCliRun.status, 0, `first activation must succeed: ${firstCliRun.stderr}`);
assert.strictEqual(JSON.parse(firstCliRun.stdout).authorizationId, 'approval-cli-1');
const replayedCliRun = runVerifierCli(cliToken);
assert.strictEqual(replayedCliRun.status, 1, 'a replayed activation must exit non-zero');
assert(
  replayedCliRun.stderr.includes('ALPHA17_AUTHORIZATION_REPLAYED'),
  `a replayed activation must name the replay: ${replayedCliRun.stderr}`
);
const unconfiguredCliRun = runVerifierCli(cliToken, { NV_ALPHA17_AUTHORIZATION_CLAIM_DIR: '' });
assert.strictEqual(unconfiguredCliRun.status, 1);
assert(
  unconfiguredCliRun.stderr.includes('ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE'),
  `an unconfigured ledger must refuse before verifying: ${unconfiguredCliRun.stderr}`
);
assert(
  !unconfiguredCliRun.stdout.trim(),
  'a refused activation must not emit an authorization result'
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

for (const [name, source] of [
  ['CI', ciWorkflow],
  ['alpha.17 qualification', workflow]
]) {
  for (const reference of remoteActionReferences(source)) {
    assertImmutableActionReference(reference, name);
  }
  /*
   * Checked without parsing the workflow.
   *
   * Three consecutive reviews found a valid YAML spelling that the previous
   * step-parser skipped -- a named step, then a bare dash, then a comment after
   * the dash -- and each time the contract reported a pass it had never made.
   * The lesson is not to parse better; a fourth regular expression still owes
   * flow mappings, quoted keys, anchors and block scalars. It is to assert a
   * property that does not depend on where a step begins.
   *
   * Two facts give that property. actions/checkout defaults persist-credentials
   * to true, so an omitted setting is the dangerous state, not a neutral one --
   * which the count catches. And every setting present must read false, which
   * the value check catches. No layout can satisfy both while leaving a
   * checkout persisting credentials.
   *
   * What it deliberately does not prove: which false belongs to which checkout.
   * Two on one step and none on another would pass. That limit is visible in
   * four lines, which is the whole point -- the parser's limits were invisible
   * and surprised us three times.
   */
  const checkouts = source.match(/uses:[ \t]*actions\/checkout@/g) || [];
  const persistSettings = [...source.matchAll(/persist-credentials:[ \t]*(\S*)/g)];
  for (const [, value] of persistSettings) {
    assert.strictEqual(value, 'false',
      `${name} must never set persist-credentials to anything but false`);
  }
  assert.strictEqual(persistSettings.length, checkouts.length,
    `${name} must set persist-credentials: false on every checkout, including omitted ones`);
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
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
  'actions/cache/restore': '0057852bfaa89a56745cba8c7296529d2fc39830',
  'actions/cache/save': '0057852bfaa89a56745cba8c7296529d2fc39830'
};
for (const [action, commit] of Object.entries(actionPins)) {
  assert(workflow.includes(`uses: ${action}@${commit}`), `${action} must use its reviewed immutable commit`);
}
for (const input of [
  'run_github', 'run_gitlab', 'run_gitea', 'run_hosted'
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
const playwrightCacheBinding = automated.indexOf('PLAYWRIGHT_BROWSERS_PATH=%s');
const playwrightInstall = automated.indexOf('npx playwright install --with-deps chromium');
/* The message below claims both matrices, so bound the last invocation. */
const checkoutBrowserMatrix = automated.lastIndexOf('npm run test:e2e');
const extractedCandidateQualifier = automated.indexOf('node scripts/qualify-candidate-archive.js');
assert(
  playwrightCacheBinding >= 0 &&
    playwrightCacheBinding < playwrightInstall &&
    playwrightInstall < checkoutBrowserMatrix &&
    checkoutBrowserMatrix < extractedCandidateQualifier,
  'Playwright installation and both browser matrices must share one cache bound before installation'
);
assert(
  automated.includes('playwright_browsers="${RUNNER_TEMP}/ms-playwright"') &&
    automated.includes('>> "${GITHUB_ENV}"'),
  'the automated job must persist an absolute runner-temp Playwright cache for subsequent isolated steps'
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

/*
 * The envelope is minted by the run and verified by the same verifier that
 * always checked it. Two properties matter and neither is visible from the
 * mint alone.
 *
 * The mint must be fed the run's own facts, not a dispatch input: an operator
 * who could hand in the candidate digest or the source commit could authorize
 * a run against bytes the automated job never built.
 *
 * And the verification must still happen. A mint whose output was trusted
 * without being run back through the verifier would skip every binding --
 * workflow, repository, ref, event, parents, digest, jobs and target hashes --
 * and the gate would authorize whatever it was handed.
 */
assert(
  /scripts\/alpha17-authorize\.js sign[\s\S]{0,200}--ephemeral-key/.test(authorization),
  'the run must mint its own activation envelope with a key it generates'
);
/*
 * Named by where it comes from, not by the word. The minted file carries an
 * `authorization_token` key that the step reads back, so matching the bare
 * word would fail on correct code; what must not appear is the envelope
 * arriving from outside the run.
 */
assert(
  !/inputs\.authorization_token|AUTHORIZATION_ENVELOPE/.test(authorization),
  'the activation envelope must not arrive as a dispatch input'
);
for (const binding of [
  'NV_ALPHA17_EXPECTED_SUBJECT_SHA256: ${{ needs.automated.outputs.subject_sha256 }}',
  'NV_ALPHA17_EXPECTED_SOURCE_COMMIT: ${{ needs.automated.outputs.source_commit }}',
  'NV_ALPHA17_EXPECTED_SOURCE_PARENT: ${{ needs.automated.outputs.source_parent }}'
]) {
  assert(
    authorization.includes(binding),
    `the minted envelope must bind the qualified candidate through ${binding.split(':')[0]}`
  );
}
assert(
  !/NV_ALPHA17_EXPECTED_(?:SUBJECT_SHA256|SOURCE_COMMIT|SOURCE_PARENT): \$\{\{ inputs\./.test(authorization),
  'the minted envelope must never bind a candidate the dispatcher supplied'
);
const mintIndex = authorization.indexOf('--ephemeral-key');
const verifyIndex = authorization.indexOf('ci/verify-alpha17-authorization.js');
assert(
  mintIndex >= 0 && mintIndex < verifyIndex,
  'a minted envelope must still be put through the verifier'
);
for (const variable of [
  'ALPHA17_GITHUB_REPOSITORY', 'ALPHA17_GITLAB_REPOSITORY',
  'ALPHA17_GITEA_REPOSITORY', 'ALPHA17_GITEA_API_URL',
  'ALPHA17_HOSTED_BASE_URL', 'ALPHA17_RENDER_SERVICE_ID',
  'ALPHA17_NEON_PROJECT_ID', 'ALPHA17_COHORT_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_NEON_PROJECT_ID', 'ALPHA17_RESTORE_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_TARGET_FINGERPRINT', 'ALPHA17_RESTORE_APP_BASE_URL',
  'ALPHA17_RESTORE_APP_DEPLOY_ID'
]) assert(authorization.includes(variable), `authorization job must bind ${variable}`);


/*
 * The spend ledger must be restored before the envelope is verified and saved
 * after, and the verifier must be told where it lives. Order is the property
 * that matters: a save that preceded the verification would persist nothing,
 * and a verification that preceded the restore would read an empty ledger and
 * accept every replay.
 */
const claimRestore = authorization.indexOf('uses: actions/cache/restore@');
const claimVerify = authorization.indexOf('ci/verify-alpha17-authorization.js');
const claimSave = authorization.indexOf('uses: actions/cache/save@');
assert(
  claimRestore >= 0 && claimRestore < claimVerify && claimVerify < claimSave,
  'the spent-approval ledger must be restored before verification and saved after it'
);
/*
 * Checked by value, not by presence.
 *
 * A presence check passes on the shell reference inside the run block, so it
 * stays green with the binding deleted -- the verifier would then refuse every
 * dispatch, but the contract would have reported a pass it never made. What
 * actually has to hold is that one directory is bound to the verifier and that
 * the same directory is the one cached. If those diverge the cache preserves
 * an empty ledger and every replay is admitted, which no presence check sees.
 */
const claimDirectoryBindings = [...authorization.matchAll(/NV_ALPHA17_AUTHORIZATION_CLAIM_DIR: ([^\n]+)/g)]
  .map(match => match[1].trim());
assert.strictEqual(
  claimDirectoryBindings.length, 1,
  'the spent-approval ledger directory must be bound to the verifier exactly once'
);
const cachedLedgerPaths = [...authorization.matchAll(/^[ \t]+path: ([^\n]*authorization-claims[^\n]*)$/gm)]
  .map(match => match[1].trim());
assert.strictEqual(cachedLedgerPaths.length, 2, 'restore and save must both carry the ledger');
for (const cached of cachedLedgerPaths) {
  assert.strictEqual(
    cached, claimDirectoryBindings[0],
    'the cached ledger must be the exact directory the verifier records spends in'
  );
}
assert(
  authorization.includes('NV_ALPHA17_EXPECTED_REF: ${{ github.ref }}'),
  'the authorization job must bind the exact dispatch ref the envelope names'
);
/*
 * A run-unique save key with a shared restore prefix is what makes the ledger
 * roll forward. A key that did not vary per run could never be written twice,
 * so the ledger would freeze at its first entry and stop detecting replays.
 */
const claimKeys = [...authorization.matchAll(/key: (alpha17-authorization-claims[^\n]*)/g)]
  .map(match => match[1].trim());
assert.strictEqual(claimKeys.length, 2, 'restore and save must both name the ledger cache');
for (const key of claimKeys) {
  assert(key.includes('github.run_id'), `ledger cache key ${key} must be unique per run`);
}
assert(
  /restore-keys: \|\n\s+alpha17-authorization-claims-\n/.test(authorization),
  'the ledger must restore the most recent prior run through a shared key prefix'
);
/*
 * The spend is recorded before the verification step finishes -- the step goes
 * on to extract the envelope and target hashes -- so a failure in that tail
 * would discard a spend that had already happened, and the approval would be
 * replayable for the rest of its lifetime. The save therefore runs on failure
 * as well.
 */
const ledgerSaveStep = authorization.slice(authorization.indexOf('- name: Persist spent-approval ledger'));
assert(
  /^\s+if: always\(\)$/m.test(ledgerSaveStep.slice(0, ledgerSaveStep.indexOf('uses:'))),
  'the spent-approval ledger must be saved even when verification fails after recording a spend'
);

for (const name of ['github-live', 'gitlab-live', 'gitea-live', 'hosted-live']) {
  const block = job(name);
  assert(block.includes("github.event_name == 'workflow_dispatch'"), `${name} must be dispatch-only`);
  assert(block.includes('needs: [automated, authorize-live]'), `${name} must depend on automated and authorization gates`);
  assert(block.includes('needs.automated.outputs.subject_sha256'), `${name} must bind the qualified subject hash`);
  assert(block.includes('needs.automated.outputs.source_commit'), `${name} must bind the qualified source commit`);
  assert(!block.includes('${{ inputs.subject_sha256 }}'), `${name} must not interpolate an untrusted subject input`);
  assert(!block.includes('${{ inputs.source_commit }}'), `${name} must not interpolate an untrusted source input`);
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
const hostedValidationIndex = hosted.indexOf('Run authenticated restore and hosted gate from trusted runner');
const hostedFirstSecretIndex = hosted.indexOf('${{ secrets.');
assert(
  hostedPreflightIndex >= 0 && hostedInstallIndex > hostedPreflightIndex && hostedInstallIndex < hostedFirstSecretIndex,
  'hosted dependencies must be installed without credentials after signed-target preflight'
);
assert(hosted.includes('path: trusted-runner'), 'hosted validation must execute from an exact trusted checkout');
assert(
  hosted.includes('NV_ALPHA17_EXPECTED_SOURCE_COMMIT: ${{ needs.automated.outputs.source_commit }}'),
  'the trusted-checkout source identity must enter the shell through the step environment'
);
assert(
  hosted.includes("printf '%s\\n' \"${NV_ALPHA17_EXPECTED_SOURCE_COMMIT}\" | grep -qxE '[0-9a-f]{40}'"),
  'the trusted-checkout source identity must be validated before comparison'
);
assert(hosted.includes('restore_attestation="${RUNNER_TEMP}/alpha17-restore-attestation.json"'),
  'the restore attestation must be written under RUNNER_TEMP');
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION_PATH="${restore_attestation}"'),
  'the restore runner must write the attestation to the bound path');
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION="${restore_attestation}"'),
  'the hosted gate must read the attestation from the bound path');
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64="$(openssl rand -base64 32)"'),
  'the attestation key must be generated per run');
/*
 * The restore runner clears its own backup directory on success and failure,
 * but a cancelled job never reaches that code, and every alpha-db command
 * blocks the event loop so no in-process handler could. This trap is the layer
 * that survives cancellation, so it must cover the decryptable backup material.
 */
assert(/trap '[^']*rm -rf -- "\$\{RUNNER_TEMP\}"\/nvx-alpha17-restore-\*[^']*' EXIT/.test(hosted),
  'the hosted step must clear restore backup material on cancellation');

assert(hosted.includes('unset NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64'),
  'the attestation key must be unset before the candidate secret scan');
assert(
  hosted.includes('npm ci --ignore-scripts --no-audit --no-fund'),
  'hosted dependency installation must suppress lifecycle scripts and unrelated network checks'
);
assert(
  hostedValidationIndex > hostedInstallIndex,
  'the trusted workflow runner must execute restore before the hosted gate consumes the proof'
);
for (const binding of [
  'ALPHA17_DATABASE_URL',
  'ALPHA17_RESTORE_DATABASE_URL',
  'ALPHA17_BACKUP_KEY_BASE64',
  'ALPHA17_NEON_API_KEY',
  'ALPHA17_COHORT_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_NEON_PROJECT_ID',
  'ALPHA17_RESTORE_NEON_BRANCH_ID',
  'ALPHA17_RESTORE_TARGET_FINGERPRINT',
  'ALPHA17_RESTORE_APP_BASE_URL',
  'ALPHA17_RESTORE_APP_DEPLOY_ID',
  'ALPHA17_OPERATOR_KEY_ID'
]) assert(hosted.includes(binding), `hosted restore execution must bind ${binding}`);
assert(hosted.includes('ci/run-alpha17-restore-validation.js'));
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION_PATH'));
assert(hosted.includes('NV_ALPHA17_RESTORE_ATTESTATION'));
assert(hosted.includes('PGSSLROOTCERT: /etc/ssl/certs/ca-certificates.crt'),
  'hosted restore must pin an explicit trusted CA for Node pg and libpq children');
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
