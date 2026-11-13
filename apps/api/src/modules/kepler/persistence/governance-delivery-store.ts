import { createHash } from 'node:crypto';
import { GovernanceError, normalizeUuid, normalizePolicyScope } from '../domain/governance-model.ts';
import {
  SUPPORTED_EVENT_TYPES, DEFAULT_NOTIFICATION_EVENT_TYPES, normalizeNotificationPreferences,
  normalizeWebhookDefinition, normalizeEventTypes, deriveWebhookSigningSecret, buildSignedEvidenceExport,
  verifySignedEvidenceExport
} from '../delivery/governance-delivery.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { Queryable, Row } from '../../../platform/persistence/queryable.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import {
  translateDatabaseError, normalizeIdempotencyKey, requiredText, sha256Stable, rowsOf, actorOf, onlyRow, dateOf,
  eventCursor, eventLimit, eventFromJoinedRow, mapWebhook, mapWebhookDelivery, exportRowEnvelope, type Fields
} from './governance-records.ts';
import type { GovernanceStoreContext } from './governance-store.ts';

/*
 * What governance tells others: its events, a reader's notifications and
 * their preferences, outbound webhooks and their deliveries -- leased to a
 * worker and recorded attempt by attempt -- and signed evidence exports.
 */

export async function eventRows(store: GovernanceStoreContext, client: Queryable, input: Fields = {}) {
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
  return rowsOf(result).map(eventFromJoinedRow);
}

export async function getGovernanceEvent(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const seq = eventCursor(input.eventSeq);
  if (seq < 1) throw new GovernanceError('Governance event sequence is invalid', 'GOVERNANCE_CURSOR_INVALID', 400);
  const rows = await store.eventRows(store.pool, { scope, afterSeq: seq - 1, throughSeq: seq, limit: 1 });
  if (!rows[0]) throw new GovernanceError('Governance event was not found', 'GOVERNANCE_EVENT_NOT_FOUND', 404);
  return rows[0];
}

export async function getNotificationPreferences(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const result = await store.pool.query(
    `SELECT enabled,event_types,last_read_seq,updated_at FROM nv_governance_notification_preferences
     WHERE scope_key=$1 AND identity_key=$2`,
    [scope.scopeKey, actor.identityKey]
  );
  const row = rowsOf(result)[0];
  return {
    ...normalizeNotificationPreferences(row ? { enabled: row.enabled, eventTypes: row.event_types } : {}),
    lastReadSeq: row ? Number(row.last_read_seq) : 0,
    updatedAt: row ? row.updated_at : null
  };
}

export async function updateNotificationPreferences(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const preferences = normalizeNotificationPreferences(input.preferences);
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.notification.preferences.update', request: preferences
  }, async client => {
    const result = await client.query(
      `INSERT INTO nv_governance_notification_preferences(scope_key,identity_key,enabled,event_types,last_read_seq,updated_at)
       VALUES($1,$2,$3,$4::jsonb,0,$5)
       ON CONFLICT(scope_key,identity_key) DO UPDATE SET enabled=EXCLUDED.enabled,event_types=EXCLUDED.event_types,updated_at=EXCLUDED.updated_at
       RETURNING enabled,event_types,last_read_seq,updated_at`,
      [scope.scopeKey, actor.identityKey, preferences.enabled, JSON.stringify(preferences.eventTypes), store.now().toISOString()]
    );
    const row = onlyRow(result);
    return { ...preferences, lastReadSeq: Number(row.last_read_seq), updatedAt: row.updated_at };
  });
}

export async function markNotificationsRead(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const throughSeq = eventCursor(input.throughSeq, 'Notification read cursor');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.notification.read', request: { throughSeq }
  }, async client => {
    const maximum = await client.query('SELECT COALESCE(max(event_seq),0)::bigint AS max_seq FROM nv_governance_event_outbox WHERE scope_key=$1 AND event_seq<=$2', [scope.scopeKey, throughSeq]);
    const bounded = Number(rowsOf(maximum)[0]?.max_seq || 0);
    const result = await client.query(
      `INSERT INTO nv_governance_notification_preferences(scope_key,identity_key,enabled,event_types,last_read_seq,updated_at)
       VALUES($1,$2,true,$3::jsonb,$4,$5)
       ON CONFLICT(scope_key,identity_key) DO UPDATE SET last_read_seq=GREATEST(nv_governance_notification_preferences.last_read_seq,EXCLUDED.last_read_seq),updated_at=EXCLUDED.updated_at
       RETURNING enabled,event_types,last_read_seq,updated_at`,
      [scope.scopeKey, actor.identityKey, JSON.stringify(DEFAULT_NOTIFICATION_EVENT_TYPES), bounded, store.now().toISOString()]
    );
    const row = onlyRow(result);
    return { ...normalizeNotificationPreferences({ enabled: row.enabled, eventTypes: row.event_types }), lastReadSeq: Number(row.last_read_seq), updatedAt: row.updated_at };
  });
}

export async function listNotifications(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const preferences = await store.getNotificationPreferences({ scope, actor });
  const limit = eventLimit(input.limit, 200, 50);
  const afterSeq = eventCursor(input.afterSeq);
  if (!preferences.enabled || !preferences.eventTypes.length) return { preferences, events: [], unreadCount: 0, nextSeq: null, complete: true };
  const rows = await store.eventRows(store.pool, { scope, afterSeq, limit: limit + 1, eventTypes: preferences.eventTypes });
  const events = rows.slice(0, limit);
  const lastEvent = events[events.length - 1];
  const unread = await store.pool.query(
    `SELECT count(*)::integer AS unread_count FROM nv_governance_event_outbox
     WHERE scope_key=$1 AND event_seq>$2 AND event_type=ANY($3::text[])`,
    [scope.scopeKey, preferences.lastReadSeq, preferences.eventTypes]
  );
  return {
    preferences,
    events,
    unreadCount: Number(rowsOf(unread)[0]?.unread_count || 0),
    nextSeq: lastEvent ? lastEvent.eventSeq : null,
    complete: rows.length <= limit
  };
}

export async function createWebhook(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const definition = normalizeWebhookDefinition(input.definition);
  const webhookId = normalizeUuid(store.idFactory(), 'webhook id');
  const salt = String(store.saltFactory()).trim().toLowerCase();
  if (!isSha256Hex(salt)) throw new GovernanceError('Webhook salt generator returned invalid output', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.webhook.create', request: definition
  }, async client => {
    const result = await client.query(
      `INSERT INTO nv_governance_webhooks(webhook_id,scope_key,provider,authority,owner,repo,name,endpoint_url,event_types,enabled,secret_salt,secret_version,created_by_identity_key,created_by_login,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,1,$12,$13,$14,$14) RETURNING *`,
      [webhookId, scope.scopeKey, scope.provider, scope.authority, scope.owner, scope.repo, definition.name, definition.url,
       JSON.stringify(definition.eventTypes), definition.enabled, salt, actor.identityKey, actor.login, store.now().toISOString()]
    );
    return { webhook: mapWebhook(onlyRow(result)), signingSecret: deriveWebhookSigningSecret(store.secret, scope.scopeKey, webhookId, salt, 1) };
  });
}

export async function listWebhooks(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const result = await store.pool.query(
    `SELECT * FROM nv_governance_webhooks WHERE scope_key=$1 AND deleted_at IS NULL ORDER BY created_at ASC,webhook_id ASC LIMIT 100`,
    [scope.scopeKey]
  );
  return rowsOf(result).map(mapWebhook);
}

export async function webhookRowInScope(store: GovernanceStoreContext, client: Queryable, scope: RepositoryScope, webhookId: unknown, lock = false): Promise<Row> {
  const id = normalizeUuid(webhookId, 'webhook id');
  const result = await client.query(
    `SELECT * FROM nv_governance_webhooks WHERE webhook_id=$1 AND scope_key=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, scope.scopeKey]
  );
  if (!rowsOf(result)[0]) throw new GovernanceError('Governance webhook was not found', 'GOVERNANCE_WEBHOOK_NOT_FOUND', 404);
  return onlyRow(result);
}

export async function updateWebhook(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const webhookId = normalizeUuid(input.webhookId, 'webhook id');
  const definition = normalizeWebhookDefinition(input.definition);
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.webhook.update', request: { webhookId, definition }
  }, async client => {
    await store.webhookRowInScope(client, scope, webhookId, true);
    const result = await client.query(
      `UPDATE nv_governance_webhooks SET name=$1,endpoint_url=$2,event_types=$3::jsonb,enabled=$4,updated_at=$5
       WHERE webhook_id=$6 AND scope_key=$7 AND deleted_at IS NULL RETURNING *`,
      [definition.name, definition.url, JSON.stringify(definition.eventTypes), definition.enabled, store.now().toISOString(), webhookId, scope.scopeKey]
    );
    return mapWebhook(onlyRow(result));
  });
}

export async function rotateWebhookSecret(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const webhookId = normalizeUuid(input.webhookId, 'webhook id');
  const salt = String(store.saltFactory()).trim().toLowerCase();
  if (!isSha256Hex(salt)) throw new GovernanceError('Webhook salt generator returned invalid output', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.webhook.rotate', request: { webhookId }
  }, async client => {
    const current = await store.webhookRowInScope(client, scope, webhookId, true);
    const version = Number(current.secret_version) + 1;
    const result = await client.query(
      `UPDATE nv_governance_webhooks SET secret_salt=$1,secret_version=$2,updated_at=$3 WHERE webhook_id=$4 AND scope_key=$5 RETURNING *`,
      [salt, version, store.now().toISOString(), webhookId, scope.scopeKey]
    );
    return { webhook: mapWebhook(onlyRow(result)), signingSecret: deriveWebhookSigningSecret(store.secret, scope.scopeKey, webhookId, salt, version) };
  });
}

export async function deleteWebhook(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const webhookId = normalizeUuid(input.webhookId, 'webhook id');
  return store.idempotentTransaction({
    idempotencyKey: input.idempotencyKey, scopeKey: scope.scopeKey, actorIdentityKey: actor.identityKey,
    operation: 'governance.webhook.delete', request: { webhookId }
  }, async client => {
    await store.webhookRowInScope(client, scope, webhookId, true);
    const result = await client.query(
      `UPDATE nv_governance_webhooks SET enabled=false,deleted_at=$1,updated_at=$1 WHERE webhook_id=$2 AND scope_key=$3 RETURNING *`,
      [store.now().toISOString(), webhookId, scope.scopeKey]
    );
    return mapWebhook(onlyRow(result));
  });
}

export async function listWebhookDeliveries(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const webhookId = normalizeUuid(input.webhookId, 'webhook id');
  const limit = eventLimit(input.limit, 200, 100);
  const result = await store.pool.query(
    `SELECT d.* FROM nv_governance_webhook_deliveries d
     JOIN nv_governance_webhooks w ON w.webhook_id=d.webhook_id
     WHERE w.scope_key=$1 AND w.webhook_id=$2
     ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT $3`,
    [scope.scopeKey, webhookId, limit]
  );
  return rowsOf(result).map(mapWebhookDelivery);
}

export async function claimWebhookDeliveries(store: GovernanceStoreContext, input: Fields = {}) {
  const limit = eventLimit(input.limit, 20, 10);
  const leaseSeconds = eventLimit(input.leaseSeconds, 300, 60);
  const result = await store.pool.query(
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
  return rowsOf(result).map(row => ({
    ...mapWebhookDelivery(row),
    scope: normalizePolicyScope({ provider: row.provider, baseUrl: `https://${row.authority}`, owner: row.owner, repo: row.repo }),
    url: String(row.endpoint_url),
    secretSalt: row.secret_salt,
    secretVersion: Number(row.secret_version),
    eventTypes: row.event_types,
    name: row.name
  }));
}

export async function recordWebhookDeliveryAttempt(store: GovernanceStoreContext, input: Fields = {}) {
  const deliveryId = normalizeUuid(input.deliveryId, 'webhook delivery id');
  const eventHash = requiredText(input.eventHash, 'Webhook event hash', 64).toLowerCase();
  const signatureHash = requiredText(input.signatureHash, 'Webhook signature hash', 64).toLowerCase();
  if (!isSha256Hex(eventHash) || !isSha256Hex(signatureHash)) throw new GovernanceError('Webhook attempt hashes are invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
  const requestTimestamp = dateOf(input.requestTimestamp);
  if (!Number.isFinite(requestTimestamp.getTime())) throw new GovernanceError('Webhook attempt timestamp is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
  const delivered = input.delivered === true;
  const terminal = input.terminal === true;
  const statusCode = input.statusCode == null ? null : Number(input.statusCode);
  if (statusCode != null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) throw new GovernanceError('Webhook status code is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
  const errorCode = input.errorCode == null ? null : requiredText(input.errorCode, 'Webhook error code', 100).toUpperCase();
  if (errorCode && !/^[A-Z][A-Z0-9_]{2,99}$/.test(errorCode)) throw new GovernanceError('Webhook error code is invalid', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
  if (!delivered && !errorCode) throw new GovernanceError('Webhook failure requires a bounded error code', 'GOVERNANCE_WEBHOOK_ATTEMPT_INVALID', 400);
  return store.transaction(async client => {
    const current = await client.query('SELECT * FROM nv_governance_webhook_deliveries WHERE delivery_id=$1 FOR UPDATE', [deliveryId]);
    const row = rowsOf(current)[0];
    if (!row) throw new GovernanceError('Webhook delivery was not found', 'GOVERNANCE_WEBHOOK_DELIVERY_NOT_FOUND', 404);
    if (row.status !== 'delivering') throw new GovernanceError('Webhook delivery is not leased for delivery', 'GOVERNANCE_WEBHOOK_DELIVERY_STATE_INVALID', 409);
    const attemptNumber = Number(row.attempt_count) + 1;
    if (attemptNumber > 5) throw new GovernanceError('Webhook delivery attempt limit was exceeded', 'GOVERNANCE_WEBHOOK_ATTEMPT_LIMIT', 409);
    const operationTime = store.now();
    const resultState = delivered ? 'delivered' : (terminal || attemptNumber >= 5 ? 'dead-letter' : 'retry');
    const attemptId = normalizeUuid(store.idFactory(), 'webhook attempt id');
    await client.query(
      `INSERT INTO nv_governance_webhook_attempts(attempt_id,delivery_id,attempt_number,event_hash,request_timestamp,signature_hash,result,status_code,error_code,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [attemptId, deliveryId, attemptNumber, eventHash, requestTimestamp.toISOString(), signatureHash, resultState, statusCode, errorCode, operationTime.toISOString()]
    );
    const delays = [60, 300, 1800, 7200];
    const nextAttempt = delivered || resultState === 'dead-letter' ? operationTime : new Date(operationTime.getTime() + Number(delays[attemptNumber - 1]) * 1000);
    const updated = await client.query(
      `UPDATE nv_governance_webhook_deliveries SET status=$1,attempt_count=$2,next_attempt_at=$3,lease_until=NULL,last_status_code=$4,last_error_code=$5,delivered_at=$6,updated_at=$7
       WHERE delivery_id=$8 RETURNING *`,
      [resultState, attemptNumber, nextAttempt.toISOString(), statusCode, errorCode, delivered ? operationTime.toISOString() : null, operationTime.toISOString(), deliveryId]
    );
    return mapWebhookDelivery(onlyRow(updated));
  });
}

export async function createEvidenceExport(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const actor = actorOf(input.actor);
  const format = String(input.format || '').trim().toLowerCase();
  if (!['json','csv'].includes(format)) throw new GovernanceError('Evidence export format must be json or csv', 'GOVERNANCE_EXPORT_FORMAT_INVALID', 400);
  const afterSeq = eventCursor(input.afterEventSeq);
  const requestedThrough = input.throughEventSeq == null || String(input.throughEventSeq).trim() === '' ? null : eventCursor(input.throughEventSeq, 'Evidence export upper cursor');
  const limit = eventLimit(input.limit, 1000, 1000);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) throw new GovernanceError('Evidence export requires an Idempotency-Key', 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED', 400);
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
  const requestHash = sha256Stable({ format, afterSeq, requestedThrough, limit });
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nv-governance-export:${scope.scopeKey}:${actor.identityKey}:${keyHash}`]);
    const existing = await client.query(
      `SELECT * FROM nv_governance_exports WHERE scope_key=$1 AND actor_identity_key=$2 AND idempotency_key_hash=$3`,
      [scope.scopeKey, actor.identityKey, keyHash]
    );
    if (rowsOf(existing)[0]) {
      if (onlyRow(existing).request_hash !== requestHash) throw new GovernanceError('Idempotency-Key was already used for a different evidence export', 'GOVERNANCE_IDEMPOTENCY_CONFLICT', 409);
      await client.query('COMMIT');
      return exportRowEnvelope(onlyRow(existing));
    }
    const maxResult = await client.query('SELECT COALESCE(max(event_seq),0)::bigint AS max_seq FROM nv_governance_event_outbox WHERE scope_key=$1', [scope.scopeKey]);
    const maximum = Number(rowsOf(maxResult)[0]?.max_seq || 0);
    const throughSeq = requestedThrough == null ? maximum : Math.min(requestedThrough, maximum);
    if (throughSeq && throughSeq <= afterSeq) throw new GovernanceError('Evidence export range is empty or invalid', 'GOVERNANCE_EXPORT_RANGE_INVALID', 400);
    const events = throughSeq ? await store.eventRows(client, { scope, afterSeq, throughSeq, limit: limit + 1 }) : [];
    if (events.length > limit) throw new GovernanceError('Evidence export range exceeds the 1000-record limit; create multiple cursor-bounded exports', 'GOVERNANCE_EXPORT_LIMIT', 413);
    const exportId = normalizeUuid(store.idFactory(), 'export id');
    const envelope = buildSignedEvidenceExport({ exportId, generatedAt: store.now().toISOString(), scope, actorLogin: actor.login, events, format, secret: store.secret });
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

export async function listEvidenceExports(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const limit = eventLimit(input.limit, 200, 100);
  const result = await store.pool.query(
    `SELECT export_id,export_format,after_event_seq,through_event_seq,record_count,content_hash,manifest,signature,actor_login,created_at
     FROM nv_governance_exports WHERE scope_key=$1 ORDER BY created_at DESC,export_id DESC LIMIT $2`,
    [scope.scopeKey, limit]
  );
  return rowsOf(result).map(row => ({ exportId: row.export_id, format: row.export_format, afterEventSeq: Number(row.after_event_seq), throughEventSeq: row.through_event_seq == null ? null : Number(row.through_event_seq), recordCount: Number(row.record_count), contentHash: row.content_hash, manifest: row.manifest, signature: row.signature, actorLogin: row.actor_login, createdAt: row.created_at }));
}

export async function getEvidenceExport(store: GovernanceStoreContext, input: Fields = {}) {
  const scope = normalizePolicyScope(input.scope);
  const exportId = normalizeUuid(input.exportId, 'export id');
  const result = await store.pool.query('SELECT * FROM nv_governance_exports WHERE export_id=$1 AND scope_key=$2', [exportId, scope.scopeKey]);
  if (!rowsOf(result)[0]) throw new GovernanceError('Evidence export was not found', 'GOVERNANCE_EXPORT_NOT_FOUND', 404);
  return exportRowEnvelope(onlyRow(result));
}

export async function verifyEvidenceExport(store: GovernanceStoreContext, input: Fields = {}) {
  const envelope = await store.getEvidenceExport(input);
  return verifySignedEvidenceExport(envelope, store.secret);
}
