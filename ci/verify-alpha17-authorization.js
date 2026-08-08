#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const AUTHORIZATION_SCHEMA_VERSION = '1.0.0';
const ALLOWED_JOBS = Object.freeze(['github', 'gitlab', 'gitea', 'hosted']);
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
  const jobs = [...new Set(value.map(item => String(item).trim()))];
  if (jobs.some(job => !ALLOWED_JOBS.includes(job))) fail(`${label} contains an unknown job`, 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
  return ALLOWED_JOBS.filter(job => jobs.includes(job));
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
    'schemaVersion', 'workflow', 'repository', 'event', 'sourceParent',
    'sourceCommit', 'subjectSha256', 'authorizedJobs', 'authorizationId', 'expiresAt'
  ];
  if (Object.keys(payload).some(key => !allowedFields.includes(key))) {
    fail('authorization payload contains an unexpected field', 'ALPHA17_AUTHORIZATION_INVALID');
  }
  if (!crypto.verify(null, payloadBytes, publicKey(options.publicKeyBase64), signature)) {
    fail('authorization signature does not verify', 'ALPHA17_AUTHORIZATION_SIGNATURE_INVALID');
  }
  if (payload.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) fail('authorization schema does not match', 'ALPHA17_AUTHORIZATION_INVALID');
  if (payload.workflow !== options.expectedWorkflow) fail('authorization workflow does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
  if (payload.repository !== options.expectedRepository) fail('authorization repository does not match', 'ALPHA17_AUTHORIZATION_SCOPE_MISMATCH');
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
  if (requestedJobs.some(job => !authorizedJobs.includes(job))) {
    fail('a requested job is outside the authorization envelope', 'ALPHA17_AUTHORIZATION_JOBS_INVALID');
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
  return Object.freeze({
    ok: true,
    authorizationId: payload.authorizationId,
    authorizedJobs: Object.freeze(authorizedJobs),
    expiresAt: payload.expiresAt,
    envelopeHash: sha256(raw)
  });
}

function main(env = process.env) {
  const requestedJobs = String(env.NV_ALPHA17_REQUESTED_JOBS || '').split(',').map(value => value.trim()).filter(Boolean);
  const token = fs.readFileSync(0, 'utf8').trim();
  const result = verifyAuthorizationEnvelope(token, {
    publicKeyBase64: env.NV_ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64,
    expectedWorkflow: env.NV_ALPHA17_EXPECTED_WORKFLOW,
    expectedRepository: env.NV_ALPHA17_EXPECTED_REPOSITORY,
    expectedEvent: env.NV_ALPHA17_EXPECTED_EVENT,
    expectedSourceParent: env.NV_ALPHA17_EXPECTED_SOURCE_PARENT,
    expectedSourceCommit: env.NV_ALPHA17_EXPECTED_SOURCE_COMMIT,
    expectedSubjectHash: env.NV_ALPHA17_EXPECTED_SUBJECT_SHA256,
    requestedJobs,
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
  verifyAuthorizationEnvelope
});
