import { GovernanceError, normalizeUuid, normalizePolicyScope, policyDocumentHash } from '../domain/governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { normalizeSimulationRequest } from '../domain/governance-simulation.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { PoolClient, Queryable, Row } from '../../../platform/persistence/queryable.ts';
import { property } from '../../../platform/values/fields.ts';
import {
  translateDatabaseError, requiredText, sha256Stable, rowsOf, actorOf, optionalText, onlyRow, boundedListLimit,
  reviewResponse, authorizationEvidenceOf, mapReviewAssignment, REVIEW_SENSITIVE_TEXT_RX, mapReviewDecision,
  activationAuthorizationEvidenceOf, activationSimulationEvidenceOf, activePolicySetLockKey, type Fields
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * Reviewing a version and putting it into force: a reviewer claimed and a
 * decision recorded, then a version activated or rolled back -- only once
 * its review allows it, under the repository's policy lock, with the
 * simulation of what it would change kept beside the activation.
 */

export async function reviewVersionInScope(store: GovernanceStoreContext, client: Queryable, input: { readonly policyId: string; readonly versionId: string; readonly scopeKey: string }): Promise<Row> {
  const result = await client.query(
    `SELECT v.policy_id,v.version_id,v.version_number,v.authored_by_identity_key,v.authored_by_login,
            v.required_approvals,v.disallow_author_approval,p.scope_key,
            EXISTS(SELECT 1 FROM nv_governance_activations a WHERE a.version_id=v.version_id) AS has_activation,
            EXISTS(SELECT 1 FROM nv_governance_version_withdrawals w WHERE w.version_id=v.version_id) AS withdrawn
     FROM nv_governance_policy_versions v
     JOIN nv_governance_policies p ON p.policy_id=v.policy_id
     WHERE v.policy_id=$1 AND v.version_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL`,
    [input.policyId, input.versionId, input.scopeKey]
  );
  if (!rowsOf(result)[0]) throw new GovernanceError('Policy version was not found', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
  return onlyRow(result);
}

export async function reviewRows(store: GovernanceStoreContext, client: Queryable, versionId: string) {
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
  return { assignments: rowsOf(assignments), decisions: rowsOf(decisions) };
}

export async function getReviewState(store: GovernanceStoreContext, input: Fields = {}) {
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const version = await store.reviewVersionInScope(store.pool, { policyId, versionId, scopeKey: scope.scopeKey });
  const rows = await store.reviewRows(store.pool, versionId);
  return reviewResponse(version, rows.assignments, rows.decisions);
}

export async function claimReviewer(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const evidence = authorizationEvidenceOf(input.authorizationEvidence, store.now());
  const assignmentId = normalizeUuid(store.idFactory(), 'review assignment id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.reviewer.assign',
    request: { policyId, versionId }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
    authorizationEvidenceOf(evidence, store.now());
    const version = await store.reviewVersionInScope(client, { policyId, versionId, scopeKey: scope.scopeKey });
    const rows = await store.reviewRows(client, versionId);
    const current = reviewResponse(version, rows.assignments, rows.decisions);
    if (version.has_activation) throw new GovernanceError('Review assignments are frozen after activation', 'GOVERNANCE_VERSION_FINALIZED', 409);
    if (version.withdrawn) throw new GovernanceError('This version was withdrawn and can no longer be reviewed', 'GOVERNANCE_VERSION_WITHDRAWN', 409);
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
       evidence.providerRole, evidence.source, evidence.fetchedAt, evidence.expiresAt, store.now().toISOString()]
    );
    const assignment = onlyRow(inserted);
    await store.appendAudit(client, {
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

export async function recordReviewDecision(store: GovernanceStoreContext, input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const evidence = authorizationEvidenceOf(input.authorizationEvidence, store.now());
  const decision = String(input.decision || '').trim().toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new GovernanceError('Decision must be approve or reject', 'GOVERNANCE_DECISION_INVALID');
  const rationale = optionalText(input.rationale, 'Decision rationale', 4000);
  if (REVIEW_SENSITIVE_TEXT_RX.test(rationale)) {
    throw new GovernanceError('Decision rationale appears to contain sensitive credential material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
  }
  if (decision === 'reject' && !rationale) {
    throw new GovernanceError('A rejection rationale is required', 'GOVERNANCE_REJECTION_RATIONALE_REQUIRED', 400);
  }
  const approvalId = normalizeUuid(store.idFactory(), 'approval id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: 'governance.approval.decide',
    request: { policyId, versionId, decision, rationale }
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
    authorizationEvidenceOf(evidence, store.now());
    const version = await store.reviewVersionInScope(client, { policyId, versionId, scopeKey: scope.scopeKey });
    const rows = await store.reviewRows(client, versionId);
    const current = reviewResponse(version, rows.assignments, rows.decisions);
    if (version.has_activation) throw new GovernanceError('Review decisions are frozen after activation', 'GOVERNANCE_VERSION_FINALIZED', 409);
    if (version.withdrawn) throw new GovernanceError('This version was withdrawn and can no longer be reviewed', 'GOVERNANCE_VERSION_WITHDRAWN', 409);
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
       store.now().toISOString()]
    );
    const recorded = onlyRow(inserted);
    await store.appendAudit(client, {
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

export async function activateVersion(store: GovernanceStoreContext, input: Fields) {
  return store.changeActiveVersion('activate', input);
}

export async function rollbackVersion(store: GovernanceStoreContext, input: Fields) {
  return store.changeActiveVersion('rollback', input);
}

export async function changeActiveVersion(store: GovernanceStoreContext, action: 'activate' | 'rollback', input: Fields = {}) {
  const actor = actorOf(input.actor);
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const versionId = normalizeUuid(input.versionId, 'policy version id');
  const scope = normalizePolicyScope(input.scope);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new GovernanceError('Expected policy revision is invalid', 'GOVERNANCE_REVISION_INVALID');
  const reason = requiredText(input.reason, action === 'rollback' ? 'Rollback reason' : 'Activation reason', 4000);
  if (REVIEW_SENSITIVE_TEXT_RX.test(reason)) throw new GovernanceError('Activation reason appears to contain sensitive credential material', 'GOVERNANCE_SENSITIVE_TEXT', 400);
  const authorization = activationAuthorizationEvidenceOf(input.authorizationEvidence, store.now());
  const simulationRequest = input.simulationRequest === undefined ? null : normalizeSimulationRequest(input.simulationRequest);
  const suppliedSimulation = simulationRequest ? null : activationSimulationEvidenceOf(input.simulationEvidence, input.expectedSimulationHash);
  const simulationHash = String(input.expectedSimulationHash || '').trim().toLowerCase();
  if (!isSha256Hex(simulationHash)) throw new GovernanceError('Simulation evidence hash is invalid', 'GOVERNANCE_SIMULATION_INVALID', 400);
  const activationId = normalizeUuid(store.idFactory(), 'activation id');
  /*
   * The simulation is pure but not cheap, so it runs from an unlocked read
   * before the transaction. Under the locks the transaction then requires
   * that the documents it compared are still the proposed and active ones.
   * Its outcome, error included, is only acted on inside, so a retried
   * request still reaches its receipt first.
   */
  let precomputed = null;
  if (simulationRequest) {
    const snapshot = await store.pool.query(
      `SELECT v.version_number,v.document,v.document_hash,h.active_version_id,
              av.document_hash AS active_document_hash,av.document AS active_document,av.version_number AS active_version_number
       FROM nv_governance_policy_versions v
       JOIN nv_governance_policies p ON p.policy_id=v.policy_id
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions av ON av.version_id=h.active_version_id
       WHERE v.version_id=$1 AND v.policy_id=$2 AND p.scope_key=$3`,
      [versionId, policyId, scope.scopeKey]
    ).catch(error => { throw translateDatabaseError(error); });
    const seen = rowsOf(snapshot)[0];
    if (seen) {
      const inputs = {
        documentHash: seen.document_hash,
        activeVersionId: seen.active_version_id ? String(seen.active_version_id) : null,
        activeDocumentHash: seen.active_version_id ? seen.active_document_hash : null
      };
      try {
        precomputed = { inputs, result: store.simulate({
          scope,
          proposedVersion: { versionId, versionNumber: Number(seen.version_number), document: seen.document, documentHash: seen.document_hash },
          baselineVersion: seen.active_version_id ? {
            versionId: String(seen.active_version_id), versionNumber: Number(seen.active_version_number),
            document: seen.active_document, documentHash: seen.active_document_hash
          } : null,
          request: simulationRequest
        }) };
      } catch (error) { precomputed = { inputs, error }; }
    }
  }
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actor.identityKey,
    operation: action === 'rollback' ? 'governance.policy.rollback' : 'governance.policy.activate',
    request: { policyId, versionId, expectedRevision, reason, simulationHash },
    // Preserve existing receipts while binding the actual scenarios too. A
    // copied report hash must not replay an otherwise different request.
    validateReplay: simulationRequest ? async (client: PoolClient, response: unknown): Promise<void> => {
      const recorded = await client.query(
        `SELECT scenario_set_hash FROM nv_governance_activation_evidence
         WHERE activation_id=$1 AND policy_id=$2 AND version_id=$3 AND scope_key=$4`,
        [property(response, 'activationId'), policyId, versionId, scope.scopeKey]
      );
      const evidenceRow = rowsOf(recorded)[0];
      if (!evidenceRow || evidenceRow.scenario_set_hash !== sha256Stable(simulationRequest)) {
        throw new GovernanceError('Idempotency-Key was already used for a different governance request', 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 409);
      }
      activationAuthorizationEvidenceOf(authorization, store.now());
    } : null
  }, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [activePolicySetLockKey(scope.scopeKey)]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance:${policyId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-review:${versionId}`]);
    activationAuthorizationEvidenceOf(authorization, store.now());
    const found = await client.query(
      `SELECT v.*,p.scope_key,h.active_version_id,h.revision,av.document_hash AS active_document_hash,
              av.document AS active_document,av.version_number AS active_version_number,
              EXISTS(SELECT 1 FROM nv_governance_version_withdrawals w WHERE w.version_id=v.version_id) AS withdrawn
       FROM nv_governance_policy_versions v
       JOIN nv_governance_policies p ON p.policy_id=v.policy_id
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       LEFT JOIN nv_governance_policy_versions av ON av.version_id=h.active_version_id
       WHERE v.version_id=$1 AND v.policy_id=$2 AND p.scope_key=$3 AND p.archived_at IS NULL
       FOR UPDATE OF h`,
      [versionId, policyId, scope.scopeKey]
    );
    const state = rowsOf(found)[0];
    if (!state) throw new GovernanceError('Policy version was not found in this repository policy', 'GOVERNANCE_VERSION_NOT_FOUND', 404);
    const currentRevision = Number(state.revision || 0);
    if (currentRevision !== expectedRevision) {
      throw new GovernanceError('Policy state changed; reload before activating', 'GOVERNANCE_REVISION_CONFLICT', 409, { expectedRevision, currentRevision });
    }
    if (String(state.active_version_id || '') === versionId) throw new GovernanceError('Policy version is already active', 'GOVERNANCE_VERSION_ALREADY_ACTIVE', 409);
    if (state.withdrawn) throw new GovernanceError('This version was withdrawn and cannot be activated', 'GOVERNANCE_VERSION_WITHDRAWN', 409);
    // A successful retry reaches its receipt before consulting the changed
    // head. New transitions use the simulation only if what it compared is
    // still what the locked snapshot holds.
    let simulation = suppliedSimulation;
    if (!simulation) {
      const locked = {
        documentHash: state.document_hash,
        activeVersionId: state.active_version_id ? String(state.active_version_id) : null,
        activeDocumentHash: state.active_version_id ? state.active_document_hash : null
      };
      if (!precomputed || stableJson(precomputed.inputs) !== stableJson(locked)) {
        throw new GovernanceError('Simulation evidence is stale for the current active policy', 'GOVERNANCE_SIMULATION_STALE', 409);
      }
      if (precomputed.error) throw precomputed.error;
      simulation = activationSimulationEvidenceOf(precomputed.result, simulationHash);
    }
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
    if (!state.active_version_id) {
      const activeCount = await client.query(
        `SELECT count(*)::int AS active_policy_count
         FROM nv_governance_policies p
         JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
         WHERE p.scope_key=$1 AND p.archived_at IS NULL AND h.active_version_id IS NOT NULL`,
        [scope.scopeKey]
      );
      if (Number(rowsOf(activeCount)[0]?.active_policy_count || 0) >= 100) {
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
      if (!rowsOf(prior)[0]) throw new GovernanceError('Rollback target has no prior evidence-backed activation', 'GOVERNANCE_ROLLBACK_TARGET_INVALID', 409);
      rollbackSourceActivationId = onlyRow(prior).activation_id;
    } else {
      const prior = await client.query(
        `SELECT 1 FROM nv_governance_activations a
         JOIN nv_governance_activation_evidence e ON e.activation_id=a.activation_id
         WHERE a.policy_id=$1 AND a.version_id=$2 LIMIT 1`,
        [policyId, versionId]
      );
      if (rowsOf(prior)[0]) throw new GovernanceError('Previously active versions must use the rollback workflow', 'GOVERNANCE_USE_ROLLBACK', 409);
      const rows = await store.reviewRows(client, versionId);
      const review = reviewResponse(state, rows.assignments, rows.decisions);
      if (review.status === 'rejected') throw new GovernanceError('A rejected policy version cannot be activated', 'GOVERNANCE_VERSION_REJECTED', 409);
      if (review.status !== 'approved') {
        throw new GovernanceError('Policy version does not have final approval', 'GOVERNANCE_APPROVALS_REQUIRED', 409, { approvals: review.approvalCount, requiredApprovals: review.requiredApprovals });
      }
    }

    const resultingRevision = currentRevision + 1;
    const createdAt = store.now().toISOString();
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
    await store.appendAudit(client, {
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
      activationId: onlyRow(activation).activation_id,
      policyId,
      versionId,
      previousVersionId: state.active_version_id || null,
      rollbackSourceActivationId,
      action,
      revision: Number(onlyRow(head).revision),
      simulationHash: simulation.simulationHash,
      updatedAt: onlyRow(head).updated_at
    };
  });
}

export async function listActivationHistory(store: GovernanceStoreContext, input: Fields = {}) {
  const policyId = normalizeUuid(input.policyId, 'policy id');
  const scope = normalizePolicyScope(input.scope);
  const capped = boundedListLimit(input.limit);
  const result = await store.pool.query(
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
  return rowsOf(result).map(row => ({
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
