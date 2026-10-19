'use strict';

const crypto = require('crypto');
const { normalizePolicyScope } = require('./governance-model');

/* The snapshot's shape and its guard are the actor contract; this module resolves one from the provider. */
const actor = require('../packages/contracts/src/actor.ts');
const { isPlainObject } = require('../packages/contracts/src/guards.ts');

const { ACCESS_LEVEL_BY_ROLE, AUTHORIZATION_SCHEMA_VERSION, GOVERNANCE_ROLE_NAMES, rolesForLevel } = actor;
const AUTH_METHODS = new Set(actor.AUTH_METHODS);
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

class AuthorizationResolverError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'AuthorizationResolverError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status = 400) {
  throw new AuthorizationResolverError(message, code, status);
}

function normalizeText(value, label, max = 200, allowEmpty = false) {
  return actor.normalizeAuthorizationText(value, label, max, allowEmpty, fail);
}

function normalizeIdentityKey(value, label) {
  return actor.normalizeAuthorizationIdentityKey(value, label, fail);
}

/* A malformed snapshot is an AuthorizationResolverError; a malformed scope inside it stays governance's own. */
function normalizeAuthorizationSnapshot(input) {
  return actor.normalizeAuthorizationSnapshot(input, { refuse: fail, normalizeScope: normalizePolicyScope });
}

function hashIdentity(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeAccountContext(account, actorIdentityKey, scope) {
  if (!isPlainObject(account)) fail('Provider account is required', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  const provider = String(account.provider || 'github').trim().toLowerCase();
  if (provider !== scope.provider) fail('Provider account does not match the authorization scope', 'AUTHORIZATION_SCOPE_INVALID');
  const login = normalizeText(account.login, 'Provider login');
  const authMethod = String(account.authMethod || 'token').trim();
  if (!AUTH_METHODS.has(authMethod)) fail('Provider authentication method is invalid', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  const requestIdentityKey = normalizeIdentityKey(actorIdentityKey, 'Request identity');
  if (authMethod !== 'github-app') {
    return {
      executionPrincipal: { kind: 'user', identityKey: requestIdentityKey, login, authMethod },
      governanceActor: { kind: 'human', identityKey: requestIdentityKey, login, verified: false },
      installationCapabilities: null,
      cacheIdentity: requestIdentityKey
    };
  }
  if (provider !== 'github') fail('GitHub App authentication is only valid for GitHub', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  const installationId = Number(account.installationId);
  const installationAccountId = Number(account.installationAccountId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0 ||
      !Number.isSafeInteger(installationAccountId) || installationAccountId <= 0) {
    fail('GitHub App installation identity is invalid', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  }
  const governanceIdentityKey = normalizeIdentityKey(account.authorizedByIdentityKey, 'GitHub App authorizer identity');
  const governanceLogin = normalizeText(account.authorizedByLogin, 'GitHub App authorizer login');
  const executionIdentityKey = hashIdentity({
    provider: 'github', authority: scope.authority, authMethod: 'github-app',
    installationId, installationAccountId, login: login.toLowerCase()
  });
  return {
    executionPrincipal: {
      kind: 'installation', identityKey: executionIdentityKey, login,
      authMethod: 'github-app', installationId
    },
    governanceActor: {
      kind: 'human', identityKey: governanceIdentityKey, login: governanceLogin, verified: false
    },
    installationCapabilities: null,
    cacheIdentity: `${executionIdentityKey}:${governanceIdentityKey}`
  };
}

function emptyRoles() {
  return { reader: false, author: false, reviewer: false, activator: false, administrator: false };
}

function emptyAccess(source = 'provider.permission.unavailable') {
  return { baseRole: 'none', providerRole: 'unknown', level: ACCESS_LEVEL_BY_ROLE.none, source, complete: false };
}

function evidenceTimes(now, ttlMs) {
  const fetchedMs = Number(now());
  if (!Number.isFinite(fetchedMs)) fail('Authorization clock is invalid', 'AUTHORIZATION_CONFIGURATION_INVALID', 500);
  return {
    fetchedAt: new Date(fetchedMs).toISOString(),
    expiresAt: new Date(fetchedMs + ttlMs).toISOString()
  };
}

function unavailableFromContext(context, scope, reasonCode, now, ttlMs, status = 'unavailable', installationCapabilities = null) {
  const times = evidenceTimes(now, ttlMs);
  const boundedCapabilities = context.executionPrincipal.kind === 'installation'
    ? (installationCapabilities || { repositorySelected: false, repositorySelection: 'selected', permissions: {} })
    : null;
  return normalizeAuthorizationSnapshot({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    scope,
    executionPrincipal: context.executionPrincipal,
    governanceActor: { ...context.governanceActor, verified: false },
    repositoryAccess: emptyAccess(),
    governanceRoles: emptyRoles(),
    installationCapabilities: boundedCapabilities,
    evidence: { status, ...times, reasonCode }
  });
}

function createUnavailableAuthorizationSnapshot(input = {}) {
  const scope = normalizePolicyScope({
    provider: input.account && input.account.provider || input.provider,
    baseUrl: input.account && input.account.baseUrl || input.baseUrl,
    owner: input.owner,
    repo: input.repo
  });
  const context = normalizeAccountContext(input.account, input.actorIdentityKey, scope);
  const ttlMs = Number.isFinite(Number(input.ttlMs)) && Number(input.ttlMs) > 0 ? Number(input.ttlMs) : DEFAULT_CACHE_TTL_MS;
  const now = typeof input.now === 'function' ? input.now : Date.now;
  let installationCapabilities = null;
  if (context.executionPrincipal.kind === 'installation' && isPlainObject(input.account.installation)) {
    const installation = input.account.installation;
    installationCapabilities = {
      repositorySelected: false,
      repositorySelection: installation.repositorySelection === 'all' ? 'all' : 'selected',
      permissions: sanitizeProviderPermissions(installation.permissions)
    };
  }
  return unavailableFromContext(
    context,
    scope,
    normalizeText(input.reasonCode || 'AUTHORIZATION_EVIDENCE_UNAVAILABLE', 'Authorization reason code', 120),
    now,
    ttlMs,
    input.status === 'partial' ? 'partial' : 'unavailable',
    installationCapabilities
  );
}

function sanitizeProviderRole(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text.length > 120 || !/^[a-z0-9._ -]+$/.test(text)) return 'unknown';
  return text;
}

function githubAccess(response, expectedLogin, source) {
  if (!isPlainObject(response)) return null;
  const permission = String(response.permission || '').trim().toLowerCase();
  const role = sanitizeProviderRole(response.role_name || permission);
  const returnedLogin = String(response.user && response.user.login || '').trim().toLowerCase();
  if (!['admin', 'write', 'read', 'none'].includes(permission) || returnedLogin !== expectedLogin.toLowerCase()) return null;
  const access = (baseRole, providerRole) => ({ baseRole, providerRole, level: ACCESS_LEVEL_BY_ROLE[baseRole], source, complete: true });
  if (permission === 'admin') return access('admin', role);
  if (permission === 'write') return access(role === 'maintain' ? 'maintain' : 'write', role);
  if (permission === 'read') return access(role === 'triage' ? 'triage' : 'read', role);
  return access('none', role === 'unknown' ? 'none' : role);
}

/*
 * Read access by virtue of the repository being public, not of membership.
 * It is the reader level every signed-in person has on a public repository,
 * and its source says so: work that belongs to the reader alone -- their own
 * audits and scans of it -- may accept it, while anything the repository's
 * collaborators share (its governance) refuses it, because being able to read
 * a public repository makes nobody a collaborator on it.
 */
const PUBLIC_ACCESS_SOURCES = Object.freeze(['github.repository.public']);
function publicRepositoryAccess(repository, scope) {
  if (!isPlainObject(repository)) return null;
  const expected = `${scope.owner}/${scope.repo}`.toLowerCase();
  const name = String(repository.full_name || '').trim().toLowerCase();
  const visibility = repository.visibility == null ? (repository.private === false ? 'public' : '') : String(repository.visibility).toLowerCase();
  if (repository.private !== false || repository.internal === true || visibility !== 'public' || name !== expected) return null;
  return { baseRole: 'read', providerRole: 'public', level: ACCESS_LEVEL_BY_ROLE.read, source: 'github.repository.public', complete: true };
}
function isPublicReaderAccess(snapshot) {
  return Boolean(snapshot && snapshot.repositoryAccess && PUBLIC_ACCESS_SOURCES.includes(snapshot.repositoryAccess.source));
}

function sanitizeProviderPermissions(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const permission = String(value[key] || '');
    if (!actor.isSensitiveAuthorizationKey(key) && /^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(permission)) out[key] = permission;
  }
  return out;
}

function reasonFromError(error) {
  const status = Number(error && error.status);
  if (status === 401) return 'AUTHORIZATION_PROVIDER_UNAUTHENTICATED';
  if (status === 403) return 'AUTHORIZATION_PROVIDER_FORBIDDEN';
  if (status === 404) return 'AUTHORIZATION_SCOPE_NOT_FOUND';
  if (status === 429) return 'AUTHORIZATION_PROVIDER_RATE_LIMITED';
  if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) return 'AUTHORIZATION_PROVIDER_TIMEOUT';
  return 'AUTHORIZATION_PROVIDER_UNAVAILABLE';
}

function createResolvedSnapshot({ scope, context, access, now, ttlMs, installationCapabilities = null }) {
  const times = evidenceTimes(now, ttlMs);
  return normalizeAuthorizationSnapshot({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    scope,
    executionPrincipal: context.executionPrincipal,
    governanceActor: { ...context.governanceActor, verified: true },
    repositoryAccess: access,
    governanceRoles: rolesForLevel(access.level),
    installationCapabilities,
    evidence: { status: 'resolved', ...times, reasonCode: null }
  });
}

function createAuthorizationResolver(options = {}) {
  if (typeof options.request !== 'function') throw new TypeError('Authorization resolver request dependency is required');
  const request = options.request;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cacheTtlMs = Number.isFinite(Number(options.cacheTtlMs)) && Number(options.cacheTtlMs) > 0
    ? Math.min(Number(options.cacheTtlMs), 5 * 60 * 1000)
    : DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isSafeInteger(Number(options.maxEntries)) && Number(options.maxEntries) > 0
    ? Math.min(Number(options.maxEntries), 2000)
    : DEFAULT_MAX_ENTRIES;
  const cache = new Map();
  const inFlight = new Map();

  function cacheKey(scope, context, authMethod) {
    return `${scope.scopeKey}:${authMethod}:${context.cacheIdentity}`;
  }

  function remember(key, snapshot) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { snapshot, expiresAt: new Date(snapshot.evidence.expiresAt).getTime() });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  async function resolveFresh(account, scope, context) {
    try {
      if (context.executionPrincipal.kind === 'installation') {
        const installation = account.installation;
        if (!isPlainObject(installation) || Number(installation.id) !== context.executionPrincipal.installationId ||
            String(installation.account && installation.account.login || '').trim().toLowerCase() !== String(account.login).trim().toLowerCase() ||
            Number(installation.account && installation.account.id) !== Number(account.installationAccountId)) {
          return unavailableFromContext(context, scope, 'AUTHORIZATION_INSTALLATION_EVIDENCE_UNAVAILABLE', now, cacheTtlMs);
        }
        const capabilities = {
          repositorySelected: false,
          repositorySelection: installation.repositorySelection === 'all' ? 'all' : 'selected',
          permissions: sanitizeProviderPermissions(installation.permissions)
        };
        const repoPath = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
        const repository = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: repoPath });
        const fullName = String(repository && repository.full_name || '').trim().toLowerCase();
        if (fullName !== `${scope.owner}/${scope.repo}`.toLowerCase()) {
          return unavailableFromContext(context, scope, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE', now, cacheTtlMs, 'partial', capabilities);
        }
        capabilities.repositorySelected = true;
        const permissionPath = `${repoPath}/collaborators/${encodeURIComponent(context.governanceActor.login)}/permission`;
        const permission = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: permissionPath });
        const access = githubAccess(permission, context.governanceActor.login, 'github.collaborator.permission');
        if (!access) return unavailableFromContext(context, scope, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE', now, cacheTtlMs, 'partial', capabilities);
        return createResolvedSnapshot({ scope, context, access, now, ttlMs: cacheTtlMs, installationCapabilities: capabilities });
      }

      const repoPath = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
      const permissionPath = `${repoPath}/collaborators/${encodeURIComponent(context.governanceActor.login)}/permission`;
      let permission;
      try {
        permission = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: permissionPath });
      } catch (error) {
        /*
         * GitHub answers this question only to people who can push. Anyone
         * else reading a public repository is refused here, so the repository
         * itself is asked whether it is public; if it is, the answer is the
         * reader access everyone has, marked as such.
         */
        if (Number(error && error.status) !== 403) throw error;
        const repository = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: repoPath }).catch(() => null);
        const access = publicRepositoryAccess(repository, scope);
        if (!access) throw error;
        return createResolvedSnapshot({ scope, context, access, now, ttlMs: cacheTtlMs });
      }
      const source = 'github.collaborator.permission';
      const access = githubAccess(permission, context.governanceActor.login, source);
      if (!access) return unavailableFromContext(context, scope, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE', now, cacheTtlMs, 'partial');
      return createResolvedSnapshot({ scope, context, access, now, ttlMs: cacheTtlMs });
    } catch (error) {
      let capabilities = null;
      if (context.executionPrincipal.kind === 'installation' && isPlainObject(account.installation)) {
        capabilities = {
          repositorySelected: false,
          repositorySelection: account.installation.repositorySelection === 'all' ? 'all' : 'selected',
          permissions: sanitizeProviderPermissions(account.installation.permissions)
        };
      }
      return unavailableFromContext(context, scope, reasonFromError(error), now, cacheTtlMs, 'unavailable', capabilities);
    }
  }

  async function resolve(input = {}) {
    const account = input.account;
    const scope = normalizePolicyScope({
      provider: account && account.provider,
      baseUrl: account && account.baseUrl,
      owner: input.owner,
      repo: input.repo
    });
    const context = normalizeAccountContext(account, input.actorIdentityKey, scope);
    const key = cacheKey(scope, context, String(account.authMethod || 'token'));
    const currentTime = Number(now());
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.snapshot;
    if (cached) cache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = resolveFresh(account, scope, context)
      .then(snapshot => {
        remember(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }

  return Object.freeze({ resolve, cacheSize: () => cache.size });
}

module.exports = Object.freeze({
  AuthorizationResolverError,
  AUTHORIZATION_SCHEMA_VERSION,
  GOVERNANCE_ROLE_NAMES,
  normalizeAuthorizationSnapshot,
  createUnavailableAuthorizationSnapshot,
  createAuthorizationResolver,
  PUBLIC_ACCESS_SOURCES,
  isPublicReaderAccess
});
