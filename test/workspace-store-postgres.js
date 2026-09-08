'use strict';

// Invoked by the real PostgreSQL migration gate, never by a mock database.
const assert = require('assert');
const crypto = require('crypto');
const { Pool, Client } = require('pg');
const { withBackupSchema } = require('../scripts/alpha-db');
const { WorkspaceStore } = require('../src/workspace-store');
const { digest, verifiedHumanIdentity } = require('../src/workspace-identity');
const { workspaceExecutionAuthority } = require('../src/workspace-authority');
const { createWorkspaceSafetyStore } = require('../src/workspace-safety');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');

module.exports = async function testWorkspaceStore(connectionString) {
  const pool = new Pool({ connectionString, max: 3 });
  const secret = crypto.randomBytes(32).toString('base64url');
  const config = { setupDigest: digest(secret), setupExpiresAt: Date.now() + 3600000 };
  const credentialKey = crypto.randomBytes(32);
  const codec = {
    seal(value) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', credentialKey, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
    },
    unseal(value) {
      try {
        const raw = Buffer.from(value, 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', credentialKey, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]));
      } catch { return null; }
    }
  };
  const store = new WorkspaceStore({ pool, config, ...codec });
  const human = id => verifiedHumanIdentity({ provider: 'github', providerAccountId: id, login: `user-${id}` });
  const verifyIdentity = async () => human(42);
  try {
    await withBackupSchema(connectionString, {}, async version => {
      assert.strictEqual(version, '017_workspace_credentials');
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

    await assert.rejects(() => store.executionAccount(token), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' });
    const credential = { provider: 'github', providerAccountId: 99, login: 'user-99', authMethod: 'token', token: 'synthetic-workspace-credential-a' };
    const connected = await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey, credential });
    assert.strictEqual(connected.id, connection.id, 'reconnection retains the stable connection ID');
    assert.strictEqual((await store.listConnections(token)).length, 1, 'other principal connections are never listed');
    assert.strictEqual((await store.listConnections(token))[0].credentialStored, true);
    assert.strictEqual((await store.executionAccount(token)).token, credential.token);
    assert.strictEqual((await new WorkspaceStore({ pool, config, ...codec }).executionAccount(token)).token, credential.token,
      'encrypted credentials survive a process restart within the session lifetime');
    const ciphertext = (await pool.query('SELECT sealed_credential FROM nv_workspace_credentials WHERE session_hash=$1', [digest(token)])).rows[0].sealed_credential;
    assert(!ciphertext.includes(credential.token), 'the database does not hold plaintext provider credentials');
    const secondSession = await store.signIn({ identity: renamed });
    await store.selectConnection({ token: secondSession.token, workspaceId: workspace, connectionId: connection.id });
    await assert.rejects(() => store.executionAccount(secondSession.token), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' },
      'a second session cannot borrow the first session credential');
    await store.bindConnection({ token: secondSession.token, identity: human(99), legacyIdentityKey: legacyKey,
      credential: { ...credential, token: 'synthetic-workspace-credential-b' } });
    assert.strictEqual((await store.executionAccount(token)).token, credential.token);
    await pool.query('UPDATE nv_workspace_credentials SET sealed_credential=$1 WHERE session_hash=$2', [ciphertext, digest(secondSession.token)]);
    await assert.rejects(() => store.executionAccount(secondSession.token), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' },
      'copying a sealed credential to another session fails envelope binding');
    await assert.rejects(() => pool.query(`INSERT INTO nv_workspace_credentials
      (session_hash, connection_id, workspace_id, principal_id, sealed_credential) VALUES($1,$2,$3,$4,$5)`,
    [digest(token), otherConnection, otherWorkspace, other, ciphertext]), error => error.code === '23503');
    await assert.rejects(() => store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey,
      credential: { ...credential, providerAccountId: 100 } }), { code: 'WORKSPACE_CONNECTION_REJECTED' });
    assert.strictEqual((await store.executionAccount(token)).token, credential.token, 'failed reconnect preserves the original credential');

    const execution = await store.executionContext(token);
    assert.strictEqual(execution.context.connection.id, connection.id);
    assert.strictEqual(execution.account.providerAccountId, 99, 'context and credential resolve together');
    const ownerExecutionKey = workspaceExecutionAuthority(execution.context).identityKey;
    assert.notStrictEqual(ownerExecutionKey, legacyKey);
    const safety = createWorkspaceSafetyStore(pool);
    await safety.update(ownerExecutionKey, { readOnly: true });
    await Promise.all([
      safety.update(ownerExecutionKey, { protect: { repo: 'Owner/Demo', path: 'README.md' } }),
      safety.update(ownerExecutionKey, { protect: { repo: 'owner/demo', path: '.github/**' } })
    ]);
    assert.deepStrictEqual((await safety.load(ownerExecutionKey)).protected['owner/demo'], ['.github/**', 'README.md'],
      'concurrent safeguard changes are serialized without losing either pattern');
    await assert.rejects(() => safety.update(ownerExecutionKey, { protect: { repo: 'owner/demo', path: '../escape' } }), { code: 'WORKSPACE_INPUT_INVALID' });
    await safety.update(legacyKey, { freezeSync: true });
    const testerId = crypto.randomUUID(), inviteId = crypto.randomBytes(16).toString('hex');
    await pool.query(`INSERT INTO nv_alpha_invites(invite_id,secret_digest,tester_label,repository_scopes,terms_version,expires_at)
      VALUES($1,$2,'owner-isolation-test',ARRAY['github:github.com:owner/demo'],'2026-08-01',now()+interval '1 day')`, [inviteId, digest(inviteId)]);
    await pool.query(`INSERT INTO nv_alpha_testers(tester_id,invite_id,tester_label,repository_scopes,terms_version,terms_accepted_at)
      VALUES($1,$2,'owner-isolation-test',ARRAY['github:github.com:owner/demo'],'2026-08-01',now())`, [testerId, inviteId]);
    const privacy = new AlphaPrivacyStore({ pool });
    await privacy.bindProviderIdentity({ testerId, identityKey: legacyKey, provider: 'github', authority: 'github.com' });
    await privacy.createDeletionRequest({ testerId });
    const purged = await privacy.purgeTester({ testerId });
    assert.strictEqual(purged.status, 'complete', 'exercise the actual cohort purge transaction');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_security_state WHERE identity_key=$1', [legacyKey])).rowCount, 0);
    assert.strictEqual((await safety.load(ownerExecutionKey)).readOnly, true, 'tester purge preserves owner safeguards');
    assert.strictEqual((await store.executionContext(token)).account.token, credential.token, 'tester purge preserves owner credentials');

    // Legacy cleanup tables do not own or cascade into foundation metadata.
    await pool.query('INSERT INTO nv_sessions(sid, data, identity_keys) VALUES($1,$2,$3)', ['legacy-workspace-test', 'legacy-sealed-data', [legacyKey]]);
    await pool.query('DELETE FROM nv_sessions WHERE identity_keys @> $1::text[]', [[legacyKey]]);
    assert.strictEqual((await store.readContext(token)).principalId, owner);
    assert.strictEqual((await store.executionAccount(token)).token, credential.token, 'legacy cleanup cannot remove owner credentials');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_connections')).rows[0].n, 2);
    await store.disconnectConnection({ token, connectionId: connection.id });
    assert.strictEqual((await safety.load(ownerExecutionKey)).readOnly, true, 'disconnect retains durable owner safeguards');
    assert.strictEqual((await store.readContext(token)).connection, null);
    assert.strictEqual((await store.readContext(secondSession.token)).connection, null);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 0,
      'disconnect removes credentials from every workspace session for this connection');
    await store.signOut(secondSession.token);

    const rotating = await store.signIn({ identity: renamed });
    await store.bindConnection({ token: rotating.token, identity: human(99), legacyIdentityKey: legacyKey, credential });
    const rotated = await store.signIn({ identity: renamed, previousToken: rotating.token });
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 0,
      'session rotation cascades to credentials, but not durable account bindings');
    await store.bindConnection({ token: rotated.token, identity: human(99), legacyIdentityKey: legacyKey, credential });
    await store.signOut(rotated.token);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 0, 'sign-out removes session credentials');

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
    const rebound = await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey, credential });
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

    await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey });
    await store.selectConnection({ token, workspaceId: workspace, connectionId: rebound.id });
    await assert.rejects(() => store.executionAccount(token), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' },
      'metadata-only reactivation must not resurrect a credential left behind by out-of-band revocation');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 0);

    await pool.query('UPDATE nv_principals SET revoked_at=now() WHERE principal_id=$1', [owner]);
    assert.strictEqual(await store.readContext(token), null, 'revocation must be resolved on the next request');
    await assert.rejects(() => store.signIn({ identity: renamed }), { code: 'WORKSPACE_SIGN_IN_REJECTED' });
    await assert.rejects(() => restarted.claim({ secret, verifyIdentity }), { code: 'WORKSPACE_SETUP_REJECTED' }, 'losing the owner must not reopen setup');
    await pool.query('UPDATE nv_principals SET revoked_at=NULL WHERE principal_id=$1', [owner]);
    await store.bindConnection({ token, identity: human(99), legacyIdentityKey: legacyKey, credential });
    await store.selectConnection({ token, workspaceId: workspace, connectionId: connection.id });
    await pool.query("UPDATE nv_workspace_sessions SET expires_at=now()-interval '1 second' WHERE session_hash=$1", [digest(token)]);
    assert.strictEqual(await store.readContext(token), null);
    await assert.rejects(() => store.executionAccount(token), { code: 'WORKSPACE_SESSION_REQUIRED' });
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 1,
      'expiry prevents credential use even before physical cleanup runs');
    await pool.query('DELETE FROM nv_workspace_sessions WHERE expires_at <= now()');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_credentials')).rows[0].n, 0);
    await store.signOut(token);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM nv_workspace_sessions')).rows[0].n, 0);
    console.log('workspace PostgreSQL tests passed (claim race, rollback, restart, isolation, revocation, legacy cleanup)');
  } finally { await pool.end(); }
};
