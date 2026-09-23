'use strict';

/*
 * The schema half. The store's tests prove what it does with a database that
 * behaves; this proves the table it is written against is the one the
 * migration creates, and that the properties the limit depends on are held by
 * PostgreSQL rather than by the application remembering to ask.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '021_rate_limit_buckets.sql'),
  'utf8'
);

/* The statements only. The prose above them explains why there is no capacity
   ceiling, and a token search that reads the explanation as the thing it
   forbids is a test that fails on its own reasoning. */
const statements = sql.split('\n').filter(line => !/^\s*--/.test(line)).join('\n');
assert(sql.includes('CREATE TABLE nv_rate_limit_buckets'), 'missing nv_rate_limit_buckets');
assert.match(
  sql, /bucket_namespace text NOT NULL\s*\n?\s*CHECK \(bucket_namespace IN \('api', 'webhook'\)\)/,
  'the namespace is closed: a typo must be a failed insert, not a third budget nobody is watching'
);
assert.match(
  sql, /bucket_key text NOT NULL\s*\n?\s*CHECK \(bucket_key ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  'the key column takes a digest and nothing else, so a caller identity cannot be stored by mistake'
);
assert.match(
  sql, /PRIMARY KEY \(bucket_namespace, bucket_key\)/,
  'the conditional upsert depends on this primary key to serialise concurrent counts'
);
assert.match(sql, /window_started_at timestamptz NOT NULL/, 'the window start is stored, not a rolling timestamp');
assert.match(
  sql, /request_count integer NOT NULL DEFAULT 0\s*\n?\s*CHECK \(request_count >= 0\)/,
  'a negative count would be a limit that never triggers'
);
assert.match(
  sql, /CREATE INDEX nv_rate_limit_buckets_window_idx\s*\n?\s*ON nv_rate_limit_buckets \(window_started_at\)/,
  'the sweep must read an index rather than the table'
);

/*
 * No capacity ceiling and nothing that removes a row for a reason other than
 * its window having closed. The Map this replaces discarded its oldest entry
 * past five thousand, so a caller near their limit could be forgotten under
 * load and start again -- a limit that fails open exactly when the most
 * traffic is arriving.
 */
assert.strictEqual(
  /CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(statements), false,
  'no trigger may remove a counter: rows leave when their window closes and at no other time'
);
assert.strictEqual(/\bLIMIT\b/i.test(statements), false, 'the migration must not carry a capacity ceiling');
for (const forbidden of ['DROP TABLE', 'DELETE FROM']) {
  assert.strictEqual(statements.toUpperCase().includes(forbidden), false, `the migration must not ${forbidden.toLowerCase()}`);
}
assert.strictEqual(
  /ALTER TABLE (?!nv_rate_limit_buckets)/.test(statements), false,
  'a new counter table must not alter a table an earlier migration already applied'
);

console.log('rate limit persistence contract tests passed');
