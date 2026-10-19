import { normalizeAuthorizationSnapshot } from '../../../platform/authorization/authorization-resolver.ts';

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function currentTime(now: (() => number) | number): number {
  const value = Number(typeof now === 'function' ? now() : Date.now());
  if (!Number.isFinite(value)) throw new Error('Governance interface clock is invalid');
  return value;
}

export interface GovernanceCapabilities {
  readonly read: boolean;
  readonly author: boolean;
  readonly review: boolean;
  readonly activate: boolean;
  readonly administer: boolean;
}

/* What the governance screens may offer this person on this repository, and how current that is. */
export interface GovernanceInterfaceAccess {
  readonly schemaVersion: 1;
  readonly repository: { readonly provider: string; readonly authority: string; readonly owner: string; readonly repo: string };
  readonly actor: { readonly login: string };
  readonly execution: { readonly kind: string; readonly authMethod: string };
  readonly capabilities: GovernanceCapabilities;
  readonly evidence: { readonly status: 'current' | 'stale' | 'unavailable'; readonly expiresAt: string };
}

export function projectGovernanceInterfaceAccess(snapshot: unknown, now: (() => number) | number = Date.now): GovernanceInterfaceAccess {
  const authorization = normalizeAuthorizationSnapshot(snapshot);
  const timestamp = currentTime(now);
  const fetchedAt = new Date(authorization.evidence.fetchedAt).getTime();
  const expiresAt = new Date(authorization.evidence.expiresAt).getTime();
  const current = authorization.evidence.status === 'resolved' &&
    authorization.repositoryAccess.complete === true &&
    authorization.governanceActor.verified === true &&
    Number.isFinite(fetchedAt) && Number.isFinite(expiresAt) &&
    fetchedAt <= timestamp + 30_000 && expiresAt > timestamp;
  const roles = authorization.governanceRoles;
  const capabilities = {
    read: current && roles.reader === true,
    author: current && roles.author === true,
    review: current && roles.reviewer === true,
    activate: current && roles.activator === true,
    administer: current && roles.administrator === true
  };
  return deepFreeze({
    schemaVersion: 1,
    repository: {
      provider: authorization.scope.provider,
      authority: authorization.scope.authority,
      owner: authorization.scope.owner,
      repo: authorization.scope.repo
    },
    actor: { login: authorization.governanceActor.login },
    execution: {
      kind: authorization.executionPrincipal.kind,
      authMethod: authorization.executionPrincipal.authMethod
    },
    capabilities,
    evidence: {
      status: current ? 'current' : (expiresAt <= timestamp ? 'stale' : 'unavailable'),
      expiresAt: authorization.evidence.expiresAt
    }
  });
}
