import { GovernanceError, normalizeUuid, normalizePolicyScope } from '../domain/governance-model.ts';
import { normalizeExceptionRequest, computeExceptionState } from '../domain/governance-exceptions.ts';
import type { Queryable, Row } from '../../../platform/persistence/queryable.ts';
import {
  requiredText, rowsOf, actorOf, onlyRow, boundedListLimit, REVIEW_SENSITIVE_TEXT_RX, activePolicySetLockKey,
  exceptionAuthorizationEvidenceOf, mapExceptionRequest, exceptionDecisionOf, mapExceptionEvent, dateOf, type Fields
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * Exceptions to a policy: requested, decided, revoked, and read back with
 * the events that make up each one's state.
 */

export async function exceptionRowInScope(store: GovernanceStoreContext, client: Queryable, input: Fields = {}, lock = false): Promise<Row> {
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
  if (!rowsOf(result)[0]) throw new GovernanceError('Exception request was not found in this repository scope', 'GOVERNANCE_EXCEPTION_NOT_FOUND', 404);
  return onlyRow(result);
}

export async function exceptionEventRows(store: GovernanceStoreContext, client: Queryable, exceptionId: unknown): Promise<readonly Row[]> {
  const result = await client.query(
    `SELECT * FROM nv_governance_exception_events
     WHERE exception_id=$1 ORDER BY created_at ASC,event_id ASC`,
    [exceptionId]
  );
  return result.rows || [];
}

export async function createExceptionRequest(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const scope = normalizePolicyScope(input.scope);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 30, store.now());
  const exceptionId = normalizeUuid(store.idFactory(), 'exception id');
  return store.idempotentTransaction({
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
    const version = rowsOf(versionResult)[0];
    if (!version) throw new GovernanceError('Policy version was not found in this repository scope', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
    if (version.active_version_id !== versionId) throw new GovernanceError('Exceptions can target only the currently active policy version', 'GOVERNANCE_EXCEPTION_VERSION_INACTIVE', 409);
    const operationTime = store.now();
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
    await store.appendAudit(client, {
      policyId, versionId, scopeKey: scope.scopeKey, eventType: 'exception.requested', actor,
      details: { exceptionId, kind: request.kind, action: request.action, ruleIds: request.ruleIds, targetHash: request.targetHash, expiresAt: request.expiresAt, documentHash: request.documentHash }
    });
    return mapExceptionRequest({ ...rowsOf(inserted)[0], version_number: version.version_number, active_version_id: version.active_version_id, current_head_revision: version.current_head_revision }, [], operationTime);
  });
}

export async function getException(store: GovernanceStoreContext, input: Fields = {}) {
  const client = await store.pool.connect();
  try {
    const row = await store.exceptionRowInScope(client, input, false);
    const events = await store.exceptionEventRows(client, row.exception_id);
    return mapExceptionRequest(row, events, store.now());
  } finally { client.release(); }
}

export async function listExceptions(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const limit = boundedListLimit(input.limit);
  const client = await store.pool.connect();
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
    for (const row of rowsOf(result)) output.push(mapExceptionRequest(row, await store.exceptionEventRows(client, row.exception_id), store.now()));
    return output;
  } finally { client.release(); }
}

export async function decideException(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const scope = normalizePolicyScope(input.scope);
  const exceptionId = normalizeUuid(input.exceptionId, 'exception id');
  const decision = exceptionDecisionOf(input.decision);
  const reason = requiredText(input.reason, 'Exception decision reason', 4000);
  if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Exception decision reason contains sensitive material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
  const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 50, store.now());
  const eventId = normalizeUuid(store.idFactory(), 'exception event id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.exception.decide', request: { exceptionId, decision, reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-exception:${exceptionId}`]);
    const row = await store.exceptionRowInScope(client, { exceptionId, scope }, true);
    if (decision === 'approve') {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-active-exceptions:${scope.scopeKey}:${row.action}`]);
    }
    const operationTime = store.now();
    const events = await store.exceptionEventRows(client, exceptionId);
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
      if (Number(rowsOf(countResult)[0]?.active_count || 0) >= 100) {
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
    await store.appendAudit(client, {
      policyId: row.policy_id, versionId: row.version_id, scopeKey: scope.scopeKey,
      eventType: decision === 'approve' ? 'exception.approved' : 'exception.rejected', actor,
      details: { exceptionId, decision, expiresAt: dateOf(row.expires_at).toISOString(), reason: reason.slice(0, 1000) }
    });
    return mapExceptionRequest(row, [...events, onlyRow(inserted)], operationTime);
  });
}

export async function revokeException(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const scope = normalizePolicyScope(input.scope);
  const exceptionId = normalizeUuid(input.exceptionId, 'exception id');
  const reason = requiredText(input.reason, 'Exception revocation reason', 4000);
  if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Exception revocation reason contains sensitive material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
  const initialAuthorization = exceptionAuthorizationEvidenceOf(input.authorizationEvidence, 50, store.now());
  const eventId = normalizeUuid(store.idFactory(), 'exception event id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.exception.revoke', request: { exceptionId, reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-exception:${exceptionId}`]);
    const row = await store.exceptionRowInScope(client, { exceptionId, scope }, true);
    const operationTime = store.now();
    const events = await store.exceptionEventRows(client, exceptionId);
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
    await store.appendAudit(client, {
      policyId: row.policy_id, versionId: row.version_id, scopeKey: scope.scopeKey,
      eventType: 'exception.revoked', actor,
      details: { exceptionId, reason: reason.slice(0, 1000) }
    });
    return mapExceptionRequest(row, [...events, onlyRow(inserted)], operationTime);
  });
}
