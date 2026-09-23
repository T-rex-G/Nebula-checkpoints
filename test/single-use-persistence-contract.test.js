'use strict';

/*
 * The schema half of the single-use guard. The store's own tests prove what it
 * does with a database that behaves; this proves the database it is written
 * against is the one the migration creates, and that the properties the guard
 * depends on are held by the table rather than by the application.
 *
 * A guard enforced only in JavaScript is a guard that the next caller can
 * forget to ask for.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '020_single_use_guards.sql'),
  'utf8'
);

assert(sql.includes('CREATE TABLE nv_single_use_guards'), 'missing nv_single_use_guards');

/* The kind is closed. A typo must be a failed insert, not a fourth namespace
   that silently guards nothing. */
for (const kind of ['step-up', 'github-app-state', 'restore-authorization']) {
  assert(
    new RegExp(`'${kind.replace(/[-]/g, '\\-')}'`).test(sql),
    `guard_kind must admit ${kind}`
  );
}
assert.match(sql, /guard_kind text NOT NULL\s*\n?\s*CHECK \(guard_kind IN \(/, 'guard_kind must be constrained to known kinds');

/*
 * The column takes a digest and nothing else. If a caller ever passes a raw
 * grant, an OAuth state or a restore authorization, the insert fails rather
 * than storing a live credential in a table that outlives it.
 */
assert.match(
  sql, /guard_key text NOT NULL\s*\n?\s*CHECK \(guard_key ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  'guard_key must be constrained to a sha-256 digest'
);

/* One grant, one row, per kind: the primary key is what makes a conflicting
   insert the thing that decides a claim. */
assert.match(sql, /PRIMARY KEY \(guard_kind, guard_key\)/, 'the claim depends on this primary key');

assert.match(sql, /expires_at timestamptz NOT NULL/, 'a guard without an expiry would never be swept');
assert.match(sql, /consumed_at timestamptz NOT NULL DEFAULT now\(\)/, 'the claim records when it happened');
assert.match(
  sql, /CREATE INDEX nv_single_use_guards_expiry_idx\s*\n?\s*ON nv_single_use_guards \(expires_at\)/,
  'the sweep must read an index rather than the table'
);

/*
 * No capacity ceiling, and nothing that removes a row for any reason other
 * than its expiry. The Map this replaces dropped its oldest entry once it held
 * ten thousand, so a live grant could be forgotten under load and then
 * replayed -- a guard that fails open exactly when it is under most pressure.
 */
assert.strictEqual(
  /CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(sql), false,
  'no trigger may remove a guard: rows leave when they expire and at no other time'
);
assert.strictEqual(
  /\bLIMIT\b/i.test(sql), false,
  'the migration must not carry a capacity ceiling'
);
for (const forbidden of ['DROP TABLE', 'DELETE FROM']) {
  assert.strictEqual(
    sql.toUpperCase().includes(forbidden), false,
    `the migration must not ${forbidden.toLowerCase()}`
  );
}

/* Append-only: this migration adds, it does not rewrite an applied one. */
assert.strictEqual(
  /ALTER TABLE (?!nv_single_use_guards)/.test(sql), false,
  'a new guard table must not alter a table an earlier migration already applied'
);

console.log('single-use guard persistence contract tests passed');
