'use strict';

const crypto = require('crypto');

/*
 * The shared half of the rate limit. The counters it replaces lived in
 * module-scope Maps, so a limit of N was N per process: two instances served
 * 2N, and the ceiling loosened exactly as capacity was added.
 *
 * One statement decides, as it does for the single-use guards. An insert whose
 * conflict clause is conditional opens a window or increments inside one, and
 * PostgreSQL serialises conflicting inserts on the primary key, so two
 * simultaneous requests cannot both read a count of N and both write N+1.
 *
 * The window rule is preserved rather than improved. Each limiter this
 * replaces resets by comparing now against the moment its window opened, and
 * the two do not agree on the boundary -- the API window reopens when more
 * than sixty seconds have passed, the webhook window when sixty seconds have
 * passed. Those are different at exactly one millisecond a minute, which is
 * the kind of difference that turns into an unreproducible 429, so each keeps
 * its own comparison instead of both being quietly rounded to the same one.
 */

const NAMESPACES = Object.freeze(['api', 'webhook']);
const DEFAULT_SWEEP_BATCH = 500;
const MAX_SWEEP_BATCH = 5000;

class RateLimitStoreError extends Error {
  constructor(message, code = 'RATE_LIMIT_STORE_UNAVAILABLE', status = 503) {
    super(message);
    this.name = 'RateLimitStoreError';
    this.code = code;
    this.status = status;
  }
}

function bucketKeyFor(namespace, key) {
  return crypto.createHash('sha256').update(`nv/rate-limit/${namespace}\u001f${key}`, 'utf8').digest('hex');
}

function requireNamespace(namespace) {
  const value = String(namespace || '');
  if (!NAMESPACES.includes(value)) throw new TypeError(`Unknown rate limit namespace: ${String(namespace)}`);
  return value;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

class RateLimitStore {
  constructor(options = {}) {
    const pool = options && options.pool;
    if (!pool || typeof pool.query !== 'function') throw new TypeError('RateLimitStore requires a pg-compatible pool');
    this.pool = pool;
    this.sweepBatch = Math.min(MAX_SWEEP_BATCH, Math.max(1, Number(options.sweepBatch) || DEFAULT_SWEEP_BATCH));
  }

  /*
   * Counts one request and says whether it is within the ceiling.
   *
   * `inclusiveReset` picks which comparison opens a new window, so each
   * limiter keeps the boundary it already had: false means a window reopens
   * only once more than windowMs has elapsed, true means once windowMs has.
   *
   * The count is returned as well as the verdict, because a limiter that can
   * only say yes or no cannot tell an operator how close a caller was.
   */
  /**
   * Every field is optional to the checker and required at run time: the
   * validators below reject a missing one with a message, which is a better
   * answer than a destructuring crash.
   *
   * @param {{ namespace?: string, key?: unknown, windowMs?: number, limit?: number,
   *   inclusiveReset?: boolean }} [request]
   * @returns {Promise<{ allowed: boolean, count: number, limit: number }>}
   */
  async count({ namespace, key, windowMs, limit, inclusiveReset = false } = {}) {
    const bucketNamespace = requireNamespace(namespace);
    const bucketKey = bucketKeyFor(bucketNamespace, String(key == null ? '' : key));
    const window = requirePositiveInteger(windowMs, 'Rate limit window');
    const ceiling = requirePositiveInteger(limit, 'Rate limit ceiling');

    let result;
    try {
      result = await this.pool.query(
        `INSERT INTO nv_rate_limit_buckets (bucket_namespace, bucket_key, window_started_at, request_count)
         VALUES ($1, $2, now(), 1)
         ON CONFLICT (bucket_namespace, bucket_key) DO UPDATE
            SET window_started_at = CASE
                  WHEN ${inclusiveReset
                    ? 'now() - nv_rate_limit_buckets.window_started_at >= ($3::double precision / 1000.0) * interval \'1 second\''
                    : 'now() - nv_rate_limit_buckets.window_started_at > ($3::double precision / 1000.0) * interval \'1 second\''}
                  THEN now() ELSE nv_rate_limit_buckets.window_started_at END,
                request_count = CASE
                  WHEN ${inclusiveReset
                    ? 'now() - nv_rate_limit_buckets.window_started_at >= ($3::double precision / 1000.0) * interval \'1 second\''
                    : 'now() - nv_rate_limit_buckets.window_started_at > ($3::double precision / 1000.0) * interval \'1 second\''}
                  THEN 1 ELSE nv_rate_limit_buckets.request_count + 1 END
         RETURNING request_count`,
        [bucketNamespace, bucketKey, window]
      );
    } catch (error) {
      /*
       * A counter that cannot answer has not said the caller is within their
       * limit. The caller turns this into a refusal; it must never be read as
       * permission, and it must never fall back to a local count, because a
       * local count answers "well within" on every instance that has not seen
       * this caller before.
       */
      throw new RateLimitStoreError(
        `Rate limit storage is unavailable: ${(error && error.code) || 'query failed'}`
      );
    }

    const count = Number(result && result.rows && result.rows[0] && result.rows[0].request_count) || 0;
    return { allowed: count <= ceiling, count, limit: ceiling };
  }

  /* Closed windows only, a bounded slice at a time. A live window is never
     discarded to make room: that is a limit failing open under load. */
  /**
   * @param {{ windowMs?: number, limit?: number }} [request]
   * @returns {Promise<number>}
   */
  async sweepClosed({ windowMs, limit } = {}) {
    const window = requirePositiveInteger(windowMs, 'Rate limit window');
    const batch = Math.min(MAX_SWEEP_BATCH, Math.max(1, Number(limit) || this.sweepBatch));
    let result;
    try {
      result = await this.pool.query(
        `DELETE FROM nv_rate_limit_buckets
           WHERE ctid IN (
             SELECT ctid FROM nv_rate_limit_buckets
              WHERE now() - window_started_at > ($1::double precision / 1000.0) * interval '1 second'
              ORDER BY window_started_at
              LIMIT $2
           )`,
        [window, batch]
      );
    } catch (error) {
      throw new RateLimitStoreError(`Rate limit sweep failed: ${(error && error.code) || 'query failed'}`);
    }
    return Number(result && result.rowCount) || 0;
  }
}

module.exports = Object.freeze({
  NAMESPACES,
  DEFAULT_SWEEP_BATCH,
  MAX_SWEEP_BATCH,
  RateLimitStore,
  RateLimitStoreError,
  bucketKeyFor
});
