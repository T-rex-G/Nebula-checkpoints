import type { Row } from '../../../platform/persistence/queryable.ts';
import {
  requirePlainObject, rowsOf, AlphaPrivacyStoreError, requireTesterId, requireHash, requireActiveProvider,
  requireAuthority, toIso, onlyRow, requireProvider, requireResourceType, requireReasonCode, requireHashList
} from './alpha-privacy-records.ts';
import type { AlphaPrivacyStoreContext } from './alpha-privacy-store.ts';

/*
 * A tester's provider identities, and cleaning up after one leaves: the
 * binding of an identity to a tester, the cleanup tasks a disconnect leaves
 * for what a provider can no longer be asked to remove, the webhooks a
 * tester owns, and the evidence that each was removed -- or why it was not.
 */

export async function bindProviderIdentity(store: AlphaPrivacyStoreContext, input: unknown): Promise<Readonly<{ created: boolean; connectedAt: string }>> {
  const binding = requirePlainObject(input, 'provider binding input');
  const testerId = requireTesterId(binding.testerId);
  const identityKey = requireHash(binding.identityKey, 'identityKey');
  const provider = requireActiveProvider(binding.provider);
  const authority = requireAuthority(binding.authority);
  const now = store.currentTime();

  return store.withLifecycleTransaction(
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
      const lifecycle = rowsOf(lifecycleResult)[0];
      if (lifecycle && lifecycle.lifecycle_started) {
        throw new AlphaPrivacyStoreError(
          'Provider cleanup lifecycle has started',
          'ALPHA_PROVIDER_LIFECYCLE_STARTED'
        );
      }

      const existingRows = rowsOf(existingResult);
      const existing = existingRows[0];
      if (existing) {
        if (
          existingRows.length !== 1
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
        connectedAt: toIso(onlyRow(inserted).connected_at)
      });
    }
  );
}

export async function createCleanupTask(store: AlphaPrivacyStoreContext, input: unknown) {
  const cleanup = requirePlainObject(input, 'cleanup task input');
  const testerId = requireTesterId(cleanup.testerId);
  const identityKey = requireHash(cleanup.identityKey, 'identityKey');
  const provider = requireProvider(cleanup.provider);
  const resourceType = requireResourceType(cleanup.resourceType);
  const resourceKeyHash = requireHash(cleanup.resourceKeyHash, 'resourceKeyHash');
  const reasonCode = requireReasonCode(cleanup.reasonCode || '');
  const now = store.currentTime();

  return store.withLifecycleTransaction(
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
      if (rowsOf(existingResult).length) {
        const existing = rowsOf(existingResult)[0];
        if (rowsOf(existingResult).length !== 1 || !existing || !existing.cleanup_id || !existing.status) {
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
      const binding = rowsOf(bindingResult)[0];
      if (rowsOf(bindingResult).length !== 1 || !binding || binding.disconnected_at) {
        throw new AlphaPrivacyStoreError(
          'Cleanup requires one active provider binding',
          'ALPHA_PROVIDER_BINDING_INACTIVE'
        );
      }

      const manifestId = store.nextUuid('cleanup manifest');
      const cleanupId = store.nextUuid('cleanup task');
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

export async function claimProviderWebhookOwnership(store: AlphaPrivacyStoreContext, input: unknown) {
  const claim = requirePlainObject(input, 'provider webhook ownership input');
  const testerId = requireTesterId(claim.testerId);
  const identityKey = requireHash(claim.identityKey, 'identityKey');
  const provider = requireActiveProvider(claim.provider);
  const resourceKeyHash = requireHash(claim.resourceKeyHash, 'resourceKeyHash');
  const now = store.currentTime();

  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: false, allowRevoked: false },
    async client => {
      const bindingResult = await client.query(
        `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
           FROM nv_alpha_provider_bindings
          WHERE tester_id=$1 AND identity_key=$2 AND provider=$3 FOR UPDATE`,
        [testerId, identityKey, provider]
      );
      const binding = rowsOf(bindingResult)[0];
      if (rowsOf(bindingResult).length !== 1 || !binding || binding.disconnected_at) {
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
      if (rowsOf(webhookResult).length !== 1) {
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
      const existing = rowsOf(existingResult).find(row => row.tester_id === testerId);
      if (existing && !existing.released_at) {
        return Object.freeze({ claimed: false, claimedAt: toIso(existing.claimed_at) });
      }
      if (existing || (rowsOf(lifecycleResult)[0] && onlyRow(lifecycleResult).lifecycle_started)) {
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
      return Object.freeze({ claimed: true, claimedAt: toIso(onlyRow(inserted).claimed_at) });
    }
  );
}

export async function prepareProviderDisconnect(store: AlphaPrivacyStoreContext, input: unknown) {
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
  const now = store.currentTime();

  return store.withLifecycleTransaction(
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
      const existingByTuple = new Map<string, Row>();
      for (const row of rowsOf(existingResult)) {
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
      const binding = rowsOf(bindingResult)[0];
      if (rowsOf(bindingResult).length !== 1 || !binding) {
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
      const activeSessionHashes = rowsOf(sessionResult)
        .filter(row => !row.released_at)
        .map(row => row.session_key_hash);
      if (!binding.disconnected_at && !activeSessionHashes.includes(currentSessionKeyHash)) {
        throw new AlphaPrivacyStoreError(
          'Provider session ownership could not be verified',
          'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
        );
      }
      if (binding.disconnected_at && !rowsOf(existingResult).length) {
        throw new AlphaPrivacyStoreError(
          'Cleanup requires exact retained evidence',
          'ALPHA_PROVIDER_BINDING_INACTIVE'
        );
      }

      const webhookHashes = new Set(
        rowsOf(webhookResult)
          .filter(row => row.tester_id === testerId && !row.released_at)
          .map(row => row.resource_key_hash)
      );
      for (const resourceKeyHash of candidateWebhookHashes) {
        webhookHashes.add(resourceKeyHash);
      }
      const sessionHashes = new Set(activeSessionHashes);
      for (const row of rowsOf(existingResult)) {
        if (row.resource_type === 'provider-webhook') webhookHashes.add(row.resource_key_hash);
        if (row.resource_type === 'provider-session') sessionHashes.add(row.resource_key_hash);
      }
      const ensureTask = async (resourceType: string, resourceKeyHash: unknown) => {
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
        const manifestId = store.nextUuid('cleanup manifest');
        const cleanupId = store.nextUuid('cleanup task');
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

      const candidateSet = new Set<unknown>(candidateWebhookHashes);
      const webhooks: Readonly<Record<string, unknown>>[] = [];
      for (const resourceKeyHash of [...webhookHashes].sort()) {
        const requesterOwned = rowsOf(webhookResult).some(row => (
          row.resource_key_hash === resourceKeyHash && row.tester_id === testerId
        ));
        const task = await ensureTask('provider-webhook', resourceKeyHash);
        const shared = rowsOf(webhookResult).some(row => (
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
      const providerSessions: Readonly<Record<string, unknown>>[] = [];
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

export async function completeProviderWebhookCleanup(store: AlphaPrivacyStoreContext, input: unknown) {
  const completion = requirePlainObject(input, 'provider webhook completion input');
  const testerId = requireTesterId(completion.testerId);
  const identityKey = requireHash(completion.identityKey, 'identityKey');
  const provider = requireProvider(completion.provider);
  const cleanupId = requireTesterId(completion.cleanupId);
  const resourceKeyHash = requireHash(completion.resourceKeyHash, 'resourceKeyHash');
  const now = store.currentTime();

  return store.withLifecycleTransaction(
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
      const task = rowsOf(taskResult)[0];
      if (
        rowsOf(taskResult).length !== 1 || !task
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
      const owner = rowsOf(ownersResult).find(row => row.tester_id === testerId);
      if (!owner) {
        throw new AlphaPrivacyStoreError(
          'Provider webhook ownership could not be verified',
          'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT'
        );
      }
      const shared = rowsOf(ownersResult).some(row => (
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
        if (!rowsOf(released)[0]) {
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
        if (!rowsOf(verified)[0]) {
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

export async function inspectProviderWebhookCleanup(store: AlphaPrivacyStoreContext, input: unknown) {
  const inspection = requirePlainObject(input, 'provider webhook inspection input');
  const testerId = requireTesterId(inspection.testerId);
  const identityKey = requireHash(inspection.identityKey, 'identityKey');
  const provider = requireProvider(inspection.provider);
  const cleanupId = requireTesterId(inspection.cleanupId);
  const resourceKeyHash = requireHash(inspection.resourceKeyHash, 'resourceKeyHash');

  return store.withLifecycleTransaction(
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
      const task = rowsOf(taskResult)[0];
      if (
        rowsOf(taskResult).length !== 1 || !task
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
      if (!rowsOf(ownersResult).some(row => row.tester_id === testerId)) {
        throw new AlphaPrivacyStoreError(
          'Provider webhook ownership could not be verified',
          'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT'
        );
      }
      return Object.freeze({
        verified: task.status === 'verified',
        shared: rowsOf(ownersResult).some(row => (
          row.tester_id !== testerId && !row.released_at && !row.tester_revoked_at
        ))
      });
    }
  );
}

export async function completeCleanupTask(store: AlphaPrivacyStoreContext, input: unknown) {
  const completion = requirePlainObject(input, 'cleanup completion input');
  const testerId = requireTesterId(completion.testerId);
  const cleanupId = requireTesterId(completion.cleanupId);
  const now = store.currentTime();

  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: false, allowRevoked: false, allowBlockedDeletion: true },
    async client => {
      const result = await client.query(
        `SELECT cleanup_id,tester_id,status,verified_at
           FROM nv_alpha_cleanup_tasks
          WHERE cleanup_id=$1 AND tester_id=$2 FOR UPDATE`,
        [cleanupId, testerId]
      );
      const task = rowsOf(result)[0];
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
      const verified = rowsOf(updated)[0];
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
