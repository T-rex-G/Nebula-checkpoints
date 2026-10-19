import { createHash } from 'node:crypto';

/* The snapshot's shape and its guard are the actor contract; this module resolves one from the provider. */
import * as actor from '../../../../../packages/contracts/src/actor.ts';
import type {
  AuthorizationEvidenceStatus,
  AuthorizationSnapshot,
  BaseRole,
  ExecutionPrincipal,
  GovernanceActor,
  GovernanceRoles,
  InstallationCapabilities,
  InstallationPermission,
  RepositoryAccess
} from '../../../../../packages/contracts/src/actor.ts';
import { isPlainObject } from '../../../../../packages/contracts/src/guards.ts';
import type { JsonObject } from '../../../../../packages/contracts/src/guards.ts';
import type { IdentityKey } from '../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../packages/contracts/src/scope.ts';
import { normalizeRepositoryScope } from './repository-scope.ts';

export { AUTHORIZATION_SCHEMA_VERSION, GOVERNANCE_ROLE_NAMES } from '../../../../../packages/contracts/src/actor.ts';

const { ACCESS_LEVEL_BY_ROLE, AUTHORIZATION_SCHEMA_VERSION, rolesForLevel } = actor;
const AUTH_METHODS = new Set<string>(actor.AUTH_METHODS);
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

export class AuthorizationResolverError extends Error {
  override readonly name = 'AuthorizationResolverError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(message: string, code: string, status = 400): never {
  throw new AuthorizationResolverError(message, code, status);
}

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as JsonObject)[key];
}

function normalizeText(value: unknown, label: string, max = 200, allowEmpty = false): string {
  return actor.normalizeAuthorizationText(value, label, max, allowEmpty, fail);
}

function normalizeIdentityKey(value: unknown, label: string): IdentityKey {
  return actor.normalizeAuthorizationIdentityKey(value, label, fail);
}

/* A malformed snapshot is an AuthorizationResolverError; a malformed scope inside it stays the scope reader's own. */
export function normalizeAuthorizationSnapshot(input: unknown): AuthorizationSnapshot {
  return actor.normalizeAuthorizationSnapshot(input, { refuse: fail, normalizeScope: normalizeRepositoryScope });
}

function hashIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/* Who executes a request and who answers for it in governance; the cache keys on both. */
interface AccountContext {
  readonly executionPrincipal: ExecutionPrincipal;
  readonly governanceActor: GovernanceActor;
  readonly installationCapabilities: null;
  readonly cacheIdentity: string;
}

function normalizeAccountContext(account: unknown, actorIdentityKey: unknown, scope: RepositoryScope): AccountContext {
  if (!isPlainObject(account)) return fail('Provider account is required', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  const provider = String(account.provider || 'github').trim().toLowerCase();
  if (provider !== scope.provider) fail('Provider account does not match the authorization scope', 'AUTHORIZATION_SCOPE_INVALID');
  const login = normalizeText(account.login, 'Provider login');
  const authMethod = String(account.authMethod || 'token').trim();
  if (!AUTH_METHODS.has(authMethod)) fail('Provider authentication method is invalid', 'AUTHORIZATION_ACCOUNT_INVALID', 401);
  const method = authMethod as ExecutionPrincipal['authMethod'];
  const requestIdentityKey = normalizeIdentityKey(actorIdentityKey, 'Request identity');
  if (method !== 'github-app') {
    return {
      executionPrincipal: { kind: 'user', identityKey: requestIdentityKey, login, authMethod: method },
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
  }) as IdentityKey;
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

function emptyRoles(): GovernanceRoles {
  return { reader: false, author: false, reviewer: false, activator: false, administrator: false };
}

function emptyAccess(source = 'provider.permission.unavailable'): RepositoryAccess {
  return { baseRole: 'none', providerRole: 'unknown', level: ACCESS_LEVEL_BY_ROLE.none, source, complete: false };
}

function evidenceTimes(now: () => number, ttlMs: number): { readonly fetchedAt: string; readonly expiresAt: string } {
  const fetchedMs = Number(now());
  if (!Number.isFinite(fetchedMs)) fail('Authorization clock is invalid', 'AUTHORIZATION_CONFIGURATION_INVALID', 500);
  return {
    fetchedAt: new Date(fetchedMs).toISOString(),
    expiresAt: new Date(fetchedMs + ttlMs).toISOString()
  };
}

type UnresolvedStatus = Exclude<AuthorizationEvidenceStatus, 'resolved'>;

function unavailableFromContext(
  context: AccountContext,
  scope: RepositoryScope,
  reasonCode: string,
  now: () => number,
  ttlMs: number,
  status: UnresolvedStatus = 'unavailable',
  installationCapabilities: InstallationCapabilities | null = null
): AuthorizationSnapshot {
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

/* What the provider said the installation may do, before the repository is known to be selected. */
function installationCapabilitiesOf(installation: JsonObject): { repositorySelected: boolean; readonly repositorySelection: 'all' | 'selected'; readonly permissions: Readonly<Record<string, InstallationPermission>> } {
  return {
    repositorySelected: false,
    repositorySelection: installation.repositorySelection === 'all' ? 'all' : 'selected',
    permissions: sanitizeProviderPermissions(installation.permissions)
  };
}

export interface UnavailableSnapshotInput {
  readonly account?: unknown;
  readonly actorIdentityKey?: unknown;
  readonly provider?: unknown;
  readonly baseUrl?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
  readonly ttlMs?: unknown;
  readonly now?: unknown;
  readonly reasonCode?: unknown;
  readonly status?: unknown;
}

export function createUnavailableAuthorizationSnapshot(input: UnavailableSnapshotInput = {}): AuthorizationSnapshot {
  const scope = normalizeRepositoryScope({
    provider: read(input.account, 'provider') || input.provider,
    baseUrl: read(input.account, 'baseUrl') || input.baseUrl,
    owner: input.owner,
    repo: input.repo
  });
  const context = normalizeAccountContext(input.account, input.actorIdentityKey, scope);
  const account = input.account as JsonObject;
  const ttlMs = Number.isFinite(Number(input.ttlMs)) && Number(input.ttlMs) > 0 ? Number(input.ttlMs) : DEFAULT_CACHE_TTL_MS;
  const now = typeof input.now === 'function' ? input.now as () => number : Date.now;
  let installationCapabilities: InstallationCapabilities | null = null;
  if (context.executionPrincipal.kind === 'installation' && isPlainObject(account.installation)) {
    installationCapabilities = installationCapabilitiesOf(account.installation);
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

function sanitizeProviderRole(value: unknown): string {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text.length > 120 || !/^[a-z0-9._ -]+$/.test(text)) return 'unknown';
  return text;
}

function githubAccess(response: unknown, expectedLogin: string, source: string): RepositoryAccess | null {
  if (!isPlainObject(response)) return null;
  const permission = String(response.permission || '').trim().toLowerCase();
  const role = sanitizeProviderRole(response.role_name || permission);
  const returnedLogin = String(read(response.user, 'login') || '').trim().toLowerCase();
  if (!['admin', 'write', 'read', 'none'].includes(permission) || returnedLogin !== expectedLogin.toLowerCase()) return null;
  const access = (baseRole: BaseRole, providerRole: string): RepositoryAccess => ({ baseRole, providerRole, level: ACCESS_LEVEL_BY_ROLE[baseRole], source, complete: true });
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
export const PUBLIC_ACCESS_SOURCES: readonly string[] = Object.freeze(['github.repository.public']);
function publicRepositoryAccess(repository: unknown, scope: RepositoryScope): RepositoryAccess | null {
  if (!isPlainObject(repository)) return null;
  const expected = `${scope.owner}/${scope.repo}`.toLowerCase();
  const name = String(repository.full_name || '').trim().toLowerCase();
  const visibility = repository.visibility == null ? (repository.private === false ? 'public' : '') : String(repository.visibility).toLowerCase();
  if (repository.private !== false || repository.internal === true || visibility !== 'public' || name !== expected) return null;
  return { baseRole: 'read', providerRole: 'public', level: ACCESS_LEVEL_BY_ROLE.read, source: 'github.repository.public', complete: true };
}
export function isPublicReaderAccess(snapshot: unknown): boolean {
  const access = read(snapshot, 'repositoryAccess');
  return Boolean(snapshot && access && PUBLIC_ACCESS_SOURCES.includes(read(access, 'source') as string));
}

function sanitizeProviderPermissions(value: unknown): Record<string, InstallationPermission> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, InstallationPermission> = {};
  for (const key of Object.keys(value).sort()) {
    const permission = String(value[key] || '');
    if (!actor.isSensitiveAuthorizationKey(key) && /^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(permission)) {
      out[key] = permission as InstallationPermission;
    }
  }
  return out;
}

function reasonFromError(error: unknown): string {
  const status = Number(read(error, 'status'));
  if (status === 401) return 'AUTHORIZATION_PROVIDER_UNAUTHENTICATED';
  if (status === 403) return 'AUTHORIZATION_PROVIDER_FORBIDDEN';
  if (status === 404) return 'AUTHORIZATION_SCOPE_NOT_FOUND';
  if (status === 429) return 'AUTHORIZATION_PROVIDER_RATE_LIMITED';
  if (error && (read(error, 'name') === 'AbortError' || read(error, 'code') === 'ABORT_ERR')) return 'AUTHORIZATION_PROVIDER_TIMEOUT';
  return 'AUTHORIZATION_PROVIDER_UNAVAILABLE';
}

interface ResolvedInput {
  readonly scope: RepositoryScope;
  readonly context: AccountContext;
  readonly access: RepositoryAccess;
  readonly now: () => number;
  readonly ttlMs: number;
  readonly installationCapabilities?: InstallationCapabilities | null;
}

function createResolvedSnapshot({ scope, context, access, now, ttlMs, installationCapabilities = null }: ResolvedInput): AuthorizationSnapshot {
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

/* One read of the provider's API on the account's behalf. */
export interface ProviderReadRequest {
  readonly account: JsonObject;
  readonly provider: string;
  readonly baseUrl: unknown;
  readonly apiPath: string;
}
export type ProviderRead = (request: ProviderReadRequest) => Promise<unknown>;

export interface AuthorizationResolverOptions {
  readonly request?: ProviderRead;
  readonly now?: () => number;
  readonly cacheTtlMs?: unknown;
  readonly maxEntries?: unknown;
}

export interface ResolveInput {
  readonly account?: unknown;
  readonly actorIdentityKey?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
}

export interface AuthorizationResolver {
  resolve(input?: ResolveInput): Promise<AuthorizationSnapshot>;
  cacheSize(): number;
}

export function createAuthorizationResolver(options: AuthorizationResolverOptions = {}): AuthorizationResolver {
  if (typeof options.request !== 'function') throw new TypeError('Authorization resolver request dependency is required');
  const request = options.request;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cacheTtlMs = Number.isFinite(Number(options.cacheTtlMs)) && Number(options.cacheTtlMs) > 0
    ? Math.min(Number(options.cacheTtlMs), 5 * 60 * 1000)
    : DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isSafeInteger(Number(options.maxEntries)) && Number(options.maxEntries) > 0
    ? Math.min(Number(options.maxEntries), 2000)
    : DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, { readonly snapshot: AuthorizationSnapshot; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<AuthorizationSnapshot>>();

  function cacheKey(scope: RepositoryScope, context: AccountContext, authMethod: string): string {
    return `${scope.scopeKey}:${authMethod}:${context.cacheIdentity}`;
  }

  function remember(key: string, snapshot: AuthorizationSnapshot): void {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { snapshot, expiresAt: new Date(snapshot.evidence.expiresAt).getTime() });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function resolveFresh(account: JsonObject, scope: RepositoryScope, context: AccountContext): Promise<AuthorizationSnapshot> {
    try {
      if (context.executionPrincipal.kind === 'installation') {
        const installation = account.installation;
        if (!isPlainObject(installation) || Number(installation.id) !== context.executionPrincipal.installationId ||
            String(read(installation.account, 'login') || '').trim().toLowerCase() !== String(account.login).trim().toLowerCase() ||
            Number(read(installation.account, 'id')) !== Number(account.installationAccountId)) {
          return unavailableFromContext(context, scope, 'AUTHORIZATION_INSTALLATION_EVIDENCE_UNAVAILABLE', now, cacheTtlMs);
        }
        const capabilities = installationCapabilitiesOf(installation);
        const repoPath = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
        const repository = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: repoPath });
        const fullName = String(read(repository, 'full_name') || '').trim().toLowerCase();
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
      let permission: unknown;
      try {
        permission = await request({ account, provider: scope.provider, baseUrl: account.baseUrl || '', apiPath: permissionPath });
      } catch (error) {
        /*
         * GitHub answers this question only to people who can push. Anyone
         * else reading a public repository is refused here, so the repository
         * itself is asked whether it is public; if it is, the answer is the
         * reader access everyone has, marked as such.
         */
        if (Number(read(error, 'status')) !== 403) throw error;
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
      let capabilities: InstallationCapabilities | null = null;
      if (context.executionPrincipal.kind === 'installation' && isPlainObject(account.installation)) {
        capabilities = installationCapabilitiesOf(account.installation);
      }
      return unavailableFromContext(context, scope, reasonFromError(error), now, cacheTtlMs, 'unavailable', capabilities);
    }
  }

  async function resolve(input: ResolveInput = {}): Promise<AuthorizationSnapshot> {
    const account = input.account;
    const scope = normalizeRepositoryScope({
      provider: read(account, 'provider'),
      baseUrl: read(account, 'baseUrl'),
      owner: input.owner,
      repo: input.repo
    });
    const context = normalizeAccountContext(account, input.actorIdentityKey, scope);
    /* The context refuses anything but a plain object, so the account is one from here. */
    const provided = account as JsonObject;
    const key = cacheKey(scope, context, String(provided.authMethod || 'token'));
    const currentTime = Number(now());
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.snapshot;
    if (cached) cache.delete(key);
    const already = inFlight.get(key);
    if (already) return already;
    const pending = resolveFresh(provided, scope, context)
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
