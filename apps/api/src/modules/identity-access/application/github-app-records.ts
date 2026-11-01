/*
 * A GitHub App installation's record and its audit trail.
 *
 * Every lifecycle event is logged as a line of JSON and, where the database
 * is ready, kept in nv_github_app_audit with only the details
 * domain/github-app-audit.ts allows. In the hosted alpha the installation id
 * is never kept, and the actor is a tester's label: the one the caller
 * supplies when it is in shape, or else the tester the identity is bound to
 * when there is exactly one -- an identity two testers share names neither.
 *
 * Outside the alpha an installation's non-secret metadata is kept per
 * identity, and removed when the installation is disconnected. The alpha
 * keeps none of it here: its provider bindings are the privacy store's.
 */
import { randomUUID } from 'node:crypto';
import { cleanText } from '../../../platform/values/text.ts';
import { alphaActorLabel } from '../domain/alpha-privacy.ts';
import { safeGithubAppAuditDetails } from '../domain/github-app-audit.ts';

type Rows = { readonly rows: readonly Readonly<Record<string, unknown>>[] };

export interface GithubAppRecordsDeps {
  readonly alphaEnabled: boolean;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => { query(text: string, values?: readonly unknown[]): Promise<Rows> };
}

/* An installation as GitHub describes it, and the person who authorized it. */
export interface InstallationRecord {
  readonly id: unknown;
  readonly account: { readonly login: unknown; readonly id: unknown; readonly type: unknown };
  readonly repositorySelection: unknown;
  readonly permissions?: unknown;
  readonly suspendedAt?: unknown;
}
export interface AuthorizingUser { readonly login: unknown; readonly id: unknown }

export function createGithubAppRecords(deps: GithubAppRecordsDeps) {
  async function retainedProviderActor(identity: unknown): Promise<string> {
    if (!deps.alphaEnabled || !(await deps.ready())) return '';
    const result = await deps.pool().query(
      `SELECT DISTINCT tester_id FROM nv_alpha_provider_bindings
      WHERE identity_key=$1 AND disconnected_at IS NULL
      ORDER BY tester_id LIMIT 2`,
      [identity]
    );
    return result.rows.length === 1
      ? alphaActorLabel({ testerId: (result.rows[0] as Readonly<Record<string, unknown>>).tester_id })
      : '';
  }

  async function recordGithubAppAudit(identity: unknown, eventType: unknown, installationId: unknown, details: unknown = {}): Promise<boolean> {
    const identityKeyValue = cleanText(String(identity || 'system:github-app'), 128);
    const type = cleanText(String(eventType || 'github-app.event'), 100);
    const id = Number(installationId);
    const safeId = !deps.alphaEnabled && Number.isSafeInteger(id) && id > 0 ? id : null;
    const safeDetails = safeGithubAppAuditDetails(details);
    if (deps.alphaEnabled) {
      const supplied = /^alpha:[0-9a-f]{12}$/.test(String(safeDetails.actor || ''))
        ? safeDetails.actor
        : '';
      const actor = supplied || await retainedProviderActor(identityKeyValue);
      if (actor) safeDetails.actor = actor;
      else delete safeDetails.actor;
    }
    console.log(JSON.stringify({
      t: new Date().toISOString(), event: 'github-app-lifecycle', type,
      identityKey: identityKeyValue, installationId: safeId, details: safeDetails
    }));
    if (!(await deps.ready())) return false;
    await deps.pool().query(
      `INSERT INTO nv_github_app_audit(event_id,identity_key,event_type,installation_id,details,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,now())`,
      [randomUUID(), identityKeyValue, type, safeId, JSON.stringify(safeDetails)]
    );
    return true;
  }

  async function persistGithubAppInstallation(identity: unknown, installation: InstallationRecord, authorizedUser: AuthorizingUser, status = 'connected'): Promise<boolean> {
    if (deps.alphaEnabled) return false;
    if (!(await deps.ready())) return false;
    await deps.pool().query(
      `INSERT INTO nv_github_app_installations(
       identity_key,installation_id,account_login,account_id,account_type,authorized_by_login,authorized_by_id,
       repository_selection,permissions,status,suspended_at,connected_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now(),now())
     ON CONFLICT(identity_key,installation_id) DO UPDATE SET
       account_login=EXCLUDED.account_login,account_id=EXCLUDED.account_id,account_type=EXCLUDED.account_type,
       authorized_by_login=EXCLUDED.authorized_by_login,authorized_by_id=EXCLUDED.authorized_by_id,
       repository_selection=EXCLUDED.repository_selection,permissions=EXCLUDED.permissions,status=EXCLUDED.status,
       suspended_at=EXCLUDED.suspended_at,updated_at=now()`,
      [
        identity, installation.id, installation.account.login, installation.account.id, installation.account.type,
        authorizedUser.login, authorizedUser.id, installation.repositorySelection,
        JSON.stringify(installation.permissions || {}), status, installation.suspendedAt || null
      ]
    );
    return true;
  }

  async function removeGithubAppInstallation(identity: unknown, installationId: unknown): Promise<boolean> {
    if (!(await deps.ready())) return false;
    await deps.pool().query(
      'DELETE FROM nv_github_app_installations WHERE identity_key=$1 AND installation_id=$2',
      [identity, installationId]
    );
    return true;
  }

  return { retainedProviderActor, recordGithubAppAudit, persistGithubAppInstallation, removeGithubAppInstallation };
}

export type GithubAppRecords = ReturnType<typeof createGithubAppRecords>;
