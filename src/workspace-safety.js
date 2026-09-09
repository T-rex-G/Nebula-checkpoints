'use strict';

const { workspaceError } = require('./workspace-identity');

function cleanSafety(value = {}) {
  return { readOnly: value.readOnly === true, freezeSync: value.freezeSync === true,
    protected: { ...(value.protected || {}) } };
}

// The caller supplies a server-resolved workspace execution key. No legacy
// cookie fallback: an unavailable safety store must stop an owner write.
function createWorkspaceSafetyStore(pool) {
  const checkKey = key => { if (!/^[a-f0-9]{64}$/.test(key)) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401); };
  return {
    async load(key) {
      checkKey(key);
      const result = await pool.query('SELECT state FROM nv_security_state WHERE identity_key=$1', [key]);
      return cleanSafety(result.rows[0]?.state);
    },
    async update(key, body) {
      checkKey(key);
      for (const field of ['readOnly', 'freezeSync']) {
        if (body[field] !== undefined && typeof body[field] !== 'boolean') throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
      }
      const protect = body.protect;
      let repo, pattern;
      if (protect !== undefined) {
        if (!protect || typeof protect !== 'object' || Array.isArray(protect)
          || Object.keys(protect).some(k => !['repo', 'path', 'on'].includes(k))
          || typeof protect.repo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(protect.repo)
          || typeof protect.path !== 'string' || (protect.on !== undefined && typeof protect.on !== 'boolean')) {
          throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
        }
        repo = protect.repo.toLowerCase();
        pattern = protect.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
        if (!pattern || pattern.length > 512 || /[\0\r\n]/.test(pattern)
          || pattern.split('/').some(p => !p || p === '.' || p === '..')) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`workspace-safety:${key}`]);
        const result = await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1 FOR UPDATE', [key]);
        const state = cleanSafety(result.rows[0]?.state);
        for (const field of ['readOnly', 'freezeSync']) if (body[field] !== undefined) state[field] = body[field];
        if (protect) {
          const patterns = new Set(state.protected[repo] || []);
          if (protect.on === false) patterns.delete(pattern); else patterns.add(pattern);
          if (patterns.size > 100) throw workspaceError('WORKSPACE_INPUT_INVALID', 413);
          if (patterns.size) state.protected[repo] = [...patterns].sort(); else delete state.protected[repo];
          if (Object.keys(state.protected).length > 30) throw workspaceError('WORKSPACE_INPUT_INVALID', 413);
        }
        await client.query(`INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2::jsonb,now())
          ON CONFLICT(identity_key) DO UPDATE SET state=EXCLUDED.state,updated=now()`, [key, JSON.stringify(state)]);
        await client.query('COMMIT');
        return state;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
  };
}

module.exports = { createWorkspaceSafetyStore };
