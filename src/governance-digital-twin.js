'use strict';

const crypto = require('crypto');
const { normalizePolicyScope, normalizeUuid, stableJson } = require('./governance-model');

const MAX_HISTORY_LIMIT = 200;

class GovernanceDigitalTwinError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'GovernanceDigitalTwinError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code = 'GOVERNANCE_DIGITAL_TWIN_INVALID', status = 400) {
  throw new GovernanceDigitalTwinError(message, code, status);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function integer(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) fail('Digital Twin pagination input is invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail('Digital Twin pagination input is invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  return number;
}

function normalizeDigitalTwinOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Digital Twin options are invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  return deepFreeze({
    historyLimit: integer(input.historyLimit, 50, 1, MAX_HISTORY_LIMIT),
    afterDecisionSeq: integer(input.afterDecisionSeq, 0, 0, Number.MAX_SAFE_INTEGER)
  });
}

function date(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return parsed.toISOString();
}

function count(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) fail('Digital Twin count is invalid', 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return number;
}


function hash(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return text;
}

function uuid(value, label) {
  try { return normalizeUuid(value, label); }
  catch { fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500); }
}

function reviewState(row) {
  const requiredApprovals = count(row.required_approvals || 1);
  const assignedCount = count(row.assignment_count);
  const approvalCount = count(row.approval_count);
  const rejectionCount = count(row.rejection_count);
  const status = rejectionCount > 0 ? 'rejected' : approvalCount >= requiredApprovals ? 'approved' : 'pending';
  return { status, requiredApprovals, assignedCount, approvalCount, rejectionCount, terminal: status !== 'pending' };
}

function buildPolicyDigitalTwinReadModel(input = {}) {
  const scope = normalizePolicyScope(input.scope);
  const options = normalizeDigitalTwinOptions(input.options || {});
  const data = input.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Digital Twin source data is invalid', 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  const asOf = date(data.asOf, 'Digital Twin snapshot time');
  const policyRows = Array.isArray(data.policies) ? data.policies : [];
  const versionRows = Array.isArray(data.versions) ? data.versions : [];
  const draftRows = Array.isArray(data.drafts) ? data.drafts : [];
  const exceptionRows = Array.isArray(data.exceptions) ? data.exceptions : [];
  const activationRows = Array.isArray(data.activations) ? data.activations : [];
  const decisionRows = Array.isArray(data.decisions) ? data.decisions : [];
  const versionsByPolicy = new Map();
  for (const row of versionRows) {
    const simulationHash = row.simulation_hash == null ? null : String(row.simulation_hash);
    const entry = {
      versionId: uuid(row.version_id, 'Policy version id'),
      versionNumber: count(row.version_number),
      documentHash: hash(row.document_hash, 'Policy document hash'),
      createdAt: date(row.created_at, 'Policy version time'),
      review: reviewState(row),
      simulationEvidence: simulationHash ? {
        status: 'recorded-activation-evidence',
        simulationHash: hash(simulationHash, 'Simulation hash'),
        scenarioSetHash: hash(row.scenario_set_hash, 'Scenario-set hash'),
        resultHash: hash(row.simulation_result_hash, 'Simulation result hash'),
        recordedAt: date(row.simulation_evidence_created_at, 'Simulation evidence time')
      } : { status: 'fresh-simulation-required' }
    };
    if (!versionsByPolicy.has(row.policy_id)) versionsByPolicy.set(row.policy_id, []);
    versionsByPolicy.get(row.policy_id).push(entry);
  }
  for (const values of versionsByPolicy.values()) values.sort((a, b) => b.versionNumber - a.versionNumber || a.versionId.localeCompare(b.versionId));

  const policies = policyRows.map(row => {
    const versions = versionsByPolicy.get(row.policy_id) || [];
    const activeVersionId = row.active_version_id || null;
    return {
      policyId: uuid(row.policy_id, 'Policy id'),
      policyKey: String(row.policy_key || ''),
      name: String(row.name || ''),
      description: String(row.description || ''),
      revision: count(row.revision),
      updatedAt: date(row.updated_at, 'Policy update time'),
      active: activeVersionId ? {
        versionId: uuid(activeVersionId, 'Active version id'),
        versionNumber: count(row.active_version_number),
        documentHash: hash(row.active_document_hash, 'Active document hash'),
        enforcementMode: ['observe','warn','block'].includes(row.active_enforcement_mode) ? row.active_enforcement_mode : 'observe'
      } : null,
      latestVersion: versions[0] || null,
      versionCount: versions.length
    };
  }).sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.policyId.localeCompare(b.policyId));

  const drafts = draftRows.map(row => ({
    draftId: uuid(row.draft_id, 'Draft id'),
    policyId: uuid(row.policy_id, 'Draft policy id'),
    revision: count(row.revision),
    documentHash: hash(row.document_hash, 'Draft document hash'),
    authoredByLogin: String(row.authored_by_login || ''),
    requiredApprovals: count(row.required_approvals),
    disallowAuthorApproval: row.disallow_author_approval !== false,
    createdAt: date(row.created_at, 'Draft creation time'),
    updatedAt: date(row.updated_at, 'Draft update time')
  })).sort((a, b) => a.policyId.localeCompare(b.policyId) || b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId));

  const proposedVersions = [];
  for (const [policyId, versions] of versionsByPolicy.entries()) {
    const policy = policies.find(item => item.policyId === policyId);
    if (!policy || !versions.length) continue;
    const candidates = policy.active
      ? versions.filter(version => version.versionNumber > policy.active.versionNumber)
      : [versions[0]];
    for (const version of candidates) {
      const blockers = [];
      if (version.review.status !== 'approved') blockers.push(`review-${version.review.status}`);
      blockers.push('fresh-simulation-required');
      proposedVersions.push({
        policyId,
        policyKey: policy.policyKey,
        ...version,
        activationReadiness: { eligible: false, blockers }
      });
    }
  }
  proposedVersions.sort((a, b) => a.policyKey.localeCompare(b.policyKey) || b.versionNumber - a.versionNumber || a.versionId.localeCompare(b.versionId));

  const exceptions = exceptionRows.map(row => ({
    exceptionId: uuid(row.exception_id, 'Exception id'),
    policyId: uuid(row.policy_id, 'Exception policy id'),
    versionId: uuid(row.version_id, 'Exception version id'),
    kind: row.kind,
    action: row.action,
    state: row.state,
    expiresAt: date(row.expires_at, 'Exception expiry'),
    createdAt: date(row.created_at, 'Exception creation time')
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.exceptionId.localeCompare(b.exceptionId));
  const effectiveExceptions = exceptions.filter(item => item.state === 'approved' && new Date(item.expiresAt).getTime() > new Date(asOf).getTime());
  const summaryRows = Array.isArray(data.activeExceptionSummary) ? data.activeExceptionSummary : [];
  const activeExceptionsByAction = summaryRows.length
    ? summaryRows.map(row => ({ action: String(row.action || ''), count: count(row.active_count) })).sort((a, b) => a.action.localeCompare(b.action))
    : [...new Map(effectiveExceptions.map(item => [item.action, 0])).keys()].sort().map(action => ({ action, count: effectiveExceptions.filter(item => item.action === action).length }));
  const activeExceptionCount = activeExceptionsByAction.reduce((total, item) => total + item.count, 0);

  const activations = activationRows.map(row => ({
    seq: count(row.seq), policyId: uuid(row.policy_id, 'Activation policy id'), versionId: uuid(row.version_id, 'Activation version id'),
    action: row.action, actorLogin: row.actor_login, createdAt: date(row.created_at, 'Activation time'),
    evidence: row.simulation_hash ? {
      simulationHash: hash(row.simulation_hash, 'Activation simulation hash'),
      scenarioSetHash: hash(row.scenario_set_hash, 'Activation scenario-set hash'),
      resultHash: hash(row.simulation_result_hash, 'Activation result hash')
    } : null
  }));
  const decisions = decisionRows.map(row => ({
    seq: count(row.seq), action: row.action, enforcementOutcome: row.enforcement_outcome,
    effectiveEffect: row.effective_effect, evaluatedAt: date(row.evaluated_at || row.created_at, 'Decision time'),
    decisionHash: hash(row.decision_hash, 'Decision hash')
  }));
  const completeness = {
    policies: data.completeness && data.completeness.policies === true,
    versions: data.completeness && data.completeness.versions === true,
    drafts: data.completeness && data.completeness.drafts === true,
    exceptions: data.completeness && data.completeness.exceptions === true,
    activations: data.completeness && data.completeness.activations === true,
    decisions: data.completeness && data.completeness.decisions === true
  };
  const complete = Object.values(completeness).every(Boolean);
  const totals = data.totals && typeof data.totals === 'object' ? data.totals : {};
  const totalPolicyCount = totals.policies == null ? policies.length : count(totals.policies);
  const totalActivePolicyCount = totals.activePolicies == null ? policies.filter(item => item.active).length : count(totals.activePolicies);
  const body = {
    schemaVersion: 1,
    scope,
    current: {
      policies,
      policyCount: totalPolicyCount,
      returnedPolicyCount: policies.length,
      activePolicyCount: totalActivePolicyCount
    },
    proposed: { drafts, draftCount: drafts.length, versions: proposedVersions, versionCount: proposedVersions.length },
    effective: {
      activePolicyCount: totalActivePolicyCount,
      activeExceptionCount,
      activeExceptionsByAction,
      exceptionReferences: effectiveExceptions
    },
    history: {
      activations,
      decisions,
      exceptions,
      nextDecisionSeq: data.nextDecisionSeq == null ? null : count(data.nextDecisionSeq),
      requestedAfterDecisionSeq: options.afterDecisionSeq,
      limit: options.historyLimit
    },
    freshness: { status: complete ? 'current' : 'partial', asOf, completeness }
  };
  return deepFreeze({ ...body, readModelHash: crypto.createHash('sha256').update(stableJson(body), 'utf8').digest('hex') });
}

module.exports = Object.freeze({
  GovernanceDigitalTwinError,
  normalizeDigitalTwinOptions,
  buildPolicyDigitalTwinReadModel,
  MAX_HISTORY_LIMIT
});
