/*
 * Corona's evidence route: the identity's evidence chain for one repository,
 * verified link by link, with the repository's recorded events and its signed
 * snapshots, each signature checked again as it is read. Without a database
 * the chain says it is unavailable and there is nothing else to read.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { member } from '../../../platform/values/fields.ts';
import type { SnapshotSignatures } from '../domain/snapshot-signatures.ts';

export interface EvidenceDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly account: (req: Request) => unknown;
  readonly fail: (res: Response, error: unknown) => unknown;
  identityKey(account: unknown): string;
  scopedEvidenceKey(provider: unknown, owner: unknown, repo: unknown, identity: unknown): string;
  /* The chain under a key, verified from its first record, up to a limit. */
  verifyEvidenceChain(key: string, limit: number): Promise<Record<string, unknown>>;
  dbReady(): Promise<unknown>;
  pool(): Queryable;
  readonly signatures: Pick<SnapshotSignatures, 'verify'>;
}

/* `result.rows`, as a query answers them. */
function rowsOf(result: unknown, what: string): readonly unknown[] {
  const rows = member(result, 'rows');
  if (!Array.isArray(rows)) throw new TypeError(`${what}.rows.map is not a function`);
  return rows;
}

export function registerEvidenceRoutes(app: Application, deps: EvidenceDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account, fail } = deps;

  app.get('/api/repo/:owner/:repo/evidence', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, async (req: Request, res: Response) => {
    try {
      const identity = deps.identityKey(account(req));
      const key = deps.scopedEvidenceKey(member(account(req), 'provider') || 'github', req.params.owner, req.params.repo, identity);
      const chain = await deps.verifyEvidenceChain(key, 5000);
      if (!(await deps.dbReady())) { res.json({ available: false, chain, events: [], snapshots: [] }); return; }
      const [events, snapshots] = await Promise.all([
        deps.pool().query(
          `SELECT event_id,event_type,actor,severity,risk_score,summary,reasons,created_at FROM nv_intelligence_events
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4 ORDER BY created_at DESC LIMIT 500`,
          [member(account(req), 'provider') || 'github', req.params.owner, req.params.repo, identity]
        ),
        deps.pool().query(
          `SELECT snapshot_id,signature,created_at,snapshot FROM nv_recovery_snapshots
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4 ORDER BY created_at DESC LIMIT 50`,
          [member(account(req), 'provider') || 'github', req.params.owner, req.params.repo, identity]
        )
      ]);
      const evidenceRecords = chain.records || [];
      const chainSummary = { ...chain };
      delete chainSummary.records;
      res.json({
        kind: 'nebulaverse-evidence', version: 1, generatedAt: new Date().toISOString(),
        repository: `${req.params.owner}/${req.params.repo}`, chain: chainSummary,
        records: evidenceRecords,
        events: member(events, 'rows'),
        snapshots: rowsOf(snapshots, 'snapshots').map(row => {
          const verification = deps.signatures.verify(member(row, 'signature'), member(row, 'snapshot_id'), member(row, 'snapshot'));
          return {
            ...Object(row),
            signature_valid: verification.valid,
            signature_key_id: verification.keyId,
            signature_legacy: verification.legacy
          };
        })
      });
    } catch (e) { fail(res, e); }
  });
}
