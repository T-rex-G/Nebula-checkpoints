import { createHash } from 'node:crypto';
import { MUTATION_ACTIONS, isMutationAction } from '../../../../../../packages/contracts/src/mutation.ts';
import type { MutationActionName, MutationDescriptor, MutationRisk, PolicyEvaluator, PolicyOutcome } from '../../../../../../packages/contracts/src/mutation.ts';
import { isPolicyKey, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { evaluatePolicyDocument } from './governance-simulation.ts';
import type { MatchedRule } from './governance-simulation.ts';
import {
  normalizePolicyDocument,
  policyDocumentHash,
  normalizePolicyScope,
  normalizeUuid,
  normalizeIdentityKey,
  normalizePolicyKey
} from './governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import type { EnforcementMode, PolicyDocument, PolicyEffect } from './governance-model.ts';
import { deriveControlMapping, normalizeControlMapping, normalizeControlRefs, CONTROL_CATALOG } from './control-catalog.ts';
import type { ControlMapping } from './control-catalog.ts';
import { applyPolicyExceptions } from './governance-exceptions.ts';
import type { ExceptionApplication } from './governance-exceptions.ts';

type Fields = Readonly<Record<string, unknown>>;

const EFFECT_RANK: Readonly<Record<PolicyEffect, number>> = Object.freeze({ allow: 0, 'require-approval': 1, deny: 2 });
const MODE_RANK: Readonly<Record<EnforcementMode, number>> = Object.freeze({ observe: 0, warn: 1, block: 2 });
const MAX_DECISION_BYTES = 256 * 1024;
export const POLICY_DECISION_GENESIS = 'NV-POLICY-DECISION-GENESIS-V1';

/* Set only when the refusal carries details of its own, so it is typed here rather than declared as a field that would always exist. */
export interface GovernanceEnforcementError {
  readonly details?: unknown;
}

export class GovernanceEnforcementError extends Error {
  override readonly name = 'GovernanceEnforcementError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400, details: unknown = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) (this as { details?: unknown }).details = details;
  }
}

function fail(message: string, code = 'POLICY_DECISION_INVALID', status = 400, details: unknown = undefined): never {
  throw new GovernanceEnforcementError(message, code, status, details);
}

function isPlainObject(value: unknown): value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function hash(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!isSha256Hex(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function boundedText(value: unknown, label: string, max = 200): string {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} is invalid`);
  return text;
}

function isPolicyEffect(value: string): value is PolicyEffect {
  return Object.hasOwn(EFFECT_RANK, value);
}

function isPolicyOutcome(value: string): value is PolicyOutcome {
  return value === 'allow' || value === 'warn' || value === 'block';
}

function isEnforcementMode(value: string): value is EnforcementMode {
  return Object.hasOwn(MODE_RANK, value);
}

/* The list a field holds, or none when it holds something else. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeEnforcementMode(input: unknown): EnforcementMode {
  const mode = input == null || input === '' ? 'observe' : String(input).trim().toLowerCase();
  if (!isEnforcementMode(mode)) fail('Policy enforcement mode is invalid', 'GOVERNANCE_ENFORCEMENT_INVALID');
  return mode;
}

export function descriptorEvidenceHash(descriptor: unknown): string {
  if (!isPlainObject(descriptor)) fail('Mutation descriptor evidence is invalid', 'POLICY_DESCRIPTOR_INVALID', 500);
  return sha256({
    mutationId: descriptor.mutationId,
    scopeKey: descriptor.scopeKey,
    action: descriptor.action,
    category: descriptor.category,
    risk: descriptor.risk,
    actorIdentityKey: descriptor.actorIdentityKey,
    actorLogin: descriptor.actorLogin,
    method: descriptor.method,
    route: descriptor.route,
    metadata: descriptor.metadata || {},
    security: descriptor.security || {}
  });
}

interface ActivePolicy {
  readonly policyId: string;
  readonly policyKey: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly headRevision: number;
  readonly documentHash: string;
  readonly document: PolicyDocument;
  readonly enforcementMode: EnforcementMode;
}

function normalizeActivePolicy(input: unknown): ActivePolicy {
  if (!isPlainObject(input)) fail('Active policy is invalid', 'POLICY_ACTIVE_SET_INVALID', 500);
  const document = normalizePolicyDocument(input.document);
  const documentHash = policyDocumentHash(document);
  if (hash(input.documentHash, 'Active policy document hash') !== documentHash) {
    fail('Active policy failed its document integrity check', 'POLICY_ACTIVE_VERSION_INTEGRITY_FAILED', 500);
  }
  const versionNumber = Number(input.versionNumber);
  const headRevision = Number(input.headRevision);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 || !Number.isSafeInteger(headRevision) || headRevision < 1) {
    fail('Active policy version or head revision is invalid', 'POLICY_ACTIVE_SET_INVALID', 500);
  }
  return {
    policyId: normalizeUuid(input.policyId, 'active policy id'),
    policyKey: normalizePolicyKey(input.policyKey),
    versionId: normalizeUuid(input.versionId, 'active policy version id'),
    versionNumber,
    headRevision,
    documentHash,
    document,
    enforcementMode: normalizeEnforcementMode(document.enforcement && document.enforcement.mode)
  };
}

function effectiveEffectOf(effects: readonly PolicyEffect[]): PolicyEffect {
  return [...effects].sort((a, b) => EFFECT_RANK[b] - EFFECT_RANK[a] || a.localeCompare(b))[0] || 'allow';
}

/* One active policy's answer for the mutation, as a decision records it. */
export interface PolicyEvaluationEntry {
  readonly policyId: string;
  readonly policyKey: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly headRevision: number;
  readonly documentHash: string;
  readonly enforcementMode: EnforcementMode;
  readonly effect: PolicyEffect;
  readonly source: 'matched-rules' | 'default-allow';
  readonly conflict: boolean;
  readonly matchedRuleIds: readonly string[];
  readonly matchedRules: readonly MatchedRule[];
  readonly unsupportedRuleActions: readonly string[];
  readonly evaluationHash: string;
  /* Engine version 2 onwards: what the policy said before exceptions, and which exceptions lifted which rules. */
  readonly originalEffect?: PolicyEffect;
  readonly originalConflict?: boolean;
  readonly waivedRuleIds?: readonly string[];
  readonly exceptionApplications?: readonly ExceptionApplication[];
}

function policySetBodyOf(policyEvaluations: readonly PolicyEvaluationEntry[]): readonly Fields[] {
  return policyEvaluations.map(item => ({
    policyId: item.policyId,
    policyKey: item.policyKey,
    versionId: item.versionId,
    versionNumber: item.versionNumber,
    headRevision: item.headRevision,
    documentHash: item.documentHash,
    enforcementMode: item.enforcementMode
  }));
}

function appliedExceptionBodyOf(policyEvaluations: readonly PolicyEvaluationEntry[]): readonly Fields[] {
  return policyEvaluations.flatMap(item => (item.exceptionApplications || []).map(exception => ({
    policyId: item.policyId, versionId: item.versionId, documentHash: item.documentHash,
    exceptionId: exception.exceptionId, kind: exception.kind, subjectIdentityKey: exception.subjectIdentityKey,
    targetHash: exception.targetHash, ruleIds: exception.ruleIds,
    expiresAt: exception.expiresAt, approvedAt: exception.approvedAt,
    approvedByIdentityKey: exception.approvedByIdentityKey
  }))).sort((a, b) => a.policyId.localeCompare(b.policyId) || a.exceptionId.localeCompare(b.exceptionId));
}

interface EnforcementSemantics {
  readonly effectiveEffect: PolicyEffect;
  readonly rolloutMode: EnforcementMode;
  readonly enforcementOutcome: PolicyOutcome;
  readonly warningCodes: readonly string[];
  readonly blockCode: string | null;
}

function enforcementSemantics(policyEvaluations: readonly PolicyEvaluationEntry[], category: unknown): EnforcementSemantics {
  const effectiveEffect = effectiveEffectOf(policyEvaluations.map(item => item.effect));
  const relevant = policyEvaluations.filter(item => item.effect !== 'allow');
  const blocking = relevant.filter(item => item.enforcementMode === 'block');
  const warning = relevant.filter(item => item.enforcementMode === 'warn');
  const observed = relevant.filter(item => item.enforcementMode === 'observe');
  let enforcementOutcome: PolicyOutcome = 'allow';
  let blockCode: string | null = null;
  if (blocking.length) {
    enforcementOutcome = 'block';
    blockCode = blocking.some(item => item.effect === 'deny') ? 'POLICY_MUTATION_BLOCKED' : 'POLICY_APPROVAL_REQUIRED';
  } else if (warning.length) {
    enforcementOutcome = 'warn';
  }
  let rolloutMode: EnforcementMode = [...relevant].sort((a, b) => MODE_RANK[b.enforcementMode] - MODE_RANK[a.enforcementMode])[0]?.enforcementMode ?? 'observe';
  const warningCodes: string[] = [];
  const warningEvidence = [...warning];
  if (category === 'governance' && enforcementOutcome === 'block') {
    warningEvidence.push(...blocking);
    enforcementOutcome = 'warn';
    blockCode = null;
    rolloutMode = 'warn';
    warningCodes.push('POLICY_CONTROL_PLANE_NON_BLOCKING');
  }
  if (policyEvaluations.some(item => item.conflict)) warningCodes.push('POLICY_RULE_CONFLICT');
  if (policyEvaluations.some(item => item.unsupportedRuleActions.length)) warningCodes.push('POLICY_UNSUPPORTED_ACTIVE_RULES');
  if (policyEvaluations.some(item => item.exceptionApplications && item.exceptionApplications.length)) warningCodes.push('POLICY_EXCEPTION_APPLIED');
  if (warningEvidence.length) {
    warningCodes.push(effectiveEffectOf(warningEvidence.map(item => item.effect)) === 'deny'
      ? 'POLICY_DENY_WARNING'
      : 'POLICY_APPROVAL_WARNING');
  }
  if (observed.length) {
    warningCodes.push(effectiveEffectOf(observed.map(item => item.effect)) === 'deny'
      ? 'POLICY_DENY_OBSERVED'
      : 'POLICY_APPROVAL_OBSERVED');
  }
  return {
    effectiveEffect,
    rolloutMode,
    enforcementOutcome,
    warningCodes: [...new Set(warningCodes)].sort(),
    blockCode
  };
}

export interface ActivePolicySetInput {
  readonly scope?: unknown;
  readonly descriptor?: unknown;
  readonly activePolicies?: unknown;
  readonly activeExceptions?: unknown;
  readonly evaluatedAt?: unknown;
}

export function evaluateActivePolicySet(input: ActivePolicySetInput = {}): PolicyDecision {
  const scope = normalizePolicyScope(input.scope);
  const descriptor = input.descriptor;
  if (!isPlainObject(descriptor) || descriptor.scopeKey !== scope.scopeKey || !isMutationAction(descriptor.action)) {
    fail('Mutation descriptor does not match the policy evaluation scope', 'POLICY_DESCRIPTOR_INVALID', 500);
  }
  const action = descriptor.action;
  const evaluatedAt = new Date((input.evaluatedAt || Date.now()) as string | number | Date);
  if (!Number.isFinite(evaluatedAt.getTime())) fail('Policy evaluation timestamp is invalid', 'POLICY_DECISION_INVALID', 500);
  const activeExceptions = listOf(input.activeExceptions);
  const policies = listOf(input.activePolicies)
    .map(normalizeActivePolicy)
    .sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.policyId.localeCompare(b.policyId));
  const governanceActor = read(descriptor.authorization, 'governanceActor');
  const policyEvaluations: PolicyEvaluationEntry[] = policies.map(policy => {
    const evaluation = evaluatePolicyDocument(policy.document, {
      schemaVersion: 1,
      scenarios: [{ id: 'runtime-mutation', action, attributes: descriptor.metadata || {} }]
    });
    if (evaluation.unsupportedRuleActions.length) {
      fail(
        'Active policy set contains unsupported mutation actions',
        'POLICY_UNSUPPORTED_ACTIVE_RULES',
        500,
        { actions: evaluation.unsupportedRuleActions }
      );
    }
    /* One scenario went in, so one result comes out. */
    const result = evaluation.results[0];
    if (!result) throw new TypeError('Policy evaluation returned no result for the mutation');
    const base = {
      policyId: policy.policyId,
      policyKey: policy.policyKey,
      versionId: policy.versionId,
      versionNumber: policy.versionNumber,
      headRevision: policy.headRevision,
      documentHash: policy.documentHash,
      enforcementMode: policy.enforcementMode,
      effect: result.effect,
      source: result.source,
      conflict: result.conflict,
      matchedRuleIds: result.matchedRuleIds,
      matchedRules: result.matchedRules,
      unsupportedRuleActions: evaluation.unsupportedRuleActions,
      evaluationHash: evaluation.evaluationHash
    };
    const applied = applyPolicyExceptions(base, activeExceptions, action, evaluatedAt, {
      actorIdentityKey: governanceActor && read(governanceActor, 'verified')
        ? read(governanceActor, 'identityKey')
        : null,
      metadata: descriptor.metadata
    });
    const evidence = {
      documentHash: policy.documentHash,
      matchedRuleIds: applied.matchedRuleIds,
      matchedRules: applied.matchedRules,
      originalEffect: applied.originalEffect,
      originalConflict: applied.originalConflict,
      effect: applied.effect,
      conflict: applied.conflict,
      waivedRuleIds: applied.waivedRuleIds,
      exceptionApplications: applied.exceptionApplications,
      unsupportedRuleActions: applied.unsupportedRuleActions
    };
    return { ...applied, evaluationHash: sha256(evidence) };
  });

  const semantics = enforcementSemantics(policyEvaluations, descriptor.category);
  const policySetBody = policySetBodyOf(policyEvaluations);
  const controlMapping = deriveControlMapping({ action, policyEvaluations });
  const decision = {
    schemaVersion: 1,
    engineVersion: 2,
    mutationId: descriptor.mutationId,
    scope,
    action,
    category: descriptor.category,
    risk: descriptor.risk,
    actor: { identityKey: descriptor.actorIdentityKey, login: descriptor.actorLogin },
    descriptorHash: descriptorEvidenceHash(descriptor),
    source: policies.length ? 'active-policy-set' : 'no-active-policy',
    policySetHash: sha256(policySetBody),
    exceptionSetHash: sha256(appliedExceptionBodyOf(policyEvaluations)),
    activePolicyCount: policies.length,
    policyEvaluations,
    effectiveEffect: semantics.effectiveEffect,
    rolloutMode: semantics.rolloutMode,
    enforcementOutcome: semantics.enforcementOutcome,
    warningCodes: semantics.warningCodes,
    blockCode: semantics.blockCode,
    controlMapping,
    evaluatedAt: evaluatedAt.toISOString()
  };
  return normalizePolicyDecision(decision, descriptor);
}

function normalizeMatchedRule(input: unknown): MatchedRule {
  if (!isPlainObject(input)) fail('Matched policy rule is invalid');
  const id = String(input.id || '').trim().toLowerCase();
  const effect = String(input.effect || '').trim().toLowerCase();
  if (!isPolicyKey(id) || !isPolicyEffect(effect)) fail('Matched policy rule is invalid');
  let controlRefs: readonly string[];
  try { controlRefs = normalizeControlRefs(input.controlRefs || []); }
  catch { fail('Matched policy control references are invalid'); }
  return { id, effect, ...(controlRefs.length ? { controlRefs } : {}) };
}

function normalizeExceptionApplication(input: unknown, matchedRules: readonly MatchedRule[]): ExceptionApplication {
  if (!isPlainObject(input)) fail('Policy exception application is invalid');
  const kind = String(input.kind || '').trim().toLowerCase();
  if (kind !== 'exception' && kind !== 'waiver') fail('Policy exception kind is invalid');
  const ruleIds = [...new Set(lowerCaseList(input.ruleIds))].sort();
  if (!ruleIds.length || ruleIds.length > 50 || ruleIds.some(id => !isPolicyKey(id))) fail('Policy exception rule evidence is invalid');
  const expectedEffect = kind === 'exception' ? 'deny' : 'require-approval';
  const rules = new Map(matchedRules.map(rule => [rule.id, rule.effect]));
  if (ruleIds.some(id => rules.get(id) !== expectedEffect)) fail('Policy exception rule evidence is inconsistent');
  const approvedAt = new Date(input.approvedAt as string | number | Date);
  const expiresAt = new Date(input.expiresAt as string | number | Date);
  if (!Number.isFinite(approvedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || approvedAt >= expiresAt) fail('Policy exception time evidence is invalid');
  const targetHash = String(input.targetHash || '').trim().toLowerCase();
  if (!isSha256Hex(targetHash)) fail('Policy exception target hash is invalid');
  return {
    exceptionId: normalizeUuid(input.exceptionId, 'exception id'),
    kind,
    subjectIdentityKey: normalizeIdentityKey(input.subjectIdentityKey, 'exception subject identity'),
    targetHash,
    ruleIds,
    expiresAt: expiresAt.toISOString(),
    approvedAt: approvedAt.toISOString(),
    approvedByIdentityKey: normalizeIdentityKey(input.approvedByIdentityKey, 'exception approver identity'),
    approvedByLogin: boundedText(input.approvedByLogin, 'Exception approver login')
  };
}

function lowerCaseList(value: unknown): string[] {
  return listOf(value).map(item => String(item || '').trim().toLowerCase());
}

function normalizePolicyEvaluation(input: unknown, engineVersion = 1): PolicyEvaluationEntry {
  if (!isPlainObject(input)) fail('Policy evaluation entry is invalid');
  const mode = normalizeEnforcementMode(input.enforcementMode);
  const effect = String(input.effect || '').trim().toLowerCase();
  if (!isPolicyEffect(effect)) fail('Policy evaluation effect is invalid');
  const source = String(input.source || '').trim();
  if (source !== 'matched-rules' && source !== 'default-allow') fail('Policy evaluation source is invalid');
  const matchedRules = listOf(input.matchedRules).map(normalizeMatchedRule);
  const matchedRuleIds = lowerCaseList(input.matchedRuleIds);
  if (stableJson(matchedRuleIds) !== stableJson(matchedRules.map(item => item.id))) fail('Policy matched-rule evidence is inconsistent');
  const unsupportedRuleActions = [...new Set(lowerCaseList(input.unsupportedRuleActions))].sort();
  if (unsupportedRuleActions.some(value => !/^[a-z][a-z0-9._-]{1,99}$/.test(value))) fail('Unsupported policy actions are invalid');
  const expectedSource = matchedRules.length ? 'matched-rules' : 'default-allow';
  const originalEffect = engineVersion >= 2 ? String(input.originalEffect || '').trim().toLowerCase() : effect;
  const originalConflict = engineVersion >= 2 ? !!input.originalConflict : !!input.conflict;
  const exceptionApplications = engineVersion >= 2
    ? listOf(input.exceptionApplications).map(item => normalizeExceptionApplication(item, matchedRules))
    : [];
  const waivedRuleIds = engineVersion >= 2 ? [...new Set(lowerCaseList(input.waivedRuleIds))].sort() : [];
  const applicationRuleIds = [...new Set(exceptionApplications.flatMap(item => item.ruleIds))].sort();
  const matchedIds = new Set(matchedRuleIds);
  if (waivedRuleIds.some(id => !matchedIds.has(id)) || stableJson(waivedRuleIds) !== stableJson(applicationRuleIds)) {
    fail('Policy exception application evidence is inconsistent');
  }
  const remaining = matchedRules.filter(rule => !waivedRuleIds.includes(rule.id));
  const expectedOriginalEffect = effectiveEffectOf(matchedRules.map(rule => rule.effect));
  const expectedOriginalConflict = new Set(matchedRules.map(rule => rule.effect)).size > 1;
  const expectedEffect = effectiveEffectOf(remaining.map(rule => rule.effect));
  const expectedConflict = new Set(remaining.map(rule => rule.effect)).size > 1;
  if (source !== expectedSource || originalEffect !== expectedOriginalEffect || originalConflict !== expectedOriginalConflict ||
      effect !== expectedEffect || !!input.conflict !== expectedConflict) {
    fail('Policy evaluation rule evidence is inconsistent');
  }
  const versionNumber = Number(input.versionNumber);
  const headRevision = Number(input.headRevision);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 ||
      !Number.isSafeInteger(headRevision) || headRevision < 1) {
    fail('Policy evaluation version evidence is invalid');
  }
  const output: PolicyEvaluationEntry = {
    policyId: normalizeUuid(input.policyId, 'policy id'),
    policyKey: normalizePolicyKey(input.policyKey),
    versionId: normalizeUuid(input.versionId, 'policy version id'),
    versionNumber,
    headRevision,
    documentHash: hash(input.documentHash, 'Policy document hash'),
    enforcementMode: mode,
    effect,
    source,
    conflict: !!input.conflict,
    matchedRuleIds,
    matchedRules,
    unsupportedRuleActions,
    evaluationHash: hash(input.evaluationHash, 'Policy evaluation hash')
  };
  /* The original effect was just shown to equal the one its matched rules give, so it is an effect. */
  return engineVersion >= 2 ? { ...output, originalEffect: expectedOriginalEffect, originalConflict, waivedRuleIds, exceptionApplications } : output;
}

/* A verified policy decision: what the gateway acts on and the decision ledger records. */
export interface PolicyDecision {
  readonly schemaVersion: 1;
  readonly engineVersion: 1 | 2;
  readonly mutationId: string;
  readonly scope: RepositoryScope;
  readonly action: MutationActionName;
  readonly category: string;
  readonly risk: MutationRisk;
  readonly actor: { readonly identityKey: string; readonly login: string };
  readonly descriptorHash: string;
  readonly source: 'active-policy-set' | 'no-active-policy' | 'evaluation-unavailable';
  readonly policySetHash: string;
  readonly exceptionSetHash?: string | null;
  readonly activePolicyCount: number;
  readonly policyEvaluations: readonly PolicyEvaluationEntry[];
  readonly effectiveEffect: PolicyEffect;
  readonly rolloutMode: EnforcementMode;
  readonly enforcementOutcome: PolicyOutcome;
  readonly warningCodes: readonly string[];
  readonly blockCode: string | null;
  readonly controlMapping: ControlMapping;
  readonly evaluatedAt: string;
  readonly decisionId?: string;
  readonly previousHash?: string;
  readonly recordHash?: string;
}

const DECISION_FIELDS = new Set([
  'schemaVersion', 'engineVersion', 'mutationId', 'scope', 'action', 'category', 'risk', 'actor', 'descriptorHash', 'source',
  'policySetHash', 'exceptionSetHash', 'activePolicyCount', 'policyEvaluations', 'effectiveEffect', 'rolloutMode',
  'enforcementOutcome', 'warningCodes', 'blockCode', 'controlMapping', 'evaluatedAt',
  'decisionId', 'previousHash', 'recordHash'
]);
const BLOCK_CODES = [
  'POLICY_MUTATION_BLOCKED',
  'POLICY_APPROVAL_REQUIRED',
  'POLICY_EVALUATION_UNAVAILABLE',
  'POLICY_UNSUPPORTED_ACTIVE_RULES'
];

export function normalizePolicyDecision(input: unknown, descriptor: unknown = null): PolicyDecision {
  if (!isPlainObject(input)) fail('Policy decision must be an object');
  for (const key of Object.keys(input)) if (!DECISION_FIELDS.has(key)) fail(`Unsupported policy decision field: ${key}`);
  const engineVersion = Number(input.engineVersion);
  if (Number(input.schemaVersion) !== 1 || (engineVersion !== 1 && engineVersion !== 2)) fail('Policy decision schema is unsupported');
  const scope = normalizePolicyScope(input.scope);
  const mutationId = normalizeUuid(input.mutationId, 'mutation id');
  const action = String(input.action || '').trim().toLowerCase();
  if (!isMutationAction(action)) fail('Policy decision action evidence is invalid');
  const definition = MUTATION_ACTIONS[action];
  if (input.category !== definition.category || input.risk !== definition.risk) fail('Policy decision action evidence is invalid');
  const actor = input.actor;
  if (!isPlainObject(actor)) fail('Policy decision actor is invalid');
  const normalizedActor = { identityKey: normalizeIdentityKey(actor.identityKey, 'policy decision actor'), login: boundedText(actor.login, 'Policy decision actor login') };
  const source = String(input.source || '').trim();
  if (source !== 'active-policy-set' && source !== 'no-active-policy' && source !== 'evaluation-unavailable') fail('Policy decision source is invalid');
  const evaluations = listOf(input.policyEvaluations).map(item => normalizePolicyEvaluation(item, engineVersion));
  const activePolicyCount = Number(input.activePolicyCount);
  if (!Number.isSafeInteger(activePolicyCount) || activePolicyCount < 0 || activePolicyCount > 100 || activePolicyCount !== evaluations.length) {
    fail('Policy decision active-policy count is invalid');
  }
  const effectiveEffect = String(input.effectiveEffect || '').trim();
  const rolloutMode = normalizeEnforcementMode(input.rolloutMode);
  const enforcementOutcome = String(input.enforcementOutcome || '').trim();
  if (!isPolicyEffect(effectiveEffect) || !isPolicyOutcome(enforcementOutcome)) fail('Policy enforcement outcome is invalid');
  const warningCodes = [...new Set(listOf(input.warningCodes).map(value => String(value || '').trim()))].sort();
  if (warningCodes.length > 32 || warningCodes.some(value => !/^[A-Z][A-Z0-9_]{2,79}$/.test(value))) fail('Policy warning codes are invalid');
  const blockCode = input.blockCode == null ? null : String(input.blockCode).trim();
  if ((enforcementOutcome === 'block') !== !!blockCode || (blockCode && !BLOCK_CODES.includes(blockCode))) {
    fail('Policy block code is invalid');
  }
  const evaluatedAt = new Date(input.evaluatedAt as string | number | Date);
  if (!Number.isFinite(evaluatedAt.getTime())) fail('Policy decision timestamp is invalid');
  const normalizedControlMapping = normalizeControlMapping(input.controlMapping);
  const normalizedPolicySetHash = hash(input.policySetHash, 'Policy set hash');
  const normalizedExceptionSetHash = engineVersion >= 2 ? hash(input.exceptionSetHash, 'Exception set hash') : null;
  if (source === 'evaluation-unavailable') {
    const expectedControlPlane = definition.category === 'governance';
    const unsupportedActiveRules = warningCodes.includes('POLICY_UNSUPPORTED_ACTIVE_RULES');
    const expectedOutcome = !expectedControlPlane && (input.rolloutMode === 'block' || unsupportedActiveRules)
      ? 'block'
      : 'warn';
    const expectedWarnings = [
      'POLICY_EVALUATION_UNAVAILABLE',
      ...(unsupportedActiveRules ? ['POLICY_UNSUPPORTED_ACTIVE_RULES'] : []),
      ...(expectedControlPlane ? ['POLICY_CONTROL_PLANE_NON_BLOCKING'] : [])
    ].sort();
    const expectedBlockCode = expectedOutcome === 'block'
      ? (unsupportedActiveRules ? 'POLICY_UNSUPPORTED_ACTIVE_RULES' : 'POLICY_EVALUATION_UNAVAILABLE')
      : null;
    const expectedUnmappedReasons = [
      'POLICY_EVALUATION_UNAVAILABLE',
      ...(unsupportedActiveRules ? ['POLICY_UNSUPPORTED_ACTIVE_RULES'] : [])
    ].sort();
    if (evaluations.length !== 0 || activePolicyCount !== 0 || normalizedPolicySetHash !== sha256([]) ||
        effectiveEffect !== 'allow' || enforcementOutcome !== expectedOutcome || rolloutMode !== expectedOutcome ||
        blockCode !== expectedBlockCode || stableJson(warningCodes) !== stableJson(expectedWarnings) ||
        normalizedControlMapping.status !== 'unavailable' ||
        stableJson(normalizedControlMapping.unmappedReasons) !== stableJson(expectedUnmappedReasons) ||
        (engineVersion >= 2 && normalizedExceptionSetHash !== sha256([]))) {
      fail('Unavailable policy decision evidence is inconsistent');
    }
  } else {
    if ((source === 'active-policy-set') !== (evaluations.length > 0)) fail('Policy decision source is inconsistent');
    const expectedPolicySetHash = sha256(policySetBodyOf(evaluations));
    const expected = enforcementSemantics(evaluations, definition.category);
    const expectedExceptionSetHash = engineVersion >= 2 ? sha256(appliedExceptionBodyOf(evaluations)) : null;
    const expectedMapping = deriveControlMapping({ action, policyEvaluations: evaluations, catalogVersion: normalizedControlMapping.catalog.version });
    if (normalizedPolicySetHash !== expectedPolicySetHash || effectiveEffect !== expected.effectiveEffect ||
        rolloutMode !== expected.rolloutMode || enforcementOutcome !== expected.enforcementOutcome ||
        blockCode !== expected.blockCode || stableJson(warningCodes) !== stableJson(expected.warningCodes) ||
        stableJson(normalizedControlMapping) !== stableJson(expectedMapping) ||
        (engineVersion >= 2 && normalizedExceptionSetHash !== expectedExceptionSetHash)) {
      fail('Policy decision evidence is inconsistent');
    }
  }
  const output: PolicyDecision = {
    schemaVersion: 1,
    engineVersion,
    mutationId,
    scope,
    action,
    category: definition.category,
    risk: definition.risk,
    actor: normalizedActor,
    descriptorHash: hash(input.descriptorHash, 'Mutation descriptor hash'),
    source,
    policySetHash: normalizedPolicySetHash,
    ...(engineVersion >= 2 ? { exceptionSetHash: normalizedExceptionSetHash } : {}),
    activePolicyCount,
    policyEvaluations: evaluations,
    effectiveEffect,
    rolloutMode,
    enforcementOutcome,
    warningCodes,
    blockCode,
    controlMapping: normalizedControlMapping,
    evaluatedAt: evaluatedAt.toISOString()
  };
  let recorded = output;
  if (input.decisionId != null || input.previousHash != null || input.recordHash != null) {
    const decisionId = normalizeUuid(input.decisionId, 'policy decision id');
    const previousHash = String(input.previousHash || '').trim();
    if (previousHash !== POLICY_DECISION_GENESIS && !isSha256Hex(previousHash)) fail('Policy decision previous hash is invalid');
    recorded = { ...output, decisionId, previousHash, recordHash: hash(input.recordHash, 'Policy decision record hash') };
  }
  if (descriptor) {
    const actorLogin = read(descriptor, 'actorLogin');
    if (mutationId !== read(descriptor, 'mutationId') || scope.scopeKey !== read(descriptor, 'scopeKey') || action !== read(descriptor, 'action') ||
        recorded.descriptorHash !== descriptorEvidenceHash(descriptor) ||
        normalizedActor.identityKey !== read(descriptor, 'actorIdentityKey') ||
        typeof actorLogin !== 'string' || normalizedActor.login.toLowerCase() !== actorLogin.toLowerCase()) {
      fail('Policy decision does not match the active mutation', 'MUTATION_POLICY_DECISION_MISMATCH', 500);
    }
  }
  if (Buffer.byteLength(stableJson(recorded), 'utf8') > MAX_DECISION_BYTES) fail('Policy decision is too large', 'POLICY_DECISION_TOO_LARGE', 500);
  return deepFreeze(recorded);
}

function unavailableControlMapping(reasons: readonly string[] = ['POLICY_EVALUATION_UNAVAILABLE']): ControlMapping {
  const body = {
    schemaVersion: 1,
    status: 'unavailable',
    catalog: {
      id: CONTROL_CATALOG.id,
      version: CONTROL_CATALOG.version,
      frameworkRevision: CONTROL_CATALOG.frameworkRevision,
      hash: CONTROL_CATALOG.hash
    },
    controls: [],
    unmappedReasons: [...new Set(reasons)].sort()
  };
  return normalizeControlMapping({ ...body, mappingHash: sha256(body) });
}

type ScopedDescriptor = Pick<MutationDescriptor, 'provider' | 'authority' | 'owner' | 'repo' | 'scopeKey'>;

function descriptorPolicyScope(descriptor: ScopedDescriptor): Fields {
  return {
    provider: descriptor.provider,
    baseUrl: `https://${descriptor.authority}`,
    owner: descriptor.owner,
    repo: descriptor.repo,
    scopeKey: descriptor.scopeKey
  };
}

function unavailableDecision(descriptor: MutationDescriptor, failureMode: string, now: () => Date | number | string, failureCode: unknown = 'POLICY_EVALUATION_FAILED'): PolicyDecision {
  const controlPlaneRecovery = descriptor.category === 'governance';
  const unsupportedActiveRules = failureCode === 'POLICY_UNSUPPORTED_ACTIVE_RULES';
  const block = !controlPlaneRecovery && (failureMode === 'block' || unsupportedActiveRules);
  const warningCodes = ['POLICY_EVALUATION_UNAVAILABLE'];
  if (unsupportedActiveRules) warningCodes.push('POLICY_UNSUPPORTED_ACTIVE_RULES');
  if (controlPlaneRecovery) warningCodes.push('POLICY_CONTROL_PLANE_NON_BLOCKING');
  const body = {
    schemaVersion: 1,
    engineVersion: 2,
    mutationId: descriptor.mutationId,
    scope: descriptorPolicyScope(descriptor),
    action: descriptor.action,
    category: descriptor.category,
    risk: descriptor.risk,
    actor: { identityKey: descriptor.actorIdentityKey, login: descriptor.actorLogin },
    descriptorHash: descriptorEvidenceHash(descriptor),
    source: 'evaluation-unavailable',
    policySetHash: sha256([]),
    exceptionSetHash: sha256([]),
    activePolicyCount: 0,
    policyEvaluations: [],
    effectiveEffect: 'allow',
    rolloutMode: block ? 'block' : 'warn',
    enforcementOutcome: block ? 'block' : 'warn',
    warningCodes,
    blockCode: block
      ? (unsupportedActiveRules ? 'POLICY_UNSUPPORTED_ACTIVE_RULES' : 'POLICY_EVALUATION_UNAVAILABLE')
      : null,
    controlMapping: unavailableControlMapping([
      'POLICY_EVALUATION_UNAVAILABLE',
      ...(unsupportedActiveRules ? ['POLICY_UNSUPPORTED_ACTIVE_RULES'] : [])
    ]),
    evaluatedAt: new Date(now()).toISOString()
  };
  return normalizePolicyDecision(body, descriptor);
}

/* The decision store the runtime writes through: it evaluates and records in one step. */
export interface DecisionStore {
  evaluateAndAppendPolicyDecision(input: { readonly scope: Fields; readonly descriptor: MutationDescriptor }): Promise<unknown>;
}

export interface GovernanceRuntimeOptions {
  readonly store?: DecisionStore | null;
  readonly failureMode?: string;
  readonly now?: () => Date | number | string;
  readonly onError?: (event: Readonly<{ code: string; action: string; scopeKey: string }>) => void;
}

export interface GovernanceRuntime extends PolicyEvaluator {
  verify(decision: unknown, descriptor?: unknown): PolicyDecision;
  evaluate(descriptor: MutationDescriptor): Promise<PolicyDecision>;
}

export function createGovernanceRuntime({ store, failureMode = 'warn', now = () => new Date(), onError = () => {} }: GovernanceRuntimeOptions = {}): GovernanceRuntime {
  if (!store || typeof store.evaluateAndAppendPolicyDecision !== 'function') throw new TypeError('Governance runtime requires a decision store');
  const decisions = store;
  const mode = String(failureMode || '').trim().toLowerCase();
  if (!['warn', 'block'].includes(mode)) throw new TypeError('Governance runtime failure mode must be warn or block');
  /* The mutation gateway's policy port: the decision for a descriptor, and the verification of any decision against one. */
  return Object.freeze({
    verify: normalizePolicyDecision,
    async evaluate(descriptor: MutationDescriptor): Promise<PolicyDecision> {
      try {
        const decision = await decisions.evaluateAndAppendPolicyDecision({
          scope: descriptorPolicyScope(descriptor),
          descriptor
        });
        return normalizePolicyDecision(decision, descriptor);
      } catch (error) {
        const code = read(error, 'code');
        try {
          onError(Object.freeze({
            code: String(error && code || 'POLICY_EVALUATION_FAILED').slice(0, 100),
            action: descriptor.action,
            scopeKey: descriptor.scopeKey
          }));
        } catch { /* a failing observer does not change the decision */ }
        return unavailableDecision(descriptor, mode, now, error && code);
      }
    }
  });
}

export interface StepEvaluatorInput {
  readonly scope?: unknown;
  readonly activePolicies?: unknown;
  readonly activeExceptions?: unknown;
  readonly evaluatedAt?: unknown;
}

/*
 * The step evaluator Safe Passage is handed: each step of a proposed route
 * judged by the active policy set that refused the original, through the same
 * evaluation, recording nothing. The platform asks; governance answers.
 */
export function activePolicySetStepEvaluator({ scope, activePolicies, activeExceptions, evaluatedAt }: StepEvaluatorInput = {}): (descriptor: MutationDescriptor) => PolicyDecision {
  return descriptor => evaluateActivePolicySet({ scope, descriptor, activePolicies, activeExceptions, evaluatedAt });
}
