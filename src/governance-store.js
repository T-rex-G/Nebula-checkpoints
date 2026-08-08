'use strict';

const crypto = require('crypto');
const REVIEW_SENSITIVE_TEXT_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:bearer|token|password|secret)\s*[:=]\s*[A-Za-z0-9._~+\/-]{16,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;
const {
  GovernanceError,
  GOVERNANCE_AUDIT_GENESIS,
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
} = require('./governance-model');
const {
  POLICY_DECISION_GENESIS,
  evaluateActivePolicySet,
  normalizePolicyDecision
} = require('./governance-enforcement');
const { normalizeExceptionRequest, computeExceptionState } = require('./governance-exceptions');
const { normalizeDigitalTwinOptions } = require('./governance-digital-twin');
const {
  SUPPORTED_EVENT_TYPES,
  DEFAULT_NOTIFICATION_EVENT_TYPES,
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  normalizeEventTypes,
  deriveWebhookSigningSecret,
  buildGovernanceEvent,
  buildSignedEvidenceExport,
  verifySignedEvidenceExport
} = require('./governance-delivery');

function requiredText(value, label, max = 2000) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new GovernanceError(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

function optionalText(value, label, max = 4000) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new GovernanceError(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

function actorOf(input) {
  if (!input || typeof input !== 'object') throw new GovernanceError('Governance actor is required', 'GOVERNANCE_ACTOR_INVALID');
  return {
    identityKey: normalizeIdentityKey(input.identityKey, 'actor identity'),
    login: requiredText(input.login, 'Actor login', 200)
  };
}

function mapPolicy(row) {
  return {
    policyId: row.policy_id,
    scopeKey: row.scope_key,
    provider: row.provider,
    authority: row.authority,
    owner: row.owner,
    repo: row.repo,
    policyKey: row.policy_key,
    name: row.name,
    description: row.description || '',
    createdByIdentityKey: row.created_by_identity_key,
    createdByLogin: row.created_by_login,
    createdAt: row.created_at
  };
}

function mapVersion(row) {
  return {
    versionId: row.version_id,
    policyId: row.policy_id,
    versionNumber: Number(row.version_number),
    document: row.document,
    documentHash: row.document_hash,
    authoredByIdentityKey: row.authored_by_identity_key,
    authoredByLogin: row.authored_by_login,
    requiredApprovals: Number(row.required_approvals),
    disallowAuthorApproval: !!row.disallow_author_approval,
    createdAt: row.created_at
  };
}

function mapPolicyState(row) {
  return {
    ...mapPolicy(row),
    activeVersionId: row.active_version_id || null,
    activeVersionNumber: row.active_version_number == null ? null : Number(row.active_version_number),
    activeDocumentHash: row.active_document_hash || null,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at
  };
}

function mapDraft(row) {
  return {
    draftId: row.draft_id,
    policyId: row.policy_id,
    revision: Number(row.revision || 0),
    document: row.document,
    documentHash: row.document_hash,
    authoredByIdentityKey: row.authored_by_identity_key,
    authoredByLogin: row.authored_by_login,
    requiredApprovals: Number(row.required_approvals),
    disallowAuthorApproval: !!row.disallow_author_approval,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}


function mapReviewAssignment(row) {
  return {
    assignmentId: row.assignment_id,
    policyId: row.policy_id,
    versionId: row.version_id,
    reviewerIdentityKey: row.reviewer_identity_key,
    reviewerLogin: row.reviewer_login,
    reviewerAccessLevel: Number(row.reviewer_access_level),
    reviewerProviderRole: row.reviewer_provider_role,
    authorizationSource: row.authorization_source,
    authorizationFetchedAt: row.authorization_fetched_at,
    authorizationExpiresAt: row.authorization_expires_at,
    createdAt: row.created_at
  };
}

function mapReviewDecision(row) {
  return {
    decisionId: row.approval_id,
    versionId: row.version_id,
    assignmentId: row.assignment_id || null,
    decision: row.decision,
    actorIdentityKey: row.actor_identity_key,
    actorLogin: row.actor_login,
    rationale: row.rationale || '',
    reviewerAccessLevel: row.reviewer_access_level == null ? null : Number(row.reviewer_access_level),
    reviewerProviderRole: row.reviewer_provider_role || null,
    authorizationSource: row.authorization_source || null,
    authorizationFetchedAt: row.authorization_fetched_at || null,
    authorizationExpiresAt: row.authorization_expires_at || null,
    createdAt: row.created_at
  };
}

function mapExceptionEvent(row) {
  return {
    eventId: row.event_id,
    exceptionId: row.exception_id,
    eventType: row.event_type,
    actorIdentityKey: row.actor_identity_key,
    actorLogin: row.actor_login,
    reason: row.reason,
    authorizationAccessLevel: Number(row.authorization_access_level),
    authorizationProviderRole: row.authorization_provider_role,
    authorizationSource: row.authorization_source,
    authorizationFetchedAt: row.authorization_fetched_at,
    authorizationExpiresAt: row.authorization_expires_at,
    createdAt: row.created_at
  };
}

function mapExceptionRequest(row, events = [], now = new Date()) {
  const request = {
    exceptionId: row.exception_id,
    scopeKey: row.scope_key,
    policyId: row.policy_id,
    versionId: row.version_id,
    versionNumber: row.version_number == null ? null : Number(row.version_number),
    documentHash: row.document_hash,
    headRevision: Number(row.head_revision),
    kind: row.kind,
    action: row.action,
    ruleIds: Array.isArray(row.rule_ids) ? row.rule_ids : [],
    target: row.target && typeof row.target === 'object' ? row.target : {},
    targetHash: row.target_hash,
    reason: row.reason,
    requestedByIdentityKey: row.requested_by_identity_key,
    requestedByLogin: row.requested_by_login,
    authorizationAccessLevel: Number(row.authorization_access_level),
    authorizationProviderRole: row.authorization_provider_role,
    authorizationSource: row.authorization_source,
    authorizationFetchedAt: row.authorization_fetched_at,
    authorizationExpiresAt: row.authorization_expires_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
  const mappedEvents = events.map(mapExceptionEvent);
  const state = computeExceptionState({ request, events: mappedEvents, now, activeVersionId: row.active_version_id || null, activeHeadRevision: Number(row.current_head_revision == null ? row.revision : row.current_head_revision) });
  return { ...request, ...state, events: mappedEvents };
}

function exceptionAuthorizationEvidenceOf(input, minimumLevel, currentDate = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Exception authorization evidence is required', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  const accessLevel = Number(input.accessLevel);
  if (![30, 40, 50].includes(accessLevel) || accessLevel < minimumLevel) {
    throw new GovernanceError('Current repository authorization is required for this exception operation', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(input.providerRole, 'Exception provider role', 120);
  const source = requiredText(input.source, 'Exception authorization source', 120);
  const fetchedAt = new Date(input.fetchedAt);
  const expiresAt = new Date(input.expiresAt);
  const currentTime = new Date(currentDate).getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(currentTime) ||
      expiresAt <= fetchedAt || expiresAt.getTime() <= currentTime || fetchedAt.getTime() > currentTime + 30 * 1000) {
    throw new GovernanceError('Exception authorization evidence is invalid or stale', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  return { accessLevel, providerRole, source, fetchedAt: fetchedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

function exceptionDecisionOf(value) {
  const decision = String(value || '').trim().toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new GovernanceError('Exception decision must be approve or reject', 'GOVERNANCE_EXCEPTION_DECISION_INVALID');
  return decision;
}

function authorizationEvidenceOf(input, currentDate = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Reviewer authorization evidence is required', 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID', 403);
  }
  const accessLevel = Number(input.accessLevel);
  if (![40, 50].includes(accessLevel)) {
    throw new GovernanceError('Current reviewer authorization is required', 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(input.providerRole, 'Reviewer provider role', 120);
  const source = requiredText(input.source, 'Reviewer authorization source', 120);
  const fetchedAt = new Date(input.fetchedAt);
  const expiresAt = new Date(input.expiresAt);
  const currentTime = new Date(currentDate).getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(currentTime) ||
      expiresAt <= fetchedAt || expiresAt.getTime() <= currentTime || fetchedAt.getTime() > currentTime + 30 * 1000) {
    throw new GovernanceError('Reviewer authorization evidence is invalid or stale', 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID', 403);
  }
  return {
    accessLevel,
    providerRole,
    source,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}

function activationAuthorizationEvidenceOf(input, currentDate = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Activator authorization evidence is required', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  const accessLevel = Number(input.accessLevel);
  if (accessLevel !== 50) {
    throw new GovernanceError('Current repository administrator authorization is required', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(input.providerRole, 'Activator provider role', 120);
  const source = requiredText(input.source, 'Activator authorization source', 120);
  const fetchedAt = new Date(input.fetchedAt);
  const expiresAt = new Date(input.expiresAt);
  const currentTime = new Date(currentDate).getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(currentTime) ||
      expiresAt <= fetchedAt || expiresAt.getTime() <= currentTime || fetchedAt.getTime() > currentTime + 30 * 1000) {
    throw new GovernanceError('Activator authorization evidence is invalid or stale', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  return { accessLevel, providerRole, source, fetchedAt: fetchedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

function activationSimulationEvidenceOf(input, expectedSimulationHash) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Simulation evidence is required', 'GOVERNANCE_SIMULATION_REQUIRED', 400);
  }
  const hash = value => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) throw new GovernanceError('Simulation evidence hash is invalid', 'GOVERNANCE_SIMULATION_INVALID', 400);
    return normalized;
  };
  const simulationHash = hash(input.simulationHash);
  if (simulationHash !== hash(expectedSimulationHash)) {
    throw new GovernanceError('Simulation evidence does not match the reviewed result', 'GOVERNANCE_SIMULATION_MISMATCH', 409);
  }
  if (Number(input.schemaVersion) !== 1 || !Number.isSafeInteger(Number(input.engineVersion)) || Number(input.engineVersion) < 1) {
    throw new GovernanceError('Simulation evidence version is unsupported', 'GOVERNANCE_SIMULATION_INVALID', 400);
  }
  if (!input.activationReadiness || input.activationReadiness.eligible !== true ||
      !Array.isArray(input.activationReadiness.blockers) || input.activationReadiness.blockers.length !== 0) {
    throw new GovernanceError('Simulation evidence contains activation blockers', 'GOVERNANCE_SIMULATION_BLOCKED', 409);
  }
  const scope = normalizePolicyScope(input.scope);
  const proposed = input.proposed || {};
  const baseline = input.baseline || {};
  const summary = input.summary || {};
  const versionId = normalizeUuid(proposed.versionId, 'simulation proposed version id');
  const proposedDocumentHash = hash(proposed.documentHash);
  const baselineKind = String(baseline.kind || '');
  if (!['no-policy', 'active-version'].includes(baselineKind)) {
    throw new GovernanceError('Simulation baseline is invalid', 'GOVERNANCE_SIMULATION_INVALID', 400);
  }
  const baselineVersionId = baselineKind === 'active-version' ? normalizeUuid(baseline.versionId, 'simulation baseline version id') : null;
  if (baselineKind === 'no-policy' && baseline.versionId != null) {
    throw new GovernanceError('No-policy simulation baseline cannot name a version', 'GOVERNANCE_SIMULATION_INVALID', 400);
  }
  const scenarioCount = Number(summary.scenarioCount);
  const strengthenedCount = Number(summary.strengthenedCount || 0);
  const relaxedCount = Number(summary.relaxedCount || 0);
  const changedCount = Number(summary.changedCount || 0);
  for (const value of [scenarioCount, strengthenedCount, relaxedCount, changedCount]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 200) throw new GovernanceError('Simulation summary is invalid', 'GOVERNANCE_SIMULATION_INVALID', 400);
  }
  if (scenarioCount < 1) throw new GovernanceError('Simulation must contain at least one scenario', 'GOVERNANCE_SIMULATION_INVALID', 400);
  return {
    schemaVersion: 1,
    engineVersion: Number(input.engineVersion),
    scope,
    simulationHash,
    scenarioSetHash: hash(input.scenarioSetHash),
    resultHash: hash(input.resultHash),
    proposed: { versionId, documentHash: proposedDocumentHash },
    baseline: { kind: baselineKind, versionId: baselineVersionId, documentHash: hash(baseline.documentHash) },
    summary: { scenarioCount, strengthenedCount, relaxedCount, changedCount }
  };
}

function reviewResponse(version, assignmentRows, decisionRows) {
  const assignments = assignmentRows.map(mapReviewAssignment);
  const decisions = decisionRows.map(mapReviewDecision);
  const state = computeGovernanceReviewState({
    requiredApprovals: Number(version.required_approvals),
    assignments,
    decisions
  });
  return {
    policyId: version.policy_id,
    versionId: version.version_id,
    versionNumber: Number(version.version_number),
    authoredByIdentityKey: version.authored_by_identity_key,
    authoredByLogin: version.authored_by_login,
    requiredApprovals: Number(version.required_approvals),
    disallowAuthorApproval: !!version.disallow_author_approval,
    activated: !!version.has_activation,
    ...state,
    assignments,
    decisions
  };
}

function expectedRevisionOf(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new GovernanceError('Expected draft revision is invalid', 'GOVERNANCE_DRAFT_REVISION_INVALID');
  }
  return revision;
}

function boundedListLimit(value) {
  if (value == null || String(value).trim() === '') return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new GovernanceError('Governance list limit must be an integer between 1 and 200', 'GOVERNANCE_LIMIT_INVALID', 400);
  }
  return limit;
}

function boundedDecisionLimit(value, defaultValue, maximum) {
  if (value == null || String(value).trim() === '') return defaultValue;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new GovernanceError(
      `Governance decision limit must be an integer between 1 and ${maximum}`,
      'GOVERNANCE_LIMIT_INVALID',
      400
    );
  }
  return limit;
}

function decisionCursor(value) {
  if (value == null || String(value).trim() === '') return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new GovernanceError('Governance decision cursor must be a non-negative integer', 'GOVERNANCE_CURSOR_INVALID', 400);
  }
  return cursor;
}

function normalizedDraftContent(input) {
  const document = normalizePolicyDocument(input.document);
  const documentHash = policyDocumentHash(document);
  if (input.documentHash != null && String(input.documentHash).trim().toLowerCase() !== documentHash) {
    throw new GovernanceError('Draft document hash is inconsistent', 'GOVERNANCE_DOCUMENT_HASH_INVALID');
  }
  const approval = normalizeApprovalPolicy(input.approvalPolicy);
  return { document, documentHash, approval };
}

function normalizeIdempotencyKey(value) {
  if (value == null || String(value).trim() === '') return null;
  const key = String(value).trim();
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new GovernanceError('Idempotency-Key must contain 8 to 200 printable characters', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function activePolicySetLockKey(scopeKey) {
  return `nv-governance-active-set:${scopeKey}`;
}

function decisionRecordHash(secret, input) {
  return crypto.createHmac('sha256', secret).update(stableJson(input), 'utf8').digest('hex');
}


function eventCursor(value, label = 'Governance event cursor') {
  if (value == null || String(value).trim() === '') return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GovernanceError(`${label} must be a non-negative integer`, 'GOVERNANCE_CURSOR_INVALID', 400);
  return cursor;
}
function eventLimit(value, maximum = 200, defaultValue = 100) {
  if (value == null || String(value).trim() === '') return defaultValue;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new GovernanceError(`Governance event limit must be an integer between 1 and ${maximum}`, 'GOVERNANCE_LIMIT_INVALID', 400);
  return limit;
}
function mapWebhook(row) {
  return {
    webhookId: row.webhook_id,
    scopeKey: row.scope_key,
    name: row.name,
    url: row.endpoint_url,
    eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
    enabled: !!row.enabled,
    secretVersion: Number(row.secret_version),
    createdByLogin: row.created_by_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
}
function mapWebhookDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    webhookId: row.webhook_id,
    eventSeq: Number(row.event_seq),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until || null,
    lastStatusCode: row.last_status_code == null ? null : Number(row.last_status_code),
    lastErrorCode: row.last_error_code || null,
    deliveredAt: row.delivered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function lifecycleSubject(details) {
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const result = {};
  for (const key of ['draftId','assignmentId','approvalId','activationId','exceptionId','previousVersionId','rollbackSourceActivationId']) {
    if (source[key]) result[key] = source[key];
  }
  for (const key of ['action','decision','reviewStatus']) if (source[key]) result[key] = source[key];
  return result;
}
function lifecycleEvidence(details) {
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const result = {};
  if (source.documentHash) result.documentHash = source.documentHash;
  else if (source.proposedDocumentHash) result.documentHash = source.proposedDocumentHash;
  for (const key of ['simulationHash','scenarioSetHash','resultHash','targetHash']) if (source[key]) result[key] = source[key];
  return result;
}
function eventFromJoinedRow(row) {
  const lifecycle = row.source_kind === 'lifecycle';
  if (lifecycle) {
    return buildGovernanceEvent({
      eventSeq: Number(row.event_seq), sourceKind: row.source_kind, sourceSeq: Number(row.source_seq), sourceId: row.source_id,
      eventType: row.event_type, occurredAt: row.occurred_at,
      scope: { provider: row.lifecycle_provider, baseUrl: `${row.lifecycle_provider === 'github' ? 'https://' : 'https://'}${row.lifecycle_authority}`, owner: row.lifecycle_owner, repo: row.lifecycle_repo, scopeKey: row.scope_key },
      actorLogin: row.lifecycle_actor_login, policyId: row.lifecycle_policy_id, versionId: row.lifecycle_version_id,
      subject: lifecycleSubject(row.lifecycle_details),
      evidence: { lifecycleRecordHash: row.lifecycle_record_hash, detailsHash: row.lifecycle_details_hash, ...lifecycleEvidence(row.lifecycle_details) }
    });
  }
  const mapping = row.decision_control_mapping && typeof row.decision_control_mapping === 'object' ? row.decision_control_mapping : {};
  return buildGovernanceEvent({
    eventSeq: Number(row.event_seq), sourceKind: row.source_kind, sourceSeq: Number(row.source_seq), sourceId: row.source_id,
    eventType: row.event_type, occurredAt: row.occurred_at,
    scope: { provider: row.decision_provider, baseUrl: `https://${row.decision_authority}`, owner: row.decision_owner, repo: row.decision_repo, scopeKey: row.scope_key },
    actorLogin: row.decision_actor_login,
    subject: { mutationId: row.decision_mutation_id, action: row.decision_action, enforcementOutcome: row.decision_enforcement_outcome, effectiveEffect: row.decision_effective_effect, rolloutMode: row.decision_rollout_mode },
    evidence: { decisionHash: row.decision_hash, descriptorHash: row.decision_descriptor_hash, policySetHash: row.decision_policy_set_hash, controlMappingHash: mapping.mappingHash }
  });
}
function exportRowEnvelope(row) {
  return {
    schemaVersion: 1,
    format: 'nebulaverse-governance-evidence-envelope',
    manifest: row.manifest,
    content: row.content,
    signature: row.signature
  };
}

function translateDatabaseError(error) {
  if (error instanceof GovernanceError) return error;
  if (error && error.code === '23505') {
    const constraint = String(error.constraint || '');
    if (/exception_one_decision/i.test(constraint)) return new GovernanceError('This exception already has an approval decision', 'GOVERNANCE_EXCEPTION_DECISION_EXISTS', 409);
    if (/exception_one_revoke/i.test(constraint)) return new GovernanceError('This exception is already revoked', 'GOVERNANCE_EXCEPTION_REVOKED', 409);
    if (/approvals.*version.*actor|approvals_assignment_once/i.test(constraint)) return new GovernanceError('This identity already recorded a decision for the version', 'GOVERNANCE_DECISION_EXISTS', 409);
    if (/review_assignments.*version.*reviewer/i.test(constraint)) return new GovernanceError('This identity is already assigned to review the version', 'GOVERNANCE_REVIEW_ASSIGNMENT_EXISTS', 409);
    if (/policy_versions.*document_hash/i.test(constraint)) return new GovernanceError('An identical immutable policy version already exists', 'GOVERNANCE_VERSION_DUPLICATE', 409);
    if (/active_draft_per_author|policy_drafts.*policy.*authored/i.test(constraint)) return new GovernanceError('This author already has an active draft for the policy', 'GOVERNANCE_DRAFT_EXISTS', 409);
    if (/policies.*scope_key.*policy_key/i.test(constraint)) return new GovernanceError('A policy with this key already exists in the repository scope', 'GOVERNANCE_POLICY_EXISTS', 409);
    return new GovernanceError('Governance record already exists', 'GOVERNANCE_CONFLICT', 409);
  }
  if (error && error.code === '23503') return new GovernanceError('Referenced governance record does not exist', 'GOVERNANCE_REFERENCE_INVALID', 409);
  return error;
}

class GovernanceStore {
  constructor(pool, options = {}) {
    if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
      throw new GovernanceError('Governance requires a PostgreSQL pool', 'GOVERNANCE_DATABASE_REQUIRED', 503);
    }
    if (Buffer.byteLength(String(options.secret || ''), 'utf8') < 32) {
      throw new GovernanceError('Governance audit secret is invalid', 'GOVERNANCE_AUDIT_SECRET_INVALID', 500);
    }
    this.pool = pool;
    this.secret = String(options.secret);
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID();
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.saltFactory = typeof options.saltFactory === 'function' ? options.saltFactory : () => crypto.randomBytes(32).toString('hex');
  }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async idempotentTransaction(context, work) {
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    if (!idempotencyKey) return this.transaction(work);
    const scopeKey = requiredText(context.scopeKey, 'Governance scope key', 600);
    const actorIdentityKey = normalizeIdentityKey(context.actorIdentityKey, 'idempotency actor identity');
    const operation = String(context.operation || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,99}$/.test(operation)) {
      throw new GovernanceError('Governance idempotency operation is invalid', 'GOVERNANCE_IDEMPOTENCY_OPERATION_INVALID', 500);
    }
    const keyHash = crypto.createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    const requestHash = sha256Stable(context.request || {});
    return this.transaction(async client => {
      const reserved = await client.query(
        `INSERT INTO nv_governance_idempotency(
          scope_key,actor_identity_key,operation,idempotency_key_hash,request_hash,response_body,created_at
         ) VALUES($1,$2,$3,$4,$5,NULL,$6)
         ON CONFLICT DO NOTHING RETURNING request_hash`,
        [scopeKey, actorIdentityKey, operation, keyHash, requestHash, this.now().toISOString()]
      );
      if (!reserved.rowCount) {
        const existing = await client.query(
          `SELECT request_hash,response_body FROM nv_governance_idempotency
           WHERE scope_key=$1 AND actor_identity_key=$2 AND operation=$3 AND idempotency_key_hash=$4`,
          [scopeKey, actorIdentityKey, operation, keyHash]
        );
        const row = existing.rows[0];
        if (!row) throw new GovernanceError('Idempotent operation could not be resolved', 'GOVERNANCE_IDEMPOTENCY_UNAVAILABLE', 409);
        if (row.request_hash !== requestHash) {
          throw new GovernanceError('Idempotency-Key was already used for a different governance request', 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 409);
        }
        if (row.response_body == null) {
          throw new GovernanceError('An identical governance request is still being processed', 'GOVERNANCE_IDEMPOTENCY_IN_PROGRESS', 409);
        }
        return row.response_body;
      }
      const value = await work(client);
      const encoded = JSON.stringify(value);
      if (!encoded || Buffer.byteLength(encoded, 'utf8') > 512 * 1024) {
        throw new GovernanceError('Governance idempotency response is invalid', 'GOVERNANCE_IDEMPOTENCY_RESPONSE_INVALID', 500);
      }
      const completed = await client.query(
        `UPDATE nv_governance_idempotency SET response_body=$1::jsonb
         WHERE scope_key=$2 AND actor_identity_key=$3 AND operation=$4 AND idempotency_key_hash=$5`,
        [encoded, scopeKey, actorIdentityKey, operation, keyHash]
      );
      if (!completed.rowCount) {
        throw new GovernanceError('Governance idempotency record could not be completed', 'GOVERNANCE_IDEMPOTENCY_UNAVAILABLE', 500);
      }
      return value;
    });
  }

  async appendAudit(client, context) {
    const policyId = normalizeUuid(context.policyId, 'policy id');
    const eventId = normalizeUuid(this.idFactory(), 'audit event id');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-audit:${policyId}`]);
    const previous = await client.query(
      `SELECT record_hash FROM nv_governance_audit
       WHERE policy_id=$1 ORDER BY seq DESC LIMIT 1`,
      [policyId]
    );
    const record = createGovernanceAuditRecord(this.secret, {
      eventId,
      policyId,
      versionId: context.versionId || null,
      eventType: context.eventType,
      actorIdentityKey: context.actor.identityKey,
      actorLogin: context.actor.login,
      previousHash: previous.rows[0] ? previous.rows[0].record_hash : GOVERNANCE_AUDIT_GENESIS,
      details: normalizeAuditDetails(context.details || {}),
      createdAt: this.now().toISOString()
    });
    await client.query(
      `INSERT INTO nv_governance_audit(
        event_id,scope_key,policy_id,version_id,event_type,actor_identity_key,actor_login,
        details,details_hash,previous_hash,record_hash,created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) RETURNING seq,created_at`,
      [record.eventId, context.scopeKey, record.policyId, record.versionId, record.eventType,
       record.actorIdentityKey, record.actorLogin, JSON.stringify(record.details), record.detailsHash,
       record.previousHash, record.recordHash, record.createdAt]
    );
    return record;
  }

  async createPolicy(input) {
    const actor = actorOf(input.actor);
    const scope = normalizePolicyScope(input.scope);
    const policyKey = normalizePolicyKey(input.policyKey);
    const name = requiredText(input.name, 'Policy name', 200);
    const description = optionalText(input.description, 'Policy description', 4000);
    const policyId = normalizeUuid(this.idFactory(), 'policy id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.policy.create',
      request: { policyKey, name, description }
    }, async client => {
      const inserted = await client.query(
        `INSERT INTO nv_governance_policies(
          policy_id,scope_key,provider,authority,owner,repo,policy_key,name,description,
          created_by_identity_key,created_by_login,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [policyId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo, policyKey, name, description,
         actor.identityKey, actor.login, this.now().toISOString()]
      );
      await client.query(
        'INSERT INTO nv_governance_policy_heads(policy_id,active_version_id,revision,updated_at) VALUES($1,NULL,0,$2)',
        [policyId, this.now().toISOString()]
      );
      await this.appendAudit(client, {
        policyId, scopeKey: scope.scopeKey, eventType: 'policy.created', actor,
        details: { policyKey, name, provider: scope.provider, authority: scope.authority, owner: scope.owner, repo: scope.repo }
      });
      return mapPolicy(inserted.rows[0]);
    });
  }

  async listPolicies(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const capped = boundedListLimit(input.limit);
    const result = await this.pool.query(
      `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
              v.version_number AS active_version_number,v.document_hash AS active_document_hash
       FROM nv_governance_policies p
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
       WHERE p.scope_key=$1 AND p.archived_at IS NULL
       ORDER BY p.created_at ASC,p.policy_id ASC LIMIT $2`,
      [scope.scopeKey, capped]
    );
    return result.rows.map(mapPolicyState);
  }

  async getPolicyStateInScope(input = {}) {
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const scope = normalizePolicyScope(input.scope);
    const result = await this.pool.query(
      `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
              v.version_number AS active_version_number,v.document_hash AS active_document_hash
       FROM nv_governance_policies p
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
       WHERE p.policy_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL`,
      [policyId, scope.scopeKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
    return mapPolicyState(result.rows[0]);
  }

  async createVersion(input) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const document = normalizePolicyDocument(input.document);
    const documentHash = policyDocumentHash(document);
    const approval = normalizeApprovalPolicy(input.approvalPolicy);
    const versionId = normalizeUuid(this.idFactory(), 'policy version id');
    return this.transaction(async client => {
      const policyResult = await client.query(
        `SELECT policy_id,scope_key,provider,authority,owner,repo,policy_key,name,description,
                created_by_identity_key,created_by_login,created_at
         FROM nv_governance_policies WHERE policy_id=$1 AND archived_at IS NULL FOR UPDATE`,
        [policyId]
      );
      const policy = policyResult.rows[0];
      if (!policy) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
      const maxResult = await client.query(
        'SELECT COALESCE(MAX(version_number),0)::int AS version_number FROM nv_governance_policy_versions WHERE policy_id=$1',
        [policyId]
      );
      const versionNumber = Number(maxResult.rows[0] && maxResult.rows[0].version_number || 0) + 1;
      const inserted = await client.query(
        `INSERT INTO nv_governance_policy_versions(
          version_id,policy_id,version_number,document,document_hash,authored_by_identity_key,authored_by_login,
          required_approvals,disallow_author_approval,created_at
         ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [versionId, policyId, versionNumber, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
         approval.requiredApprovals, approval.disallowAuthorApproval, this.now().toISOString()]
      );
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: policy.scope_key, eventType: 'version.created', actor,
        details: { versionNumber, documentHash, requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
      });
      return mapVersion(inserted.rows[0]);
    });
  }

  async createDraft(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const scope = normalizePolicyScope(input.scope);
    const { document, documentHash, approval } = normalizedDraftContent(input);
    const draftId = normalizeUuid(this.idFactory(), 'policy draft id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.draft.create',
      request: { policyId, documentHash, approval }
    }, async client => {
      const policy = await client.query(
        `SELECT policy_id,scope_key FROM nv_governance_policies
         WHERE policy_id=$1 AND scope_key=$2 AND archived_at IS NULL FOR SHARE`,
        [policyId, scope.scopeKey]
      );
      if (!policy.rows[0]) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
      const inserted = await client.query(
        `INSERT INTO nv_governance_policy_drafts(
          draft_id,policy_id,revision,document,document_hash,authored_by_identity_key,authored_by_login,
          required_approvals,disallow_author_approval,created_at,updated_at
         ) VALUES($1,$2,0,$3::jsonb,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [draftId, policyId, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
         approval.requiredApprovals, approval.disallowAuthorApproval, this.now().toISOString()]
      );
      await this.appendAudit(client, {
        policyId, scopeKey: scope.scopeKey, eventType: 'draft.created', actor,
        details: { draftId, revision: 0, documentHash, requiredApprovals: approval.requiredApprovals,
          disallowAuthorApproval: approval.disallowAuthorApproval }
      });
      return mapDraft(inserted.rows[0]);
    });
  }

  async getDraft(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const draftId = normalizeUuid(input.draftId, 'policy draft id');
    const scope = normalizePolicyScope(input.scope);
    const result = await this.pool.query(
      `SELECT d.* FROM nv_governance_policy_drafts d
       JOIN nv_governance_policies p ON p.policy_id=d.policy_id
       WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
         AND d.authored_by_identity_key=$4`,
      [draftId, policyId, scope.scopeKey, actor.identityKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
    return mapDraft(result.rows[0]);
  }

  async updateDraft(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const draftId = normalizeUuid(input.draftId, 'policy draft id');
    const scope = normalizePolicyScope(input.scope);
    const expectedRevision = expectedRevisionOf(input.expectedRevision);
    const { document, documentHash, approval } = normalizedDraftContent(input);
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.draft.update',
      request: { policyId, draftId, expectedRevision, documentHash, approval }
    }, async client => {
      const found = await client.query(
        `SELECT d.*,p.scope_key FROM nv_governance_policy_drafts d
         JOIN nv_governance_policies p ON p.policy_id=d.policy_id
         WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
           AND d.authored_by_identity_key=$4 FOR UPDATE`,
        [draftId, policyId, scope.scopeKey, actor.identityKey]
      );
      const draft = found.rows[0];
      if (!draft) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
      if (Number(draft.revision) !== expectedRevision) {
        throw new GovernanceError('Policy draft changed; reload before saving', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409, {
          expectedRevision, currentRevision: Number(draft.revision)
        });
      }
      const updated = await client.query(
        `UPDATE nv_governance_policy_drafts
         SET revision=revision+1,document=$1::jsonb,document_hash=$2,required_approvals=$3,
             disallow_author_approval=$4,authored_by_login=$5,updated_at=$6
         WHERE draft_id=$7 AND revision=$8 RETURNING *`,
        [JSON.stringify(document), documentHash, approval.requiredApprovals, approval.disallowAuthorApproval,
         actor.login, this.now().toISOString(), draftId, expectedRevision]
      );
      if (!updated.rowCount) throw new GovernanceError('Policy draft changed during save', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409);
      const nextRevision = expectedRevision + 1;
      await this.appendAudit(client, {
        policyId, scopeKey: scope.scopeKey, eventType: 'draft.updated', actor,
        details: { draftId, previousRevision: expectedRevision, revision: nextRevision, documentHash,
          requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
      });
      return mapDraft(updated.rows[0]);
    });
  }

  async submitDraft(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const draftId = normalizeUuid(input.draftId, 'policy draft id');
    const scope = normalizePolicyScope(input.scope);
    const expectedRevision = expectedRevisionOf(input.expectedRevision);
    const versionId = normalizeUuid(this.idFactory(), 'policy version id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.draft.submit',
      request: { policyId, draftId, expectedRevision }
    }, async client => {
      const found = await client.query(
        `SELECT d.*,p.scope_key FROM nv_governance_policy_drafts d
         JOIN nv_governance_policies p ON p.policy_id=d.policy_id
         WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
           AND d.authored_by_identity_key=$4 FOR UPDATE`,
        [draftId, policyId, scope.scopeKey, actor.identityKey]
      );
      const draft = found.rows[0];
      if (!draft) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
      if (Number(draft.revision) !== expectedRevision) {
        throw new GovernanceError('Policy draft changed; reload before submitting', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409, {
          expectedRevision, currentRevision: Number(draft.revision)
        });
      }
      const document = normalizePolicyDocument(draft.document);
      const documentHash = policyDocumentHash(document);
      if (documentHash !== draft.document_hash) {
        throw new GovernanceError('Stored policy draft failed its integrity check', 'GOVERNANCE_DRAFT_INTEGRITY_FAILED', 500);
      }
      const approval = normalizeApprovalPolicy({
        requiredApprovals: Number(draft.required_approvals),
        disallowAuthorApproval: !!draft.disallow_author_approval
      });
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
      const maxResult = await client.query(
        'SELECT COALESCE(MAX(version_number),0)::int AS version_number FROM nv_governance_policy_versions WHERE policy_id=$1',
        [policyId]
      );
      const versionNumber = Number(maxResult.rows[0] && maxResult.rows[0].version_number || 0) + 1;
      const inserted = await client.query(
        `INSERT INTO nv_governance_policy_versions(
          version_id,policy_id,version_number,document,document_hash,authored_by_identity_key,authored_by_login,
          required_approvals,disallow_author_approval,created_at
         ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [versionId, policyId, versionNumber, JSON.stringify(document), documentHash, actor.identityKey, actor.login,
         approval.requiredApprovals, approval.disallowAuthorApproval, this.now().toISOString()]
      );
      const removed = await client.query(
        'DELETE FROM nv_governance_policy_drafts WHERE draft_id=$1 AND revision=$2',
        [draftId, expectedRevision]
      );
      if (!removed.rowCount) throw new GovernanceError('Policy draft changed during submission', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409);
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: scope.scopeKey, eventType: 'version.created', actor,
        details: { sourceDraftId: draftId, versionNumber, documentHash,
          requiredApprovals: approval.requiredApprovals, disallowAuthorApproval: approval.disallowAuthorApproval }
      });
      return mapVersion(inserted.rows[0]);
    });
  }

  async listVersions(input = {}) {
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const scope = normalizePolicyScope(input.scope);
    const capped = boundedListLimit(input.limit);
    const result = await this.pool.query(
      `SELECT v.* FROM nv_governance_policy_versions v
       JOIN nv_governance_policies p ON p.policy_id=v.policy_id
       WHERE v.policy_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL
       ORDER BY v.version_number DESC,v.created_at DESC LIMIT $3`,
      [policyId, scope.scopeKey, capped]
    );
    return result.rows.map(mapVersion);
  }

  async getVersionInScope(input = {}) {
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const scope = normalizePolicyScope(input.scope);
    const result = await this.pool.query(
      `SELECT v.* FROM nv_governance_policy_versions v
       JOIN nv_governance_policies p ON p.policy_id=v.policy_id
       WHERE v.version_id=$1 AND v.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL`,
      [versionId, policyId, scope.scopeKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Policy version was not found', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
    return mapVersion(result.rows[0]);
  }


  async reviewVersionInScope(client, input) {
    const result = await client.query(
      `SELECT v.policy_id,v.version_id,v.version_number,v.authored_by_identity_key,v.authored_by_login,
              v.required_approvals,v.disallow_author_approval,p.scope_key,
              EXISTS(SELECT 1 FROM nv_governance_activations a WHERE a.version_id=v.version_id) AS has_activation
       FROM nv_governance_policy_versions v
       JOIN nv_governance_policies p ON p.policy_id=v.policy_id
       WHERE v.policy_id=$1 AND v.version_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL`,
      [input.policyId, input.versionId, input.scopeKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Policy version was not found', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
    return result.rows[0];
  }

  async reviewRows(client, versionId) {
    const assignments = await client.query(
      `SELECT assignment_id,policy_id,version_id,reviewer_identity_key,reviewer_login,
              reviewer_access_level,reviewer_provider_role,authorization_source,
              authorization_fetched_at,authorization_expires_at,created_at
       FROM nv_governance_review_assignments
       WHERE version_id=$1 ORDER BY created_at ASC,assignment_id ASC`,
      [versionId]
    );
    const decisions = await client.query(
      `SELECT approval_id,version_id,assignment_id,decision,actor_identity_key,actor_login,rationale,
              reviewer_access_level,reviewer_provider_role,authorization_source,
              authorization_fetched_at,authorization_expires_at,created_at
       FROM nv_governance_approvals
       WHERE version_id=$1 AND assignment_id IS NOT NULL ORDER BY created_at ASC,approval_id ASC`,
      [versionId]
    );
    return { assignments: assignments.rows, decisions: decisions.rows };
  }

  async getReviewState(input = {}) {
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const scope = normalizePolicyScope(input.scope);
    const version = await this.reviewVersionInScope(this.pool, { policyId, versionId, scopeKey: scope.scopeKey });
    const rows = await this.reviewRows(this.pool, versionId);
    return reviewResponse(version, rows.assignments, rows.decisions);
  }

  async claimReviewer(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const scope = normalizePolicyScope(input.scope);
    const evidence = authorizationEvidenceOf(input.authorizationEvidence, this.now());
    const assignmentId = normalizeUuid(this.idFactory(), 'review assignment id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.reviewer.assign',
      request: { policyId, versionId }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
      authorizationEvidenceOf(evidence, this.now());
      const version = await this.reviewVersionInScope(client, { policyId, versionId, scopeKey: scope.scopeKey });
      const rows = await this.reviewRows(client, versionId);
      const current = reviewResponse(version, rows.assignments, rows.decisions);
      if (version.has_activation) throw new GovernanceError('Review assignments are frozen after activation', 'GOVERNANCE_VERSION_FINALIZED', 409);
      if (current.terminal) throw new GovernanceError('The policy review is already final', 'GOVERNANCE_REVIEW_FINALIZED', 409, { status: current.status });
      if (version.disallow_author_approval && version.authored_by_identity_key === actor.identityKey) {
        throw new GovernanceError('The policy author cannot review this version', 'GOVERNANCE_AUTHOR_REVIEW_FORBIDDEN', 403);
      }
      const existing = rows.assignments.find(row => row.reviewer_identity_key === actor.identityKey);
      if (existing) return { assignment: mapReviewAssignment(existing), review: current };
      if (rows.assignments.length >= 25) {
        throw new GovernanceError('The policy version has reached the reviewer assignment limit', 'GOVERNANCE_REVIEWER_LIMIT_REACHED', 409);
      }
      const inserted = await client.query(
        `INSERT INTO nv_governance_review_assignments(
          assignment_id,policy_id,version_id,reviewer_identity_key,reviewer_login,
          reviewer_access_level,reviewer_provider_role,authorization_source,
          authorization_fetched_at,authorization_expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [assignmentId, policyId, versionId, actor.identityKey, actor.login, evidence.accessLevel,
         evidence.providerRole, evidence.source, evidence.fetchedAt, evidence.expiresAt, this.now().toISOString()]
      );
      const assignment = inserted.rows[0];
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: scope.scopeKey, eventType: 'reviewer.assigned', actor,
        details: {
          assignmentId,
          reviewerAccessLevel: evidence.accessLevel,
          reviewerProviderRole: evidence.providerRole,
          authorizationSource: evidence.source,
          authorizationFetchedAt: evidence.fetchedAt,
          authorizationExpiresAt: evidence.expiresAt
        }
      });
      return {
        assignment: mapReviewAssignment(assignment),
        review: reviewResponse(version, [...rows.assignments, assignment], rows.decisions)
      };
    });
  }

  async recordReviewDecision(input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const scope = normalizePolicyScope(input.scope);
    const evidence = authorizationEvidenceOf(input.authorizationEvidence, this.now());
    const decision = String(input.decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(decision)) throw new GovernanceError('Decision must be approve or reject', 'GOVERNANCE_DECISION_INVALID');
    const rationale = optionalText(input.rationale, 'Decision rationale', 4000);
    if (REVIEW_SENSITIVE_TEXT_RX.test(rationale)) {
      throw new GovernanceError('Decision rationale appears to contain sensitive credential material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
    }
    if (decision === 'reject' && !rationale) {
      throw new GovernanceError('A rejection rationale is required', 'GOVERNANCE_REJECTION_RATIONALE_REQUIRED', 400);
    }
    const approvalId = normalizeUuid(this.idFactory(), 'approval id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.approval.decide',
      request: { policyId, versionId, decision, rationale }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
      authorizationEvidenceOf(evidence, this.now());
      const version = await this.reviewVersionInScope(client, { policyId, versionId, scopeKey: scope.scopeKey });
      const rows = await this.reviewRows(client, versionId);
      const current = reviewResponse(version, rows.assignments, rows.decisions);
      if (version.has_activation) throw new GovernanceError('Review decisions are frozen after activation', 'GOVERNANCE_VERSION_FINALIZED', 409);
      if (current.terminal) throw new GovernanceError('The policy review is already final', 'GOVERNANCE_REVIEW_FINALIZED', 409, { status: current.status });
      if (version.disallow_author_approval && version.authored_by_identity_key === actor.identityKey) {
        throw new GovernanceError('The policy author cannot review this version', 'GOVERNANCE_AUTHOR_REVIEW_FORBIDDEN', 403);
      }
      const assignment = rows.assignments.find(row => row.reviewer_identity_key === actor.identityKey);
      if (!assignment) throw new GovernanceError('The current reviewer is not assigned to this version', 'GOVERNANCE_REVIEWER_NOT_ASSIGNED', 403);
      const inserted = await client.query(
        `INSERT INTO nv_governance_approvals(
          approval_id,version_id,assignment_id,decision,actor_identity_key,actor_login,rationale,
          reviewer_access_level,reviewer_provider_role,authorization_source,
          authorization_fetched_at,authorization_expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [approvalId, versionId, assignment.assignment_id, decision, actor.identityKey, actor.login, rationale,
         evidence.accessLevel, evidence.providerRole, evidence.source, evidence.fetchedAt, evidence.expiresAt,
         this.now().toISOString()]
      );
      const recorded = inserted.rows[0];
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: scope.scopeKey, eventType: 'approval.recorded', actor,
        details: {
          assignmentId: assignment.assignment_id,
          decision,
          rationale: rationale.slice(0, 1000),
          reviewerAccessLevel: evidence.accessLevel,
          reviewerProviderRole: evidence.providerRole,
          authorizationSource: evidence.source,
          authorizationFetchedAt: evidence.fetchedAt,
          authorizationExpiresAt: evidence.expiresAt
        }
      });
      return {
        decision: mapReviewDecision(recorded),
        review: reviewResponse(version, rows.assignments, [...rows.decisions, recorded])
      };
    });
  }

  async activateVersion(input) {
    return this.changeActiveVersion('activate', input);
  }

  async rollbackVersion(input) {
    return this.changeActiveVersion('rollback', input);
  }

  async changeActiveVersion(action, input = {}) {
    const actor = actorOf(input.actor);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const scope = normalizePolicyScope(input.scope);
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new GovernanceError('Expected policy revision is invalid', 'GOVERNANCE_REVISION_INVALID');
    const reason = requiredText(input.reason, action === 'rollback' ? 'Rollback reason' : 'Activation reason', 4000);
    if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Activation reason appears to contain sensitive credential material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
    const authorization = activationAuthorizationEvidenceOf(input.authorizationEvidence, this.now());
    const simulation = activationSimulationEvidenceOf(input.simulationEvidence, input.expectedSimulationHash);
    const activationId = normalizeUuid(this.idFactory(), 'activation id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: action === 'rollback' ? 'governance.policy.rollback' : 'governance.policy.activate',
      request: { policyId, versionId, expectedRevision, reason, simulationHash: simulation.simulationHash }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
      activationAuthorizationEvidenceOf(authorization, this.now());
      const found = await client.query(
        `SELECT v.*,p.scope_key,h.active_version_id,h.revision,av.document_hash AS active_document_hash
         FROM nv_governance_policy_versions v
         JOIN nv_governance_policies p ON p.policy_id=v.policy_id
         JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
         LEFT JOIN nv_governance_policy_versions av ON av.version_id=h.active_version_id
         WHERE v.version_id=$1 AND v.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
         FOR UPDATE OF h`,
        [versionId, policyId, scope.scopeKey]
      );
      const state = found.rows[0];
      if (!state) throw new GovernanceError('Policy version was not found in this repository policy', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
      const currentRevision = Number(state.revision || 0);
      if (currentRevision !== expectedRevision) {
        throw new GovernanceError('Policy state changed; reload before activating', 'GOVERNANCE_REVISION_CONFLICT', 409, { expectedRevision, currentRevision });
      }
      if (String(state.active_version_id || '') === versionId) throw new GovernanceError('Policy version is already active', 'GOVERNANCE_VERSION_ALREADY_ACTIVE', 409);
      if (simulation.scope.scopeKey !== scope.scopeKey || simulation.proposed.versionId !== versionId || simulation.proposed.documentHash !== state.document_hash) {
        throw new GovernanceError('Simulation evidence does not match the proposed policy version', 'GOVERNANCE_SIMULATION_MISMATCH', 409);
      }
      const expectedBaselineKind = state.active_version_id ? 'active-version' : 'no-policy';
      const expectedBaselineDocumentHash = state.active_version_id
        ? state.active_document_hash
        : policyDocumentHash({ schemaVersion: 1, rules: [] });
      if (simulation.baseline.kind !== expectedBaselineKind ||
          simulation.baseline.versionId !== (state.active_version_id || null) ||
          simulation.baseline.documentHash !== expectedBaselineDocumentHash) {
        throw new GovernanceError('Simulation evidence is stale for the current active policy', 'GOVERNANCE_SIMULATION_STALE', 409);
      }
      if (action === 'activate' && !state.active_version_id) {
        const activeCount = await client.query(
          `SELECT count(*)::int AS active_policy_count
           FROM nv_governance_policies p
           JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
           WHERE p.scope_key=$1 AND p.archived_at IS NULL AND h.active_version_id IS NOT NULL`,
          [scope.scopeKey]
        );
        if (Number(activeCount.rows[0] && activeCount.rows[0].active_policy_count || 0) >= 100) {
          throw new GovernanceError(
            'This repository has reached the supported active-policy limit',
            'GOVERNANCE_ACTIVE_POLICY_LIMIT_REACHED',
            409,
            { maximum: 100 }
          );
        }
      }

      let rollbackSourceActivationId = null;
      if (action === 'rollback') {
        const prior = await client.query(
          `SELECT a.activation_id FROM nv_governance_activations a
           JOIN nv_governance_activation_evidence e ON e.activation_id=a.activation_id
           WHERE a.policy_id=$1 AND a.version_id=$2
           ORDER BY a.resulting_revision DESC,a.created_at DESC LIMIT 1`,
          [policyId, versionId]
        );
        if (!prior.rows[0]) throw new GovernanceError('Rollback target has no prior evidence-backed activation', 'GOVERNANCE_ROLLBACK_TARGET_INVALID', 409);
        rollbackSourceActivationId = prior.rows[0].activation_id;
      } else {
        const prior = await client.query(
          `SELECT 1 FROM nv_governance_activations a
           JOIN nv_governance_activation_evidence e ON e.activation_id=a.activation_id
           WHERE a.policy_id=$1 AND a.version_id=$2 LIMIT 1`,
          [policyId, versionId]
        );
        if (prior.rows[0]) throw new GovernanceError('Previously active versions must use the rollback workflow', 'GOVERNANCE_USE_ROLLBACK', 409);
        const rows = await this.reviewRows(client, versionId);
        const review = reviewResponse(state, rows.assignments, rows.decisions);
        if (review.status === 'rejected') throw new GovernanceError('A rejected policy version cannot be activated', 'GOVERNANCE_VERSION_REJECTED', 409);
        if (review.status !== 'approved') {
          throw new GovernanceError('Policy version does not have final approval', 'GOVERNANCE_APPROVALS_REQUIRED', 409, { approvals: review.approvalCount, requiredApprovals: review.requiredApprovals });
        }
      }

      const resultingRevision = currentRevision + 1;
      const createdAt = this.now().toISOString();
      const activation = await client.query(
        `INSERT INTO nv_governance_activations(
          activation_id,policy_id,version_id,previous_version_id,action,expected_revision,resulting_revision,
          actor_identity_key,actor_login,reason,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [activationId, policyId, versionId, state.active_version_id || null, action, currentRevision, resultingRevision,
         actor.identityKey, actor.login, reason, createdAt]
      );
      const head = await client.query(
        `UPDATE nv_governance_policy_heads
         SET active_version_id=$1,revision=$2,updated_at=$5
         WHERE policy_id=$3 AND revision=$4
         RETURNING active_version_id,revision,updated_at`,
        [versionId, resultingRevision, policyId, currentRevision, createdAt]
      );
      if (!head.rowCount) throw new GovernanceError('Policy state changed during activation', 'GOVERNANCE_REVISION_CONFLICT', 409);
      await client.query(
        `INSERT INTO nv_governance_activation_evidence(
          activation_id,policy_id,version_id,scope_key,simulation_schema_version,simulation_engine_version,
          simulation_hash,scenario_set_hash,result_hash,proposed_document_hash,baseline_kind,baseline_version_id,
          baseline_document_hash,scenario_count,strengthened_count,relaxed_count,changed_count,
          rollback_source_activation_id,actor_access_level,actor_provider_role,authorization_source,
          authorization_fetched_at,authorization_expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [activationId, policyId, versionId, scope.scopeKey, simulation.schemaVersion, simulation.engineVersion,
         simulation.simulationHash, simulation.scenarioSetHash, simulation.resultHash, simulation.proposed.documentHash,
         simulation.baseline.kind, simulation.baseline.versionId, simulation.baseline.documentHash,
         simulation.summary.scenarioCount, simulation.summary.strengthenedCount, simulation.summary.relaxedCount,
         simulation.summary.changedCount, rollbackSourceActivationId, authorization.accessLevel, authorization.providerRole,
         authorization.source, authorization.fetchedAt, authorization.expiresAt, createdAt]
      );
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: scope.scopeKey,
        eventType: action === 'rollback' ? 'policy.rolled-back' : 'policy.activated', actor,
        details: {
          action,
          activationId,
          previousVersionId: state.active_version_id || null,
          rollbackSourceActivationId,
          versionNumber: Number(state.version_number),
          expectedRevision: currentRevision,
          resultingRevision,
          simulationHash: simulation.simulationHash,
          scenarioSetHash: simulation.scenarioSetHash,
          resultHash: simulation.resultHash,
          proposedDocumentHash: simulation.proposed.documentHash,
          baselineKind: simulation.baseline.kind,
          baselineVersionId: simulation.baseline.versionId,
          baselineDocumentHash: simulation.baseline.documentHash,
          scenarioCount: simulation.summary.scenarioCount,
          strengthenedCount: simulation.summary.strengthenedCount,
          relaxedCount: simulation.summary.relaxedCount,
          changedCount: simulation.summary.changedCount,
          authorizationSource: authorization.source,
          authorizationFetchedAt: authorization.fetchedAt,
          authorizationExpiresAt: authorization.expiresAt,
          reason: reason.slice(0, 1000)
        }
      });
      return {
        activationId: activation.rows[0].activation_id,
        policyId,
        versionId,
        previousVersionId: state.active_version_id || null,
        rollbackSourceActivationId,
        action,
        revision: Number(head.rows[0].revision),
        simulationHash: simulation.simulationHash,
        updatedAt: head.rows[0].updated_at
      };
    });
  }

  async exceptionRowInScope(client, input = {}, lock = false) {
    const exceptionId = normalizeUuid(input.exceptionId, 'exception id');
    const scope = normalizePolicyScope(input.scope);
    const result = await client.query(
      `SELECT r.*,v.version_number,h.active_version_id,h.revision AS current_head_revision
       FROM nv_governance_exception_requests r
       JOIN nv_governance_policies p ON p.policy_id=r.policy_id
       JOIN nv_governance_policy_versions v ON v.policy_id=r.policy_id AND v.version_id=r.version_id
       JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id
       WHERE r.exception_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL
       ${lock ? 'FOR SHARE OF r,p,v,h' : ''}`,
      [exceptionId, scope.scopeKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Exception request was not found in this repository scope', 'GOVERNANCE_EXCEPTION_NOT_FOUND', 404);
    return result.rows[0];
  }

  async exceptionEventRows(client, exceptionId) {
    const result = await client.query(
      `SELECT * FROM nv_governance_exception_events
       WHERE exception_id=$1 ORDER BY created_at ASC,event_id ASC`,
      [exceptionId]
    );
    return result.rows || [];
  }

  async createExceptionRequest(input = {}) {
    const actor = actorOf(input.actor);
    const scope = normalizePolicyScope(input.scope);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 30, this.now());
    const exceptionId = normalizeUuid(this.idFactory(), 'exception id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey,
      scopeKey: scope.scopeKey,
      actorIdentityKey: actor.identityKey,
      operation: 'governance.exception.request',
      request: { policyId, versionId, input: input.request }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
      const versionResult = await client.query(
        `SELECT p.scope_key,h.active_version_id,h.revision AS current_head_revision,v.version_number,v.document,v.document_hash
         FROM nv_governance_policies p
         JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
         JOIN nv_governance_policy_versions v ON v.policy_id=p.policy_id AND v.version_id=$2
         WHERE p.policy_id=$1 AND p.scope_key=$3 AND p.archived_at IS NULL
         FOR SHARE OF p,h,v`,
        [policyId, versionId, scope.scopeKey]
      );
      const version = versionResult.rows[0];
      if (!version) throw new GovernanceError('Policy version was not found in this repository scope', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
      if (version.active_version_id !== versionId) throw new GovernanceError('Exceptions can target only the currently active policy version', 'GOVERNANCE_EXCEPTION_VERSION_INACTIVE', 409);
      const operationTime = this.now();
      const authorization = exceptionAuthorizationEvidenceOf(initialAuthorization, 30, operationTime);
      const request = normalizeExceptionRequest(input.request, version.document, operationTime);
      if (request.documentHash !== version.document_hash) throw new GovernanceError('Active policy version failed its document integrity check', 'GOVERNANCE_DOCUMENT_HASH_INVALID', 500);
      const inserted = await client.query(
        `INSERT INTO nv_governance_exception_requests(
          exception_id,scope_key,policy_id,version_id,document_hash,head_revision,kind,action,rule_ids,target,target_hash,reason,
          requested_by_identity_key,requested_by_login,authorization_access_level,authorization_provider_role,
          authorization_source,authorization_fetched_at,authorization_expires_at,expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [exceptionId, scope.scopeKey, policyId, versionId, request.documentHash, Number(version.current_head_revision), request.kind, request.action,
         JSON.stringify(request.ruleIds), JSON.stringify(request.target), request.targetHash, request.reason, actor.identityKey, actor.login, authorization.accessLevel,
         authorization.providerRole, authorization.source, authorization.fetchedAt, authorization.expiresAt,
         request.expiresAt, operationTime.toISOString()]
      );
      await this.appendAudit(client, {
        policyId, versionId, scopeKey: scope.scopeKey, eventType: 'exception.requested', actor,
        details: { exceptionId, kind: request.kind, action: request.action, ruleIds: request.ruleIds, targetHash: request.targetHash, expiresAt: request.expiresAt, documentHash: request.documentHash }
      });
      return mapExceptionRequest({ ...inserted.rows[0], version_number: version.version_number, active_version_id: version.active_version_id, current_head_revision: version.current_head_revision }, [], operationTime);
    });
  }

  async getException(input = {}) {
    const client = await this.pool.connect();
    try {
      const row = await this.exceptionRowInScope(client, input, false);
      const events = await this.exceptionEventRows(client, row.exception_id);
      return mapExceptionRequest(row, events, this.now());
    } finally { client.release(); }
  }

  async listExceptions(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const versionId = normalizeUuid(input.versionId, 'policy version id');
    const limit = boundedListLimit(input.limit);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT r.*,v.version_number,h.active_version_id,h.revision AS current_head_revision
         FROM nv_governance_exception_requests r
         JOIN nv_governance_policies p ON p.policy_id=r.policy_id
         JOIN nv_governance_policy_versions v ON v.policy_id=r.policy_id AND v.version_id=r.version_id
         JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id
         WHERE p.scope_key=$1 AND r.policy_id=$2 AND r.version_id=$3 AND p.archived_at IS NULL
         ORDER BY r.created_at DESC,r.exception_id DESC LIMIT $4`,
        [scope.scopeKey, policyId, versionId, limit]
      );
      const output = [];
      for (const row of result.rows) output.push(mapExceptionRequest(row, await this.exceptionEventRows(client, row.exception_id), this.now()));
      return output;
    } finally { client.release(); }
  }

  async decideException(input = {}) {
    const actor = actorOf(input.actor);
    const scope = normalizePolicyScope(input.scope);
    const exceptionId = normalizeUuid(input.exceptionId, 'exception id');
    const decision = exceptionDecisionOf(input.decision);
    const reason = requiredText(input.reason, 'Exception decision reason', 4000);
    if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Exception decision reason contains sensitive material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
    const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 50, this.now());
    const eventId = normalizeUuid(this.idFactory(), 'exception event id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.exception.decide', request: { exceptionId, decision, reason }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-exception:${exceptionId}`]);
      const row = await this.exceptionRowInScope(client, { exceptionId, scope }, true);
      if (decision === 'approve') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-active-exceptions:${scope.scopeKey}:${row.action}`]);
      }
      const operationTime = this.now();
      const events = await this.exceptionEventRows(client, exceptionId);
      const authorization = exceptionAuthorizationEvidenceOf(initialAuthorization, 50, operationTime);
      const state = computeExceptionState({ request: { versionId: row.version_id, headRevision: Number(row.head_revision), expiresAt: row.expires_at }, events: events.map(mapExceptionEvent), now: operationTime, activeVersionId: row.active_version_id, activeHeadRevision: Number(row.current_head_revision) });
      if (state.status !== 'pending') throw new GovernanceError(`Exception request is ${state.status}`, 'GOVERNANCE_EXCEPTION_NOT_PENDING', 409);
      if (actor.identityKey === row.requested_by_identity_key) throw new GovernanceError('The requester cannot decide their own exception', 'GOVERNANCE_EXCEPTION_SELF_APPROVAL_FORBIDDEN', 403);
      if (decision === 'approve') {
        const countResult = await client.query(
          `SELECT count(*)::int AS active_count
           FROM nv_governance_exception_requests r
           JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id AND h.active_version_id=r.version_id AND h.revision=r.head_revision
           JOIN nv_governance_exception_events approved ON approved.exception_id=r.exception_id AND approved.event_type='approve'
           LEFT JOIN nv_governance_exception_events revoked ON revoked.exception_id=r.exception_id AND revoked.event_type='revoke' AND revoked.created_at<=$3
           WHERE r.scope_key=$1 AND r.action=$2 AND r.expires_at>$3 AND approved.created_at<=$3 AND revoked.event_id IS NULL`,
          [scope.scopeKey, row.action, operationTime.toISOString()]
        );
        if (Number(countResult.rows[0] && countResult.rows[0].active_count || 0) >= 100) {
          throw new GovernanceError(
            'Repository active-exception limit is reached for this mutation action',
            'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED',
            409,
            { maximum: 100, action: row.action }
          );
        }
      }
      const inserted = await client.query(
        `INSERT INTO nv_governance_exception_events(
          event_id,exception_id,policy_id,version_id,event_type,actor_identity_key,actor_login,reason,
          authorization_access_level,authorization_provider_role,authorization_source,
          authorization_fetched_at,authorization_expires_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [eventId, exceptionId, row.policy_id, row.version_id, decision, actor.identityKey, actor.login, reason,
         authorization.accessLevel, authorization.providerRole, authorization.source, authorization.fetchedAt,
         authorization.expiresAt, operationTime.toISOString()]
      );
      await this.appendAudit(client, {
        policyId: row.policy_id, versionId: row.version_id, scopeKey: scope.scopeKey,
        eventType: decision === 'approve' ? 'exception.approved' : 'exception.rejected', actor,
        details: { exceptionId, decision, expiresAt: new Date(row.expires_at).toISOString(), reason: reason.slice(0, 1000) }
      });
      return mapExceptionRequest(row, [...events, inserted.rows[0]], operationTime);
    });
  }

  async revokeException(input = {}) {
    const actor = actorOf(input.actor);
    const scope = normalizePolicyScope(input.scope);
    const exceptionId = normalizeUuid(input.exceptionId, 'exception id');
    const reason = requiredText(input.reason, 'Exception revocation reason', 4000);
    if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Exception revocation reason contains sensitive material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
    const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 50, this.now());
    const eventId = normalizeUuid(this.idFactory(), 'exception event id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.exception.revoke', request: { exceptionId, reason }
    }, async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-exception:${exceptionId}`]);
      const row = await this.exceptionRowInScope(client, { exceptionId, scope }, true);
      const operationTime = this.now();
      const events = await this.exceptionEventRows(client, exceptionId);
      const authorization = exceptionAuthorizationEvidenceOf(initialAuthorization, 50, operationTime);
      const mapped = events.map(mapExceptionEvent);
      if (!mapped.some(event => event.eventType === 'approve') || mapped.some(event => event.eventType === 'revoke')) {
        throw new GovernanceError('Only an approved, unrevoked exception can be revoked', 'GOVERNANCE_EXCEPTION_NOT_REVOCABLE', 409);
      }
      const inserted = await client.query(
        `INSERT INTO nv_governance_exception_events(
          event_id,exception_id,policy_id,version_id,event_type,actor_identity_key,actor_login,reason,
          authorization_access_level,authorization_provider_role,authorization_source,
          authorization_fetched_at,authorization_expires_at,created_at
         ) VALUES($1,$2,$3,$4,'revoke',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [eventId, exceptionId, row.policy_id, row.version_id, actor.identityKey, actor.login, reason,
         authorization.accessLevel, authorization.providerRole, authorization.source, authorization.fetchedAt,
         authorization.expiresAt, operationTime.toISOString()]
      );
      await this.appendAudit(client, {
        policyId: row.policy_id, versionId: row.version_id, scopeKey: scope.scopeKey,
        eventType: 'exception.revoked', actor,
        details: { exceptionId, reason: reason.slice(0, 1000) }
      });
      return mapExceptionRequest(row, [...events, inserted.rows[0]], operationTime);
    });
  }

  async listActivationHistory(input = {}) {
    const policyId = normalizeUuid(input.policyId, 'policy id');
    const scope = normalizePolicyScope(input.scope);
    const capped = boundedListLimit(input.limit);
    const result = await this.pool.query(
      `SELECT a.*,e.simulation_hash,e.scenario_set_hash,e.result_hash,e.proposed_document_hash,
              e.baseline_kind,e.baseline_version_id,e.baseline_document_hash,e.scenario_count,
              e.strengthened_count,e.relaxed_count,e.changed_count,e.rollback_source_activation_id
       FROM nv_governance_activations a
       JOIN nv_governance_policies p ON p.policy_id=a.policy_id
       LEFT JOIN nv_governance_activation_evidence e ON e.activation_id=a.activation_id
       WHERE a.policy_id=$1 AND p.scope_key=$2 AND p.archived_at IS NULL
       ORDER BY a.resulting_revision DESC,a.created_at DESC LIMIT $3`,
      [policyId, scope.scopeKey, capped]
    );
    return result.rows.map(row => ({
      activationId: row.activation_id,
      policyId: row.policy_id,
      versionId: row.version_id,
      previousVersionId: row.previous_version_id || null,
      rollbackSourceActivationId: row.rollback_source_activation_id || null,
      action: row.action,
      expectedRevision: Number(row.expected_revision),
      resultingRevision: Number(row.resulting_revision),
      actorIdentityKey: row.actor_identity_key,
      actorLogin: row.actor_login,
      reason: row.reason,
      simulationHash: row.simulation_hash || null,
      scenarioSetHash: row.scenario_set_hash || null,
      resultHash: row.result_hash || null,
      proposedDocumentHash: row.proposed_document_hash || null,
      baselineKind: row.baseline_kind || null,
      baselineVersionId: row.baseline_version_id || null,
      baselineDocumentHash: row.baseline_document_hash || null,
      scenarioCount: row.scenario_count == null ? null : Number(row.scenario_count),
      strengthenedCount: row.strengthened_count == null ? null : Number(row.strengthened_count),
      relaxedCount: row.relaxed_count == null ? null : Number(row.relaxed_count),
      changedCount: row.changed_count == null ? null : Number(row.changed_count),
      createdAt: row.created_at
    }));
  }


  async evaluateAndAppendPolicyDecision(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const descriptor = input.descriptor;
    if (!descriptor || descriptor.scopeKey !== scope.scopeKey) {
      throw new GovernanceError('Mutation descriptor does not match the governance scope', 'POLICY_DESCRIPTOR_INVALID', 500);
    }
    const decisionId = normalizeUuid(this.idFactory(), 'policy decision id');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
      const active = await client.query(
        `SELECT p.policy_id,p.policy_key,h.active_version_id,h.revision,
                v.version_number,v.document,v.document_hash
         FROM nv_governance_policies p
         JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
         JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id AND v.policy_id=p.policy_id
         WHERE p.scope_key=$1 AND p.archived_at IS NULL AND h.active_version_id IS NOT NULL
         ORDER BY p.policy_key ASC,p.policy_id ASC
         LIMIT 101
         FOR SHARE OF p,h,v`,
        [scope.scopeKey]
      );
      if (active.rows.length > 100) {
        throw new GovernanceError(
          'Repository active-policy limit is exceeded',
          'GOVERNANCE_ACTIVE_POLICY_LIMIT_EXCEEDED',
          503,
          { maximum: 100 }
        );
      }
      const activePolicies = active.rows.map(row => ({
        policyId: row.policy_id,
        policyKey: row.policy_key,
        versionId: row.active_version_id,
        versionNumber: Number(row.version_number),
        headRevision: Number(row.revision),
        document: row.document,
        documentHash: row.document_hash
      }));
      const createdAt = this.now().toISOString();
      const exceptionRows = activePolicies.length ? await client.query(
        `SELECT r.exception_id,r.policy_id,r.version_id,r.document_hash,r.kind,r.action,r.rule_ids,r.target,r.target_hash,
                r.requested_by_identity_key,r.expires_at,e.created_at AS approved_at,e.actor_identity_key AS approved_by_identity_key,e.actor_login AS approved_by_login
         FROM nv_governance_exception_requests r
         JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id AND h.active_version_id=r.version_id AND h.revision=r.head_revision
         JOIN nv_governance_exception_events e ON e.exception_id=r.exception_id AND e.event_type='approve'
         LEFT JOIN nv_governance_exception_events revoked ON revoked.exception_id=r.exception_id AND revoked.event_type='revoke' AND revoked.created_at <= $4
         WHERE r.scope_key=$1 AND r.action=$2 AND r.version_id = ANY($3::uuid[])
           AND r.expires_at > $4 AND e.created_at <= $4 AND revoked.event_id IS NULL
         ORDER BY r.policy_id ASC,r.exception_id ASC
         LIMIT 101`,
        [scope.scopeKey, descriptor.action, activePolicies.map(item => item.versionId), createdAt]
      ) : { rows: [] };
      if (exceptionRows.rows.length > 100) {
        throw new GovernanceError(
          'Repository active-exception limit is exceeded for this mutation action',
          'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED',
          503,
          { maximum: 100, action: descriptor.action }
        );
      }
      const activeExceptions = exceptionRows.rows.map(row => ({
        exceptionId: row.exception_id, policyId: row.policy_id, versionId: row.version_id,
        documentHash: row.document_hash, kind: row.kind, action: row.action, ruleIds: row.rule_ids,
        subjectIdentityKey: row.requested_by_identity_key, target: row.target, targetHash: row.target_hash,
        expiresAt: row.expires_at, approvedAt: row.approved_at,
        approvedByIdentityKey: row.approved_by_identity_key, approvedByLogin: row.approved_by_login
      }));
      const decision = evaluateActivePolicySet({ scope, descriptor, activePolicies, activeExceptions, evaluatedAt: createdAt });
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-policy-decisions:${scope.scopeKey}`]);
      const previous = await client.query(
        `SELECT record_hash FROM nv_governance_policy_decisions
         WHERE scope_key=$1 ORDER BY seq DESC LIMIT 1`,
        [scope.scopeKey]
      );
      const previousHash = previous.rows[0] ? previous.rows[0].record_hash : POLICY_DECISION_GENESIS;
      const decisionHash = sha256Stable(decision);
      const recordHash = decisionRecordHash(this.secret, {
        decisionId,
        mutationId: decision.mutationId,
        scopeKey: scope.scopeKey,
        decisionHash,
        previousHash,
        createdAt
      });
      const storedDecision = normalizePolicyDecision({ ...decision, decisionId, previousHash, recordHash }, descriptor);
      const inserted = await client.query(
        `INSERT INTO nv_governance_policy_decisions(
          decision_id,mutation_id,scope_key,provider,authority,owner,repo,actor_identity_key,actor_login,
          action,category,risk,source,descriptor_hash,policy_set_hash,active_policy_count,effective_effect,rollout_mode,
          enforcement_outcome,warning_codes,block_code,control_mapping,decision,decision_hash,previous_hash,
          record_hash,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,
                  $22::jsonb,$23::jsonb,$24,$25,$26,$27) RETURNING seq`,
        [decisionId, storedDecision.mutationId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo,
         storedDecision.actor.identityKey, storedDecision.actor.login, storedDecision.action, storedDecision.category,
         storedDecision.risk, storedDecision.source, storedDecision.descriptorHash, storedDecision.policySetHash, storedDecision.activePolicyCount,
         storedDecision.effectiveEffect, storedDecision.rolloutMode, storedDecision.enforcementOutcome,
         JSON.stringify(storedDecision.warningCodes), storedDecision.blockCode, JSON.stringify(storedDecision.controlMapping),
         JSON.stringify(decision), decisionHash, previousHash, recordHash, createdAt]
      );
      if (!inserted.rowCount) {
        throw new GovernanceError('Policy decision could not be recorded', 'POLICY_DECISION_PERSISTENCE_FAILED', 500);
      }
      return storedDecision;
    });
  }

  async listPolicyDecisionsInScope(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const limit = boundedDecisionLimit(input.limit, 100, 5000);
    const afterSeq = decisionCursor(input.afterSeq);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const counts = await client.query(
        `SELECT count(*)::int AS total_count,
                count(*) FILTER (WHERE seq > $2)::int AS remaining_count
         FROM nv_governance_policy_decisions WHERE scope_key=$1`,
        [scope.scopeKey, afterSeq]
      );
      const result = await client.query(
        `SELECT seq,decision_id,mutation_id,decision,decision_hash,previous_hash,record_hash,created_at
         FROM nv_governance_policy_decisions
         WHERE scope_key=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [scope.scopeKey, afterSeq, limit]
      );
      const decisions = result.rows.map(row => {
        try {
          const decision = normalizePolicyDecision({
            ...row.decision,
            decisionId: row.decision_id,
            previousHash: row.previous_hash,
            recordHash: row.record_hash
          });
          if (decision.mutationId !== row.mutation_id) throw new Error('mutation mismatch');
          return Object.freeze({
            seq: Number(row.seq),
            ...decision,
            decisionHash: String(row.decision_hash || '').toLowerCase(),
            createdAt: new Date(row.created_at).toISOString()
          });
        } catch {
          throw new GovernanceError('Stored policy decision evidence is invalid', 'POLICY_DECISION_CORRUPT', 500);
        }
      });
      const countRow = counts.rows[0] || {};
      const total = Number(countRow.total_count || 0);
      const remaining = Number(countRow.remaining_count || 0);
      const nextAfterSeq = decisions.length ? decisions[decisions.length - 1].seq : afterSeq;
      const output = Object.freeze({
        decisions: Object.freeze(decisions),
        total,
        remaining,
        afterSeq,
        nextAfterSeq,
        complete: decisions.length === remaining
      });
      await client.query('COMMIT');
      return output;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async verifyPolicyDecisionChainInScope(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const maxRecords = boundedDecisionLimit(input.limit, 50000, 100000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const outcome = await (async () => {
        const countResult = await client.query(
          'SELECT count(*)::int AS total_count FROM nv_governance_policy_decisions WHERE scope_key=$1',
          [scope.scopeKey]
        );
        const total = Number(countResult.rows[0] && countResult.rows[0].total_count || 0);
        let expectedPrevious = POLICY_DECISION_GENESIS;
        let checked = 0;
        let lastSeq = 0;
        while (checked < total && checked < maxRecords) {
          const pageSize = Math.min(500, total - checked, maxRecords - checked);
          const result = await client.query(
            `SELECT seq,decision_id,mutation_id,decision,decision_hash,previous_hash,record_hash,created_at
             FROM nv_governance_policy_decisions
             WHERE scope_key=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
            [scope.scopeKey, lastSeq, pageSize]
          );
          if (!result.rows.length) {
            return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_CHAIN_MISMATCH', firstInvalidSeq: null, headHash: expectedPrevious });
          }
          for (const row of result.rows) {
            const seq = Number(row.seq);
            if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
              return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_CHAIN_MISMATCH', firstInvalidSeq: Number.isFinite(seq) ? seq : null, headHash: expectedPrevious });
            }
            let decision;
            try {
              decision = normalizePolicyDecision(row.decision);
            } catch {
              return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_INVALID', firstInvalidSeq: seq, headHash: expectedPrevious });
            }
            const createdAt = new Date(row.created_at);
            if (!Number.isFinite(createdAt.getTime()) || decision.evaluatedAt !== createdAt.toISOString() ||
                decision.mutationId !== row.mutation_id || String(row.previous_hash || '') !== expectedPrevious) {
              return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_CHAIN_MISMATCH', firstInvalidSeq: seq, headHash: expectedPrevious });
            }
            const computedDecisionHash = sha256Stable(decision);
            if (computedDecisionHash !== String(row.decision_hash || '').toLowerCase()) {
              return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_HASH_MISMATCH', firstInvalidSeq: seq, headHash: expectedPrevious });
            }
            const computedRecordHash = decisionRecordHash(this.secret, {
              decisionId: row.decision_id,
              mutationId: row.mutation_id,
              scopeKey: scope.scopeKey,
              decisionHash: computedDecisionHash,
              previousHash: expectedPrevious,
              createdAt: createdAt.toISOString()
            });
            if (computedRecordHash !== String(row.record_hash || '').toLowerCase()) {
              return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_RECORD_HASH_MISMATCH', firstInvalidSeq: seq, headHash: expectedPrevious });
            }
            expectedPrevious = computedRecordHash;
            checked += 1;
            lastSeq = seq;
          }
        }
        const complete = checked === total;
        return Object.freeze({
          valid: true,
          checked,
          total,
          complete,
          reasonCode: complete ? null : 'POLICY_DECISION_VERIFICATION_LIMIT',
          firstInvalidSeq: null,
          headHash: expectedPrevious
        });
      })();
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async getDigitalTwinReadModelData(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const options = normalizeDigitalTwinOptions({ historyLimit: input.historyLimit, afterDecisionSeq: input.afterDecisionSeq });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await client.query('SELECT transaction_timestamp() AS as_of');
      const asOf = snapshot.rows[0] && snapshot.rows[0].as_of;
      const policyLimit = 201;
      const versionLimit = 1001;
      const pageLimit = options.historyLimit + 1;
      const policiesResult = await client.query(
        `SELECT p.policy_id,p.policy_key,p.name,p.description,p.created_at,
                h.active_version_id,COALESCE(h.revision,0) AS revision,COALESCE(h.updated_at,p.created_at) AS updated_at,
                av.version_number AS active_version_number,av.document_hash AS active_document_hash,
                COALESCE(av.document->'enforcement'->>'mode','observe') AS active_enforcement_mode,
                count(*) OVER()::integer AS total_policy_count,
                count(*) FILTER (WHERE h.active_version_id IS NOT NULL) OVER()::integer AS total_active_policy_count
           FROM nv_governance_policies p
           LEFT JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
           LEFT JOIN nv_governance_policy_versions av ON av.policy_id=p.policy_id AND av.version_id=h.active_version_id
          WHERE p.scope_key=$1 AND p.archived_at IS NULL
          ORDER BY p.policy_key ASC,p.policy_id ASC
          LIMIT $2`,
        [scope.scopeKey, policyLimit]
      );
      const versionsResult = await client.query(
        `SELECT v.policy_id,v.version_id,v.version_number,v.document_hash,v.required_approvals,v.created_at,
                count(DISTINCT a.assignment_id)::integer AS assignment_count,
                count(DISTINCT ap.approval_id) FILTER (WHERE ap.assignment_id IS NOT NULL AND ap.decision='approve')::integer AS approval_count,
                count(DISTINCT ap.approval_id) FILTER (WHERE ap.assignment_id IS NOT NULL AND ap.decision='reject')::integer AS rejection_count,
                ae.simulation_hash,ae.scenario_set_hash,ae.result_hash AS simulation_result_hash,
                ae.created_at AS simulation_evidence_created_at,
                count(*) OVER()::integer AS total_version_count
           FROM nv_governance_policy_versions v
           JOIN nv_governance_policies p ON p.policy_id=v.policy_id
           LEFT JOIN nv_governance_review_assignments a ON a.version_id=v.version_id
           LEFT JOIN nv_governance_approvals ap ON ap.version_id=v.version_id
           LEFT JOIN LATERAL (
             SELECT evidence.simulation_hash,evidence.scenario_set_hash,evidence.result_hash,evidence.created_at
               FROM nv_governance_activation_evidence evidence
              WHERE evidence.policy_id=v.policy_id AND evidence.version_id=v.version_id
              ORDER BY evidence.created_at DESC,evidence.activation_id DESC
              LIMIT 1
           ) ae ON true
          WHERE p.scope_key=$1 AND p.archived_at IS NULL
          GROUP BY v.policy_id,v.version_id,v.version_number,v.document_hash,v.required_approvals,v.created_at,
                   ae.simulation_hash,ae.scenario_set_hash,ae.result_hash,ae.created_at
          ORDER BY v.policy_id ASC,v.version_number DESC,v.version_id ASC
          LIMIT $2`,
        [scope.scopeKey, versionLimit]
      );
      const draftLimit = 501;
      const draftsResult = await client.query(
        `SELECT d.draft_id,d.policy_id,d.revision,d.document_hash,d.authored_by_login,
                d.required_approvals,d.disallow_author_approval,d.created_at,d.updated_at
           FROM nv_governance_policy_drafts d
           JOIN nv_governance_policies p ON p.policy_id=d.policy_id
          WHERE p.scope_key=$1 AND p.archived_at IS NULL
          ORDER BY d.policy_id ASC,d.updated_at DESC,d.draft_id ASC
          LIMIT $2`,
        [scope.scopeKey, draftLimit]
      );
      const exceptionsResult = await client.query(
        `SELECT r.exception_id,r.policy_id,r.version_id,r.kind,r.action,r.expires_at,r.created_at,
                CASE
                  WHEN h.active_version_id IS DISTINCT FROM r.version_id OR h.revision<>r.head_revision THEN 'superseded'
                  WHEN decision.event_type IS NULL THEN 'pending'
                  WHEN decision.event_type='reject' THEN 'rejected'
                  WHEN revoke.event_type='revoke' THEN 'revoked'
                  WHEN r.expires_at<=transaction_timestamp() THEN 'expired'
                  ELSE 'approved'
                END AS state
           FROM nv_governance_exception_requests r
           JOIN nv_governance_policies p ON p.policy_id=r.policy_id AND p.scope_key=r.scope_key
           JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id
           LEFT JOIN LATERAL (
             SELECT e.event_type FROM nv_governance_exception_events e
              WHERE e.exception_id=r.exception_id AND e.event_type IN ('approve','reject')
              ORDER BY e.created_at ASC,e.event_id ASC LIMIT 1
           ) decision ON true
           LEFT JOIN LATERAL (
             SELECT e.event_type FROM nv_governance_exception_events e
              WHERE e.exception_id=r.exception_id AND e.event_type='revoke'
              ORDER BY e.created_at ASC,e.event_id ASC LIMIT 1
           ) revoke ON true
          WHERE r.scope_key=$1
          ORDER BY r.created_at DESC,r.exception_id DESC
          LIMIT $2`,
        [scope.scopeKey, pageLimit]
      );
      const activeExceptionSummaryResult = await client.query(
        `SELECT r.action,count(*)::integer AS active_count
           FROM nv_governance_exception_requests r
           JOIN nv_governance_policy_heads h ON h.policy_id=r.policy_id
           JOIN LATERAL (
             SELECT e.event_type FROM nv_governance_exception_events e
              WHERE e.exception_id=r.exception_id AND e.event_type IN ('approve','reject')
              ORDER BY e.created_at ASC,e.event_id ASC LIMIT 1
           ) decision ON true
           LEFT JOIN LATERAL (
             SELECT e.event_type FROM nv_governance_exception_events e
              WHERE e.exception_id=r.exception_id AND e.event_type='revoke'
              ORDER BY e.created_at ASC,e.event_id ASC LIMIT 1
           ) revoke ON true
          WHERE r.scope_key=$1
            AND h.active_version_id=r.version_id AND h.revision=r.head_revision
            AND decision.event_type='approve' AND revoke.event_type IS NULL
            AND r.expires_at>transaction_timestamp()
          GROUP BY r.action
          ORDER BY r.action ASC`,
        [scope.scopeKey]
      );
      const activationsResult = await client.query(
        `SELECT row_number() OVER (ORDER BY a.created_at ASC,a.activation_id ASC)::bigint AS seq,
                a.policy_id,a.version_id,a.action,a.actor_login,a.created_at,
                ae.simulation_hash,ae.scenario_set_hash,ae.result_hash AS simulation_result_hash
           FROM nv_governance_activations a
           JOIN nv_governance_policies p ON p.policy_id=a.policy_id
           LEFT JOIN nv_governance_activation_evidence ae ON ae.activation_id=a.activation_id
          WHERE p.scope_key=$1
          ORDER BY a.created_at DESC,a.activation_id DESC
          LIMIT $2`,
        [scope.scopeKey, pageLimit]
      );
      const decisionsResult = await client.query(
        `SELECT seq,action,enforcement_outcome,effective_effect,created_at AS evaluated_at,decision_hash
           FROM nv_governance_policy_decisions
          WHERE scope_key=$1 AND seq>$2
          ORDER BY seq ASC
          LIMIT $3`,
        [scope.scopeKey, options.afterDecisionSeq, pageLimit]
      );
      await client.query('COMMIT');
      const policyComplete = policiesResult.rows.length < policyLimit;
      const versionComplete = versionsResult.rows.length < versionLimit;
      const draftComplete = draftsResult.rows.length < draftLimit;
      const exceptionComplete = exceptionsResult.rows.length < pageLimit;
      const activationComplete = activationsResult.rows.length < pageLimit;
      const decisionComplete = decisionsResult.rows.length < pageLimit;
      const decisions = decisionsResult.rows.slice(0, options.historyLimit);
      return {
        asOf: new Date(asOf).toISOString(),
        totals: {
          policies: policiesResult.rows[0] ? Number(policiesResult.rows[0].total_policy_count) : 0,
          activePolicies: policiesResult.rows[0] ? Number(policiesResult.rows[0].total_active_policy_count) : 0,
          versions: versionsResult.rows[0] ? Number(versionsResult.rows[0].total_version_count) : 0
        },
        policies: policiesResult.rows.slice(0, policyLimit - 1),
        versions: versionsResult.rows.slice(0, versionLimit - 1),
        drafts: draftsResult.rows.slice(0, draftLimit - 1),
        exceptions: exceptionsResult.rows.slice(0, options.historyLimit),
        activations: activationsResult.rows.slice(0, options.historyLimit),
        decisions,
        activeExceptionSummary: activeExceptionSummaryResult.rows,
        completeness: {
          policies: policyComplete,
          versions: versionComplete,
          drafts: draftComplete,
          exceptions: exceptionComplete,
          activations: activationComplete,
          decisions: decisionComplete
        },
        nextDecisionSeq: decisions.length ? Number(decisions[decisions.length - 1].seq) : null
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translateDatabaseError(error);
    } finally {
      client.release();
    }
  }


  async eventRows(client, input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const afterSeq = eventCursor(input.afterSeq);
    const throughSeq = input.throughSeq == null || String(input.throughSeq).trim() === '' ? null : eventCursor(input.throughSeq, 'Governance event upper cursor');
    if (throughSeq != null && throughSeq <= afterSeq) throw new GovernanceError('Governance event upper cursor must be greater than the lower cursor', 'GOVERNANCE_CURSOR_INVALID', 400);
    const limit = eventLimit(input.limit, 1001, 100);
    const eventTypes = normalizeEventTypes(input.eventTypes == null ? SUPPORTED_EVENT_TYPES : input.eventTypes, { allowEmpty: true });
    if (!eventTypes.length) return [];
    const result = await client.query(
      `SELECT o.event_seq,o.source_kind,o.source_seq,o.source_id,o.scope_key,o.event_type,o.occurred_at,
              a.policy_id AS lifecycle_policy_id,a.version_id AS lifecycle_version_id,a.actor_login AS lifecycle_actor_login,
              a.details AS lifecycle_details,a.details_hash AS lifecycle_details_hash,a.record_hash AS lifecycle_record_hash,
              p.provider AS lifecycle_provider,p.authority AS lifecycle_authority,p.owner AS lifecycle_owner,p.repo AS lifecycle_repo,
              d.mutation_id AS decision_mutation_id,d.actor_login AS decision_actor_login,d.action AS decision_action,
              d.enforcement_outcome AS decision_enforcement_outcome,d.effective_effect AS decision_effective_effect,
              d.rollout_mode AS decision_rollout_mode,d.decision_hash,d.descriptor_hash AS decision_descriptor_hash,
              d.policy_set_hash AS decision_policy_set_hash,d.control_mapping AS decision_control_mapping,
              d.provider AS decision_provider,d.authority AS decision_authority,d.owner AS decision_owner,d.repo AS decision_repo
         FROM nv_governance_event_outbox o
         LEFT JOIN nv_governance_audit a ON o.source_kind='lifecycle' AND a.seq=o.source_seq AND a.event_id=o.source_id
         LEFT JOIN nv_governance_policies p ON p.policy_id=a.policy_id
         LEFT JOIN nv_governance_policy_decisions d ON o.source_kind='runtime-decision' AND d.seq=o.source_seq AND d.mutation_id=o.source_id
        WHERE o.scope_key=$1 AND o.event_seq>$2 AND ($3::bigint IS NULL OR o.event_seq<=$3)
          AND o.event_type=ANY($4::text[])
        ORDER BY o.event_seq ASC LIMIT $5`,
      [scope.scopeKey, afterSeq, throughSeq, eventTypes, limit]
    );
    return result.rows.map(eventFromJoinedRow);
  }

  async getGovernanceEvent(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const seq = eventCursor(input.eventSeq);
    if (seq < 1) throw new GovernanceError('Governance event sequence is invalid', 'GOVERNANCE_CURSOR_INVALID', 400);
    const rows = await this.eventRows(this.pool, { scope, afterSeq: seq - 1, throughSeq: seq, limit: 1 });
    if (!rows[0]) throw new GovernanceError('Governance event was not found', 'GOVERNANCE_EVENT_NOT_FOUND', 404);
    return rows[0];
  }

  async getNotificationPreferences(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const result = await this.pool.query(
      `SELECT enabled,event_types,last_read_seq,updated_at FROM nv_governance_notification_preferences
       WHERE scope_key=$1 AND identity_key=$2`,
      [scope.scopeKey, actor.identityKey]
    );
    const row = result.rows[0];
    return {
      ...normalizeNotificationPreferences(row ? { enabled: row.enabled, eventTypes: row.event_types } : {}),
      lastReadSeq: row ? Number(row.last_read_seq) : 0,
      updatedAt: row ? row.updated_at : null
    };
  }

  async updateNotificationPreferences(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const preferences = normalizeNotificationPreferences(input.preferences);
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.notification.preferences.update', request: preferences
    }, async client => {
      const result = await client.query(
        `INSERT INTO nv_governance_notification_preferences(scope_key,identity_key,enabled,event_types,last_read_seq,updated_at)
         VALUES($1,$2,$3,$4::jsonb,0,$5)
         ON CONFLICT(scope_key,identity_key) DO UPDATE SET enabled=EXCLUDED.enabled,event_types=EXCLUDED.event_types,updated_at=EXCLUDED.updated_at
         RETURNING enabled,event_types,last_read_seq,updated_at`,
        [scope.scopeKey, actor.identityKey, preferences.enabled, JSON.stringify(preferences.eventTypes), this.now().toISOString()]
      );
      const row = result.rows[0];
      return { ...preferences, lastReadSeq: Number(row.last_read_seq), updatedAt: row.updated_at };
    });
  }

  async markNotificationsRead(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const throughSeq = eventCursor(input.throughSeq, 'Notification read cursor');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.notification.read', request: { throughSeq }
    }, async client => {
      const maximum = await client.query('SELECT COALESCE(max(event_seq),0)::bigint AS max_seq FROM nv_governance_event_outbox WHERE scope_key=$1 AND event_seq<=$2', [scope.scopeKey, throughSeq]);
      const bounded = Number(maximum.rows[0] && maximum.rows[0].max_seq || 0);
      const result = await client.query(
        `INSERT INTO nv_governance_notification_preferences(scope_key,identity_key,enabled,event_types,last_read_seq,updated_at)
         VALUES($1,$2,true,$3::jsonb,$4,$5)
         ON CONFLICT(scope_key,identity_key) DO UPDATE SET last_read_seq=GREATEST(nv_governance_notification_preferences.last_read_seq,EXCLUDED.last_read_seq),updated_at=EXCLUDED.updated_at
         RETURNING enabled,event_types,last_read_seq,updated_at`,
        [scope.scopeKey, actor.identityKey, JSON.stringify(DEFAULT_NOTIFICATION_EVENT_TYPES), bounded, this.now().toISOString()]
      );
      const row = result.rows[0];
      return { ...normalizeNotificationPreferences({ enabled: row.enabled, eventTypes: row.event_types }), lastReadSeq: Number(row.last_read_seq), updatedAt: row.updated_at };
    });
  }

  async listNotifications(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const preferences = await this.getNotificationPreferences({ scope, actor });
    const limit = eventLimit(input.limit, 200, 50);
    const afterSeq = eventCursor(input.afterSeq);
    if (!preferences.enabled || !preferences.eventTypes.length) return { preferences, events: [], unreadCount: 0, nextSeq: null, complete: true };
    const rows = await this.eventRows(this.pool, { scope, afterSeq, limit: limit + 1, eventTypes: preferences.eventTypes });
    const events = rows.slice(0, limit);
    const unread = await this.pool.query(
      `SELECT count(*)::integer AS unread_count FROM nv_governance_event_outbox
       WHERE scope_key=$1 AND event_seq>$2 AND event_type=ANY($3::text[])`,
      [scope.scopeKey, preferences.lastReadSeq, preferences.eventTypes]
    );
    return {
      preferences,
      events,
      unreadCount: Number(unread.rows[0] && unread.rows[0].unread_count || 0),
      nextSeq: events.length ? events[events.length - 1].eventSeq : null,
      complete: rows.length <= limit
    };
  }

  async createWebhook(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const definition = normalizeWebhookDefinition(input.definition);
    const webhookId = normalizeUuid(this.idFactory(), 'webhook id');
    const salt = String(this.saltFactory()).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(salt)) throw new GovernanceError('Webhook salt generator returned invalid output', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.webhook.create', request: definition
    }, async client => {
      const result = await client.query(
        `INSERT INTO nv_governance_webhooks(webhook_id,scope_key,provider,authority,owner,repo,name,endpoint_url,event_types,enabled,secret_salt,secret_version,created_by_identity_key,created_by_login,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,1,$12,$13,$14,$14) RETURNING *`,
        [webhookId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo, definition.name, definition.url,
         JSON.stringify(definition.eventTypes), definition.enabled, salt, actor.identityKey, actor.login, this.now().toISOString()]
      );
      return { webhook: mapWebhook(result.rows[0]), signingSecret: deriveWebhookSigningSecret(this.secret, scope.scopeKey, webhookId, salt, 1) };
    });
  }

  async listWebhooks(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const result = await this.pool.query(
      `SELECT * FROM nv_governance_webhooks WHERE scope_key=$1 AND deleted_at IS NULL ORDER BY created_at ASC,webhook_id ASC LIMIT 100`,
      [scope.scopeKey]
    );
    return result.rows.map(mapWebhook);
  }

  async webhookRowInScope(client, scope, webhookId, lock = false) {
    const id = normalizeUuid(webhookId, 'webhook id');
    const result = await client.query(
      `SELECT * FROM nv_governance_webhooks WHERE webhook_id=$1 AND scope_key=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [id, scope.scopeKey]
    );
    if (!result.rows[0]) throw new GovernanceError('Governance webhook was not found', 'GOVERNANCE_WEBHOOK_NOT_FOUND', 404);
    return result.rows[0];
  }

  async updateWebhook(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const webhookId = normalizeUuid(input.webhookId, 'webhook id');
    const definition = normalizeWebhookDefinition(input.definition);
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.webhook.update', request: { webhookId, definition }
    }, async client => {
      await this.webhookRowInScope(client, scope, webhookId, true);
      const result = await client.query(
        `UPDATE nv_governance_webhooks SET name=$1,endpoint_url=$2,event_types=$3::jsonb,enabled=$4,updated_at=$5
         WHERE webhook_id=$6 AND scope_key=$7 AND deleted_at IS NULL RETURNING *`,
        [definition.name, definition.url, JSON.stringify(definition.eventTypes), definition.enabled, this.now().toISOString(), webhookId, scope.scopeKey]
      );
      return mapWebhook(result.rows[0]);
    });
  }

  async rotateWebhookSecret(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const webhookId = normalizeUuid(input.webhookId, 'webhook id');
    const salt = String(this.saltFactory()).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(salt)) throw new GovernanceError('Webhook salt generator returned invalid output', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.webhook.rotate', request: { webhookId }
    }, async client => {
      const current = await this.webhookRowInScope(client, scope, webhookId, true);
      const version = Number(current.secret_version) + 1;
      const result = await client.query(
        `UPDATE nv_governance_webhooks SET secret_salt=$1,secret_version=$2,updated_at=$3 WHERE webhook_id=$4 AND scope_key=$5 RETURNING *`,
        [salt, version, this.now().toISOString(), webhookId, scope.scopeKey]
      );
      return { webhook: mapWebhook(result.rows[0]), signingSecret: deriveWebhookSigningSecret(this.secret, scope.scopeKey, webhookId, salt, version) };
    });
  }

  async deleteWebhook(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const webhookId = normalizeUuid(input.webhookId, 'webhook id');
    return this.idempotentTransaction({
      idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
      operation: 'governance.webhook.delete', request: { webhookId }
    }, async client => {
      await this.webhookRowInScope(client, scope, webhookId, true);
      const result = await client.query(
        `UPDATE nv_governance_webhooks SET enabled=false,deleted_at=$1,updated_at=$1 WHERE webhook_id=$2 AND scope_key=$3 RETURNING *`,
        [this.now().toISOString(), webhookId, scope.scopeKey]
      );
      return mapWebhook(result.rows[0]);
    });
  }

  async listWebhookDeliveries(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const webhookId = normalizeUuid(input.webhookId, 'webhook id');
    const limit = eventLimit(input.limit, 200, 100);
    const result = await this.pool.query(
      `SELECT d.* FROM nv_governance_webhook_deliveries d
       JOIN nv_governance_webhooks w ON w.webhook_id=d.webhook_id
       WHERE w.scope_key=$1 AND w.webhook_id=$2
       ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT $3`,
      [scope.scopeKey, webhookId, limit]
    );
    return result.rows.map(mapWebhookDelivery);
  }

  async claimWebhookDeliveries(input = {}) {
    const limit = eventLimit(input.limit, 20, 10);
    const leaseSeconds = eventLimit(input.leaseSeconds, 300, 60);
    const result = await this.pool.query(
      `WITH due AS (
         SELECT d.delivery_id FROM nv_governance_webhook_deliveries d
         JOIN nv_governance_webhooks w ON w.webhook_id=d.webhook_id
         WHERE w.enabled=true AND w.deleted_at IS NULL
           AND ((d.status IN ('pending','retry') AND d.next_attempt_at<=now()) OR (d.status='delivering' AND d.lease_until<=now()))
         ORDER BY d.next_attempt_at ASC,d.delivery_id ASC
         FOR UPDATE OF d SKIP LOCKED LIMIT $1
       ), updated AS (
         UPDATE nv_governance_webhook_deliveries d SET status='delivering',lease_until=now()+($2::int * interval '1 second'),updated_at=now()
         FROM due WHERE d.delivery_id=due.delivery_id RETURNING d.*
       )
       SELECT updated.*,w.scope_key,w.provider,w.authority,w.owner,w.repo,w.endpoint_url,w.secret_salt,w.secret_version,w.event_types,w.name
       FROM updated JOIN nv_governance_webhooks w ON w.webhook_id=updated.webhook_id
       ORDER BY updated.next_attempt_at ASC,updated.delivery_id ASC`,
      [limit, leaseSeconds]
    );
    return result.rows.map(row => ({
      ...mapWebhookDelivery(row),
      scope: normalizePolicyScope({ provider: row.provider, baseUrl: `https://${row.authority}`, owner: row.owner, repo: row.repo }),
      url: row.endpoint_url,
      secretSalt: row.secret_salt,
      secretVersion: Number(row.secret_version),
      eventTypes: row.event_types,
      name: row.name
    }));
  }

  async recordWebhookDeliveryAttempt(input = {}) {
    const deliveryId = normalizeUuid(input.deliveryId, 'webhook delivery id');
    const eventHash = requiredText(input.eventHash, 'Webhook event hash', 64).toLowerCase();
    const signatureHash = requiredText(input.signatureHash, 'Webhook signature hash', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(eventHash) || !/^[0-9a-f]{64}$/.test(signatureHash)) throw new GovernanceError('Webhook attempt hashes are invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
    const requestTimestamp = new Date(input.requestTimestamp);
    if (!Number.isFinite(requestTimestamp.getTime())) throw new GovernanceError('Webhook attempt timestamp is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
    const delivered = input.delivered === true;
    const terminal = input.terminal === true;
    const statusCode = input.statusCode == null ? null : Number(input.statusCode);
    if (statusCode != null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) throw new GovernanceError('Webhook status code is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
    const errorCode = input.errorCode == null ? null : requiredText(input.errorCode, 'Webhook error code', 100).toUpperCase();
    if (errorCode && !/^[A-Z][A-Z0-9_]{2,99}$/.test(errorCode)) throw new GovernanceError('Webhook error code is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
    if (!delivered && !errorCode) throw new GovernanceError('Webhook failure requires a bounded error code', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
    return this.transaction(async client => {
      const current = await client.query('SELECT * FROM nv_governance_webhook_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId]);
      const row = current.rows[0];
      if (!row) throw new GovernanceError('Webhook delivery was not found', 'GOVERNANCE_WEBHOOK_DELIVERY_NOT_FOUND', 404);
      if (row.status !== 'delivering') throw new GovernanceError('Webhook delivery is not leased for delivery', 'GOVERNANCE_WEBHOOK_DELIVERY_STATE_INVALID', 409);
      const attemptNumber = Number(row.attempt_count) + 1;
      if (attemptNumber > 5) throw new GovernanceError('Webhook delivery attempt limit was exceeded', 'GOVERNANCE_WEBHOOK_ATTEMPT_LIMIT', 409);
      const operationTime = this.now();
      const resultState = delivered ? 'delivered' : (terminal || attemptNumber >= 5 ? 'dead-letter' : 'retry');
      const attemptId = normalizeUuid(this.idFactory(), 'webhook attempt id');
      await client.query(
        `INSERT INTO nv_governance_webhook_attempts(attempt_id,delivery_id,attempt_number,event_hash,request_timestamp,signature_hash,result,status_code,error_code,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [attemptId, deliveryId, attemptNumber, eventHash, requestTimestamp.toISOString(), signatureHash, resultState, statusCode, errorCode, operationTime.toISOString()]
      );
      const delays = [60, 300, 1800, 7200];
      const nextAttempt = delivered || resultState === 'dead-letter' ? operationTime : new Date(operationTime.getTime() + delays[attemptNumber - 1] * 1000);
      const updated = await client.query(
        `UPDATE nv_governance_webhook_deliveries SET status=$1,attempt_count=$2,next_attempt_at=$3,lease_until=NULL,last_status_code=$4,last_error_code=$5,delivered_at=$6,updated_at=$7
         WHERE delivery_id=$8 RETURNING *`,
        [resultState, attemptNumber, nextAttempt.toISOString(), statusCode, errorCode, delivered ? operationTime.toISOString() : null, operationTime.toISOString(), deliveryId]
      );
      return mapWebhookDelivery(updated.rows[0]);
    });
  }

  async createEvidenceExport(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const actor = actorOf(input.actor);
    const format = String(input.format || '').trim().toLowerCase();
    if (!['json','csv'].includes(format)) throw new GovernanceError('Evidence export format must be json or csv', 'GOVERNANCE_EXPORT_FORMAT_INVALID', 400);
    const afterSeq = eventCursor(input.afterEventSeq);
    const requestedThrough = input.throughEventSeq == null || String(input.throughEventSeq).trim() === '' ? null : eventCursor(input.throughEventSeq, 'Evidence export upper cursor');
    const limit = eventLimit(input.limit, 1000, 1000);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (!idempotencyKey) throw new GovernanceError('Evidence export requires an Idempotency-Key', 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED', 400);
    const keyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
    const requestHash = sha256Stable({ format, afterSeq, requestedThrough, limit });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-export:${scope.scopeKey}:${actor.identityKey}:${keyHash}`]);
      const existing = await client.query(
        `SELECT * FROM nv_governance_exports WHERE scope_key=$1 AND actor_identity_key=$2 AND idempotency_key_hash=$3`,
        [scope.scopeKey, actor.identityKey, keyHash]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new GovernanceError('Idempotency-Key was already used for a different evidence export', 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 409);
        await client.query('COMMIT');
        return exportRowEnvelope(existing.rows[0]);
      }
      const maxResult = await client.query('SELECT COALESCE(max(event_seq),0)::bigint AS max_seq FROM nv_governance_event_outbox WHERE scope_key=$1', [scope.scopeKey]);
      const maximum = Number(maxResult.rows[0] && maxResult.rows[0].max_seq || 0);
      const throughSeq = requestedThrough == null ? maximum : Math.min(requestedThrough, maximum);
      if (throughSeq && throughSeq <= afterSeq) throw new GovernanceError('Evidence export range is empty or invalid', 'GOVERNANCE_EXPORT_RANGE_INVALID', 400);
      const events = throughSeq ? await this.eventRows(client, { scope, afterSeq, throughSeq, limit: limit + 1 }) : [];
      if (events.length > limit) throw new GovernanceError('Evidence export range exceeds the 1000-record limit; create multiple cursor-bounded exports', 'GOVERNANCE_EXPORT_LIMIT', 413);
      const exportId = normalizeUuid(this.idFactory(), 'export id');
      const envelope = buildSignedEvidenceExport({ exportId, generatedAt: this.now().toISOString(), scope, actorLogin: actor.login, events, format, secret: this.secret });
      await client.query(
        `INSERT INTO nv_governance_exports(export_id,scope_key,provider,authority,owner,repo,actor_identity_key,actor_login,idempotency_key_hash,request_hash,export_format,after_event_seq,through_event_seq,record_count,content_hash,manifest,signature,content,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)`,
        [exportId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo, actor.identityKey, actor.login, keyHash, requestHash, format,
         afterSeq, throughSeq || null, envelope.manifest.recordCount, envelope.manifest.contentHash, JSON.stringify(envelope.manifest), JSON.stringify(envelope.signature), envelope.content, envelope.manifest.generatedAt]
      );
      await client.query('COMMIT');
      return envelope;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translateDatabaseError(error);
    } finally { client.release(); }
  }

  async listEvidenceExports(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const limit = eventLimit(input.limit, 200, 100);
    const result = await this.pool.query(
      `SELECT export_id,export_format,after_event_seq,through_event_seq,record_count,content_hash,manifest,signature,actor_login,created_at
       FROM nv_governance_exports WHERE scope_key=$1 ORDER BY created_at DESC,export_id DESC LIMIT $2`,
      [scope.scopeKey, limit]
    );
    return result.rows.map(row => ({ exportId: row.export_id, format: row.export_format, afterEventSeq: Number(row.after_event_seq), throughEventSeq: row.through_event_seq == null ? null : Number(row.through_event_seq), recordCount: Number(row.record_count), contentHash: row.content_hash, manifest: row.manifest, signature: row.signature, actorLogin: row.actor_login, createdAt: row.created_at }));
  }

  async getEvidenceExport(input = {}) {
    const scope = normalizePolicyScope(input.scope);
    const exportId = normalizeUuid(input.exportId, 'export id');
    const result = await this.pool.query('SELECT * FROM nv_governance_exports WHERE export_id=$1 AND scope_key=$2', [exportId, scope.scopeKey]);
    if (!result.rows[0]) throw new GovernanceError('Evidence export was not found', 'GOVERNANCE_EXPORT_NOT_FOUND', 404);
    return exportRowEnvelope(result.rows[0]);
  }

  async verifyEvidenceExport(input = {}) {
    const envelope = await this.getEvidenceExport(input);
    return verifySignedEvidenceExport(envelope, this.secret);
  }

  async getPolicyState(policyId) {
    const id = normalizeUuid(policyId, 'policy id');
    const result = await this.pool.query(
      `SELECT p.*,h.active_version_id,h.revision,h.updated_at,
              v.version_number AS active_version_number,v.document_hash AS active_document_hash
       FROM nv_governance_policies p
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id
       WHERE p.policy_id=$1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) throw new GovernanceError('Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
    return {
      ...mapPolicy(row),
      activeVersionId: row.active_version_id || null,
      activeVersionNumber: row.active_version_number == null ? null : Number(row.active_version_number),
      activeDocumentHash: row.active_document_hash || null,
      revision: Number(row.revision || 0),
      updatedAt: row.updated_at
    };
  }

  async verifyAudit(policyId, limit = 5000) {
    const id = normalizeUuid(policyId, 'policy id');
    const capped = Math.min(Math.max(Number(limit) || 1, 1), 5000);
    const result = await this.pool.query(
      `SELECT seq,event_id,policy_id,version_id,event_type,actor_identity_key,actor_login,details,details_hash,
              previous_hash,record_hash,created_at,count(*) OVER()::int AS total_count
       FROM nv_governance_audit WHERE policy_id=$1 ORDER BY seq ASC LIMIT $2`,
      [id, capped]
    );
    const records = result.rows.map(row => ({
      eventId: row.event_id,
      policyId: row.policy_id,
      versionId: row.version_id,
      eventType: row.event_type,
      actorIdentityKey: row.actor_identity_key,
      actorLogin: row.actor_login,
      details: row.details,
      detailsHash: row.details_hash,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
      createdAt: new Date(row.created_at).toISOString()
    }));
    const verification = verifyGovernanceAuditChain(this.secret, records);
    const total = Number(result.rows[0] && result.rows[0].total_count || 0);
    return { ...verification, total, complete: records.length === total };
  }
}

module.exports = { GovernanceStore, translateDatabaseError };
