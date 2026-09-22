'use strict';

const crypto = require('crypto');
const { providerSessionKeyHash } = require('./provider-disconnect');

const TESTER_ID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RX = /^[0-9a-f]{64}$/;
const AUTHORITY_RX = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const REASON_CODE_RX = /^(?:|[A-Z][A-Z0-9_]{1,79})$/;
const RELEASE_VERSION_RX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const CORRELATION_ID_RX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const FEATURE_RX = /^[a-z][a-z0-9._-]{0,79}$/;
const ERROR_CODE_RX = /^[A-Z][A-Z0-9_]{1,79}$/;
const PROVIDERS = new Set(['github', 'gitlab', 'gitea']);
const RESOURCE_TYPES = new Set(['provider-webhook', 'temporary-branch', 'provider-session']);
const CAPABILITY_STATUSES = new Set(['Supported', 'Experimental', 'Unavailable']);
const RUNTIMES = new Set(['chrome', 'firefox', 'safari', 'edge', 'node', 'unknown']);
const FEEDBACK_INPUT_FIELDS = new Set([
  'testerId', 'releaseVersion', 'correlationId', 'provider', 'feature',
  'capabilityStatus', 'errorCode', 'runtime', 'occurredAt'
]);
const DAY_MS = 24 * 60 * 60 * 1000;

class AlphaPrivacyStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AlphaPrivacyStoreError';
    this.code = code;
  }
}

function requirePlainObject(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireTesterId(value) {
  if (typeof value !== 'string' || !TESTER_ID_RX.test(value)) {
    throw new TypeError('testerId must be a UUID');
  }
  return value.toLowerCase();
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_RX.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function requireHashList(value, label, maximum = 1000) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded hash array`);
  }
  const hashes = value.map((item, index) => requireHash(item, `${label}[${index}]`));
  if (new Set(hashes).size !== hashes.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return hashes;
}

function requireProvider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    throw new TypeError('provider is unsupported');
  }
  return value;
}

function requireAuthority(value) {
  if (
    typeof value !== 'string'
    || value.length > 255
    || !AUTHORITY_RX.test(value)
  ) {
    throw new TypeError('authority must be a normalized provider authority');
  }
  return value;
}

function requireResourceType(value) {
  if (typeof value !== 'string' || !RESOURCE_TYPES.has(value)) {
    throw new TypeError('resourceType is unsupported');
  }
  return value;
}

function requireReasonCode(value) {
  if (typeof value !== 'string' || !REASON_CODE_RX.test(value)) {
    throw new TypeError('reasonCode must be an allowlisted diagnostic code');
  }
  return value;
}

function requirePattern(value, pattern, label, maximum = 80) {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireEnum(value, values, label) {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function toDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function toIso(value) {
  return toDate(value, 'database timestamp').toISOString();
}

function cleanupTuple(row) {
  return [
    row.tester_id,
    row.identity_key,
    row.provider,
    row.resource_type,
    row.resource_key_hash
  ].join('\0');
}

function testerPurgeHash(testerId) {
  return crypto.createHash('sha256')
    .update(`nv-alpha-purge-v1\0${testerId}`, 'utf8')
    .digest('hex');
}

function purgeReportFromRow(row) {
  return Object.freeze({
    status: 'complete',
    tokenBearingStateRemoved: row.token_bearing_state_removed === true,
    providerCleanupVerified: row.provider_cleanup_verified === true,
    retainedIntegrityMetadata: row.retained_integrity_metadata === true,
    removed: Object.freeze({
      providerSessions: Number(row.provider_sessions_removed),
      webhooks: Number(row.webhooks_removed),
      events: Number(row.events_removed),
      snapshots: Number(row.snapshots_removed),
      feedback: Number(row.feedback_removed)
    }),
    completedAt: toIso(row.completed_at)
  });
}

class AlphaPrivacyStore {
  constructor(options) {
    const input = requirePlainObject(options, 'AlphaPrivacyStore options');
    if (
      !input.pool
      || typeof input.pool.query !== 'function'
      || typeof input.pool.connect !== 'function'
    ) {
      throw new TypeError('AlphaPrivacyStore requires a pg-compatible pool');
    }
    if (input.now !== undefined && typeof input.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (input.randomUUID !== undefined && typeof input.randomUUID !== 'function') {
      throw new TypeError('randomUUID must be a function');
    }
    if (input.sessionCodec !== undefined && (
      !input.sessionCodec
      || typeof input.sessionCodec !== 'object'
      || typeof input.sessionCodec.encode !== 'function'
      || typeof input.sessionCodec.decode !== 'function'
      || typeof input.sessionCodec.identityKey !== 'function'
    )) {
      throw new TypeError('sessionCodec must provide encode, decode and identityKey functions');
    }
    this.pool = input.pool;
    this.now = input.now || (() => new Date());
    this.randomUUID = input.randomUUID || crypto.randomUUID;
    this.sessionCodec = input.sessionCodec || null;
  }

  currentTime() {
    return toDate(this.now(), 'now');
  }

  async withGlobalTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('nv-alpha-privacy-lifecycle',0))"
      );
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async withLifecycleTransaction(testerId, options, callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('nv-alpha-privacy-lifecycle',0))"
      );
      const testerResult = await client.query(
        `SELECT tester_id,revoked_at,metadata_purged_at
           FROM nv_alpha_testers WHERE tester_id=$1 FOR UPDATE`,
        [testerId]
      );
      const tester = testerResult.rows[0];
      if (!tester) {
        throw new AlphaPrivacyStoreError('Alpha tester is unavailable', 'ALPHA_TESTER_UNAVAILABLE');
      }
      if ((tester.revoked_at || tester.metadata_purged_at) && !options.allowRevoked) {
        throw new AlphaPrivacyStoreError('Alpha tester is revoked', 'ALPHA_TESTER_REVOKED');
      }
      const deletionResult = await client.query(
        `SELECT request_id,tester_id,status,blocked_cleanup_ids,requested_at,completed_at
           FROM nv_alpha_deletion_requests WHERE tester_id=$1 FOR UPDATE`,
        [testerId]
      );
      const deletion = deletionResult.rows[0] || null;
      const blockedCompletion = deletion
        && deletion.status === 'blocked'
        && options.allowBlockedDeletion;
      if (deletion && !options.allowDeletion && !blockedCompletion) {
        throw new AlphaPrivacyStoreError(
          'Alpha tester deletion lifecycle has started',
          'ALPHA_TESTER_DELETING'
        );
      }
      const value = await callback(client, { tester, deletion });
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async bindProviderIdentity(input) {
    const binding = requirePlainObject(input, 'provider binding input');
    const testerId = requireTesterId(binding.testerId);
    const identityKey = requireHash(binding.identityKey, 'identityKey');
    const provider = requireProvider(binding.provider);
    const authority = requireAuthority(binding.authority);
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const existingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 FOR UPDATE`,
          [testerId, identityKey]
        );
        const lifecycleResult = await client.query(
          `SELECT EXISTS(
             SELECT 1 FROM nv_alpha_cleanup_manifest
              WHERE tester_id=$1 AND identity_key=$2
           ) AS lifecycle_started`,
          [testerId, identityKey]
        );
        if (lifecycleResult.rows[0] && lifecycleResult.rows[0].lifecycle_started) {
          throw new AlphaPrivacyStoreError(
            'Provider cleanup lifecycle has started',
            'ALPHA_PROVIDER_LIFECYCLE_STARTED'
          );
        }

        if (existingResult.rows.length) {
          const existing = existingResult.rows[0];
          if (
            existingResult.rows.length !== 1
            || existing.provider !== provider
            || existing.authority !== authority
            || existing.disconnected_at
          ) {
            throw new AlphaPrivacyStoreError(
              'Provider binding conflicts with retained lifecycle evidence',
              'ALPHA_PROVIDER_BINDING_CONFLICT'
            );
          }
          return Object.freeze({
            created: false,
            connectedAt: toIso(existing.connected_at)
          });
        }

        const inserted = await client.query(
          `INSERT INTO nv_alpha_provider_bindings(
             tester_id,identity_key,provider,authority,connected_at
           ) VALUES($1,$2,$3,$4,$5)
           RETURNING connected_at`,
          [testerId, identityKey, provider, authority, now]
        );
        return Object.freeze({
          created: true,
          connectedAt: toIso(inserted.rows[0].connected_at)
        });
      }
    );
  }

  nextUuid(label) {
    const value = this.randomUUID();
    if (typeof value !== 'string' || !TESTER_ID_RX.test(value)) {
      throw new TypeError(`randomUUID must return a UUID for ${label}`);
    }
    return value.toLowerCase();
  }

  async createCleanupTask(input) {
    const cleanup = requirePlainObject(input, 'cleanup task input');
    const testerId = requireTesterId(cleanup.testerId);
    const identityKey = requireHash(cleanup.identityKey, 'identityKey');
    const provider = requireProvider(cleanup.provider);
    const resourceType = requireResourceType(cleanup.resourceType);
    const resourceKeyHash = requireHash(cleanup.resourceKeyHash, 'resourceKeyHash');
    const reasonCode = requireReasonCode(cleanup.reasonCode || '');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const existingResult = await client.query(
          `SELECT manifest.manifest_id,manifest.tester_id,manifest.identity_key,
                  manifest.provider,manifest.resource_type,manifest.resource_key_hash,
                  task.cleanup_id,task.status,task.verified_at
             FROM nv_alpha_cleanup_manifest manifest
             INNER JOIN nv_alpha_cleanup_tasks task ON task.manifest_id=manifest.manifest_id
            WHERE manifest.tester_id=$1
              AND manifest.identity_key=$2
              AND manifest.provider=$3
              AND manifest.resource_type=$4
              AND manifest.resource_key_hash=$5
            FOR UPDATE OF manifest,task`,
          [testerId, identityKey, provider, resourceType, resourceKeyHash]
        );
        if (existingResult.rows.length) {
          const existing = existingResult.rows[0];
          if (existingResult.rows.length !== 1 || !existing.cleanup_id || !existing.status) {
            throw new AlphaPrivacyStoreError(
              'Cleanup evidence is inconsistent',
              'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
            );
          }
          return Object.freeze({
            cleanupId: existing.cleanup_id,
            status: existing.status,
            created: false
          });
        }

        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const binding = bindingResult.rows[0];
        if (bindingResult.rows.length !== 1 || !binding || binding.disconnected_at) {
          throw new AlphaPrivacyStoreError(
            'Cleanup requires one active provider binding',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }

        const manifestId = this.nextUuid('cleanup manifest');
        const cleanupId = this.nextUuid('cleanup task');
        await client.query(
          `INSERT INTO nv_alpha_cleanup_manifest(
             manifest_id,tester_id,identity_key,provider,resource_type,
             resource_key_hash,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [manifestId, testerId, identityKey, provider, resourceType, resourceKeyHash, now]
        );
        await client.query(
          `INSERT INTO nv_alpha_cleanup_tasks(
             cleanup_id,manifest_id,tester_id,identity_key,provider,resource_type,
             resource_key_hash,status,reason_code,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
          [
            cleanupId, manifestId, testerId, identityKey, provider, resourceType,
            resourceKeyHash, reasonCode, now
          ]
        );
        return Object.freeze({ cleanupId, status: 'pending', created: true });
      }
    );
  }

  async claimProviderWebhookOwnership(input) {
    const claim = requirePlainObject(input, 'provider webhook ownership input');
    const testerId = requireTesterId(claim.testerId);
    const identityKey = requireHash(claim.identityKey, 'identityKey');
    const provider = requireProvider(claim.provider);
    const resourceKeyHash = requireHash(claim.resourceKeyHash, 'resourceKeyHash');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const binding = bindingResult.rows[0];
        if (bindingResult.rows.length !== 1 || !binding || binding.disconnected_at) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook ownership requires one active binding',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }
        const webhookResult = await client.query(
          `SELECT alpha_resource_key_hash
             FROM nv_webhooks
            WHERE identity_key=$1 AND provider=$2 AND alpha_resource_key_hash=$3
            FOR UPDATE`,
          [identityKey, provider, resourceKeyHash]
        );
        if (webhookResult.rows.length !== 1) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook resource is unavailable',
            'ALPHA_PROVIDER_WEBHOOK_UNAVAILABLE'
          );
        }
        const lifecycleResult = await client.query(
          `SELECT EXISTS(
             SELECT 1 FROM nv_alpha_cleanup_manifest
              WHERE identity_key=$1 AND provider=$2
                AND (
                  (resource_type='provider-webhook' AND resource_key_hash=$3)
                  OR (tester_id=$4 AND resource_type='provider-session')
                )
           ) AS lifecycle_started`,
          [identityKey, provider, resourceKeyHash, testerId]
        );
        const existingResult = await client.query(
          `SELECT tester_id,identity_key,provider,resource_key_hash,claimed_at,released_at
             FROM nv_alpha_provider_webhook_ownership
            WHERE identity_key=$1 AND provider=$2 AND resource_key_hash=$3
            FOR UPDATE`,
          [identityKey, provider, resourceKeyHash]
        );
        const existing = existingResult.rows.find(row => row.tester_id === testerId);
        if (existing && !existing.released_at) {
          return Object.freeze({ claimed: false, claimedAt: toIso(existing.claimed_at) });
        }
        if (existing || (lifecycleResult.rows[0] && lifecycleResult.rows[0].lifecycle_started)) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook cleanup lifecycle has started',
            'ALPHA_PROVIDER_LIFECYCLE_STARTED'
          );
        }
        const inserted = await client.query(
          `INSERT INTO nv_alpha_provider_webhook_ownership(
             tester_id,identity_key,provider,resource_key_hash,claimed_at
           ) VALUES($1,$2,$3,$4,$5)
           RETURNING claimed_at`,
          [testerId, identityKey, provider, resourceKeyHash, now]
        );
        return Object.freeze({ claimed: true, claimedAt: toIso(inserted.rows[0].claimed_at) });
      }
    );
  }

  async prepareProviderDisconnect(input) {
    const preparation = requirePlainObject(input, 'provider disconnect preparation input');
    const testerId = requireTesterId(preparation.testerId);
    const identityKey = requireHash(preparation.identityKey, 'identityKey');
    const provider = requireProvider(preparation.provider);
    const currentSessionKeyHash = requireHash(
      preparation.currentSessionKeyHash,
      'currentSessionKeyHash'
    );
    const candidateWebhookHashes = requireHashList(
      preparation.webhookResourceKeyHashes,
      'webhookResourceKeyHashes'
    );
    const reasonCode = requireReasonCode(preparation.reasonCode || '');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: true, allowRevoked: true },
      async client => {
        const existingResult = await client.query(
          `SELECT manifest.manifest_id,manifest.resource_type,manifest.resource_key_hash,
                  task.cleanup_id,task.status,task.verified_at
             FROM nv_alpha_cleanup_manifest manifest
             INNER JOIN nv_alpha_cleanup_tasks task ON task.manifest_id=manifest.manifest_id
            WHERE manifest.tester_id=$1 AND manifest.identity_key=$2 AND manifest.provider=$3
            FOR UPDATE OF manifest,task`,
          [testerId, identityKey, provider]
        );
        const existingByTuple = new Map();
        for (const row of existingResult.rows) {
          const key = `${row.resource_type}\0${row.resource_key_hash}`;
          if (existingByTuple.has(key)) {
            throw new AlphaPrivacyStoreError(
              'Cleanup evidence is inconsistent',
              'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
            );
          }
          existingByTuple.set(key, row);
        }
        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const binding = bindingResult.rows[0];
        if (bindingResult.rows.length !== 1 || !binding) {
          throw new AlphaPrivacyStoreError(
            'Provider binding is unavailable',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }
        const sessionResult = await client.query(
          `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
             FROM nv_alpha_provider_session_ownership
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
            ORDER BY session_key_hash FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const webhookResult = await client.query(
          `SELECT ownership.tester_id,ownership.identity_key,ownership.provider,
                  ownership.resource_key_hash,ownership.claimed_at,ownership.released_at,
                  tester.revoked_at AS tester_revoked_at
             FROM nv_alpha_provider_webhook_ownership ownership
             JOIN nv_alpha_testers tester ON tester.tester_id=ownership.tester_id
            WHERE ownership.identity_key=$1 AND ownership.provider=$2
            ORDER BY ownership.resource_key_hash,ownership.tester_id
            FOR UPDATE OF ownership`,
          [identityKey, provider]
        );
        const activeSessionHashes = sessionResult.rows
          .filter(row => !row.released_at)
          .map(row => row.session_key_hash);
        if (!binding.disconnected_at && !activeSessionHashes.includes(currentSessionKeyHash)) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership could not be verified',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }
        if (binding.disconnected_at && !existingResult.rows.length) {
          throw new AlphaPrivacyStoreError(
            'Cleanup requires exact retained evidence',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }

        const webhookHashes = new Set(
          webhookResult.rows
            .filter(row => row.tester_id === testerId && !row.released_at)
            .map(row => row.resource_key_hash)
        );
        for (const resourceKeyHash of candidateWebhookHashes) {
          webhookHashes.add(resourceKeyHash);
        }
        const sessionHashes = new Set(activeSessionHashes);
        for (const row of existingResult.rows) {
          if (row.resource_type === 'provider-webhook') webhookHashes.add(row.resource_key_hash);
          if (row.resource_type === 'provider-session') sessionHashes.add(row.resource_key_hash);
        }
        const ensureTask = async (resourceType, resourceKeyHash) => {
          const key = `${resourceType}\0${resourceKeyHash}`;
          const existing = existingByTuple.get(key);
          if (existing) {
            return Object.freeze({
              cleanupId: existing.cleanup_id,
              status: existing.status,
              resourceKeyHash
            });
          }
          if (binding.disconnected_at) {
            throw new AlphaPrivacyStoreError(
              'Cleanup requires one active provider binding',
              'ALPHA_PROVIDER_BINDING_INACTIVE'
            );
          }
          const manifestId = this.nextUuid('cleanup manifest');
          const cleanupId = this.nextUuid('cleanup task');
          await client.query(
            `INSERT INTO nv_alpha_cleanup_manifest(
               manifest_id,tester_id,identity_key,provider,resource_type,
               resource_key_hash,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [manifestId, testerId, identityKey, provider, resourceType, resourceKeyHash, now]
          );
          await client.query(
            `INSERT INTO nv_alpha_cleanup_tasks(
               cleanup_id,manifest_id,tester_id,identity_key,provider,resource_type,
               resource_key_hash,status,reason_code,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
            [
              cleanupId, manifestId, testerId, identityKey, provider, resourceType,
              resourceKeyHash, reasonCode, now
            ]
          );
          return Object.freeze({ cleanupId, status: 'pending', resourceKeyHash });
        };

        const candidateSet = new Set(candidateWebhookHashes);
        const webhooks = [];
        for (const resourceKeyHash of [...webhookHashes].sort()) {
          const requesterOwned = webhookResult.rows.some(row => (
            row.resource_key_hash === resourceKeyHash && row.tester_id === testerId
          ));
          const task = await ensureTask('provider-webhook', resourceKeyHash);
          const shared = webhookResult.rows.some(row => (
            row.resource_key_hash === resourceKeyHash
            && row.tester_id !== testerId
            && !row.released_at
            && !row.tester_revoked_at
          ));
          webhooks.push(Object.freeze({
            ...task,
            requesterOwned,
            shared,
            localPresent: candidateSet.has(resourceKeyHash)
          }));
        }
        const providerSessions = [];
        for (const resourceKeyHash of [...sessionHashes].sort()) {
          providerSessions.push(await ensureTask('provider-session', resourceKeyHash));
        }
        if (!providerSessions.length) {
          throw new AlphaPrivacyStoreError(
            'Cleanup requires provider-session evidence',
            'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
          );
        }
        return Object.freeze({
          webhooks: Object.freeze(webhooks),
          providerSessions: Object.freeze(providerSessions)
        });
      }
    );
  }

  async completeProviderWebhookCleanup(input) {
    const completion = requirePlainObject(input, 'provider webhook completion input');
    const testerId = requireTesterId(completion.testerId);
    const identityKey = requireHash(completion.identityKey, 'identityKey');
    const provider = requireProvider(completion.provider);
    const cleanupId = requireTesterId(completion.cleanupId);
    const resourceKeyHash = requireHash(completion.resourceKeyHash, 'resourceKeyHash');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: true, allowRevoked: true },
      async client => {
        const taskResult = await client.query(
          `SELECT cleanup_id,tester_id,identity_key,provider,resource_type,
                  resource_key_hash,status,verified_at
             FROM nv_alpha_cleanup_tasks
            WHERE cleanup_id=$1 AND tester_id=$2 FOR UPDATE`,
          [cleanupId, testerId]
        );
        const task = taskResult.rows[0];
        if (
          taskResult.rows.length !== 1 || !task
          || task.identity_key !== identityKey || task.provider !== provider
          || task.resource_type !== 'provider-webhook'
          || task.resource_key_hash !== resourceKeyHash
        ) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook cleanup evidence is inconsistent',
            'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
          );
        }
        const ownersResult = await client.query(
          `SELECT ownership.tester_id,ownership.identity_key,ownership.provider,
                  ownership.resource_key_hash,ownership.claimed_at,ownership.released_at,
                  tester.revoked_at AS tester_revoked_at
             FROM nv_alpha_provider_webhook_ownership ownership
             JOIN nv_alpha_testers tester ON tester.tester_id=ownership.tester_id
            WHERE ownership.identity_key=$1 AND ownership.provider=$2
              AND ownership.resource_key_hash=$3
            FOR UPDATE OF ownership`,
          [identityKey, provider, resourceKeyHash]
        );
        const owner = ownersResult.rows.find(row => row.tester_id === testerId);
        if (!owner) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook ownership could not be verified',
            'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT'
          );
        }
        const shared = ownersResult.rows.some(row => (
          row.tester_id !== testerId && !row.released_at && !row.tester_revoked_at
        ));
        if (task.status !== 'verified' && !shared && completion.providerVerifiedAbsent !== true) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook absence is unverified',
            'ALPHA_PROVIDER_CLEANUP_UNVERIFIED'
          );
        }
        let localRemoved = false;
        if (!shared) {
          const removed = await client.query(
            `DELETE FROM nv_webhooks
              WHERE identity_key=$1 AND provider=$2 AND alpha_resource_key_hash=$3`,
            [identityKey, provider, resourceKeyHash]
          );
          localRemoved = Number(removed.rowCount) > 0;
        }
        if (!owner.released_at) {
          const released = await client.query(
            `UPDATE nv_alpha_provider_webhook_ownership
                SET released_at=$5
              WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                AND resource_key_hash=$4 AND released_at IS NULL
              RETURNING released_at`,
            [testerId, identityKey, provider, resourceKeyHash, now]
          );
          if (!released.rows[0]) {
            throw new AlphaPrivacyStoreError(
              'Provider webhook ownership release conflicted',
              'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT'
            );
          }
        }
        if (task.status !== 'verified') {
          const verified = await client.query(
            `UPDATE nv_alpha_cleanup_tasks
                SET status='verified',verified_at=$3
              WHERE cleanup_id=$1 AND tester_id=$2 AND status<>'verified'
              RETURNING cleanup_id,status,verified_at`,
            [cleanupId, testerId, now]
          );
          if (!verified.rows[0]) {
            throw new AlphaPrivacyStoreError(
              'Cleanup verification conflicted',
              'ALPHA_CLEANUP_VERIFICATION_CONFLICT'
            );
          }
        }
        return Object.freeze({ verified: true, shared, localRemoved });
      }
    );
  }

  async inspectProviderWebhookCleanup(input) {
    const inspection = requirePlainObject(input, 'provider webhook inspection input');
    const testerId = requireTesterId(inspection.testerId);
    const identityKey = requireHash(inspection.identityKey, 'identityKey');
    const provider = requireProvider(inspection.provider);
    const cleanupId = requireTesterId(inspection.cleanupId);
    const resourceKeyHash = requireHash(inspection.resourceKeyHash, 'resourceKeyHash');

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const taskResult = await client.query(
          `SELECT cleanup_id,tester_id,identity_key,provider,resource_type,
                  resource_key_hash,status,verified_at
             FROM nv_alpha_cleanup_tasks
            WHERE cleanup_id=$1 AND tester_id=$2 FOR UPDATE`,
          [cleanupId, testerId]
        );
        const task = taskResult.rows[0];
        if (
          taskResult.rows.length !== 1 || !task
          || task.identity_key !== identityKey || task.provider !== provider
          || task.resource_type !== 'provider-webhook'
          || task.resource_key_hash !== resourceKeyHash
        ) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook cleanup evidence is inconsistent',
            'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
          );
        }
        const ownersResult = await client.query(
          `SELECT ownership.tester_id,ownership.identity_key,ownership.provider,
                  ownership.resource_key_hash,ownership.claimed_at,ownership.released_at,
                  tester.revoked_at AS tester_revoked_at
             FROM nv_alpha_provider_webhook_ownership ownership
             JOIN nv_alpha_testers tester ON tester.tester_id=ownership.tester_id
            WHERE ownership.identity_key=$1 AND ownership.provider=$2
              AND ownership.resource_key_hash=$3
            FOR UPDATE OF ownership`,
          [identityKey, provider, resourceKeyHash]
        );
        if (!ownersResult.rows.some(row => row.tester_id === testerId)) {
          throw new AlphaPrivacyStoreError(
            'Provider webhook ownership could not be verified',
            'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT'
          );
        }
        return Object.freeze({
          verified: task.status === 'verified',
          shared: ownersResult.rows.some(row => (
            row.tester_id !== testerId && !row.released_at && !row.tester_revoked_at
          ))
        });
      }
    );
  }

  async completeCleanupTask(input) {
    const completion = requirePlainObject(input, 'cleanup completion input');
    const testerId = requireTesterId(completion.testerId);
    const cleanupId = requireTesterId(completion.cleanupId);
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false, allowBlockedDeletion: true },
      async client => {
        const result = await client.query(
          `SELECT cleanup_id,tester_id,status,verified_at
             FROM nv_alpha_cleanup_tasks
            WHERE cleanup_id=$1 AND tester_id=$2 FOR UPDATE`,
          [cleanupId, testerId]
        );
        const task = result.rows[0];
        if (!task) {
          throw new AlphaPrivacyStoreError(
            'Cleanup task is unavailable',
            'ALPHA_CLEANUP_TASK_UNAVAILABLE'
          );
        }
        if (task.status === 'verified') {
          return Object.freeze({
            cleanupId: task.cleanup_id,
            status: 'verified',
            verifiedAt: toIso(task.verified_at)
          });
        }
        const updated = await client.query(
          `UPDATE nv_alpha_cleanup_tasks
              SET status='verified',verified_at=$3
            WHERE cleanup_id=$1 AND tester_id=$2 AND status<>'verified'
            RETURNING cleanup_id,status,verified_at`,
          [cleanupId, testerId, now]
        );
        const verified = updated.rows[0];
        if (!verified) {
          throw new AlphaPrivacyStoreError(
            'Cleanup verification conflicted',
            'ALPHA_CLEANUP_VERIFICATION_CONFLICT'
          );
        }
        return Object.freeze({
          cleanupId: verified.cleanup_id,
          status: verified.status,
          verifiedAt: toIso(verified.verified_at)
        });
      }
    );
  }

  async cleanupReadiness(client, testerId, scope = null) {
    const [
      bindingResult,
      manifestResult,
      taskResult,
      ownershipResult,
      webhookOwnershipResult
    ] = await Promise.all([
      client.query(
        `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
           FROM nv_alpha_provider_bindings
          WHERE tester_id=$1 ORDER BY identity_key,provider`,
        [testerId]
      ),
      client.query(
        `SELECT manifest_id,tester_id,identity_key,provider,resource_type,
                resource_key_hash,created_at
           FROM nv_alpha_cleanup_manifest
          WHERE tester_id=$1 ORDER BY identity_key,provider,resource_type,resource_key_hash`,
        [testerId]
      ),
      client.query(
        `SELECT cleanup_id,manifest_id,tester_id,identity_key,provider,resource_type,
                resource_key_hash,status,reason_code,created_at,verified_at
           FROM nv_alpha_cleanup_tasks
          WHERE tester_id=$1 ORDER BY identity_key,provider,resource_type,resource_key_hash,cleanup_id`,
        [testerId]
      ),
      client.query(
        `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
           FROM nv_alpha_provider_session_ownership
          WHERE tester_id=$1 ORDER BY identity_key,provider,session_key_hash`,
        [testerId]
      ),
      client.query(
        `SELECT tester_id,identity_key,provider,resource_key_hash,claimed_at,released_at
           FROM nv_alpha_provider_webhook_ownership
          WHERE tester_id=$1 ORDER BY identity_key,provider,resource_key_hash`,
        [testerId]
      )
    ]);
    const inScope = row => !scope || (
      row.identity_key === scope.identityKey && row.provider === scope.provider
    );
    const bindings = bindingResult.rows.filter(inScope);
    const manifests = manifestResult.rows.filter(inScope);
    const tasks = taskResult.rows.filter(inScope);
    const ownership = ownershipResult.rows.filter(inScope);
    const webhookOwnership = webhookOwnershipResult.rows.filter(inScope);
    const manifestByTuple = new Map();
    const manifestById = new Map();
    const tasksByTuple = new Map();
    const diagnosticBlocks = new Map();
    const addBlock = (code, count = 1, cleanupIds = []) => {
      const existing = diagnosticBlocks.get(code) || { count: 0, cleanupIds: new Set() };
      existing.count += count;
      for (const cleanupId of cleanupIds) {
        if (cleanupId) existing.cleanupIds.add(cleanupId);
      }
      diagnosticBlocks.set(code, existing);
    };
    let exact = manifests.length > 0;
    if (!manifests.length && !bindings.length) addBlock('CLEANUP_MISSING');

    for (const manifest of manifests) {
      const key = cleanupTuple(manifest);
      if (manifestByTuple.has(key)) {
        exact = false;
        addBlock('CLEANUP_EXTRA');
      }
      manifestByTuple.set(key, manifest);
      manifestById.set(manifest.manifest_id, manifest);
    }
    for (const task of tasks) {
      const key = cleanupTuple(task);
      const group = tasksByTuple.get(key) || [];
      group.push(task);
      tasksByTuple.set(key, group);
    }

    for (const binding of bindings) {
      const hasExpectedResource = manifests.some(manifest => (
        manifest.tester_id === binding.tester_id
        && manifest.identity_key === binding.identity_key
        && manifest.provider === binding.provider
      ));
      if (!hasExpectedResource) {
        exact = false;
        addBlock('CLEANUP_MISSING');
      }
    }
    for (const owner of ownership) {
      if (owner.released_at) continue;
      const hasExpectedSession = manifests.some(manifest => (
        manifest.tester_id === owner.tester_id
        && manifest.identity_key === owner.identity_key
        && manifest.provider === owner.provider
        && manifest.resource_type === 'provider-session'
        && manifest.resource_key_hash === owner.session_key_hash
      ));
      if (!hasExpectedSession) {
        exact = false;
        addBlock('CLEANUP_MISSING');
      }
    }
    for (const owner of webhookOwnership) {
      if (owner.released_at) continue;
      const hasExpectedWebhook = manifests.some(manifest => (
        manifest.tester_id === owner.tester_id
        && manifest.identity_key === owner.identity_key
        && manifest.provider === owner.provider
        && manifest.resource_type === 'provider-webhook'
        && manifest.resource_key_hash === owner.resource_key_hash
      ));
      if (!hasExpectedWebhook) {
        exact = false;
        addBlock('CLEANUP_MISSING');
      }
    }
    if (!bindings.length && manifests.length) {
      exact = false;
      addBlock(
        'CLEANUP_ORPHAN',
        manifests.length,
        tasks.map(task => task.cleanup_id)
      );
    }

    for (const [key, manifest] of manifestByTuple) {
      const matchingTasks = tasksByTuple.get(key) || [];
      if (!matchingTasks.length) {
        exact = false;
        addBlock('CLEANUP_MISSING');
      }
      if (matchingTasks.length > 1) {
        exact = false;
        addBlock(
          'CLEANUP_EXTRA',
          matchingTasks.length - 1,
          matchingTasks.map(task => task.cleanup_id)
        );
      }
      for (const task of matchingTasks) {
        if (task.status !== 'verified' || !task.verified_at) {
          exact = false;
          addBlock('CLEANUP_UNVERIFIED', 1, [task.cleanup_id]);
        }
      }
    }
    for (const [key, matchingTasks] of tasksByTuple) {
      const tupleManifest = manifestByTuple.get(key);
      for (const task of matchingTasks) {
        const idManifest = manifestById.get(task.manifest_id);
        if (!tupleManifest) {
          exact = false;
          addBlock('CLEANUP_ORPHAN', 1, [task.cleanup_id]);
        } else if (task.manifest_id !== tupleManifest.manifest_id) {
          exact = false;
          addBlock('CLEANUP_REPLACEMENT', 1, [task.cleanup_id]);
        }
        if (idManifest && cleanupTuple(idManifest) !== key) {
          exact = false;
          addBlock('CLEANUP_MISMATCHED', 1, [task.cleanup_id]);
        }
      }
    }

    const cleanupBlocks = [...diagnosticBlocks.entries()]
      .map(([code, block]) => Object.freeze({
        code,
        count: Math.min(block.count, 10000),
        cleanupIds: Object.freeze([...block.cleanupIds].sort().slice(0, 100))
      }))
      .sort((left, right) => left.code.localeCompare(right.code));
    const blockedIds = new Set(cleanupBlocks.flatMap(block => block.cleanupIds));

    return Object.freeze({
      verified: exact,
      blockedCleanupIds: Object.freeze([...blockedIds].sort()),
      cleanupBlocks: Object.freeze(cleanupBlocks)
    });
  }

  async replaceCleanupBlocks(client, requestId, cleanupBlocks) {
    await client.query(
      'DELETE FROM nv_alpha_deletion_blocks WHERE request_id=$1',
      [requestId]
    );
    for (const block of cleanupBlocks) {
      await client.query(
        `INSERT INTO nv_alpha_deletion_blocks(
           request_id,block_code,blocked_count,cleanup_ids
         ) VALUES($1,$2,$3,$4)`,
        [requestId, block.code, block.count, [...block.cleanupIds]]
      );
    }
  }

  async createDeletionRequest(input) {
    const deletionInput = requirePlainObject(input, 'deletion request input');
    const testerId = requireTesterId(deletionInput.testerId);
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: true, allowRevoked: false },
      async (client, lifecycle) => {
        const readiness = await this.cleanupReadiness(client, testerId);
        const status = readiness.verified ? 'requested' : 'blocked';
        if (
          lifecycle.deletion
          && lifecycle.deletion.status === 'requested'
          && status !== 'requested'
        ) {
          throw new AlphaPrivacyStoreError(
            'Cleanup evidence changed after deletion became ready',
            'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
          );
        }
        if (lifecycle.deletion && lifecycle.deletion.status === 'complete') {
          return Object.freeze({
            status: 'complete',
            providerCleanupVerified: true,
            blockedCleanupIds: Object.freeze([]),
            cleanupBlocks: Object.freeze([])
          });
        }

        await client.query(
          `UPDATE nv_alpha_sessions
              SET revoked_at=COALESCE(revoked_at,$2)
            WHERE tester_id=$1`,
          [testerId, now]
        );
        let requestId = lifecycle.deletion && lifecycle.deletion.request_id;
        if (!lifecycle.deletion) {
          const inserted = await client.query(
            `INSERT INTO nv_alpha_deletion_requests(
               request_id,tester_id,status,blocked_cleanup_ids,requested_at
             ) VALUES($1,$2,$3,$4,$5)
             RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
            [
              this.nextUuid('deletion request'),
              testerId,
              status,
              [...readiness.blockedCleanupIds],
              now
            ]
          );
          requestId = inserted.rows[0].request_id;
        } else if (
          lifecycle.deletion.status !== status
          || JSON.stringify(lifecycle.deletion.blocked_cleanup_ids || [])
            !== JSON.stringify(readiness.blockedCleanupIds)
        ) {
          await client.query(
            `UPDATE nv_alpha_deletion_requests
                SET status=$2,blocked_cleanup_ids=$3
              WHERE tester_id=$1
              RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
            [testerId, status, [...readiness.blockedCleanupIds]]
          );
        }
        await this.replaceCleanupBlocks(client, requestId, readiness.cleanupBlocks);

        return Object.freeze({
          status,
          providerCleanupVerified: readiness.verified,
          blockedCleanupIds: readiness.blockedCleanupIds,
          cleanupBlocks: readiness.cleanupBlocks
        });
      }
    );
  }

  async markProviderIdentityDisconnected(input) {
    const disconnect = requirePlainObject(input, 'provider disconnect input');
    const testerId = requireTesterId(disconnect.testerId);
    const identityKey = requireHash(disconnect.identityKey, 'identityKey');
    const provider = requireProvider(disconnect.provider);
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const binding = bindingResult.rows[0];
        if (bindingResult.rows.length !== 1 || !binding) {
          throw new AlphaPrivacyStoreError(
            'Provider binding is unavailable',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }
        if (binding.disconnected_at) {
          return Object.freeze({
            disconnected: true,
            disconnectedAt: toIso(binding.disconnected_at)
          });
        }

        const readiness = await this.cleanupReadiness(
          client,
          testerId,
          { identityKey, provider }
        );
        if (!readiness.verified) {
          throw new AlphaPrivacyStoreError(
            'Provider cleanup is not verified',
            'ALPHA_PROVIDER_CLEANUP_UNVERIFIED'
          );
        }
        await client.query(
          `UPDATE nv_alpha_provider_session_ownership
              SET released_at=$4
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
              AND released_at IS NULL`,
          [testerId, identityKey, provider, now]
        );
        const updated = await client.query(
          `UPDATE nv_alpha_provider_bindings
              SET disconnected_at=$4
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
              AND disconnected_at IS NULL
            RETURNING disconnected_at`,
          [testerId, identityKey, provider, now]
        );
        if (!updated.rows[0]) {
          throw new AlphaPrivacyStoreError(
            'Provider disconnect conflicted',
            'ALPHA_PROVIDER_DISCONNECT_CONFLICT'
          );
        }
        return Object.freeze({
          disconnected: true,
          disconnectedAt: toIso(updated.rows[0].disconnected_at)
        });
      }
    );
  }

  async claimProviderSessionOwnership(input) {
    const ownership = requirePlainObject(input, 'provider session ownership input');
    const testerId = requireTesterId(ownership.testerId);
    const identityKey = requireHash(ownership.identityKey, 'identityKey');
    const provider = requireProvider(ownership.provider);
    const sessionKeyHash = requireHash(ownership.sessionKeyHash, 'sessionKeyHash');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const binding = bindingResult.rows[0];
        if (bindingResult.rows.length !== 1 || !binding || binding.disconnected_at) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership requires one active binding',
            'ALPHA_PROVIDER_BINDING_INACTIVE'
          );
        }

        const existingResult = await client.query(
          `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
             FROM nv_alpha_provider_session_ownership
            WHERE session_key_hash=$1 FOR UPDATE`,
          [sessionKeyHash]
        );
        const foreignOwner = existingResult.rows.find(row => row.tester_id !== testerId);
        const existing = existingResult.rows.find(row => (
          row.tester_id === testerId
          && row.identity_key === identityKey
          && row.provider === provider
        ));
        if (foreignOwner || (existing && existing.released_at)) {
          throw new AlphaPrivacyStoreError(
            'Provider session is already owned by another lifecycle',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }
        if (existing) {
          return Object.freeze({
            claimed: false,
            claimedAt: toIso(existing.claimed_at)
          });
        }

        const inserted = await client.query(
          `INSERT INTO nv_alpha_provider_session_ownership(
             session_key_hash,tester_id,identity_key,provider,claimed_at
           ) VALUES($1,$2,$3,$4,$5)
           RETURNING claimed_at`,
          [sessionKeyHash, testerId, identityKey, provider, now]
        );
        return Object.freeze({
          claimed: true,
          claimedAt: toIso(inserted.rows[0].claimed_at)
        });
      }
    );
  }

  requireSessionCodec() {
    if (!this.sessionCodec) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session codec is unavailable',
        'ALPHA_SESSION_CODEC_UNAVAILABLE'
      );
    }
    return this.sessionCodec;
  }

  decodeHostedSession(value) {
    const decoded = this.requireSessionCodec().decode(value);
    if (
      !decoded
      || typeof decoded !== 'object'
      || Array.isArray(decoded)
      || !Array.isArray(decoded.accounts)
    ) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session state is invalid',
        'ALPHA_PROVIDER_SESSION_STATE_INVALID'
      );
    }
    return structuredClone(decoded);
  }

  encodeHostedSession(value) {
    const encoded = this.requireSessionCodec().encode(value);
    if (typeof encoded !== 'string' || !encoded) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session state could not be encoded',
        'ALPHA_PROVIDER_SESSION_STATE_INVALID'
      );
    }
    return encoded;
  }

  hostedSessionIdentityKeys(session) {
    const codec = this.requireSessionCodec();
    const keys = [];
    for (const account of session.accounts) {
      const key = codec.identityKey(account);
      requireHash(key, 'hosted session account identityKey');
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  assertHostedSessionRowKey(row, sessionKeyHash) {
    if (!row || row.session_key_hash !== sessionKeyHash) {
      throw new AlphaPrivacyStoreError(
        'Hosted provider session ownership could not be verified',
        'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
      );
    }
  }

  async lockOwnedProviderSession(client, testerId, sessionKeyHash, options = {}) {
    const ownershipResult = await client.query(
      `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
         FROM nv_alpha_provider_session_ownership
        WHERE session_key_hash=$1 FOR UPDATE`,
      [sessionKeyHash]
    );
    const foreign = ownershipResult.rows.find(row => row.tester_id !== testerId);
    const matching = options.identityKey
      ? ownershipResult.rows.find(row => (
        row.tester_id === testerId
        && row.identity_key === options.identityKey
        && row.provider === options.provider
      ))
      : ownershipResult.rows.find(row => row.tester_id === testerId && !row.released_at);
    if (foreign || !matching || (!options.allowReleased && matching.released_at)) {
      throw new AlphaPrivacyStoreError(
        'Provider session ownership could not be verified',
        'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
      );
    }
    return matching;
  }

  async readHostedProviderSession(input) {
    const read = requirePlainObject(input, 'hosted provider session read input');
    const testerId = requireTesterId(read.testerId);
    const sessionId = String(read.sessionId || '');
    const sessionKeyHash = providerSessionKeyHash(sessionId);
    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        await this.lockOwnedProviderSession(client, testerId, sessionKeyHash);
        const result = await client.query(
          `SELECT sid,data,identity_keys,session_key_hash,revision,updated
             FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
          [sessionId]
        );
        const row = result.rows[0];
        if (!row) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider session is unavailable',
            'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
          );
        }
        this.assertHostedSessionRowKey(row, sessionKeyHash);
        const revision = Number(row.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider session revision is invalid',
            'ALPHA_PROVIDER_SESSION_STATE_INVALID'
          );
        }
        return Object.freeze({
          session: this.decodeHostedSession(row.data),
          revision
        });
      }
    );
  }

  async mutateHostedProviderSession(input) {
    const mutation = requirePlainObject(input, 'hosted provider session mutation input');
    const testerId = requireTesterId(mutation.testerId);
    const sessionId = String(mutation.sessionId || '');
    const sessionKeyHash = providerSessionKeyHash(sessionId);
    if (typeof mutation.mutate !== 'function') throw new TypeError('mutate must be a function');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.withLifecycleTransaction(
          testerId,
          { allowDeletion: false, allowRevoked: false },
          async client => {
            await this.lockOwnedProviderSession(client, testerId, sessionKeyHash);
            const result = await client.query(
              `SELECT sid,data,identity_keys,session_key_hash,revision,updated
                 FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
              [sessionId]
            );
            const row = result.rows[0];
            if (!row) {
              throw new AlphaPrivacyStoreError(
                'Hosted provider session is unavailable',
                'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
              );
            }
            this.assertHostedSessionRowKey(row, sessionKeyHash);
            const revision = Number(row.revision);
            if (!Number.isSafeInteger(revision) || revision < 0) {
              throw new AlphaPrivacyStoreError(
                'Hosted provider session revision is invalid',
                'ALPHA_PROVIDER_SESSION_STATE_INVALID'
              );
            }
            const current = this.decodeHostedSession(row.data);
            const next = await mutation.mutate(current, Object.freeze({ revision, attempt }));
            if (!next || typeof next !== 'object' || Array.isArray(next) || !Array.isArray(next.accounts)) {
              throw new AlphaPrivacyStoreError(
                'Hosted provider session mutation returned invalid state',
                'ALPHA_PROVIDER_SESSION_STATE_INVALID'
              );
            }
            const updated = await client.query(
              `UPDATE nv_sessions
                  SET data=$2,identity_keys=$3::text[],revision=revision+1,updated=$4
                WHERE sid=$1 AND revision=$5
                RETURNING revision`,
              [
                sessionId,
                this.encodeHostedSession(next),
                this.hostedSessionIdentityKeys(next),
                this.currentTime(),
                revision
              ]
            );
            if (!updated.rows[0]) {
              throw new AlphaPrivacyStoreError(
                'Hosted provider session revision conflicted',
                'ALPHA_SESSION_REVISION_CONFLICT'
              );
            }
            return Object.freeze({
              session: structuredClone(next),
              revision: Number(updated.rows[0].revision)
            });
          }
        );
      } catch (error) {
        if (error && error.code === 'ALPHA_SESSION_REVISION_CONFLICT' && attempt < 2) continue;
        throw error;
      }
    }
    throw new AlphaPrivacyStoreError(
      'Hosted provider session revision conflicted',
      'ALPHA_SESSION_REVISION_CONFLICT'
    );
  }

  async connectHostedProviderAccount(input) {
    const connection = requirePlainObject(input, 'hosted provider account connection input');
    const testerId = requireTesterId(connection.testerId);
    const sessionId = String(connection.sessionId || '');
    const sessionKeyHash = providerSessionKeyHash(sessionId);
    const account = requirePlainObject(connection.account, 'hosted provider account');
    const identityKey = requireHash(
      this.requireSessionCodec().identityKey(account),
      'hosted provider account identityKey'
    );
    const provider = requireProvider(account.provider || 'github');
    const authority = requireAuthority(connection.authority);
    const capacity = Number(connection.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
      throw new TypeError('capacity must be a bounded positive integer');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.withLifecycleTransaction(
          testerId,
          { allowDeletion: false, allowRevoked: false },
          async client => {
        const ownershipResult = await client.query(
          `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
             FROM nv_alpha_provider_session_ownership
            WHERE session_key_hash=$1 FOR UPDATE`,
          [sessionKeyHash]
        );
        if (ownershipResult.rows.some(row => row.tester_id !== testerId)) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership could not be verified',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }
        const activeOwnership = ownershipResult.rows.filter(row => !row.released_at);
        if (ownershipResult.rows.length && !activeOwnership.length) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership could not be verified',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }

        let row = null;
        let current = { accounts: [], active: 0 };
        if (activeOwnership.length) {
          const sessionResult = await client.query(
            `SELECT sid,data,identity_keys,session_key_hash,revision,updated
               FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
            [sessionId]
          );
          row = sessionResult.rows[0] || null;
          if (!row) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session is unavailable',
              'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
            );
          }
          this.assertHostedSessionRowKey(row, sessionKeyHash);
          current = this.decodeHostedSession(row.data);
        }

        const currentAccounts = current.accounts.filter(existing => !(
          this.requireSessionCodec().identityKey(existing) === identityKey
          && String(existing.provider || 'github') === provider
        ));
        const replacing = currentAccounts.length !== current.accounts.length;
        if (!replacing && current.accounts.length >= capacity) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider account capacity was reached',
            'ALPHA_PROVIDER_ACCOUNT_CAPACITY'
          );
        }

        const bindingResult = await client.query(
          `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
             FROM nv_alpha_provider_bindings
            WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
          [testerId, identityKey, provider]
        );
        const existingBinding = bindingResult.rows[0] || null;
        const lifecycleResult = await client.query(
          `SELECT EXISTS(
             SELECT 1 FROM nv_alpha_cleanup_manifest
              WHERE tester_id=$1 AND identity_key=$2
                AND resource_type='provider-session'
           ) AS lifecycle_started`,
          [testerId, identityKey]
        );
        if (lifecycleResult.rows[0] && lifecycleResult.rows[0].lifecycle_started) {
          throw new AlphaPrivacyStoreError(
            'Provider cleanup lifecycle has started',
            'ALPHA_PROVIDER_LIFECYCLE_STARTED'
          );
        }
        if (bindingResult.rows.length > 1 || (
          existingBinding
          && (existingBinding.authority !== authority || existingBinding.disconnected_at)
        )) {
          throw new AlphaPrivacyStoreError(
            'Provider binding conflicts with retained lifecycle evidence',
            'ALPHA_PROVIDER_BINDING_CONFLICT'
          );
        }
        if (!existingBinding) {
          await client.query(
            `INSERT INTO nv_alpha_provider_bindings(
               tester_id,identity_key,provider,authority,connected_at
             ) VALUES($1,$2,$3,$4,$5)
             RETURNING connected_at`,
            [testerId, identityKey, provider, authority, this.currentTime()]
          );
        }

        const existingOwnership = ownershipResult.rows.find(owner => (
          owner.tester_id === testerId
          && owner.identity_key === identityKey
          && owner.provider === provider
        ));
        if (existingOwnership && existingOwnership.released_at) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership could not be verified',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }
        if (!existingOwnership) {
          await client.query(
            `INSERT INTO nv_alpha_provider_session_ownership(
               session_key_hash,tester_id,identity_key,provider,claimed_at
             ) VALUES($1,$2,$3,$4,$5)
             RETURNING claimed_at`,
            [sessionKeyHash, testerId, identityKey, provider, this.currentTime()]
          );
        }

        const next = this.scrubIdentityBoundSessionState(current, identityKey) || {};
        next.accounts = [...currentAccounts, structuredClone(account)];
        next.active = next.accounts.length - 1;
        const encoded = this.encodeHostedSession(next);
        const identityKeys = this.hostedSessionIdentityKeys(next);
        if (!row) {
          const inserted = await client.query(
            `INSERT INTO nv_sessions(sid,data,identity_keys,session_key_hash,revision,updated)
             VALUES($1,$2,$3::text[],$4,0,$5)
             RETURNING revision`,
            [sessionId, encoded, identityKeys, sessionKeyHash, this.currentTime()]
          );
          if (!inserted.rows[0]) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session could not be created',
              'ALPHA_PROVIDER_SESSION_CONFLICT'
            );
          }
          return Object.freeze({ session: structuredClone(next), revision: 0 });
        }
        const revision = Number(row.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider session revision is invalid',
            'ALPHA_PROVIDER_SESSION_STATE_INVALID'
          );
        }
        const updated = await client.query(
          `UPDATE nv_sessions
              SET data=$2,identity_keys=$3::text[],revision=revision+1,updated=$4
            WHERE sid=$1 AND revision=$5
            RETURNING revision`,
          [sessionId, encoded, identityKeys, this.currentTime(), revision]
        );
        if (!updated.rows[0]) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider session revision conflicted',
            'ALPHA_SESSION_REVISION_CONFLICT'
          );
        }
        return Object.freeze({
          session: structuredClone(next),
          revision: Number(updated.rows[0].revision)
        });
          }
        );
      } catch (error) {
        if (error && error.code === 'ALPHA_SESSION_REVISION_CONFLICT' && attempt < 2) continue;
        throw error;
      }
    }
    throw new AlphaPrivacyStoreError(
      'Hosted provider session revision conflicted',
      'ALPHA_SESSION_REVISION_CONFLICT'
    );
  }

  async revokeOwnedProviderSessions(input) {
    const revocation = requirePlainObject(input, 'owned provider session revocation input');
    const testerId = requireTesterId(revocation.testerId);
    if (!Array.isArray(revocation.sessionIds) || revocation.sessionIds.length > 1000) {
      throw new TypeError('sessionIds must be a bounded array');
    }
    const sessionIds = revocation.sessionIds.map((value, index) => {
      if (typeof value !== 'string' || !value || value.length > 512) {
        throw new TypeError(`sessionIds[${index}] is invalid`);
      }
      return value;
    });
    if (new Set(sessionIds).size !== sessionIds.length) {
      throw new TypeError('sessionIds must not contain duplicates');
    }
    const sidByHash = new Map();
    for (const sessionId of sessionIds) {
      const hash = providerSessionKeyHash(sessionId);
      if (sidByHash.has(hash) && sidByHash.get(hash) !== sessionId) {
        throw new AlphaPrivacyStoreError(
          'Provider session reference collided',
          'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
        );
      }
      sidByHash.set(hash, sessionId);
    }
    if (!sessionIds.length) {
      return Object.freeze({ revokedSessionIds: Object.freeze([]) });
    }

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const hashes = [...sidByHash.keys()].sort();
        const ownershipResult = await client.query(
          `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
             FROM nv_alpha_provider_session_ownership
            WHERE session_key_hash=ANY($1::text[])
            ORDER BY session_key_hash,identity_key,provider FOR UPDATE`,
          [hashes]
        );
        if (ownershipResult.rows.some(row => row.tester_id !== testerId)) {
          throw new AlphaPrivacyStoreError(
            'Provider session ownership could not be verified',
            'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
          );
        }
        for (const hash of hashes) {
          if (!ownershipResult.rows.some(row => (
            row.session_key_hash === hash && row.tester_id === testerId && !row.released_at
          ))) {
            throw new AlphaPrivacyStoreError(
              'Provider session ownership could not be verified',
              'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
            );
          }
        }
        const sessionsResult = await client.query(
          `SELECT sid,data,identity_keys,session_key_hash,revision,updated
             FROM nv_sessions
            WHERE session_key_hash=ANY($1::text[])
            ORDER BY session_key_hash FOR UPDATE`,
          [hashes]
        );
        const removed = [];
        for (const row of sessionsResult.rows) {
          if (sidByHash.get(row.session_key_hash) !== row.sid) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session ownership could not be verified',
              'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
            );
          }
          const revision = Number(row.revision);
          if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session revision is invalid',
              'ALPHA_PROVIDER_SESSION_STATE_INVALID'
            );
          }
          const deleted = await client.query(
            `DELETE FROM nv_sessions
              WHERE sid=$1 AND session_key_hash=$2 AND revision=$3
              RETURNING sid`,
            [row.sid, row.session_key_hash, revision]
          );
          if (!deleted.rows[0]) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session revision conflicted',
              'ALPHA_SESSION_REVISION_CONFLICT'
            );
          }
          removed.push(row.sid);
        }
        await client.query(
          `UPDATE nv_alpha_provider_session_ownership
              SET released_at=$3
            WHERE tester_id=$1 AND session_key_hash=ANY($2::text[])
              AND released_at IS NULL`,
          [testerId, hashes, this.currentTime()]
        );
        return Object.freeze({ revokedSessionIds: Object.freeze(removed.sort()) });
      }
    );
  }

  scrubIdentityBoundSessionState(value, identityKey) {
    if (Array.isArray(value)) {
      return value
        .map(item => this.scrubIdentityBoundSessionState(item, identityKey))
        .filter(item => item !== undefined);
    }
    if (!value || typeof value !== 'object') return value;
    if (value.identityKey === identityKey) return undefined;
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = this.scrubIdentityBoundSessionState(item, identityKey);
      if (scrubbed !== undefined) clean[key] = scrubbed;
    }
    return clean;
  }

  async finalizeProviderDisconnect(input) {
    const finalization = requirePlainObject(input, 'provider disconnect finalization input');
    const testerId = requireTesterId(finalization.testerId);
    const identityKey = requireHash(finalization.identityKey, 'identityKey');
    const provider = requireProvider(finalization.provider);
    const rawTasks = Array.isArray(finalization.providerSessionTasks)
      ? finalization.providerSessionTasks
      : [{
          resourceKeyHash: finalization.sessionKeyHash,
          cleanupId: finalization.providerSessionCleanupId
        }];
    if (!rawTasks.length || rawTasks.length > 1000) {
      throw new TypeError('providerSessionTasks must be a bounded non-empty array');
    }
    const providerSessionTasks = rawTasks.map((item, index) => {
      const task = requirePlainObject(item, `providerSessionTasks[${index}]`);
      return Object.freeze({
        resourceKeyHash: requireHash(task.resourceKeyHash, 'provider session resourceKeyHash'),
        cleanupId: requireTesterId(task.cleanupId)
      });
    });
    if (
      new Set(providerSessionTasks.map(task => task.resourceKeyHash)).size !== providerSessionTasks.length
      || new Set(providerSessionTasks.map(task => task.cleanupId)).size !== providerSessionTasks.length
    ) {
      throw new TypeError('providerSessionTasks must contain exact unique tuples');
    }
    if (finalization.sessionId !== undefined && (
      providerSessionKeyHash(String(finalization.sessionId || ''))
        !== providerSessionTasks[0].resourceKeyHash
    )) {
      throw new AlphaPrivacyStoreError(
        'Provider session reference is inconsistent',
        'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
      );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.withLifecycleTransaction(
          testerId,
          { allowDeletion: true, allowRevoked: true },
          async client => {
            const bindingResult = await client.query(
              `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
                 FROM nv_alpha_provider_bindings
                WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
              [testerId, identityKey, provider]
            );
            const binding = bindingResult.rows[0];
            if (bindingResult.rows.length !== 1 || !binding) {
              throw new AlphaPrivacyStoreError(
                'Provider binding is unavailable',
                'ALPHA_PROVIDER_BINDING_INACTIVE'
              );
            }
            const ownershipResult = await client.query(
              `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
                 FROM nv_alpha_provider_session_ownership
                WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                ORDER BY session_key_hash FOR UPDATE`,
              [testerId, identityKey, provider]
            );
            const ownershipHashes = new Set(ownershipResult.rows.map(row => row.session_key_hash));
            const taskHashes = new Set(providerSessionTasks.map(task => task.resourceKeyHash));
            if (
              providerSessionTasks.some(task => !ownershipHashes.has(task.resourceKeyHash))
              || ownershipResult.rows.some(row => !row.released_at && !taskHashes.has(row.session_key_hash))
            ) {
              throw new AlphaPrivacyStoreError(
                'Provider session cleanup evidence is incomplete',
                'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
              );
            }
            const taskResult = await client.query(
              `SELECT cleanup_id,manifest_id,tester_id,identity_key,provider,
                      resource_type,resource_key_hash,status,verified_at
                 FROM nv_alpha_cleanup_tasks
                WHERE cleanup_id=ANY($1::uuid[]) AND tester_id=$2
                ORDER BY resource_key_hash FOR UPDATE`,
              [providerSessionTasks.map(task => task.cleanupId), testerId]
            );
            const taskById = new Map(taskResult.rows.map(task => [task.cleanup_id, task]));
            if (taskResult.rows.length !== providerSessionTasks.length) {
              throw new AlphaPrivacyStoreError(
                'Provider session cleanup evidence is inconsistent',
                'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
              );
            }
            for (const expected of providerSessionTasks) {
              const task = taskById.get(expected.cleanupId);
              if (
                !task || task.identity_key !== identityKey || task.provider !== provider
                || task.resource_type !== 'provider-session'
                || task.resource_key_hash !== expected.resourceKeyHash
              ) {
                throw new AlphaPrivacyStoreError(
                  'Provider session cleanup evidence is inconsistent',
                  'ALPHA_CLEANUP_EVIDENCE_MISMATCH'
                );
              }
              if (task.status !== 'verified') {
                const verified = await client.query(
                  `UPDATE nv_alpha_cleanup_tasks
                      SET status='verified',verified_at=$3
                    WHERE cleanup_id=$1 AND tester_id=$2 AND status<>'verified'
                    RETURNING cleanup_id,status,verified_at`,
                  [task.cleanup_id, testerId, this.currentTime()]
                );
                if (!verified.rows[0]) {
                  throw new AlphaPrivacyStoreError(
                    'Cleanup verification conflicted',
                    'ALPHA_CLEANUP_VERIFICATION_CONFLICT'
                  );
                }
              }
            }
            const readiness = await this.cleanupReadiness(
              client,
              testerId,
              { identityKey, provider }
            );
            if (!readiness.verified) {
              throw new AlphaPrivacyStoreError(
                'Provider cleanup is not verified',
                'ALPHA_PROVIDER_CLEANUP_UNVERIFIED'
              );
            }

            const sessionsResult = await client.query(
              `SELECT sid,data,identity_keys,session_key_hash,revision,updated
                 FROM nv_sessions
                WHERE session_key_hash=ANY($1::text[])
                ORDER BY session_key_hash FOR UPDATE`,
              [[...taskHashes].sort()]
            );
            let accountRemoved = false;
            let sessionRemoved = false;
            for (const row of sessionsResult.rows) {
              if (!taskHashes.has(row.session_key_hash)) {
                throw new AlphaPrivacyStoreError(
                  'Hosted provider session ownership could not be verified',
                  'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
                );
              }
              const revision = Number(row.revision);
              if (!Number.isSafeInteger(revision) || revision < 0) {
                throw new AlphaPrivacyStoreError(
                  'Hosted provider session revision is invalid',
                  'ALPHA_PROVIDER_SESSION_STATE_INVALID'
                );
              }
              const current = this.decodeHostedSession(row.data);
              const remainingAccounts = current.accounts.filter(account => {
                const matches = this.requireSessionCodec().identityKey(account) === identityKey
                  && String(account.provider || 'github') === provider;
                if (matches) accountRemoved = true;
                return !matches;
              });
              const scrubbed = this.scrubIdentityBoundSessionState(current, identityKey) || {};
              scrubbed.accounts = remainingAccounts;
              scrubbed.active = remainingAccounts.length
                ? Math.min(Math.max(Number(scrubbed.active) || 0, 0), remainingAccounts.length - 1)
                : 0;
              if (!remainingAccounts.length) {
                const deleted = await client.query(
                  'DELETE FROM nv_sessions WHERE sid=$1 AND revision=$2 RETURNING sid',
                  [row.sid, revision]
                );
                if (!deleted.rows[0]) {
                  throw new AlphaPrivacyStoreError(
                    'Hosted provider session revision conflicted',
                    'ALPHA_SESSION_REVISION_CONFLICT'
                  );
                }
                sessionRemoved = true;
              } else {
                const updated = await client.query(
                  `UPDATE nv_sessions
                      SET data=$2,identity_keys=$3::text[],revision=revision+1,updated=$4
                    WHERE sid=$1 AND revision=$5
                    RETURNING revision`,
                  [
                    row.sid,
                    this.encodeHostedSession(scrubbed),
                    this.hostedSessionIdentityKeys(scrubbed),
                    this.currentTime(),
                    revision
                  ]
                );
                if (!updated.rows[0]) {
                  throw new AlphaPrivacyStoreError(
                    'Hosted provider session revision conflicted',
                    'ALPHA_SESSION_REVISION_CONFLICT'
                  );
                }
              }
            }
            const activeWebhookResult = await client.query(
              `SELECT EXISTS(
                 SELECT 1 FROM nv_alpha_provider_webhook_ownership
                  WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                    AND released_at IS NULL
               ) AS active_webhook_ownership`,
              [testerId, identityKey, provider]
            );
            if (
              activeWebhookResult.rows[0]
              && activeWebhookResult.rows[0].active_webhook_ownership === true
            ) {
              throw new AlphaPrivacyStoreError(
                'Provider webhook cleanup is not verified',
                'ALPHA_PROVIDER_CLEANUP_UNVERIFIED'
              );
            }
            const sharedResult = await client.query(
              `SELECT EXISTS(
                 SELECT 1
                   FROM nv_alpha_provider_bindings shared_binding
                   JOIN nv_alpha_testers shared_tester
                     ON shared_tester.tester_id=shared_binding.tester_id
                  WHERE shared_binding.identity_key=$1
                    AND shared_binding.provider=$2
                    AND shared_binding.tester_id<>$3
                    AND shared_binding.disconnected_at IS NULL
                    AND shared_tester.revoked_at IS NULL
                 UNION ALL
                 SELECT 1
                   FROM nv_alpha_provider_session_ownership shared_owner
                   JOIN nv_alpha_testers owner_tester
                     ON owner_tester.tester_id=shared_owner.tester_id
                  WHERE shared_owner.identity_key=$1
                    AND shared_owner.provider=$2
                    AND shared_owner.tester_id<>$3
                    AND shared_owner.released_at IS NULL
                    AND owner_tester.revoked_at IS NULL
               ) AS shared_provider_state`,
              [identityKey, provider, testerId]
            );
            const sharedProviderState = !!(
              sharedResult.rows[0] && sharedResult.rows[0].shared_provider_state === true
            );
            if (!sharedProviderState) {
              await client.query(
                'DELETE FROM nv_github_app_installations WHERE identity_key=$1',
                [identityKey]
              );
            }
            await client.query(
              `UPDATE nv_alpha_provider_session_ownership
                  SET released_at=$4
                WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                  AND released_at IS NULL`,
              [testerId, identityKey, provider, this.currentTime()]
            );
            if (!binding.disconnected_at) {
              const disconnected = await client.query(
                `UPDATE nv_alpha_provider_bindings
                    SET disconnected_at=$4
                  WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                    AND disconnected_at IS NULL
                  RETURNING disconnected_at`,
                [testerId, identityKey, provider, this.currentTime()]
              );
              if (!disconnected.rows[0]) {
                throw new AlphaPrivacyStoreError(
                  'Provider disconnect conflicted',
                  'ALPHA_PROVIDER_DISCONNECT_CONFLICT'
                );
              }
            }
            return Object.freeze({
              finalized: true,
              sessionRemoved,
              accountRemoved,
              sharedProviderState
            });
          }
        );
      } catch (error) {
        if (error && error.code === 'ALPHA_SESSION_REVISION_CONFLICT' && attempt < 2) continue;
        throw error;
      }
    }
    throw new AlphaPrivacyStoreError(
      'Hosted provider session revision conflicted',
      'ALPHA_SESSION_REVISION_CONFLICT'
    );
  }

  async scrubCompletedTesterSessions(client, testerId) {
    const ownershipResult = await client.query(
      `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
         FROM nv_alpha_provider_session_ownership
        WHERE session_key_hash IN (
          SELECT DISTINCT session_key_hash
            FROM nv_alpha_provider_session_ownership
           WHERE tester_id=$1
        )
        ORDER BY session_key_hash,tester_id,identity_key,provider FOR UPDATE`,
      [testerId]
    );
    const ownersByHash = new Map();
    for (const row of ownershipResult.rows) {
      const sessionKeyHash = requireHash(row.session_key_hash, 'owned sessionKeyHash');
      const owners = ownersByHash.get(sessionKeyHash) || new Set();
      owners.add(String(row.tester_id || '').toLowerCase());
      ownersByHash.set(sessionKeyHash, owners);
    }
    const exclusivelyOwnedHashes = [...ownersByHash]
      .filter(([, owners]) => owners.size === 1 && owners.has(testerId))
      .map(([sessionKeyHash]) => sessionKeyHash)
      .sort();
    if (!exclusivelyOwnedHashes.length) return 0;
    const removed = await client.query(
      `DELETE FROM nv_sessions
        WHERE session_key_hash=ANY($1::text[])
        RETURNING sid`,
      [exclusivelyOwnedHashes]
    );
    return removed.rowCount;
  }

  async purgeTester(input) {
    const purge = requirePlainObject(input, 'tester purge input');
    const testerId = requireTesterId(purge.testerId);
    const testerIdHash = testerPurgeHash(testerId);
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: true, allowRevoked: true },
      async (client, lifecycle) => {
        const previousReport = await client.query(
          `SELECT status,token_bearing_state_removed,provider_cleanup_verified,
                  retained_integrity_metadata,provider_sessions_removed,
                  webhooks_removed,events_removed,snapshots_removed,feedback_removed,
                  completed_at
             FROM nv_alpha_purge_reports WHERE tester_id_hash=$1`,
          [testerIdHash]
        );
        if (previousReport.rows[0]) {
          await this.scrubCompletedTesterSessions(client, testerId);
          return purgeReportFromRow(previousReport.rows[0]);
        }
        if (!lifecycle.deletion) {
          throw new AlphaPrivacyStoreError(
            'Deletion request is required before purge',
            'ALPHA_DELETION_REQUEST_REQUIRED'
          );
        }

        const readiness = await this.cleanupReadiness(client, testerId);
        if (!readiness.verified) {
          if (lifecycle.deletion.status === 'blocked') {
            await client.query(
              `UPDATE nv_alpha_deletion_requests
                  SET status=$2,blocked_cleanup_ids=$3
                WHERE tester_id=$1
                RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
              [testerId, 'blocked', [...readiness.blockedCleanupIds]]
            );
          }
          await this.replaceCleanupBlocks(
            client,
            lifecycle.deletion.request_id,
            readiness.cleanupBlocks
          );
          return Object.freeze({
            status: 'blocked',
            providerCleanupVerified: false,
            blockedCleanupIds: readiness.blockedCleanupIds,
            cleanupBlocks: readiness.cleanupBlocks
          });
        }
        if (lifecycle.deletion.status === 'complete') {
          throw new AlphaPrivacyStoreError(
            'Completed deletion is missing its immutable report',
            'ALPHA_PURGE_REPORT_MISSING'
          );
        }
        if (lifecycle.deletion.status === 'blocked') {
          await client.query(
            `UPDATE nv_alpha_deletion_requests
                SET status=$2,blocked_cleanup_ids=$3
              WHERE tester_id=$1
              RETURNING request_id,status,blocked_cleanup_ids,requested_at,completed_at`,
            [testerId, 'requested', []]
          );
        }
        await this.replaceCleanupBlocks(client, lifecycle.deletion.request_id, []);

        await client.query(
          `UPDATE nv_alpha_sessions
              SET revoked_at=COALESCE(revoked_at,$2)
            WHERE tester_id=$1`,
          [testerId, now]
        );
        await client.query(
          `UPDATE nv_alpha_provider_bindings
              SET disconnected_at=COALESCE(disconnected_at,$2)
            WHERE tester_id=$1`,
          [testerId, now]
        );
        const exclusiveResult = await client.query(
          `SELECT DISTINCT binding.identity_key
             FROM nv_alpha_provider_bindings binding
            WHERE binding.tester_id=$1
              AND NOT EXISTS (
                SELECT 1
                  FROM nv_alpha_provider_bindings shared_binding
                  JOIN nv_alpha_testers shared_tester
                    ON shared_tester.tester_id=shared_binding.tester_id
                 WHERE shared_binding.identity_key=binding.identity_key
                   AND shared_binding.tester_id<>$1
                   AND shared_binding.disconnected_at IS NULL
                   AND shared_tester.revoked_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM nv_alpha_provider_session_ownership shared_owner
                  JOIN nv_alpha_testers owner_tester
                    ON owner_tester.tester_id=shared_owner.tester_id
                 WHERE shared_owner.identity_key=binding.identity_key
                   AND shared_owner.tester_id<>$1
                   AND shared_owner.released_at IS NULL
                   AND owner_tester.revoked_at IS NULL
              )
            ORDER BY binding.identity_key`,
          [testerId]
        );
        const exclusiveIdentityKeys = exclusiveResult.rows.map(row => row.identity_key);

        await client.query(
          `INSERT INTO nv_alpha_retained_integrity(
             tester_id_hash,record_kind,record_hash,previous_hash,payload_hash,
             recorded_at,retained_at
           )
           SELECT $1,'governance-audit',record_hash,previous_hash,details_hash,
                  created_at,$3::timestamptz
             FROM nv_governance_audit
            WHERE actor_identity_key=ANY($2::text[])
           UNION ALL
           SELECT $1,'governance-decision',record_hash,previous_hash,decision_hash,
                  created_at,$3::timestamptz
             FROM nv_governance_policy_decisions
            WHERE actor_identity_key=ANY($2::text[])
           ON CONFLICT DO NOTHING`,
          [testerIdHash, exclusiveIdentityKeys, now]
        );
        await client.query(
          `INSERT INTO nv_alpha_audit_purge_authorizations(
             tester_id,tester_id_hash,identity_key,record_kind,record_hash,
             previous_hash,payload_hash,created_at
           )
           SELECT $1::uuid,$2,actor_identity_key,'governance-audit',record_hash,
                  previous_hash,details_hash,$4::timestamptz
             FROM nv_governance_audit
            WHERE actor_identity_key=ANY($3::text[])
           UNION ALL
           SELECT $1::uuid,$2,actor_identity_key,'governance-decision',record_hash,
                  previous_hash,decision_hash,$4::timestamptz
             FROM nv_governance_policy_decisions
            WHERE actor_identity_key=ANY($3::text[])`,
          [testerId, testerIdHash, exclusiveIdentityKeys, now]
        );
        await client.query(
          `DELETE FROM nv_governance_audit
            WHERE actor_identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_governance_policy_decisions
            WHERE actor_identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_alpha_audit_purge_authorizations WHERE tester_id=$1`,
          [testerId]
        );

        const providerSessions = await client.query(
          `DELETE FROM nv_sessions session
            WHERE session.identity_keys && $2::text[]
              AND NOT EXISTS (
                SELECT 1 FROM nv_alpha_provider_bindings shared_binding
                JOIN nv_alpha_testers shared_tester
                  ON shared_tester.tester_id=shared_binding.tester_id
                WHERE shared_binding.tester_id<>$1
                  AND shared_binding.identity_key=ANY(session.identity_keys)
                  AND shared_binding.disconnected_at IS NULL
                  AND shared_tester.revoked_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM nv_alpha_provider_session_ownership shared_owner
                JOIN nv_alpha_testers owner_tester
                  ON owner_tester.tester_id=shared_owner.tester_id
                WHERE shared_owner.tester_id<>$1
                  AND shared_owner.identity_key=ANY(session.identity_keys)
                  AND shared_owner.released_at IS NULL
                  AND owner_tester.revoked_at IS NULL
              )`,
          [testerId, exclusiveIdentityKeys]
        );
        const webhooks = await client.query(
          `DELETE FROM nv_webhooks WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        const events = await client.query(
          `DELETE FROM nv_intelligence_events WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        const snapshots = await client.query(
          `DELETE FROM nv_recovery_snapshots WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_github_app_installations WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_security_state WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_github_app_audit WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        /*
         * Exposure scanning, added alongside the tables it owns rather than
         * afterwards. A scan and its findings are things this server learned
         * about somebody's repository -- bounded locations, a keyed fingerprint,
         * a placeholder -- and none of it should outlive the tester it was
         * learned for.
         *
         * Observations are deliberately not listed. They reference their scan
         * with ON DELETE CASCADE, so they leave with it; a second delete here
         * would make two places responsible for the same rows and one of them
         * would eventually be wrong.
         */
        await client.query(
          `DELETE FROM nv_exposure_scans WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        await client.query(
          `DELETE FROM nv_exposure_findings WHERE identity_key=ANY($1::text[])`,
          [exclusiveIdentityKeys]
        );
        const feedback = await client.query(
          `DELETE FROM nv_alpha_feedback WHERE tester_id=$1`,
          [testerId]
        );
        await client.query(
          `UPDATE nv_alpha_provider_session_ownership
              SET released_at=COALESCE(released_at,$2)
            WHERE tester_id=$1`,
          [testerId, now]
        );
        await client.query(
          `UPDATE nv_alpha_testers
              SET revoked_at=COALESCE(revoked_at,$2)
            WHERE tester_id=$1`,
          [testerId, now]
        );
        await client.query(
          `UPDATE nv_alpha_deletion_requests
              SET status='complete',blocked_cleanup_ids='{}'::uuid[],completed_at=$2
            WHERE tester_id=$1 AND status='requested'
            RETURNING request_id,status,completed_at`,
          [testerId, now]
        );

        const insertedReport = await client.query(
          `INSERT INTO nv_alpha_purge_reports(
             report_id,tester_id_hash,status,token_bearing_state_removed,
             provider_cleanup_verified,retained_integrity_metadata,
             provider_sessions_removed,webhooks_removed,events_removed,
             snapshots_removed,feedback_removed,completed_at,created_at
           ) VALUES($1,$2,'complete',true,true,true,$3,$4,$5,$6,$7,$8,$8)
           RETURNING status,token_bearing_state_removed,provider_cleanup_verified,
                     retained_integrity_metadata,provider_sessions_removed,
                     webhooks_removed,events_removed,snapshots_removed,feedback_removed,
                     completed_at`,
          [
            this.nextUuid('purge report'),
            testerIdHash,
            providerSessions.rowCount,
            webhooks.rowCount,
            events.rowCount,
            snapshots.rowCount,
            feedback.rowCount,
            now
          ]
        );
        return purgeReportFromRow(insertedReport.rows[0]);
      }
    );
  }

  async recordFeedback(input) {
    const feedback = requirePlainObject(input, 'feedback input');
    if (Object.keys(feedback).some(key => !FEEDBACK_INPUT_FIELDS.has(key))) {
      throw new AlphaPrivacyStoreError(
        'Feedback contains unsupported fields',
        'ALPHA_FEEDBACK_FIELDS_REJECTED'
      );
    }
    const testerId = requireTesterId(feedback.testerId);
    const releaseVersion = requirePattern(
      feedback.releaseVersion,
      RELEASE_VERSION_RX,
      'releaseVersion'
    );
    const correlationId = requirePattern(
      feedback.correlationId,
      CORRELATION_ID_RX,
      'correlationId'
    );
    const provider = requireProvider(feedback.provider);
    const feature = requirePattern(feedback.feature, FEATURE_RX, 'feature');
    const capabilityStatus = requireEnum(
      feedback.capabilityStatus,
      CAPABILITY_STATUSES,
      'capabilityStatus'
    );
    const errorCode = requirePattern(feedback.errorCode, ERROR_CODE_RX, 'errorCode');
    const runtime = requireEnum(feedback.runtime, RUNTIMES, 'runtime');
    const occurredAt = toDate(feedback.occurredAt, 'occurredAt');
    const now = this.currentTime();

    return this.withLifecycleTransaction(
      testerId,
      { allowDeletion: false, allowRevoked: false },
      async client => {
        const inserted = await client.query(
          `INSERT INTO nv_alpha_feedback(
             feedback_id,tester_id,release_version,correlation_id,provider,
             feature,capability_status,error_code,runtime,occurred_at,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING created_at`,
          [
            this.nextUuid('feedback'), testerId, releaseVersion, correlationId,
            provider, feature, capabilityStatus, errorCode, runtime, occurredAt, now
          ]
        );
        return Object.freeze({
          recorded: true,
          createdAt: toIso(inserted.rows[0].created_at)
        });
      }
    );
  }

  async cohortClose(input) {
    const close = requirePlainObject(input, 'cohort close input');
    const closedAt = toDate(close.closedAt, 'closedAt');
    const purgeAfter = new Date(closedAt.getTime() + 30 * DAY_MS);
    const now = this.currentTime();

    return this.withGlobalTransaction(async client => {
      const existingResult = await client.query(
        `SELECT cohort_key,closed_at,purge_after,created_at
           FROM nv_alpha_cohort_retention
          WHERE cohort_key='public-alpha-17' FOR UPDATE`
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          toDate(existing.closed_at, 'cohort closed timestamp').getTime() !== closedAt.getTime()
          || toDate(existing.purge_after, 'cohort purge timestamp').getTime()
            !== purgeAfter.getTime()
        ) {
          throw new AlphaPrivacyStoreError(
            'Cohort close boundary conflicts with retained metadata',
            'ALPHA_COHORT_CLOSE_CONFLICT'
          );
        }
        return Object.freeze({
          created: false,
          closedAt: toIso(existing.closed_at),
          purgeAfter: toIso(existing.purge_after)
        });
      }
      const inserted = await client.query(
        `INSERT INTO nv_alpha_cohort_retention(
           cohort_key,closed_at,purge_after,created_at
         ) VALUES('public-alpha-17',$1,$2,$3)
         RETURNING closed_at,purge_after`,
        [closedAt, purgeAfter, now]
      );
      return Object.freeze({
        created: true,
        closedAt: toIso(inserted.rows[0].closed_at),
        purgeAfter: toIso(inserted.rows[0].purge_after)
      });
    });
  }

  async runRetention() {
    const now = this.currentTime();
    const sessionCutoff = new Date(now.getTime() - 7 * DAY_MS);
    const feedbackCutoff = new Date(now.getTime() - 14 * DAY_MS);
    const evidenceCutoff = new Date(now.getTime() - 30 * DAY_MS);

    return this.withGlobalTransaction(async client => {
      const cohortResult = await client.query(
        `SELECT cohort_key,closed_at,purge_after,created_at
           FROM nv_alpha_cohort_retention
          WHERE cohort_key='public-alpha-17' FOR UPDATE`
      );
      const alphaSessions = await client.query(
        `DELETE FROM nv_alpha_sessions
          WHERE expires_at<=$1 OR created_at<=$2`,
        [now, sessionCutoff]
      );
      const providerSessions = await client.query(
        `DELETE FROM nv_sessions session
          WHERE session.updated<=$1
            AND EXISTS (
              SELECT 1
                FROM nv_alpha_provider_bindings binding
               WHERE binding.identity_key=ANY(session.identity_keys)
            )`,
        [sessionCutoff]
      );
      const events = await client.query(
        `DELETE FROM nv_intelligence_events event
          WHERE event.created_at<=$1
            AND EXISTS (
              SELECT 1 FROM nv_alpha_provider_bindings binding
              WHERE binding.identity_key=event.identity_key
            )`,
        [evidenceCutoff]
      );
      const snapshots = await client.query(
        `DELETE FROM nv_recovery_snapshots snapshot
          WHERE snapshot.created_at<=$1
            AND EXISTS (
              SELECT 1 FROM nv_alpha_provider_bindings binding
              WHERE binding.identity_key=snapshot.identity_key
            )`,
        [evidenceCutoff]
      );
      const exports = await client.query(
        `DELETE FROM nv_governance_exports export
          WHERE export.created_at<=$1
            AND EXISTS (
              SELECT 1 FROM nv_alpha_provider_bindings binding
              WHERE binding.identity_key=export.actor_identity_key
            )`,
        [evidenceCutoff]
      );
      const feedback = await client.query(
        `DELETE FROM nv_alpha_feedback
          WHERE created_at<=$1`,
        [feedbackCutoff]
      );
      const cohort = cohortResult.rows[0];
      let testerMetadataPurged = 0;
      let inviteMetadataPurged = 0;
      if (
        cohort
        && now >= toDate(cohort.purge_after, 'cohort purge timestamp')
      ) {
        const testerMetadata = await client.query(
          `UPDATE nv_alpha_testers
              SET tester_label=NULL,repository_scopes=NULL,terms_version=NULL,
                  terms_accepted_at=NULL,created_at=NULL,revoked_at=NULL,
                  revocation_reason=NULL,metadata_purged_at=$1
            WHERE metadata_purged_at IS NULL`,
          [now]
        );
        const inviteMetadata = await client.query(
          `UPDATE nv_alpha_invites
              SET secret_digest=NULL,tester_label=NULL,repository_scopes=NULL,
                  terms_version=NULL,created_at=NULL,expires_at=NULL,
                  redeemed_at=NULL,revoked_at=NULL,metadata_purged_at=$1
            WHERE metadata_purged_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM nv_alpha_testers tester
                 WHERE tester.invite_id=nv_alpha_invites.invite_id
                   AND tester.metadata_purged_at IS NULL
              )`,
          [now]
        );
        testerMetadataPurged = testerMetadata.rowCount;
        inviteMetadataPurged = inviteMetadata.rowCount;
      }
      return Object.freeze({
        alphaSessionsRemoved: alphaSessions.rowCount,
        providerSessionsRemoved: providerSessions.rowCount,
        eventsRemoved: events.rowCount,
        snapshotsRemoved: snapshots.rowCount,
        evidenceExportsRemoved: exports.rowCount,
        feedbackRemoved: feedback.rowCount,
        testerMetadataPurged,
        inviteMetadataPurged,
        cohortMetadataPreserved: !cohort || now < toDate(cohort.purge_after, 'cohort purge timestamp'),
        completedAt: now.toISOString()
      });
    });
  }

}

module.exports = Object.freeze({ AlphaPrivacyStore, AlphaPrivacyStoreError });
