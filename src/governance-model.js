'use strict';

const crypto = require('crypto');
const { normalizeControlRefs, ControlMappingError } = require('./control-catalog');

const GOVERNANCE_AUDIT_GENESIS = 'NEBULAVERSE-GOVERNANCE-GENESIS-V1';
const POLICY_DOCUMENT_MAX_BYTES = 256 * 1024;
const AUDIT_DETAILS_MAX_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_ARRAY_ITEMS = 1000;
const MAX_OBJECT_KEYS = 250;
const MAX_RULES = 500;
const PROVIDERS = new Set(['github', 'gitlab', 'gitea']);
const EFFECTS = new Set(['allow', 'deny', 'require-approval']);
const SENSITIVE_KEY_RX = /^(?:access_?token|refresh_?token|token|client_?secret|secret|password|private_?key|authorization|authorization_?header|cookie|cookie_?value|session_?cookie)$/i;
const SENSITIVE_SUFFIX_RX = /(?:_token|_secret|_password|_private_key)$/i;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class GovernanceError extends Error {
  constructor(message, code, status = 400, details = undefined) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code, status = 400, details) {
  throw new GovernanceError(message, code, status, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeRequiredText(value, label, max = 200) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

function normalizeOptionalText(value, label, max = 2000) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

function normalizeIdentityKey(value, label = 'identity key') {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_IDENTITY_INVALID');
  return text;
}

function normalizeUuid(value, label = 'identifier') {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_ID_INVALID');
  }
  return text;
}

function normalizePolicyScope(input) {
  if (!isPlainObject(input)) fail('Policy scope is required', 'GOVERNANCE_SCOPE_INVALID');
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) fail('Policy provider is unsupported', 'GOVERNANCE_SCOPE_INVALID');
  const owner = normalizeRequiredText(input.owner, 'Policy owner', 240);
  const repo = normalizeRequiredText(input.repo, 'Policy repository', 160);
  const ownerSegment = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
  const repoSegment = /^[A-Za-z0-9_.-]+$/;
  if (!ownerSegment.test(owner) || owner.split('/').some(part => part === '.' || part === '..') || !repoSegment.test(repo) || repo === '.' || repo === '..') {
    fail('Policy repository scope is invalid', 'GOVERNANCE_SCOPE_INVALID');
  }

  let rawBase = String(input.baseUrl || '').trim();
  if (!rawBase) {
    if (provider === 'github') rawBase = 'https://github.com';
    else if (provider === 'gitlab') rawBase = 'https://gitlab.com';
    else if (input.authority) rawBase = `https://${String(input.authority).trim()}`;
    else fail('Gitea policy scope requires its server URL', 'GOVERNANCE_SCOPE_INVALID');
  }
  let parsed;
  try { parsed = new URL(rawBase); }
  catch { fail('Policy provider authority is invalid', 'GOVERNANCE_SCOPE_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('Policy provider authority is invalid', 'GOVERNANCE_SCOPE_INVALID');
  }
  if (provider === 'github' && ['api.github.com', 'github.com'].includes(parsed.hostname.toLowerCase())) {
    parsed = new URL('https://github.com');
  }
  const path = parsed.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  const authority = `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${path ? `/${path}` : ''}`;
  return {
    provider,
    authority,
    owner,
    repo,
    scopeKey: `${provider}:${authority}:${owner.toLowerCase()}/${repo.toLowerCase()}`
  };
}

function normalizePolicyKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(key)) {
    fail('Policy key must be a stable lower-case identifier', 'GOVERNANCE_POLICY_KEY_INVALID');
  }
  return key;
}

function sensitiveKey(key) {
  const compact = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_RX.test(key) || SENSITIVE_SUFFIX_RX.test(key) ||
    /(?:token|secret|password|privatekey)$/.test(compact) ||
    ['authorization', 'authorizationheader', 'cookie', 'cookievalue', 'sessioncookie'].includes(compact);
}

function cloneBoundedJson(value, options = {}, path = '$', depth = 0) {
  const maxBytes = options.maxBytes || POLICY_DOCUMENT_MAX_BYTES;
  if (depth > MAX_JSON_DEPTH) fail(`${path} exceeds the maximum JSON depth`, 'GOVERNANCE_DOCUMENT_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`, 'GOVERNANCE_DOCUMENT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > maxBytes) fail(`${path} contains an oversized string`, 'GOVERNANCE_DOCUMENT_TOO_LARGE', 413);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) fail(`${path} contains too many items`, 'GOVERNANCE_DOCUMENT_INVALID');
    return value.map((entry, index) => cloneBoundedJson(entry, options, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) fail(`${path} contains a non-JSON value`, 'GOVERNANCE_DOCUMENT_INVALID');
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) fail(`${path} contains too many fields`, 'GOVERNANCE_DOCUMENT_INVALID');
  const out = {};
  for (const key of keys) {
    if (!key || key.length > 120 || /[\u0000-\u001f\u007f]/.test(key)) fail(`${path} contains an invalid field name`, 'GOVERNANCE_DOCUMENT_INVALID');
    if (DANGEROUS_OBJECT_KEYS.has(key.toLowerCase())) {
      fail(`Dangerous field ${key} is not allowed in governance data`, 'GOVERNANCE_DANGEROUS_FIELD', 400, { path: `${path}.${key}` });
    }
    if (sensitiveKey(key)) fail(`Sensitive field ${key} is not allowed in governance data`, 'GOVERNANCE_SENSITIVE_FIELD', 400, { path: `${path}.${key}` });
    out[key] = cloneBoundedJson(value[key], options, `${path}.${key}`, depth + 1);
  }
  return out;
}

function enforceEncodedSize(value, maxBytes, code) {
  const bytes = Buffer.byteLength(stableJson(value), 'utf8');
  if (bytes > maxBytes) fail('Governance JSON exceeds the configured limit', code, 413, { bytes, maxBytes });
  return value;
}

function normalizePolicyDocument(input) {
  if (!isPlainObject(input)) fail('Policy document must be a JSON object', 'GOVERNANCE_DOCUMENT_INVALID');
  let initial;
  try { initial = JSON.stringify(input); } catch { fail('Policy document must be valid JSON', 'GOVERNANCE_DOCUMENT_INVALID'); }
  if (Buffer.byteLength(initial || '', 'utf8') > POLICY_DOCUMENT_MAX_BYTES) {
    fail('Policy document exceeds 256 KiB', 'GOVERNANCE_DOCUMENT_TOO_LARGE', 413);
  }
  const schemaVersion = Number(input.schemaVersion);
  if (schemaVersion !== 1) fail('Only governance policy schema version 1 is supported', 'GOVERNANCE_SCHEMA_UNSUPPORTED');
  if (!Array.isArray(input.rules)) fail('Policy rules must be an array', 'GOVERNANCE_DOCUMENT_INVALID');
  if (input.rules.length > MAX_RULES) fail('Policy contains too many rules', 'GOVERNANCE_DOCUMENT_INVALID');
  const ids = new Set();
  const rules = input.rules.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`Policy rule ${index + 1} must be an object`, 'GOVERNANCE_DOCUMENT_INVALID');
    const id = String(raw.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,63}$/.test(id)) fail(`Policy rule ${index + 1} has an invalid id`, 'GOVERNANCE_DOCUMENT_INVALID');
    if (ids.has(id)) fail(`Policy rule id ${id} is duplicated`, 'GOVERNANCE_RULE_DUPLICATE');
    ids.add(id);
    const action = String(raw.action || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,99}$/.test(action)) fail(`Policy rule ${id} has an invalid action`, 'GOVERNANCE_DOCUMENT_INVALID');
    const effect = String(raw.effect || '').trim().toLowerCase();
    if (!EFFECTS.has(effect)) fail(`Policy rule ${id} has an invalid effect`, 'GOVERNANCE_DOCUMENT_INVALID');
    const rule = { id, action, effect };
    if (raw.controlRefs !== undefined) {
      try { rule.controlRefs = [...normalizeControlRefs(raw.controlRefs)]; }
      catch (error) {
        if (error instanceof ControlMappingError) fail(error.message, error.code, error.status);
        throw error;
      }
    }
    if (raw.conditions !== undefined) {
      if (!isPlainObject(raw.conditions)) fail(`Policy rule ${id} conditions must be an object`, 'GOVERNANCE_DOCUMENT_INVALID');
      rule.conditions = cloneBoundedJson(raw.conditions, { maxBytes: POLICY_DOCUMENT_MAX_BYTES }, `$.rules[${index}].conditions`, 1);
    }
    if (raw.description !== undefined) rule.description = normalizeOptionalText(raw.description, `Policy rule ${id} description`, 1000);
    return rule;
  });
  const document = { schemaVersion: 1 };
  if (input.description !== undefined) document.description = normalizeOptionalText(input.description, 'Policy description', 4000);
  if (input.enforcement !== undefined) {
    if (!isPlainObject(input.enforcement)) fail('Policy enforcement must be an object', 'GOVERNANCE_ENFORCEMENT_INVALID');
    const mode = String(input.enforcement.mode || '').trim().toLowerCase();
    if (!['observe', 'warn', 'block'].includes(mode) || Object.keys(input.enforcement).some(key => key !== 'mode')) {
      fail('Policy enforcement mode must be observe, warn or block', 'GOVERNANCE_ENFORCEMENT_INVALID');
    }
    document.enforcement = { mode };
  }
  document.rules = rules;
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) fail('Policy metadata must be an object', 'GOVERNANCE_DOCUMENT_INVALID');
    document.metadata = cloneBoundedJson(input.metadata, { maxBytes: POLICY_DOCUMENT_MAX_BYTES }, '$.metadata', 1);
  }
  return enforceEncodedSize(document, POLICY_DOCUMENT_MAX_BYTES, 'GOVERNANCE_DOCUMENT_TOO_LARGE');
}

function normalizeApprovalPolicy(input = {}) {
  if (input == null) input = {};
  if (!isPlainObject(input)) fail('Approval policy is invalid', 'GOVERNANCE_APPROVAL_POLICY_INVALID');
  const requiredApprovals = input.requiredApprovals == null ? 1 : Number(input.requiredApprovals);
  const disallowAuthorApproval = input.disallowAuthorApproval == null ? true : input.disallowAuthorApproval;
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 5 || typeof disallowAuthorApproval !== 'boolean') {
    fail('Approval policy must require between one and five approvals', 'GOVERNANCE_APPROVAL_POLICY_INVALID');
  }
  return { requiredApprovals, disallowAuthorApproval };
}

function policyDocumentHash(document) {
  return sha256(stableJson(normalizePolicyDocument(document)));
}

function normalizeAuditDetails(input = {}) {
  if (!isPlainObject(input)) fail('Governance audit details must be an object', 'GOVERNANCE_AUDIT_INVALID');
  let initial;
  try { initial = JSON.stringify(input); } catch { fail('Governance audit details must be valid JSON', 'GOVERNANCE_AUDIT_INVALID'); }
  if (Buffer.byteLength(initial || '', 'utf8') > AUDIT_DETAILS_MAX_BYTES) {
    fail('Governance audit details exceed 64 KiB', 'GOVERNANCE_AUDIT_TOO_LARGE', 413);
  }
  return enforceEncodedSize(
    cloneBoundedJson(input, { maxBytes: AUDIT_DETAILS_MAX_BYTES }, '$', 0),
    AUDIT_DETAILS_MAX_BYTES,
    'GOVERNANCE_AUDIT_TOO_LARGE'
  );
}


function computeGovernanceReviewState(input = {}) {
  if (!isPlainObject(input)) fail('Governance review state is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  const requiredApprovals = Number(input.requiredApprovals);
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 5) {
    fail('Governance review quorum is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  }
  if (!Array.isArray(input.assignments) || !Array.isArray(input.decisions)) {
    fail('Governance review records are invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  }
  const assigned = new Set();
  for (const assignment of input.assignments) {
    if (!isPlainObject(assignment)) fail('Governance review assignment is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    const identityKey = normalizeIdentityKey(assignment.reviewerIdentityKey || assignment.reviewer_identity_key, 'reviewer identity');
    if (assigned.has(identityKey)) fail('Governance review assignment is duplicated', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    assigned.add(identityKey);
  }
  const decided = new Set();
  let approvalCount = 0;
  let rejectionCount = 0;
  for (const record of input.decisions) {
    if (!isPlainObject(record)) fail('Governance review decision is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    const identityKey = normalizeIdentityKey(record.actorIdentityKey || record.actor_identity_key, 'decision actor identity');
    const decision = String(record.decision || '').trim().toLowerCase();
    if (!assigned.has(identityKey) || decided.has(identityKey) || !['approve', 'reject'].includes(decision)) {
      fail('Governance review decision is inconsistent', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    }
    decided.add(identityKey);
    if (decision === 'approve') approvalCount += 1;
    else rejectionCount += 1;
  }
  const quorumReached = rejectionCount === 0 && approvalCount >= requiredApprovals;
  const status = rejectionCount > 0 ? 'rejected' : quorumReached ? 'approved' : 'pending';
  return {
    status,
    terminal: status !== 'pending',
    quorumReached,
    assignedCount: assigned.size,
    approvalCount,
    rejectionCount,
    pendingCount: assigned.size - decided.size
  };
}

function normalizeAuditRecordInput(input) {
  if (!isPlainObject(input)) fail('Governance audit record is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const eventId = normalizeUuid(input.eventId, 'audit event id');
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = input.versionId == null ? null : normalizeUuid(input.versionId, 'policy version id');
  const eventType = String(input.eventType || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,99}$/.test(eventType)) fail('Governance audit event type is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const actorIdentityKey = normalizeIdentityKey(input.actorIdentityKey, 'audit actor identity');
  const actorLogin = normalizeRequiredText(input.actorLogin, 'Audit actor login', 200);
  const previousHash = String(input.previousHash || '').trim();
  if (previousHash !== GOVERNANCE_AUDIT_GENESIS && !/^[0-9a-f]{64}$/.test(previousHash)) {
    fail('Governance audit previous hash is invalid', 'GOVERNANCE_AUDIT_INVALID');
  }
  const date = new Date(input.createdAt);
  if (!Number.isFinite(date.getTime())) fail('Governance audit timestamp is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const details = normalizeAuditDetails(input.details || {});
  return {
    eventId, policyId, versionId, eventType, actorIdentityKey, actorLogin,
    previousHash, details, createdAt: date.toISOString()
  };
}

function createGovernanceAuditRecord(secret, input) {
  if (Buffer.byteLength(String(secret || ''), 'utf8') < 32) {
    fail('Governance audit secret must contain at least 32 bytes', 'GOVERNANCE_AUDIT_SECRET_INVALID', 500);
  }
  const normalized = normalizeAuditRecordInput(input);
  const detailsHash = sha256(stableJson(normalized.details));
  const signed = {
    eventId: normalized.eventId,
    policyId: normalized.policyId,
    versionId: normalized.versionId,
    eventType: normalized.eventType,
    actorIdentityKey: normalized.actorIdentityKey,
    actorLogin: normalized.actorLogin,
    previousHash: normalized.previousHash,
    detailsHash,
    createdAt: normalized.createdAt
  };
  const recordHash = crypto.createHmac('sha256', String(secret)).update(stableJson(signed), 'utf8').digest('hex');
  return { ...normalized, detailsHash, recordHash };
}

function verifyGovernanceAuditChain(secret, records) {
  if (!Array.isArray(records)) fail('Governance audit records must be an array', 'GOVERNANCE_AUDIT_INVALID');
  let previousHash = GOVERNANCE_AUDIT_GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    let expected;
    try { expected = createGovernanceAuditRecord(secret, { ...record, previousHash }); }
    catch (error) {
      return { valid: false, checked: index + 1, failedAt: index + 1, code: error.code || 'GOVERNANCE_AUDIT_INVALID' };
    }
    if (record.previousHash !== previousHash || record.detailsHash !== expected.detailsHash || record.recordHash !== expected.recordHash) {
      return { valid: false, checked: index + 1, failedAt: index + 1, code: 'GOVERNANCE_AUDIT_CHAIN_INVALID' };
    }
    previousHash = record.recordHash;
  }
  return { valid: true, checked: records.length, head: previousHash };
}

module.exports = {
  GovernanceError,
  GOVERNANCE_AUDIT_GENESIS,
  POLICY_DOCUMENT_MAX_BYTES,
  normalizeIdentityKey,
  normalizeUuid,
  normalizePolicyScope,
  normalizePolicyKey,
  normalizePolicyDocument,
  normalizeApprovalPolicy,
  computeGovernanceReviewState,
  policyDocumentHash,
  normalizeAuditDetails,
  createGovernanceAuditRecord,
  verifyGovernanceAuditChain,
  stableJson
};
