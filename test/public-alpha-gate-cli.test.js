'use strict';

const assert = require('assert');
const { PROVIDER_CAPABILITY_REQUIREMENTS } = require('../src/qualification-evidence');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { createArtifactVerifier, parseArgs } = require('../scripts/public-alpha-gate');
const { createPassFixture } = require('./helpers/public-alpha-pass-fixture');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');

assert.deepStrictEqual(parseArgs(['plan']), { command: 'plan' });
assert.deepStrictEqual(parseArgs(['verify', '/tmp/evidence.json']), {
  command: 'verify',
  evidence: '/tmp/evidence.json'
});
assert.deepStrictEqual(parseArgs([
  'close', '/tmp/evidence.json', '--output-dir', '/tmp/alpha17-closeout'
]), {
  command: 'close',
  evidence: '/tmp/evidence.json',
  outputDir: '/tmp/alpha17-closeout'
});
assert.throws(() => parseArgs(['close', '/tmp/evidence.json']), /--output-dir/);
assert.throws(() => parseArgs(['verify', 'relative.json']), /absolute path/);
assert.throws(() => parseArgs(['plan', '--unexpected']), /does not accept/);

const root = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-alpha-gate-test-'));
try {
  const fixture = createPassFixture();
  fixture.envelopes['hosted-artifact'].deploymentSha256 = computeReleaseFingerprint(root);
  fixture.bindings.expectedDeploymentSha256 = fixture.envelopes['hosted-artifact'].deploymentSha256;
  const evidence = fixture.record;
  const completedAt = new Date().toISOString();
  evidence.generatedAt = completedAt;
  for (const section of [evidence.automated, evidence.hosted, evidence.manual]) {
    for (const item of Object.values(section)) item.completedAt = completedAt;
  }
  for (const provider of Object.values(evidence.providers)) {
    for (const item of Object.values(provider)) item.completedAt = completedAt;
  }
  for (const artifact of evidence.artifacts) {
    const envelope = fixture.envelopes[artifact.id];
    envelope.completedAt = completedAt;
    for (const claim of Object.values(envelope.claims)) claim.completedAt = completedAt;
    const artifactPath = path.join(temporaryRoot, `${artifact.id}.json`);
    fs.writeFileSync(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    artifact.path = artifactPath;
    artifact.sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  }

  const atomicArtifact = evidence.artifacts[0];
  const originalArtifactBytes = fs.readFileSync(atomicArtifact.path);
  const originalArtifact = JSON.parse(originalArtifactBytes);
  const replacementArtifact = { ...originalArtifact, originId: 'swapped-after-hash' };
  const replacementPath = `${atomicArtifact.path}.replacement`;
  fs.writeFileSync(replacementPath, `${JSON.stringify(replacementArtifact, null, 2)}\n`);
  const originalReadSync = fs.readSync;
  let swapped = false;
  fs.readSync = function readAndSwap(...args) {
    const bytesRead = originalReadSync(...args);
    if (!swapped && bytesRead > 0) {
      fs.renameSync(replacementPath, atomicArtifact.path);
      swapped = true;
    }
    return bytesRead;
  };
  let atomicallyVerified;
  try {
    atomicallyVerified = createArtifactVerifier()(atomicArtifact);
  } finally {
    fs.readSync = originalReadSync;
    fs.writeFileSync(atomicArtifact.path, originalArtifactBytes);
    fs.rmSync(replacementPath, { force: true });
  }
  assert.strictEqual(swapped, true, 'the atomic-read regression fixture must perform the file swap');
  assert.strictEqual(
    atomicallyVerified.originId,
    originalArtifact.originId,
    'the artifact digest and parsed envelope must come from the same file bytes'
  );

  const oversizedArtifactPath = path.join(temporaryRoot, 'oversized-artifact.json');
  const oversizedDescriptor = fs.openSync(oversizedArtifactPath, 'w', 0o600);
  try {
    fs.ftruncateSync(oversizedDescriptor, (64 * 1024 * 1024) + 1);
  } finally {
    fs.closeSync(oversizedDescriptor);
  }
  assert.throws(
    () => createArtifactVerifier()({
      ...atomicArtifact,
      path: oversizedArtifactPath
    }),
    /safe size limit/,
    'artifact size must be rejected from the opened descriptor before content is read'
  );

  const cleanEvidence = structuredClone(evidence);
  evidence.knownLimitations.push('Line one\n# Injected heading https://github.com/acme/private-repo');
  const evidencePath = path.join(temporaryRoot, 'qualification.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  /*
   * The operator's restore witness reaches the CLI as a file, the same way the
   * evidence does. Without it the gate refuses to run at all, which is the
   * intended posture: an unwitnessed restore proof is not a weaker proof, it
   * is an unverifiable one.
   */
  const witnessPath = path.join(temporaryRoot, 'restore-witness.json');
  fs.writeFileSync(witnessPath, `${JSON.stringify(fixture.bindings.restoreWitness, null, 2)}\n`, { mode: 0o600 });

  const env = {
    ...process.env,
    NV_PUBLIC_ALPHA_RESTORE_WITNESS: witnessPath,
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: 'a'.repeat(64),
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: 'b'.repeat(40),
    NV_PUBLIC_ALPHA_GITHUB_TARGET_SHA256: fixture.bindings.expectedAuthorizedTargets.github,
    NV_PUBLIC_ALPHA_GITLAB_TARGET_SHA256: fixture.bindings.expectedAuthorizedTargets.gitlab,
    NV_PUBLIC_ALPHA_GITEA_TARGET_SHA256: fixture.bindings.expectedAuthorizedTargets.gitea,
    NV_PUBLIC_ALPHA_HOSTED_TARGET_SHA256: fixture.bindings.expectedAuthorizedTargets.hosted,
    NV_ALPHA17_OPERATOR_KEY_ID: 'fixture-operator',
    NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64: fixture.bindings.trustedOperatorKeys['fixture-operator']
  };
  const plan = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'plan'
  ], { cwd: root, env, encoding: 'utf8' }));
  assert(plan.catalog.automated.includes('production-audit'));
  assert(plan.commands.some(command => command.key === 'verify-qualification'));
  assert(!JSON.stringify(plan).includes('ghp_'));

  const verification = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'verify', evidencePath
  ], { cwd: root, env, encoding: 'utf8' }));
  assert.strictEqual(verification.decision, 'go');
  assert.match(verification.recordHash, /^[0-9a-f]{64}$/);

  const closeoutDirectory = path.join(temporaryRoot, 'closeout');
  const closeResult = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'close', evidencePath, '--output-dir', closeoutDirectory
  ], { cwd: root, env, encoding: 'utf8' }));
  assert.strictEqual(closeResult.decision, 'go');
  const qualificationPath = path.join(closeoutDirectory, 'Nebulaverse-X-v5.3.0-alpha.17.0-Public-Alpha-Qualification.json');
  const closeoutPath = path.join(closeoutDirectory, 'Nebulaverse-X-v5.3.0-alpha.17.0-Public-Alpha-Closeout.md');
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  const closeout = fs.readFileSync(closeoutPath, 'utf8');
  assert.strictEqual(qualification.subjectSha256, 'a'.repeat(64));
  assert.strictEqual(qualification.sourceCommit, 'b'.repeat(40));
  assert(closeout.includes(`Subject SHA-256: \`${'a'.repeat(64)}\``));
  assert(closeout.includes(`Source commit: \`${'b'.repeat(40)}\``));
  /*
   * Derived, not restated. This was the number 22, and promoting a capability
   * that the runs already proved made it wrong -- which is the same drift the
   * documentation counts were taught to catch. A total copied into a test is
   * a second source of truth that only ever agrees by accident.
   */
  const providerCapabilityTotal = Object.values(PROVIDER_CAPABILITY_REQUIREMENTS)
    .reduce((sum, capabilities) => sum + Object.keys(capabilities).length, 0);
  assert(
    closeout.includes(`Provider evidence: ${providerCapabilityTotal}/${providerCapabilityTotal} passed`),
    `closeout must report ${providerCapabilityTotal} provider capabilities, one per contract entry`
  );
  assert(closeout.includes('Hosted evidence: 13/13 passed'));
  assert(closeout.includes('Manual evidence: 5/5 passed'));
  assert(closeout.includes('Cleanup: verified'));
  assert(closeout.includes('Render Free wake delay'));
  assert(!closeout.includes('# Injected heading'));
  assert(!closeout.includes('github.com/acme/private-repo'));
  assert(!/ghp_|glpat-|postgres(?:ql)?:\/\//i.test(closeout));
  assert.strictEqual(fs.statSync(qualificationPath).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(closeoutPath).mode & 0o777, 0o600);

  const unrelatedEnvelope = structuredClone(fixture.envelopes['automated-artifact']);
  unrelatedEnvelope.claims = {
    'automated.unrelated-check': {
      status: 'pass',
      cleanupVerified: true,
      completedAt
    }
  };
  const unrelatedPath = path.join(temporaryRoot, 'unrelated-but-hash-valid.json');
  fs.writeFileSync(unrelatedPath, `${JSON.stringify(unrelatedEnvelope, null, 2)}\n`, { mode: 0o600 });
  const unrelatedRecord = structuredClone(cleanEvidence);
  const automatedMetadata = unrelatedRecord.artifacts.find(item => item.id === 'automated-artifact');
  automatedMetadata.path = unrelatedPath;
  automatedMetadata.sha256 = crypto.createHash('sha256').update(fs.readFileSync(unrelatedPath)).digest('hex');
  const unrelatedRecordPath = path.join(temporaryRoot, 'unrelated-qualification.json');
  fs.writeFileSync(unrelatedRecordPath, `${JSON.stringify(unrelatedRecord, null, 2)}\n`, { mode: 0o600 });
  const unrelatedRejected = spawnSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'verify', unrelatedRecordPath
  ], { cwd: root, env, encoding: 'utf8' });
  assert.notStrictEqual(unrelatedRejected.status, 0);
  assert.match(unrelatedRejected.stderr, /PUBLIC_ALPHA_EVIDENCE_CLAIM_MISSING/);

  const symlinkPath = path.join(temporaryRoot, 'evidence-link.json');
  fs.symlinkSync(evidencePath, symlinkPath);
  const rejected = spawnSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'verify', symlinkPath
  ], { cwd: root, env, encoding: 'utf8' });
  assert.notStrictEqual(rejected.status, 0);
  assert.match(rejected.stderr, /regular non-symlink/i);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

/*
 * The readiness board.
 *
 * Every gate has to pass for one frozen candidate inside a fixed window, and
 * verify is all-or-nothing about it: a record missing sixty entries reports
 * the same way as one missing a single manual pass, and neither says how long
 * the evidence already in hand has left. That is a scheduling question being
 * answered by a pass/fail tool, so status answers it separately -- and must
 * never be mistaken for the decision.
 */
{
  const catalog = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'plan'
  ], { cwd: root, encoding: 'utf8' })).catalog;
  const total = catalog.automated.length + catalog.hosted.length + catalog.manual.length +
    Object.values(catalog.providers).reduce((sum, list) => sum + list.length, 0);

  const board = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-alpha-gate-board-'));
  const partialPath = path.join(board, 'partial-evidence.json');
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(partialPath, JSON.stringify({
    subjectSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    automated: {
      [catalog.automated[0]]: { status: 'pass', cleanupVerified: true, completedAt: recent, artifact: 'x' },
      [catalog.automated[1]]: { status: 'pass', cleanupVerified: true, completedAt: stale, artifact: 'x' }
    },
    manual: {
      [catalog.manual[0]]: { status: 'pass', cleanupVerified: true, completedAt: recent, artifact: 'x' }
    }
  }));

  const status = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'status', partialPath
  ], { cwd: root, encoding: 'utf8' }));

  assert.strictEqual(status.totals.required, total,
    'the board must count every entry the catalog requires');
  assert.strictEqual(status.totals.present, 3);
  assert.strictEqual(status.totals.outstanding, total - 3);
  assert.strictEqual(status.evidenceWindowHours, 72);

  /* Evidence past the window is called out rather than counted as progress. */
  assert.strictEqual(status.expired.length, 1);
  assert.strictEqual(status.expired[0].label, `automated.${catalog.automated[1]}`);

  /*
   * The deadline the campaign actually runs on: the oldest evidence still in
   * hand, because it ages out first and takes the record with it.
   */
  assert(status.campaignDeadline, 'a record with live evidence must report a deadline');
  assert(status.campaignDeadline.hoursRemaining > 70 && status.campaignDeadline.hoursRemaining <= 71,
    `expected about 71 hours remaining, observed ${status.campaignDeadline.hoursRemaining}`);

  assert(status.outstanding.includes(`manual.${catalog.manual[1]}`));
  assert(status.note.includes('Readiness only'),
    'the board must say it is not the decision');

  /* An empty record is a legitimate starting state, not an error. */
  const emptyPath = path.join(board, 'empty-evidence.json');
  fs.writeFileSync(emptyPath, JSON.stringify({}));
  const empty = JSON.parse(execFileSync(process.execPath, [
    'scripts/public-alpha-gate.js', 'status', emptyPath
  ], { cwd: root, encoding: 'utf8' }));
  assert.strictEqual(empty.totals.present, 0);
  assert.strictEqual(empty.campaignDeadline, null);
  assert.strictEqual(empty.subjectSha256, null);
  fs.rmSync(board, { recursive: true, force: true });
}

console.log('public alpha gate CLI tests passed');
