import { createHash } from 'node:crypto';
import { errorCode, type Queryable, type QueryOutcome } from '../persistence/queryable.ts';

/*
 * The durable half of the single-use guard contract that
 * src/security-foundation.js defines. It answers `consumeOnce` the same way
 * the in-memory adapter does -- true if this caller claimed the grant, false
 * if it was already spent -- and differs only in where the answer is kept, so
 * a second process gets the same answer as the first.
 *
 * One statement decides. Not a SELECT and then an INSERT: those can be
 * interleaved by anything that has to cross a connection, and two requests
 * carrying one grant would both read "unspent" before either wrote. An insert
 * whose conflict clause is itself conditional does the reading, the deciding
 * and the writing inside one round trip, and PostgreSQL serialises conflicting
 * inserts on the primary key, so exactly one of them can come back with a row.
 *
 * The comparison uses the database's clock rather than the caller's. That is
 * the whole point of moving off a per-process Map: two instances with drifting
 * clocks must not disagree about whether a grant is still alive, and the only
 * clock they share is the one attached to the table.
 */

export const GUARD_KINDS: readonly string[] = Object.freeze(['step-up', 'github-app-state', 'restore-authorization']);
export const DEFAULT_SWEEP_BATCH = 500;
export const MAX_SWEEP_BATCH = 5000;

/* Field order is the order the properties were always set in: name, code, status. */
export class SingleUseStoreError extends Error {
  override readonly name = 'SingleUseStoreError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'SINGLE_USE_STORE_UNAVAILABLE', status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/*
 * Domain separation is in the digest, not only in the column: the same random
 * value arriving under two kinds must not produce one key, or a guard consumed
 * as one kind would silently consume the other.
 */
export function guardKeyFor(kind: string, key: string): string {
  return createHash('sha256').update(`nv/single-use/${kind}\u001f${key}`, 'utf8').digest('hex');
}

function requireKind(kind: unknown): string {
  const value = String(kind || '');
  if (!GUARD_KINDS.includes(value)) {
    throw new TypeError(`Unknown single-use guard kind: ${String(kind)}`);
  }
  return value;
}

/*
 * Expiries cross as epoch milliseconds because that is what the callers hold,
 * and land as timestamptz because that is what the clock comparison needs.
 */
function requireExpiry(expiresAt: unknown): number {
  const value = Number(expiresAt);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError('A single-use guard requires a positive expiry in epoch milliseconds');
  }
  return value;
}

/*
 * The in-process adapter, for the profile allowed to run without a database
 * and as the default the security foundation falls back to. Its decision is
 * synchronous, which is what makes it atomic: nothing can run between the read
 * and the write.
 *
 * It keeps a capacity ceiling because a process-local guard cannot grow
 * without bound. Expired entries may be discarded, but a live grant must
 * never be forgotten: at capacity a new claim is refused until space expires.
 */
/* One claim: the guard's key, when it lapses and the caller's now, both in epoch milliseconds. */
export interface MemoryClaim {
  readonly key: unknown;
  readonly expiresAt: number;
  readonly now: number;
}

export function memorySingleUseStore(map: Map<unknown, unknown>, { maxEntries = 5000 }: { readonly maxEntries?: unknown } = {}): { consumeOnce(claim: MemoryClaim): boolean } {
  if (!(map instanceof Map)) throw new TypeError('An in-process single-use guard requires a Map');
  const ceiling = Math.max(100, Number(maxEntries) || 5000);
  return {
    consumeOnce({ key, expiresAt, now: currentTime }: MemoryClaim): boolean {
      const consumedUntil = Number(map.get(key) || 0);
      if (consumedUntil >= currentTime) return false;
      for (const [id, until] of map) {
        if (Number(until) < currentTime) map.delete(id);
      }
      if (map.size >= ceiling) return false;
      map.delete(key);
      map.set(key, expiresAt);
      return true;
    }
  };
}

export interface SingleUseStoreOptions {
  readonly pool?: Queryable;
  readonly sweepBatch?: unknown;
}

export class SingleUseStore {
  readonly pool: Queryable;
  readonly sweepBatch: number;

  constructor(options: SingleUseStoreOptions = {}) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('SingleUseStore requires a pg-compatible pool');
    }
    this.pool = pool;
    this.sweepBatch = Math.min(
      MAX_SWEEP_BATCH,
      Math.max(1, Number(options.sweepBatch) || DEFAULT_SWEEP_BATCH)
    );
  }

  /*
   * Returns true when this caller is the one that claimed the grant.
   *
   * A row that is still live blocks the claim: the conflict clause's WHERE
   * fails, nothing is written and nothing is returned. A row whose expiry has
   * already passed does not block it -- the key is free again and the claim
   * takes it over -- which matches the in-memory adapter, where an expired
   * record is replaced rather than treated as a guard.
   *
   * `expires_at >= now()` is what blocks, so a record expiring exactly now
   * still refuses. The in-memory adapter refuses at equality too; a guard and
   * its replacement disagreeing by one millisecond at the boundary is the kind
   * of difference that only shows up as an unreproducible replay.
   */
  async consumeOnce({ kind, key, expiresAt }: { readonly kind?: string; readonly key?: string | null; readonly expiresAt?: number } = {}): Promise<boolean> {
    const guardKind = requireKind(kind);
    const guardKey = guardKeyFor(guardKind, String(key == null ? '' : key));
    const expiry = requireExpiry(expiresAt);

    let result: QueryOutcome;
    try {
      result = await this.pool.query(
        `INSERT INTO nv_single_use_guards (guard_kind, guard_key, expires_at)
         VALUES ($1, $2, to_timestamp($3::double precision / 1000.0))
         ON CONFLICT (guard_kind, guard_key) DO UPDATE
            SET expires_at = EXCLUDED.expires_at, consumed_at = now()
          WHERE nv_single_use_guards.expires_at < now()
         RETURNING 1 AS claimed`,
        [guardKind, guardKey, expiry]
      );
    } catch (error) {
      /*
       * A guard that cannot answer has not said the grant is unspent. The
       * caller turns this into a refusal; it must never be read as a claim,
       * and it must never fall back to a local Map, because a local Map would
       * answer "unspent" on every instance that has not seen the grant.
       */
      throw new SingleUseStoreError(
        `Single-use guard storage is unavailable: ${errorCode(error) || 'query failed'}`
      );
    }
    const rows = result && result.rows;
    return Array.isArray(rows) && rows.length === 1;
  }

  /*
   * Expired rows only, a bounded slice at a time, and the same clock the claim
   * used. Nothing else is ever deleted: a table that discards a live guard
   * under pressure is a guard that fails open exactly when it matters, which
   * is what the ten-thousand-entry ceiling on the Map it replaces did.
   */
  /* Returns how many expired rows were removed. */
  async sweepExpired({ limit }: { readonly limit?: number } = {}): Promise<number> {
    const batch = Math.min(
      MAX_SWEEP_BATCH,
      Math.max(1, Number(limit) || this.sweepBatch)
    );
    let result: QueryOutcome;
    try {
      result = await this.pool.query(
        `DELETE FROM nv_single_use_guards
           WHERE ctid IN (
             SELECT ctid FROM nv_single_use_guards
              WHERE expires_at < now()
              ORDER BY expires_at
              LIMIT $1
           )`,
        [batch]
      );
    } catch (error) {
      throw new SingleUseStoreError(
        `Single-use guard sweep failed: ${errorCode(error) || 'query failed'}`
      );
    }
    return Number(result && result.rowCount) || 0;
  }
}

