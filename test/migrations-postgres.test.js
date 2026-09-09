'use strict';

/*
 * Every other gate reads the migrations as text. None of them ever hands the
 * SQL to a server, so PostgreSQL never gets a say in whether the schema this
 * release depends on can exist.
 *
 * 015_alpha_privacy shipped in a candidate marked green while being impossible
 * to apply: three of its trigger functions aliased a table as "authorization",
 * a reserved word. Lint passed, the release tests passed, the unit suite
 * passed, and the deployment stopped at 014 and reported migration-mismatch.
 *
 * This runs the migrations against a real server. It needs one -- there is no
 * mock, because a mock is precisely what failed to catch the defect.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client } = require('pg');
const { loadMigrations, runMigrations, verifyMigrations } = require('../src/migrations');
const { verifyAlphaPrivacyPurge } = require('./alpha-privacy-purge-postgres');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();

/*
 * Refuse rather than skip. A gate that quietly passes when its server is
 * missing is the same as not having the gate, and this one exists because a
 * silent pass is what let the defect through.
 */
if (!ADMIN_URL) {
  throw new Error(
    'NV_TEST_DATABASE_URL is required: this gate applies the migrations to a real PostgreSQL server'
  );
}

function scratchName() {
  return `nvx_migration_gate_${crypto.randomBytes(6).toString('hex')}`;
}

function urlForDatabase(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function main() {
  const expected = loadMigrations(DIRECTORY);
  assert(expected.length > 0, 'no migrations were discovered');

  const scratch = scratchName();
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${scratch}`));

  try {
    const scratchUrl = urlForDatabase(ADMIN_URL, scratch);

    /* Applying them is the whole point: this is where invalid SQL surfaces. */
    const first = await withClient(scratchUrl, client => runMigrations(client, { directory: DIRECTORY }));
    assert.strictEqual(
      first.applied.length,
      expected.length,
      `applied ${first.applied.length} of ${expected.length} migrations`
    );
    assert.deepStrictEqual(
      first.applied,
      expected.map(item => item.id),
      'migrations were applied out of order, or one was skipped'
    );

    /* The server runs verify mode in production, so the state left behind has
     * to satisfy the same check the deployment will make. */
    const verified = await withClient(scratchUrl, client => verifyMigrations(client, { directory: DIRECTORY }));
    assert.deepStrictEqual(verified.missing, [], 'verification reports missing migrations');
    assert.deepStrictEqual(verified.changed, [], 'verification reports changed checksums');
    assert.deepStrictEqual(verified.unknown, [], 'verification reports unknown migrations');
    assert.strictEqual(verified.ok, true, 'a freshly migrated database does not verify');
    assert.strictEqual(verified.expectedLatest, expected.at(-1).id);

    /* A second run must be a no-op. A migration that only works on an empty
     * database breaks the next deploy rather than this one. */
    const second = await withClient(scratchUrl, client => runMigrations(client, { directory: DIRECTORY }));
    assert.deepStrictEqual(second.applied, [], 'migrations are not idempotent: a second run applied work');

    const reverified = await withClient(scratchUrl, client => verifyMigrations(client, { directory: DIRECTORY }));
    assert.strictEqual(reverified.ok, true, 'the database stops verifying after a second migration run');
    await withClient(scratchUrl, async client => {
      const retired = await client.query(`SELECT tablename FROM pg_tables
        WHERE schemaname='public' AND tablename IN (
          'nv_principals', 'nv_login_identities', 'nv_workspaces',
          'nv_workspace_bootstrap', 'nv_workspace_connections',
          'nv_workspace_sessions', 'nv_workspace_credentials')`);
      assert.deepStrictEqual(retired.rows, [], 'retired tables must be absent after migration');

      /* Reconstruct the historical schema only inside a rolled-back test
       * transaction. An upgrade must refuse unreviewed data, then succeed
       * after that data is explicitly cleared, preserving ordinary sessions. */
      await client.query('BEGIN');
      try {
        for (const id of ['016_personal_workspaces', '017_workspace_credentials']) {
          await client.query(expected.find(migration => migration.id === id).sql);
        }
        const principalId = crypto.randomUUID();
        await client.query('INSERT INTO nv_principals(principal_id) VALUES($1)', [principalId]);
        const ordinaryBefore = (await client.query('SELECT count(*)::int AS n FROM nv_sessions')).rows[0].n;
        const retirement = expected.find(migration => migration.id === '018_remove_retired_identity_tables');
        await client.query('SAVEPOINT reject_populated');
        await assert.rejects(() => client.query(retirement.sql), /contain data; complete the scoped data cleanup/);
        await client.query('ROLLBACK TO SAVEPOINT reject_populated');
        assert.strictEqual((await client.query('SELECT count(*)::int AS n FROM nv_principals')).rows[0].n, 1);
        await client.query('DELETE FROM nv_principals WHERE principal_id=$1', [principalId]);
        await client.query(retirement.sql);
        assert.strictEqual((await client.query('SELECT count(*)::int AS n FROM nv_sessions')).rows[0].n, ordinaryBefore);
      } finally {
        await client.query('ROLLBACK');
      }
    });
    await verifyAlphaPrivacyPurge(scratchUrl);
  } finally {
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`));
  }

  console.log(`postgres migration tests passed (${expected.length} migrations applied, verified, and re-applied clean)`);
}

main().catch(error => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
