'use strict';

const crypto = require('crypto');
const { MUTATION_ACTIONS } = require('./mutation-gateway');
const { evaluatePolicyDocument } = require('./governance-simulation');
const {
  normalizePolicyDocument,
  policyDocumentHash,
  normalizePolicyScope,
  normalizeUuid,
  normalizeIdentityKey,
  normalizePolicyKey,
  stableJson
} = require('./governance-model');
const { deriveControlMapping, normalizeControlMapping, normalizeControlRefs, CONTROL_CATALOG } = require('./control-catalog');
const { applyPolicyExceptions } = require('./governance-exceptions');

const EFFECT_RANK = Object.freeze({ allow: 0, 'require-approval': 1, deny: 2 });
const MODE_RANK = Object.freeze({ observe: 0, warn: 1, block: 2 });
const MAX_DECISION_BYTES = 256 * 1024;
const POLICY_DECISION_GENESIS = 'NV-POLICY-DECISION-GENESIS-V1';

class GovernanceEnforcementError extends Error {
  constructor(message, code, status = 400, details) {
    super(message);
    this.name = 'GovernanceEnforcementError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code = 'POLICY_DECISION_INVALID', status = 400, details) {
  throw new GovernanceEnforcementError(message, code, status, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function boundedText(value, label, max = 200) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} is invalid`);
  return text;
}

function normalizeEnforcementMode(input) {
  const mode = input == null || input === '' ? 'observe' : String(input).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MODE_RANK, mode)) fail('Policy enforcement mode is invalid', 'GOVERNANCE_ENFORCEMENT_INVALID');
  return mode;
}

function descriptorEvidenceHash(descriptor) {
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

function normalizeActivePolicy(input) {
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

function effectiveEffectOf(effects) {
  return [...effects].sort((a, b) => EFFECT_RANK[b] - EFFECT_RANK[a] || a.localeCompare(b))[0] || 'allow';
}

function policySetBodyOf(policyEvaluations) {
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

function appliedExceptionBodyOf(policyEvaluations) {
  return policyEvaluations.flatMap(item => (item.exceptionApplications || []).map(exception => ({
    policyId: item.policyId, versionId: item.versionId, documentHash: item.documentHash,
    exceptionId: exception.exceptionId, kind: exception.kind, subjectIdentityKey: exception.subjectIdentityKey,
    targetHash: exception.targetHash, ruleIds: exception.ruleIds,
    expiresAt: exception.expiresAt, approvedAt: exception.approvedAt,
    approvedByIdentityKey: exception.approvedByIdentityKey
  }))).sort((a, b) => a.policyId.localeCompare(b.policyId) || a.exceptionId.localeCompare(b.exceptionId));
}

function enforcementSemantics(policyEvaluations, category) {
  const effectiveEffect = effectiveEffectOf(policyEvaluations.map(item => item.effect));
  const relevant = policyEvaluations.filter(item => item.effect !== 'allow');
  const blocking = relevant.filter(item => item.enforcementMode === 'block');
  const warning = relevant.filter(item => item.enforcementMode === 'warn');
  const observed = relevant.filter(item => item.enforcementMode === 'observe');
  let enforcementOutcome = 'allow';
  let blockCode = null;
  if (blocking.length) {
    enforcementOutcome = 'block';
    blockCode = blocking.some(item => item.effect === 'deny') ? 'POLICY_MUTATION_BLOCKED' : 'POLICY_APPROVAL_REQUIRED';
  } else if (warning.length) {
    enforcementOutcome = 'warn';
  }
  let rolloutMode = relevant.length
    ? [...relevant].sort((a, b) => MODE_RANK[b.enforcementMode] - MODE_RANK[a.enforcementMode])[0].enforcementMode
    : 'observe';
  const warningCodes = [];
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

function evaluateActivePolicySet(input = {}) {
  const scope = normalizePolicyScope(input.scope);
  const descriptor = input.descriptor;
  if (!isPlainObject(descriptor) || descriptor.scopeKey !== scope.scopeKey || !MUTATION_ACTIONS[descriptor.action]) {
    fail('Mutation descriptor does not match the policy evaluation scope', 'POLICY_DESCRIPTOR_INVALID', 500);
  }
  const evaluatedAt = new Date(input.evaluatedAt || Date.now());
  if (!Number.isFinite(evaluatedAt.getTime())) fail('Policy evaluation timestamp is invalid', 'POLICY_DECISION_INVALID', 500);
  const activeExceptions = Array.isArray(input.activeExceptions) ? input.activeExceptions : [];
  const policies = (Array.isArray(input.activePolicies) ? input.activePolicies : [])
    .map(normalizeActivePolicy)
    .sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.policyId.localeCompare(b.policyId));
  const policyEvaluations = policies.map(policy => {
    const evaluation = evaluatePolicyDocument(policy.document, {
      schemaVersion: 1,
      scenarios: [{ id: 'runtime-mutation', action: descriptor.action, attributes: descriptor.metadata || {} }]
    });
    if (evaluation.unsupportedRuleActions.length) {
      fail(
        'Active policy set contains unsupported mutation actions',
        'POLICY_UNSUPPORTED_ACTIVE_RULES',
        500,
        { actions: evaluation.unsupportedRuleActions }
      );
    }
    const result = evaluation.results[0];
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
    const applied = applyPolicyExceptions(base, activeExceptions, descriptor.action, evaluatedAt, {
      actorIdentityKey: descriptor.authorization && descriptor.authorization.governanceActor && descriptor.authorization.governanceActor.verified
        ? descriptor.authorization.governanceActor.identityKey
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
  const controlMapping = deriveControlMapping({ action: descriptor.action, policyEvaluations });
  const decision = {
    schemaVersion: 1,
    engineVersion: 2,
    mutationId: descriptor.mutationId,
    scope,
    action: descriptor.action,
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

function normalizeMatchedRule(input) {
  if (!isPlainObject(input)) fail('Matched policy rule is invalid');
  const id = String(input.id || '').trim().toLowerCase();
  const effect = String(input.effect || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(id) || !Object.prototype.hasOwnProperty.call(EFFECT_RANK, effect)) fail('Matched policy rule is invalid');
  let controlRefs;
  try { controlRefs = normalizeControlRefs(input.controlRefs || []); }
  catch { fail('Matched policy control references are invalid'); }
  return { id, effect, ...(controlRefs.length ? { controlRefs } : {}) };
}

function normalizeExceptionApplication(input, matchedRules) {
  if (!isPlainObject(input)) fail('Policy exception application is invalid');
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!['exception', 'waiver'].includes(kind)) fail('Policy exception kind is invalid');
  const ruleIds = Array.isArray(input.ruleIds) ? [...new Set(input.ruleIds.map(value => String(value || '').trim().toLowerCase()))].sort() : [];
  if (!ruleIds.length || ruleIds.length > 50 || ruleIds.some(id => !/^[a-z][a-z0-9._-]{1,63}$/.test(id))) fail('Policy exception rule evidence is invalid');
  const expectedEffect = kind === 'exception' ? 'deny' : 'require-approval';
  const rules = new Map(matchedRules.map(rule => [rule.id, rule.effect]));
  if (ruleIds.some(id => rules.get(id) !== expectedEffect)) fail('Policy exception rule evidence is inconsistent');
  const approvedAt = new Date(input.approvedAt);
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(approvedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || approvedAt >= expiresAt) fail('Policy exception time evidence is invalid');
  const targetHash = String(input.targetHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(targetHash)) fail('Policy exception target hash is invalid');
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

function normalizePolicyEvaluation(input, engineVersion = 1) {
  if (!isPlainObject(input)) fail('Policy evaluation entry is invalid');
  const mode = normalizeEnforcementMode(input.enforcementMode);
  const effect = String(input.effect || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(EFFECT_RANK, effect)) fail('Policy evaluation effect is invalid');
  const source = String(input.source || '').trim();
  if (!['matched-rules', 'default-allow'].includes(source)) fail('Policy evaluation source is invalid');
  const matchedRules = Array.isArray(input.matchedRules) ? input.matchedRules.map(normalizeMatchedRule) : [];
  const matchedRuleIds = Array.isArray(input.matchedRuleIds) ? input.matchedRuleIds.map(value => String(value || '').trim().toLowerCase()) : [];
  if (stableJson(matchedRuleIds) !== stableJson(matchedRules.map(item => item.id))) fail('Policy matched-rule evidence is inconsistent');
  const unsupportedRuleActions = Array.isArray(input.unsupportedRuleActions)
    ? [...new Set(input.unsupportedRuleActions.map(value => String(value || '').trim().toLowerCase()))].sort()
    : [];
  if (unsupportedRuleActions.some(value => !/^[a-z][a-z0-9._-]{1,99}$/.test(value))) fail('Unsupported policy actions are invalid');
  const expectedSource = matchedRules.length ? 'matched-rules' : 'default-allow';
  const originalEffect = engineVersion >= 2 ? String(input.originalEffect || '').trim().toLowerCase() : effect;
  const originalConflict = engineVersion >= 2 ? !!input.originalConflict : !!input.conflict;
  const exceptionApplications = engineVersion >= 2
    ? (Array.isArray(input.exceptionApplications) ? input.exceptionApplications.map(item => normalizeExceptionApplication(item, matchedRules)) : [])
    : [];
  const waivedRuleIds = engineVersion >= 2
    ? (Array.isArray(input.waivedRuleIds) ? [...new Set(input.waivedRuleIds.map(value => String(value || '').trim().toLowerCase()))].sort() : [])
    : [];
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
  const output = {
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
  if (engineVersion >= 2) Object.assign(output, { originalEffect, originalConflict, waivedRuleIds, exceptionApplications });
  return output;
}

function normalizePolicyDecision(input, descriptor = null) {
  if (!isPlainObject(input)) fail('Policy decision must be an object');
  const allowed = new Set([
    'schemaVersion', 'engineVersion', 'mutationId', 'scope', 'action', 'category', 'risk', 'actor', 'descriptorHash', 'source',
    'policySetHash', 'exceptionSetHash', 'activePolicyCount', 'policyEvaluations', 'effectiveEffect', 'rolloutMode',
    'enforcementOutcome', 'warningCodes', 'blockCode', 'controlMapping', 'evaluatedAt',
    'decisionId', 'previousHash', 'recordHash'
  ]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unsupported policy decision field: ${key}`);
  const engineVersion = Number(input.engineVersion);
  if (Number(input.schemaVersion) !== 1 || ![1, 2].includes(engineVersion)) fail('Policy decision schema is unsupported');
  const scope = normalizePolicyScope(input.scope);
  const mutationId = normalizeUuid(input.mutationId, 'mutation id');
  const action = String(input.action || '').trim().toLowerCase();
  const definition = MUTATION_ACTIONS[action];
  if (!definition || input.category !== definition.category || input.risk !== definition.risk) fail('Policy decision action evidence is invalid');
  const actor = input.actor;
  if (!isPlainObject(actor)) fail('Policy decision actor is invalid');
  const normalizedActor = { identityKey: normalizeIdentityKey(actor.identityKey, 'policy decision actor'), login: boundedText(actor.login, 'Policy decision actor login') };
  const source = String(input.source || '').trim();
  if (!['active-policy-set', 'no-active-policy', 'evaluation-unavailable'].includes(source)) fail('Policy decision source is invalid');
  const evaluations = Array.isArray(input.policyEvaluations) ? input.policyEvaluations.map(item => normalizePolicyEvaluation(item, engineVersion)) : [];
  const activePolicyCount = Number(input.activePolicyCount);
  if (!Number.isSafeInteger(activePolicyCount) || activePolicyCount < 0 || activePolicyCount > 100 || activePolicyCount !== evaluations.length) {
    fail('Policy decision active-policy count is invalid');
  }
  const effectiveEffect = String(input.effectiveEffect || '').trim();
  const rolloutMode = normalizeEnforcementMode(input.rolloutMode);
  const enforcementOutcome = String(input.enforcementOutcome || '').trim();
  if (!Object.prototype.hasOwnProperty.call(EFFECT_RANK, effectiveEffect) || !['allow', 'warn', 'block'].includes(enforcementOutcome)) fail('Policy enforcement outcome is invalid');
  const warningCodes = Array.isArray(input.warningCodes) ? [...new Set(input.warningCodes.map(value => String(value || '').trim()))].sort() : [];
  if (warningCodes.length > 32 || warningCodes.some(value => !/^[A-Z][A-Z0-9_]{2,79}$/.test(value))) fail('Policy warning codes are invalid');
  const blockCode = input.blockCode == null ? null : String(input.blockCode).trim();
  if ((enforcementOutcome === 'block') !== !!blockCode || (blockCode && !['POLICY_MUTATION_BLOCKED', 'POLICY_APPROVAL_REQUIRED', 'POLICY_EVALUATION_UNAVAILABLE'].includes(blockCode))) {
    fail('Policy block code is invalid');
  }
  const evaluatedAt = new Date(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAt.getTime())) fail('Policy decision timestamp is invalid');
  const normalizedControlMapping = normalizeControlMapping(input.controlMapping);
  const normalizedPolicySetHash = hash(input.policySetHash, 'Policy set hash');
  const normalizedExceptionSetHash = engineVersion >= 2 ? hash(input.exceptionSetHash, 'Exception set hash') : null;
  if (source === 'evaluation-unavailable') {
    const expectedControlPlane = definition.category === 'governance';
    const expectedOutcome = input.rolloutMode === 'block' && !expectedControlPlane ? 'block' : 'warn';
    const expectedWarnings = ['POLICY_EVALUATION_UNAVAILABLE', ...(expectedControlPlane ? ['POLICY_CONTROL_PLANE_NON_BLOCKING'] : [])].sort();
    const expectedBlockCode = expectedOutcome === 'block' ? 'POLICY_EVALUATION_UNAVAILABLE' : null;
    if (evaluations.length !== 0 || activePolicyCount !== 0 || normalizedPolicySetHash !== sha256([]) ||
        effectiveEffect !== 'allow' || enforcementOutcome !== expectedOutcome || rolloutMode !== expectedOutcome ||
        blockCode !== expectedBlockCode || stableJson(warningCodes) !== stableJson(expectedWarnings) ||
        normalizedControlMapping.status !== 'unavailable' || (engineVersion >= 2 && normalizedExceptionSetHash !== sha256([]))) {
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
  const output = {
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
  if (input.decisionId != null || input.previousHash != null || input.recordHash != null) {
    output.decisionId = normalizeUuid(input.decisionId, 'policy decision id');
    const previousHash = String(input.previousHash || '').trim();
    if (previousHash !== POLICY_DECISION_GENESIS && !/^[0-9a-f]{64}$/.test(previousHash)) fail('Policy decision previous hash is invalid');
    output.previousHash = previousHash;
    output.recordHash = hash(input.recordHash, 'Policy decision record hash');
  }
  if (descriptor) {
    if (mutationId !== descriptor.mutationId || scope.scopeKey !== descriptor.scopeKey || action !== descriptor.action ||
        output.descriptorHash !== descriptorEvidenceHash(descriptor) ||
        normalizedActor.identityKey !== descriptor.actorIdentityKey || normalizedActor.login.toLowerCase() !== descriptor.actorLogin.toLowerCase()) {
      fail('Policy decision does not match the active mutation', 'MUTATION_POLICY_DECISION_MISMATCH', 500);
    }
  }
  if (Buffer.byteLength(stableJson(output), 'utf8') > MAX_DECISION_BYTES) fail('Policy decision is too large', 'POLICY_DECISION_TOO_LARGE', 500);
  return deepFreeze(output);
}

function unavailableControlMapping() {
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
    unmappedReasons: ['POLICY_EVALUATION_UNAVAILABLE']
  };
  return normalizeControlMapping({ ...body, mappingHash: sha256(body) });
}

function descriptorPolicyScope(descriptor) {
  return {
    provider: descriptor.provider,
    baseUrl: `https://${descriptor.authority}`,
    owner: descriptor.owner,
    repo: descriptor.repo,
    scopeKey: descriptor.scopeKey
  };
}

function unavailableDecision(descriptor, failureMode, now) {
  const controlPlaneRecovery = descriptor.category === 'governance';
  const block = failureMode === 'block' && !controlPlaneRecovery;
  const warningCodes = ['POLICY_EVALUATION_UNAVAILABLE'];
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
    blockCode: block ? 'POLICY_EVALUATION_UNAVAILABLE' : null,
    controlMapping: unavailableControlMapping(),
    evaluatedAt: new Date(now()).toISOString()
  };
  return normalizePolicyDecision(body, descriptor);
}

function createGovernanceRuntime({ store, failureMode = 'warn', now = () => new Date(), onError = () => {} } = {}) {
  if (!store || typeof store.evaluateAndAppendPolicyDecision !== 'function') throw new TypeError('Governance runtime requires a decision store');
  const mode = String(failureMode || '').trim().toLowerCase();
  if (!['warn', 'block'].includes(mode)) throw new TypeError('Governance runtime failure mode must be warn or block');
  return Object.freeze({
    async evaluate(descriptor) {
      try {
        const decision = await store.evaluateAndAppendPolicyDecision({
          scope: descriptorPolicyScope(descriptor),
          descriptor
        });
        return normalizePolicyDecision(decision, descriptor);
      } catch (error) {
        try {
          onError(Object.freeze({
            code: String(error && error.code || 'POLICY_EVALUATION_FAILED').slice(0, 100),
            action: descriptor.action,
            scopeKey: descriptor.scopeKey
          }));
        } catch {}
        return unavailableDecision(descriptor, mode, now);
      }
    }
  });
}

module.exports = Object.freeze({
  GovernanceEnforcementError,
  POLICY_DECISION_GENESIS,
  normalizeEnforcementMode,
  descriptorEvidenceHash,
  evaluateActivePolicySet,
  normalizePolicyDecision,
  createGovernanceRuntime
});
