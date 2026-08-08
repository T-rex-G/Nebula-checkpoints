'use strict';

const crypto = require('crypto');
const { normalizePolicyScope } = require('./governance-model');

const AUTHORIZATION_SCHEMA_VERSION = 1;
const GOVERNANCE_ROLE_NAMES = Object.freeze([
  'reader', 'author', 'reviewer', 'activator', 'administrator'
]);
const AUTH_METHODS = new Set(['token', 'oauth', 'github-app']);
const EVIDENCE_STATUSES = new Set(['resolved', 'partial', 'unavailable']);
const BASE_ROLES = new Set(['none', 'read', 'triage', 'write', 'maintain', 'admin']);
const ACCESS_LEVEL_BY_ROLE = Object.freeze({ none: 0, read: 10, triage: 20, write: 30, maintain: 40, admin: 50 });
const ACCESS_LEVELS = new Set(Object.values(ACCESS_LEVEL_BY_ROLE));
const SENSITIVE_KEY_RX = /(?:accesstoken|refreshtoken|token|secret|password|privatekey|authorization|cookie)/i;
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sensitiveKey(key) {
  return SENSITIVE_KEY_RX.test(String(key || '').replace(/[^a-z0-9]/gi, ''));
}

function cloneCredentialFree(value, path = '$', depth = 0) {
  if (depth > 8) fail(`${path} exceeds the authorization depth limit`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /\0/.test(value)) fail(`${path} contains invalid text`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail(`${path} contains too many items`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    return value.map((entry, index) => cloneCredentialFree(entry, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) fail(`${path} contains a non-JSON value`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  const keys = Object.keys(value);
  if (keys.length > 80) fail(`${path} contains too many fields`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  const out = {};
  for (const key of keys) {
    if (!key || key.length > 120 || /[\0\r\n]/.test(key)) fail(`${path} contains an invalid field name`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    if (sensitiveKey(key)) fail(`Sensitive field ${key} is not allowed in authorization evidence`, 'AUTHORIZATION_SENSITIVE_FIELD');
    out[key] = cloneCredentialFree(value[key], `${path}.${key}`, depth + 1);
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizeText(value, label, max = 200, allowEmpty = false) {
  const text = String(value == null ? '' : value).trim();
  if ((!allowEmpty && !text) || text.length > max || /[\0\r\n]/.test(text)) {
    fail(`${label} is invalid`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  return text;
}

function normalizeIdentityKey(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) fail(`${label} is invalid`, 'AUTHORIZATION_IDENTITY_INVALID');
  return text;
}

function normalizeIso(value, label) {
  const text = normalizeText(value, label, 80);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== text) {
    fail(`${label} is invalid`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  return text;
}

function normalizePermissions(value) {
  if (!isPlainObject(value)) fail('Installation permissions are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const permission = String(value[key] || '');
    if (!/^[a-z_]{1,80}$/.test(key) || !['read', 'write', 'admin'].includes(permission)) {
      fail('Installation permissions are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
    out[key] = permission;
  }
  return out;
}

function normalizeAuthorizationSnapshot(input) {
  if (!isPlainObject(input)) fail('Authorization snapshot must be an object', 'AUTHORIZATION_SNAPSHOT_INVALID');
  cloneCredentialFree(input);
  if (Number(input.schemaVersion) !== AUTHORIZATION_SCHEMA_VERSION) {
    fail('Authorization snapshot schema is unsupported', 'AUTHORIZATION_SCHEMA_UNSUPPORTED');
  }

  const rawScope = input.scope;
  if (!isPlainObject(rawScope)) fail('Authorization scope is required', 'AUTHORIZATION_SCOPE_INVALID');
  const scope = normalizePolicyScope({
    provider: rawScope.provider,
    baseUrl: rawScope.authority ? `https://${rawScope.authority}` : undefined,
    owner: rawScope.owner,
    repo: rawScope.repo
  });
  if (scope.authority !== String(rawScope.authority || '').trim() ||
      scope.scopeKey !== String(rawScope.scopeKey || '').trim()) {
    fail('Authorization scope is inconsistent', 'AUTHORIZATION_SCOPE_INVALID');
  }

  const rawExecution = input.executionPrincipal;
  if (!isPlainObject(rawExecution)) fail('Execution principal is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const executionKind = String(rawExecution.kind || '').trim();
  if (!['user', 'installation'].includes(executionKind)) fail('Execution principal kind is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const authMethod = String(rawExecution.authMethod || '').trim();
  if (!AUTH_METHODS.has(authMethod) || (executionKind === 'installation') !== (authMethod === 'github-app')) {
    fail('Execution authentication method is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const executionPrincipal = {
    kind: executionKind,
    identityKey: normalizeIdentityKey(rawExecution.identityKey, 'Execution identity'),
    login: normalizeText(rawExecution.login, 'Execution login'),
    authMethod
  };
  if (executionKind === 'installation') {
    const installationId = Number(rawExecution.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      fail('Execution installation ID is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
    executionPrincipal.installationId = installationId;
  }

  const rawActor = input.governanceActor;
  if (!isPlainObject(rawActor) || String(rawActor.kind || '') !== 'human') {
    fail('Governance actor is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const governanceActor = {
    kind: 'human',
    identityKey: normalizeIdentityKey(rawActor.identityKey, 'Governance identity'),
    login: normalizeText(rawActor.login, 'Governance login'),
    verified: rawActor.verified === true
  };

  const rawAccess = input.repositoryAccess;
  if (!isPlainObject(rawAccess)) fail('Repository access is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const baseRole = String(rawAccess.baseRole || '').trim().toLowerCase();
  const level = Number(rawAccess.level);
  if (!BASE_ROLES.has(baseRole) || !ACCESS_LEVELS.has(level) || ACCESS_LEVEL_BY_ROLE[baseRole] !== level) {
    fail('Repository access is inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const repositoryAccess = {
    baseRole,
    providerRole: normalizeText(rawAccess.providerRole, 'Provider role', 120),
    level,
    source: normalizeText(rawAccess.source, 'Authorization source', 120),
    complete: rawAccess.complete === true
  };

  const rawRoles = input.governanceRoles;
  if (!isPlainObject(rawRoles)) fail('Governance roles are required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const governanceRoles = {};
  const expectedRoles = rolesForLevel(level);
  for (const role of GOVERNANCE_ROLE_NAMES) {
    governanceRoles[role] = rawRoles[role] === true;
    if (governanceRoles[role] !== expectedRoles[role]) {
      fail('Governance roles are inconsistent with repository access', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
  }

  let installationCapabilities = null;
  if (input.installationCapabilities != null) {
    const rawCapabilities = input.installationCapabilities;
    if (!isPlainObject(rawCapabilities)) fail('Installation capabilities are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    const repositorySelection = String(rawCapabilities.repositorySelection || '');
    if (!['all', 'selected'].includes(repositorySelection)) fail('Installation repository selection is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    installationCapabilities = {
      repositorySelected: rawCapabilities.repositorySelected === true,
      repositorySelection,
      permissions: normalizePermissions(rawCapabilities.permissions || {})
    };
  }
  if ((executionKind === 'installation') !== (installationCapabilities !== null)) {
    fail('Installation capabilities do not match the execution principal', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  if (executionKind === 'user' && (
    executionPrincipal.identityKey !== governanceActor.identityKey ||
    executionPrincipal.login.toLowerCase() !== governanceActor.login.toLowerCase()
  )) {
    fail('User execution and governance identities are inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }

  const rawEvidence = input.evidence;
  if (!isPlainObject(rawEvidence)) fail('Authorization evidence is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const status = String(rawEvidence.status || '').trim();
  if (!EVIDENCE_STATUSES.has(status)) fail('Authorization evidence status is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const fetchedAt = normalizeIso(rawEvidence.fetchedAt, 'Authorization fetched timestamp');
  const expiresAt = normalizeIso(rawEvidence.expiresAt, 'Authorization expiry timestamp');
  if (new Date(expiresAt).getTime() <= new Date(fetchedAt).getTime()) {
    fail('Authorization evidence expiry is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const reasonCode = rawEvidence.reasonCode == null ? null : normalizeText(rawEvidence.reasonCode, 'Authorization reason code', 120);
  if (status === 'resolved' && (
    reasonCode !== null || !repositoryAccess.complete || !governanceActor.verified ||
    (executionKind === 'installation' && !installationCapabilities.repositorySelected)
  )) {
    fail('Resolved authorization evidence is inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  if (status !== 'resolved' && (repositoryAccess.complete || Object.values(governanceRoles).some(Boolean))) {
    fail('Incomplete authorization evidence cannot grant governance roles', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }

  const snapshot = {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    scope,
    executionPrincipal,
    governanceActor,
    repositoryAccess,
    governanceRoles,
    installationCapabilities,
    evidence: { status, fetchedAt, expiresAt, reasonCode }
  };
  return deepFreeze(snapshot);
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

function rolesForLevel(level) {
  return {
    reader: level >= 10,
    author: level >= 30,
    reviewer: level >= 40,
    activator: level >= 50,
    administrator: level >= 50
  };
}

function emptyAccess(source = 'provider.permission.unavailable') {
  return { baseRole: 'none', providerRole: 'unknown', level: 0, source, complete: false };
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
  if (permission === 'admin') return { baseRole: 'admin', providerRole: role, level: 50, source, complete: true };
  if (permission === 'write') {
    const maintain = role === 'maintain';
    return { baseRole: maintain ? 'maintain' : 'write', providerRole: role, level: maintain ? 40 : 30, source, complete: true };
  }
  if (permission === 'read') {
    const triage = role === 'triage';
    return { baseRole: triage ? 'triage' : 'read', providerRole: role, level: triage ? 20 : 10, source, complete: true };
  }
  return { baseRole: 'none', providerRole: role === 'unknown' ? 'none' : role, level: 0, source, complete: true };
}

function gitlabAccess(response) {
  if (!isPlainObject(response) || !isPlainObject(response.permissions)) return null;
  const rawLevels = [response.permissions.project_access, response.permissions.group_access]
    .map(value => value == null ? 0 : Number(value && value.access_level));
  if (rawLevels.some(value => !Number.isInteger(value) || value < 0 || value > 50)) return null;
  const accessLevel = Math.max(...rawLevels);
  if (accessLevel >= 50) return { baseRole: 'admin', providerRole: 'owner', level: 50, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 40) return { baseRole: 'maintain', providerRole: 'maintainer', level: 40, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 30) return { baseRole: 'write', providerRole: 'developer', level: 30, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 25) return { baseRole: 'read', providerRole: 'security-manager', level: 10, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 20) return { baseRole: 'read', providerRole: 'reporter', level: 10, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 15) return { baseRole: 'read', providerRole: 'planner', level: 10, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 10) return { baseRole: 'read', providerRole: 'guest', level: 10, source: 'gitlab.project.permissions', complete: true };
  if (accessLevel >= 5) return { baseRole: 'read', providerRole: 'minimal', level: 10, source: 'gitlab.project.permissions', complete: true };
  return { baseRole: 'none', providerRole: 'none', level: 0, source: 'gitlab.project.permissions', complete: true };
}

function sanitizeProviderPermissions(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const permission = String(value[key] || '');
    if (!sensitiveKey(key) && /^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(permission)) out[key] = permission;
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
      if (scope.provider === 'gitlab') {
        const apiPath = `/projects/${encodeURIComponent(`${scope.owner}/${scope.repo}`)}`;
        const response = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath });
        const access = gitlabAccess(response);
        if (!access) return unavailableFromContext(context, scope, 'AUTHORIZATION_PROVIDER_RESPONSE_INCOMPLETE', now, cacheTtlMs, 'partial');
        return createResolvedSnapshot({ scope, context, access, now, ttlMs: cacheTtlMs });
      }

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

      const permissionPath = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/collaborators/${encodeURIComponent(context.governanceActor.login)}/permission`;
      const permission = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: permissionPath });
      const source = scope.provider === 'gitea' ? 'gitea.collaborator.permission' : 'github.collaborator.permission';
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
  createAuthorizationResolver
});
