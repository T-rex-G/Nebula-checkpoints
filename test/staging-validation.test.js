'use strict';

const assert = require('assert');
const {
  CHECKS,
  CATALOG_HASH,
  EVIDENCE_SCHEMA_VERSION,
  sha256,
  normalizeEvidenceRecord,
  evaluateStagingGate,
  createBlockedEvidencePlan
} = require('../src/staging-validation');

const NOW = new Date('2026-07-23T12:00:00.000Z');
const SUBJECT_HASH = sha256('Nebulaverse-X-v5.3.0-alpha.16.1-release-candidate');
const verifyArtifact = artifact => artifact.sha256 === sha256(`artifact:${artifact.path}`);
const options = { now: NOW, expectedSubjectHash: SUBJECT_HASH, verifyArtifact };

function pass(check) {
  const artifactPath = `staging/evidence/${check.id}.json`;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    catalogHash: CATALOG_HASH,
    subjectHash: SUBJECT_HASH,
    checkId: check.id,
    status: 'pass',
    startedAt: '2026-07-23T11:00:00.000Z',
    completedAt: '2026-07-23T11:05:00.000Z',
    environmentFingerprint: sha256('ubuntu-node22-staging'),
    commandHash: sha256(check.command),
    artifacts: [{ path: artifactPath, sha256: sha256(`artifact:${artifactPath}`) }]
  };
}

assert.ok(CHECKS.length >= 20, 'Task 20 catalog must cover every staging domain');
assert.strictEqual(new Set(CHECKS.map(check => check.id)).size, CHECKS.length, 'check IDs must be unique');
assert.match(CATALOG_HASH, /^[a-f0-9]{64}$/);
assert.ok(CHECKS.every(check => typeof check.command === 'string' && check.command.length > 0), 'every check must prescribe one command contract');
assert.ok(CHECKS.some(check => check.destructive), 'destructive staging must be explicit');
assert.ok(CHECKS.some(check => check.tier === 'browser'), 'browser validation must be represented');
assert.ok(CHECKS.some(check => check.tier === 'neon'), 'Neon validation must be represented');
assert.ok(CHECKS.some(check => check.tier === 'provider'), 'provider validation must be represented');
assert.ok(CHECKS.filter(check => check.id.endsWith('full-suite')).every(check => check.command.includes('--require-subject')), 'matrix evidence must be candidate-bound');

const blockedPlan = createBlockedEvidencePlan({ now: NOW, subjectHash: SUBJECT_HASH });
const blocked = evaluateStagingGate(blockedPlan, { now: NOW, expectedSubjectHash: SUBJECT_HASH });
assert.strictEqual(blocked.gate, 'closed');
assert.ok(blocked.blockingCheckIds.length > 0);
assert.strictEqual(blocked.catalogHash, CATALOG_HASH);
assert.strictEqual(blocked.subjectHash, SUBJECT_HASH);

const allPassing = evaluateStagingGate(CHECKS.map(pass), options);
assert.strictEqual(allPassing.gate, 'open');
assert.strictEqual(allPassing.blockingCheckIds.length, 0);
assert.match(allPassing.reportHash, /^[a-f0-9]{64}$/);
assert.match(allPassing.evidenceHash, /^[a-f0-9]{64}$/);

const sameEvidenceLater = evaluateStagingGate(CHECKS.map(pass), {
  ...options,
  now: new Date('2026-07-23T12:01:00.000Z')
});
assert.strictEqual(sameEvidenceLater.reportHash, allPassing.reportHash, 'verification time must not change the deterministic report hash');
assert.strictEqual(sameEvidenceLater.evidenceHash, allPassing.evidenceHash);

const requiredOnly = CHECKS.filter(check => check.required).map(pass);
const requiredReport = evaluateStagingGate(requiredOnly, options);
assert.strictEqual(requiredReport.gate, 'open', 'optional GitHub App evidence may be absent when not configured');

const stale = CHECKS.map(pass);
stale[0] = { ...stale[0], startedAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-01T00:05:00.000Z' };
assert.strictEqual(evaluateStagingGate(stale, options).gate, 'closed');

assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), checkId: 'unknown' }, options), /Unknown/);
assert.throws(() => evaluateStagingGate([pass(CHECKS[0]), pass(CHECKS[0])], options), /Duplicate/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), environmentFingerprint: 'secret' }, options), /SHA-256/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), schemaVersion: '0.9.0' }, options), /schemaVersion/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), catalogHash: sha256('forged-catalog') }, options), /catalogHash/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), subjectHash: sha256('other-candidate') }, options), /subjectHash/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), commandHash: sha256('echo pass') }, options), /commandHash/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), artifacts: [] }, options), /artifact file/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), artifacts: [{ path: '../escape.json', sha256: sha256('x') }] }, options), /relative POSIX|traversal|staging\/evidence/);
assert.throws(() => normalizeEvidenceRecord(pass(CHECKS[0]), { now: NOW, expectedSubjectHash: SUBJECT_HASH }), /verifyArtifact/);
assert.throws(() => normalizeEvidenceRecord(pass(CHECKS[0]), { ...options, verifyArtifact: () => false }), /artifact verification failed/);
assert.throws(() => normalizeEvidenceRecord({ ...pass(CHECKS[0]), subjectHash: '0'.repeat(64) }, { ...options, expectedSubjectHash: '0'.repeat(64) }), /non-zero/);
assert.throws(() => evaluateStagingGate(CHECKS.map(pass), { now: NOW, verifyArtifact }), /expectedSubjectHash/);
assert.throws(() => createBlockedEvidencePlan({ now: NOW }), /subjectHash/);

console.log('staging validation tests passed');
