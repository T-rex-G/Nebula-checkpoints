'use strict';

const { alphaActorLabel } = require('./alpha-privacy');

/* Resolve the durable owner, not a display label. Hosted scans must still have
   an active invitation, repository scope and provider-session ownership. */
async function resolveExposureSession(input, dependencies) {
  const { scope, scanId, requestedBy } = input;
  const {
    pool, unseal, identityKey, providerAuthority, resolveAccount,
    alphaEnabled, readAlphaSession, readOwnedSession, repositoryAllowed
  } = dependencies;
  const owned = await pool.query(
    `SELECT identity_key FROM nv_exposure_scans
      WHERE scan_id=$1 AND provider=$2 AND authority=$3 AND owner_login=$4 AND repo_name=$5`,
    [scanId, scope.provider, scope.authority, scope.owner, scope.repo]
  );
  const key = owned.rows[0] && owned.rows[0].identity_key;
  if (!key) return null;
  const alpha = String(requestedBy).startsWith('alpha:');
  if (alphaEnabled && !alpha) return null;
  const rows = await pool.query(
    `SELECT sid, data, session_key_hash FROM nv_sessions
      WHERE $1 = ANY(identity_keys) ORDER BY updated DESC LIMIT 10`, [key]
  );
  for (const row of rows.rows) {
    let content;
    if (alpha) {
      const owners = await pool.query(
        `SELECT ownership.tester_id, access.session_id
           FROM nv_alpha_provider_session_ownership ownership
           JOIN nv_alpha_provider_bindings binding USING (tester_id, identity_key, provider)
           JOIN nv_alpha_sessions access USING (tester_id)
          WHERE ownership.session_key_hash=$1 AND ownership.identity_key=$2
            AND ownership.provider=$3 AND binding.authority=$4
            AND ownership.released_at IS NULL AND binding.disconnected_at IS NULL
            AND access.revoked_at IS NULL AND access.expires_at > now()
          ORDER BY access.last_seen_at DESC LIMIT 10`,
        [row.session_key_hash, key, scope.provider, scope.authority]
      );
      for (const owner of owners.rows) {
        if (alphaActorLabel({ testerId: owner.tester_id }) !== requestedBy) continue;
        try {
          const access = await readAlphaSession(owner.session_id);
          if (access.testerId !== owner.tester_id || !repositoryAllowed(access, scope)) continue;
          content = (await readOwnedSession({ testerId: owner.tester_id, sessionId: row.sid })).session;
          break;
        } catch { /* Expired, revoked or disconnected sessions cannot authorize a read. */ }
      }
    } else {
      try { content = unseal(row.data); } catch { continue; }
    }
    for (const account of (content && Array.isArray(content.accounts) ? content.accounts : [])) {
      if (!account || identityKey(account) !== key || (account.provider || 'github') !== scope.provider
        || providerAuthority(account) !== scope.authority) continue;
      if (!alpha && String(account.login || '') !== requestedBy) continue;
      try { return await resolveAccount(account); } catch { /* Try another currently owned session. */ }
    }
  }
  return null;
}

module.exports = { resolveExposureSession };
