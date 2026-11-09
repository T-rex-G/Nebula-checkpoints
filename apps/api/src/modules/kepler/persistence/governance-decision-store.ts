import { GovernanceError, normalizeUuid, normalizePolicyScope } from '../domain/governance-model.ts';
import { POLICY_DECISION_GENESIS, evaluateActivePolicySet, normalizePolicyDecision } from '../domain/governance-enforcement.ts';
import { isIdentityKey } from '../../../../../../packages/contracts/src/ids.ts';
import { property } from '../../../platform/values/fields.ts';
import {
  translateDatabaseError, sha256Stable, rowsOf, activePolicySetLockKey, dateOf, decisionRecordHash,
  boundedDecisionLimit, decisionCursor, type Fields
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * Policy decisions: each evaluation appended to the repository's hash
 * chain, the policy set in force resolved for an action, the decisions
 * listed and counted, and the chain verified.
 */

export async function evaluateAndAppendPolicyDecision(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const descriptor = input.descriptor;
  if (!descriptor || property(descriptor, 'scopeKey') !== scope.scopeKey) {
    throw new GovernanceError('Mutation descriptor does not match the governance scope', 'POLICY_DESCRIPTOR_INVALID', 500);
  }
  const decisionId = normalizeUuid(store.idFactory(), 'policy decision id');
  return store.transaction(async client => {
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
    if (rowsOf(active).length > 100) {
      throw new GovernanceError(
        'Repository active-policy limit is exceeded',
        'GOVERNANCE_ACTIVE_POLICY_LIMIT_EXCEEDED',
        503,
        { maximum: 100 }
      );
    }
    const activePolicies = rowsOf(active).map(row => ({
      policyId: row.policy_id,
      policyKey: row.policy_key,
      versionId: row.active_version_id,
      versionNumber: Number(row.version_number),
      headRevision: Number(row.revision),
      document: row.document,
      documentHash: row.document_hash
    }));
    const createdAt = store.now().toISOString();
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
      [scope.scopeKey, property(descriptor, 'action'), activePolicies.map(item => item.versionId), createdAt]
    ) : { rows: [] };
    if (rowsOf(exceptionRows).length > 100) {
      throw new GovernanceError(
        'Repository active-exception limit is exceeded for this mutation action',
        'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED',
        503,
        { maximum: 100, action: property(descriptor, 'action') }
      );
    }
    const activeExceptions = rowsOf(exceptionRows).map(row => ({
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
    const previousRow = rowsOf(previous)[0];
    const previousHash = previousRow ? previousRow.record_hash : POLICY_DECISION_GENESIS;
    const decisionHash = sha256Stable(decision);
    const recordHash = decisionRecordHash(store.secret, {
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

/*
 * The active policy set for a scope, read and nothing else.
 *
 * Safe Passage has to ask the policy whether a compliant route is permitted
 * before offering it. Asking through the runtime evaluator would append a
 * decision to the hash chain for a mutation nobody performed, so the set is
 * read here and judged by the pure evaluator instead. Nothing is written and
 * no decision identifier is minted: this answers a question, it does not
 * record one.
 */
export async function resolveActivePolicySetInScope(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const action = String(input.action || '').trim();
  if (!action) throw new GovernanceError('An action is required to resolve the active policy set', 'POLICY_DESCRIPTOR_INVALID', 500);
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const active = await client.query(
      `SELECT p.policy_id,p.policy_key,h.active_version_id,h.revision,
              v.version_number,v.document,v.document_hash
       FROM nv_governance_policies p
       JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
       JOIN nv_governance_policy_versions v ON v.version_id=h.active_version_id AND v.policy_id=p.policy_id
       WHERE p.scope_key=$1 AND p.archived_at IS NULL AND h.active_version_id IS NOT NULL
       ORDER BY p.policy_key ASC,p.policy_id ASC
       LIMIT 101`,
      [scope.scopeKey]
    );
    if (rowsOf(active).length > 100) {
      throw new GovernanceError(
        'Repository active-policy limit is exceeded',
        'GOVERNANCE_ACTIVE_POLICY_LIMIT_EXCEEDED',
        503,
        { maximum: 100 }
      );
    }
    const activePolicies = rowsOf(active).map(row => ({
      policyId: row.policy_id,
      policyKey: row.policy_key,
      versionId: row.active_version_id,
      versionNumber: Number(row.version_number),
      headRevision: Number(row.revision),
      document: row.document,
      documentHash: row.document_hash
    }));
    const resolvedAt = store.now().toISOString();
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
      [scope.scopeKey, action, activePolicies.map(item => item.versionId), resolvedAt]
    ) : { rows: [] };
    if (rowsOf(exceptionRows).length > 100) {
      throw new GovernanceError(
        'Repository active-exception limit is exceeded for this mutation action',
        'GOVERNANCE_ACTIVE_EXCEPTION_LIMIT_EXCEEDED',
        503,
        { maximum: 100, action }
      );
    }
    const activeExceptions = rowsOf(exceptionRows).map(row => ({
      exceptionId: row.exception_id, policyId: row.policy_id, versionId: row.version_id,
      documentHash: row.document_hash, kind: row.kind, action: row.action, ruleIds: row.rule_ids,
      subjectIdentityKey: row.requested_by_identity_key, target: row.target, targetHash: row.target_hash,
      expiresAt: row.expires_at, approvedAt: row.approved_at,
      approvedByIdentityKey: row.approved_by_identity_key, approvedByLogin: row.approved_by_login
    }));
    return { activePolicies, activeExceptions, resolvedAt };
  } catch (error) {
    throw translateDatabaseError(error);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export async function listPolicyDecisionsInScope(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const limit = boundedDecisionLimit(input.limit, 100, 5000);
  if (input.beforeSeq != null && input.afterSeq != null) {
    throw new GovernanceError('Choose one governance decision cursor', 'GOVERNANCE_CURSOR_INVALID', 400);
  }
  const descending = input.beforeSeq != null;
  const cursor = decisionCursor(descending ? input.beforeSeq : input.afterSeq);
  const comparison = descending ? '<' : '>';
  const order = descending ? 'DESC' : 'ASC';
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = await client.query(
      `SELECT count(*)::int AS total_count,
              count(*) FILTER (WHERE seq ${comparison} $2)::int AS remaining_count
       FROM nv_governance_policy_decisions WHERE scope_key=$1`,
      [scope.scopeKey, cursor]
    );
    const result = await client.query(
      `SELECT seq,decision_id,mutation_id,decision,decision_hash,previous_hash,record_hash,created_at
       FROM nv_governance_policy_decisions
       WHERE scope_key=$1 AND seq ${comparison} $2 ORDER BY seq ${order} LIMIT $3`,
      [scope.scopeKey, cursor, limit]
    );
    const decisions = rowsOf(result).map(row => {
      try {
        const decision = normalizePolicyDecision({
          ...(row.decision as Fields),
          decisionId: row.decision_id,
          previousHash: row.previous_hash,
          recordHash: row.record_hash
        });
        if (decision.mutationId !== row.mutation_id) throw new Error('mutation mismatch');
        return Object.freeze({
          seq: Number(row.seq),
          ...decision,
          decisionHash: String(row.decision_hash || '').toLowerCase(),
          createdAt: dateOf(row.created_at).toISOString()
        });
      } catch {
        throw new GovernanceError('Stored policy decision evidence is invalid', 'POLICY_DECISION_CORRUPT', 500);
      }
    });
    const countRow = rowsOf(counts)[0] || {};
    const total = Number(countRow.total_count || 0);
    const remaining = Number(countRow.remaining_count || 0);
    const lastDecision = decisions[decisions.length - 1];
    const nextSeq = lastDecision ? lastDecision.seq : cursor;
    const output = Object.freeze({
      decisions: Object.freeze(decisions),
      total,
      remaining,
      ...(descending ? { beforeSeq: cursor, nextBeforeSeq: decisions.length === remaining ? null : nextSeq } : { afterSeq: cursor, nextAfterSeq: nextSeq }),
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

/*
 * How the merges one identity asked for were decided since a moment, as a
 * count per enforcement outcome across every repository. Counts only: no
 * repository, rule or decision leaves this, so it can sit on the Overview
 * without reading anything the identity could not already see one
 * repository at a time.
 */
export async function countMergeOutcomes(store: GovernanceStoreContext, input: Fields = {}) {
  const identityKey = String(input.actorIdentityKey || '');
  if (!isIdentityKey(identityKey)) {
    throw new GovernanceError('Governance actor identity is invalid', 'GOVERNANCE_ACTOR_INVALID', 400);
  }
  const since = dateOf(input.since);
  if (!Number.isFinite(since.getTime())) {
    throw new GovernanceError('Governance count start is invalid', 'GOVERNANCE_SINCE_INVALID', 400);
  }
  try {
    const result = await store.pool.query(
      `SELECT enforcement_outcome, count(*)::int AS n
         FROM nv_governance_policy_decisions
        WHERE actor_identity_key=$1 AND action='pull.merge' AND created_at >= $2
        GROUP BY enforcement_outcome`,
      [identityKey, since.toISOString()]
    );
    const counts: Record<string, number> = { allow: 0, warn: 0, block: 0 };
    for (const row of rowsOf(result)) {
      const outcome = String(row.enforcement_outcome);
      if (Object.hasOwn(counts, outcome)) counts[outcome] = Number(row.n) || 0;
    }
    return Object.freeze(counts);
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

export async function verifyPolicyDecisionChainInScope(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const maxRecords = boundedDecisionLimit(input.limit, 50000, 100000);
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const outcome = await (async () => {
      const countResult = await client.query(
        'SELECT count(*)::int AS total_count FROM nv_governance_policy_decisions WHERE scope_key=$1',
        [scope.scopeKey]
      );
      const total = Number(rowsOf(countResult)[0]?.total_count || 0);
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
        if (!rowsOf(result).length) {
          return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_CHAIN_MISMATCH', firstInvalidSeq: null, headHash: expectedPrevious });
        }
        for (const row of rowsOf(result)) {
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
          const createdAt = dateOf(row.created_at);
          if (!Number.isFinite(createdAt.getTime()) || decision.evaluatedAt !== createdAt.toISOString() ||
              decision.mutationId !== row.mutation_id || String(row.previous_hash || '') !== expectedPrevious) {
            return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_CHAIN_MISMATCH', firstInvalidSeq: seq, headHash: expectedPrevious });
          }
          const computedDecisionHash = sha256Stable(decision);
          if (computedDecisionHash !== String(row.decision_hash || '').toLowerCase()) {
            return Object.freeze({ valid: false, checked, total, complete: false, reasonCode: 'POLICY_DECISION_HASH_MISMATCH', firstInvalidSeq: seq, headHash: expectedPrevious });
          }
          const computedRecordHash = decisionRecordHash(store.secret, {
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
