import { alphaActorLabel } from '../../identity-access/index.ts';
import type { Queryable, QueryOutcome, Row } from '../../../platform/persistence/queryable.ts';
import type { ExposureScope } from '../persistence/exposure-store.ts';

export interface ExposureSessionInput {
  readonly scope: ExposureScope;
  readonly scanId: string;
  readonly requestedBy: unknown;
}

/* What the server lends the resolver: its pool, its session codec and its provider rules. */
export interface ExposureSessionDependencies<Access extends { readonly testerId?: unknown }, Resolved> {
  readonly pool: Queryable;
  unseal(data: unknown): unknown;
  identityKey(account: unknown): unknown;
  providerAuthority(account: unknown): unknown;
  resolveAccount(account: unknown): Promise<Resolved>;
  readonly alphaEnabled: boolean;
  readAlphaSession(sessionId: unknown): Promise<Access>;
  readOwnedSession(input: { readonly testerId: unknown; readonly sessionId: unknown }): Promise<{ readonly session?: unknown }>;
  repositoryAllowed(access: Access, scope: ExposureScope): boolean;
}

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Readonly<Record<string, unknown>>)[key];
}

/* The rows a statement answered with. An answer without them is a failure, as it always was. */
function rowsOf(result: QueryOutcome): readonly Row[] {
  const rows = result.rows;
  if (!rows) throw new TypeError('the database answered without rows');
  return rows;
}

/* Resolve the durable owner, not a display label. Hosted scans must still have
   an active invitation, repository scope and provider-session ownership. */
export async function resolveExposureSession<Access extends { readonly testerId?: unknown }, Resolved>(
  input: ExposureSessionInput,
  dependencies: ExposureSessionDependencies<Access, Resolved>
): Promise<Resolved | null> {
  const { scope, scanId, requestedBy } = input;
  const {
    pool, unseal, identityKey, providerAuthority, resolveAccount,
    alphaEnabled, readAlphaSession, readOwnedSession, repositoryAllowed
  } = dependencies;
  const owned = await pool.query(
    `SELECT identity_key FROM nv_exposure_scans
      WHERE scan_id=$1 AND provider=$2 AND authority=$3 AND owner_login=$4 AND repo_name=$5`,
    [scanId, scope.provider, scope.authority, scope.owner, scope.repo]
  );
  const key = read(rowsOf(owned)[0], 'identity_key');
  if (!key) return null;
  const alpha = String(requestedBy).startsWith('alpha:');
  if (alphaEnabled && !alpha) return null;
  const rows = await pool.query(
    `SELECT sid, data, session_key_hash FROM nv_sessions
      WHERE $1 = ANY(identity_keys) ORDER BY updated DESC LIMIT 10`, [key]
  );
  for (const row of rowsOf(rows)) {
    let content: unknown;
    if (alpha) {
      const owners = await pool.query(
        `SELECT ownership.tester_id, access.session_id
           FROM nv_alpha_provider_session_ownership ownership
           JOIN nv_alpha_provider_bindings binding USING (tester_id, identity_key, provider)
           JOIN nv_alpha_sessions access USING (tester_id)
          WHERE ownership.session_key_hash=$1 AND ownership.identity_key=$2
            AND ownership.provider=$3 AND binding.authority=$4
            AND ownership.released_at IS NULL AND binding.disconnected_at IS NULL
            AND access.revoked_at IS NULL AND access.expires_at > now()
          ORDER BY access.last_seen_at DESC LIMIT 10`,
        [row.session_key_hash, key, scope.provider, scope.authority]
      );
      for (const owner of rowsOf(owners)) {
        if (alphaActorLabel({ testerId: owner.tester_id }) !== requestedBy) continue;
        try {
          const access = await readAlphaSession(owner.session_id);
          if (access.testerId !== owner.tester_id || !repositoryAllowed(access, scope)) continue;
          content = (await readOwnedSession({ testerId: owner.tester_id, sessionId: row.sid })).session;
          break;
        } catch { /* Expired, revoked or disconnected sessions cannot authorize a read. */ }
      }
    } else {
      try { content = unseal(row.data); } catch { continue; }
    }
    const accounts = read(content, 'accounts');
    for (const account of (content && Array.isArray(accounts) ? accounts as readonly unknown[] : [])) {
      if (!account || identityKey(account) !== key || (read(account, 'provider') || 'github') !== scope.provider
        || providerAuthority(account) !== scope.authority) continue;
      if (!alpha && String(read(account, 'login') || '') !== requestedBy) continue;
      try { return await resolveAccount(account); } catch { /* Try another currently owned session. */ }
    }
  }
  return null;
}
