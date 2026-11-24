/*
 * The database's lifecycle: the server's one pool, whether the store behind it
 * is ready, and the upkeep a ready store is given.
 *
 * Readiness is one promise, shared by every caller while it is pending, so a
 * burst of requests on a cold start migrates the store once. A failure clears
 * it and holds off for fifteen seconds, so a database that is down is not
 * dialled again by every request. Each invalidation advances a generation, and
 * an initialization that finishes after one is not believed: the store may have
 * gone away while it ran, and a late success must not undo the invalidation.
 *
 * What the readiness probe publishes is kept here beside it: waking while an
 * initialization runs, connected once one succeeds, unavailable after a
 * failure, and a mismatch when the store's migrations are not this release's.
 * In verify mode, the hosted alpha's, the store is checked and never migrated;
 * migrating is the release's job, not the web process's.
 */
import { databaseReadiness } from './hosted-readiness.ts';
import type { Migration, MigrationOptions, MigrationVerification } from './migrations.ts';
import type { PoolClient, TransactionalPool } from './queryable.ts';

export interface LifecyclePool extends TransactionalPool {
  end(): Promise<void>;
}

export interface DatabaseLifecycleDeps<P extends LifecyclePool> {
  readonly databaseUrl: string;
  readonly migrationMode: 'apply' | 'verify';
  readonly migrationsDirectory: string;
  readonly productName: string;
  readonly eventRetentionDays: number;
  readonly sessionRetentionDays: number;
  /* Opens the pool (database-pool.ts); its callback reports a connection lost while idle. */
  readonly openPool: (connectionString: string, onIdleError: (error: unknown) => void) => P;
  readonly migrations: {
    readonly load: (directory: string) => readonly Migration[];
    readonly run: (client: PoolClient, options: MigrationOptions) => Promise<{ readonly applied: readonly string[]; readonly total: number }>;
    readonly verify: (client: PoolClient, options: MigrationOptions) => Promise<MigrationVerification>;
  };
  /* Called after each initialization that succeeds; what it starts, it starts once. */
  readonly onReady?: () => void;
}

export type DatabaseReadiness = ReturnType<typeof databaseReadiness>;
export type ReadinessLoss = 'unavailable' | 'waking' | 'migration-mismatch';

export interface DatabaseLifecycle<P extends LifecyclePool> {
  /* The pool, opened on first use. */
  pool(): P;
  /* Whether the store is ready, initializing it when it is not and the backoff has passed. */
  ready(): Promise<boolean>;
  /* The store has been lost: forget that it was ready, and say why. */
  invalidate(state?: ReadinessLoss): void;
  /* What the readiness probe publishes. */
  readiness(): DatabaseReadiness;
  /* The latest migration this release carries, or, once verified, the one it expects. */
  migration(): string;
  /* Closes the pool, if one was ever opened. */
  close(): Promise<void>;
}

const RETRY_AFTER_MS = 15000;
const RETENTION_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SQLSTATE = /^[A-Z0-9]{5}$/;

export function createDatabaseLifecycle<P extends LifecyclePool>(deps: DatabaseLifecycleDeps<P>): DatabaseLifecycle<P> {
  const { databaseUrl, migrationMode, migrationsDirectory, productName } = deps;
  let opened: P | null = null;
  let pending: Promise<boolean> | null = null;
  let retryAfter = 0;
  let generation = 0;
  let maintenanceStarted = false;
  let readiness = databaseReadiness({
    required: !!databaseUrl,
    connected: !databaseUrl,
    waking: !!databaseUrl,
    migrationMatch: true,
    quotaWarning: false
  });
  let migration = deps.migrations.load(migrationsDirectory).at(-1)?.id || '';

  function pool(): P {
    if (!opened) {
      opened = deps.openPool(databaseUrl, error => {
        invalidate('unavailable');
        const code = error && (error as { readonly code?: unknown }).code;
        console.error(JSON.stringify({ t: new Date().toISOString(), event: 'database-idle-disconnect',
          code: SQLSTATE.test(String(code || '')) ? code : 'DB_CONNECTION_FAILED' }));
      });
    }
    return opened;
  }

  async function initialize(): Promise<boolean> {
    const client = await pool().connect();
    try {
      if (migrationMode === 'verify') {
        const verification = await deps.migrations.verify(client, { directory: migrationsDirectory });
        migration = verification.expectedLatest;
        readiness = databaseReadiness({
          required: true,
          connected: true,
          waking: false,
          migrationMatch: verification.ok,
          quotaWarning: false
        });
        console.log(JSON.stringify({
          t: new Date().toISOString(),
          db: `${productName} migration verification complete`,
          migration: verification.expectedLatest,
          missingCount: verification.missing.length,
          changedCount: verification.changed.length,
          unknownCount: verification.unknown.length
        }));
        return verification.ok;
      }
      const result = await deps.migrations.run(client, {
        directory: migrationsDirectory,
        logger: { info(message) { console.log(JSON.stringify({ t: new Date().toISOString(), db: message })); } }
      });
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        db: `${productName} intelligence store ready`,
        migrationsApplied: result.applied.length,
        migrationsTotal: result.total
      }));
      readiness = databaseReadiness({
        required: true,
        connected: true,
        waking: false,
        migrationMatch: true,
        quotaWarning: false
      });
      return true;
    } finally { client.release(); }
  }

  /* Events and sessions past their retention, and idempotency keys past their day. */
  async function cleanup(): Promise<void> {
    if (!opened) return;
    await Promise.all([
      pool().query(`DELETE FROM nv_intelligence_events WHERE created_at < now() - ($1::int * interval '1 day')`, [deps.eventRetentionDays]),
      pool().query(`DELETE FROM nv_sessions WHERE updated < now() - ($1::int * interval '1 day')`, [deps.sessionRetentionDays]),
      pool().query(`DELETE FROM nv_governance_idempotency WHERE created_at < now() - interval '24 hours'`)
    ]).catch((error: Error) => console.error('Database retention cleanup failed:', error.message));
  }

  function startMaintenance(): void {
    if (maintenanceStarted) return;
    maintenanceStarted = true;
    cleanup().catch(() => {});
    const timer = setInterval(() => cleanup().catch(() => {}), RETENTION_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function invalidate(state: ReadinessLoss = 'unavailable'): void {
    generation += 1;
    pending = null;
    retryAfter = Date.now() + RETRY_AFTER_MS;
    readiness = databaseReadiness({
      required: true,
      connected: false,
      waking: state === 'waking',
      migrationMatch: state !== 'migration-mismatch',
      quotaWarning: false
    });
  }

  function ready(): Promise<boolean> {
    if (!databaseUrl) return Promise.resolve(false);
    if (pending) return pending;
    if (Date.now() < retryAfter) return Promise.resolve(false);
    readiness = databaseReadiness({
      required: true,
      connected: false,
      waking: true,
      migrationMatch: true,
      quotaWarning: false
    });
    const started = generation;
    pending = initialize()
      .then(ok => {
        if (started !== generation) {
          invalidate('unavailable');
          return false;
        }
        if (ok) {
          startMaintenance();
          if (deps.onReady) deps.onReady();
        }
        return ok;
      })
      .catch((error: Error) => {
        console.error('DB unavailable; retrying after a short backoff:', error.message);
        invalidate('unavailable');
        return false;
      });
    return pending;
  }

  return {
    pool,
    ready,
    invalidate,
    readiness: () => readiness,
    migration: () => migration,
    async close() { if (opened) await opened.end(); }
  };
}
