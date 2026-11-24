'use strict';
/*
 * The database lifecycle (apps/api/src/platform/persistence/database-lifecycle.ts):
 * one pool, one shared initialization, the backoff after a failure, the
 * generation that keeps a late success from undoing an invalidation, what the
 * readiness probe publishes, and the upkeep a ready store is given once.
 *
 * Every database operation is a deferred the test settles itself, the clock
 * is the test's, and the timers and the console are recorded.
 */
const assert = require('assert');
const path = require('path');
const { createDatabaseLifecycle } = require('../apps/api/src/platform/persistence/database-lifecycle.ts');
const { createDatabasePool, DATABASE_BUDGETS } = require('../apps/api/src/platform/persistence/database-pool.ts');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const URL = 'postgres://tester:secret@db.example/nebula?sslmode=require';

function harness(options = {}) {
  const calls = [];
  const pending = [];
  const deferred = label => new Promise((resolve, reject) => pending.push({ label, resolve, reject }));
  let idle = null;
  let clients = 0;
  const pool = {
    connect() {
      calls.push(['connect']);
      return deferred('connect').then(() => {
        const id = ++clients;
        return { id, release() { calls.push(['release', id]); } };
      });
    },
    query(text, values) { calls.push(['query', text, values]); return deferred('query'); },
    end() { calls.push(['end']); return Promise.resolve(); }
  };
  const migrations = {
    load(directory) { calls.push(['load', directory]); return options.migrations || [{ id: '001_sessions' }, { id: '023_exposure_verifications' }]; },
    run(client, runOptions) {
      calls.push(['run', client.id, runOptions.directory]);
      return deferred('run').then(result => { runOptions.logger.info('Applied database migration 023_exposure_verifications'); return result; });
    },
    verify(client, verifyOptions) { calls.push(['verify', client.id, verifyOptions.directory, Object.keys(verifyOptions)]); return deferred('verify'); }
  };
  let readyCalls = 0;
  const lifecycle = createDatabaseLifecycle({
    databaseUrl: options.databaseUrl === undefined ? URL : options.databaseUrl,
    migrationMode: options.mode || 'apply',
    migrationsDirectory: DIRECTORY,
    productName: 'Nebulaverse',
    eventRetentionDays: 90,
    sessionRetentionDays: 35,
    openPool(url, onIdleError) { calls.push(['open', url]); idle = onIdleError; return pool; },
    migrations,
    onReady: () => { readyCalls += 1; }
  });
  const settle = async (label, answer, fail) => {
    const index = pending.findIndex(item => item.label === label);
    assert(index >= 0, `nothing pending for ${label}`);
    const [item] = pending.splice(index, 1);
    if (fail) item.reject(answer); else item.resolve(answer);
    for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  return { lifecycle, calls, pending, settle, idle: error => idle(error), readyCalls: () => readyCalls };
}

const world = { now: 1_700_000_000_000, timers: [], logs: [] };
const saved = { now: Date.now, setInterval: global.setInterval, log: console.log, error: console.error };
function install() {
  Date.now = () => world.now;
  global.setInterval = (callback, ms) => {
    const timer = { callback, ms, unrefed: false, unref() { timer.unrefed = true; } };
    world.timers.push(timer);
    return timer;
  };
  console.log = (...args) => world.logs.push(['log', ...args]);
  console.error = (...args) => world.logs.push(['error', ...args]);
}
function restore() {
  Date.now = saved.now;
  global.setInterval = saved.setInterval;
  console.log = saved.log;
  console.error = saved.error;
}
function reset() { world.timers = []; world.logs = []; }
const json = entry => JSON.parse(entry[1]);
const state = lifecycle => lifecycle.readiness().state;

async function main() {
  install();
  try {
    /* Without a database: nothing is required, nothing is dialled, and the release's latest migration is reported. */
    {
      reset();
      const { lifecycle, calls } = harness({ databaseUrl: '' });
      assert.deepStrictEqual(lifecycle.readiness(), { state: 'connected', ok: true, retryable: false, message: 'Database is connected.' });
      assert.strictEqual(lifecycle.migration(), '023_exposure_verifications');
      assert.strictEqual(await lifecycle.ready(), false);
      assert.deepStrictEqual(calls, [['load', DIRECTORY]]);
      await lifecycle.close();
      assert.deepStrictEqual(calls, [['load', DIRECTORY]], 'closing never opens a pool');
      assert.strictEqual(harness({ databaseUrl: '', migrations: [] }).lifecycle.migration(), '');
    }

    /* A cold start migrates once, however many callers ask, and then starts the upkeep. */
    {
      reset();
      const h = harness();
      const { lifecycle, calls } = h;
      assert.strictEqual(state(lifecycle), 'waking', 'a configured database is waking until it answers');
      const first = lifecycle.ready();
      assert.strictEqual(lifecycle.ready(), first, 'callers share one initialization');
      assert.strictEqual(state(lifecycle), 'waking');
      assert.deepStrictEqual(calls.slice(1), [['open', URL], ['connect']]);
      await h.settle('connect');
      assert.deepStrictEqual(calls.slice(3), [['run', 1, DIRECTORY]]);
      await h.settle('run', { applied: ['022_exposure_scans', '023_exposure_verifications'], total: 23 });
      assert.strictEqual(await first, true);
      assert.strictEqual(state(lifecycle), 'connected');
      assert.deepStrictEqual(calls.slice(4, 5), [['release', 1]], 'the client goes back to the pool');
      const logged = world.logs.filter(entry => entry[0] === 'log').map(json);
      assert.deepStrictEqual(logged.map(entry => entry.db), ['Applied database migration 023_exposure_verifications', 'Nebulaverse intelligence store ready']);
      assert.deepStrictEqual([logged[1].migrationsApplied, logged[1].migrationsTotal], [2, 23]);
      assert(logged.every(entry => /^\d{4}-\d{2}-\d{2}T/.test(entry.t)));
      assert.deepStrictEqual(calls.slice(5), [
        ['query', `DELETE FROM nv_intelligence_events WHERE created_at < now() - ($1::int * interval '1 day')`, [90]],
        ['query', `DELETE FROM nv_sessions WHERE updated < now() - ($1::int * interval '1 day')`, [35]],
        ['query', `DELETE FROM nv_governance_idempotency WHERE created_at < now() - interval '24 hours'`, undefined]
      ], 'events and sessions past retention, and idempotency keys past their day');
      assert.deepStrictEqual(world.timers.map(timer => [timer.ms, timer.unrefed]), [[12 * 60 * 60 * 1000, true]]);
      assert.strictEqual(h.readyCalls(), 1);
      assert.strictEqual(lifecycle.ready(), first, 'a ready store is not initialized again');

      for (let i = 0; i < 3; i += 1) await h.settle('query', { rowCount: 0 });
      world.timers[0].callback();
      assert.strictEqual(calls.filter(call => call[0] === 'query').length, 6, 'the timer runs the upkeep again');
    }

    /* A failed round of upkeep is reported by its message, and the next round still runs. */
    {
      reset();
      const h = harness();
      const ready = h.lifecycle.ready();
      await h.settle('connect');
      await h.settle('run', { applied: [], total: 23 });
      assert.strictEqual(await ready, true);
      await h.settle('query', new Error('canceling statement due to statement timeout'), true);
      assert.deepStrictEqual(world.logs.filter(entry => entry[0] === 'error'), [['error', 'Database retention cleanup failed:', 'canceling statement due to statement timeout']]);
    }

    /* Verify mode checks the store and never migrates it; what it expects is what the probe reports. */
    {
      reset();
      const h = harness({ mode: 'verify' });
      const ready = h.lifecycle.ready();
      await h.settle('connect');
      assert.deepStrictEqual(h.calls.slice(3), [['verify', 1, DIRECTORY, ['directory']]]);
      await h.settle('verify', { ok: true, expectedLatest: '024_next', missing: [], changed: ['003_intelligence'], unknown: ['x', 'y'] });
      assert.strictEqual(await ready, true);
      assert.strictEqual(state(h.lifecycle), 'connected');
      assert.strictEqual(h.lifecycle.migration(), '024_next');
      const [log] = world.logs.filter(entry => entry[0] === 'log').map(json);
      assert.deepStrictEqual({ ...log, t: undefined }, {
        t: undefined, db: 'Nebulaverse migration verification complete', migration: '024_next', missingCount: 0, changedCount: 1, unknownCount: 2
      });
      assert(!h.calls.some(call => call[0] === 'run'));
      assert.strictEqual(h.readyCalls(), 1);
    }

    /* A store whose migrations are not this release's is a mismatch: not ready, no upkeep, and not dialled again. */
    {
      reset();
      const h = harness({ mode: 'verify' });
      const ready = h.lifecycle.ready();
      await h.settle('connect');
      await h.settle('verify', { ok: false, expectedLatest: '023_exposure_verifications', missing: ['023_exposure_verifications'], changed: [], unknown: [] });
      assert.strictEqual(await ready, false);
      assert.strictEqual(state(h.lifecycle), 'migration-mismatch');
      assert.strictEqual(h.lifecycle.readiness().retryable, false);
      assert.strictEqual(h.readyCalls(), 0);
      assert.strictEqual(world.timers.length, 0);
      assert.strictEqual(h.lifecycle.ready(), ready, 'the answer stands until the store is invalidated');
      assert.strictEqual(h.calls.filter(call => call[0] === 'connect').length, 1);
    }

    /* A failure is reported, published as unavailable, and not retried for fifteen seconds. */
    {
      reset();
      const h = harness();
      const ready = h.lifecycle.ready();
      await h.settle('connect', new Error('connect ECONNREFUSED'), true);
      assert.strictEqual(await ready, false);
      assert.strictEqual(state(h.lifecycle), 'unavailable');
      assert.deepStrictEqual(world.logs, [['error', 'DB unavailable; retrying after a short backoff:', 'connect ECONNREFUSED']]);
      world.now += 14999;
      assert.strictEqual(await h.lifecycle.ready(), false);
      assert.strictEqual(h.calls.filter(call => call[0] === 'connect').length, 1, 'no connection inside the backoff');
      world.now += 1;
      const again = h.lifecycle.ready();
      assert.strictEqual(state(h.lifecycle), 'waking');
      assert.strictEqual(h.calls.filter(call => call[0] === 'connect').length, 2, 'the backoff ends at fifteen seconds');
      await h.settle('connect');
      await h.settle('run', new Error('could not obtain lock'), true);
      assert.strictEqual(await again, false);
      assert.deepStrictEqual(h.calls.filter(call => call[0] === 'release'), [['release', 1]], 'a failed migration still gives the client back');
      assert.strictEqual(h.readyCalls(), 0);
    }

    /* An invalidation while an initialization is in flight wins over its late success. */
    {
      reset();
      const h = harness();
      const ready = h.lifecycle.ready();
      h.lifecycle.invalidate('waking');
      assert.strictEqual(state(h.lifecycle), 'waking');
      await h.settle('connect');
      await h.settle('run', { applied: [], total: 23 });
      assert.strictEqual(await ready, false);
      assert.strictEqual(state(h.lifecycle), 'unavailable');
      assert.strictEqual(h.readyCalls(), 0);
      assert.strictEqual(world.timers.length, 0, 'no upkeep for a store that was lost');
      world.now += 15000;
      const fresh = h.lifecycle.ready();
      assert.notStrictEqual(fresh, ready, 'the next caller starts over');
      await h.settle('connect');
      await h.settle('run', { applied: [], total: 23 });
      assert.strictEqual(await fresh, true);
      assert.strictEqual(h.readyCalls(), 1);
    }

    /* Each reason for a loss, and the default; a mismatch shows only once the store answers. */
    {
      reset();
      const h = harness();
      h.lifecycle.invalidate();
      assert.strictEqual(state(h.lifecycle), 'unavailable');
      h.lifecycle.invalidate('waking');
      assert.deepStrictEqual(h.lifecycle.readiness(), { state: 'waking', ok: false, retryable: true, message: 'Database is waking; retry shortly.' });
      h.lifecycle.invalidate('migration-mismatch');
      assert.strictEqual(state(h.lifecycle), 'unavailable');
      assert.strictEqual(await h.lifecycle.ready(), false, 'an invalidation starts the backoff');
      assert(!h.calls.some(call => call[0] === 'connect'));
    }

    /* A connection lost while idle invalidates the store and is logged by its SQLSTATE alone. */
    {
      reset();
      const h = harness();
      const ready = h.lifecycle.ready();
      await h.settle('connect');
      await h.settle('run', { applied: [], total: 23 });
      assert.strictEqual(await ready, true);
      world.logs = [];
      h.idle(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
      assert.strictEqual(state(h.lifecycle), 'unavailable');
      assert.notStrictEqual(h.lifecycle.ready(), ready, 'the shared answer is forgotten');
      h.idle(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      h.idle(Object.assign(new Error('odd'), { code: 12345 }));
      h.idle(null);
      const logged = world.logs.map(json);
      assert.deepStrictEqual(logged.map(entry => [entry.event, entry.code]), [
        ['database-idle-disconnect', '57P01'], ['database-idle-disconnect', 'DB_CONNECTION_FAILED'],
        ['database-idle-disconnect', 12345], ['database-idle-disconnect', 'DB_CONNECTION_FAILED']
      ]);
      assert(!JSON.stringify(world.logs).includes('administrator'), 'the message never reaches the log');
    }

    /* The upkeep starts once, however often the store becomes ready again. */
    {
      reset();
      const h = harness();
      for (let round = 0; round < 2; round += 1) {
        const ready = h.lifecycle.ready();
        await h.settle('connect');
        await h.settle('run', { applied: [], total: 23 });
        assert.strictEqual(await ready, true);
        h.lifecycle.invalidate();
        world.now += 15000;
      }
      assert.strictEqual(world.timers.length, 1);
      assert.strictEqual(h.calls.filter(call => call[0] === 'query').length, 3);
      assert.strictEqual(h.readyCalls(), 2, 'the ready hook is told each time; what it starts, it starts once');
      assert.strictEqual(h.lifecycle.pool(), h.lifecycle.pool());
      assert.strictEqual(h.calls.filter(call => call[0] === 'open').length, 1, 'one pool for the life of the process');
      await h.lifecycle.close();
      assert.strictEqual(h.calls.at(-1)[0], 'end');
    }
  } finally {
    restore();
  }
  finished = true;
  /*
   * The pool the server opens: channel binding on, so a credential is only
   * ever proved to the server holding the TLS session it was sent over, and
   * the budgets that bound each wait. Built without connecting.
   */
  {
    const pool = createDatabasePool('postgres://tester:secret@db.example/nebula?sslmode=require', () => {});
    assert.equal(pool.options.enableChannelBinding, true, 'the pool binds its credentials to the channel');
    for (const [name, value] of Object.entries(DATABASE_BUDGETS)) assert.equal(pool.options[name], value, name);
    assert.deepEqual([DATABASE_BUDGETS.max, DATABASE_BUDGETS.connectionTimeoutMillis, DATABASE_BUDGETS.statement_timeout, DATABASE_BUDGETS.lock_timeout], [3, 5000, 10000, 3000]);
    await pool.end();
  }
  console.log('database lifecycle tests passed');
}

/* A deferred nobody settles leaves main() waiting with nothing left to run, and Node would exit cleanly. */
let finished = false;
process.on('exit', () => {
  if (finished) return;
  restore();
  console.error('database lifecycle tests did not finish: an operation was left waiting');
  process.exitCode = 1;
});
main().catch(error => { restore(); console.error(error); process.exit(1); });
