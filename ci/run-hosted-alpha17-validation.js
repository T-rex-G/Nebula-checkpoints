#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('../config/public-alpha-capabilities.json');
const { runSmoke, timedRequest } = require('../scripts/alpha-smoke');
const { readSafeJson, runLoad } = require('../scripts/alpha-load');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  verifyHostedOperatorSignature
} = require('../src/qualification-evidence');
const {
  requireExactCommit,
  requireEnvironment,
  requireSubjectHash,
  sanitizeEvidence
} = require('./provider-alpha17-common');
const { verifyLiveTargetBinding } = require('./verify-alpha17-authorization');
const { validateRunnerRestoreAttestation } = require('./alpha17-restore-attestation');

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DIRECT_KEYS = Object.freeze([
  'render-cold-start',
  'five-concurrent-read-testers',
  'single-bounded-mutation'
]);
const RESTORE_KEY = 'isolated-database-restore';
const OPERATIONAL_KEYS = Object.freeze(
  qualificationCatalog(registry).hosted.filter(key => !DIRECT_KEYS.includes(key) && key !== RESTORE_KEY)
);
const OPERATIONAL_CHECK_CONTRACT = Object.freeze({
  'neon-scale-to-zero-wake': Object.freeze({ status: 'pass', wakeRetries: '$positive-integer' }),
  'memory-restart-observation': Object.freeze({ status: 'pass', restartObserved: true }),
  'active-session-revocation': Object.freeze({ status: 'pass', deniedAfterRevocation: true }),
  'provider-disconnect': Object.freeze({ status: 'pass', browserStatePurged: true }),
  'ephemeral-filesystem-restart': Object.freeze({ status: 'pass', stateRecoveredFromDatabase: true }),
  'database-interruption-recovery': Object.freeze({ status: 'pass', failClosedDuringInterruption: true }),
  'provider-429-outage': Object.freeze({ status: 'pass', retryBounded: true }),
  'application-rollback': Object.freeze({ status: 'pass', candidateRestored: true }),
  'disposable-tester-purge': Object.freeze({ status: 'pass', tokenBearingStateRemoved: true })
});

function fail(message, code) {
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

function isNonzeroSha256(value) {
  return SHA256_PATTERN.test(String(value || '')) && !/^0{64}$/.test(value);
}

function validateOperationalCheck(key, check) {
  const contract = OPERATIONAL_CHECK_CONTRACT[key];
  if (!contract || !hasExactKeys(check, Object.keys(contract))) {
    fail('an operational check does not match its signed proof schema', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
  }
  for (const [field, rule] of Object.entries(contract)) {
    if (rule === '$positive-integer') {
      if (!Number.isSafeInteger(check[field]) || check[field] <= 0) {
        fail('an operational count is invalid', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
      }
    } else if (rule === '$sha256') {
      if (!isNonzeroSha256(check[field])) {
        fail('an operational proof digest is invalid', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
      }
    } else if (check[field] !== rule) {
      fail('an operational proof is incomplete', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
    }
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoSecretMaterial(value) {
  const safeSecretLikeKeys = Object.freeze(['token-bearing-state-removed']);
  function visit(input) {
    if (Array.isArray(input)) return input.forEach(visit);
    if (isPlainObject(input)) {
      for (const [key, child] of Object.entries(input)) {
        const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        if (
          !safeSecretLikeKeys.includes(normalized) &&
          /(^|[-_])(password|credential|token|authorization|cookie|secret|private[-_]?key|api[-_]?key|database[-_]?url)([-_]|$)/.test(normalized)
        ) {
          fail('operational record contains a secret-like field', 'ALPHA17_OPERATIONAL_SECRET_MATERIAL');
        }
        visit(child);
      }
      return;
    }
    if (typeof input === 'string' && (
      /authorization\s*:\s*bearer/i.test(input) ||
      /postgres(?:ql)?:\/\/[^\s/:]+:[^@\s]+@/i.test(input) ||
      /\bgh[pousr]_[a-z0-9_]{20,}/i.test(input) ||
      /\bglpat-[a-z0-9_-]{12,}/i.test(input)
    )) {
      fail('operational record contains secret-like material', 'ALPHA17_OPERATIONAL_SECRET_MATERIAL');
    }
  }
  visit(value);
}

function parseFresh(value, now) {
  const completed = new Date(value);
  if (!value || Number.isNaN(completed.getTime()) || completed.toISOString() !== value) {
    fail('operational record timestamp is invalid', 'ALPHA17_OPERATIONAL_STALE');
  }
  const age = now.getTime() - completed.getTime();
  if (age > MAX_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
    fail('operational record is outside the 72-hour window', 'ALPHA17_OPERATIONAL_STALE');
  }
}

function publicKeyFromBase64(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) {
    fail('operator public key is invalid', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'spki'
    });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    fail('operator public key is invalid', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
}

function validateOperationalRecord(input, options = {}) {
  if (!isPlainObject(input)) fail('operational record must be an object', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  assertNoSecretMaterial(input);
  const record = cloneJson(input);
  if (!hasExactKeys(record, [
    'schemaVersion', 'subjectSha256', 'sourceCommit', 'completedAt',
    'cleanupVerified', 'checks', 'signature'
  ])) fail('operational record fields do not match the signed schema', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  if (record.schemaVersion !== '1.0.0') fail('operational schema does not match', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  if (record.subjectSha256 !== options.expectedSubjectHash) {
    fail('operational subject does not match', 'ALPHA17_OPERATIONAL_SUBJECT_MISMATCH');
  }
  if (record.sourceCommit !== options.expectedSourceCommit) {
    fail('operational source commit does not match', 'ALPHA17_OPERATIONAL_SOURCE_MISMATCH');
  }
  if (record.cleanupVerified !== true) fail('operational cleanup is not verified', 'ALPHA17_OPERATIONAL_CLEANUP_INCOMPLETE');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  parseFresh(record.completedAt, now);
  if (!isPlainObject(record.checks)) fail('operational checks are missing', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  const actualKeys = Object.keys(record.checks).sort();
  assertNoSecretMaterial(record.checks);
  if (JSON.stringify(actualKeys) !== JSON.stringify([...OPERATIONAL_KEYS].sort())) {
    fail('operational checks do not match the hosted catalog', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  }
  if (JSON.stringify(Object.keys(OPERATIONAL_CHECK_CONTRACT).sort()) !== JSON.stringify([...OPERATIONAL_KEYS].sort())) {
    fail('operational proof contract does not match the hosted catalog', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  }
  for (const key of OPERATIONAL_KEYS) validateOperationalCheck(key, record.checks[key]);
  if (!isPlainObject(record.signature) || record.signature.algorithm !== 'ed25519') {
    fail('operational signature is missing', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(String(record.signature.keyId || ''))) {
    fail('operational signature key ID is invalid', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
  const signature = String(record.signature.value || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 512) {
    fail('operational signature value is invalid', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
  const unsigned = { ...record };
  delete unsigned.signature;
  const verified = crypto.verify(
    null,
    Buffer.from(stableJson(unsigned), 'utf8'),
    publicKeyFromBase64(options.publicKeyBase64),
    Buffer.from(signature, 'base64')
  );
  if (!verified) fail('operational signature does not verify', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  return Object.freeze(record);
}

function readOperationalRecord(filePath) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECORD_BYTES) {
    fail('operational record must be a bounded regular non-symlink file', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  }
  try {
    return JSON.parse(fs.readFileSync(fs.realpathSync(filePath), 'utf8'));
  } catch {
    fail('operational record must contain valid JSON', 'ALPHA17_OPERATIONAL_SCHEMA_INVALID');
  }
}

function readRunnerRestoreAttestation(filePath) {
  if (!filePath) fail('runner restore attestation is required', 'ALPHA17_RESTORE_ATTESTATION_MISSING');
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    fail('runner restore attestation is required', 'ALPHA17_RESTORE_ATTESTATION_MISSING');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_RECORD_BYTES) {
    fail('runner restore attestation must be a bounded regular file', 'ALPHA17_RESTORE_ATTESTATION_INVALID');
  }
  try {
    return JSON.parse(fs.readFileSync(fs.realpathSync(filePath), 'utf8'));
  } catch {
    fail('runner restore attestation must contain valid JSON', 'ALPHA17_RESTORE_ATTESTATION_INVALID');
  }
}

async function readDeployedReleaseFingerprint(baseUrl) {
  let timed;
  try {
    timed = await timedRequest(baseUrl, '/api/version', {
      method: 'GET',
      timeoutMs: 20000,
      followRedirects: false
    });
  } catch {
    fail('hosted deployment identity request failed', 'ALPHA17_HOSTED_DEPLOYMENT_INVALID');
  }
  if (timed.response.status !== 200) {
    await timed.response.body?.cancel().catch(() => {});
    fail('hosted deployment identity request did not pass', 'ALPHA17_HOSTED_DEPLOYMENT_INVALID');
  }
  const body = await readSafeJson(timed.response);
  const fingerprint = String(body?.releaseTreeSha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint) || /^0{64}$/.test(fingerprint)) {
    fail('hosted deployment identity is invalid', 'ALPHA17_HOSTED_DEPLOYMENT_INVALID');
  }
  return fingerprint;
}

async function runHostedValidation(options = {}) {
  const env = options.env || process.env;
  const subjectSha256 = requireSubjectHash(env);
  const sourceCommit = requireExactCommit(env);
  const runId = requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_RUN_ID');
  const targetBinding = verifyLiveTargetBinding({
    jobName: 'hosted',
    target: {
      baseUrl: env.NV_ALPHA_BASE_URL,
      renderServiceId: env.NV_ALPHA17_RENDER_SERVICE_ID,
      neonProjectId: env.NV_ALPHA17_NEON_PROJECT_ID,
      cohortNeonBranchId: env.NV_ALPHA17_COHORT_NEON_BRANCH_ID,
      restoreNeonProjectId: env.NV_ALPHA17_RESTORE_NEON_PROJECT_ID,
      restoreNeonBranchId: env.NV_ALPHA17_RESTORE_NEON_BRANCH_ID,
      restoreTargetKind: env.NV_ALPHA17_RESTORE_TARGET_KIND,
      restoreTargetFingerprint: env.NV_RESTORE_TARGET_FINGERPRINT,
      restoreAppBaseUrl: env.NV_ALPHA17_RESTORE_APP_BASE_URL,
      restoreAppDeployId: env.NV_ALPHA17_RESTORE_APP_DEPLOY_ID
    },
    signedTargetHash: env.NV_ALPHA17_SIGNED_TARGET_SHA256
  });
  const now = options.now || (() => new Date());
  const startedAt = now().toISOString();
  const inputRecord = options.operationalRecord || readOperationalRecord(String(env.NV_ALPHA17_OPERATIONAL_RECORD || ''));
  const operational = validateOperationalRecord(inputRecord, {
    expectedSubjectHash: subjectSha256,
    expectedSourceCommit: sourceCommit,
    publicKeyBase64: env.NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64,
    now: now()
  });
  const operatorKeyId = requireEnvironment(env, 'NV_ALPHA17_OPERATOR_KEY_ID');
  if (operational.signature.keyId !== operatorKeyId) {
    fail('operational signature key ID is not the trusted operator key', 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
  }
  const inputRestoreAttestation = options.restoreAttestation || readRunnerRestoreAttestation(
    String(env.NV_ALPHA17_RESTORE_ATTESTATION || '')
  );
  const restoreAttestation = validateRunnerRestoreAttestation(inputRestoreAttestation, {
    expectedSubjectHash: subjectSha256,
    expectedSourceCommit: sourceCommit,
    expectedOriginId: `workflow-${runId}-restore`,
    expectedRestoreTargetFingerprint: requireEnvironment(env, 'NV_RESTORE_TARGET_FINGERPRINT'),
    expectedRestoreAppDeployIdSha256: sha256(requireEnvironment(env, 'NV_ALPHA17_RESTORE_APP_DEPLOY_ID')),
    workflowRepository: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_REPOSITORY'),
    workflowPath: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_PATH'),
    workflowRunId: runId,
    attestationKeyBase64: requireEnvironment(env, 'NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64'),
    now: now()
  });

  const expectedDeploymentSha256 = computeReleaseFingerprint(path.resolve(__dirname, '..'));
  const deploymentSha256 = await readDeployedReleaseFingerprint(env.NV_ALPHA_BASE_URL);
  if (deploymentSha256 !== expectedDeploymentSha256) {
    fail('hosted deployment does not match the exact candidate release tree', 'ALPHA17_HOSTED_DEPLOYMENT_MISMATCH');
  }

  const smoke = await runSmoke(env.NV_ALPHA_BASE_URL);
  if (!smoke.ok) fail('hosted smoke checks did not pass', 'ALPHA17_HOSTED_SMOKE_FAILED');
  const load = await runLoad({
    ...env,
    NV_ALPHA_TESTERS: '5',
    NV_ALPHA_READS_PER_TESTER: '10',
    NV_ALPHA_MUTATIONS: '1'
  });
  if (!load.ok || !load.cleanup.ok) fail('bounded hosted load did not pass cleanup', 'ALPHA17_HOSTED_LOAD_FAILED');

  const checks = {
    'render-cold-start': {
      status: 'pass',
      requestCount: smoke.checks.length,
      maximumDurationMs: Math.max(...smoke.checks.map(check => check.durationMs))
    },
    'five-concurrent-read-testers': {
      status: 'pass',
      workers: load.workers,
      reads: load.reads,
      p95Ms: load.p95Ms
    },
    'single-bounded-mutation': {
      status: 'pass',
      mutations: load.mutations,
      mutationStatusClass: load.mutation ? `${Math.floor(load.mutation.status / 100)}xx` : 'none',
      cleanupVerified: load.cleanup.ok
    },
    ...operational.checks,
    [RESTORE_KEY]: restoreAttestation.check
  };
  const hostedKeys = qualificationCatalog(registry).hosted;
  if (hostedKeys.some(key => !checks[key] || checks[key].status !== 'pass')) {
    fail('hosted qualification catalog is incomplete', 'ALPHA17_HOSTED_CATALOG_INCOMPLETE');
  }
  const completedAt = now().toISOString();
  const claims = Object.fromEntries(hostedKeys.map(key => [`hosted.${key}`, {
    status: 'pass',
    cleanupVerified: true,
    completedAt
  }]));
  const core = sanitizeEvidence({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    artifactType: 'hosted-live',
    status: 'pass',
    cleanupVerified: true,
    subjectSha256,
    sourceCommit,
    originId: `workflow-${runId}-hosted`,
    authorizedTargetSha256: targetBinding.targetHash,
    deploymentSha256,
    operatorAttestation: {
      schemaVersion: operational.schemaVersion,
      keyId: operational.signature.keyId,
      completedAt: operational.completedAt,
      recordSha256: sha256(stableJson(operational)),
      record: operational
    },
    restoreRunnerAttestation: {
      schemaVersion: restoreAttestation.schemaVersion,
      completedAt: restoreAttestation.completedAt,
      recordSha256: sha256(stableJson(restoreAttestation)),
      record: restoreAttestation
    },
    checks,
    claims,
    startedAt,
    completedAt,
    nodeVersion: process.versions.node
  });
  validateEvidenceEnvelope(core);
  verifyHostedOperatorSignature(core, {
    [operatorKeyId]: requireEnvironment(env, 'NV_ALPHA17_OPERATOR_PUBLIC_KEY_BASE64')
  });
  return Object.freeze({ ...core, artifactSha256: sha256(stableJson(core)) });
}

if (require.main === module) {
  runHostedValidation().then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({
  validateOperationalRecord,
  validateRunnerRestoreAttestation,
  readOperationalRecord,
  readRunnerRestoreAttestation,
  readDeployedReleaseFingerprint,
  runHostedValidation
});
