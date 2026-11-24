'use strict';
/*
 * The durable stores a request's admission and its single-use grants are kept
 * in (the platform's durable stores), and how many accounts a session may
 * hold where they are kept (identity and access).
 */
const assert = require('assert');
const { createDurableStores } = require('../apps/api/src/platform/rate-limit/durable-stores.ts');
const { RateLimitStore } = require('../apps/api/src/platform/rate-limit/rate-limit-store.ts');
const { SingleUseStore } = require('../apps/api/src/platform/rate-limit/single-use-store.ts');
const { sessionAccountCapacity } = require('../apps/api/src/modules/identity-access/index.ts');

function pools() {
  const opened = [];
  return { opened, pool: () => { const pool = { id: opened.length + 1, query: async () => ({ rows: [] }) }; opened.push(pool); return pool; } };
}

{
  const { opened, pool } = pools();
  const stores = createDurableStores({ databaseConfigured: true, pool });
  assert.strictEqual(opened.length, 0, 'nothing is built until it is used');
  const rate = stores.apiRateLimitStore();
  assert(rate instanceof RateLimitStore, 'the rate limit is counted in the database');
  assert.strictEqual(stores.apiRateLimitStore(), rate, 'by one store');
  const single = stores.durableSingleUseStore();
  assert(single instanceof SingleUseStore);
  assert.strictEqual(stores.durableSingleUseStore(), single, 'and single-use grants by one store');
  assert.deepStrictEqual([rate.pool.id, single.pool.id, opened.length], [1, 2, 2], 'each over the pool as it was when first used');
}
{
  const { opened, pool } = pools();
  const stores = createDurableStores({ databaseConfigured: false, pool });
  assert.strictEqual(stores.apiRateLimitStore(), null, 'without a database each process counts for itself');
  assert.strictEqual(opened.length, 0);
  const unconfigured = createDurableStores({ databaseConfigured: false, pool: () => { throw new Error('DATABASE_URL is not configured'); } });
  assert.throws(() => unconfigured.durableSingleUseStore(), /DATABASE_URL is not configured/, 'a durable grant without a database is the configuration\'s refusal');
}

assert.strictEqual(sessionAccountCapacity(true), 10, 'a session kept in the database holds ten accounts');
assert.strictEqual(sessionAccountCapacity(false), 3, 'a session sealed into its cookie holds three');

console.log('Durable stores tests passed');
