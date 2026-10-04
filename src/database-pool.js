'use strict';
const { Pool } = require('pg');

// Server-side deadlines cancel work on PostgreSQL; the slightly longer client
// deadline also bounds a lost response. Acquisition and idle transaction limits
// prevent an unavailable connection or abandoned lock from consuming the pool.
const DATABASE_BUDGETS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,
  query_timeout: 12000,
  lock_timeout: 3000,
  idle_in_transaction_session_timeout: 15000
});

function createDatabasePool(connectionString, onIdleError) {
  const pool = new Pool({ connectionString, ...DATABASE_BUDGETS, enableChannelBinding: true });
  const reported = new WeakSet();
  function report(error) {
    if (reported.has(error)) return;
    reported.add(error);
    onIdleError(error);
  }
  // pg removes the failed idle client. A listener is still required to prevent
  // EventEmitter's unhandled error from terminating the whole HTTP service.
  pool.on('error', report);
  // An error on a checked-out connection still rejects its in-flight query.
  // Keep a listener for a socket failure between queries, when pg cannot attach
  // the failure to a query promise and otherwise emits an unhandled error.
  pool.on('connect', client => client.on('error', report));
  return pool;
}
module.exports = { DATABASE_BUDGETS, createDatabasePool };
