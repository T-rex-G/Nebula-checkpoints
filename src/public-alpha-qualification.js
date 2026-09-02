'use strict';

const crypto = require('crypto');
const {
  EVIDENCE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_REQUIREMENTS,
  artifactTypeForLabel,
  validateEvidenceEnvelope,
  verifyHostedOperatorSignature,
  verifyRestoreWitness
} = require('./qualification-evidence');

const QUALIFICATION_SCHEMA_VERSION = EVIDENCE_SCHEMA_VERSION;
const PRODUCT = 'Nebulaverse-X';
const DEPLOYMENT = 'hosted-alpha';
const MAX_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PREDECESSOR_SUBJECT_SHA256 = '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892';
const SAFE_SECRET_LIKE_FIELD_NAMES = Object.freeze(['secret-scan']);

const AUTOMATED_KEYS = Object.freeze([
  'node22-clean-install',
  'node22-runtime-matrix',
  'syntax',
  'secret-scan',
  'deterministic-double-package',
  'fresh-extraction-clean-install',
  'production-audit',
  'development-audit-classification',
  'desktop-golden-path',
  'mobile-golden-path',
  'capability-ui-server-consistency',
  'invite-security',
  'repository-allowlist',
  'credential-browser-purge',
  'cleanup',
  'retention-purge',
  'cold-start-degraded-ui',
  'backup-format',
  'rate-abuse',
  'accessibility-axe',
  'accessibility-keyboard',
  'accessibility-reflow'
]);

const HOSTED_KEYS = Object.freeze([
  'render-cold-start',
  'neon-scale-to-zero-wake',
  'five-concurrent-read-testers',
  'single-bounded-mutation',
  'memory-restart-observation',
  'active-session-revocation',
  'provider-disconnect',
  'ephemeral-filesystem-restart',
  'database-interruption-recovery',
  'provider-429-outage',
  'application-rollback',
  'isolated-database-restore',
  'disposable-tester-purge'
]);

const MANUAL_KEYS = Object.freeze([
  'ios-voiceover',
  'desktop-screen-reader',
  'privacy-terms-review',
  'operator-runbook-walkthrough',
  'known-limitations-review'
]);

function fail(message, code) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function failArtifactVerification(artifact, cause) {
  const causeMessage = cause && cause.message ? String(cause.message) : 'artifact verifier failed';
  const error = new TypeError(
    `qualification artifact ${artifact.id} does not match: ${causeMessage}`,
    { cause }
  );
  error.code = 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH';
  error.artifactId = artifact.id;
  if (cause && cause.code) error.causeCode = String(cause.code);
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value, path = 'record') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (!isPlainObject(value)) fail(`${path} must contain JSON data only`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      fail(`${path} contains a forbidden property name`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
    }
    if (child === undefined) fail(`${path} contains an undefined value`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
    output[key] = cloneJson(child, `${path}.${key}`);
  }
  return output;
}

function normalizedKey(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function assertNoSecretMaterial(value, path = 'record') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (
        !SAFE_SECRET_LIKE_FIELD_NAMES.includes(normalized) &&
        /(^|[-_])(password|passwd|token|secret|authorization|cookie|private[-_]?key|api[-_]?key|database[-_]?url)([-_]|$)/.test(normalized)
      ) {
        fail(`${path} contains a secret-like field name`, 'PUBLIC_ALPHA_SECRET_MATERIAL');
      }
      assertNoSecretMaterial(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (
    /authorization\s*:\s*bearer/i.test(value) ||
    /\bbearer\s+[a-z0-9._~+\/-]{12,}/i.test(value) ||
    /\bgh[pousr]_[a-z0-9_]{20,}/i.test(value) ||
    /\bglpat-[a-z0-9_-]{12,}/i.test(value) ||
    /postgres(?:ql)?:\/\/[^\s/:]+:[^@\s]+@/i.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
  ) {
    fail(`${path} contains secret-like material`, 'PUBLIC_ALPHA_SECRET_MATERIAL');
  }
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

function qualificationCatalog(registry) {
  if (!isPlainObject(registry) || !isPlainObject(registry.providers)) {
    fail('capability registry is invalid', 'PUBLIC_ALPHA_REGISTRY_INVALID');
  }
  const providers = {};
  for (const provider of Object.keys(registry.providers).sort()) {
    const deployment = registry.providers[provider] && registry.providers[provider][DEPLOYMENT];
    const requirements = PROVIDER_CAPABILITY_REQUIREMENTS[provider];
    if (!isPlainObject(deployment) || !isPlainObject(requirements)) {
      fail('capability deployment is missing', 'PUBLIC_ALPHA_REGISTRY_INVALID');
    }
    providers[provider] = Object.keys(requirements).sort();
    for (const feature of providers[provider]) {
      const tuple = deployment[feature];
      if (!Array.isArray(tuple) || tuple[0] !== 'Supported' || tuple[1] !== 'Provider-verified') {
        fail('provider qualification contract conflicts with the capability registry', 'PUBLIC_ALPHA_REGISTRY_INVALID');
      }
    }
  }
  if (Object.keys(PROVIDER_CAPABILITY_REQUIREMENTS).some(provider => !Object.hasOwn(providers, provider))) {
    fail('provider qualification contract is missing from the capability registry', 'PUBLIC_ALPHA_REGISTRY_INVALID');
  }
  return deepFreeze({
    automated: [...AUTOMATED_KEYS],
    hosted: [...HOSTED_KEYS],
    manual: [...MANUAL_KEYS],
    providers
  });
}

function validateQualificationRecord(record) {
  if (!isPlainObject(record)) fail('qualification record must be an object', 'PUBLIC_ALPHA_SCHEMA_INVALID');
  assertNoSecretMaterial(record);
  const normalized = cloneJson(record);
  for (const field of [
    'schemaVersion', 'product', 'version', 'subjectSha256', 'sourceCommit',
    'nodeVersion', 'latestMigration', 'generatedAt'
  ]) {
    if (typeof normalized[field] !== 'string') fail(`${field} must be a string`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
  }
  for (const field of ['automated', 'providers', 'hosted', 'manual', 'security']) {
    if (!isPlainObject(normalized[field])) fail(`${field} must be an object`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
  }
  for (const field of ['goldenPathCapabilities', 'observedEnabledCapabilities', 'artifacts']) {
    if (!Array.isArray(normalized[field])) fail(`${field} must be an array`, 'PUBLIC_ALPHA_SCHEMA_INVALID');
  }
  return deepFreeze(normalized);
}

function parseFreshTimestamp(value, now, label) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} has an invalid timestamp`, 'PUBLIC_ALPHA_EVIDENCE_STALE');
  }
  const age = now.getTime() - parsed.getTime();
  if (age > MAX_EVIDENCE_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
    fail(`${label} is outside the qualification freshness window`, 'PUBLIC_ALPHA_EVIDENCE_STALE');
  }
  return parsed;
}

function assertExactKeys(section, expected, label, missingCode = 'PUBLIC_ALPHA_EVIDENCE_MISSING') {
  if (!isPlainObject(section)) fail(`${label} evidence is missing`, missingCode);
  for (const key of expected) {
    if (!Object.hasOwn(section, key)) fail(`${label} evidence is incomplete`, missingCode);
  }
  const unexpected = Object.keys(section).filter(key => !expected.includes(key));
  if (unexpected.length) fail(`${label} evidence contains an unexpected item`, 'PUBLIC_ALPHA_EVIDENCE_UNEXPECTED');
}

function verifyEvidenceEntry(entry, label, artifacts, now, context) {
  if (!isPlainObject(entry)) fail(`${label} evidence is invalid`, 'PUBLIC_ALPHA_EVIDENCE_MISSING');
  if (entry.status !== 'pass') fail(`${label} did not pass`, 'PUBLIC_ALPHA_EVIDENCE_NOT_PASS');
  if (entry.cleanupVerified !== true) fail(`${label} cleanup is not verified`, 'PUBLIC_ALPHA_CLEANUP_UNVERIFIED');
  parseFreshTimestamp(entry.completedAt, now, label);
  if (typeof entry.artifact !== 'string' || !artifacts.has(entry.artifact)) {
    fail(`${label} is not bound to a verified artifact`, 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISSING');
  }
  const artifact = artifacts.get(entry.artifact);
  if (
    artifact.subjectSha256 !== context.subjectSha256 ||
    artifact.sourceCommit !== context.sourceCommit ||
    artifact.artifactType !== artifactTypeForLabel(label)
  ) fail(`${label} artifact context does not match`, 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_CONTEXT_MISMATCH');
  if (artifact.artifactType === 'provider-live') {
    const provider = String(label).split('.')[1];
    if (artifact.provider !== provider) {
      fail(`${label} provider artifact context does not match`, 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_CONTEXT_MISMATCH');
    }
  }
  parseFreshTimestamp(artifact.completedAt, now, `${label} artifact`);
  const claim = artifact.claims[label];
  if (!isPlainObject(claim)) fail(`${label} is absent from its artifact`, 'PUBLIC_ALPHA_EVIDENCE_CLAIM_MISSING');
  if (
    claim.status !== entry.status ||
    claim.cleanupVerified !== entry.cleanupVerified ||
    claim.completedAt !== entry.completedAt
  ) fail(`${label} does not match its artifact claim`, 'PUBLIC_ALPHA_EVIDENCE_CLAIM_MISMATCH');
}

function capabilityTuple(registry, qualifiedName) {
  const match = /^(github|gitlab|gitea):(.+)$/.exec(String(qualifiedName));
  if (!match) fail('capability name is invalid', 'PUBLIC_ALPHA_CAPABILITY_INVALID');
  const tuple = registry.providers[match[1]] &&
    registry.providers[match[1]][DEPLOYMENT] &&
    registry.providers[match[1]][DEPLOYMENT][match[2]];
  if (!Array.isArray(tuple)) fail('capability is unknown', 'PUBLIC_ALPHA_CAPABILITY_INVALID');
  return tuple;
}

function liveEvidenceBindings(options) {
  const expected = options.expectedAuthorizedTargets;
  const expectedKeys = ['github', 'gitlab', 'gitea', 'hosted'];
  if (
    !isPlainObject(expected) ||
    JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify([...expectedKeys].sort()) ||
    expectedKeys.some(key => !/^[0-9a-f]{64}$/.test(String(expected[key] || '')) || /^0{64}$/.test(expected[key])) ||
    !/^[0-9a-f]{64}$/.test(String(options.expectedDeploymentSha256 || '')) ||
    /^0{64}$/.test(options.expectedDeploymentSha256) ||
    !isPlainObject(options.trustedOperatorKeys) ||
    Object.keys(options.trustedOperatorKeys).length === 0 ||
    !isPlainObject(options.restoreWitness)
  ) {
    fail('trusted live-evidence bindings are required', 'PUBLIC_ALPHA_OPTIONS_INVALID');
  }
  return Object.freeze({
    expectedAuthorizedTargets: expected,
    expectedDeploymentSha256: options.expectedDeploymentSha256,
    trustedOperatorKeys: options.trustedOperatorKeys,
    restoreWitness: options.restoreWitness
  });
}

function verifyQualification(input, options = {}) {
  const record = validateQualificationRecord(input);
  const now = options.now instanceof Date ? new Date(options.now.getTime()) : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) fail('verification time is invalid', 'PUBLIC_ALPHA_OPTIONS_INVALID');
  if (!isPlainObject(options.registry)) fail('capability registry is required', 'PUBLIC_ALPHA_OPTIONS_INVALID');
  const liveBindings = liveEvidenceBindings(options);

  if (record.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) fail('qualification schema does not match', 'PUBLIC_ALPHA_SCHEMA_MISMATCH');
  if (record.product !== PRODUCT) fail('qualification product does not match', 'PUBLIC_ALPHA_PRODUCT_MISMATCH');
  if (record.version !== options.expectedVersion) fail('qualification version does not match', 'PUBLIC_ALPHA_VERSION_MISMATCH');
  if (
    !/^[0-9a-f]{64}$/.test(record.subjectSha256) ||
    record.subjectSha256 === PREDECESSOR_SUBJECT_SHA256 ||
    record.subjectSha256 !== options.expectedSubjectHash
  ) {
    fail('qualification subject does not match', 'PUBLIC_ALPHA_EVIDENCE_SUBJECT_MISMATCH');
  }
  if (!/^[0-9a-f]{40}$/.test(record.sourceCommit) || record.sourceCommit !== options.expectedSourceCommit) {
    fail('qualification source commit does not match', 'PUBLIC_ALPHA_SOURCE_COMMIT_MISMATCH');
  }
  if (record.latestMigration !== options.expectedLatestMigration) fail('latest migration does not match', 'PUBLIC_ALPHA_MIGRATION_MISMATCH');
  if (record.nodeVersion !== '22.23.1') {
    fail('qualification must use Node 22.23.1', 'PUBLIC_ALPHA_NODE_VERSION_INVALID');
  }
  parseFreshTimestamp(record.generatedAt, now, 'qualification record');

  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    fail('qualification artifacts are missing', 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISSING');
  }
  if (typeof options.verifyArtifact !== 'function') fail('artifact verifier is required', 'PUBLIC_ALPHA_OPTIONS_INVALID');
  const artifacts = new Map();
  for (const artifact of record.artifacts) {
    if (
      !isPlainObject(artifact) ||
      !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(String(artifact.id || '')) ||
      typeof artifact.path !== 'string' ||
      artifact.path.length === 0 ||
      !/^[0-9a-f]{64}$/.test(String(artifact.sha256 || '')) ||
      artifacts.has(artifact.id)
    ) {
      fail('qualification artifact metadata is invalid', 'PUBLIC_ALPHA_EVIDENCE_ARTIFACT_MISMATCH');
    }
    let verified;
    try {
      verified = validateEvidenceEnvelope(options.verifyArtifact(artifact));
    } catch (error) {
      failArtifactVerification(artifact, error);
    }
    if (verified.artifactType === 'provider-live') {
      if (verified.authorizedTargetSha256 !== liveBindings.expectedAuthorizedTargets[verified.provider]) {
        fail('provider evidence target does not match trusted authorization', 'PUBLIC_ALPHA_EVIDENCE_TARGET_MISMATCH');
      }
    }
    if (verified.artifactType === 'hosted-live') {
      if (verified.authorizedTargetSha256 !== liveBindings.expectedAuthorizedTargets.hosted) {
        fail('hosted evidence target does not match trusted authorization', 'PUBLIC_ALPHA_EVIDENCE_TARGET_MISMATCH');
      }
      if (verified.deploymentSha256 !== liveBindings.expectedDeploymentSha256) {
        fail('hosted deployment does not match the trusted candidate tree', 'PUBLIC_ALPHA_DEPLOYMENT_MISMATCH');
      }
      try {
        verifyHostedOperatorSignature(verified, liveBindings.trustedOperatorKeys);
        /*
         * The restore runner's own signature is unverifiable outside its job,
         * so without this the restore proof is whatever the evidence claims it
         * is. The operator's witness is what makes it evidence.
         */
        verifyRestoreWitness(verified, liveBindings.restoreWitness, liveBindings.trustedOperatorKeys);
      } catch (error) {
        failArtifactVerification(artifact, error);
      }
    }
    artifacts.set(artifact.id, verified);
  }

  const catalog = qualificationCatalog(options.registry);
  assertExactKeys(record.automated, catalog.automated, 'automated');
  assertExactKeys(record.hosted, catalog.hosted, 'hosted');
  assertExactKeys(record.manual, catalog.manual, 'manual');
  const evidenceContext = { subjectSha256: record.subjectSha256, sourceCommit: record.sourceCommit };
  for (const key of catalog.automated) verifyEvidenceEntry(record.automated[key], `automated.${key}`, artifacts, now, evidenceContext);
  for (const key of catalog.hosted) verifyEvidenceEntry(record.hosted[key], `hosted.${key}`, artifacts, now, evidenceContext);
  for (const key of catalog.manual) verifyEvidenceEntry(record.manual[key], `manual.${key}`, artifacts, now, evidenceContext);

  assertExactKeys(record.providers, Object.keys(catalog.providers), 'provider', 'PUBLIC_ALPHA_PROVIDER_EVIDENCE_MISSING');
  for (const [provider, features] of Object.entries(catalog.providers)) {
    assertExactKeys(record.providers[provider], features, provider, 'PUBLIC_ALPHA_PROVIDER_EVIDENCE_MISSING');
    for (const feature of features) {
      verifyEvidenceEntry(record.providers[provider][feature], `providers.${provider}.${feature}`, artifacts, now, evidenceContext);
    }
  }

  if (
    !Number.isInteger(record.security.criticalUnresolved) ||
    !Number.isInteger(record.security.highUnresolved) ||
    record.security.criticalUnresolved !== 0 ||
    record.security.highUnresolved !== 0
  ) {
    fail('critical or high security findings remain open', 'PUBLIC_ALPHA_SECURITY_FINDINGS_OPEN');
  }

  for (const name of record.goldenPathCapabilities) {
    const tuple = capabilityTuple(options.registry, name);
    if (tuple[0] === 'Experimental') fail('experimental capability is in the golden path', 'PUBLIC_ALPHA_EXPERIMENTAL_IN_GOLDEN_PATH');
    if (tuple[0] !== 'Supported') fail('unavailable capability is in the golden path', 'PUBLIC_ALPHA_UNAVAILABLE_ENABLED');
  }
  for (const name of record.observedEnabledCapabilities) {
    if (capabilityTuple(options.registry, name)[0] === 'Unavailable') {
      fail('unavailable capability was observed enabled', 'PUBLIC_ALPHA_UNAVAILABLE_ENABLED');
    }
  }

  const recordHash = sha256(stableJson(record));
  return deepFreeze({
    ok: true,
    decision: 'go',
    recordHash,
    checks: {
      automated: catalog.automated.length,
      providerCapabilities: Object.values(catalog.providers).reduce((sum, items) => sum + items.length, 0),
      hosted: catalog.hosted.length,
      manual: catalog.manual.length,
      artifacts: record.artifacts.length,
      trustedLiveTargets: 4,
      hostedOperatorSignatures: 1,
      cleanupVerified: true,
      securityFindingsOpen: 0
    }
  });
}

module.exports = Object.freeze({
  QUALIFICATION_SCHEMA_VERSION,
  /*
   * Exported so that a readiness view can show the same window verification
   * enforces. A second copy of the number is a second number, and the one that
   * drifts is always the one on the screen the operator is reading.
   */
  MAX_EVIDENCE_AGE_MS,
  qualificationCatalog,
  validateQualificationRecord,
  verifyQualification
});
