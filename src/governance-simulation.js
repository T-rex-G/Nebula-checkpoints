'use strict';

const crypto = require('crypto');
const { MUTATION_ACTIONS } = require('./mutation-gateway');
const {
  normalizePolicyDocument,
  policyDocumentHash,
  normalizeUuid,
  normalizePolicyScope,
  stableJson
} = require('./governance-model');

const MAX_SCENARIOS = 200;
const MAX_ATTRIBUTES_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_KEYS = 120;
const MAX_ARRAY = 250;
const MAX_STRING = 2048;
const EFFECT_RANK = Object.freeze({ allow: 0, 'require-approval': 1, deny: 2 });
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_SCENARIO_KEYS = new Set([
  'provider', 'authority', 'owner', 'repo', 'scope', 'scopekey',
  'actor', 'actoridentitykey', 'actorlogin', 'identity', 'identitykey',
  'role', 'roles', 'governanceroles', 'permissions', 'installationpermissions',
  'accesstoken', 'refreshtoken', 'authorization', 'authorizationheader',
  'cookie', 'sessioncookie', 'password', 'secret', 'privatekey',
  'content', 'filecontent', 'rawcontent', 'rawfile', 'patch', 'diff', 'payload', 'providerresponse'
]);
const SENSITIVE_KEY_RX = /(?:token|secret|password|privatekey|authorization|cookie)/i;
const SENSITIVE_VALUE_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:bearer|token|password|secret)\s*[:=]\s*[A-Za-z0-9._~+\/-]{16,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

class GovernanceSimulationError extends Error {
  constructor(message, code, status = 400, details) {
    super(message);
    this.name = 'GovernanceSimulationError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code, status = 400, details) {
  throw new GovernanceSimulationError(message, code, status, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function compactKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function assertSafeKey(key, path) {
  const compact = compactKey(key);
  if (!key || key.length > 100 || DANGEROUS_KEYS.has(key) || SENSITIVE_KEY_RX.test(compact) || FORBIDDEN_SCENARIO_KEYS.has(compact)) {
    fail(`Sensitive or invalid simulation field at ${path}`, 'SIMULATION_SENSITIVE_FIELD');
  }
}

function normalizePath(value, label) {
  const text = String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!text || text.length > 1024 || text.includes('\0') || text.split('/').includes('..')) {
    fail(`${label} is invalid`, 'SIMULATION_INPUT_INVALID');
  }
  return text;
}

function cloneAttributes(value, path = '$.attributes', depth = 0, keyHint = '') {
  if (depth > MAX_DEPTH) fail('Simulation attributes are nested too deeply', 'SIMULATION_INPUT_INVALID');
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`Simulation value at ${path} is invalid`, 'SIMULATION_INPUT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      fail(`Simulation value at ${path} is invalid`, 'SIMULATION_INPUT_INVALID');
    }
    if (SENSITIVE_VALUE_RX.test(value)) fail(`Simulation value at ${path} appears to contain credential material`, 'SIMULATION_SENSITIVE_VALUE');
    if (keyHint === 'path' || keyHint === 'paths') return normalizePath(value, path);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) fail(`Simulation array at ${path} is too large`, 'SIMULATION_INPUT_INVALID');
    return value.map((item, index) => cloneAttributes(item, `${path}[${index}]`, depth + 1, keyHint));
  }
  if (!isPlainObject(value)) fail(`Simulation value at ${path} must be JSON-compatible`, 'SIMULATION_INPUT_INVALID');
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_KEYS) fail(`Simulation object at ${path} has too many fields`, 'SIMULATION_INPUT_INVALID');
  const out = {};
  for (const key of keys) {
    assertSafeKey(key, `${path}.${key}`);
    out[key] = cloneAttributes(value[key], `${path}.${key}`, depth + 1, key.toLowerCase());
  }
  return out;
}

function normalizeSimulationRequest(input) {
  if (!isPlainObject(input)) fail('Simulation request must be a JSON object', 'SIMULATION_INPUT_INVALID');
  const allowed = new Set(['schemaVersion', 'scenarios']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('Simulation request contains an unsupported field', 'SIMULATION_INPUT_INVALID');
  if (Number(input.schemaVersion) !== 1) fail('Only simulation schema version 1 is supported', 'SIMULATION_SCHEMA_UNSUPPORTED');
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > MAX_SCENARIOS) {
    fail(`Simulation requires between one and ${MAX_SCENARIOS} scenarios`, 'SIMULATION_INPUT_INVALID');
  }
  const ids = new Set();
  const scenarios = input.scenarios.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`Simulation scenario ${index + 1} must be an object`, 'SIMULATION_INPUT_INVALID');
    const allowedScenario = new Set(['id', 'action', 'attributes']);
    for (const key of Object.keys(raw)) if (!allowedScenario.has(key)) fail(`Simulation scenario ${index + 1} contains an unsupported field`, 'SIMULATION_INPUT_INVALID');
    const id = String(raw.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id) || ids.has(id)) fail(`Simulation scenario ${index + 1} has an invalid or duplicate id`, 'SIMULATION_INPUT_INVALID');
    ids.add(id);
    const action = String(raw.action || '').trim().toLowerCase();
    if (!MUTATION_ACTIONS[action]) fail(`Simulation action ${action || '(empty)'} is not registered`, 'SIMULATION_ACTION_UNKNOWN');
    const attributes = raw.attributes == null ? {} : cloneAttributes(raw.attributes);
    if (!isPlainObject(attributes)) fail('Simulation attributes must be an object', 'SIMULATION_INPUT_INVALID');
    if (Buffer.byteLength(stableJson(attributes), 'utf8') > MAX_ATTRIBUTES_BYTES) fail('Simulation scenario attributes exceed 64 KiB', 'SIMULATION_INPUT_TOO_LARGE', 413);
    return { id, action, attributes };
  });
  const request = { schemaVersion: 1, scenarios };
  if (Buffer.byteLength(stableJson(request), 'utf8') > MAX_REQUEST_BYTES) fail('Simulation request exceeds 256 KiB', 'SIMULATION_INPUT_TOO_LARGE', 413);
  return deepFreeze(request);
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globRegex(pattern) {
  const normalized = normalizePath(pattern, 'Policy path condition');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') { source += '.*'; index += 1; }
      else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
}

function scalarEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function arrayIntersects(left, right) {
  return left.some(item => right.some(candidate => scalarEqual(item, candidate)));
}

function pathConditionMatches(expected, actual) {
  const patterns = Array.isArray(expected) ? expected : [expected];
  const paths = Array.isArray(actual) ? actual : [actual];
  if (!patterns.length || !paths.length) return false;
  return patterns.some(pattern => {
    if (typeof pattern !== 'string') return false;
    const matcher = globRegex(pattern);
    return paths.some(pathValue => typeof pathValue === 'string' && matcher.test(normalizePath(pathValue, 'Scenario path')));
  });
}

function conditionValue(attributes, key) {
  if (Object.prototype.hasOwnProperty.call(attributes, key)) return attributes[key];
  if (key === 'branches' && Object.prototype.hasOwnProperty.call(attributes, 'branch')) return attributes.branch;
  if (key === 'branch' && Object.prototype.hasOwnProperty.call(attributes, 'branches')) return attributes.branches;
  if (key === 'paths' && Object.prototype.hasOwnProperty.call(attributes, 'path')) return attributes.path;
  if (key === 'path' && Object.prototype.hasOwnProperty.call(attributes, 'paths')) return attributes.paths;
  return undefined;
}

function conditionMatches(expected, actual, key) {
  if (actual === undefined) return false;
  if (key === 'path' || key === 'paths') return pathConditionMatches(expected, actual);
  if (Array.isArray(expected) && Array.isArray(actual)) return arrayIntersects(expected, actual);
  if (Array.isArray(expected)) return expected.some(item => scalarEqual(item, actual));
  if (Array.isArray(actual)) return actual.some(item => scalarEqual(expected, item));
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every(child => conditionMatches(expected[child], actual[child], child));
  }
  return scalarEqual(expected, actual);
}

function ruleMatches(rule, scenario, definition) {
  if (rule.action !== scenario.action) return false;
  if (!rule.conditions) return true;
  const attributes = { ...scenario.attributes, category: definition.category, risk: definition.risk };
  return Object.keys(rule.conditions).every(key => conditionMatches(rule.conditions[key], conditionValue(attributes, key), key));
}

function evaluatePolicyDocument(documentInput, scenariosInput) {
  const document = normalizePolicyDocument(documentInput);
  const request = Array.isArray(scenariosInput)
    ? normalizeSimulationRequest({ schemaVersion: 1, scenarios: scenariosInput })
    : normalizeSimulationRequest(scenariosInput);
  const unsupportedRuleActions = [...new Set(document.rules.filter(rule => !MUTATION_ACTIONS[rule.action]).map(rule => rule.action))].sort();
  const results = request.scenarios.map(scenario => {
    const definition = MUTATION_ACTIONS[scenario.action];
    const matched = document.rules.filter(rule => MUTATION_ACTIONS[rule.action] && ruleMatches(rule, scenario, definition));
    const effects = [...new Set(matched.map(rule => rule.effect))].sort((a, b) => EFFECT_RANK[b] - EFFECT_RANK[a] || a.localeCompare(b));
    const effect = effects.length ? effects[0] : 'allow';
    return {
      scenarioId: scenario.id,
      action: scenario.action,
      category: definition.category,
      risk: definition.risk,
      effect,
      source: matched.length ? 'matched-rules' : 'default-allow',
      conflict: effects.length > 1,
      matchedRuleIds: matched.map(rule => rule.id),
      matchedRules: matched.map(rule => ({ id: rule.id, effect: rule.effect, ...(rule.controlRefs ? { controlRefs: rule.controlRefs } : {}) }))
    };
  });
  const evidence = { documentHash: policyDocumentHash(document), results, unsupportedRuleActions };
  return deepFreeze({ ...evidence, evaluationHash: crypto.createHash('sha256').update(stableJson(evidence), 'utf8').digest('hex') });
}

function normalizeVersion(input, label) {
  if (!isPlainObject(input)) fail(`${label} policy version is invalid`, 'SIMULATION_VERSION_INVALID', 500);
  const document = normalizePolicyDocument(input.document);
  const versionId = normalizeUuid(input.versionId, `${label} version id`);
  const versionNumber = Number(input.versionNumber);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) fail(`${label} version number is invalid`, 'SIMULATION_VERSION_INVALID', 500);
  const documentHash = policyDocumentHash(document);
  if (input.documentHash != null) {
    const suppliedHash = String(input.documentHash).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(suppliedHash)) fail(`${label} document hash is invalid`, 'SIMULATION_VERSION_INVALID', 500);
    if (suppliedHash !== documentHash) fail(`${label} policy version failed its document integrity check`, 'SIMULATION_VERSION_INTEGRITY_FAILED', 500);
  }
  return { versionId, versionNumber, documentHash, document };
}

function changeOf(baselineEffect, proposedEffect) {
  if (baselineEffect === proposedEffect) return 'unchanged';
  if (EFFECT_RANK[proposedEffect] > EFFECT_RANK[baselineEffect]) return 'strengthened';
  if (EFFECT_RANK[proposedEffect] < EFFECT_RANK[baselineEffect]) return 'relaxed';
  return 'changed';
}

function simulatePolicyImpact(input = {}) {
  const scope = normalizePolicyScope(input.scope);
  const request = normalizeSimulationRequest(input.request);
  const proposedVersion = normalizeVersion(input.proposedVersion, 'Proposed');
  const baselineVersion = input.baselineVersion == null ? null : normalizeVersion(input.baselineVersion, 'Baseline');
  const proposedEvaluation = evaluatePolicyDocument(proposedVersion.document, request);
  const baselineEvaluation = baselineVersion
    ? evaluatePolicyDocument(baselineVersion.document, request)
    : evaluatePolicyDocument({ schemaVersion: 1, rules: [] }, request);
  const baselineByScenario = new Map(baselineEvaluation.results.map(item => [item.scenarioId, item]));
  const results = proposedEvaluation.results.map(item => {
    const baseline = baselineByScenario.get(item.scenarioId);
    return {
      ...item,
      baselineEffect: baseline.effect,
      baselineSource: baseline.source,
      baselineConflict: baseline.conflict,
      baselineMatchedRuleIds: baseline.matchedRuleIds,
      baselineMatchedRules: baseline.matchedRules,
      change: changeOf(baseline.effect, item.effect)
    };
  });
  const changed = results.filter(item => item.change !== 'unchanged');
  const conflicts = results.filter(item => item.conflict);
  const baselineConflicts = results.filter(item => item.baselineConflict);
  const exercisedProposedRuleIds = new Set(proposedEvaluation.results.flatMap(item => item.matchedRuleIds));
  const unexercisedProposedRuleIds = proposedVersion.document.rules
    .filter(rule => MUTATION_ACTIONS[rule.action] && !exercisedProposedRuleIds.has(rule.id))
    .map(rule => rule.id)
    .sort();
  const impactDiff = changed.map(item => ({
    scenarioId: item.scenarioId,
    action: item.action,
    category: item.category,
    risk: item.risk,
    fromEffect: item.baselineEffect,
    toEffect: item.effect,
    change: item.change
  }));
  const summary = {
    scenarioCount: results.length,
    unchangedCount: results.filter(item => item.change === 'unchanged').length,
    strengthenedCount: results.filter(item => item.change === 'strengthened').length,
    relaxedCount: results.filter(item => item.change === 'relaxed').length,
    changedCount: results.filter(item => item.change === 'changed').length,
    conflictCount: conflicts.length,
    baselineConflictCount: results.filter(item => item.baselineConflict).length,
    affectedActions: [...new Set(changed.map(item => item.action))].sort(),
    affectedActionClasses: [...new Set(changed.map(item => item.category))].sort(),
    affectedRiskLevels: [...new Set(changed.map(item => item.risk))].sort((a, b) => RISK_RANK[b] - RISK_RANK[a] || a.localeCompare(b)),
    highestAffectedRisk: changed.length ? changed.map(item => item.risk).sort((a, b) => RISK_RANK[b] - RISK_RANK[a])[0] : null,
    unsupportedRuleActions: [...new Set([...proposedEvaluation.unsupportedRuleActions, ...baselineEvaluation.unsupportedRuleActions])].sort(),
    unexercisedProposedRuleIds
  };
  const warnings = [];
  if (!baselineVersion) warnings.push({ code: 'SIMULATION_NO_ACTIVE_POLICY', count: 1 });
  if (conflicts.length) warnings.push({ code: 'SIMULATION_RULE_CONFLICTS', count: conflicts.length });
  if (baselineConflicts.length) warnings.push({ code: 'SIMULATION_BASELINE_CONFLICTS', count: baselineConflicts.length });
  if (summary.relaxedCount) warnings.push({ code: 'SIMULATION_RELAXED_OUTCOMES', count: summary.relaxedCount });
  if (summary.unsupportedRuleActions.length) warnings.push({ code: 'SIMULATION_UNSUPPORTED_POLICY_ACTIONS', count: summary.unsupportedRuleActions.length, actions: summary.unsupportedRuleActions.slice(0, 50) });
  if (unexercisedProposedRuleIds.length) warnings.push({ code: 'SIMULATION_UNEXERCISED_POLICY_RULES', count: unexercisedProposedRuleIds.length, ruleIds: unexercisedProposedRuleIds.slice(0, 50) });
  const activationBlockers = [];
  if (conflicts.length) activationBlockers.push('SIMULATION_RULE_CONFLICTS');
  if (proposedEvaluation.unsupportedRuleActions.length) activationBlockers.push('SIMULATION_UNSUPPORTED_POLICY_ACTIONS');
  if (unexercisedProposedRuleIds.length) activationBlockers.push('SIMULATION_UNEXERCISED_POLICY_RULES');
  const activationReadiness = { eligible: activationBlockers.length === 0, blockers: activationBlockers };
  const scenarioSetHash = crypto.createHash('sha256').update(stableJson(request), 'utf8').digest('hex');
  const conflictEvidence = conflicts.map(item => ({ scenarioId: item.scenarioId, action: item.action, matchedRules: item.matchedRules }));
  const resultPayload = { results, impactDiff, conflicts: conflictEvidence, summary, warnings, activationReadiness };
  const resultHash = crypto.createHash('sha256').update(stableJson(resultPayload), 'utf8').digest('hex');
  const report = {
    schemaVersion: 1,
    engineVersion: 1,
    scope,
    scenarioSetHash,
    resultHash,
    proposed: {
      versionId: proposedVersion.versionId,
      versionNumber: proposedVersion.versionNumber,
      documentHash: proposedVersion.documentHash,
      evaluationHash: proposedEvaluation.evaluationHash,
      unsupportedRuleActions: proposedEvaluation.unsupportedRuleActions
    },
    baseline: baselineVersion ? {
      kind: 'active-version',
      versionId: baselineVersion.versionId,
      versionNumber: baselineVersion.versionNumber,
      documentHash: baselineVersion.documentHash,
      evaluationHash: baselineEvaluation.evaluationHash,
      unsupportedRuleActions: baselineEvaluation.unsupportedRuleActions
    } : {
      kind: 'no-policy', versionId: null, versionNumber: null,
      documentHash: baselineEvaluation.documentHash,
      evaluationHash: baselineEvaluation.evaluationHash,
      unsupportedRuleActions: baselineEvaluation.unsupportedRuleActions
    },
    request,
    results,
    impactDiff,
    conflicts: conflictEvidence,
    warnings,
    activationReadiness,
    summary
  };
  const simulationHash = crypto.createHash('sha256').update(stableJson(report), 'utf8').digest('hex');
  return deepFreeze({ ...report, simulationHash });
}

module.exports = Object.freeze({
  GovernanceSimulationError,
  normalizeSimulationRequest,
  evaluatePolicyDocument,
  simulatePolicyImpact
});
