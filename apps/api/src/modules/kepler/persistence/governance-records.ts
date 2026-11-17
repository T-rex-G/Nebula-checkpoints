import { createHash, createHmac } from 'node:crypto';
import {
  GovernanceError, normalizeIdentityKey, normalizeUuid, normalizePolicyScope, normalizePolicyDocument,
  normalizeApprovalPolicy, computeGovernanceReviewState, policyDocumentHash
} from '../domain/governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { computeExceptionState } from '../domain/governance-exceptions.ts';
import type { simulatePolicyImpact } from '../domain/governance-simulation.ts';
import { buildGovernanceEvent } from '../delivery/governance-delivery.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { PoolClient, QueryOutcome, Row } from '../../../platform/persistence/queryable.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { property } from '../../../platform/values/fields.ts';

/*
 * The governance store's vocabulary and its records.
 *
 * The checks on what the store is given, the keys its locks and its chains
 * are taken under, and the records each row is read back as: a policy, a
 * version and its review, an activation, an exception, a decision, an event
 * and its delivery, and an export. Database errors are translated here into
 * the store's own. The store in governance-store.ts and its operations
 * stand on this.
 */

export const REVIEW_SENSITIVE_TEXT_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:bearer|token|password|secret)\s*[:=]\s*[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

export type Fields = Readonly<Record<string, unknown>>;

/* The person a governance write is recorded against. */
export interface GovernanceActor {
  readonly identityKey: string;
  readonly login: string;
}

/* The provider's confirmation of a person's access, as a review, activation or exception records it. */
export interface AuthorizationEvidence {
  readonly accessLevel: number;
  readonly providerRole: string;
  readonly source: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

/* One entry of a policy's tamper-evident lifecycle record. */
export interface AuditContext {
  readonly policyId: unknown;
  readonly versionId?: unknown;
  readonly scopeKey: unknown;
  readonly eventType: string;
  readonly actor: GovernanceActor;
  readonly details?: unknown;
}

/* What makes a write replayable: who sent it, on which repository, under which key, with what request. */
export interface IdempotencyContext {
  readonly idempotencyKey?: unknown;
  readonly scopeKey?: unknown;
  readonly actorIdentityKey?: unknown;
  readonly operation?: unknown;
  readonly request?: unknown;
  readonly validateReplay?: ((client: PoolClient, body: unknown) => Promise<void> | void) | null;
}

/* A lifecycle change made under the locks its caller holds. */
export interface LockedChange {
  readonly scope: RepositoryScope;
  readonly state: Row;
  readonly actor: GovernanceActor;
  readonly reason: string;
  readonly resetId?: string | null;
}

export interface GovernanceStoreOptions {
  readonly secret?: unknown;
  readonly idFactory?: () => unknown;
  readonly now?: () => Date;
  readonly saltFactory?: () => unknown;
  readonly simulate?: typeof simulatePolicyImpact;
}

/* A date from a stored or supplied value, by JavaScript's own reading of it; callers check the result is finite. */
export function dateOf(value: unknown): Date {
  return new Date(value as string | number | Date);
}

/* The rows a statement answered with. An answer without them is a failure, as it always was. */
export function rowsOf(result: QueryOutcome): readonly Row[] {
  const rows = result.rows;
  if (!rows) throw new TypeError('the database answered without rows');
  return rows;
}

/* The row a statement that always returns one returned (RETURNING, an aggregate). */
export function onlyRow(result: QueryOutcome): Row {
  const row = rowsOf(result)[0];
  if (!row) throw new TypeError('the database returned no row');
  return row;
}

export function requiredText(value: unknown, label: string, max = 2000): string {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new GovernanceError(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

export function optionalText(value: unknown, label: string, max = 4000): string {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new GovernanceError(`${label} is invalid`, 'GOVERNANCE_INPUT_INVALID');
  }
  return text;
}

export function actorOf(input: unknown): GovernanceActor {
  if (!input || typeof input !== 'object') throw new GovernanceError('Governance actor is required', 'GOVERNANCE_ACTOR_INVALID');
  const fields = input as Fields;
  return {
    identityKey: normalizeIdentityKey(fields.identityKey, 'actor identity'),
    login: requiredText(fields.login, 'Actor login', 200)
  };
}

export function mapPolicy(row: Row) {
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

export function mapVersion(row: Row) {
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

export function mapPolicyState(row: Row) {
  return {
    ...mapPolicy(row),
    activeVersionId: row.active_version_id || null,
    activeVersionNumber: row.active_version_number == null ? null : Number(row.active_version_number),
    activeDocumentHash: row.active_document_hash || null,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at
  };
}

export function mapDraft(row: Row) {
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


export function mapReviewAssignment(row: Row) {
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

export function mapReviewDecision(row: Row) {
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

export function mapExceptionEvent(row: Row) {
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

export function mapExceptionRequest(row: Row, events: readonly Row[] = [], now: Date = new Date()) {
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

export function exceptionAuthorizationEvidenceOf(input: unknown, minimumLevel: number, currentDate: Date = new Date()): AuthorizationEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Exception authorization evidence is required', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  const fields = input as Fields;
  const accessLevel = Number(fields.accessLevel);
  if (![30, 40, 50].includes(accessLevel) || accessLevel < minimumLevel) {
    throw new GovernanceError('Current repository authorization is required for this exception operation', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(fields.providerRole, 'Exception provider role', 120);
  const source = requiredText(fields.source, 'Exception authorization source', 120);
  const fetchedAt = dateOf(fields.fetchedAt);
  const expiresAt = dateOf(fields.expiresAt);
  const currentTime = new Date(currentDate).getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(currentTime) ||
      expiresAt <= fetchedAt || expiresAt.getTime() <= currentTime || fetchedAt.getTime() > currentTime + 30 * 1000) {
    throw new GovernanceError('Exception authorization evidence is invalid or stale', 'GOVERNANCE_EXCEPTION_AUTHORIZATION_INVALID', 403);
  }
  return { accessLevel, providerRole, source, fetchedAt: fetchedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

export function exceptionDecisionOf(value: unknown): 'approve' | 'reject' {
  const decision = String(value || '').trim().toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') throw new GovernanceError('Exception decision must be approve or reject', 'GOVERNANCE_EXCEPTION_DECISION_INVALID');
  return decision;
}

export function authorizationEvidenceOf(input: unknown, currentDate: Date = new Date()): AuthorizationEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Reviewer authorization evidence is required', 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID', 403);
  }
  const fields = input as Fields;
  const accessLevel = Number(fields.accessLevel);
  if (![40, 50].includes(accessLevel)) {
    throw new GovernanceError('Current reviewer authorization is required', 'GOVERNANCE_REVIEW_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(fields.providerRole, 'Reviewer provider role', 120);
  const source = requiredText(fields.source, 'Reviewer authorization source', 120);
  const fetchedAt = dateOf(fields.fetchedAt);
  const expiresAt = dateOf(fields.expiresAt);
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

export function activationAuthorizationEvidenceOf(input: unknown, currentDate: Date = new Date()): AuthorizationEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Activator authorization evidence is required', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  const fields = input as Fields;
  const accessLevel = Number(fields.accessLevel);
  if (accessLevel !== 50) {
    throw new GovernanceError('Current repository administrator authorization is required', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  const providerRole = requiredText(fields.providerRole, 'Activator provider role', 120);
  const source = requiredText(fields.source, 'Activator authorization source', 120);
  const fetchedAt = dateOf(fields.fetchedAt);
  const expiresAt = dateOf(fields.expiresAt);
  const currentTime = new Date(currentDate).getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || !Number.isFinite(currentTime) ||
      expiresAt <= fetchedAt || expiresAt.getTime() <= currentTime || fetchedAt.getTime() > currentTime + 30 * 1000) {
    throw new GovernanceError('Activator authorization evidence is invalid or stale', 'GOVERNANCE_ACTIVATION_AUTHORIZATION_INVALID', 403);
  }
  return { accessLevel, providerRole, source, fetchedAt: fetchedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

export function activationSimulationEvidenceOf(input: unknown, expectedSimulationHash: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceError('Simulation evidence is required', 'GOVERNANCE_SIMULATION_REQUIRED', 400);
  }
  const fields = input as Fields;
  const hash = (value: unknown): string => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!isSha256Hex(normalized)) throw new GovernanceError('Simulation evidence hash is invalid', 'GOVERNANCE_SIMULATION_INVALID', 400);
    return normalized;
  };
  const simulationHash = hash(fields.simulationHash);
  if (simulationHash !== hash(expectedSimulationHash)) {
    throw new GovernanceError('Simulation evidence does not match the reviewed result', 'GOVERNANCE_SIMULATION_MISMATCH', 409);
  }
  if (Number(fields.schemaVersion) !== 1 || !Number.isSafeInteger(Number(fields.engineVersion)) || Number(fields.engineVersion) < 1) {
    throw new GovernanceError('Simulation evidence version is unsupported', 'GOVERNANCE_SIMULATION_INVALID', 400);
  }
  const readiness = fields.activationReadiness;
  const blockers = property(readiness, 'blockers');
  if (!readiness || property(readiness, 'eligible') !== true ||
      !Array.isArray(blockers) || blockers.length !== 0) {
    throw new GovernanceError('Simulation evidence contains activation blockers', 'GOVERNANCE_SIMULATION_BLOCKED', 409);
  }
  const scope = normalizePolicyScope(fields.scope);
  const proposed = (fields.proposed || {}) as Fields;
  const baseline = (fields.baseline || {}) as Fields;
  const summary = (fields.summary || {}) as Fields;
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
    engineVersion: Number(fields.engineVersion),
    scope,
    simulationHash,
    scenarioSetHash: hash(fields.scenarioSetHash),
    resultHash: hash(fields.resultHash),
    proposed: { versionId, documentHash: proposedDocumentHash },
    baseline: { kind: baselineKind, versionId: baselineVersionId, documentHash: hash(baseline.documentHash) },
    summary: { scenarioCount, strengthenedCount, relaxedCount, changedCount }
  };
}

export function reviewResponse(version: Row, assignmentRows: readonly Row[], decisionRows: readonly Row[]) {
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

export function expectedRevisionOf(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new GovernanceError('Expected draft revision is invalid', 'GOVERNANCE_DRAFT_REVISION_INVALID');
  }
  return revision;
}

export function boundedListLimit(value: unknown): number {
  if (value == null || String(value).trim() === '') return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new GovernanceError('Governance list limit must be an integer between 1 and 200', 'GOVERNANCE_LIMIT_INVALID', 400);
  }
  return limit;
}

export function boundedDecisionLimit(value: unknown, defaultValue: number, maximum: number): number {
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

export function decisionCursor(value: unknown): number {
  if (value == null) return 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) {
    throw new GovernanceError('Governance decision cursor must be a non-negative integer', 'GOVERNANCE_CURSOR_INVALID', 400);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new GovernanceError('Governance decision cursor must be a non-negative integer', 'GOVERNANCE_CURSOR_INVALID', 400);
  }
  return cursor;
}

export function normalizedDraftContent(input: Fields) {
  const document = normalizePolicyDocument(input.document);
  const documentHash = policyDocumentHash(document);
  if (input.documentHash != null && String(input.documentHash).trim().toLowerCase() !== documentHash) {
    throw new GovernanceError('Draft document hash is inconsistent', 'GOVERNANCE_DOCUMENT_HASH_INVALID');
  }
  const approval = normalizeApprovalPolicy(input.approvalPolicy);
  return { document, documentHash, approval };
}

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  const key = String(value).trim();
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new GovernanceError('Idempotency-Key must contain 8 to 200 printable characters', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

export function sha256Stable(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function activePolicySetLockKey(scopeKey: string): string {
  return `nv-governance-active-set:${scopeKey}`;
}

export function decisionRecordHash(secret: string, input: unknown): string {
  return createHmac('sha256', secret).update(stableJson(input), 'utf8').digest('hex');
}


export function eventCursor(value: unknown, label = 'Governance event cursor'): number {
  if (value == null || String(value).trim() === '') return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GovernanceError(`${label} must be a non-negative integer`, 'GOVERNANCE_CURSOR_INVALID', 400);
  return cursor;
}
export function eventLimit(value: unknown, maximum = 200, defaultValue = 100): number {
  if (value == null || String(value).trim() === '') return defaultValue;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new GovernanceError(`Governance event limit must be an integer between 1 and ${maximum}`, 'GOVERNANCE_LIMIT_INVALID', 400);
  return limit;
}
export function mapWebhook(row: Row) {
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
export function mapWebhookDelivery(row: Row) {
  return {
    deliveryId: String(row.delivery_id), // the uuid key; status and endpoint_url are text NOT NULL as well
    webhookId: row.webhook_id,
    eventSeq: Number(row.event_seq),
    status: String(row.status),
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
function lifecycleSubject(details: unknown): Record<string, unknown> {
  const source: Fields = details && typeof details === 'object' && !Array.isArray(details) ? details as Fields : {};
  const result: Record<string, unknown> = {};
  for (const key of ['draftId','assignmentId','approvalId','activationId','exceptionId','previousVersionId','rollbackSourceActivationId']) {
    if (source[key]) result[key] = source[key];
  }
  for (const key of ['action','decision','reviewStatus']) if (source[key]) result[key] = source[key];
  return result;
}
function lifecycleEvidence(details: unknown): Record<string, unknown> {
  const source: Fields = details && typeof details === 'object' && !Array.isArray(details) ? details as Fields : {};
  const result: Record<string, unknown> = {};
  if (source.documentHash) result.documentHash = source.documentHash;
  else if (source.proposedDocumentHash) result.documentHash = source.proposedDocumentHash;
  for (const key of ['simulationHash','scenarioSetHash','resultHash','targetHash']) if (source[key]) result[key] = source[key];
  return result;
}
export function eventFromJoinedRow(row: Row) {
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
  const mapping: Fields = row.decision_control_mapping && typeof row.decision_control_mapping === 'object' ? row.decision_control_mapping as Fields : {};
  return buildGovernanceEvent({
    eventSeq: Number(row.event_seq), sourceKind: row.source_kind, sourceSeq: Number(row.source_seq), sourceId: row.source_id,
    eventType: row.event_type, occurredAt: row.occurred_at,
    scope: { provider: row.decision_provider, baseUrl: `https://${row.decision_authority}`, owner: row.decision_owner, repo: row.decision_repo, scopeKey: row.scope_key },
    actorLogin: row.decision_actor_login,
    subject: { mutationId: row.decision_mutation_id, action: row.decision_action, enforcementOutcome: row.decision_enforcement_outcome, effectiveEffect: row.decision_effective_effect, rolloutMode: row.decision_rollout_mode },
    evidence: { decisionHash: row.decision_hash, descriptorHash: row.decision_descriptor_hash, policySetHash: row.decision_policy_set_hash, controlMappingHash: mapping.mappingHash }
  });
}
export function exportRowEnvelope(row: Row) {
  return {
    schemaVersion: 1,
    format: 'nebulaverse-governance-evidence-envelope',
    manifest: row.manifest,
    content: row.content,
    signature: row.signature
  };
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof GovernanceError) return error;
  const code = property(error, 'code');
  if (error && code === '23505') {
    const constraint = String(property(error, 'constraint') || '');
    if (/exception_one_decision/i.test(constraint)) return new GovernanceError('This exception already has an approval decision', 'GOVERNANCE_EXCEPTION_DECISION_EXISTS', 409);
    if (/exception_one_revoke/i.test(constraint)) return new GovernanceError('This exception is already revoked', 'GOVERNANCE_EXCEPTION_REVOKED', 409);
    if (/approvals.*version.*actor|approvals_assignment_once/i.test(constraint)) return new GovernanceError('This identity already recorded a decision for the version', 'GOVERNANCE_DECISION_EXISTS', 409);
    if (/review_assignments.*version.*reviewer/i.test(constraint)) return new GovernanceError('This identity is already assigned to review the version', 'GOVERNANCE_REVIEW_ASSIGNMENT_EXISTS', 409);
    if (/policy_versions.*document_hash/i.test(constraint)) return new GovernanceError('An identical immutable policy version already exists', 'GOVERNANCE_VERSION_DUPLICATE', 409);
    if (/active_draft_per_author|policy_drafts.*policy.*authored/i.test(constraint)) return new GovernanceError('This author already has an active draft for the policy', 'GOVERNANCE_DRAFT_EXISTS', 409);
    if (/policies.*(?:scope_key.*policy_key|live_key)/i.test(constraint)) return new GovernanceError('A policy with this key already exists in the repository scope', 'GOVERNANCE_POLICY_EXISTS', 409);
    return new GovernanceError('Governance record already exists', 'GOVERNANCE_CONFLICT', 409);
  }
  if (error && code === '23503') return new GovernanceError('Referenced governance record does not exist', 'GOVERNANCE_REFERENCE_INVALID', 409);
  return error;
}
