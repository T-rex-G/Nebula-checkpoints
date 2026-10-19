import { createHash, createHmac } from 'node:crypto';
import { normalizeControlRefs, ControlMappingError } from './control-catalog.ts';
import { IDENTITY_KEY, POLICY_KEY, RECORD_ID, isPolicyKey, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import * as scopeContract from '../../../../../../packages/contracts/src/scope.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';

export const GOVERNANCE_AUDIT_GENESIS = 'NEBULAVERSE-GOVERNANCE-GENESIS-V1';
export const POLICY_DOCUMENT_MAX_BYTES = 256 * 1024;
const AUDIT_DETAILS_MAX_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_ARRAY_ITEMS = 1000;
const MAX_OBJECT_KEYS = 250;
const MAX_RULES = 500;
const EFFECTS = new Set(['allow', 'deny', 'require-approval']);
const SENSITIVE_KEY_RX = /^(?:access_?token|refresh_?token|token|client_?secret|secret|password|private_?key|authorization|authorization_?header|cookie|cookie_?value|session_?cookie)$/i;
const SENSITIVE_SUFFIX_RX = /(?:_token|_secret|_password|_private_key)$/i;
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/* Set only when the refusal carries details of its own, so it is typed here rather than declared as a field that would always exist. */
export interface GovernanceError {
  readonly details?: unknown;
}

export class GovernanceError extends Error {
  override readonly name = 'GovernanceError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400, details: unknown = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) (this as { details?: unknown }).details = details;
  }
}

function fail(message: string, code: string, status = 400, details?: unknown): never {
  throw new GovernanceError(message, code, status, details);
}

type Fields = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}


function sha256(value: unknown): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeRequiredText(value: unknown, label: string, max = 200): string {
  return scopeContract.normalizeRequiredText(value, label, max, fail);
}

function normalizeOptionalText(value: unknown, label: string, max = 2000): string {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

export function normalizeIdentityKey(value: unknown, label = 'identity key'): string {
  const text = String(value || '').trim().toLowerCase();
  if (!IDENTITY_KEY.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_IDENTITY_INVALID');
  return text;
}

export function normalizeUuid(value: unknown, label = 'identifier'): string {
  const text = String(value || '').trim().toLowerCase();
  if (!RECORD_ID.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_ID_INVALID');
  }
  return text;
}

/* The repository a policy is about (packages/contracts/src/scope.ts), refused as a GovernanceError. */
export function normalizePolicyScope(input: unknown): RepositoryScope {
  return scopeContract.normalizePolicyScope(input, fail);
}

export function normalizePolicyKey(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  if (!POLICY_KEY.test(key)) {
    fail('Policy key must be a stable lower-case identifier', 'GOVERNANCE_POLICY_KEY_INVALID');
  }
  return key;
}

function sensitiveKey(key: string): boolean {
  const compact = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_RX.test(key) || SENSITIVE_SUFFIX_RX.test(key) ||
    /(?:token|secret|password|privatekey)$/.test(compact) ||
    ['authorization', 'authorizationheader', 'cookie', 'cookievalue', 'sessioncookie'].includes(compact);
}

function cloneBoundedJson(value: unknown, options: { readonly maxBytes?: number } = {}, path = '$', depth = 0): unknown {
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
    return (value as readonly unknown[]).map((entry, index) => cloneBoundedJson(entry, options, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) return fail(`${path} contains a non-JSON value`, 'GOVERNANCE_DOCUMENT_INVALID');
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) fail(`${path} contains too many fields`, 'GOVERNANCE_DOCUMENT_INVALID');
  const out: Record<string, unknown> = {};
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

function enforceEncodedSize<T>(value: T, maxBytes: number, code: string): T {
  const bytes = Buffer.byteLength(stableJson(value), 'utf8');
  if (bytes > maxBytes) fail('Governance JSON exceeds the configured limit', code, 413, { bytes, maxBytes });
  return value;
}

export type PolicyEffect = 'allow' | 'deny' | 'require-approval';
export type EnforcementMode = 'observe' | 'warn' | 'block';

/* One rule of a policy: what it applies to, what it decides, and why. */
export interface PolicyRule {
  readonly id: string;
  readonly action: string;
  readonly effect: PolicyEffect;
  readonly controlRefs?: string[];
  readonly conditions?: Readonly<Record<string, unknown>>;
  readonly description?: string;
}

/* A policy document as normalized: what a version stores and its hash names. */
export interface PolicyDocument {
  readonly schemaVersion: 1;
  readonly description?: string;
  readonly enforcement?: { readonly mode: EnforcementMode };
  readonly rules: readonly PolicyRule[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function normalizePolicyDocument(input: unknown): PolicyDocument {
  if (!isPlainObject(input)) return fail('Policy document must be a JSON object', 'GOVERNANCE_DOCUMENT_INVALID');
  let initial: string | undefined;
  try { initial = JSON.stringify(input); } catch { fail('Policy document must be valid JSON', 'GOVERNANCE_DOCUMENT_INVALID'); }
  if (Buffer.byteLength(initial || '', 'utf8') > POLICY_DOCUMENT_MAX_BYTES) {
    fail('Policy document exceeds 256 KiB', 'GOVERNANCE_DOCUMENT_TOO_LARGE', 413);
  }
  const schemaVersion = Number(input.schemaVersion);
  if (schemaVersion !== 1) fail('Only governance policy schema version 1 is supported', 'GOVERNANCE_SCHEMA_UNSUPPORTED');
  const rawRules = input.rules;
  if (!Array.isArray(rawRules)) return fail('Policy rules must be an array', 'GOVERNANCE_DOCUMENT_INVALID');
  if (rawRules.length > MAX_RULES) fail('Policy contains too many rules', 'GOVERNANCE_DOCUMENT_INVALID');
  const ids = new Set<string>();
  const rules = (rawRules as readonly unknown[]).map((raw, index): PolicyRule => {
    if (!isPlainObject(raw)) return fail(`Policy rule ${index + 1} must be an object`, 'GOVERNANCE_DOCUMENT_INVALID');
    const id = String(raw.id || '').trim().toLowerCase();
    if (!isPolicyKey(id)) fail(`Policy rule ${index + 1} has an invalid id`, 'GOVERNANCE_DOCUMENT_INVALID');
    if (ids.has(id)) fail(`Policy rule id ${id} is duplicated`, 'GOVERNANCE_RULE_DUPLICATE');
    ids.add(id);
    const action = String(raw.action || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,99}$/.test(action)) fail(`Policy rule ${id} has an invalid action`, 'GOVERNANCE_DOCUMENT_INVALID');
    const effect = String(raw.effect || '').trim().toLowerCase();
    if (!EFFECTS.has(effect)) fail(`Policy rule ${id} has an invalid effect`, 'GOVERNANCE_DOCUMENT_INVALID');
    const rule: { -readonly [K in keyof PolicyRule]: PolicyRule[K] } = { id, action, effect: effect as PolicyEffect };
    if (raw.controlRefs !== undefined) {
      try { rule.controlRefs = [...normalizeControlRefs(raw.controlRefs)]; }
      catch (error) {
        if (error instanceof ControlMappingError) fail(error.message, error.code, error.status);
        throw error;
      }
    }
    if (raw.conditions !== undefined) {
      if (!isPlainObject(raw.conditions)) fail(`Policy rule ${id} conditions must be an object`, 'GOVERNANCE_DOCUMENT_INVALID');
      rule.conditions = cloneBoundedJson(raw.conditions, { maxBytes: POLICY_DOCUMENT_MAX_BYTES }, `$.rules[${index}].conditions`, 1) as Readonly<Record<string, unknown>>;
    }
    if (raw.description !== undefined) rule.description = normalizeOptionalText(raw.description, `Policy rule ${id} description`, 1000);
    return rule;
  });
  /* Built field by field in the order the stored documents have always had: schemaVersion, description, enforcement, rules, metadata. */
  const document: Record<string, unknown> = { schemaVersion: 1 };
  if (input.description !== undefined) document.description = normalizeOptionalText(input.description, 'Policy description', 4000);
  if (input.enforcement !== undefined) {
    const enforcement = input.enforcement;
    if (!isPlainObject(enforcement)) return fail('Policy enforcement must be an object', 'GOVERNANCE_ENFORCEMENT_INVALID');
    const mode = String(enforcement.mode || '').trim().toLowerCase();
    if (!['observe', 'warn', 'block'].includes(mode) || Object.keys(enforcement).some(key => key !== 'mode')) {
      fail('Policy enforcement mode must be observe, warn or block', 'GOVERNANCE_ENFORCEMENT_INVALID');
    }
    document.enforcement = { mode: mode as EnforcementMode };
  }
  document.rules = rules;
  if (input.metadata !== undefined) {
    if (!isPlainObject(input.metadata)) fail('Policy metadata must be an object', 'GOVERNANCE_DOCUMENT_INVALID');
    document.metadata = cloneBoundedJson(input.metadata, { maxBytes: POLICY_DOCUMENT_MAX_BYTES }, '$.metadata', 1) as Readonly<Record<string, unknown>>;
  }
  return enforceEncodedSize(document as unknown as PolicyDocument, POLICY_DOCUMENT_MAX_BYTES, 'GOVERNANCE_DOCUMENT_TOO_LARGE');
}

export interface ApprovalPolicy {
  readonly requiredApprovals: number;
  readonly disallowAuthorApproval: boolean;
}

export function normalizeApprovalPolicy(input: unknown = {}): ApprovalPolicy {
  const policy = input == null ? {} : input;
  if (!isPlainObject(policy)) return fail('Approval policy is invalid', 'GOVERNANCE_APPROVAL_POLICY_INVALID');
  const requiredApprovals = policy.requiredApprovals == null ? 1 : Number(policy.requiredApprovals);
  const disallowAuthorApproval = policy.disallowAuthorApproval == null ? true : policy.disallowAuthorApproval;
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 5 || typeof disallowAuthorApproval !== 'boolean') {
    fail('Approval policy must require between one and five approvals', 'GOVERNANCE_APPROVAL_POLICY_INVALID');
  }
  return { requiredApprovals, disallowAuthorApproval };
}

export function policyDocumentHash(document: unknown): string {
  return sha256(stableJson(normalizePolicyDocument(document)));
}

export function normalizeAuditDetails(input: unknown = {}): Readonly<Record<string, unknown>> {
  if (!isPlainObject(input)) return fail('Governance audit details must be an object', 'GOVERNANCE_AUDIT_INVALID');
  let initial: string | undefined;
  try { initial = JSON.stringify(input); } catch { fail('Governance audit details must be valid JSON', 'GOVERNANCE_AUDIT_INVALID'); }
  if (Buffer.byteLength(initial || '', 'utf8') > AUDIT_DETAILS_MAX_BYTES) {
    fail('Governance audit details exceed 64 KiB', 'GOVERNANCE_AUDIT_TOO_LARGE', 413);
  }
  return enforceEncodedSize(
    cloneBoundedJson(input, { maxBytes: AUDIT_DETAILS_MAX_BYTES }, '$', 0) as Readonly<Record<string, unknown>>,
    AUDIT_DETAILS_MAX_BYTES,
    'GOVERNANCE_AUDIT_TOO_LARGE'
  );
}

/* Where a version's review stands: its quorum, and whether anyone refused it. */
export interface GovernanceReviewState {
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly terminal: boolean;
  readonly quorumReached: boolean;
  readonly assignedCount: number;
  readonly approvalCount: number;
  readonly rejectionCount: number;
  readonly pendingCount: number;
}

export function computeGovernanceReviewState(input: unknown = {}): GovernanceReviewState {
  if (!isPlainObject(input)) return fail('Governance review state is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  const requiredApprovals = Number(input.requiredApprovals);
  if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 5) {
    fail('Governance review quorum is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  }
  const assignments = input.assignments;
  const decisions = input.decisions;
  if (!Array.isArray(assignments) || !Array.isArray(decisions)) {
    return fail('Governance review records are invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
  }
  const assigned = new Set<string>();
  for (const assignment of assignments as readonly unknown[]) {
    if (!isPlainObject(assignment)) return fail('Governance review assignment is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    const identityKey = normalizeIdentityKey(assignment.reviewerIdentityKey || assignment.reviewer_identity_key, 'reviewer identity');
    if (assigned.has(identityKey)) fail('Governance review assignment is duplicated', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
    assigned.add(identityKey);
  }
  const decided = new Set<string>();
  let approvalCount = 0;
  let rejectionCount = 0;
  for (const record of decisions as readonly unknown[]) {
    if (!isPlainObject(record)) return fail('Governance review decision is invalid', 'GOVERNANCE_REVIEW_STATE_INVALID', 500);
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

/* One entry of the governance audit chain, before it is signed. */
export interface AuditRecordInput {
  readonly eventId: string;
  readonly policyId: string;
  readonly versionId: string | null;
  readonly eventType: string;
  readonly actorIdentityKey: string;
  readonly actorLogin: string;
  readonly previousHash: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AuditRecord extends AuditRecordInput {
  readonly detailsHash: string;
  readonly recordHash: string;
}

function normalizeAuditRecordInput(input: unknown): AuditRecordInput {
  if (!isPlainObject(input)) return fail('Governance audit record is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const eventId = normalizeUuid(input.eventId, 'audit event id');
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = input.versionId == null ? null : normalizeUuid(input.versionId, 'policy version id');
  const eventType = String(input.eventType || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,99}$/.test(eventType)) fail('Governance audit event type is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const actorIdentityKey = normalizeIdentityKey(input.actorIdentityKey, 'audit actor identity');
  const actorLogin = normalizeRequiredText(input.actorLogin, 'Audit actor login', 200);
  const previousHash = String(input.previousHash || '').trim();
  if (previousHash !== GOVERNANCE_AUDIT_GENESIS && !isSha256Hex(previousHash)) {
    fail('Governance audit previous hash is invalid', 'GOVERNANCE_AUDIT_INVALID');
  }
  const date = new Date(input.createdAt as string | number | Date);
  if (!Number.isFinite(date.getTime())) fail('Governance audit timestamp is invalid', 'GOVERNANCE_AUDIT_INVALID');
  const details = normalizeAuditDetails(input.details || {});
  return {
    eventId, policyId, versionId, eventType, actorIdentityKey, actorLogin,
    previousHash, details, createdAt: date.toISOString()
  };
}

export function createGovernanceAuditRecord(secret: unknown, input: unknown): AuditRecord {
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
  const recordHash = createHmac('sha256', String(secret)).update(stableJson(signed), 'utf8').digest('hex');
  return { ...normalized, detailsHash, recordHash };
}

export type AuditChainVerdict =
  | { readonly valid: true; readonly checked: number; readonly head: string }
  | { readonly valid: false; readonly checked: number; readonly failedAt: number; readonly code: unknown };

export function verifyGovernanceAuditChain(secret: unknown, records: unknown): AuditChainVerdict {
  if (!Array.isArray(records)) return fail('Governance audit records must be an array', 'GOVERNANCE_AUDIT_INVALID');
  let previousHash: unknown = GOVERNANCE_AUDIT_GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as Fields;
    let expected: AuditRecord;
    try { expected = createGovernanceAuditRecord(secret, { ...record, previousHash }); }
    catch (error) {
      return { valid: false, checked: index + 1, failedAt: index + 1, code: (error as { readonly code?: unknown }).code || 'GOVERNANCE_AUDIT_INVALID' };
    }
    if (record.previousHash !== previousHash || record.detailsHash !== expected.detailsHash || record.recordHash !== expected.recordHash) {
      return { valid: false, checked: index + 1, failedAt: index + 1, code: 'GOVERNANCE_AUDIT_CHAIN_INVALID' };
    }
    previousHash = record.recordHash;
  }
  return { valid: true, checked: records.length, head: previousHash as string };
}
