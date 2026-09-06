'use strict';

const crypto = require('crypto');

function workspaceError(code, status = 403) {
  return Object.assign(new Error('Workspace access could not be established'), { code, status });
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Only call with an account obtained from a fresh, server-side /user request.
// This is deliberately a new namespace; legacy safety/evidence keys stay intact.
function verifiedHumanIdentity(account = {}) {
  const provider = account.provider || 'github';
  const id = account.providerAccountId;
  if (!['github', 'gitlab', 'gitea'].includes(provider)
    || !Number.isSafeInteger(id) || id <= 0 || account.authMethod === 'github-app'
    || account.bot === true || (account.type && account.type !== 'User')) {
    throw workspaceError('WORKSPACE_HUMAN_IDENTITY_REQUIRED', 401);
  }
  let instance;
  try {
    const url = new URL(provider === 'github' ? 'https://github.com'
      : account.baseUrl || (provider === 'gitlab' ? 'https://gitlab.com' : ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    instance = url.origin + url.pathname.replace(/\/+$/, '');
  } catch { throw workspaceError('WORKSPACE_HUMAN_IDENTITY_REQUIRED', 401); }
  const providerUserId = String(id);
  return Object.freeze({
    provider, instance, providerUserId,
    key: digest(JSON.stringify(['nv-workspace-human/v1', provider, instance, providerUserId])),
    login: String(account.login || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200)
  });
}

function loadWorkspaceConfig(env = {}, { databaseUrl = '' } = {}) {
  const enabled = String(env.NV_WORKSPACE_FOUNDATION_ENABLED || '0').trim();
  if (!['0', '1'].includes(enabled)) throw new Error('NV_WORKSPACE_FOUNDATION_ENABLED must be 0 or 1');
  const setupDigest = String(env.NV_WORKSPACE_SETUP_SHA256 || '').trim();
  const expiry = String(env.NV_WORKSPACE_SETUP_EXPIRES_AT || '').trim();
  if (!!setupDigest !== !!expiry) throw new Error('Workspace setup verifier and expiry must be configured together');
  if (setupDigest && !/^[a-f0-9]{64}$/.test(setupDigest)) throw new Error('NV_WORKSPACE_SETUP_SHA256 must be a SHA-256 digest');
  if (expiry && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expiry) || !Number.isFinite(Date.parse(expiry)))) {
    throw new Error('NV_WORKSPACE_SETUP_EXPIRES_AT must be an absolute UTC timestamp');
  }
  if (enabled === '1' && !databaseUrl) throw new Error('Workspace foundation requires DATABASE_URL');
  return Object.freeze({ enabled: enabled === '1', setupDigest, setupExpiresAt: expiry ? Date.parse(expiry) : 0 });
}

function verifySetupSecret(config, secret, now = Date.now()) {
  if (!config.setupDigest || now >= config.setupExpiresAt || !/^[A-Za-z0-9_-]{43,128}$/.test(String(secret || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(config.setupDigest, 'hex'));
}

module.exports = { digest, workspaceError, verifiedHumanIdentity, loadWorkspaceConfig, verifySetupSecret };
