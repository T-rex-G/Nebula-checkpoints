'use strict';

/*
 * The durable single-use guard. What matters here is not that it writes a row
 * but that one grant can be claimed exactly once across connections, that a
 * guard is never dropped while it is still alive, and that a store which
 * cannot answer refuses rather than allows.
 *
 * The fake database implements the statements' real semantics rather than
 * recording that they were sent. A guard asserted against a recording mock is
 * a guard asserted against itself.
 */

const assert = require('assert');
const {
  GUARD_KINDS, MAX_SWEEP_BATCH, SingleUseStore, SingleUseStoreError, guardKeyFor
} = require('../src/single-use-store');

const SECOND = 1000;

class FakeDatabase {
  constructor({ delayMs = 0 } = {}) {
    this.rows = new Map();
    this.clock = 1_800_000_000_000;
    this.delayMs = delayMs;
    this.failure = null;
    this.statements = [];
  }

  now() { return this.clock; }

  async query(text, params) {
    this.statements.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    /*
     * Latency before the decision, never inside it. A real server decides a
     * conflicting insert indivisibly; a fake that awaited between its own read
     * and write would be modelling the bug rather than the database.
     */
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (this.failure) throw this.failure;

    if (/^INSERT INTO nv_single_use_guards/.test(text)) {
      const [kind, key, expiresAtMs] = params;
      const id = `${kind}\u0000${key}`;
      const existing = this.rows.get(id);
      if (existing && Number(existing.expiresAt) >= this.clock) return { rows: [], rowCount: 0 };
      this.rows.set(id, { kind, key, expiresAt: Number(expiresAtMs), consumedAt: this.clock });
      return { rows: [{ claimed: 1 }], rowCount: 1 };
    }
    if (/^DELETE FROM nv_single_use_guards/.test(text)) {
      const [limit] = params;
      const expired = [...this.rows.entries()]
        .filter(([, row]) => Number(row.expiresAt) < this.clock)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
        .slice(0, Number(limit));
      for (const [id] of expired) this.rows.delete(id);
      return { rows: [], rowCount: expired.length };
    }
    throw new Error(`unexpected statement: ${text}`);
  }
}

function storeWith(options = {}) {
  const db = new FakeDatabase(options);
  return { db, store: new SingleUseStore({ pool: db, ...options }) };
}

(async () => {
  /* A grant is claimed once and refused after. */
  {
    const { db, store } = storeWith();
    const claim = { kind: 'step-up', key: 'grant-1', expiresAt: db.clock + 300 * SECOND };
    assert.strictEqual(await store.consumeOnce(claim), true, 'a fresh grant is claimable');
    assert.strictEqual(await store.consumeOnce(claim), false, 'a spent grant is refused');
  }

  /* Every guard kind behaves the same way, and none of them share a key. */
  {
    const { db, store } = storeWith();
    for (const kind of GUARD_KINDS) {
      assert.strictEqual(
        await store.consumeOnce({ kind, key: 'shared-value', expiresAt: db.clock + 60 * SECOND }),
        true,
        `${kind} must not be blocked by another kind holding the same value`
      );
    }
    assert.strictEqual(db.rows.size, GUARD_KINDS.length, 'one row per kind, not one row shared');
  }

  /* The raw grant never reaches the database; only a digest of it does. */
  {
    const { db, store } = storeWith();
    await store.consumeOnce({ kind: 'step-up', key: 'secret-grant-value', expiresAt: db.clock + 60 * SECOND });
    const sent = JSON.stringify(db.statements);
    assert.strictEqual(sent.includes('secret-grant-value'), false, 'a grant must not be written to the table');
    assert.strictEqual(
      db.statements[0].params[1], guardKeyFor('step-up', 'secret-grant-value'),
      'the stored key is the domain-separated digest'
    );
    assert.match(db.statements[0].params[1], /^[0-9a-f]{64}$/, 'the digest must satisfy the column CHECK');
    assert.notStrictEqual(
      guardKeyFor('step-up', 'x'), guardKeyFor('github-app-state', 'x'),
      'one value under two kinds must not produce one key'
    );
  }

  /* Expiry frees the key; the boundary refuses. */
  {
    const { db, store } = storeWith();
    const key = 'expiring-grant';
    await store.consumeOnce({ kind: 'step-up', key, expiresAt: db.clock + 10 * SECOND });
    db.clock += 10 * SECOND;
    assert.strictEqual(
      await store.consumeOnce({ kind: 'step-up', key, expiresAt: db.clock + 10 * SECOND }), false,
      'a guard expiring exactly now still refuses, as the in-memory adapter does'
    );
    db.clock += 1;
    assert.strictEqual(
      await store.consumeOnce({ kind: 'step-up', key, expiresAt: db.clock + 10 * SECOND }), true,
      'once past its expiry the key is free again'
    );
  }

  /*
   * One statement per claim. This is the property the race depends on and the
   * only one a test can hold on to: a fake database decides atomically because
   * a real one does, so a store split into a read and a write would still race
   * correctly against the fake while racing wrongly against PostgreSQL. What
   * gives that split away is the extra round trip.
   */
  {
    const { db, store } = storeWith();
    await store.consumeOnce({ kind: 'step-up', key: 'counted', expiresAt: db.clock + 60 * SECOND });
    assert.strictEqual(
      db.statements.length, 1,
      'a claim must be one statement: a read and a write can be interleaved, one insert cannot'
    );
    assert.match(
      db.statements[0].text, /^INSERT INTO nv_single_use_guards .* ON CONFLICT .* DO UPDATE .* WHERE /,
      'the decision lives in the conflict clause, not in the application'
    );
  }

  /*
   * The race: two connections carrying one grant, against a store that takes
   * time to answer. Exactly one may come back with a claim.
   */
  {
    const { db, store } = storeWith({ delayMs: 15 });
    const claim = { kind: 'step-up', key: 'contended-grant', expiresAt: db.clock + 300 * SECOND };
    const other = new SingleUseStore({ pool: db });
    const results = await Promise.all([store.consumeOnce(claim), other.consumeOnce(claim)]);
    assert.strictEqual(
      results.filter(Boolean).length, 1,
      'exactly one of two racing connections may claim one grant'
    );
  }

  /* A store that cannot answer refuses, and does not name the grant when it does. */
  {
    const { db, store } = storeWith();
    db.failure = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    await assert.rejects(
      store.consumeOnce({ kind: 'step-up', key: 'unreachable-grant', expiresAt: db.clock + 60 * SECOND }),
      error => error instanceof SingleUseStoreError
        && error.status === 503
        && !String(error.message).includes('unreachable-grant'),
      'an unavailable store refuses with a typed error that does not leak the grant'
    );
  }

  /* No capacity ceiling: a live guard is never forgotten to make room. */
  {
    const { db, store } = storeWith();
    for (let i = 0; i < 20_000; i += 1) {
      await store.consumeOnce({ kind: 'step-up', key: `grant-${i}`, expiresAt: db.clock + 300 * SECOND });
    }
    assert.strictEqual(db.rows.size, 20_000, 'no guard may be evicted to make room for another');
    assert.strictEqual(
      await store.consumeOnce({ kind: 'step-up', key: 'grant-0', expiresAt: db.clock + 300 * SECOND }), false,
      'the oldest live guard still refuses after twice the ceiling the Map had'
    );
  }

  /* The sweep takes expired rows only, a bounded slice at a time. */
  {
    const { db, store } = storeWith();
    for (let i = 0; i < 40; i += 1) {
      await store.consumeOnce({ kind: 'step-up', key: `old-${i}`, expiresAt: db.clock + 5 * SECOND });
    }
    await store.consumeOnce({ kind: 'step-up', key: 'live', expiresAt: db.clock + 600 * SECOND });
    db.clock += 10 * SECOND;

    assert.strictEqual(await store.sweepExpired({ limit: 25 }), 25, 'the sweep is bounded by its limit');
    assert.strictEqual(await store.sweepExpired({ limit: 25 }), 15, 'the rest follow on the next pass');
    assert.strictEqual(await store.sweepExpired({ limit: 25 }), 0, 'nothing is left to sweep');
    assert.strictEqual(db.rows.size, 1, 'the live guard survives every pass');
    assert.strictEqual(
      await store.consumeOnce({ kind: 'step-up', key: 'live', expiresAt: db.clock + 600 * SECOND }), false,
      'and it still refuses a replay afterwards'
    );
  }

  /* Misuse is refused rather than stored. */
  {
    const { db, store } = storeWith();
    await assert.rejects(
      store.consumeOnce({ kind: 'not-a-guard', key: 'x', expiresAt: db.clock + SECOND }),
      TypeError, 'an unknown guard kind is refused'
    );
    for (const expiresAt of [0, -1, NaN, undefined, 'soon']) {
      await assert.rejects(
        store.consumeOnce({ kind: 'step-up', key: 'x', expiresAt }),
        TypeError, `an expiry of ${String(expiresAt)} is refused`
      );
    }
    assert.strictEqual(db.rows.size, 0, 'a refused claim writes nothing');
    assert.throws(() => new SingleUseStore({}), TypeError, 'the store requires a pool');
  }

  /* The sweep batch cannot be talked into an unbounded delete. */
  {
    const { db, store } = storeWith();
    await store.sweepExpired({ limit: 10 ** 9 });
    assert.strictEqual(db.statements.at(-1).params[0], MAX_SWEEP_BATCH, 'the batch is capped');
    await store.sweepExpired({ limit: -5 });
    assert.strictEqual(db.statements.at(-1).params[0], 1, 'a nonsense batch floors at one row');
  }

  console.log('single-use store tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
