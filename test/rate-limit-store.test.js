'use strict';

/*
 * A limit of N must mean N across every process serving the application, not
 * N per process. The counters this replaces were module-scope Maps, so adding
 * an instance loosened the ceiling -- the opposite of what a limit is for.
 *
 * The fake database implements the statement's real semantics rather than
 * recording that it was sent, because a counter asserted against a recording
 * mock is a counter asserted against itself.
 */

const assert = require('assert');
const { RateLimitStore, RateLimitStoreError, bucketKeyFor, MAX_SWEEP_BATCH } = require('../src/rate-limit-store');

class FakeDatabase {
  constructor() {
    this.rows = new Map();
    this.clock = 1_800_000_000_000;
    this.failure = null;
    this.statements = [];
  }
  async query(text, params) {
    this.statements.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    if (this.failure) throw this.failure;

    if (/^INSERT INTO nv_rate_limit_buckets/.test(text)) {
      const [namespace, key, windowMs] = params;
      const inclusive = />= \(\$3/.test(String(text));
      const id = `${namespace}\u0000${key}`;
      const row = this.rows.get(id);
      const elapsed = row ? this.clock - row.startedAt : null;
      const reopen = !row || (inclusive ? elapsed >= Number(windowMs) : elapsed > Number(windowMs));
      const next = reopen
        ? { startedAt: this.clock, count: 1 }
        : { startedAt: row.startedAt, count: row.count + 1 };
      this.rows.set(id, next);
      return { rows: [{ request_count: next.count }], rowCount: 1 };
    }
    if (/^DELETE FROM nv_rate_limit_buckets/.test(text)) {
      const [windowMs, batch] = params;
      const closed = [...this.rows.entries()]
        .filter(([, row]) => this.clock - row.startedAt > Number(windowMs))
        .sort((a, b) => a[1].startedAt - b[1].startedAt)
        .slice(0, Number(batch));
      for (const [id] of closed) this.rows.delete(id);
      return { rows: [], rowCount: closed.length };
    }
    throw new Error(`unexpected statement: ${text}`);
  }
}

const API = { namespace: 'api', windowMs: 60_000, limit: 300, inclusiveReset: false };
const WEBHOOK = { namespace: 'webhook', windowMs: 60_000, limit: 120, inclusiveReset: true };

(async () => {
  /* N is N across two stores sharing a database, not N each. */
  {
    const db = new FakeDatabase();
    const a = new RateLimitStore({ pool: db });
    const b = new RateLimitStore({ pool: db });
    let allowed = 0;
    for (let i = 0; i < 400; i += 1) {
      const store = i % 2 === 0 ? a : b;
      const verdict = await store.count({ ...API, key: 'shared-caller' });
      if (verdict.allowed) allowed += 1;
    }
    assert.strictEqual(allowed, 300, 'two instances share one ceiling rather than getting one each');
  }

  /* One statement per request: a read and a write could be interleaved. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await store.count({ ...API, key: 'counted' });
    assert.strictEqual(db.statements.length, 1, 'counting must be one statement');
    assert.match(db.statements[0].text, /^INSERT INTO nv_rate_limit_buckets .* ON CONFLICT .* DO UPDATE/);
  }

  /*
   * The two limiters disagree about the boundary by one millisecond, and each
   * keeps its own. The API window reopens once MORE than sixty seconds have
   * passed; the webhook window once sixty seconds have.
   */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await store.count({ ...API, key: 'boundary' });
    db.clock += 60_000;
    assert.strictEqual(
      (await store.count({ ...API, key: 'boundary' })).count, 2,
      'the API window has not reopened at exactly sixty seconds'
    );
    db.clock += 1;
    assert.strictEqual(
      (await store.count({ ...API, key: 'boundary' })).count, 1,
      'and reopens one millisecond later'
    );

    await store.count({ ...WEBHOOK, key: 'boundary' });
    db.clock += 60_000;
    assert.strictEqual(
      (await store.count({ ...WEBHOOK, key: 'boundary' })).count, 1,
      'the webhook window reopens at exactly sixty seconds, which the API window does not'
    );
  }

  /* Namespaces never share a row, so one budget cannot spend another's. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await store.count({ ...API, key: 'same-value' });
    const webhook = await store.count({ ...WEBHOOK, key: 'same-value' });
    assert.strictEqual(webhook.count, 1, 'one value under two namespaces is two counters');
    assert.notStrictEqual(bucketKeyFor('api', 'x'), bucketKeyFor('webhook', 'x'));
  }

  /* The identity never reaches the table; only a digest of it does. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await store.count({ ...API, key: 'session-identifier-worth-hiding' });
    assert.strictEqual(
      JSON.stringify(db.statements).includes('session-identifier-worth-hiding'), false,
      'a caller identity must not be written to the counter table'
    );
    assert.match(db.statements[0].params[1], /^[0-9a-f]{64}$/);
  }

  /* A counter that cannot answer refuses rather than permitting. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    db.failure = Object.assign(new Error('terminating connection'), { code: '57P01' });
    await assert.rejects(
      store.count({ ...API, key: 'unreachable' }),
      error => error instanceof RateLimitStoreError
        && error.status === 503
        && !String(error.message).includes('unreachable'),
      'an unavailable counter refuses with a typed error that does not leak the caller'
    );
  }

  /* A live window is never discarded to make room; the sweep takes closed ones. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    for (let i = 0; i < 40; i += 1) await store.count({ ...API, key: `old-${i}` });
    db.clock += 61_000;
    await store.count({ ...API, key: 'live' });

    assert.strictEqual(await store.sweepClosed({ windowMs: 60_000, limit: 25 }), 25, 'the sweep is bounded');
    assert.strictEqual(await store.sweepClosed({ windowMs: 60_000, limit: 25 }), 15);
    assert.strictEqual(await store.sweepClosed({ windowMs: 60_000, limit: 25 }), 0);
    assert.strictEqual(db.rows.size, 1, 'the open window survives every pass');
  }

  /* No capacity ceiling: a caller near their limit is never forgotten. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    for (let i = 0; i < 20_000; i += 1) await store.count({ ...API, key: `caller-${i}` });
    assert.strictEqual(db.rows.size, 20_000, 'no counter may be evicted to make room for another');
    assert.strictEqual(
      (await store.count({ ...API, key: 'caller-0' })).count, 2,
      'the first caller still has their count after four times the Map ceiling'
    );
  }

  /* Misuse is refused rather than counted. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await assert.rejects(store.count({ ...API, namespace: 'other', key: 'x' }), TypeError);
    for (const bad of [0, -1, 1.5, NaN, 'soon', undefined]) {
      await assert.rejects(store.count({ ...API, key: 'x', windowMs: bad }), TypeError);
      await assert.rejects(store.count({ ...API, key: 'x', limit: bad }), TypeError);
    }
    assert.strictEqual(db.rows.size, 0, 'a refused call counts nothing');
    assert.throws(() => new RateLimitStore({}), TypeError);
  }

  /* The sweep batch cannot be talked into an unbounded delete. */
  {
    const db = new FakeDatabase();
    const store = new RateLimitStore({ pool: db });
    await store.sweepClosed({ windowMs: 60_000, limit: 10 ** 9 });
    assert.strictEqual(db.statements.at(-1).params[1], MAX_SWEEP_BATCH);
  }

  console.log('rate limit store tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
