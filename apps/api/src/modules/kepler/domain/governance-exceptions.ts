import { createHash } from 'node:crypto';
import {
  GovernanceError,
  normalizeUuid,
  normalizeIdentityKey,
  normalizePolicyDocument,
  policyDocumentHash
} from './governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import type { PolicyEffect } from './governance-model.ts';
/* The catalogue and the metadata guard are the mutation contract's; the gateway is not imported here, so policy and the gateway that consults it share no cycle. */
import { isMutationAction, normalizeMutationMetadata } from '../../../../../../packages/contracts/src/mutation.ts';
import type { MutationActionName } from '../../../../../../packages/contracts/src/mutation.ts';
import { isPolicyKey, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { JsonObject } from '../../../../../../packages/contracts/src/guards.ts';

type Fields = Readonly<Record<string, unknown>>;

/* Which rule effect each kind of exception lifts. */
export const EXCEPTION_KINDS = Object.freeze({ exception: 'deny', waiver: 'require-approval' } as const);
export type ExceptionKind = keyof typeof EXCEPTION_KINDS;
export const MIN_DURATION_MS = 5 * 60 * 1000;
export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RULE_IDS = 50;
export const MAX_TARGET_BYTES = 2 * 1024;
const FORBIDDEN_TARGET_KEY_RX = /^(?:content|filecontent|sourcecode|patch|diff|payload|body|raw)$/i;
const SENSITIVE_TEXT_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:bearer|token|password|secret)\s*[:=]\s*[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;
const EFFECT_RANK: Readonly<Record<PolicyEffect, number>> = Object.freeze({ allow: 0, 'require-approval': 1, deny: 2 });

function fail(message: string, code: string, status = 400, details: unknown = undefined): never {
  throw new GovernanceError(message, code, status, details);
}

function isPlainObject(value: unknown): value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isExceptionKind(value: string): value is ExceptionKind {
  return Object.hasOwn(EXCEPTION_KINDS, value);
}

function requiredText(value: unknown, label: string, max = 4000): string {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail(`${label} is invalid`, 'GOVERNANCE_EXCEPTION_INPUT_INVALID');
  }
  if (SENSITIVE_TEXT_RX.test(text)) fail(`${label} contains sensitive material`, 'GOVERNANCE_SENSITIVE_TEXT');
  return text;
}


function targetSensitiveValue(value: unknown): boolean {
  if (typeof value === 'string') return SENSITIVE_TEXT_RX.test(value);
  if (Array.isArray(value)) return value.some(targetSensitiveValue);
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, item]) =>
      FORBIDDEN_TARGET_KEY_RX.test(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) || targetSensitiveValue(item));
  }
  return false;
}

function targetHashOf(action: string, target: unknown): string {
  return createHash('sha256').update(stableJson({ action, metadata: target }), 'utf8').digest('hex');
}

export interface ExceptionTarget {
  readonly target: Readonly<JsonObject>;
  readonly targetHash: string;
}

export function normalizeExceptionTarget(input: unknown, action: string): ExceptionTarget {
  let target: Readonly<JsonObject>;
  try { target = normalizeMutationMetadata(input); }
  catch (error) {
    fail('Exception target metadata is invalid', 'GOVERNANCE_EXCEPTION_TARGET_INVALID', error && (error as { readonly status?: unknown }).status === 413 ? 413 : 400);
  }
  if (Object.keys(target).length < 1) {
    fail('Exception target metadata must identify a concrete mutation target', 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
  }
  if (Buffer.byteLength(stableJson(target), 'utf8') > MAX_TARGET_BYTES) {
    fail('Exception target metadata exceeds 2 KiB', 'GOVERNANCE_EXCEPTION_TARGET_INVALID', 413);
  }
  if (targetSensitiveValue(target)) {
    fail('Exception target metadata contains raw content or sensitive material', 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
  }
  return Object.freeze({ target, targetHash: targetHashOf(action, target) });
}

function normalizeRuleIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RULE_IDS) {
    fail(`Exception ruleIds must contain 1 to ${MAX_RULE_IDS} entries`, 'GOVERNANCE_EXCEPTION_RULES_INVALID');
  }
  const ruleIds = [...new Set((input as readonly unknown[]).map(value => String(value || '').trim().toLowerCase()))].sort();
  if (ruleIds.length !== input.length || ruleIds.some(id => !isPolicyKey(id))) {
    fail('Exception ruleIds are invalid or duplicated', 'GOVERNANCE_EXCEPTION_RULES_INVALID');
  }
  return ruleIds;
}

function dateOf(value: unknown, label: string): Date {
  const date = new Date(value as string | number | Date);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid`, 'GOVERNANCE_EXCEPTION_EXPIRY_INVALID');
  return date;
}

export interface ExceptionRequest {
  readonly kind: ExceptionKind;
  readonly action: MutationActionName;
  readonly ruleIds: readonly string[];
  readonly target: Readonly<JsonObject>;
  readonly targetHash: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly documentHash: string;
}

export function normalizeExceptionRequest(input: unknown, documentInput: unknown, nowInput: unknown = new Date()): ExceptionRequest {
  if (!isPlainObject(input)) fail('Exception request must be a JSON object', 'GOVERNANCE_EXCEPTION_INPUT_INVALID');
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!isExceptionKind(kind)) {
    fail('Exception kind must be exception or waiver', 'GOVERNANCE_EXCEPTION_KIND_INVALID');
  }
  const action = String(input.action || '').trim().toLowerCase();
  if (!isMutationAction(action)) fail('Exception action is unknown', 'GOVERNANCE_EXCEPTION_ACTION_INVALID');
  const ruleIds = normalizeRuleIds(input.ruleIds);
  if (!Object.hasOwn(input, 'target') || !isPlainObject(input.target)) {
    fail('Exception target metadata is required', 'GOVERNANCE_EXCEPTION_TARGET_INVALID');
  }
  const { target, targetHash } = normalizeExceptionTarget(input.target, action);
  const reason = requiredText(input.reason, 'Exception reason');
  const now = dateOf(nowInput, 'Exception server time');
  const expiresAt = dateOf(input.expiresAt, 'Exception expiry');
  const duration = expiresAt.getTime() - now.getTime();
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    fail('Exception expiry must be between 5 minutes and 30 days', 'GOVERNANCE_EXCEPTION_EXPIRY_INVALID');
  }
  const document = normalizePolicyDocument(documentInput);
  const rulesById = new Map(document.rules.map(rule => [rule.id, rule]));
  const expectedEffect = EXCEPTION_KINDS[kind];
  for (const id of ruleIds) {
    const rule = rulesById.get(id);
    if (!rule) fail(`Exception target rule ${id} does not exist`, 'GOVERNANCE_EXCEPTION_RULE_INVALID', 409);
    if (rule.action !== action) fail(`Exception target rule ${id} does not match the action`, 'GOVERNANCE_EXCEPTION_RULE_ACTION_MISMATCH', 409);
    if (rule.effect !== expectedEffect) {
      fail(`Exception target rule ${id} does not match the selected kind`, 'GOVERNANCE_EXCEPTION_RULE_EFFECT_MISMATCH', 409);
    }
  }
  return Object.freeze({ kind, action, ruleIds: Object.freeze(ruleIds), target, targetHash, reason, expiresAt: expiresAt.toISOString(), documentHash: policyDocumentHash(document) });
}

type ExceptionEventType = 'approve' | 'reject' | 'revoke';

function normalizeEventType(value: unknown): ExceptionEventType {
  const eventType = String(value || '').trim().toLowerCase();
  if (eventType !== 'approve' && eventType !== 'reject' && eventType !== 'revoke') fail('Exception event type is invalid', 'GOVERNANCE_EXCEPTION_STATE_INVALID', 500);
  return eventType;
}

export interface ExceptionState {
  readonly status: 'rejected' | 'revoked' | 'superseded' | 'expired' | 'approved' | 'pending';
  readonly active: boolean;
  readonly terminal: boolean;
}

export function computeExceptionState(input: unknown = {}): ExceptionState {
  const fields = input as Fields;
  const request = (fields.request || {}) as Fields;
  const expiresAt = dateOf(request.expiresAt, 'Exception expiry');
  const versionId = normalizeUuid(request.versionId, 'exception version id');
  const headRevision = Number(request.headRevision);
  const activeHeadRevision = Number(fields.activeHeadRevision);
  if (!Number.isSafeInteger(headRevision) || headRevision < 0 || !Number.isSafeInteger(activeHeadRevision) || activeHeadRevision < 0) {
    fail('Exception head revision is invalid', 'GOVERNANCE_EXCEPTION_STATE_INVALID', 500);
  }
  const activeVersionId = fields.activeVersionId == null ? null : normalizeUuid(fields.activeVersionId, 'active version id');
  const now = dateOf(fields.now == null ? new Date() : fields.now, 'Exception state time');
  /* The store's mapped events; one that is not an object fails here as it always did. */
  const events = Array.isArray(fields.events) ? (fields.events as readonly Fields[]).map(event => ({ ...event, eventType: normalizeEventType(event.eventType) })) : [];
  const decisions = events.filter(event => event.eventType === 'approve' || event.eventType === 'reject');
  const revocations = events.filter(event => event.eventType === 'revoke');
  if (decisions.length > 1 || revocations.length > 1 || (revocations.length && !decisions.some(event => event.eventType === 'approve'))) {
    fail('Exception event history is inconsistent', 'GOVERNANCE_EXCEPTION_STATE_INVALID', 500);
  }
  const decision = decisions[0];
  if (decision && decision.eventType === 'reject') return Object.freeze({ status: 'rejected', active: false, terminal: true });
  if (revocations.length) return Object.freeze({ status: 'revoked', active: false, terminal: true });
  if (activeVersionId !== versionId || activeHeadRevision !== headRevision) return Object.freeze({ status: 'superseded', active: false, terminal: true });
  if (expiresAt.getTime() <= now.getTime()) return Object.freeze({ status: 'expired', active: false, terminal: true });
  if (decision && decision.eventType === 'approve') return Object.freeze({ status: 'approved', active: true, terminal: false });
  return Object.freeze({ status: 'pending', active: false, terminal: false });
}

/* A rule the policy evaluation matched, as the evaluation reports it. */
export interface EvaluatedRule {
  readonly id: string;
  readonly effect: PolicyEffect;
}

function effectOf(rules: readonly EvaluatedRule[]): PolicyEffect {
  return [...rules].map(rule => rule.effect).sort((a, b) => EFFECT_RANK[b] - EFFECT_RANK[a] || a.localeCompare(b))[0] || 'allow';
}

export interface ActiveException {
  readonly exceptionId: string;
  readonly policyId: string;
  readonly versionId: string;
  readonly documentHash: string;
  readonly subjectIdentityKey: string;
  readonly target: Readonly<JsonObject>;
  readonly targetHash: string;
  readonly kind: ExceptionKind;
  readonly action: string;
  readonly ruleIds: readonly string[];
  readonly expiresAt: string;
  readonly approvedAt: string;
  readonly approvedByIdentityKey: string;
  readonly approvedByLogin: string;
}

export function normalizeActiveException(input: unknown, action: string, evaluatedAt: unknown): ActiveException | null {
  if (!isPlainObject(input)) fail('Active exception evidence is invalid', 'POLICY_EXCEPTION_INVALID', 500);
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!isExceptionKind(kind)) fail('Active exception kind is invalid', 'POLICY_EXCEPTION_INVALID', 500);
  const normalizedAction = String(input.action || '').trim().toLowerCase();
  if (normalizedAction !== action) fail('Active exception action is inconsistent', 'POLICY_EXCEPTION_INVALID', 500);
  const expiresAt = dateOf(input.expiresAt, 'Active exception expiry');
  const approvedAt = dateOf(input.approvedAt, 'Active exception approval time');
  const evaluationTime = dateOf(evaluatedAt, 'Policy evaluation time');
  if (expiresAt.getTime() <= evaluationTime.getTime() || approvedAt.getTime() > evaluationTime.getTime() || approvedAt.getTime() >= expiresAt.getTime()) return null;
  const documentHash = String(input.documentHash || '').trim().toLowerCase();
  if (!isSha256Hex(documentHash)) fail('Active exception document hash is invalid', 'POLICY_EXCEPTION_INVALID', 500);
  let subjectIdentityKey: string;
  try { subjectIdentityKey = normalizeIdentityKey(input.subjectIdentityKey, 'exception subject identity'); }
  catch { fail('Active exception subject identity is invalid', 'POLICY_EXCEPTION_INVALID', 500); }
  if (!Object.hasOwn(input, 'target') || !isPlainObject(input.target)) {
    fail('Active exception target metadata is invalid', 'POLICY_EXCEPTION_INVALID', 500);
  }
  const { target, targetHash } = normalizeExceptionTarget(input.target, normalizedAction);
  const suppliedTargetHash = String(input.targetHash || '').trim().toLowerCase();
  if (!isSha256Hex(suppliedTargetHash) || suppliedTargetHash !== targetHash) {
    fail('Active exception target hash is invalid', 'POLICY_EXCEPTION_INVALID', 500);
  }
  return Object.freeze({
    exceptionId: normalizeUuid(input.exceptionId, 'exception id'),
    policyId: normalizeUuid(input.policyId, 'exception policy id'),
    versionId: normalizeUuid(input.versionId, 'exception version id'),
    documentHash,
    subjectIdentityKey,
    target,
    targetHash,
    kind,
    action: normalizedAction,
    ruleIds: Object.freeze(normalizeRuleIds(input.ruleIds)),
    expiresAt: expiresAt.toISOString(),
    approvedAt: approvedAt.toISOString(),
    approvedByIdentityKey: normalizeIdentityKey(input.approvedByIdentityKey, 'exception approver identity'),
    approvedByLogin: requiredText(input.approvedByLogin, 'Exception approver login', 200)
  });
}

export interface ExceptionApplication {
  readonly exceptionId: string;
  readonly kind: ExceptionKind;
  readonly subjectIdentityKey: string;
  readonly targetHash: string;
  readonly ruleIds: readonly string[];
  readonly expiresAt: string;
  readonly approvedAt: string;
  readonly approvedByIdentityKey: string;
  readonly approvedByLogin: string;
}

/* What applying exceptions adds to an evaluation: the effect that remains once the applicable exceptions lift their rules. */
export interface ExceptionFields {
  readonly originalEffect: PolicyEffect;
  readonly originalConflict: boolean;
  readonly effect: PolicyEffect;
  readonly conflict: boolean;
  readonly waivedRuleIds: readonly string[];
  readonly exceptionApplications: readonly ExceptionApplication[];
}

/* The evaluation it was given, with those fields in place of its own. */
export type ExceptionOutcome<E extends Fields = Fields> = Readonly<Omit<E, keyof ExceptionFields>> & ExceptionFields;

export interface ExceptionContext {
  readonly actorIdentityKey?: unknown;
  readonly metadata?: unknown;
}

export function applyPolicyExceptions<E extends Fields>(policyEvaluation: E, exceptionsInput: unknown, action: string, evaluatedAt: unknown, context: ExceptionContext = {}): ExceptionOutcome<E> {
  if (!isPlainObject(policyEvaluation)) fail('Policy evaluation is invalid for exception application', 'POLICY_EXCEPTION_INVALID', 500);
  let actorIdentityKey: string | null = null;
  if (context.actorIdentityKey != null) {
    try { actorIdentityKey = normalizeIdentityKey(context.actorIdentityKey, 'mutation actor identity'); }
    catch { fail('Mutation actor identity is invalid for exception application', 'POLICY_EXCEPTION_INVALID', 500); }
  }
  const rawExceptions: readonly unknown[] = Array.isArray(exceptionsInput) ? exceptionsInput : [];
  let mutationTargetHash: string | null = null;
  if (actorIdentityKey && rawExceptions.length) {
    let runtimeTarget: Readonly<JsonObject>;
    try { runtimeTarget = normalizeMutationMetadata(context.metadata); }
    catch { fail('Mutation target metadata is invalid for exception application', 'POLICY_EXCEPTION_INVALID', 500); }
    mutationTargetHash = targetHashOf(action, runtimeTarget);
  }
  /* The evaluation is the policy engine's own answer, whose matched rules carry the id and effect it decided by. */
  const matchedRules = Array.isArray(policyEvaluation.matchedRules) ? policyEvaluation.matchedRules as readonly EvaluatedRule[] : [];
  const originalEffect = effectOf(matchedRules);
  const originalConflict = new Set(matchedRules.map(rule => rule.effect)).size > 1;
  const matchedById = new Map(matchedRules.map(rule => [rule.id, rule]));
  const applicable: ExceptionApplication[] = [];
  for (const raw of rawExceptions) {
    const exception = normalizeActiveException(raw, action, evaluatedAt);
    if (!exception) continue;
    if (!actorIdentityKey || exception.subjectIdentityKey !== actorIdentityKey || exception.targetHash !== mutationTargetHash) continue;
    if (exception.policyId !== policyEvaluation.policyId || exception.versionId !== policyEvaluation.versionId || exception.documentHash !== policyEvaluation.documentHash) continue;
    const expectedEffect = EXCEPTION_KINDS[exception.kind];
    const covered = exception.ruleIds.filter(id => matchedById.get(id)?.effect === expectedEffect);
    if (!covered.length) continue;
    applicable.push(Object.freeze({
      exceptionId: exception.exceptionId,
      kind: exception.kind,
      subjectIdentityKey: exception.subjectIdentityKey,
      targetHash: exception.targetHash,
      ruleIds: Object.freeze(covered.sort()),
      expiresAt: exception.expiresAt,
      approvedAt: exception.approvedAt,
      approvedByIdentityKey: exception.approvedByIdentityKey,
      approvedByLogin: exception.approvedByLogin
    }));
  }
  applicable.sort((a, b) => a.exceptionId.localeCompare(b.exceptionId));
  const waivedRuleIds = [...new Set(applicable.flatMap(item => item.ruleIds))].sort();
  const waived = new Set(waivedRuleIds);
  const remainingRules = matchedRules.filter(rule => !waived.has(rule.id));
  return Object.freeze({
    ...policyEvaluation,
    originalEffect,
    originalConflict,
    effect: effectOf(remainingRules),
    conflict: new Set(remainingRules.map(rule => rule.effect)).size > 1,
    waivedRuleIds: Object.freeze(waivedRuleIds),
    exceptionApplications: Object.freeze(applicable)
  });
}
