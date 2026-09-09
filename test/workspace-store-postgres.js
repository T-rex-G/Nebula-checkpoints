'use strict';

// Invoked by the real PostgreSQL migration gate, never by a mock database.
const assert = require('assert');
const crypto = require('crypto');
const { Pool, Client } = require('pg');
const { withBackupSchema } = require('../scripts/alpha-db');
const { WorkspaceStore } = require('../src/workspace-store');
const { digest, verifiedHumanIdentity } = require('../src/workspace-identity');

module.exports = async function testWorkspaceStore(connectionString) {
  const pool = new Pool({ connectionString, max: 3 });
  const secret = crypto.randomBytes(32).toString('base64url');
  const config = { setupDigest: digest(secret), setupExpiresAt: Date.now() + 3600000 };
  const store = new WorkspaceStore({ pool, config });
  const human = id => verifiedHumanIdentity({ provider: 'github', providerAccountId: id, login: `user-${id}` });
  const verifyIdentity = async () => human(42);
  try {
    await withBackupSchema(connectionString, {}, async version => {
      assert.strictEqual(version, '016_personal_workspaces');
    }, { connectDatabaseImpl: async () => {
      const client = new Client({ connectionString }); await client.connect(); return client;
    } });
    await assert.rejects(() => store.claim({ secret: 'x'.repeat(43), verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' });
    const expired = new WorkspaceStore({ pool, config: { ...config, setupExpiresAt: Date.now() - 1 } });
    await assert.rejects(() => expired.claim({ secret, verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' });
    for (let i = 0; i < 3; i++) await assert.rejects(() => store.claim({ secret: 'x'.repeat(43), verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' });
    const locked = (await pool.query('SELECT failed_attempts, locked_until FROM nv_workspace_bootstrap')).rows[0];
    assert.strictEqual(locked.failed_attempts, 5);
    assert(new Date(locked.locked_until).getTime() > Date.now());
    await assert.rejects(() => new WorkspaceStore({ pool, config }).claim({ secret, verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' }, 'setup attempt lock survives store restart');
    await pool.query("UPDATE nv_workspace_bootstrap SET locked_until=now()-interval '1 second'");
    await assert.rejects(() => store.claim({ secret, verifyIdentity: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_principals')).rows[0].n, 0,
      'interrupted provider verification must leave no partial owner');
    await pool.query(`CREATE FUNCTION nv_workspace_test_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated interrupted workspace insert'; END; $$`);
    await pool.query(`CREATE TRIGGER nv_workspace_test_interrupt BEFORE INSERT ON nv_workspaces
      FOR EACH ROW EXECUTE FUNCTION nv_workspace_test_interrupt()`);
    await assert.rejects(() => store.claim({ secret, verifyIdentity }), /simulated interrupted workspace insert/);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_principals')).rows[0].n, 0);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_login_identities')).rows[0].n, 0);
    assert.strictEqual((await pool.query('SELECT claimed_workspace_id FROM nv_workspace_bootstrap')).rows[0].claimed_workspace_id, null);
    await pool.query('DROP TRIGGER nv_workspace_test_interrupt ON nv_workspaces');
    await pool.query('DROP FUNCTION nv_workspace_test_interrupt()');

    // Hold the first claim inside the transaction while the second competes.
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const firstEntered = new Promise(resolve => { entered = resolve; });
    const first = store.claim({ secret, verifyIdentity: async () => { entered(); await held; return human(42); } });
    await firstEntered;
    const second = store.claim({ secret, verifyIdentity: async () => human(43) });
    release();
    const outcomes = await Promise.allSettled([first, second]);
    assert.deepStrictEqual(outcomes.map(x => x.status), ['fulfilled', 'rejected']);
    assert.strictEqual(outcomes[1].reason.code, 'WORKSPACE_SETUP_REJECTED');
    const claimed = outcomes[0].value;
    const owner = claimed.context.principalId;
    const workspace = claimed.context.workspaceId;
    assert.strictEqual(claimed.context.role, 'owner');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_principals')).rows[0].n, 1);
    await assert.rejects(() => store.claim({ secret, verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' });
    await assert.rejects(() => store.signIn({ identity: human(43) }), { code: 'WORKSPACE_SIGN_IN_REJECTED' });

    const renamed = { ...human(42), login: 'renamed' };
    const signedIn = await store.signIn({ identity: renamed, previousToken: claimed.token });
    assert.notStrictEqual(signedIn.token, claimed.token, 'sign-in must rotate the session');
    assert.strictEqual(await store.readContext(claimed.token), null, 'rotation must invalidate the old session');
    assert.strictEqual(signedIn.context.principalId, owner);
    assert.strictEqual((await pool.query('SELECT login FROM nv_login_identities')).rows[0].login, 'renamed');
    const token = signedIn.token;
    const restarted = new WorkspaceStore({ pool, config: { setupDigest: '', setupExpiresAt: 0 } });
    assert.deepStrictEqual(await restarted.readContext(token), signedIn.context, 'restart must preserve durable ownership');

    const legacyKey = 'a'.repeat(64);
    const connection = await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey });
    const selected = await store.selectConnection({ token, workspaceId: workspace, connectionId: connection.id });
    assert.strictEqual(selected.principalId, owner, 'selecting another Git account must not change the person');
    assert.strictEqual(selected.connection.providerUserId, '99');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_login_identities')).rows[0].n, 1,
      'connecting credentials is not identity linking');
    await assert.rejects(() => store.signIn({ identity: human(99) }), { code: 'WORKSPACE_SIGN_IN_REJECTED' });
    await assert.rejects(() => store.selectConnection({ token, workspaceId: crypto.randomUUID(), connectionId: connection.id }), { code: 'WORKSPACE_CONNECTION_REJECTED' });

    const other = crypto.randomUUID(), otherWorkspace = crypto.randomUUID(), otherConnection = crypto.randomUUID();
    await pool.query('INSERT INTO nv_principals(principal_id) VALUES($1)', [other]);
    await pool.query('INSERT INTO nv_workspaces(workspace_id, owner_principal_id) VALUES($1,$2)', [otherWorkspace, other]);
    await pool.query(`INSERT INTO nv_workspace_connections(connection_id, workspace_id, principal_id, provider, instance, provider_user_id, login, legacy_identity_key)
      VALUES($1,$2,$3,'github','https://github.com','100','other',$4)`, [otherConnection, otherWorkspace, other, legacyKey]);
    await assert.rejects(() => store.selectConnection({ token, workspaceId: workspace, connectionId: otherConnection }), { code: 'WORKSPACE_CONNECTION_REJECTED' });
    await assert.rejects(() => pool.query('UPDATE nv_workspace_sessions SET connection_id=$1 WHERE session_hash=$2', [otherConnection, digest(token)]),
      error => error.code === '23503', 'database must reject cross-principal selections too');

    // Legacy cleanup tables do not own or cascade into foundation metadata.
    await pool.query('INSERT INTO nv_sessions(sid, data, identity_keys) VALUES($1,$2,$3)', ['legacy-workspace-test', 'legacy-sealed-data', [legacyKey]]);
    await pool.query('DELETE FROM nv_sessions WHERE identity_keys @> $1::text[]', [[legacyKey]]);
    assert.strictEqual((await store.readContext(token)).principalId, owner);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_connections')).rows[0].n, 2);
    await store.disconnectConnection({ token, connectionId: connection.id });
    assert.strictEqual((await store.readContext(token)).connection, null);

    /*
     * disconnectConnection clears the session pointer itself, so the assertion
     * above passes whether or not the context query excludes revoked rows. That
     * clause is only load-bearing when a connection is revoked by some other
     * path and the pointer survives -- what any later admin revoke, expiry
     * sweep, or Change B adoption would look like. Revoke it underneath the
     * session and require the context to refuse.
     *
     * The refusal is stronger than dropping the connection back to null: a
     * session still pointing at a revoked connection resolves to no context at
     * all, so every protected route answers WORKSPACE_SESSION_REQUIRED rather
     * than silently continuing as an owner session with no Git account.
     */
    const rebound = await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey });
    await store.selectConnection({ token, workspaceId: workspace, connectionId: rebound.id });
    assert.strictEqual((await store.readContext(token)).connection.id, rebound.id);
    await pool.query('UPDATE nv_workspace_connections SET revoked_at=now() WHERE connection_id=$1', [rebound.id]);
    assert.strictEqual((await pool.query('SELECT connection_id FROM nv_workspace_sessions WHERE session_hash=$1',
      [digest(token)])).rows[0].connection_id, rebound.id, 'the pointer must survive, or this proves nothing');
    assert.strictEqual(await store.readContext(token), null,
      'a session pointing at a revoked connection must not resolve');
    await assert.rejects(() => store.selectConnection({ token, workspaceId: workspace, connectionId: rebound.id }),
      { code: 'WORKSPACE_SESSION_REQUIRED' });
    await pool.query('UPDATE nv_workspace_sessions SET connection_id=NULL WHERE session_hash=$1', [digest(token)]);
    assert.strictEqual((await store.readContext(token)).connection, null, 'clearing the pointer restores the session');
    assert.strictEqual((await pool.query('SELECT revoked_at FROM nv_workspace_connections WHERE connection_id=$1', [otherConnection])).rows[0].revoked_at, null);
    await assert.rejects(() => store.selectConnection({ token, workspaceId: workspace, connectionId: connection.id }), { code: 'WORKSPACE_CONNECTION_REJECTED' });

    await pool.query('UPDATE nv_principals SET revoked_at=now() WHERE principal_id=$1', [owner]);
    assert.strictEqual(await store.readContext(token), null, 'revocation must be resolved on the next request');
    await assert.rejects(() => store.signIn({ identity: renamed }), { code: 'WORKSPACE_SIGN_IN_REJECTED' });
    await assert.rejects(() => restarted.claim({ secret, verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' }, 'losing the owner must not reopen setup');
    await pool.query('UPDATE nv_principals SET revoked_at=NULL WHERE principal_id=$1', [owner]);
    await pool.query("UPDATE nv_workspace_sessions SET expires_at=now()-interval '1 second' WHERE session_hash=$1", [digest(token)]);
    assert.strictEqual(await store.readContext(token), null);
    await store.signOut(token);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_sessions')).rows[0].n, 0);
    console.log('workspace PostgreSQL tests passed (claim race, rollback, restart, isolation, revocation, legacy cleanup)');
  } finally { await pool.end(); }
};
