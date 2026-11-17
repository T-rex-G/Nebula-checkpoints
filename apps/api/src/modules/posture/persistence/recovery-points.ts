import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { dateFrom } from '../../../platform/values/fields.ts';

/*
 * The recovery points an identity holds, per repository: the newest and how
 * many. Read from the snapshots Corona keeps, never written here.
 */
export interface RecoveryPoint {
  readonly owner: unknown;
  readonly repo: unknown;
  readonly latestAt: string | null;
  readonly points: number;
}

export async function recoveryPoints(db: Queryable, provider: string, identityKey: string): Promise<RecoveryPoint[]> {
  const result = await db.query(
    `SELECT owner, repo, max(created_at) AS latest, count(*) AS points FROM nv_recovery_snapshots
        WHERE provider=$1 AND identity_key=$2
        GROUP BY owner, repo ORDER BY max(created_at) DESC LIMIT 500`,
    [provider, identityKey]
  );
  const rows = result.rows;
  if (!rows) throw new TypeError('The recovery points query answered no rows');
  return rows.map(row => ({
    owner: row.owner,
    repo: row.repo,
    latestAt: row.latest ? dateFrom(row.latest).toISOString() : null,
    points: Number(row.points) || 0
  }));
}
