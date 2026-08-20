'use strict';

const crypto = require('crypto');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RESTORE_CHECK_CONTRACT = Object.freeze({
  status: 'pass',
  latestMigration: '015_alpha_privacy',
  backupManifestSha256: '$sha256',
  backupCiphertextSha256: '$sha256',
  restoreTargetFingerprint: '$sha256',
  restoreAppDeployIdSha256: '$sha256',
  restoreEvidenceSha256: '$sha256',
  sourceIdentitySha256: '$sha256',
  targetIdentitySha256: '$sha256',
  sourceTargetDistinct: true,
  controlPlaneVerified: true,
  liveTargetVerified: true,
  smokePassed: true,
  backupRemoved: true
});

function fail(message, code = 'ALPHA17_RESTORE_ATTESTATION_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonzeroSha256(value) {
  return SHA256_PATTERN.test(String(value || '')) && !/^0{64}$/.test(value);
}

function parseFresh(value, now) {
  const completed = new Date(value);
  if (!value || Number.isNaN(completed.getTime()) || completed.toISOString() !== value) {
    fail('runner restore attestation timestamp is invalid', 'ALPHA17_RESTORE_ATTESTATION_STALE');
  }
  const age = now.getTime() - completed.getTime();
  if (age > MAX_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
    fail('runner restore attestation is stale', 'ALPHA17_RESTORE_ATTESTATION_STALE');
  }
}

function attestationKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 128) {
    fail('runner restore attestation key is invalid');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    fail('runner restore attestation key must be exactly 32 canonical base64 bytes');
  }
  return key;
}

function provenanceFromOptions(options = {}) {
  const repository = String(options.workflowRepository || '').trim();
  const workflow = String(options.workflowPath || '').trim();
  const runId = String(options.workflowRunId || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) fail('runner restore workflow repository is invalid');
  if (!/^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(workflow)) {
    fail('runner restore workflow path is invalid');
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(runId)) fail('runner restore workflow run ID is invalid');
  return Object.freeze({
    issuer: 'github-actions',
    workflowOwnerProjectSha256: crypto.createHash('sha256').update(repository, 'utf8').digest('hex'),
    workflow,
    runId
  });
}

function signRunnerRestoreAttestation(unsignedInput, options = {}) {
  if (!isPlainObject(unsignedInput) || Object.hasOwn(unsignedInput, 'provenance') || Object.hasOwn(unsignedInput, 'signature')) {
    fail('runner restore attestation signing input is invalid');
  }
  const provenance = provenanceFromOptions(options);
  const unsigned = { ...cloneJson(unsignedInput), provenance };
  const value = crypto.createHmac('sha256', attestationKey(options.attestationKeyBase64))
    .update(stableJson(unsigned), 'utf8')
    .digest('hex');
  return Object.freeze({
    ...unsigned,
    signature: {
      algorithm: 'hmac-sha256',
      keyId: `github-actions-${provenance.runId}`,
      value
    }
  });
}

function validateRunnerRestoreAttestation(input, options = {}) {
  if (!isPlainObject(input)) fail('runner restore attestation must be an object');
  const record = cloneJson(input);
  if (!hasExactKeys(record, [
    'schemaVersion', 'artifactType', 'subjectSha256', 'sourceCommit', 'originId',
    'completedAt', 'cleanupVerified', 'check', 'provenance', 'signature'
  ])) fail('runner restore attestation fields do not match the schema');
  if (record.schemaVersion !== '1.0.0' || record.artifactType !== 'hosted-restore-runner') {
    fail('runner restore attestation schema does not match');
  }
  if (record.subjectSha256 !== options.expectedSubjectHash) {
    fail('runner restore subject does not match', 'ALPHA17_RESTORE_ATTESTATION_SUBJECT_MISMATCH');
  }
  if (record.sourceCommit !== options.expectedSourceCommit) {
    fail('runner restore source does not match', 'ALPHA17_RESTORE_ATTESTATION_SOURCE_MISMATCH');
  }
  if (record.originId !== options.expectedOriginId || record.cleanupVerified !== true) {
    fail('runner restore origin or cleanup does not match');
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  parseFresh(record.completedAt, now);
  if (!hasExactKeys(record.check, Object.keys(RESTORE_CHECK_CONTRACT))) {
    fail('runner restore proof does not match its schema');
  }
  for (const [field, rule] of Object.entries(RESTORE_CHECK_CONTRACT)) {
    if (rule === '$sha256') {
      if (!isNonzeroSha256(record.check[field])) fail('runner restore proof contains an invalid digest');
    } else if (record.check[field] !== rule) {
      fail('runner restore proof is incomplete');
    }
  }
  if (
    record.check.sourceIdentitySha256 === record.check.targetIdentitySha256 ||
    record.check.restoreTargetFingerprint !== options.expectedRestoreTargetFingerprint ||
    record.check.restoreAppDeployIdSha256 !== options.expectedRestoreAppDeployIdSha256
  ) fail('runner restore proof is not bound to the reviewed target');

  const expectedProvenance = provenanceFromOptions(options);
  if (!hasExactKeys(record.provenance, Object.keys(expectedProvenance))) {
    fail('runner restore provenance does not match its schema');
  }
  for (const [field, expected] of Object.entries(expectedProvenance)) {
    if (record.provenance[field] !== expected) fail('runner restore provenance does not match the trusted workflow');
  }
  if (!hasExactKeys(record.signature, ['algorithm', 'keyId', 'value']) ||
      record.signature.algorithm !== 'hmac-sha256' ||
      record.signature.keyId !== `github-actions-${expectedProvenance.runId}` ||
      !SHA256_PATTERN.test(String(record.signature.value || ''))) {
    fail('runner restore attestation signature is invalid');
  }
  const unsigned = cloneJson(record);
  delete unsigned.signature;
  const expectedSignature = crypto.createHmac('sha256', attestationKey(options.attestationKeyBase64))
    .update(stableJson(unsigned), 'utf8')
    .digest();
  const observedSignature = Buffer.from(record.signature.value, 'hex');
  if (observedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(observedSignature, expectedSignature)) {
    fail('runner restore attestation signature does not verify');
  }
  return Object.freeze(record);
}

module.exports = Object.freeze({
  RESTORE_CHECK_CONTRACT,
  signRunnerRestoreAttestation,
  validateRunnerRestoreAttestation
});
