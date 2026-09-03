#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTHORIZATION_SCHEMA_VERSION = '1.3.0';
const ALLOWED_JOBS = Object.freeze(['github', 'gitlab', 'gitea', 'hosted']);
const PROVIDER_JOBS = new Set(['github', 'gitlab', 'gitea']);
const MAX_LIFETIME_MS = 30 * 60 * 1000;

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

function base64UrlDecode(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 16384) {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_INVALID');
  }
  try {
    return Buffer.from(text, 'base64url');
  } catch {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_INVALID');
  }
}

function publicKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) {
    fail('authorization public key is invalid', 'ALPHA17_AUTHORIZATION_SIGNATURE_INVALID');
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
    fail('authorization public key is invalid', 'ALPHA17_AUTHORIZATION_SIGNATURE_INVALID');
  }
}

function normalizeJobs(value, label) {
  if (!Array.isArray(value) || !value.length) fail(`${label} must name at least one job`, 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
  const rawJobs = value.map(item => String(item).trim());
  const jobs = [...new Set(rawJobs)];
  if (jobs.length !== rawJobs.length) fail(`${label} contains a duplicate job`, 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
  if (jobs.some(job => !ALLOWED_JOBS.includes(job))) fail(`${label} contains an unknown job`, 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
  return ALLOWED_JOBS.filter(job => jobs.includes(job));
}

function normalizeUrl(value, label, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  const loopbackHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  if (options.originOnly && parsed.pathname !== '/') {
    fail(`${label} must identify one service origin`, 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}${pathname}`;
}

function normalizeIdentity(value, label) {
  const identity = String(value || '').trim();
  if (!/^[A-Za-z0-9._/-]{3,200}$/.test(identity) || identity.includes('//')) {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  return identity;
}

function normalizeSha256(value, label) {
  const digest = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest) || /^0{64}$/.test(digest)) {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  return digest;
}

function normalizeRef(value, label) {
  const ref = String(value || '').trim();
  if (
    !/^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]{1,180}$/.test(ref) ||
    ref.includes('//') ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(ref)
  ) {
    fail(`${label} is invalid`, 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  }
  return ref;
}

/*
 * The signer's authorizationId is a nonce, and this is where it is spent.
 *
 * It is hashed before it reaches the ledger for two reasons. The identifier
 * grammar admits '.' and therefore admits path segments such as '........',
 * which a directory-backed ledger would resolve rather than store; and a
 * fixed-width opaque identifier lets any ledger -- a directory today, a table
 * later -- key on it without re-deriving the grammar.
 */
function authorizationClaimId(authorizationId) {
  return sha256(`alpha17-authorization-claim\n${authorizationId}`);
}

/*
 * Fail closed. A verifier that cannot record the spend has not established
 * that the envelope is unspent, so an absent, broken, or uncommunicative
 * ledger refuses the activation instead of degrading to expiry-only checking.
 */
function spendAuthorizationClaim(claims, authorizationId) {
  if (!claims || typeof claims.record !== 'function') {
    fail('authorization claim ledger is unavailable', 'ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE');
  }
  let recorded;
  try {
    recorded = claims.record(authorizationClaimId(authorizationId));
  } catch (error) {
    fail(
      `authorization claim ledger is unavailable: ${error && error.message ? error.message : 'unknown error'}`,
      'ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE'
    );
  }
  if (recorded !== true && recorded !== false) {
    fail('authorization claim ledger did not report whether the claim was new', 'ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE');
  }
  if (!recorded) {
    fail('authorization envelope has already been spent', 'ALPHA17_AUTHORIZATION_REPLAYED');
  }
}

/*
 * Exclusive create is the claim. Reading the directory and then writing to it
 * would leave a window between the two in which a second dispatch reads the
 * same absence, so novelty is decided by whether the create succeeded.
 */
function fileClaimLedger(directory) {
  const root = String(directory || '').trim();
  if (!root) throw new TypeError('authorization claim ledger directory is required');
  return Object.freeze({
    record(claimId) {
      if (!/^[0-9a-f]{64}$/.test(String(claimId))) {
        throw new TypeError('authorization claim identifier is invalid');
      }
      try {
        fs.writeFileSync(path.join(root, `${claimId}.claim`), `${new Date().toISOString()}\n`, {
          flag: 'wx',
          mode: 0o600
        });
      } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        throw error;
      }
      return true;
    }
  });
}

function normalizeLiveTarget(jobName, input) {
  const job = String(jobName || '').trim();
  if (!ALLOWED_JOBS.includes(job) || !isPlainObject(input)) {
    fail('live target is invalid', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  if (PROVIDER_JOBS.has(job)) {
    if (Object.keys(input).some(key => !['repository', 'apiUrl'].includes(key))) {
      fail('provider target contains an unexpected field', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
    }
    const repository = String(input.repository || '').trim();
    const segments = repository.split('/');
    if (
      segments.length !== 2 ||
      segments.some(segment => !/^[A-Za-z0-9._-]{1,100}$/.test(segment)) ||
      !segments[1].startsWith('nvx-alpha17-')
    ) {
      fail('provider target must be one pre-created disposable alpha.17 repository', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
    }
    return Object.freeze({
      apiUrl: normalizeUrl(input.apiUrl, 'provider API URL'),
      jobName: job,
      repository
    });
  }
  const hostedFields = [
    'baseUrl', 'renderServiceId', 'neonProjectId', 'cohortNeonBranchId',
    'restoreNeonProjectId', 'restoreNeonBranchId', 'restoreTargetKind',
    'restoreTargetFingerprint', 'restoreAppBaseUrl', 'restoreAppDeployId'
  ];
  if (Object.keys(input).some(key => !hostedFields.includes(key))) {
    fail('hosted target contains an unexpected field', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  const target = {
    baseUrl: normalizeUrl(input.baseUrl, 'hosted base URL', { originOnly: true }),
    cohortNeonBranchId: normalizeIdentity(input.cohortNeonBranchId, 'cohort Neon branch identity'),
    jobName: job,
    neonProjectId: normalizeIdentity(input.neonProjectId, 'Neon project identity'),
    renderServiceId: normalizeIdentity(input.renderServiceId, 'Render service identity'),
    restoreNeonBranchId: normalizeIdentity(input.restoreNeonBranchId, 'restore Neon branch identity'),
    restoreNeonProjectId: normalizeIdentity(input.restoreNeonProjectId, 'restore Neon project identity'),
    restoreAppBaseUrl: normalizeUrl(input.restoreAppBaseUrl, 'restore application base URL', { originOnly: true }),
    restoreAppDeployId: normalizeIdentity(input.restoreAppDeployId, 'restore application deploy identity'),
    restoreTargetFingerprint: normalizeSha256(input.restoreTargetFingerprint, 'restore target fingerprint'),
    restoreTargetKind: String(input.restoreTargetKind || '').trim()
  };
  if (target.restoreTargetKind !== 'isolated-neon-branch') {
    fail('restore target kind is invalid', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  if (
    target.neonProjectId === target.restoreNeonProjectId &&
    target.cohortNeonBranchId === target.restoreNeonBranchId
  ) fail('hosted restore branch must differ from the cohort branch', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  if (target.baseUrl === target.restoreAppBaseUrl) {
    fail('hosted restore application must differ from the cohort application', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  return Object.freeze(target);
}

function hashLiveTarget(jobName, target) {
  return sha256(stableJson(normalizeLiveTarget(jobName, target)));
}

function verifyLiveTargetBinding(options = {}) {
  const jobName = String(options.jobName || '').trim();
  const signedTargetHash = String(options.signedTargetHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(signedTargetHash) || /^0{64}$/.test(signedTargetHash)) {
    fail('signed live target hash is invalid', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  const targetHash = hashLiveTarget(jobName, options.target);
  if (targetHash !== signedTargetHash) {
    fail('live target does not match the signed authorization envelope', 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH');
  }
  return Object.freeze({ ok: true, jobName, targetHash });
}

function normalizeTargetHashes(value, authorizedJobs) {
  if (!isPlainObject(value)) fail('authorization target hashes are missing', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  const keys = Object.keys(value).sort();
  const expected = [...authorizedJobs].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail('authorization target hashes do not match the authorized jobs', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  const targetHashes = {};
  for (const jobName of authorizedJobs) {
    const hash = String(value[jobName] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || /^0{64}$/.test(hash)) {
      fail('authorization target hash is invalid', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
    }
    targetHashes[jobName] = hash;
  }
  return Object.freeze(targetHashes);
}

function targetFromEnvironment(jobName, env = process.env, prefix = 'NV_ALPHA17') {
  if (PROVIDER_JOBS.has(jobName)) {
    const upper = jobName.toUpperCase();
    return {
      repository: env[`${prefix}_${upper}_REPOSITORY`],
      apiUrl: env[`${prefix}_${upper}_API_URL`]
    };
  }
  if (jobName === 'hosted') {
    return {
      baseUrl: env[`${prefix}_HOSTED_BASE_URL`],
      renderServiceId: env[`${prefix}_RENDER_SERVICE_ID`],
      neonProjectId: env[`${prefix}_NEON_PROJECT_ID`],
      cohortNeonBranchId: env[`${prefix}_COHORT_NEON_BRANCH_ID`],
      restoreNeonProjectId: env[`${prefix}_RESTORE_NEON_PROJECT_ID`],
      restoreNeonBranchId: env[`${prefix}_RESTORE_NEON_BRANCH_ID`],
      restoreTargetKind: env[`${prefix}_RESTORE_TARGET_KIND`],
      restoreTargetFingerprint: env[`${prefix}_RESTORE_TARGET_FINGERPRINT`],
      restoreAppBaseUrl: env[`${prefix}_RESTORE_APP_BASE_URL`],
      restoreAppDeployId: env[`${prefix}_RESTORE_APP_DEPLOY_ID`]
    };
  }
  fail('live target job is invalid', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
}

function encodeAuthorizationEnvelope(payload, privateKey) {
  if (!isPlainObject(payload)) throw new TypeError('authorization payload must be an object');
  const payloadBytes = Buffer.from(stableJson(payload), 'utf8');
  const signature = crypto.sign(null, payloadBytes, privateKey);
  return `${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}

function verifyAuthorizationEnvelope(token, options = {}) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) fail('authorization envelope is malformed', 'ALPHA17_AUTHORIZATION_INVALID');
  const payloadBytes = base64UrlDecode(parts[0], 'authorization payload');
  const signature = base64UrlDecode(parts[1], 'authorization signature');
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    fail('authorization payload is malformed', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  if (!isPlainObject(payload) || stableJson(payload) !== payloadBytes.toString('utf8')) {
    fail('authorization payload is not canonical JSON', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  const allowedFields = [
    'schemaVersion', 'workflow', 'repository', 'ref', 'event', 'sourceParent',
    'sourceCommit', 'subjectSha256', 'authorizedJobs', 'targetHashes',
    'authorizationId', 'expiresAt'
  ];
  if (!allowedFields.every(field => Object.prototype.hasOwnProperty.call(payload, field))) {
    fail('authorization payload is missing a required field', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  if (Object.keys(payload).some(key => !allowedFields.includes(key))) {
    fail('authorization payload contains an unexpected field', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  if (!crypto.verify(null, payloadBytes, publicKey(options.publicKeyBase64), signature)) {
    fail('authorization signature does not verify', 'ALPHA17_AUTHORIZATION_SIGNATURE_INVALID');
  }
  if (payload.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) fail('authorization schema does not match', 'ALPHA17_AUTHORIZATION_INVALID');
  if (payload.workflow !== options.expectedWorkflow) fail('authorization workflow does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  if (payload.repository !== options.expectedRepository) fail('authorization repository does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  if (normalizeRef(payload.ref, 'authorization ref') !== normalizeRef(options.expectedRef, 'dispatch ref')) {
    fail('authorization ref does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  }
  if (payload.event !== options.expectedEvent || payload.event !== 'workflow_dispatch') {
    fail('authorization event does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  }
  if (!/^[0-9a-f]{40}$/.test(String(payload.sourceParent || '')) || payload.sourceParent !== options.expectedSourceParent) {
    fail('authorization source parent does not match', 'ALPHA17_AUTHORIZATION_SOURCE_MISMATCH');
  }
  if (!/^[0-9a-f]{40}$/.test(String(payload.sourceCommit || '')) || payload.sourceCommit !== options.expectedSourceCommit) {
    fail('authorization source commit does not match', 'ALPHA17_AUTHORIZATION_SOURCE_MISMATCH');
  }
  if (!/^[0-9a-f]{64}$/.test(String(payload.subjectSha256 || '')) || payload.subjectSha256 !== options.expectedSubjectHash) {
    fail('authorization subject does not match', 'ALPHA17_AUTHORIZATION_SUBJECT_MISMATCH');
  }
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(String(payload.authorizationId || ''))) {
    fail('authorization ID is invalid', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  const authorizedJobs = normalizeJobs(payload.authorizedJobs, 'authorizedJobs');
  const requestedJobs = normalizeJobs(options.requestedJobs, 'requestedJobs');
  if (JSON.stringify(requestedJobs) !== JSON.stringify(authorizedJobs)) {
    fail('requested jobs do not exactly match the authorization envelope', 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
  }
  const targetHashes = normalizeTargetHashes(payload.targetHashes, authorizedJobs);
  if (!isPlainObject(options.expectedTargets)) {
    fail('expected live targets are missing', 'ALPHA17_AUTHORIZATION_TARGET_INVALID');
  }
  for (const jobName of requestedJobs) {
    verifyLiveTargetBinding({
      jobName,
      target: options.expectedTargets[jobName],
      signedTargetHash: targetHashes[jobName]
    });
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const expiresAt = new Date(payload.expiresAt);
  if (
    Number.isNaN(now.getTime()) ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.toISOString() !== payload.expiresAt ||
    expiresAt.getTime() <= now.getTime()
  ) {
    fail('authorization envelope expired', 'ALPHA17_AUTHORIZATION_EXPIRED');
  }
  if (expiresAt.getTime() - now.getTime() > MAX_LIFETIME_MS) {
    fail('authorization lifetime exceeds 30 minutes', 'ALPHA17_AUTHORIZATION_EXPIRED');
  }
  /*
   * Spent last, so a rejected envelope keeps its approval identifier. The
   * envelope travels as a readable dispatch input, so any reader could
   * otherwise burn a pending approval by dispatching it against the wrong
   * subject and force the operator to re-sign.
   */
  spendAuthorizationClaim(options.claims, payload.authorizationId);
  return Object.freeze({
    ok: true,
    authorizationId: payload.authorizationId,
    authorizedJobs: Object.freeze(authorizedJobs),
    targetHashes,
    expiresAt: payload.expiresAt,
    envelopeHash: sha256(raw)
  });
}

function main(env = process.env) {
  if (process.argv[2] === 'target') {
    const jobName = String(env.NV_ALPHA17_TARGET_JOB || '').trim();
    const target = jobName === 'hosted'
      ? {
          baseUrl: env.NV_ALPHA17_TARGET_BASE_URL,
          renderServiceId: env.NV_ALPHA17_TARGET_RENDER_SERVICE_ID,
          neonProjectId: env.NV_ALPHA17_TARGET_NEON_PROJECT_ID,
          cohortNeonBranchId: env.NV_ALPHA17_TARGET_COHORT_NEON_BRANCH_ID,
          restoreNeonProjectId: env.NV_ALPHA17_TARGET_RESTORE_NEON_PROJECT_ID,
          restoreNeonBranchId: env.NV_ALPHA17_TARGET_RESTORE_NEON_BRANCH_ID,
          restoreTargetKind: env.NV_ALPHA17_TARGET_RESTORE_TARGET_KIND,
          restoreTargetFingerprint: env.NV_ALPHA17_TARGET_RESTORE_TARGET_FINGERPRINT,
          restoreAppBaseUrl: env.NV_ALPHA17_TARGET_RESTORE_APP_BASE_URL,
          restoreAppDeployId: env.NV_ALPHA17_TARGET_RESTORE_APP_DEPLOY_ID
        }
      : {
          repository: env.NV_ALPHA17_TARGET_REPOSITORY,
          apiUrl: env.NV_ALPHA17_TARGET_API_URL
        };
    const result = verifyLiveTargetBinding({
      jobName,
      target,
      signedTargetHash: env.NV_ALPHA17_SIGNED_TARGET_SHA256
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const requestedJobs = String(env.NV_ALPHA17_REQUESTED_JOBS || '').split(',').map(value => value.trim()).filter(Boolean);
  const expectedTargets = Object.fromEntries(
    requestedJobs.map(jobName => [jobName, targetFromEnvironment(jobName, env)])
  );
  const claimDirectory = String(env.NV_ALPHA17_AUTHORIZATION_CLAIM_DIR || '').trim();
  if (!claimDirectory) {
    fail('authorization claim ledger directory is not configured', 'ALPHA17_AUTHORIZATION_LEDGER_UNAVAILABLE');
  }
  const token = fs.readFileSync(0, 'utf8').trim();
  const result = verifyAuthorizationEnvelope(token, {
    publicKeyBase64: env.NV_ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64,
    claims: fileClaimLedger(claimDirectory),
    expectedWorkflow: env.NV_ALPHA17_EXPECTED_WORKFLOW,
    expectedRepository: env.NV_ALPHA17_EXPECTED_REPOSITORY,
    expectedRef: env.NV_ALPHA17_EXPECTED_REF,
    expectedEvent: env.NV_ALPHA17_EXPECTED_EVENT,
    expectedSourceParent: env.NV_ALPHA17_EXPECTED_SOURCE_PARENT,
    expectedSourceCommit: env.NV_ALPHA17_EXPECTED_SOURCE_COMMIT,
    expectedSubjectHash: env.NV_ALPHA17_EXPECTED_SUBJECT_SHA256,
    requestedJobs,
    expectedTargets,
    now: new Date()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  AUTHORIZATION_SCHEMA_VERSION,
  encodeAuthorizationEnvelope,
  fileClaimLedger,
  hashLiveTarget,
  verifyLiveTargetBinding,
  verifyAuthorizationEnvelope
});
