'use strict';

const EVIDENCE_SCHEMA_VERSION = '1.1.0';
const ARTIFACT_TYPES = Object.freeze(['automated', 'provider-live', 'hosted-live', 'manual']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ORIGIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const MAX_JSON_DEPTH = 64;
const CLAIM_PATTERN = /^(?:automated|hosted|manual)\.[a-z0-9][a-z0-9.-]*$|^providers\.(?:github|gitlab|gitea)\.[a-z0-9][a-z0-9.-]*$/;
const SAFE_SECRET_LIKE_FIELDS = Object.freeze([
  'secret-scan',
  'token-bearing-state-removed'
]);

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

module.exports = Object.freeze({
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  artifactTypeForLabel
});
