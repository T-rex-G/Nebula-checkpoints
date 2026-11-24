import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GovernanceError, GOVERNANCE_AUDIT_GENESIS, normalizeIdentityKey, normalizeUuid, normalizeAuditDetails,
  createGovernanceAuditRecord
} from '../domain/governance-model.ts';
import { simulatePolicyImpact } from '../domain/governance-simulation.ts';
import type { PoolClient, Queryable, Row, TransactionalPool } from '../../../platform/persistence/queryable.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import {
  translateDatabaseError, normalizeIdempotencyKey, requiredText, sha256Stable, rowsOf, type GovernanceStoreOptions,
  type IdempotencyContext, type AuditContext, type Fields, type LockedChange, type AuthorizationEvidence
} from './governance-records.ts';
import {
  createPolicy, listPolicies, getPolicyStateInScope, createVersion, createDraft, getDraft, updateDraft, submitDraft,
  listVersions, getVersionInScope, getPolicyState, verifyAudit
} from './governance-policies.ts';
import {
  reviewVersionInScope, reviewRows, getReviewState, claimReviewer, recordReviewDecision, activateVersion,
  rollbackVersion, changeActiveVersion, listActivationHistory
} from './governance-reviews.ts';
import {
  lifecycleReason, lockedPolicyHead, deactivateLocked, archiveLocked, deactivatePolicy, archivePolicy, restorePolicy,
  listArchivedPolicies, discardDraft, withdrawVersion, resetGovernance
} from './governance-lifecycle-store.ts';
import {
  exceptionRowInScope, exceptionEventRows, createExceptionRequest, getException, listExceptions, decideException,
  revokeException
} from './governance-exception-store.ts';
import {
  evaluateAndAppendPolicyDecision, resolveActivePolicySetInScope, listPolicyDecisionsInScope, countMergeOutcomes,
  verifyPolicyDecisionChainInScope
} from './governance-decision-store.ts';
import { getDigitalTwinReadModelData } from './governance-read-model.ts';
import {
  eventRows, getGovernanceEvent, getNotificationPreferences, updateNotificationPreferences, markNotificationsRead,
  listNotifications, createWebhook, listWebhooks, webhookRowInScope, updateWebhook, rotateWebhookSecret, deleteWebhook,
  listWebhookDeliveries, claimWebhookDeliveries, recordWebhookDeliveryAttempt, createEvidenceExport,
  listEvidenceExports, getEvidenceExport, verifyEvidenceExport
} from './governance-delivery-store.ts';
export { translateDatabaseError } from './governance-records.ts';
export type { GovernanceActor, AuthorizationEvidence, GovernanceStoreOptions } from './governance-records.ts';

export class GovernanceStore {
  readonly pool: TransactionalPool;
  readonly secret: string;
  readonly idFactory: () => unknown;
  readonly now: () => Date;
  readonly saltFactory: () => unknown;
  readonly simulate: typeof simulatePolicyImpact;

  constructor(pool: unknown, options: GovernanceStoreOptions = {}) {
    const candidate = pool as Partial<TransactionalPool> | null | undefined;
    if (!candidate || typeof candidate.connect !== 'function' || typeof candidate.query !== 'function') {
      throw new GovernanceError('Governance requires a PostgreSQL pool', 'GOVERNANCE_DATABASE_REQUIRED', 503);
    }
    if (Buffer.byteLength(String(options.secret || ''), 'utf8') < 32) {
      throw new GovernanceError('Governance audit secret is invalid', 'GOVERNANCE_AUDIT_SECRET_INVALID', 500);
    }
    /* Both calls a store makes are present; the pool's answers are read as rows. */
    this.pool = candidate as TransactionalPool;
    this.secret = String(options.secret);
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.saltFactory = typeof options.saltFactory === 'function' ? options.saltFactory : () => randomBytes(32).toString('hex');
    this.simulate = typeof options.simulate === 'function' ? options.simulate : simulatePolicyImpact;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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

  async idempotentTransaction<T>(context: IdempotencyContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    if (!idempotencyKey) return this.transaction(work);
    const scopeKey = requiredText(context.scopeKey, 'Governance scope key', 600);
    const actorIdentityKey = normalizeIdentityKey(context.actorIdentityKey, 'idempotency actor identity');
    const operation = String(context.operation || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,99}$/.test(operation)) {
      throw new GovernanceError('Governance idempotency operation is invalid', 'GOVERNANCE_IDEMPOTENCY_OPERATION_INVALID', 500);
    }
    const keyHash = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
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
        const row = rowsOf(existing)[0];
        if (!row) throw new GovernanceError('Idempotent operation could not be resolved', 'GOVERNANCE_IDEMPOTENCY_UNAVAILABLE', 409);
        if (row.request_hash !== requestHash) {
          throw new GovernanceError('Idempotency-Key was already used for a different governance request', 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 409);
        }
        if (row.response_body == null) {
          throw new GovernanceError('An identical governance request is still being processed', 'GOVERNANCE_IDEMPOTENCY_IN_PROGRESS', 409);
        }
        if (context.validateReplay) await context.validateReplay(client, row.response_body);
        /* The stored answer is what this operation returned the first time, as JSON. */
        return row.response_body as T;
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

  async appendAudit(client: Queryable, context: AuditContext) {
    const policyId = normalizeUuid(context.policyId, 'policy id');
    const eventId = normalizeUuid(this.idFactory(), 'audit event id');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-audit:${policyId}`]);
    const previous = await client.query(
      `SELECT record_hash FROM nv_governance_audit
       WHERE policy_id=$1 ORDER BY seq DESC LIMIT 1`,
      [policyId]
    );
    const previousRow = rowsOf(previous)[0];
    const record = createGovernanceAuditRecord(this.secret, {
      eventId,
      policyId,
      versionId: context.versionId || null,
      eventType: context.eventType,
      actorIdentityKey: context.actor.identityKey,
      actorLogin: context.actor.login,
      previousHash: previousRow ? previousRow.record_hash : GOVERNANCE_AUDIT_GENESIS,
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

  createPolicy(input: Fields) {
    return createPolicy(this, input);
  }

  listPolicies(input: Fields = {}) {
    return listPolicies(this, input);
  }

  getPolicyStateInScope(input: Fields = {}) {
    return getPolicyStateInScope(this, input);
  }

  createVersion(input: Fields) {
    return createVersion(this, input);
  }

  createDraft(input: Fields = {}) {
    return createDraft(this, input);
  }

  getDraft(input: Fields = {}) {
    return getDraft(this, input);
  }

  updateDraft(input: Fields = {}) {
    return updateDraft(this, input);
  }

  submitDraft(input: Fields = {}) {
    return submitDraft(this, input);
  }

  listVersions(input: Fields = {}) {
    return listVersions(this, input);
  }

  getVersionInScope(input: Fields = {}) {
    return getVersionInScope(this, input);
  }

  reviewVersionInScope(client: Queryable, input: { readonly policyId: string; readonly versionId: string; readonly scopeKey: string }): Promise<Row> {
    return reviewVersionInScope(this, client, input);
  }

  reviewRows(client: Queryable, versionId: string) {
    return reviewRows(this, client, versionId);
  }

  getReviewState(input: Fields = {}) {
    return getReviewState(this, input);
  }

  claimReviewer(input: Fields = {}) {
    return claimReviewer(this, input);
  }

  recordReviewDecision(input: Fields = {}) {
    return recordReviewDecision(this, input);
  }

  activateVersion(input: Fields) {
    return activateVersion(this, input);
  }

  rollbackVersion(input: Fields) {
    return rollbackVersion(this, input);
  }

  changeActiveVersion(action: 'activate' | 'rollback', input: Fields = {}) {
    return changeActiveVersion(this, action, input);
  }

  lifecycleReason(value: unknown, label: string): string {
    return lifecycleReason(this, value, label);
  }

  lockedPolicyHead(client: Queryable, scope: RepositoryScope, policyId: unknown, arg3: { readonly archived?: boolean } = {}): Promise<Row> {
    return lockedPolicyHead(this, client, scope, policyId, arg3);
  }

  deactivateLocked(client: Queryable, arg1: LockedChange & { readonly authorization: AuthorizationEvidence }) {
    return deactivateLocked(this, client, arg1);
  }

  archiveLocked(client: Queryable, arg1: LockedChange & { readonly deactivated: unknown }): Promise<unknown> {
    return archiveLocked(this, client, arg1);
  }

  deactivatePolicy(input: Fields = {}) {
    return deactivatePolicy(this, input);
  }

  archivePolicy(input: Fields = {}) {
    return archivePolicy(this, input);
  }

  restorePolicy(input: Fields = {}) {
    return restorePolicy(this, input);
  }

  listArchivedPolicies(input: Fields = {}) {
    return listArchivedPolicies(this, input);
  }

  discardDraft(input: Fields = {}) {
    return discardDraft(this, input);
  }

  withdrawVersion(input: Fields = {}) {
    return withdrawVersion(this, input);
  }

  resetGovernance(input: Fields = {}) {
    return resetGovernance(this, input);
  }

  exceptionRowInScope(client: Queryable, input: Fields = {}, lock = false): Promise<Row> {
    return exceptionRowInScope(this, client, input, lock);
  }

  exceptionEventRows(client: Queryable, exceptionId: unknown): Promise<readonly Row[]> {
    return exceptionEventRows(this, client, exceptionId);
  }

  createExceptionRequest(input: Fields = {}) {
    return createExceptionRequest(this, input);
  }

  getException(input: Fields = {}) {
    return getException(this, input);
  }

  listExceptions(input: Fields = {}) {
    return listExceptions(this, input);
  }

  decideException(input: Fields = {}) {
    return decideException(this, input);
  }

  revokeException(input: Fields = {}) {
    return revokeException(this, input);
  }

  listActivationHistory(input: Fields = {}) {
    return listActivationHistory(this, input);
  }

  evaluateAndAppendPolicyDecision(input: Fields = {}) {
    return evaluateAndAppendPolicyDecision(this, input);
  }

  resolveActivePolicySetInScope(input: Fields = {}) {
    return resolveActivePolicySetInScope(this, input);
  }

  listPolicyDecisionsInScope(input: Fields = {}) {
    return listPolicyDecisionsInScope(this, input);
  }

  countMergeOutcomes(input: Fields = {}) {
    return countMergeOutcomes(this, input);
  }

  verifyPolicyDecisionChainInScope(input: Fields = {}) {
    return verifyPolicyDecisionChainInScope(this, input);
  }

  getDigitalTwinReadModelData(input: Fields = {}) {
    return getDigitalTwinReadModelData(this, input);
  }

  eventRows(client: Queryable, input: Fields = {}) {
    return eventRows(this, client, input);
  }

  getGovernanceEvent(input: Fields = {}) {
    return getGovernanceEvent(this, input);
  }

  getNotificationPreferences(input: Fields = {}) {
    return getNotificationPreferences(this, input);
  }

  updateNotificationPreferences(input: Fields = {}) {
    return updateNotificationPreferences(this, input);
  }

  markNotificationsRead(input: Fields = {}) {
    return markNotificationsRead(this, input);
  }

  listNotifications(input: Fields = {}) {
    return listNotifications(this, input);
  }

  createWebhook(input: Fields = {}) {
    return createWebhook(this, input);
  }

  listWebhooks(input: Fields = {}) {
    return listWebhooks(this, input);
  }

  webhookRowInScope(client: Queryable, scope: RepositoryScope, webhookId: unknown, lock = false): Promise<Row> {
    return webhookRowInScope(this, client, scope, webhookId, lock);
  }

  updateWebhook(input: Fields = {}) {
    return updateWebhook(this, input);
  }

  rotateWebhookSecret(input: Fields = {}) {
    return rotateWebhookSecret(this, input);
  }

  deleteWebhook(input: Fields = {}) {
    return deleteWebhook(this, input);
  }

  listWebhookDeliveries(input: Fields = {}) {
    return listWebhookDeliveries(this, input);
  }

  claimWebhookDeliveries(input: Fields = {}) {
    return claimWebhookDeliveries(this, input);
  }

  recordWebhookDeliveryAttempt(input: Fields = {}) {
    return recordWebhookDeliveryAttempt(this, input);
  }

  createEvidenceExport(input: Fields = {}) {
    return createEvidenceExport(this, input);
  }

  listEvidenceExports(input: Fields = {}) {
    return listEvidenceExports(this, input);
  }

  getEvidenceExport(input: Fields = {}) {
    return getEvidenceExport(this, input);
  }

  verifyEvidenceExport(input: Fields = {}) {
    return verifyEvidenceExport(this, input);
  }

  getPolicyState(policyId: unknown) {
    return getPolicyState(this, policyId);
  }

  verifyAudit(policyId: unknown, limit: unknown = 5000) {
    return verifyAudit(this, policyId, limit);
  }
}

/*
 * What the store's operations use of it: these members, reached through the
 * store itself, so each call still goes where the store's own would.
 */
export type GovernanceStoreContext = Pick<GovernanceStore,
  'appendAudit' | 'archiveLocked' | 'changeActiveVersion' | 'deactivateLocked' | 'eventRows'
  | 'exceptionEventRows' | 'exceptionRowInScope' | 'getEvidenceExport' | 'getNotificationPreferences' | 'idFactory'
  | 'idempotentTransaction' | 'lifecycleReason' | 'lockedPolicyHead' | 'now' | 'pool' | 'reviewRows'
  | 'reviewVersionInScope' | 'saltFactory' | 'secret' | 'simulate' | 'transaction' | 'webhookRowInScope'
>;
