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

/*
 * The replay guard was typed as a Map, which is a decision about where the
 * guard lives rather than about what it has to do. A Map is per-process, so
 * the guarantee it gives -- this grant is spent -- held only for the process
 * that spent it, and a second instance would have honoured the same grant
 * again. Nothing durable could be passed in to fix that, because the type
 * check refused anything that was not a Map.
 *
 * What the guard actually needs is one operation: claim this grant, and say
 * whether this caller is the one that claimed it. Expressed that way it can be
 * a Map, a table, or anything else that can answer, and the answer means the
 * same thing in every one of them.
 *
 * The operation has to be indivisible, which is the reason the old shape could
 * not simply be widened. It read the guard at the top and wrote it at the
 * bottom with the validation in between, and that is only safe while the read
 * and the write cannot be interleaved -- true of a Map in one process, false
 * of anything that has to be asked over a connection. Two requests carrying
 * one grant would both get past the read before either wrote, and both would
 * be authorized. `consumeOnce` is one call so there is no interval to
 * interleave, and the store is the thing that makes it atomic: a table does it
 * with an insert whose conflict means "already used".
 */
const REPLAY_STORE_UNAVAILABLE = 'STEP_UP_STORE_UNAVAILABLE';

/*
 * The in-memory adapter, for the profile that runs without a database. Its
 * decision is synchronous, which is exactly what makes it atomic here: nothing
 * can run between the read and the write. It keeps the eviction the Map always
 * had -- expired entries first, then oldest -- because a bounded process-local
 * guard is the most this profile can offer, and the durable store in its own
 * task is where a guard that must never be evicted belongs.
 */
function mapReplayStore(map, maxEntries) {
  return {
    consumeOnce({ key, expiresAt, now: currentTime }) {
      const consumedUntil = Number(map.get(key) || 0);
      if (consumedUntil >= currentTime) return false;
      /* Delete before setting so a key re-claimed after its old record expired
         moves to the back of the insertion order, as it did before this was a
         separate adapter. Plain assignment keeps a key where it was, and the
         eviction below walks that order -- which would retire a live guard
         sooner than the one behind it. */
      map.delete(key);
      map.set(key, expiresAt);
      if (map.size > maxEntries) {
        for (const [id, until] of map) {
          if (Number(until) < currentTime) map.delete(id);
        }
        while (map.size > maxEntries) map.delete(map.keys().next().value);
      }
      return true;
    }
  };
}

function replayStoreFor(store, maxEntries) {
  if (store instanceof Map) return mapReplayStore(store, maxEntries);
  if (store && typeof store.consumeOnce === 'function') return store;
  throw new TypeError('The step-up replay store must be a Map or implement consumeOnce()');
}

async function consumePendingStepUp(securityState, claims, operation, { now = Date.now(), replayStore, maxReplayEntries = 5000 } = {}) {
  if (!securityState || typeof securityState !== 'object') {
    throw new TypeError('A mutable session security state is required');
  }
  const store = replayStore === undefined
    ? null
    : replayStoreFor(replayStore, Math.max(100, Number(maxReplayEntries) || 5000));
  const currentTime = Number(now);
  const grantId = String(claims && claims.jti || '');

  /*
   * Validation comes first, and nothing reaches the store until it passes. A
   * claim that names another action, another scope, or no grant at all is not
   * this session's grant, and spending a guard entry on it would let anyone
   * who can reach the route burn a grant its owner is still entitled to use.
   */
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

  if (store) {
    let claimed;
    try {
      claimed = await store.consumeOnce({
        kind: 'step-up',
        key: grantId,
        expiresAt: Math.max(Number(claims.exp || 0), Number(pending.expiresAt || 0)),
        now: currentTime
      });
    } catch (error) {
      /*
       * A guard that cannot answer has not said this grant is unspent, so the
       * only safe reading is to refuse. It is reported as unavailable rather
       * than as a replay because they are different facts: one says try again,
       * the other says this grant is finished, and telling a caller its valid
       * grant is spent because a database blinked would be a lie it cannot
       * recover from.
       */
      if (error instanceof SecurityTokenError) throw error;
      throw new SecurityTokenError(
        'Step-up authorization cannot be verified right now', REPLAY_STORE_UNAVAILABLE, 503
      );
    }
    if (!claimed) {
      throw new SecurityTokenError('Step-up authorization is missing, expired, or already used', 'STEP_UP_REPLAY');
    }
  }

  /* Only now: the grant is claimed, so clearing the pending state cannot lose
     an authorization that was never spent. */
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
  REPLAY_STORE_UNAVAILABLE,
  scopeHash
});
