import { providerSessionKeyHash } from '../domain/provider-disconnect.ts';
import { errorCode } from '../../../platform/persistence/queryable.ts';
import type { PoolClient, Row } from '../../../platform/persistence/queryable.ts';
import {
  requirePlainObject, rowsOf, AlphaPrivacyStoreError, requireTesterId, requireHash, requireActiveProvider,
  requireAuthority, toIso, onlyRow, type HostedSession, type SessionLockOptions
} from './alpha-privacy-records.ts';
import type { AlphaPrivacyStoreContext } from './alpha-privacy-store.ts';

/*
 * Provider sessions the alpha hosts for a tester: owned by one tester,
 * locked while read or changed, sealed at rest, and revoked together. A
 * session is only ever read or written under its owner's lock, so two
 * requests from one tester cannot each change a copy of it.
 */

export async function claimProviderSessionOwnership(store: AlphaPrivacyStoreContext, input: unknown) {
  const ownership = requirePlainObject(input, 'provider session ownership input');
  const testerId = requireTesterId(ownership.testerId);
  const identityKey = requireHash(ownership.identityKey, 'identityKey');
  const provider = requireActiveProvider(ownership.provider);
  const sessionKeyHash = requireHash(ownership.sessionKeyHash, 'sessionKeyHash');
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
      const foreignOwner = rowsOf(existingResult).find(row => row.tester_id !== testerId);
      const existing = rowsOf(existingResult).find(row => (
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
        claimedAt: toIso(onlyRow(inserted).claimed_at)
      });
    }
  );
}

export async function lockOwnedProviderSession(store: AlphaPrivacyStoreContext, client: PoolClient, testerId: string, sessionKeyHash: unknown, options: SessionLockOptions = {}): Promise<Row> {
  const ownershipResult = await client.query(
    `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
       FROM nv_alpha_provider_session_ownership
      WHERE session_key_hash=$1 FOR UPDATE`,
    [sessionKeyHash]
  );
  const foreign = rowsOf(ownershipResult).find(row => row.tester_id !== testerId);
  const matching = options.identityKey
    ? rowsOf(ownershipResult).find(row => (
      row.tester_id === testerId
      && row.identity_key === options.identityKey
      && row.provider === options.provider
    ))
    : rowsOf(ownershipResult).find(row => row.tester_id === testerId && !row.released_at);
  /*
   * No other tester holds it and this tester no longer does: a disconnect or
   * sign-out ended it. A copy of its cookie is a session that has ended, not
   * a dispute over who owns it.
   */
  if (!foreign && !options.identityKey && !matching) {
    throw new AlphaPrivacyStoreError(
      'Hosted provider session has ended',
      'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
    );
  }
  if (foreign || !matching || (!options.allowReleased && matching.released_at)) {
    throw new AlphaPrivacyStoreError(
      'Provider session ownership could not be verified',
      'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
    );
  }
  return matching;
}

export async function readHostedProviderSession(store: AlphaPrivacyStoreContext, input: unknown) {
  const read = requirePlainObject(input, 'hosted provider session read input');
  const testerId = requireTesterId(read.testerId);
  const sessionId = String(read.sessionId || '');
  const sessionKeyHash = providerSessionKeyHash(sessionId);
  return store.withLifecycleTransaction(
    testerId,
    { allowDeletion: false, allowRevoked: false },
    async client => {
      await store.lockOwnedProviderSession(client, testerId, sessionKeyHash);
      const result = await client.query(
        `SELECT sid,data,identity_keys,session_key_hash,revision,updated
           FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
        [sessionId]
      );
      const row = rowsOf(result)[0];
      if (!row) {
        throw new AlphaPrivacyStoreError(
          'Hosted provider session is unavailable',
          'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
        );
      }
      store.assertHostedSessionRowKey(row, sessionKeyHash);
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new AlphaPrivacyStoreError(
          'Hosted provider session revision is invalid',
          'ALPHA_PROVIDER_SESSION_STATE_INVALID'
        );
      }
      return Object.freeze({
        session: store.decodeHostedSession(row.data),
        revision
      });
    }
  );
}

export async function mutateHostedProviderSession(store: AlphaPrivacyStoreContext, input: unknown) {
  const mutation = requirePlainObject(input, 'hosted provider session mutation input');
  const testerId = requireTesterId(mutation.testerId);
  const sessionId = String(mutation.sessionId || '');
  const sessionKeyHash = providerSessionKeyHash(sessionId);
  const mutate = mutation.mutate;
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await store.withLifecycleTransaction(
        testerId,
        { allowDeletion: false, allowRevoked: false },
        async client => {
          await store.lockOwnedProviderSession(client, testerId, sessionKeyHash);
          const result = await client.query(
            `SELECT sid,data,identity_keys,session_key_hash,revision,updated
               FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
            [sessionId]
          );
          const row = rowsOf(result)[0];
          if (!row) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session is unavailable',
              'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
            );
          }
          store.assertHostedSessionRowKey(row, sessionKeyHash);
          const revision = Number(row.revision);
          if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new AlphaPrivacyStoreError(
              'Hosted provider session revision is invalid',
              'ALPHA_PROVIDER_SESSION_STATE_INVALID'
            );
          }
          const current = store.decodeHostedSession(row.data);
          const next = await mutate(current, Object.freeze({ revision, attempt })) as HostedSession | null | undefined;
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
              store.encodeHostedSession(next),
              store.hostedSessionIdentityKeys(next),
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
          return Object.freeze({
            session: structuredClone(next),
            revision: Number(onlyRow(updated).revision)
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

export async function connectHostedProviderAccount(store: AlphaPrivacyStoreContext, input: unknown) {
  const connection = requirePlainObject(input, 'hosted provider account connection input');
  const testerId = requireTesterId(connection.testerId);
  const sessionId = String(connection.sessionId || '');
  const sessionKeyHash = providerSessionKeyHash(sessionId);
  const account = requirePlainObject(connection.account, 'hosted provider account');
  const identityKey = requireHash(
    store.requireSessionCodec().identityKey(account),
    'hosted provider account identityKey'
  );
  const provider = requireActiveProvider(account.provider || 'github');
  const authority = requireAuthority(connection.authority);
  const capacity = Number(connection.capacity);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
    throw new TypeError('capacity must be a bounded positive integer');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await store.withLifecycleTransaction(
        testerId,
        { allowDeletion: false, allowRevoked: false },
        async client => {
      const ownershipResult = await client.query(
        `SELECT session_key_hash,tester_id,identity_key,provider,claimed_at,released_at
           FROM nv_alpha_provider_session_ownership
          WHERE session_key_hash=$1 FOR UPDATE`,
        [sessionKeyHash]
      );
      if (rowsOf(ownershipResult).some(row => row.tester_id !== testerId)) {
        throw new AlphaPrivacyStoreError(
          'Provider session ownership could not be verified',
          'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
        );
      }
      const activeOwnership = rowsOf(ownershipResult).filter(row => !row.released_at);
      if (rowsOf(ownershipResult).length && !activeOwnership.length) {
        /* This tester's own session, ended by a disconnect or sign-out. */
        throw new AlphaPrivacyStoreError(
          'Hosted provider session has ended',
          'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
        );
      }

      let row: Row | null = null;
      let current: HostedSession = { accounts: [], active: 0 };
      if (activeOwnership.length) {
        const sessionResult = await client.query(
          `SELECT sid,data,identity_keys,session_key_hash,revision,updated
             FROM nv_sessions WHERE sid=$1 FOR UPDATE`,
          [sessionId]
        );
        row = rowsOf(sessionResult)[0] || null;
        if (!row) {
          throw new AlphaPrivacyStoreError(
            'Hosted provider session is unavailable',
            'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
          );
        }
        store.assertHostedSessionRowKey(row, sessionKeyHash);
        current = store.decodeHostedSession(row.data);
      }

      const currentAccounts = current.accounts.filter(existing => !(
        store.requireSessionCodec().identityKey(existing) === identityKey
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
      const existingBinding = rowsOf(bindingResult)[0] || null;
      const lifecycleResult = await client.query(
        `SELECT EXISTS(
           SELECT 1 FROM nv_alpha_cleanup_manifest
            WHERE tester_id=$1 AND identity_key=$2
              AND resource_type='provider-session'
         ) AS lifecycle_started`,
        [testerId, identityKey]
      );
      if (rowsOf(lifecycleResult)[0] && onlyRow(lifecycleResult).lifecycle_started) {
        throw new AlphaPrivacyStoreError(
          'Provider cleanup lifecycle has started',
          'ALPHA_PROVIDER_LIFECYCLE_STARTED'
        );
      }
      if (rowsOf(bindingResult).length > 1 || (
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
          [testerId, identityKey, provider, authority, store.currentTime()]
        );
      }

      const existingOwnership = rowsOf(ownershipResult).find(owner => (
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
          [sessionKeyHash, testerId, identityKey, provider, store.currentTime()]
        );
      }

      const next = (store.scrubIdentityBoundSessionState(current, identityKey) || {}) as HostedSession;
      next.accounts = [...currentAccounts, structuredClone(account)];
      next.active = next.accounts.length - 1;
      const encoded = store.encodeHostedSession(next);
      const identityKeys = store.hostedSessionIdentityKeys(next);
      if (!row) {
        const inserted = await client.query(
          `INSERT INTO nv_sessions(sid,data,identity_keys,session_key_hash,revision,updated)
           VALUES($1,$2,$3::text[],$4,0,$5)
           RETURNING revision`,
          [sessionId, encoded, identityKeys, sessionKeyHash, store.currentTime()]
        );
        if (!rowsOf(inserted)[0]) {
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
        [sessionId, encoded, identityKeys, store.currentTime(), revision]
      );
      if (!rowsOf(updated)[0]) {
        throw new AlphaPrivacyStoreError(
          'Hosted provider session revision conflicted',
          'ALPHA_SESSION_REVISION_CONFLICT'
        );
      }
      return Object.freeze({
        session: structuredClone(next),
        revision: Number(onlyRow(updated).revision)
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

export async function revokeOwnedProviderSessions(store: AlphaPrivacyStoreContext, input: unknown) {
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
  const sidByHash = new Map<unknown, string>();
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

  return store.withLifecycleTransaction(
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
      if (rowsOf(ownershipResult).some(row => row.tester_id !== testerId)) {
        throw new AlphaPrivacyStoreError(
          'Provider session ownership could not be verified',
          'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
        );
      }
      for (const hash of hashes) {
        if (!rowsOf(ownershipResult).some(row => (
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
      const removed: unknown[] = [];
      for (const row of rowsOf(sessionsResult)) {
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
        if (!rowsOf(deleted)[0]) {
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
        [testerId, hashes, store.currentTime()]
      );
      return Object.freeze({ revokedSessionIds: Object.freeze(removed.sort()) });
    }
  );
}
