import { normalizePolicyScope } from '../domain/governance-model.ts';
import { normalizeDigitalTwinOptions } from '../domain/governance-digital-twin.ts';
import { translateDatabaseError, rowsOf, onlyRow, dateOf, type Fields } from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * The data the digital twin's read model is built from: the repository's
 * policies, versions, activations, exceptions and decisions, read together.
 */

export async function getDigitalTwinReadModelData(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const options = normalizeDigitalTwinOptions({ historyLimit: input.historyLimit, afterDecisionSeq: input.afterDecisionSeq, beforeDecisionSeq: input.beforeDecisionSeq });
  const descending = options.afterDecisionSeq == null;
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await client.query('SELECT transaction_timestamp() AS as_of');
    const asOf = rowsOf(snapshot)[0]?.as_of;
    const policyLimit = 201;
    const versionLimit = 1001;
    const pageLimit = options.historyLimit + 1;
    const policiesResult = await client.query(
      `SELECT p.policy_id,p.policy_key,p.name,p.description,p.created_at,
              h.active_version_id,COALESCE(h.revision,0) AS revision,COALESCE(h.updated_at,p.created_at) AS updated_at,
              av.version_number AS active_version_number,av.document_hash AS active_document_hash,
              COALESCE(av.document->'enforcement'->>'mode','observe') AS active_enforcement_mode,
              la.action AS last_activation_action,la.version_id AS last_activation_version_id,
              lav.version_number AS last_activation_version_number,
              count(*) OVER()::integer AS total_policy_count,
              count(*) FILTER (WHERE h.active_version_id IS NOT NULL) OVER()::integer AS total_active_policy_count
         FROM nv_governance_policies p
         LEFT JOIN nv_governance_policy_heads h ON h.policy_id=p.policy_id
         LEFT JOIN nv_governance_policy_versions av ON av.policy_id=p.policy_id AND av.version_id=h.active_version_id
         LEFT JOIN LATERAL (
           SELECT a.action,a.version_id FROM nv_governance_activations a
            WHERE a.policy_id=p.policy_id
            ORDER BY a.resulting_revision DESC,a.created_at DESC,a.activation_id DESC
            LIMIT 1
         ) la ON true
         LEFT JOIN nv_governance_policy_versions lav ON lav.policy_id=p.policy_id AND lav.version_id=la.version_id
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
              EXISTS(SELECT 1 FROM nv_governance_version_withdrawals w WHERE w.version_id=v.version_id) AS withdrawn,
              EXISTS(SELECT 1 FROM nv_governance_activations act
                      WHERE act.policy_id=v.policy_id AND act.version_id=v.version_id AND act.action IN ('activate','rollback')) AS previously_active,
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
        WHERE scope_key=$1 AND ${descending ? '($2::bigint IS NULL OR seq<$2)' : 'seq>$2'}
        ORDER BY seq ${descending ? 'DESC' : 'ASC'}
        LIMIT $3`,
      [scope.scopeKey, descending ? options.beforeDecisionSeq : options.afterDecisionSeq, pageLimit]
    );
    await client.query('COMMIT');
    const policyComplete = rowsOf(policiesResult).length < policyLimit;
    const versionComplete = rowsOf(versionsResult).length < versionLimit;
    const draftComplete = rowsOf(draftsResult).length < draftLimit;
    const exceptionComplete = rowsOf(exceptionsResult).length < pageLimit;
    const activationComplete = rowsOf(activationsResult).length < pageLimit;
    const decisionComplete = rowsOf(decisionsResult).length < pageLimit;
    const decisions = rowsOf(decisionsResult).slice(0, options.historyLimit);
    const lastDecision = decisions[decisions.length - 1];
    return {
      asOf: dateOf(asOf).toISOString(),
      totals: {
        policies: rowsOf(policiesResult)[0] ? Number(onlyRow(policiesResult).total_policy_count) : 0,
        activePolicies: rowsOf(policiesResult)[0] ? Number(onlyRow(policiesResult).total_active_policy_count) : 0,
        versions: rowsOf(versionsResult)[0] ? Number(onlyRow(versionsResult).total_version_count) : 0
      },
      policies: rowsOf(policiesResult).slice(0, policyLimit - 1),
      versions: rowsOf(versionsResult).slice(0, versionLimit - 1),
      drafts: rowsOf(draftsResult).slice(0, draftLimit - 1),
      exceptions: rowsOf(exceptionsResult).slice(0, options.historyLimit),
      activations: rowsOf(activationsResult).slice(0, options.historyLimit),
      decisions,
      activeExceptionSummary: rowsOf(activeExceptionSummaryResult),
      completeness: {
        policies: policyComplete,
        versions: versionComplete,
        drafts: draftComplete,
        exceptions: exceptionComplete,
        activations: activationComplete,
        decisions: decisionComplete
      },
      decisionOrder: descending ? 'desc' : 'asc',
      nextDecisionSeq: !descending && !decisionComplete && lastDecision ? Number(lastDecision.seq) : null,
      nextBeforeDecisionSeq: descending && !decisionComplete && lastDecision ? Number(lastDecision.seq) : null
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw translateDatabaseError(error);
  } finally {
    client.release();
  }
}
