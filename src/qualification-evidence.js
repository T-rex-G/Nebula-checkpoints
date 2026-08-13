'use strict';

const crypto = require('crypto');
const EVIDENCE_SCHEMA_VERSION = '1.1.0';
const ARTIFACT_TYPES = Object.freeze(['automated', 'provider-live', 'hosted-live', 'manual']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ORIGIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const MAX_JSON_DEPTH = 64;
const FORBIDDEN_JSON_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const CLAIM_PATTERN = /^(?:automated|hosted|manual)\.[a-z0-9][a-z0-9.-]*$|^providers\.(?:github|gitlab|gitea)\.[a-z0-9][a-z0-9.-]*$/;
const SAFE_SECRET_LIKE_FIELDS = Object.freeze([
  'secret-scan',
  'token-bearing-state-removed'
]);
const PROVIDER_CAPABILITY_REQUIREMENTS = deepFreeze({
  github: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'branches.write': ['disposable-branch-create', 'cleanup-absence'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  },
  gitlab: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  },
  gitea: {
    'repository.read': ['repository-read'],
    'branches.read': ['default-branch-read'],
    'file.read': ['utf8-readback'],
    'file.write': ['expected-head-write', 'stale-head', 'permission-denial'],
    'file.delete': ['stale-head-delete', 'expected-head-delete', 'cleanup-absence']
  }
});
const PROVIDER_CHECK_CONTRACT = deepFreeze([
  { key: 'repository-read', fields: { status: 'pass', statusClass: '2xx' } },
  { key: 'default-branch-read', fields: { status: 'pass', statusClass: '2xx' } },
  { key: 'disposable-branch-create', fields: { status: 'pass', statusClass: '2xx' } },
  { key: 'expected-head-write', fields: { status: 'pass', statusClass: '2xx' } },
  {
    key: 'utf8-readback',
    fields: { status: 'pass', statusClass: '2xx', bytes: '$positive-integer', contentSha256: '$sha256' }
  },
  {
    key: 'stale-head',
    fields: {
      status: 'pass',
      zeroCommit: true,
      fileVerificationStatus: 'verified',
      fileVerificationReasonCode: null,
      fileVerificationDetail: 'content bytes and provider file identity match'
    }
  },
  { key: 'permission-denial', fields: { status: 'pass', zeroCommit: true } },
  { key: 'stale-head-delete', fields: { status: 'pass', zeroCommit: true, fileRetained: true } },
  {
    key: 'expected-head-delete',
    fields: { status: 'pass', statusClass: '2xx', headAdvanced: true, fileAbsent: true }
  },
  { key: 'cleanup-absence', fields: { status: 'pass' } }
]);
const RESTORE_RUNNER_CHECK_CONTRACT = deepFreeze({
  status: 'pass',
  latestMigration: '015_alpha_privacy',
  backupManifestSha256: '$sha256',
  backupCiphertextSha256: '$sha256',
  restoreTargetFingerprint: '$sha256',
  restoreEvidenceSha256: '$sha256',
  sourceIdentitySha256: '$sha256',
  targetIdentitySha256: '$sha256',
  sourceTargetDistinct: true,
  controlPlaneVerified: true,
  liveTargetVerified: true,
  smokePassed: true,
  backupRemoved: true
});

function fail(message) {
  const error = new TypeError(message);
  error.code = 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH';
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isNonzeroSha256(value) {
  return SHA256_PATTERN.test(String(value || '')) && !/^0{64}$/.test(value);
}

function assertDepth(depth, location) {
  if (depth > MAX_JSON_DEPTH) fail(`${location} exceeds the maximum nesting depth`);
}

function cloneJson(value, location = 'artifact', depth = 0) {
  assertDepth(depth, location);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${location}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) fail(`${location} must contain JSON data only`);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.includes(key)) fail(`${location} contains a forbidden property name`);
    if (child === undefined) fail(`${location} contains undefined data`);
    output[key] = cloneJson(child, `${location}.${key}`, depth + 1);
  }
  return output;
}

function deepFreeze(value, location = 'artifact', depth = 0) {
  assertDepth(depth, location);
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const [key, child] of Object.entries(value)) {
    deepFreeze(child, `${location}.${key}`, depth + 1);
  }
  return Object.freeze(value);
}

function parseIsoTimestamp(value, label) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must use a canonical ISO-8601 timestamp`);
  }
  return parsed;
}

function assertNoSecretMaterial(value, location = 'artifact', depth = 0) {
  assertDepth(depth, location);
  if (Array.isArray(value)) {
    return value.forEach((item, index) => assertNoSecretMaterial(item, `${location}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      if (
        !CLAIM_PATTERN.test(key) &&
        !SAFE_SECRET_LIKE_FIELDS.includes(normalized) &&
        /(^|[-_])(password|passwd|credential|token|secret|authorization|cookie|private[-_]?key|api[-_]?key|database[-_]?url)([-_]|$)/.test(normalized)
      ) fail(`${location} contains a secret-like field name`);
      assertNoSecretMaterial(child, `${location}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value === 'string' && (
    /authorization\s*:\s*bearer/i.test(value) ||
    /\bbearer\s+[a-z0-9._~+/=-]{12,}/i.test(value) ||
    /\bgh[pousr]_[a-z0-9_]{20,}/i.test(value) ||
    /\bgithub_pat_[a-z0-9_]{40,}/i.test(value) ||
    /\bglpat-[a-z0-9_-]{12,}/i.test(value) ||
    /(?:postgres(?:ql)?|https?):\/\/[^\s/:]+:[^@\s]+@/i.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
  )) fail(`${location} contains secret-like material`);
}

function expectedPrefix(artifact) {
  if (artifact.artifactType === 'provider-live') return `providers.${artifact.provider}.`;
  if (artifact.artifactType === 'hosted-live') return 'hosted.';
  if (artifact.artifactType === 'automated') return 'automated.';
  return 'manual.';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function validateProviderEvidence(artifact) {
  const requirements = PROVIDER_CAPABILITY_REQUIREMENTS[artifact.provider];
  if (!requirements) fail('provider artifact context is invalid');
  const expectedCapabilities = Object.keys(requirements).sort();
  if (
    !Array.isArray(artifact.capabilities) ||
    JSON.stringify(artifact.capabilities) !== JSON.stringify(expectedCapabilities)
  ) fail('provider artifact capabilities do not match the qualified proof contract');
  const expectedClaims = expectedCapabilities.map(capability => `providers.${artifact.provider}.${capability}`).sort();
  if (JSON.stringify(Object.keys(artifact.claims).sort()) !== JSON.stringify(expectedClaims)) {
    fail('provider artifact claims do not match the qualified proof contract');
  }
  if (artifact.status !== 'pass') fail('provider artifact status is invalid');
  if (!SHA256_PATTERN.test(String(artifact.targetHash || '')) || /^0{64}$/.test(artifact.targetHash)) {
    fail('provider artifact target hash is invalid');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(artifact.nodeVersion || ''))) {
    fail('provider artifact Node version is invalid');
  }
  const startedAt = parseIsoTimestamp(artifact.startedAt, 'provider artifact start');
  if (startedAt.getTime() > new Date(artifact.completedAt).getTime()) {
    fail('provider artifact completed before it started');
  }
  if (!Array.isArray(artifact.checks) || artifact.checks.length !== PROVIDER_CHECK_CONTRACT.length) {
    fail('provider artifact checks are incomplete');
  }
  for (let index = 0; index < PROVIDER_CHECK_CONTRACT.length; index += 1) {
    const check = artifact.checks[index];
    const contract = PROVIDER_CHECK_CONTRACT[index];
    if (!isPlainObject(check) || check.key !== contract.key) fail('provider artifact check order is invalid');
    const expectedFields = ['key', ...Object.keys(contract.fields)].sort();
    if (JSON.stringify(Object.keys(check).sort()) !== JSON.stringify(expectedFields)) {
      fail(`provider artifact check ${contract.key} contains incomplete or unsupported proof fields`);
    }
    for (const [field, rule] of Object.entries(contract.fields)) {
      if (rule === '$positive-integer') {
        if (!Number.isSafeInteger(check[field]) || check[field] <= 0) {
          fail(`provider artifact check ${contract.key} contains invalid proof`);
        }
      } else if (rule === '$sha256') {
        if (!SHA256_PATTERN.test(String(check[field] || '')) || /^0{64}$/.test(check[field])) {
          fail(`provider artifact check ${contract.key} contains invalid proof`);
        }
      } else if (check[field] !== rule) {
        fail(`provider artifact check ${contract.key} contains invalid proof`);
      }
    }
  }
}

function validateEvidenceEnvelope(input) {
  if (!isPlainObject(input)) fail('artifact verifier must return a parsed evidence envelope');
  const artifact = cloneJson(input);
  assertNoSecretMaterial(artifact);
  if (artifact.schemaVersion !== EVIDENCE_SCHEMA_VERSION) fail('artifact evidence schema does not match');
  if (!ARTIFACT_TYPES.includes(artifact.artifactType)) fail('artifact type is invalid');
  if (!SHA256_PATTERN.test(String(artifact.subjectSha256 || '')) || /^0{64}$/.test(artifact.subjectSha256)) {
    fail('artifact subject SHA-256 is invalid');
  }
  if (!COMMIT_PATTERN.test(String(artifact.sourceCommit || '')) || /^0{40}$/.test(artifact.sourceCommit)) {
    fail('artifact source commit is invalid');
  }
  if (!ORIGIN_PATTERN.test(String(artifact.originId || ''))) fail('artifact origin ID is invalid');
  parseIsoTimestamp(artifact.completedAt, 'artifact completion');
  if (artifact.cleanupVerified !== true) fail('artifact cleanup is not verified');
  if (!isPlainObject(artifact.claims) || Object.keys(artifact.claims).length === 0 || Object.keys(artifact.claims).length > 500) {
    fail('artifact claims are missing or invalid');
  }
  if (artifact.artifactType === 'provider-live') {
    if (!['github', 'gitlab', 'gitea'].includes(artifact.provider)) fail('provider artifact context is invalid');
    if (!SHA256_PATTERN.test(String(artifact.authorizedTargetSha256 || '')) || /^0{64}$/.test(artifact.authorizedTargetSha256)) {
      fail('provider target authorization hash is invalid');
    }
    validateProviderEvidence(artifact);
  } else if (Object.hasOwn(artifact, 'provider')) {
    fail('non-provider artifact contains provider context');
  }
  if (artifact.artifactType === 'hosted-live') {
    if (
      !SHA256_PATTERN.test(String(artifact.authorizedTargetSha256 || '')) ||
      /^0{64}$/.test(artifact.authorizedTargetSha256) ||
      !SHA256_PATTERN.test(String(artifact.deploymentSha256 || '')) ||
      /^0{64}$/.test(artifact.deploymentSha256)
    ) fail('hosted artifact context is invalid');
    const attestation = artifact.operatorAttestation;
    if (
      !isPlainObject(attestation) ||
      JSON.stringify(Object.keys(attestation).sort()) !== JSON.stringify([
        'completedAt', 'keyId', 'record', 'recordSha256', 'schemaVersion'
      ]) ||
      attestation.schemaVersion !== '1.0.0' ||
      !/^[a-zA-Z0-9._-]{3,80}$/.test(String(attestation.keyId || '')) ||
      !SHA256_PATTERN.test(String(attestation.recordSha256 || '')) ||
      /^0{64}$/.test(attestation.recordSha256)
    ) fail('hosted operator attestation is invalid');
    const attestedAt = parseIsoTimestamp(attestation.completedAt, 'hosted operator attestation completion');
    if (attestedAt.getTime() > new Date(artifact.completedAt).getTime()) {
      fail('hosted artifact completed before its operator attestation');
    }
    const signedRecord = attestation.record;
    if (
      !isPlainObject(signedRecord) ||
      signedRecord.schemaVersion !== attestation.schemaVersion ||
      signedRecord.subjectSha256 !== artifact.subjectSha256 ||
      signedRecord.sourceCommit !== artifact.sourceCommit ||
      signedRecord.completedAt !== attestation.completedAt ||
      !isPlainObject(signedRecord.signature) ||
      signedRecord.signature.algorithm !== 'ed25519' ||
      signedRecord.signature.keyId !== attestation.keyId ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(String(signedRecord.signature.value || '')) ||
      sha256(stableJson(signedRecord)) !== attestation.recordSha256
    ) fail('hosted signed operator record does not match its attestation');
    if (
      !isPlainObject(signedRecord.checks) ||
      Object.hasOwn(signedRecord.checks, 'isolated-database-restore')
    ) fail('hosted operator record must not attest the workflow-runner restore');

    const restoreAttestation = artifact.restoreRunnerAttestation;
    if (
      !hasExactKeys(restoreAttestation, [
        'completedAt', 'record', 'recordSha256', 'schemaVersion'
      ]) ||
      restoreAttestation.schemaVersion !== '1.0.0' ||
      !isNonzeroSha256(restoreAttestation.recordSha256)
    ) fail('hosted restore runner attestation is invalid');
    const restoreAttestedAt = parseIsoTimestamp(
      restoreAttestation.completedAt,
      'hosted restore runner attestation completion'
    );
    if (restoreAttestedAt.getTime() > new Date(artifact.completedAt).getTime()) {
      fail('hosted artifact completed before its restore runner attestation');
    }
    const restoreRecord = restoreAttestation.record;
    const expectedRestoreOrigin = artifact.originId.endsWith('-hosted')
      ? `${artifact.originId.slice(0, -'-hosted'.length)}-restore`
      : '';
    if (
      !hasExactKeys(restoreRecord, [
        'schemaVersion', 'artifactType', 'subjectSha256', 'sourceCommit', 'originId',
        'completedAt', 'cleanupVerified', 'check'
      ]) ||
      restoreRecord.schemaVersion !== restoreAttestation.schemaVersion ||
      restoreRecord.artifactType !== 'hosted-restore-runner' ||
      restoreRecord.subjectSha256 !== artifact.subjectSha256 ||
      restoreRecord.sourceCommit !== artifact.sourceCommit ||
      restoreRecord.originId !== expectedRestoreOrigin ||
      restoreRecord.completedAt !== restoreAttestation.completedAt ||
      restoreRecord.cleanupVerified !== true ||
      sha256(stableJson(restoreRecord)) !== restoreAttestation.recordSha256
    ) fail('hosted restore runner record does not match its attestation');
    if (!hasExactKeys(restoreRecord.check, Object.keys(RESTORE_RUNNER_CHECK_CONTRACT))) {
      fail('hosted restore runner proof is invalid');
    }
    for (const [field, rule] of Object.entries(RESTORE_RUNNER_CHECK_CONTRACT)) {
      if (rule === '$sha256') {
        if (!isNonzeroSha256(restoreRecord.check[field])) fail('hosted restore runner proof is invalid');
      } else if (restoreRecord.check[field] !== rule) {
        fail('hosted restore runner proof is invalid');
      }
    }
    if (
      restoreRecord.check.sourceIdentitySha256 === restoreRecord.check.targetIdentitySha256 ||
      !isPlainObject(artifact.checks) ||
      stableJson(artifact.checks['isolated-database-restore']) !== stableJson(restoreRecord.check)
    ) fail('hosted restore runner proof is not bound to the hosted evidence');
  }
  const prefix = expectedPrefix(artifact);
  for (const [label, claim] of Object.entries(artifact.claims)) {
    if (!CLAIM_PATTERN.test(label) || !label.startsWith(prefix)) fail('artifact contains a claim outside its context');
    if (!isPlainObject(claim)) fail('artifact claim is invalid');
    if (!['pass', 'fail', 'blocked'].includes(claim.status)) fail('artifact claim status is invalid');
    if (typeof claim.cleanupVerified !== 'boolean') fail('artifact claim cleanup state is invalid');
    const claimTime = parseIsoTimestamp(claim.completedAt, `artifact claim ${label}`);
    if (claimTime.getTime() > new Date(artifact.completedAt).getTime()) {
      fail('artifact completed before one of its claims');
    }
  }
  return deepFreeze(artifact);
}

function artifactTypeForLabel(label) {
  if (String(label).startsWith('automated.')) return 'automated';
  if (String(label).startsWith('providers.')) return 'provider-live';
  if (String(label).startsWith('hosted.')) return 'hosted-live';
  if (String(label).startsWith('manual.')) return 'manual';
  fail('qualification evidence label is invalid');
}

function verifyHostedOperatorSignature(input, trustedOperatorKeys) {
  const artifact = validateEvidenceEnvelope(input);
  if (artifact.artifactType !== 'hosted-live') fail('operator signature verification requires hosted evidence');
  if (
    !isPlainObject(trustedOperatorKeys) ||
    Object.keys(trustedOperatorKeys).length === 0 ||
    Object.keys(trustedOperatorKeys).length > 16
  ) fail('trusted operator keyring is invalid');
  const signedRecord = artifact.operatorAttestation.record;
  const keyId = signedRecord.signature.keyId;
  if (!Object.hasOwn(trustedOperatorKeys, keyId)) fail('hosted operator signature key is not trusted');
  const encoded = String(trustedOperatorKeys[keyId] || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) {
    fail('trusted operator public key is invalid');
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'spki'
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    fail('trusted operator public key is invalid');
  }
  const unsigned = cloneJson(signedRecord);
  const signature = Buffer.from(unsigned.signature.value, 'base64');
  delete unsigned.signature;
  if (!crypto.verify(null, Buffer.from(stableJson(unsigned), 'utf8'), publicKey, signature)) {
    fail('hosted operator signature does not verify');
  }
  return true;
}

module.exports = Object.freeze({
  EVIDENCE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_REQUIREMENTS,
  validateEvidenceEnvelope,
  verifyHostedOperatorSignature,
  artifactTypeForLabel
});
