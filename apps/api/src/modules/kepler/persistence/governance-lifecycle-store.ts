import { GovernanceError, normalizeUuid, normalizePolicyScope } from '../domain/governance-model.ts';
import type { Queryable, Row } from '../../../platform/persistence/queryable.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import {
  requiredText, rowsOf, actorOf, onlyRow, boundedListLimit, expectedRevisionOf, REVIEW_SENSITIVE_TEXT_RX,
  activationAuthorizationEvidenceOf, activePolicySetLockKey, type Fields, type LockedChange,
  type AuthorizationEvidence
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * The rest of a policy's life: deactivated, archived and restored, a draft
 * discarded, a version withdrawn, and a repository's governance reset. Each
 * change takes the policy's head under its lock first, and is audited.
 */

/*
 * The rest of a policy's life: switching it off, setting it aside, bringing
 * it back, throwing away a draft, taking back a version, and clearing a
 * repository. Every one of these appends to the ledger; none of them edits a
 * record of something that already happened.
 */
export function lifecycleReason(store: GovernanceStoreContext, value: unknown, label: string): string {
  const reason = requiredText(value, label, 4000);
  if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) {
    throw new GovernanceError(`${label} appears to contain sensitive credential material`, 'GOVERNANCE_SENSITIVE_TEXT', 400);
  }
  return reason;
}

export async function lockedPolicyHead(store: GovernanceStoreContext, client: Queryable, scope: RepositoryScope, policyId: unknown, { archived = false }: { readonly archived?: boolean } = {}): Promise<Row> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
  const found = await client.query(
    `SELECT p.policy_id,p.policy_key,p.name,p.archived_at,h.active_version_id,h.revision,
            av.version_number AS active_version_number
       FROM nv_governance_policies p
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions av ON av.version_id=h.active_version_id
      WHERE p.policy_id=$1 AND p.scope_key=$2 AND ${archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'}
      FOR UPDATE OF p,h`,
    [policyId, scope.scopeKey]
  );
  if (!rowsOf(found)[0]) throw new GovernanceError(archived ? 'No archived policy with that id exists here' : 'Governance policy was not found', 'GOVERNANCE_POLICY_NOT_FOUND', 404);
  return onlyRow(found);
}

/* Switches off whatever version a locked head points at. The caller holds
 * the active-set and policy locks and has checked the revision. */
export async function deactivateLocked(store: GovernanceStoreContext, client: Queryable, { scope, state, actor, reason, authorization, resetId = null }: LockedChange & { readonly authorization: AuthorizationEvidence }) {
  const activationId = normalizeUuid(store.idFactory(), 'activation id');
  const currentRevision = Number(state.revision || 0);
  const resultingRevision = currentRevision + 1;
  const createdAt = store.now().toISOString();
  await client.query(
    `INSERT INTO nv_governance_activations(
      activation_id,policy_id,version_id,previous_version_id,action,expected_revision,resulting_revision,
      actor_identity_key,actor_login,reason,created_at
     ) VALUES($1,$2,$3,$3,'deactivate',$4,$5,$6,$7,$8,$9)`,
    [activationId, state.policy_id, state.active_version_id, currentRevision, resultingRevision,
     actor.identityKey, actor.login, reason, createdAt]
  );
  const head = await client.query(
    `UPDATE nv_governance_policy_heads
        SET active_version_id=NULL,revision=$1,updated_at=$2
      WHERE policy_id=$3 AND revision=$4
      RETURNING revision,updated_at`,
    [resultingRevision, createdAt, state.policy_id, currentRevision]
  );
  if (!head.rowCount) throw new GovernanceError('Policy state changed while switching it off', 'GOVERNANCE_REVISION_CONFLICT', 409);
  await store.appendAudit(client, {
    policyId: state.policy_id, versionId: state.active_version_id, scopeKey: scope.scopeKey,
    eventType: 'policy.deactivated', actor,
    details: {
      action: 'deactivate',
      activationId,
      previousVersionId: state.active_version_id,
      versionNumber: Number(state.active_version_number || 0),
      expectedRevision: currentRevision,
      resultingRevision,
      authorizationSource: authorization.source,
      authorizationFetchedAt: authorization.fetchedAt,
      authorizationExpiresAt: authorization.expiresAt,
      ...(resetId ? { resetId } : {}),
      reason: reason.slice(0, 1000)
    }
  });
  return { activationId, previousVersionId: state.active_version_id, revision: resultingRevision, updatedAt: onlyRow(head).updated_at };
}

export async function archiveLocked(store: GovernanceStoreContext, client: Queryable, { scope, state, actor, reason, resetId = null, deactivated }: LockedChange & { readonly deactivated: unknown }): Promise<unknown> {
  const archivedAt = store.now().toISOString();
  const updated = await client.query(
    `UPDATE nv_governance_policies SET archived_at=$1
      WHERE policy_id=$2 AND scope_key=$3 AND archived_at IS NULL
      RETURNING archived_at`,
    [archivedAt, state.policy_id, scope.scopeKey]
  );
  if (!updated.rowCount) throw new GovernanceError('Policy state changed while archiving it', 'GOVERNANCE_REVISION_CONFLICT', 409);
  await store.appendAudit(client, {
    policyId: state.policy_id, scopeKey: scope.scopeKey, eventType: 'policy.archived', actor,
    details: {
      action: 'archive',
      policyKey: state.policy_key,
      deactivated: !!deactivated,
      ...(resetId ? { resetId } : {}),
      reason: reason.slice(0, 1000)
    }
  });
  return onlyRow(updated).archived_at;
}

export async function deactivatePolicy(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = expectedRevisionOf(input.expectedRevision);
  const reason = store.lifecycleReason(input.reason, 'Reason for switching the policy off');
  const authorization = activationAuthorizationEvidenceOf(input.authorizationEvidence, store.now());
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.policy.deactivate',
    request: { policyId, expectedRevision, reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    activationAuthorizationEvidenceOf(authorization, store.now());
    const state = await store.lockedPolicyHead(client, scope, policyId);
    const currentRevision = Number(state.revision || 0);
    if (currentRevision !== expectedRevision) {
      throw new GovernanceError('Policy state changed; reload before switching it off', 'GOVERNANCE_REVISION_CONFLICT', 409, { expectedRevision, currentRevision });
    }
    if (!state.active_version_id) throw new GovernanceError('The policy is already switched off', 'GOVERNANCE_POLICY_NOT_ACTIVE', 409);
    const result = await store.deactivateLocked(client, { scope, state, actor, reason, authorization });
    return { policyId, action: 'deactivate', ...result };
  });
}

export async function archivePolicy(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = expectedRevisionOf(input.expectedRevision);
  const reason = store.lifecycleReason(input.reason, 'Reason for archiving the policy');
  const authorization = activationAuthorizationEvidenceOf(input.authorizationEvidence, store.now());
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.policy.archive',
    request: { policyId, expectedRevision, reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    activationAuthorizationEvidenceOf(authorization, store.now());
    const state = await store.lockedPolicyHead(client, scope, policyId);
    const currentRevision = Number(state.revision || 0);
    if (currentRevision !== expectedRevision) {
      throw new GovernanceError('Policy state changed; reload before archiving it', 'GOVERNANCE_REVISION_CONFLICT', 409, { expectedRevision, currentRevision });
    }
    /* An archived policy never enforces anything, so a running one is
     * switched off first, on the record, in the same transaction. */
    const deactivation = state.active_version_id
      ? await store.deactivateLocked(client, { scope, state, actor, reason, authorization })
      : null;
    const archivedAt = await store.archiveLocked(client, { scope, state, actor, reason, deactivated: !!deactivation });
    return { policyId, archivedAt, deactivated: !!deactivation, activationId: deactivation ? deactivation.activationId : null };
  });
}

export async function restorePolicy(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const reason = store.lifecycleReason(input.reason, 'Reason for restoring the policy');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.policy.restore',
    request: { policyId, reason }
  }, async client => {
    const state = await store.lockedPolicyHead(client, scope, policyId, { archived: true });
    const clash = await client.query(
      `SELECT 1 FROM nv_governance_policies
        WHERE scope_key=$1 AND policy_key=$2 AND archived_at IS NULL AND policy_id<>$3 LIMIT 1`,
      [scope.scopeKey, state.policy_key, policyId]
    );
    if (rowsOf(clash)[0]) {
      throw new GovernanceError('A current policy already uses this key; archive or rename it first', 'GOVERNANCE_POLICY_KEY_IN_USE', 409, { policyKey: state.policy_key });
    }
    await client.query(
      'UPDATE nv_governance_policies SET archived_at=NULL WHERE policy_id=$1 AND scope_key=$2 AND archived_at IS NOT NULL',
      [policyId, scope.scopeKey]
    );
    await store.appendAudit(client, {
      policyId, scopeKey: scope.scopeKey, eventType: 'policy.restored', actor,
      details: { action: 'restore', policyKey: state.policy_key, reason: reason.slice(0, 1000) }
    });
    /* It comes back switched off. Turning it on again goes through the
     * rollback workflow, with a fresh simulation, like any other return. */
    return { policyId, restored: true, active: false };
  });
}

export async function listArchivedPolicies(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const capped = boundedListLimit(input.limit);
  const result = await store.pool.query(
    `SELECT p.policy_id,p.policy_key,p.name,p.description,p.created_at,p.archived_at,
            (SELECT count(*) FROM nv_governance_policy_versions v WHERE v.policy_id=p.policy_id)::integer AS version_count,
            EXISTS(SELECT 1 FROM nv_governance_policies live
                    WHERE live.scope_key=p.scope_key AND live.policy_key=p.policy_key AND live.archived_at IS NULL) AS key_in_use
       FROM nv_governance_policies p
      WHERE p.scope_key=$1 AND p.archived_at IS NOT NULL
      ORDER BY p.archived_at DESC,p.policy_id ASC
      LIMIT $2`,
    [scope.scopeKey, capped]
  );
  return rowsOf(result).map(row => ({
    policyId: row.policy_id,
    policyKey: row.policy_key,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    versionCount: Number(row.version_count || 0),
    keyInUse: row.key_in_use === true
  }));
}

export async function discardDraft(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const draftId = normalizeUuid(input.draftId, 'policy draft id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = expectedRevisionOf(input.expectedRevision);
  const allowOthers = input.allowOthers === true;
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.draft.discard',
    request: { policyId, draftId, expectedRevision }
  }, async client => {
    const found = await client.query(
      `SELECT d.draft_id,d.revision,d.document_hash,d.authored_by_identity_key
         FROM nv_governance_policy_drafts d
         JOIN nv_governance_policies p ON p.policy_id=d.policy_id
        WHERE d.draft_id=$1 AND d.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
        FOR UPDATE OF d`,
      [draftId, policyId, scope.scopeKey]
    );
    const draft = rowsOf(found)[0];
    if (!draft) throw new GovernanceError('Governance draft was not found', 'GOVERNANCE_DRAFT_NOT_FOUND', 404);
    const own = draft.authored_by_identity_key === actor.identityKey;
    if (!own && !allowOthers) {
      throw new GovernanceError('Only the draft author or a repository administrator can discard this draft', 'GOVERNANCE_DRAFT_NOT_OWNED', 403);
    }
    if (Number(draft.revision) !== expectedRevision) {
      throw new GovernanceError('Policy draft changed; reload before discarding it', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409, {
        expectedRevision, currentRevision: Number(draft.revision)
      });
    }
    const removed = await client.query(
      'DELETE FROM nv_governance_policy_drafts WHERE draft_id=$1 AND revision=$2',
      [draftId, expectedRevision]
    );
    if (!removed.rowCount) throw new GovernanceError('Policy draft changed while discarding it', 'GOVERNANCE_DRAFT_REVISION_CONFLICT', 409);
    await store.appendAudit(client, {
      policyId, scopeKey: scope.scopeKey, eventType: 'draft.discarded', actor,
      details: { draftId, revision: expectedRevision, documentHash: draft.document_hash, discardedByAuthor: own }
    });
    return { policyId, draftId, discarded: true };
  });
}

export async function withdrawVersion(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const reason = store.lifecycleReason(input.reason, 'Reason for withdrawing the version');
  const allowOthers = input.allowOthers === true;
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.version.withdraw',
    request: { policyId, versionId, reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
    const version = await store.reviewVersionInScope(client, { policyId, versionId, scopeKey: scope.scopeKey });
    if (version.withdrawn) throw new GovernanceError('This version was already withdrawn', 'GOVERNANCE_VERSION_WITHDRAWN', 409);
    /* A version that ever ran is history, and history is what rollback reads.
     * Only a version that never took effect can be taken back. */
    if (version.has_activation) throw new GovernanceError('A version that has been active cannot be withdrawn', 'GOVERNANCE_VERSION_FINALIZED', 409);
    if (version.authored_by_identity_key !== actor.identityKey && !allowOthers) {
      throw new GovernanceError('Only the version author or a repository administrator can withdraw it', 'GOVERNANCE_VERSION_NOT_OWNED', 403);
    }
    await client.query(
      `INSERT INTO nv_governance_version_withdrawals(version_id,policy_id,scope_key,actor_identity_key,created_at)
       VALUES($1,$2,$3,$4,$5)`,
      [versionId, policyId, scope.scopeKey, actor.identityKey, store.now().toISOString()]
    );
    await store.appendAudit(client, {
      policyId, versionId, scopeKey: scope.scopeKey, eventType: 'version.withdrawn', actor,
      details: { action: 'withdraw', versionNumber: Number(version.version_number), reason: reason.slice(0, 1000) }
    });
    return { policyId, versionId, withdrawn: true };
  });
}

/*
 * Clearing a repository: every live policy is switched off and archived, in
 * one transaction, so the repository is either governed as before or not
 * governed at all -- never half. The ledger, the signed exports, the
 * webhooks and the notification settings are left exactly as they were,
 * and every archived policy can be restored.
 */
export async function resetGovernance(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const scope = normalizePolicyScope(input.scope);
  const reason = store.lifecycleReason(input.reason, 'Reason for resetting governance');
  const authorization = activationAuthorizationEvidenceOf(input.authorizationEvidence, store.now());
  const resetId = normalizeUuid(store.idFactory(), 'governance reset id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.reset',
    request: { reason }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    activationAuthorizationEvidenceOf(authorization, store.now());
    const live = await client.query(
      `SELECT p.policy_id FROM nv_governance_policies p
        WHERE p.scope_key=$1 AND p.archived_at IS NULL
        ORDER BY p.policy_key ASC,p.policy_id ASC
        LIMIT 501`,
      [scope.scopeKey]
    );
    if (rowsOf(live).length > 500) {
      throw new GovernanceError('This repository has more policies than one reset can clear', 'GOVERNANCE_RESET_LIMIT_REACHED', 409, { maximum: 500 });
    }
    let deactivatedCount = 0;
    for (const row of rowsOf(live)) {
      const state = await store.lockedPolicyHead(client, scope, row.policy_id);
      const deactivation = state.active_version_id
        ? await store.deactivateLocked(client, { scope, state, actor, reason, authorization, resetId })
        : null;
      if (deactivation) deactivatedCount += 1;
      await store.archiveLocked(client, { scope, state, actor, reason, resetId, deactivated: !!deactivation });
    }
    return { resetId, archivedCount: rowsOf(live).length, deactivatedCount };
  });
}
