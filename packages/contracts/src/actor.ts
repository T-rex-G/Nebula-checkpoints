/*
 * Who is acting, on whose authority, and with what evidence.
 *
 * An authorization snapshot names two principals. The execution principal is
 * the credential that touches the provider: a person's token or an installed
 * app. The governance actor is the person accountable for the decision. It
 * carries the repository access the provider reported for them, the
 * governance roles that access grants, and how complete and how fresh that
 * evidence is.
 *
 * The snapshot never carries a credential: a field named like one is refused
 * at any depth. Ported from src/authorization-resolver.js with its behaviour
 * and codes unchanged.
 */
import { deepFreeze, isPlainObject, refuseWithContractError } from './guards.ts';
import type { JsonObject, Refuse } from './guards.ts';
import { IDENTITY_KEY } from './ids.ts';
import type { IdentityKey } from './ids.ts';
import { normalizePolicyScope } from './scope.ts';
import type { RepositoryScope } from './scope.ts';

export const ACTOR_CONTRACT_VERSION = 1;
export const AUTHORIZATION_SCHEMA_VERSION = 1;

export const GOVERNANCE_ROLE_NAMES = Object.freeze(['reader', 'author', 'reviewer', 'activator', 'administrator'] as const);
export type GovernanceRoleName = (typeof GOVERNANCE_ROLE_NAMES)[number];
export type GovernanceRoles = Readonly<Record<GovernanceRoleName, boolean>>;

export const AUTH_METHODS = Object.freeze(['token', 'oauth', 'github-app'] as const);
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const AUTHORIZATION_EVIDENCE_STATUSES = Object.freeze(['resolved', 'partial', 'unavailable'] as const);
export type AuthorizationEvidenceStatus = (typeof AUTHORIZATION_EVIDENCE_STATUSES)[number];

export const ACCESS_LEVEL_BY_ROLE = Object.freeze({ none: 0, read: 10, triage: 20, write: 30, maintain: 40, admin: 50 } as const);
export type BaseRole = keyof typeof ACCESS_LEVEL_BY_ROLE;
export type AccessLevel = (typeof ACCESS_LEVEL_BY_ROLE)[BaseRole];
export const BASE_ROLES = Object.freeze(Object.keys(ACCESS_LEVEL_BY_ROLE) as BaseRole[]);

export type InstallationPermission = 'read' | 'write' | 'admin';

export interface ExecutionPrincipal {
  readonly kind: 'user' | 'installation';
  readonly identityKey: IdentityKey;
  readonly login: string;
  readonly authMethod: AuthMethod;
  readonly installationId?: number;
}

export interface GovernanceActor {
  readonly kind: 'human';
  readonly identityKey: IdentityKey;
  readonly login: string;
  readonly verified: boolean;
}

export interface RepositoryAccess {
  readonly baseRole: BaseRole;
  readonly providerRole: string;
  readonly level: AccessLevel;
  readonly source: string;
  readonly complete: boolean;
}

export interface InstallationCapabilities {
  readonly repositorySelected: boolean;
  readonly repositorySelection: 'all' | 'selected';
  readonly permissions: Readonly<Record<string, InstallationPermission>>;
}

export interface AuthorizationEvidence {
  readonly status: AuthorizationEvidenceStatus;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly reasonCode: string | null;
}

export interface AuthorizationSnapshot {
  readonly schemaVersion: typeof AUTHORIZATION_SCHEMA_VERSION;
  readonly scope: RepositoryScope;
  readonly executionPrincipal: ExecutionPrincipal;
  readonly governanceActor: GovernanceActor;
  readonly repositoryAccess: RepositoryAccess;
  readonly governanceRoles: GovernanceRoles;
  readonly installationCapabilities: InstallationCapabilities | null;
  readonly evidence: AuthorizationEvidence;
}

const SENSITIVE_KEY_RX = /(?:accesstoken|refreshtoken|token|secret|password|privatekey|authorization|cookie)/i;
const includes = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/* What a level of repository access lets a person do in governance. */
export function rolesForLevel(level: number): GovernanceRoles {
  return {
    reader: level >= 10,
    author: level >= 30,
    reviewer: level >= 40,
    activator: level >= 50,
    administrator: level >= 50
  };
}

/* A field named like a credential, however it is punctuated. */
export function isSensitiveAuthorizationKey(key: string): boolean {
  return SENSITIVE_KEY_RX.test(String(key || '').replace(/[^a-z0-9]/gi, ''));
}

/* Walks the input as JSON and refuses anything that is not, or that names a credential. */
function assertCredentialFree(value: unknown, refuse: Refuse, path = '$', depth = 0): void {
  if (depth > 8) refuse(`${path} exceeds the authorization depth limit`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(`${path} contains a non-finite number`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /\0/.test(value)) refuse(`${path} contains invalid text`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) refuse(`${path} contains too many items`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    value.forEach((entry, index) => assertCredentialFree(entry, refuse, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return refuse(`${path} contains a non-JSON value`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  const keys = Object.keys(value);
  if (keys.length > 80) refuse(`${path} contains too many fields`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  for (const key of keys) {
    if (!key || key.length > 120 || /[\0\r\n]/.test(key)) refuse(`${path} contains an invalid field name`, 'AUTHORIZATION_SNAPSHOT_INVALID');
    if (isSensitiveAuthorizationKey(key)) refuse(`Sensitive field ${key} is not allowed in authorization evidence`, 'AUTHORIZATION_SENSITIVE_FIELD');
    assertCredentialFree(value[key], refuse, `${path}.${key}`, depth + 1);
  }
}

export function normalizeAuthorizationText(value: unknown, label: string, max = 200, allowEmpty = false, refuse: Refuse = refuseWithContractError): string {
  const text = String(value == null ? '' : value).trim();
  if ((!allowEmpty && !text) || text.length > max || /[\0\r\n]/.test(text)) {
    refuse(`${label} is invalid`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  return text;
}

export function normalizeAuthorizationIdentityKey(value: unknown, label: string, refuse: Refuse = refuseWithContractError): IdentityKey {
  const text = String(value || '').trim().toLowerCase();
  if (!IDENTITY_KEY.test(text)) refuse(`${label} is invalid`, 'AUTHORIZATION_IDENTITY_INVALID');
  return text as IdentityKey;
}

function normalizeIso(value: unknown, label: string, refuse: Refuse): string {
  const text = normalizeAuthorizationText(value, label, 80, false, refuse);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== text) {
    refuse(`${label} is invalid`, 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  return text;
}

function normalizePermissions(value: unknown, refuse: Refuse): Record<string, InstallationPermission> {
  if (!isPlainObject(value)) return refuse('Installation permissions are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const out: Record<string, InstallationPermission> = {};
  for (const key of Object.keys(value).sort()) {
    const permission = String(value[key] || '');
    if (!/^[a-z_]{1,80}$/.test(key) || !includes(['read', 'write', 'admin'] as const, permission)) {
      return refuse('Installation permissions are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
    out[key] = permission;
  }
  return out;
}

export interface SnapshotOptions {
  /* Refuses a malformed snapshot. The server passes its AuthorizationResolverError. */
  readonly refuse?: Refuse;
  /* Normalises the scope. The server passes governance's own, so a bad scope keeps its GovernanceError. */
  readonly normalizeScope?: (input: JsonObject) => RepositoryScope;
}

export function normalizeAuthorizationSnapshot(input: unknown, options: SnapshotOptions = {}): AuthorizationSnapshot {
  const refuse = options.refuse || refuseWithContractError;
  const normalizeScope = options.normalizeScope || ((scopeInput: JsonObject) => normalizePolicyScope(scopeInput));
  if (!isPlainObject(input)) return refuse('Authorization snapshot must be an object', 'AUTHORIZATION_SNAPSHOT_INVALID');
  assertCredentialFree(input, refuse);
  if (Number(input.schemaVersion) !== AUTHORIZATION_SCHEMA_VERSION) {
    refuse('Authorization snapshot schema is unsupported', 'AUTHORIZATION_SCHEMA_UNSUPPORTED');
  }

  const rawScope = input.scope;
  if (!isPlainObject(rawScope)) return refuse('Authorization scope is required', 'AUTHORIZATION_SCOPE_INVALID');
  const scope = normalizeScope({
    provider: rawScope.provider,
    baseUrl: rawScope.authority ? `https://${String(rawScope.authority)}` : undefined,
    owner: rawScope.owner,
    repo: rawScope.repo
  });
  if (scope.authority !== String(rawScope.authority || '').trim() ||
      scope.scopeKey !== String(rawScope.scopeKey || '').trim()) {
    refuse('Authorization scope is inconsistent', 'AUTHORIZATION_SCOPE_INVALID');
  }

  const rawExecution = input.executionPrincipal;
  if (!isPlainObject(rawExecution)) return refuse('Execution principal is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const executionKind = String(rawExecution.kind || '').trim();
  if (!includes(['user', 'installation'] as const, executionKind)) return refuse('Execution principal kind is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const authMethod = String(rawExecution.authMethod || '').trim();
  if (!includes(AUTH_METHODS, authMethod) || (executionKind === 'installation') !== (authMethod === 'github-app')) {
    return refuse('Execution authentication method is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const identityKey = normalizeAuthorizationIdentityKey(rawExecution.identityKey, 'Execution identity', refuse);
  const login = normalizeAuthorizationText(rawExecution.login, 'Execution login', 200, false, refuse);
  let executionPrincipal: ExecutionPrincipal = { kind: executionKind, identityKey, login, authMethod };
  if (executionKind === 'installation') {
    const installationId = Number(rawExecution.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      refuse('Execution installation ID is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
    executionPrincipal = { ...executionPrincipal, installationId };
  }

  const rawActor = input.governanceActor;
  if (!isPlainObject(rawActor) || String(rawActor.kind || '') !== 'human') {
    return refuse('Governance actor is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const governanceActor: GovernanceActor = {
    kind: 'human',
    identityKey: normalizeAuthorizationIdentityKey(rawActor.identityKey, 'Governance identity', refuse),
    login: normalizeAuthorizationText(rawActor.login, 'Governance login', 200, false, refuse),
    verified: rawActor.verified === true
  };

  const rawAccess = input.repositoryAccess;
  if (!isPlainObject(rawAccess)) return refuse('Repository access is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const baseRole = String(rawAccess.baseRole || '').trim().toLowerCase();
  const level = Number(rawAccess.level);
  if (!includes(BASE_ROLES, baseRole) || ACCESS_LEVEL_BY_ROLE[baseRole] !== level) {
    return refuse('Repository access is inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const repositoryAccess: RepositoryAccess = {
    baseRole,
    providerRole: normalizeAuthorizationText(rawAccess.providerRole, 'Provider role', 120, false, refuse),
    level: level as AccessLevel,
    source: normalizeAuthorizationText(rawAccess.source, 'Authorization source', 120, false, refuse),
    complete: rawAccess.complete === true
  };

  const rawRoles = input.governanceRoles;
  if (!isPlainObject(rawRoles)) return refuse('Governance roles are required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const expectedRoles = rolesForLevel(level);
  const governanceRoles = {} as Record<GovernanceRoleName, boolean>;
  for (const role of GOVERNANCE_ROLE_NAMES) {
    governanceRoles[role] = rawRoles[role] === true;
    if (governanceRoles[role] !== expectedRoles[role]) {
      refuse('Governance roles are inconsistent with repository access', 'AUTHORIZATION_SNAPSHOT_INVALID');
    }
  }

  let installationCapabilities: InstallationCapabilities | null = null;
  if (input.installationCapabilities != null) {
    const rawCapabilities = input.installationCapabilities;
    if (!isPlainObject(rawCapabilities)) return refuse('Installation capabilities are invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    const repositorySelection = String(rawCapabilities.repositorySelection || '');
    if (!includes(['all', 'selected'] as const, repositorySelection)) return refuse('Installation repository selection is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
    installationCapabilities = {
      repositorySelected: rawCapabilities.repositorySelected === true,
      repositorySelection,
      permissions: normalizePermissions(rawCapabilities.permissions || {}, refuse)
    };
  }
  if ((executionKind === 'installation') !== (installationCapabilities !== null)) {
    refuse('Installation capabilities do not match the execution principal', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  if (executionKind === 'user' && (
    executionPrincipal.identityKey !== governanceActor.identityKey ||
    executionPrincipal.login.toLowerCase() !== governanceActor.login.toLowerCase()
  )) {
    refuse('User execution and governance identities are inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }

  const rawEvidence = input.evidence;
  if (!isPlainObject(rawEvidence)) return refuse('Authorization evidence is required', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const status = String(rawEvidence.status || '').trim();
  if (!includes(AUTHORIZATION_EVIDENCE_STATUSES, status)) return refuse('Authorization evidence status is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  const fetchedAt = normalizeIso(rawEvidence.fetchedAt, 'Authorization fetched timestamp', refuse);
  const expiresAt = normalizeIso(rawEvidence.expiresAt, 'Authorization expiry timestamp', refuse);
  if (new Date(expiresAt).getTime() <= new Date(fetchedAt).getTime()) {
    refuse('Authorization evidence expiry is invalid', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  const reasonCode = rawEvidence.reasonCode == null ? null : normalizeAuthorizationText(rawEvidence.reasonCode, 'Authorization reason code', 120, false, refuse);
  if (status === 'resolved' && (
    reasonCode !== null || !repositoryAccess.complete || !governanceActor.verified ||
    (executionKind === 'installation' && !(installationCapabilities && installationCapabilities.repositorySelected))
  )) {
    refuse('Resolved authorization evidence is inconsistent', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }
  if (status !== 'resolved' && (repositoryAccess.complete || Object.values(governanceRoles).some(Boolean))) {
    refuse('Incomplete authorization evidence cannot grant governance roles', 'AUTHORIZATION_SNAPSHOT_INVALID');
  }

  return deepFreeze({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    scope,
    executionPrincipal,
    governanceActor,
    repositoryAccess,
    governanceRoles,
    installationCapabilities,
    evidence: { status, fetchedAt, expiresAt, reasonCode }
  });
}
