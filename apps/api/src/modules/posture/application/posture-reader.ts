import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { read as field } from '../../../platform/values/fields.ts';
import { credentialPosture, exposureSummary, type CredentialPosture, type RepositoryExposure } from '../domain/workspace-posture.ts';
import { recoveryPoints, type RecoveryPoint } from '../persistence/recovery-points.ts';

/* What the provider transport answers for a raw request: the status, the headers, and a body to release. */
export interface RawResponse {
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body?: { cancel(): Promise<unknown> } | null;
}

/* The ports the server hands the reader: its guarded provider transport, its database and its stores. */
export interface PostureDependencies {
  gh(account: unknown, apiPath: string, options: { readonly raw: true; readonly timeoutMs: number }): Promise<RawResponse>;
  dbReady(): Promise<unknown>;
  pool(): Queryable;
  identityKey(account: unknown): string;
  normalizePolicyScope(scope: { provider: string; baseUrl: string; owner: string; repo: string }): { readonly authority: string };
  exposureStore(): { workspaceSummary(scope: { provider: string; authority: string; identityKey: string }): Promise<unknown> };
  severityOf(rule: string): unknown;
  readonly databaseConfigured: unknown;
  readonly maintenance: unknown;
  readonly hostedAlpha: unknown;
}

export interface Reading<T> {
  readonly available: boolean;
  readonly repositories: readonly T[];
}

export interface WorkspacePosture {
  readonly credential: CredentialPosture;
  readonly recovery: Reading<RecoveryPoint>;
  readonly exposure: Reading<RepositoryExposure>;
  readonly boundary: {
    readonly state: 'degraded' | 'online';
    readonly database: 'ready' | 'unavailable' | 'not-configured';
    readonly maintenance: boolean;
  };
}

function providerOf(account: unknown): string {
  return String(field(account, 'provider') || 'github');
}

/*
 * The reader behind GET /api/workspace/posture. Four independent readings,
 * each allowed to fail on its own: a database that is down makes recovery and
 * exposure unavailable, not the credential; a provider that will not describe
 * its token makes the credential unmeasured, not the database.
 *
 * Every provider request goes through the transports the server hands in --
 * the same guarded ones every other route uses -- and the token never leaves
 * this function except as the kind its prefix names.
 */
export function createPostureReader(deps: PostureDependencies): { read(account: unknown): Promise<WorkspacePosture> } {
  const {
    gh, dbReady, pool, identityKey, normalizePolicyScope, exposureStore, severityOf,
    databaseConfigured, maintenance, hostedAlpha
  } = deps;

  async function credential(account: unknown): Promise<CredentialPosture> {
    const provider = providerOf(account);
    const authMethod = field(account, 'authMethod');
    try {
      if (provider === 'github' && authMethod !== 'github-app') {
        const response = await gh(account, '/user', { raw: true, timeoutMs: 8000 });
        const scopesHeader = response.ok ? response.headers.get('x-oauth-scopes') : '';
        const expiresHeader = response.ok ? response.headers.get('github-authentication-token-expiration') : '';
        if (response.body) await response.body.cancel();
        return credentialPosture({ provider, token: field(account, 'token'), scopesHeader, expiresHeader });
      }
      return credentialPosture({ provider, authMethod });
    } catch {
      return credentialPosture({ provider: 'unknown' });
    }
  }

  async function recovery(account: unknown): Promise<Reading<RecoveryPoint>> {
    if (!(await dbReady())) return { available: false, repositories: [] };
    return { available: true, repositories: await recoveryPoints(pool(), providerOf(account), identityKey(account)) };
  }

  async function exposure(account: unknown): Promise<Reading<RepositoryExposure>> {
    if (!databaseConfigured || !(await dbReady())) return { available: false, repositories: [] };
    const provider = providerOf(account);
    /* The same authority the exposure routes key their rows by. */
    const authority = normalizePolicyScope({ provider, baseUrl: String(field(account, 'baseUrl') || ''), owner: 'scope', repo: 'scope' }).authority;
    const rows = await exposureStore().workspaceSummary({ provider, authority, identityKey: identityKey(account) });
    return { available: true, repositories: exposureSummary(rows, severityOf) };
  }

  async function read(account: unknown): Promise<WorkspacePosture> {
    if (!account || providerOf(account) !== 'github') {
      throw Object.assign(new Error('Workspace posture requires GitHub'), { code: 'PROVIDER_ACCOUNT_INVALID', status: 401 });
    }
    const settle = <T>(promise: Promise<T>): Promise<T | null> => promise.then(value => value, () => null);
    const [credentialReading, recoveryReading, exposureReading, databaseReady] = await Promise.all([
      credential(account),
      settle(recovery(account)),
      settle(exposure(account)),
      databaseConfigured ? settle(dbReady()) : Promise.resolve(false)
    ]);
    const database = databaseConfigured ? (databaseReady ? 'ready' : 'unavailable') : 'not-configured';
    return {
      credential: credentialReading,
      recovery: recoveryReading || { available: false, repositories: [] },
      exposure: exposureReading || { available: false, repositories: [] },
      boundary: {
        state: maintenance || (hostedAlpha && database !== 'ready') ? 'degraded' : 'online',
        database,
        maintenance: Boolean(maintenance)
      }
    };
  }

  return Object.freeze({ read });
}
