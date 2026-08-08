'use strict';

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const STEP_UP_ACTIONS = new Set([
  'repository.delete',
  'branch.reset',
  'pull.merge',
  'sessions.revoke-others'
]);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

class SecurityTokenError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'SecurityTokenError';
    this.code = code;
    this.status = status;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function scopeHash(scope) {
  return crypto.createHash('sha256').update(stableJson(scope)).digest('base64url');
}

function sign(secret, encodedPayload) {
  return crypto.createHmac('sha256', String(secret)).update(encodedPayload).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createToken(secret, kind, claims, { now = Date.now(), ttlMs, nonce } = {}) {
  if (!secret || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('A secret and positive token lifetime are required');
  const issuedAt = Math.floor(Number(now));
  const payload = {
    v: TOKEN_VERSION,
    kind,
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttlMs),
    nonce: String(nonce || crypto.randomBytes(18).toString('base64url')),
    ...claims
  };
  const encoded = Buffer.from(stableJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(secret, encoded)}`;
}

function decodeToken(secret, token, expectedKind, { now = Date.now() } = {}) {
  const raw = String(token || '');
  const codePrefix = expectedKind === 'csrf' ? 'CSRF' : 'STEP_UP';
  if (!raw || raw.length > 4096) throw new SecurityTokenError(`${expectedKind} token is missing or malformed`, `${codePrefix}_INVALID`);
  const pieces = raw.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new SecurityTokenError(`${expectedKind} token is malformed`, `${codePrefix}_INVALID`);
  const [encoded, signature] = pieces;
  if (!safeEqual(signature, sign(secret, encoded))) throw new SecurityTokenError(`${expectedKind} token signature is invalid`, `${codePrefix}_INVALID`);
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new SecurityTokenError(`${expectedKind} token payload is invalid`, `${codePrefix}_INVALID`); }
  if (!payload || payload.v !== TOKEN_VERSION || payload.kind !== expectedKind || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    throw new SecurityTokenError(`${expectedKind} token claims are invalid`, `${codePrefix}_INVALID`);
  }
  if (Number(now) > payload.exp) throw new SecurityTokenError(`${expectedKind} token has expired`, `${codePrefix}_EXPIRED`);
  if (payload.iat > Number(now) + 30_000 || payload.exp <= payload.iat) {
    throw new SecurityTokenError(`${expectedKind} token timestamps are invalid`, `${codePrefix}_INVALID`);
  }
  return payload;
}

function requireContext(context, prefix) {
  const sessionBinding = String(context && context.sessionBinding || '');
  const identityKey = String(context && context.identityKey || '');
  if (!sessionBinding || !identityKey) throw new TypeError(`${prefix} requires session and identity bindings`);
  return { sessionBinding, identityKey };
}

function createCsrfToken(secret, context, options = {}) {
  const bindings = requireContext(context, 'CSRF token');
  return createToken(secret, 'csrf', bindings, { ...options, ttlMs: options.ttlMs || 30 * 60 * 1000 });
}

function verifyCsrfToken(secret, token, context, options = {}) {
  const bindings = requireContext(context, 'CSRF verification');
  const payload = decodeToken(secret, token, 'csrf', options);
  if (!safeEqual(payload.sessionBinding, bindings.sessionBinding) || !safeEqual(payload.identityKey, bindings.identityKey)) {
    throw new SecurityTokenError('CSRF token does not match the active session and identity', 'CSRF_INVALID');
  }
  return payload;
}

function cleanProvider(value) {
  const provider = String(value || 'github').toLowerCase();
  if (!['github', 'gitlab', 'gitea'].includes(provider)) throw new SecurityTokenError('Unsupported provider for step-up authorization', 'STEP_UP_SCOPE_INVALID', 400);
  return provider;
}

function cleanRepoPart(value, field) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text.length > 100 || !/^[a-z0-9_.-]+$/.test(text)) {
    throw new SecurityTokenError(`Invalid ${field} in step-up scope`, 'STEP_UP_SCOPE_INVALID', 400);
  }
  return text;
}

function cleanBranch(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 255 || /[\0-\x1f\x7f]/.test(text)) {
    throw new SecurityTokenError('Invalid branch in step-up scope', 'STEP_UP_SCOPE_INVALID', 400);
  }
  return text;
}

function cleanSha(value, required = true) {
  const text = String(value || '').trim().toLowerCase();
  if (!text && !required) return '';
  if (!/^[0-9a-f]{40}$/.test(text)) throw new SecurityTokenError('Invalid commit SHA in step-up scope', 'STEP_UP_SCOPE_INVALID', 400);
  return text;
}

function normalizeStepUpRequest(action, requestedScope, context = {}) {
  const normalizedAction = String(action || '').trim();
  if (!STEP_UP_ACTIONS.has(normalizedAction)) {
    throw new SecurityTokenError('Unsupported step-up action', 'STEP_UP_ACTION_INVALID', 400);
  }
  const source = requestedScope && typeof requestedScope === 'object' ? requestedScope : {};
  const provider = cleanProvider(context.provider);
  let scope;
  if (normalizedAction === 'repository.delete') {
    scope = { provider, owner: cleanRepoPart(source.owner, 'owner'), repo: cleanRepoPart(source.repo, 'repository') };
  } else if (normalizedAction === 'branch.reset') {
    scope = {
      provider,
      owner: cleanRepoPart(source.owner, 'owner'),
      repo: cleanRepoPart(source.repo, 'repository'),
      branch: cleanBranch(source.branch),
      targetSha: cleanSha(source.targetSha),
      expectedHeadSha: cleanSha(source.expectedHeadSha, false)
    };
  } else if (normalizedAction === 'pull.merge') {
    const pullNumber = Number(source.pullNumber);
    const method = String(source.method || 'merge').toLowerCase();
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0 || pullNumber > 2_147_483_647 || !MERGE_METHODS.has(method)) {
      throw new SecurityTokenError('Invalid pull request merge scope', 'STEP_UP_SCOPE_INVALID', 400);
    }
    scope = {
      provider,
      owner: cleanRepoPart(source.owner, 'owner'),
      repo: cleanRepoPart(source.repo, 'repository'),
      pullNumber,
      method
    };
  } else if (normalizedAction === 'sessions.revoke-others') {
    const identityKey = String(context.identityKey || '');
    if (!identityKey) throw new SecurityTokenError('Active identity is required', 'STEP_UP_SCOPE_INVALID', 400);
    scope = { provider, identityKey };
  }
  return { action: normalizedAction, scope };
}

function createStepUpGrant(secret, claims, options = {}) {
  const bindings = requireContext(claims, 'Step-up grant');
  const action = String(claims && claims.action || '');
  if (!STEP_UP_ACTIONS.has(action)) throw new SecurityTokenError('Unsupported step-up action', 'STEP_UP_ACTION_INVALID', 400);
  const assurance = String(claims && claims.assurance || '');
  if (!['credential', 'oauth-session', 'github-app'].includes(assurance)) {
    throw new SecurityTokenError('Unsupported step-up assurance', 'STEP_UP_ASSURANCE_INVALID', 400);
  }
  const jti = String(options.jti || crypto.randomUUID());
  return createToken(secret, 'step-up', {
    ...bindings,
    action,
    scopeHash: scopeHash(claims.scope || {}),
    assurance,
    jti
  }, { ...options, ttlMs: options.ttlMs || 5 * 60 * 1000 });
}

function verifyStepUpGrant(secret, token, expected, options = {}) {
  const bindings = requireContext(expected, 'Step-up verification');
  const payload = decodeToken(secret, token, 'step-up', options);
  const expectedScopeHash = scopeHash(expected.scope || {});
  if (!safeEqual(payload.sessionBinding, bindings.sessionBinding) ||
      !safeEqual(payload.identityKey, bindings.identityKey) ||
      !safeEqual(payload.action, String(expected.action || '')) ||
      !safeEqual(payload.scopeHash, expectedScopeHash)) {
    throw new SecurityTokenError('Step-up grant does not match this sensitive action', 'STEP_UP_SCOPE_MISMATCH');
  }
  if (!payload.jti || !payload.assurance) throw new SecurityTokenError('Step-up grant claims are invalid', 'STEP_UP_INVALID');
  return payload;
}

function consumePendingStepUp(securityState, claims, operation, { now = Date.now(), replayStore, maxReplayEntries = 5000 } = {}) {
  if (!securityState || typeof securityState !== 'object') {
    throw new TypeError('A mutable session security state is required');
  }
  if (replayStore !== undefined && !(replayStore instanceof Map)) {
    throw new TypeError('The step-up replay store must be a Map');
  }
  const currentTime = Number(now);
  const grantId = String(claims && claims.jti || '');
  if (replayStore) {
    const consumedUntil = Number(replayStore.get(grantId) || 0);
    if (consumedUntil >= currentTime) {
      throw new SecurityTokenError('Step-up authorization is missing, expired, or already used', 'STEP_UP_REPLAY');
    }
    if (consumedUntil) replayStore.delete(grantId);
  }
  const pending = securityState.stepUp;
  const expectedScopeHash = scopeHash(operation && operation.scope || {});
  const valid = pending && grantId &&
    safeEqual(pending.jti, grantId) &&
    safeEqual(pending.action, operation && operation.action) &&
    safeEqual(pending.scopeHash, expectedScopeHash) &&
    Number(pending.expiresAt || 0) >= currentTime;
  if (!valid) {
    throw new SecurityTokenError('Step-up authorization is missing, expired, or already used', 'STEP_UP_REPLAY');
  }
  if (replayStore) {
    replayStore.set(grantId, Math.max(Number(claims.exp || 0), Number(pending.expiresAt || 0)));
    if (replayStore.size > Math.max(100, Number(maxReplayEntries) || 5000)) {
      for (const [id, expiresAt] of replayStore) {
        if (Number(expiresAt) < currentTime) replayStore.delete(id);
      }
      while (replayStore.size > Math.max(100, Number(maxReplayEntries) || 5000)) {
        replayStore.delete(replayStore.keys().next().value);
      }
    }
  }
  securityState.stepUp = null;
  return {
    action: operation.action,
    assurance: claims.assurance,
    authorizedAt: claims.iat
  };
}

function sensitiveOperationFor(request = {}) {
  const method = String(request.method || '').toUpperCase();
  const path = String(request.path || '');
  const params = request.params || {};
  const body = request.body || {};
  const context = { provider: request.provider, identityKey: request.identityKey };

  if (method === 'DELETE' && /^\/api\/repo\/[^/]+\/[^/]+$/.test(path)) {
    return normalizeStepUpRequest('repository.delete', { owner: params.owner, repo: params.repo }, context);
  }
  if (method === 'POST' && /^\/api\/repo\/[^/]+\/[^/]+\/reset$/.test(path)) {
    return normalizeStepUpRequest('branch.reset', {
      owner: params.owner, repo: params.repo, branch: body.branch,
      targetSha: body.sha, expectedHeadSha: body.expectedHeadSha
    }, context);
  }
  if (method === 'PUT' && /^\/api\/repo\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(path)) {
    return normalizeStepUpRequest('pull.merge', {
      owner: params.owner, repo: params.repo, pullNumber: params.num, method: body.method
    }, context);
  }
  if (method === 'POST' && (path === '/api/security/revoke-others' || /^\/api\/repo\/[^/]+\/[^/]+\/emergency-manifest$/.test(path))) {
    return normalizeStepUpRequest('sessions.revoke-others', {}, context);
  }
  return null;
}

module.exports = Object.freeze({
  SecurityTokenError,
  createCsrfToken,
  verifyCsrfToken,
  createStepUpGrant,
  verifyStepUpGrant,
  normalizeStepUpRequest,
  sensitiveOperationFor,
  consumePendingStepUp,
  scopeHash
});
