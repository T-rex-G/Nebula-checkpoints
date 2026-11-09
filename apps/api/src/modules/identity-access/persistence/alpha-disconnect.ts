import { providerSessionKeyHash } from '../domain/provider-disconnect.ts';
import { errorCode } from '../../../platform/persistence/queryable.ts';
import type { PoolClient, Row } from '../../../platform/persistence/queryable.ts';
import {
  requirePlainObject, rowsOf, AlphaPrivacyStoreError, requireTesterId, requireHash, toIso, onlyRow, requireProvider,
  cleanupTuple, type ReadinessScope, type CleanupReadiness, type CleanupBlock, type HostedSession
} from './alpha-privacy-records.ts';
import type { AlphaPrivacyStoreContext } from './alpha-privacy-store.ts';

/*
 * Whether a tester's data may go yet, and the disconnect that ends a
 * provider identity: what still blocks deletion, a deletion requested once
 * nothing does, and a provider identity marked disconnected and finalized --
 * its sessions scrubbed of everything bound to it, in one transaction.
 */

export async function cleanupReadiness(store: AlphaPrivacyStoreContext, client: PoolClient, testerId: string, scope: ReadinessScope | null = null): Promise<CleanupReadiness> {
  /*
   * One query after another: a client runs one at a time. Handed several at
   * once, pg 8 queues them with a deprecation, and pg 9 refuses them.
   */
  const bindingResult = await client.query(
    `SELECT tester_id,identity_key,provider,authority,connected_at,disconnected_at
         FROM nv_alpha_provider_bindings
        WHERE tester_id=$1 ORDER BY identity_key,provider`,
    [testerId]
  );
  const manifestResult = await client.query(
    `SELECT manifest_id,tester_id,identity_key,provider,resource_type,
              resource_key_hash,created_at
         FROM nv_alpha_cleanup_manifest
        WHERE tester_id=$1 ORDER BY identity_key,provider,resource_type,resource_key_hash`,
    [testerId]
  );
  const taskResult = await client.query(
    `SELECT cleanup_id,manifest_id,tester_id,identity_key,provider,resource_type,
              resource_key_hash,status,reason_code,created_at,verified_at
         FROM nv_alpha_cleanup_tasks
        WHERE tester_id=$1 ORDER BY identity_key,provider,resource_type,resource_key_hash,cleanup_id`,
    [testerId]
  );
  const ownershipResult = await client.query(
    `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
         FROM nv_alpha_provider_session_ownership
        WHERE tester_id=$1 ORDER BY identity_key,provider,session_key_hash`,
    [testerId]
  );
  const webhookOwnershipResult = await client.query(
    `SELECT tester_id,identity_key,provider,resource_key_hash,claimed_at,released_at
         FROM nv_alpha_provider_webhook_ownership
        WHERE tester_id=$1 ORDER BY identity_key,provider,resource_key_hash`,
    [testerId]
  );
  const inScope = (row: Row): boolean => !scope || (
    row.identity_key === scope.identityKey && row.provider === scope.provider
  );
  const bindings = rowsOf(bindingResult).filter(inScope);
  const manifests = rowsOf(manifestResult).filter(inScope);
  const tasks = rowsOf(taskResult).filter(inScope);
  const ownership = rowsOf(ownershipResult).filter(inScope);
  const webhookOwnership = rowsOf(webhookOwnershipResult).filter(inScope);
  const manifestByTuple = new Map<string, Row>();
  const manifestById = new Map<unknown, Row>();
  const tasksByTuple = new Map<string, Row[]>();
  const diagnosticBlocks = new Map<string, { count: number; readonly cleanupIds: Set<unknown> }>();
  const addBlock = (code: string, count = 1, cleanupIds: readonly unknown[] = []): void => {
    const existing = diagnosticBlocks.get(code) || { count: 0, cleanupIds: new Set<unknown>() };
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

export async function replaceCleanupBlocks(store: AlphaPrivacyStoreContext, client: PoolClient, requestId: unknown, cleanupBlocks: readonly CleanupBlock[]): Promise<void> {
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

export async function createDeletionRequest(store: AlphaPrivacyStoreContext, input: unknown) {
  const deletionInput = requirePlainObject(input, 'deletion request input');
  const testerId = requireTesterId(deletionInput.testerId);
  const now = store.currentTime();

  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: true, allowRevoked: false },
    async (client, lifecycle) => {
      const readiness = await store.cleanupReadiness(client, testerId);
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
            store.nextUuid('deletion request'),
            testerId,
            status,
            [...readiness.blockedCleanupIds],
            now
          ]
        );
        requestId = onlyRow(inserted).request_id;
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
      await store.replaceCleanupBlocks(client, requestId, readiness.cleanupBlocks);

      return Object.freeze({
        status,
        providerCleanupVerified: readiness.verified,
        blockedCleanupIds: readiness.blockedCleanupIds,
        cleanupBlocks: readiness.cleanupBlocks
      });
    }
  );
}

export async function markProviderIdentityDisconnected(store: AlphaPrivacyStoreContext, input: unknown) {
  const disconnect = requirePlainObject(input, 'provider disconnect input');
  const testerId = requireTesterId(disconnect.testerId);
  const identityKey = requireHash(disconnect.identityKey, 'identityKey');
  const provider = requireProvider(disconnect.provider);
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
      if (rowsOf(bindingResult).length !== 1 || !binding) {
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

      const readiness = await store.cleanupReadiness(
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
      if (!rowsOf(updated)[0]) {
        throw new AlphaPrivacyStoreError(
          'Provider disconnect conflicted',
          'ALPHA_PROVIDER_DISCONNECT_CONFLICT'
        );
      }
      return Object.freeze({
        disconnected: true,
        disconnectedAt: toIso(onlyRow(updated).disconnected_at)
      });
    }
  );
}

export async function finalizeProviderDisconnect(store: AlphaPrivacyStoreContext, input: unknown) {
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
      !== providerSessionTasks[0]?.resourceKeyHash
  )) {
    throw new AlphaPrivacyStoreError(
      'Provider session reference is inconsistent',
      'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await store.withLifecycleTransaction(
        testerId,
        { allowDeletion: true, allowRevoked: true },
        async client => {
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
          const ownershipResult = await client.query(
            `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
               FROM nv_alpha_provider_session_ownership
              WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
              ORDER BY session_key_hash FOR UPDATE`,
            [testerId, identityKey, provider]
          );
          const ownershipHashes = new Set<unknown>(rowsOf(ownershipResult).map(row => row.session_key_hash));
          const taskHashes = new Set<unknown>(providerSessionTasks.map(task => task.resourceKeyHash));
          if (
            providerSessionTasks.some(task => !ownershipHashes.has(task.resourceKeyHash))
            || rowsOf(ownershipResult).some(row => !row.released_at && !taskHashes.has(row.session_key_hash))
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
          const taskById = new Map(rowsOf(taskResult).map(task => [task.cleanup_id, task]));
          if (rowsOf(taskResult).length !== providerSessionTasks.length) {
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
                [task.cleanup_id, testerId, store.currentTime()]
              );
              if (!rowsOf(verified)[0]) {
                throw new AlphaPrivacyStoreError(
                  'Cleanup verification conflicted',
                  'ALPHA_CLEANUP_VERIFICATION_CONFLICT'
                );
              }
            }
          }
          const readiness = await store.cleanupReadiness(
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
          for (const row of rowsOf(sessionsResult)) {
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
            const current = store.decodeHostedSession(row.data);
            const remainingAccounts = current.accounts.filter(account => {
              const matches = store.requireSessionCodec().identityKey(account) === identityKey
                && String(account.provider || 'github') === provider;
              if (matches) accountRemoved = true;
              return !matches;
            });
            const scrubbed = (store.scrubIdentityBoundSessionState(current, identityKey) || {}) as HostedSession;
            scrubbed.accounts = remainingAccounts;
            scrubbed.active = remainingAccounts.length
              ? Math.min(Math.max(Number(scrubbed.active) || 0, 0), remainingAccounts.length - 1)
              : 0;
            if (!remainingAccounts.length) {
              const deleted = await client.query(
                'DELETE FROM nv_sessions WHERE sid=$1 AND revision=$2 RETURNING sid',
                [row.sid, revision]
              );
              if (!rowsOf(deleted)[0]) {
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
                  store.encodeHostedSession(scrubbed),
                  store.hostedSessionIdentityKeys(scrubbed),
                  store.currentTime(),
                  revision
                ]
              );
              if (!rowsOf(updated)[0]) {
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
            rowsOf(activeWebhookResult)[0]
            && onlyRow(activeWebhookResult).active_webhook_ownership === true
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
            rowsOf(sharedResult)[0] && onlyRow(sharedResult).shared_provider_state === true
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
            [testerId, identityKey, provider, store.currentTime()]
          );
          if (!binding.disconnected_at) {
            const disconnected = await client.query(
              `UPDATE nv_alpha_provider_bindings
                  SET disconnected_at=$4
                WHERE tester_id=$1 AND identity_key=$2 AND provider=$3
                  AND disconnected_at IS NULL
                RETURNING disconnected_at`,
              [testerId, identityKey, provider, store.currentTime()]
            );
            if (!rowsOf(disconnected)[0]) {
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
      if (errorCode(error) === 'ALPHA_SESSION_REVISION_CONFLICT' && attempt < 2) continue;
      throw error;
    }
  }
  throw new AlphaPrivacyStoreError(
    'Hosted provider session revision conflicted',
    'ALPHA_SESSION_REVISION_CONFLICT'
  );
}
