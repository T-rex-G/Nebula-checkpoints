#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const registry = require('../config/public-alpha-capabilities.json');
const { runSmoke } = require('../scripts/alpha-smoke');
const { runLoad } = require('../scripts/alpha-load');
const { qualificationCatalog } = require('../src/public-alpha-qualification');
const {
  requireExactCommit,
  requireSubjectHash,
  sanitizeEvidence
} = require('./provider-alpha17-common');
const { verifyLiveTargetBinding } = require('./verify-alpha17-authorization');

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DIRECT_KEYS = Object.freeze([
  'render-cold-start',
  'five-concurrent-read-testers',
  'single-bounded-mutation'
]);
const OPERATIONAL_KEYS = Object.freeze(
  qualificationCatalog(registry).hosted.filter(key => !DIRECT_KEYS.includes(key))
);

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
  const safeSecretLikeKeys = new Set(['token-bearing-state-removed']);
  function visit(input) {
    if (Array.isArray(input)) return input.forEach(visit);
    if (isPlainObject(input)) {
      for (const [key, child] of Object.entries(input)) {
        const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        if (
          !safeSecretLikeKeys.has(normalized) &&
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
  for (const key of OPERATIONAL_KEYS) {
    if (!isPlainObject(record.checks[key]) || record.checks[key].status !== 'pass') {
      fail('an operational check did not pass', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
    }
  }
  if (record.checks['ephemeral-filesystem-restart'].stateRecoveredFromDatabase !== true) {
    fail('restart recovery did not prove database-backed state', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
  }
  if (record.checks['isolated-database-restore'].latestMigration !== '015_alpha_privacy') {
    fail('isolated restore migration does not match', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
  }
  if (record.checks['disposable-tester-purge'].tokenBearingStateRemoved !== true) {
    fail('tester purge did not remove token-bearing state', 'ALPHA17_OPERATIONAL_CHECK_FAILED');
  }
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

async function runHostedValidation(options = {}) {
  const env = options.env || process.env;
  const subjectSha256 = requireSubjectHash(env);
  const sourceCommit = requireExactCommit(env);
  const targetBinding = verifyLiveTargetBinding({
    jobName: 'hosted',
    target: {
      baseUrl: env.NV_ALPHA_BASE_URL,
      renderServiceId: env.NV_ALPHA17_RENDER_SERVICE_ID,
      neonProjectId: env.NV_ALPHA17_NEON_PROJECT_ID
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
    ...operational.checks
  };
  const hostedKeys = qualificationCatalog(registry).hosted;
  if (hostedKeys.some(key => !checks[key] || checks[key].status !== 'pass')) {
    fail('hosted qualification catalog is incomplete', 'ALPHA17_HOSTED_CATALOG_INCOMPLETE');
  }
  const core = sanitizeEvidence({
    schemaVersion: '1.0.0',
    status: 'pass',
    cleanupVerified: true,
    subjectSha256,
    sourceCommit,
    authorizedTargetSha256: targetBinding.targetHash,
    checks,
    startedAt,
    completedAt: now().toISOString(),
    nodeVersion: process.versions.node
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
  readOperationalRecord,
  runHostedValidation
});
