'use strict';

const crypto = require('crypto');
const { digest, workspaceError, verifySetupSecret } = require('./workspace-identity');
const { sealWorkspaceCredential, openWorkspaceCredential } = require('./workspace-credentials');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_RX = /^[A-Za-z0-9_-]{43}$/;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTEXT_SQL = `SELECT s.principal_id, s.workspace_id, s.connection_id,
  c.provider, c.instance, c.provider_user_id, c.login
  FROM nv_workspace_sessions s
  JOIN nv_principals p ON p.principal_id=s.principal_id AND p.revoked_at IS NULL
  JOIN nv_workspaces w ON w.workspace_id=s.workspace_id
    AND w.owner_principal_id=p.principal_id AND w.revoked_at IS NULL
  LEFT JOIN nv_workspace_connections c ON c.connection_id=s.connection_id
    AND c.principal_id=s.principal_id AND c.workspace_id=s.workspace_id
  WHERE s.session_hash=$1 AND s.expires_at > now()
    AND (s.connection_id IS NULL OR (c.connection_id IS NOT NULL AND c.revoked_at IS NULL))`;

function projectContext(row) {
  if (!row) return null;
  return {
    principalId: row.principal_id, workspaceId: row.workspace_id, role: 'owner',
    connection: row.connection_id ? {
      id: row.connection_id, provider: row.provider, instance: row.instance,
      providerUserId: row.provider_user_id, login: row.login
    } : null
  };
}

class WorkspaceStore {
  constructor({ pool, config, seal, unseal }) {
    this.pool = pool; this.config = config; this.seal = seal; this.unseal = unseal;
  }

  async transaction(run) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async readContext(token, client = this.pool, lock = false) {
    if (!TOKEN_RX.test(String(token || ''))) return null;
    const result = await client.query(CONTEXT_SQL + (lock ? ' FOR UPDATE OF s, p, w' : ''), [digest(token)]);
    return projectContext(result.rows[0]);
  }

  async requireContext(token, client) {
    const context = await this.readContext(token, client, true);
    if (!context) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
    return context;
  }

  async newSession(client, principalId, workspaceId, previousToken) {
    if (TOKEN_RX.test(String(previousToken || ''))) {
      await client.query('DELETE FROM nv_workspace_sessions WHERE session_hash=$1 AND principal_id=$2', [digest(previousToken), principalId]);
    }
    await client.query('DELETE FROM nv_workspace_sessions WHERE principal_id=$1 AND expires_at <= now()', [principalId]);
    const count = await client.query('SELECT count(*)::int AS n FROM nv_workspace_sessions WHERE principal_id=$1', [principalId]);
    if (count.rows[0].n >= 10) throw workspaceError('WORKSPACE_SESSION_LIMIT', 429);
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO nv_workspace_sessions(session_hash, principal_id, workspace_id, expires_at)
      VALUES($1,$2,$3,now() + $4 * interval '1 millisecond')`, [digest(token), principalId, workspaceId, SESSION_TTL_MS]);
    return { token, context: await this.readContext(token, client) };
  }

  async claim({ secret, verifyIdentity }) {
    const result = await this.transaction(async client => {
      const { rows } = await client.query('SELECT * FROM nv_workspace_bootstrap WHERE singleton=true FOR UPDATE');
      const state = rows[0];
      if (!state || state.claimed_workspace_id || (state.locked_until && new Date(state.locked_until).getTime() > Date.now())) {
        return { rejected: true };
      }
      if (!verifySetupSecret(this.config, secret)) {
        const attempts = state.locked_until ? 1 : state.failed_attempts + 1;
        await client.query(`UPDATE nv_workspace_bootstrap SET failed_attempts=$1,
          locked_until=CASE WHEN $1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE singleton=true`, [attempts]);
        return { rejected: true }; // Commit failed attempts before returning a generic rejection.
      }
      // Verification is server-owned and bounded by the existing provider timeout.
      // Holding this one-time lock ensures a competitor cannot create a second owner.
      const identity = await verifyIdentity();
      if (!verifySetupSecret(this.config, secret)) return { rejected: true };
      const principalId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
      await client.query('INSERT INTO nv_principals(principal_id) VALUES($1)', [principalId]);
      await client.query(`INSERT INTO nv_login_identities(provider, instance, provider_user_id, principal_id, login)
        VALUES($1,$2,$3,$4,$5)`, [identity.provider, identity.instance, identity.providerUserId, principalId, identity.login]);
      await client.query('INSERT INTO nv_workspaces(workspace_id, owner_principal_id) VALUES($1,$2)', [workspaceId, principalId]);
      await client.query('UPDATE nv_workspace_bootstrap SET claimed_workspace_id=$1, claimed_at=now() WHERE singleton=true', [workspaceId]);
      return this.newSession(client, principalId, workspaceId);
    });
    if (result.rejected) throw workspaceError('WORKSPACE_SETUP_REJECTED');
    return result;
  }

  async signIn({ identity, previousToken }) {
    return this.transaction(async client => {
      const result = await client.query(`SELECT p.principal_id, w.workspace_id
        FROM nv_login_identities i JOIN nv_principals p ON p.principal_id=i.principal_id
        JOIN nv_workspaces w ON w.owner_principal_id=p.principal_id
        WHERE i.provider=$1 AND i.instance=$2 AND i.provider_user_id=$3
          AND p.revoked_at IS NULL AND w.revoked_at IS NULL
        ORDER BY w.created_at, w.workspace_id LIMIT 1 FOR UPDATE OF p, w`,
      [identity.provider, identity.instance, identity.providerUserId]);
      const row = result.rows[0];
      if (!row) throw workspaceError('WORKSPACE_SIGN_IN_REJECTED', 401);
      const previous = await this.readContext(previousToken, client);
      if (previous && previous.principalId !== row.principal_id) throw workspaceError('WORKSPACE_SIGN_OUT_REQUIRED');
      await client.query(`UPDATE nv_login_identities SET login=$4
        WHERE provider=$1 AND instance=$2 AND provider_user_id=$3`, [identity.provider, identity.instance, identity.providerUserId, identity.login]);
      return this.newSession(client, row.principal_id, row.workspace_id, previousToken);
    });
  }

  async listConnections(token) {
    return this.transaction(async client => {
      const context = await this.requireContext(token, client);
      const result = await client.query(`SELECT c.connection_id, c.provider, c.instance, c.provider_user_id, c.login,
        EXISTS(SELECT 1 FROM nv_workspace_credentials k WHERE k.session_hash=$3 AND k.connection_id=c.connection_id
          AND k.workspace_id=c.workspace_id AND k.principal_id=c.principal_id) AS credential_ready
        FROM nv_workspace_connections c WHERE c.workspace_id=$1 AND c.principal_id=$2 AND c.revoked_at IS NULL
        ORDER BY c.verified_at DESC, c.connection_id LIMIT 20`, [context.workspaceId, context.principalId, digest(token)]);
      return result.rows.map(row => ({ id: row.connection_id, provider: row.provider, instance: row.instance,
        providerUserId: row.provider_user_id, login: row.login, credentialStored: row.credential_ready,
        selected: context.connection?.id === row.connection_id }));
    });
  }

  async executionAccount(token) {
    return this.transaction(async client => {
      const context = await this.requireContext(token, client);
      if (!context.connection) throw workspaceError('WORKSPACE_CONNECTION_REQUIRED', 409);
      const result = await client.query(`SELECT sealed_credential FROM nv_workspace_credentials
        WHERE session_hash=$1 AND connection_id=$2 AND workspace_id=$3 AND principal_id=$4`,
      [digest(token), context.connection.id, context.workspaceId, context.principalId]);
      if (!result.rows.length) throw workspaceError('WORKSPACE_CREDENTIAL_REQUIRED', 401);
      return openWorkspaceCredential(result.rows[0].sealed_credential,
        { ...context, sessionHash: digest(token) }, this.unseal);
    });
  }

  async bindConnection({ token, identity, legacyIdentityKey, credential }) {
    if (!/^[0-9a-f]{64}$/.test(String(legacyIdentityKey || ''))) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
    return this.transaction(async client => {
      const context = await this.requireContext(token, client);
      const existing = await client.query(`SELECT connection_id, revoked_at FROM nv_workspace_connections
        WHERE workspace_id=$1 AND principal_id=$2 AND provider=$3 AND instance=$4 AND provider_user_id=$5 FOR UPDATE`,
      [context.workspaceId, context.principalId, identity.provider, identity.instance, identity.providerUserId]);
      if (!existing.rows.length) {
        const count = await client.query('SELECT count(*)::int AS n FROM nv_workspace_connections WHERE workspace_id=$1 AND principal_id=$2', [context.workspaceId, context.principalId]);
        if (count.rows[0].n >= 20) throw workspaceError('WORKSPACE_CONNECTION_LIMIT', 429);
      }
      if (existing.rows[0]?.revoked_at) {
        // Out-of-band revocation may leave credential rows behind. Reactivation
        // must never resurrect those tokens, even for a metadata-only bind.
        await client.query('DELETE FROM nv_workspace_credentials WHERE connection_id=$1 AND workspace_id=$2 AND principal_id=$3',
          [existing.rows[0].connection_id, context.workspaceId, context.principalId]);
      }
      const result = await client.query(`INSERT INTO nv_workspace_connections
        (connection_id, workspace_id, principal_id, provider, instance, provider_user_id, login, legacy_identity_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (workspace_id, principal_id, provider, instance, provider_user_id)
        DO UPDATE SET login=EXCLUDED.login, legacy_identity_key=EXCLUDED.legacy_identity_key, verified_at=now(), revoked_at=NULL
        RETURNING connection_id`, [crypto.randomUUID(), context.workspaceId, context.principalId, identity.provider,
        identity.instance, identity.providerUserId, identity.login, legacyIdentityKey]);
      const id = result.rows[0].connection_id;
      if (credential) {
        const sealed = sealWorkspaceCredential(credential, {
          ...context, sessionHash: digest(token), connection: { ...identity, id }
        }, this.seal);
        // Binding and credential replacement are one transaction. A failed seal
        // or insert cannot leave behind a partially reconnected account.
        await client.query(`INSERT INTO nv_workspace_credentials
          (session_hash, connection_id, workspace_id, principal_id, sealed_credential) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (session_hash, connection_id) DO UPDATE
          SET sealed_credential=EXCLUDED.sealed_credential, updated_at=now()`,
        [digest(token), id, context.workspaceId, context.principalId, sealed]);
      }
      return { id };
    });
  }

  async selectConnection({ token, workspaceId, connectionId }) {
    if (!UUID_RX.test(String(workspaceId || '')) || !UUID_RX.test(String(connectionId || ''))) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
    return this.transaction(async client => {
      const context = await this.requireContext(token, client);
      if (workspaceId !== context.workspaceId) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
      const result = await client.query(`UPDATE nv_workspace_sessions s SET connection_id=c.connection_id
        FROM nv_workspace_connections c WHERE s.session_hash=$1 AND c.connection_id=$2
          AND c.workspace_id=s.workspace_id AND c.principal_id=s.principal_id AND c.revoked_at IS NULL
        RETURNING s.session_hash`, [digest(token), connectionId]);
      if (!result.rows.length) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
      return this.readContext(token, client);
    });
  }

  async disconnectConnection({ token, connectionId }) {
    if (!UUID_RX.test(String(connectionId || ''))) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
    return this.transaction(async client => {
      const context = await this.requireContext(token, client);
      const result = await client.query(`UPDATE nv_workspace_connections SET revoked_at=now()
        WHERE connection_id=$1 AND workspace_id=$2 AND principal_id=$3 RETURNING connection_id`,
      [connectionId, context.workspaceId, context.principalId]);
      if (!result.rows.length) throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
      await client.query('DELETE FROM nv_workspace_credentials WHERE connection_id=$1 AND workspace_id=$2 AND principal_id=$3',
        [connectionId, context.workspaceId, context.principalId]);
      await client.query('UPDATE nv_workspace_sessions SET connection_id=NULL WHERE connection_id=$1 AND workspace_id=$2 AND principal_id=$3',
        [connectionId, context.workspaceId, context.principalId]);
    });
  }

  async signOut(token) {
    if (TOKEN_RX.test(String(token || ''))) await this.pool.query('DELETE FROM nv_workspace_sessions WHERE session_hash=$1', [digest(token)]);
  }
}

module.exports = { WorkspaceStore, SESSION_TTL_MS };
