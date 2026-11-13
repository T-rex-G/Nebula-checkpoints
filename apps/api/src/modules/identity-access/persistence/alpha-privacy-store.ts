import { randomUUID } from 'node:crypto';
import type { PoolClient, Row, TransactionalPool } from '../../../platform/persistence/queryable.ts';
import {
  requirePlainObject, toDate, rowsOf, AlphaPrivacyStoreError, requireHash, TESTER_ID_RX, type SessionCodec,
  type LifecycleOptions, type LifecycleContext, type ReadinessScope, type CleanupReadiness, type CleanupBlock,
  type HostedSession, type SessionLockOptions
} from './alpha-privacy-records.ts';
import {
  bindProviderIdentity, createCleanupTask, claimProviderWebhookOwnership, prepareProviderDisconnect,
  completeProviderWebhookCleanup, inspectProviderWebhookCleanup, completeCleanupTask
} from './alpha-provider-cleanup.ts';
import {
  cleanupReadiness, replaceCleanupBlocks, createDeletionRequest, markProviderIdentityDisconnected,
  finalizeProviderDisconnect
} from './alpha-disconnect.ts';
import {
  claimProviderSessionOwnership, lockOwnedProviderSession, readHostedProviderSession, mutateHostedProviderSession,
  connectHostedProviderAccount, revokeOwnedProviderSessions
} from './alpha-hosted-sessions.ts';
import { scrubCompletedTesterSessions, purgeTester, recordFeedback, cohortClose, runRetention } from './alpha-tester-lifecycle.ts';
export { AlphaPrivacyStoreError } from './alpha-privacy-records.ts';
export type { PurgeReport, SessionCodec } from './alpha-privacy-records.ts';

export class AlphaPrivacyStore {
  readonly pool: TransactionalPool;
  readonly now: () => unknown;
  readonly randomUUID: () => unknown;
  readonly sessionCodec: SessionCodec | null;

  constructor(options: unknown) {
    const input = requirePlainObject(options, 'AlphaPrivacyStore options');
    const pool = input.pool as Partial<TransactionalPool> | null | undefined;
    if (
      !pool
      || typeof pool.query !== 'function'
      || typeof pool.connect !== 'function'
    ) {
      throw new TypeError('AlphaPrivacyStore requires a pg-compatible pool');
    }
    if (input.now !== undefined && typeof input.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (input.randomUUID !== undefined && typeof input.randomUUID !== 'function') {
      throw new TypeError('randomUUID must be a function');
    }
    const codec = input.sessionCodec as Partial<SessionCodec> | null | undefined;
    if (input.sessionCodec !== undefined && (
      !codec
      || typeof codec !== 'object'
      || typeof codec.encode !== 'function'
      || typeof codec.decode !== 'function'
      || typeof codec.identityKey !== 'function'
    )) {
      throw new TypeError('sessionCodec must provide encode, decode and identityKey functions');
    }
    this.pool = pool as TransactionalPool;
    this.now = (input.now as (() => unknown) | undefined) || (() => new Date());
    this.randomUUID = (input.randomUUID as (() => unknown) | undefined) || randomUUID;
    this.sessionCodec = (codec as SessionCodec | undefined) || null;
  }

  currentTime(): Date {
    return toDate(this.now(), 'now');
  }

  async withGlobalTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
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

  async withLifecycleTransaction<T>(testerId: string, options: LifecycleOptions, callback: (client: PoolClient, context: LifecycleContext) => Promise<T>): Promise<T> {
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
      const tester = rowsOf(testerResult)[0];
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
      const deletion = rowsOf(deletionResult)[0] || null;
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

  bindProviderIdentity(input: unknown): Promise<Readonly<{ created: boolean; connectedAt: string }>> {
    return bindProviderIdentity(this, input);
  }

  nextUuid(label: string): string {
    const value = this.randomUUID();
    if (typeof value !== 'string' || !TESTER_ID_RX.test(value)) {
      throw new TypeError(`randomUUID must return a UUID for ${label}`);
    }
    return value.toLowerCase();
  }

  createCleanupTask(input: unknown) {
    return createCleanupTask(this, input);
  }

  claimProviderWebhookOwnership(input: unknown) {
    return claimProviderWebhookOwnership(this, input);
  }

  prepareProviderDisconnect(input: unknown) {
    return prepareProviderDisconnect(this, input);
  }

  completeProviderWebhookCleanup(input: unknown) {
    return completeProviderWebhookCleanup(this, input);
  }

  inspectProviderWebhookCleanup(input: unknown) {
    return inspectProviderWebhookCleanup(this, input);
  }

  completeCleanupTask(input: unknown) {
    return completeCleanupTask(this, input);
  }

  cleanupReadiness(client: PoolClient, testerId: string, scope: ReadinessScope | null = null): Promise<CleanupReadiness> {
    return cleanupReadiness(this, client, testerId, scope);
  }

  replaceCleanupBlocks(client: PoolClient, requestId: unknown, cleanupBlocks: readonly CleanupBlock[]): Promise<void> {
    return replaceCleanupBlocks(this, client, requestId, cleanupBlocks);
  }

  createDeletionRequest(input: unknown) {
    return createDeletionRequest(this, input);
  }

  markProviderIdentityDisconnected(input: unknown) {
    return markProviderIdentityDisconnected(this, input);
  }

  claimProviderSessionOwnership(input: unknown) {
    return claimProviderSessionOwnership(this, input);
  }

  requireSessionCodec(): SessionCodec {
    if (!this.sessionCodec) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session codec is unavailable',
        'ALPHA_SESSION_CODEC_UNAVAILABLE'
      );
    }
    return this.sessionCodec;
  }

  decodeHostedSession(value: unknown): HostedSession {
    const decoded = this.requireSessionCodec().decode(value);
    if (
      !decoded
      || typeof decoded !== 'object'
      || Array.isArray(decoded)
      || !Array.isArray((decoded as Partial<HostedSession>).accounts)
    ) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session state is invalid',
        'ALPHA_PROVIDER_SESSION_STATE_INVALID'
      );
    }
    return structuredClone(decoded as HostedSession);
  }

  encodeHostedSession(value: unknown): string {
    const encoded = this.requireSessionCodec().encode(value);
    if (typeof encoded !== 'string' || !encoded) {
      throw new AlphaPrivacyStoreError(
        'Hosted alpha session state could not be encoded',
        'ALPHA_PROVIDER_SESSION_STATE_INVALID'
      );
    }
    return encoded;
  }

  hostedSessionIdentityKeys(session: HostedSession): string[] {
    const codec = this.requireSessionCodec();
    const keys: string[] = [];
    for (const account of session.accounts) {
      const key = requireHash(codec.identityKey(account), 'hosted session account identityKey');
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  assertHostedSessionRowKey(row: Row | null | undefined, sessionKeyHash: unknown): void {
    if (!row || row.session_key_hash !== sessionKeyHash) {
      throw new AlphaPrivacyStoreError(
        'Hosted provider session ownership could not be verified',
        'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'
      );
    }
  }

  lockOwnedProviderSession(client: PoolClient, testerId: string, sessionKeyHash: unknown, options: SessionLockOptions = {}): Promise<Row> {
    return lockOwnedProviderSession(this, client, testerId, sessionKeyHash, options);
  }

  readHostedProviderSession(input: unknown) {
    return readHostedProviderSession(this, input);
  }

  mutateHostedProviderSession(input: unknown) {
    return mutateHostedProviderSession(this, input);
  }

  connectHostedProviderAccount(input: unknown) {
    return connectHostedProviderAccount(this, input);
  }

  revokeOwnedProviderSessions(input: unknown) {
    return revokeOwnedProviderSessions(this, input);
  }

  scrubIdentityBoundSessionState(value: unknown, identityKey: string): unknown {
    if (Array.isArray(value)) {
      return value
        .map(item => this.scrubIdentityBoundSessionState(item, identityKey))
        .filter(item => item !== undefined);
    }
    if (!value || typeof value !== 'object') return value;
    if ((value as Readonly<Record<string, unknown>>).identityKey === identityKey) return undefined;
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = this.scrubIdentityBoundSessionState(item, identityKey);
      if (scrubbed !== undefined) clean[key] = scrubbed;
    }
    return clean;
  }

  finalizeProviderDisconnect(input: unknown) {
    return finalizeProviderDisconnect(this, input);
  }

  scrubCompletedTesterSessions(client: PoolClient, testerId: string): Promise<number | null | undefined> {
    return scrubCompletedTesterSessions(this, client, testerId);
  }

  purgeTester(input: unknown) {
    return purgeTester(this, input);
  }

  recordFeedback(input: unknown) {
    return recordFeedback(this, input);
  }

  cohortClose(input: unknown) {
    return cohortClose(this, input);
  }

  runRetention() {
    return runRetention(this);
  }

}

/*
 * What the store's operations use of it: these members, reached through the
 * store itself, so each call still goes where the store's own would.
 */
export type AlphaPrivacyStoreContext = Pick<AlphaPrivacyStore,
  'assertHostedSessionRowKey' | 'cleanupReadiness' | 'currentTime' | 'decodeHostedSession' | 'encodeHostedSession'
  | 'hostedSessionIdentityKeys' | 'lockOwnedProviderSession' | 'nextUuid' | 'replaceCleanupBlocks'
  | 'requireSessionCodec' | 'scrubCompletedTesterSessions' | 'scrubIdentityBoundSessionState'
  | 'withGlobalTransaction' | 'withLifecycleTransaction'
>;
