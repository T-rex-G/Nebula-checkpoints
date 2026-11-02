/*
 * Corona's recovery routes, in two registrations because the route policy
 * keeps them apart (test/oracles/route-policy.json): the commit recoveries --
 * a whole repository or some of its paths restored as a new commit, a
 * commit's file listing, and a branch moved back -- among the repository's
 * write routes; and the snapshot routes -- a snapshot of the references, a
 * comparison and a restore preview, signed snapshots and the emergency
 * manifest, and the restore that spends a preview's grant -- after the
 * safeguards.
 *
 * The guards are handed in under the names the route policy records.
 */
import crypto from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import { PRODUCT_NAME } from '../../../platform/release/version.ts';
import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { member, read } from '../../../platform/values/fields.ts';
import { normalizeBranchName, normalizeCommitSha, normalizeRepoPath } from '../domain/recovery-names.ts';
import type { SnapshotSignatures } from '../domain/snapshot-signatures.ts';
import type { Recovery, RepositoryTarget } from '../application/recovery.ts';
import { RESTORE_AUTH_TTL_MS } from '../application/recovery.ts';

/* The guards every recovery route stands behind. */
export interface RecoveryGuards {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => unknown;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  gh(account: unknown, apiPath: string, options?: { readonly method?: string; readonly body?: unknown }): Promise<unknown>;
}

export interface CommitRecoveryDeps extends RecoveryGuards {
  /* A commit of tree entries onto a branch, at the head it was expected to be at (the workbench's). */
  commitTree(account: unknown, owner: unknown, repo: unknown, branch: string, message: string, entries: readonly unknown[], expectedHeadSha?: unknown): Promise<unknown>;
  /* Refuses a change to a path the session's safeguards protect. */
  enforceProtectedPaths(req: Request, paths: readonly unknown[]): void;
  /* Refuses a branch that is not at the head this view was loaded at. */
  assertExpectedHead(expectedHeadSha: unknown, actualHeadSha: unknown): void;
  /* The error a branch that moved underneath a write is answered with. */
  branchChangedError(): Error;
  /* The head an aggregate change must state. */
  requireAggregateExpectedHead(expectedHeadSha: unknown): string;
}

/* The safety state as the server normalizes it. */
export interface SafetyState {
  readonly readOnly: boolean;
  readonly freezeSync: boolean;
  readonly protected: Readonly<Record<string, { readonly length: number }>>;
}

export interface SnapshotDeps extends RecoveryGuards {
  readonly recovery: Recovery;
  dbReady(): Promise<unknown>;
  pool(): Queryable;
  identityKey(account: unknown): string;
  scopedEvidenceKey(provider: unknown, owner: unknown, repo: unknown, identity: unknown): string;
  appendEvidence(key: string, kind: string, recordId: string, payload: unknown): Promise<unknown>;
  readonly signatures: Pick<SnapshotSignatures, 'sign' | 'verify' | 'activeKeyId'>;
  /* How many signed snapshots an identity keeps for a repository. */
  readonly retentionCount: number;
  /* The session's safeguards, and the protected patterns that apply to this repository. */
  safetyOf(req: Request): SafetyState;
  protectedPatternsForReq(req: Request): readonly unknown[];
  readonly alphaEnabled: boolean;
  /* Commits a safety change for the identity, and the session's copy of it. */
  savePersistentSafety(req: Request, patch: unknown): Promise<SafetyState>;
  saveSessionSafetyCopy(req: Request, res: Response): Promise<unknown>;
  /* The identity's other sessions, their revocation, and the live streams they held. */
  /* The identity's sessions as the inventory read them from the store. */
  sessionsForIdentity(req: Request): Promise<{ readonly available: boolean; readonly rows: readonly { readonly sid?: unknown; readonly current?: unknown }[] }>;
  revokeContainedSessions(req: Request, sessionIds: readonly unknown[]): Promise<readonly unknown[]>;
  closeLiveSessions(sessionIds: readonly unknown[], reason: string): unknown;
  retainedActor(req: Request): unknown;
  /* The mutation gateway's operations so far in this request. */
  executionSnapshot(): { readonly operationIds: readonly unknown[] } | null;
}

/* A request body's field, as destructuring `req.body || {}` reads it. */
function field(req: Request, name: string): unknown {
  return member(req.body || {}, name);
}

/* A commit message's first line, as `(message || '').split('\n')[0]` reads it: anything but text has no lines. */
function firstLine(message: unknown): string {
  const text = message || '';
  if (typeof text !== 'string') throw new TypeError('(message || "").split is not a function');
  return text.split('\n')[0] || '';
}

/* `value.startsWith(prefix)`, as JavaScript calls it on a provider's path. */
function startsWith(value: unknown, prefix: string): boolean {
  if (typeof value !== 'string') throw new TypeError('t.path.startsWith is not a function');
  return value.startsWith(prefix);
}

/* `list.filter(...)`, as JavaScript calls it on a provider's answer. */
function listed(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what}.filter is not a function`);
  return value;
}

/* The repository a request names, and its API path. */
function targetOf(req: Request, account: unknown): RepositoryTarget {
  return { account, owner: req.params.owner, repo: req.params.repo };
}
function repositoryPath(req: Request): string {
  return `/repos/${req.params.owner}/${req.params.repo}`;
}

/* Every kept snapshot past the newest few, for this identity and repository, goes. */
const RETENTION_SQL = `DELETE FROM nv_recovery_snapshots WHERE snapshot_id IN (
         SELECT snapshot_id FROM nv_recovery_snapshots
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4
         ORDER BY created_at DESC, snapshot_id DESC OFFSET $5
       )`;

export function registerCommitRecoveryRoutes(app: Application, deps: CommitRecoveryDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail } = deps;

  /* Restore the whole repository to how it was at a commit, as a new commit: history is preserved. */
  app.post('/api/repo/:owner/:repo/restore', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.restore'), async (req: Request, res: Response) => {
    try {
      const suppliedSha = field(req, 'sha');
      const suppliedBranch = field(req, 'branch');
      const expectedHeadSha = field(req, 'expectedHeadSha');
      if (!suppliedSha || !suppliedBranch) { res.status(400).json({ error: 'sha and branch required' }); return; }
      const sha = normalizeCommitSha(suppliedSha);
      const branch = normalizeBranchName(suppliedBranch);
      const target = await deps.gh(account(req), `${repositoryPath(req)}/commits/${sha}`);
      const ref = await deps.gh(account(req), `${repositoryPath(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
      deps.assertExpectedHead(expectedHeadSha, member(member(ref, 'object'), 'sha'));
      const commit = await deps.gh(account(req), `${repositoryPath(req)}/git/commits`, {
        method: 'POST',
        body: {
          message: `Restore repository to ${sha.slice(0, 7)} ("${firstLine(member(member(target, 'commit'), 'message'))}") via ${PRODUCT_NAME}`,
          tree: member(member(member(target, 'commit'), 'tree'), 'sha'),
          parents: [member(member(ref, 'object'), 'sha')]
        }
      });
      try {
        await deps.gh(account(req), `${repositoryPath(req)}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: 'PATCH', body: { sha: member(commit, 'sha'), force: false }
        });
      } catch (error) {
        if (member(error, 'status') === 409 || member(error, 'status') === 422) throw deps.branchChangedError();
        throw error;
      }
      res.json({ ok: true, commit: member(commit, 'sha') });
    } catch (e) { fail(res, e); }
  });

  /* Restore specific files or folders from an old commit onto the current branch. */
  app.post('/api/repo/:owner/:repo/restore-paths', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.restore-paths'), async (req: Request, res: Response) => {
    try {
      const suppliedSha = field(req, 'sha');
      const suppliedBranch = field(req, 'branch');
      const prefix = field(req, 'prefix');
      const suppliedHead = field(req, 'expectedHeadSha');
      if (!suppliedSha || !suppliedBranch || !prefix) { res.status(400).json({ error: 'sha, branch and prefix required' }); return; }
      const sha = normalizeCommitSha(suppliedSha);
      const branch = normalizeBranchName(suppliedBranch);
      const expectedHeadSha = deps.requireAggregateExpectedHead(suppliedHead);
      const clean = normalizeRepoPath(prefix, 'restore path');
      const target = await deps.gh(account(req), `${repositoryPath(req)}/commits/${sha}`);
      const ttree = await deps.gh(account(req), `${repositoryPath(req)}/git/trees/${String(member(member(member(target, 'commit'), 'tree'), 'sha'))}?recursive=1`);
      if (member(ttree, 'truncated')) { res.status(400).json({ error: 'Repository too large for path restore' }); return; }
      const matches = listed(member(ttree, 'tree') || [], '(ttree.tree || [])').filter(entry =>
        (member(entry, 'type') === 'blob' || member(entry, 'type') === 'commit') && (member(entry, 'path') === clean || startsWith(member(entry, 'path'), clean + '/')));
      if (!matches.length) { res.status(404).json({ error: `Nothing at "${clean}" in commit ${sha.slice(0, 7)}` }); return; }
      if (matches.length > 500) { res.status(400).json({ error: `${matches.length} files match — restore a narrower path (max 500)` }); return; }
      deps.enforceProtectedPaths(req, matches.map(item => member(item, 'path')));
      const entries = matches.map(entry => ({ path: member(entry, 'path'), mode: member(entry, 'mode'), type: member(entry, 'type'), sha: member(entry, 'sha'), forceMode: true }));
      const commit = await deps.commitTree(account(req), req.params.owner, req.params.repo, branch,
        `Restore ${clean} from ${sha.slice(0, 7)} via ${PRODUCT_NAME}`, entries, expectedHeadSha);
      res.json({ ok: true, commit, restored: entries.length });
    } catch (e) { fail(res, e); }
  });

  /* A commit's snapshot: the full file listing of the repository as it existed then. */
  app.get('/api/repo/:owner/:repo/snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      const supplied: unknown = req.query.sha;
      if (!supplied) { res.status(400).json({ error: 'sha required' }); return; }
      const sha = normalizeCommitSha(supplied);
      const commit = await deps.gh(account(req), `${repositoryPath(req)}/commits/${sha}`);
      const tree = await deps.gh(account(req), `${repositoryPath(req)}/git/trees/${String(member(member(member(commit, 'commit'), 'tree'), 'sha'))}?recursive=1`);
      const files = listed(member(tree, 'tree') || [], '(t.tree || [])').filter(entry => member(entry, 'type') === 'blob' || member(entry, 'type') === 'commit')
        .map(entry => ({ path: member(entry, 'path'), sha: member(entry, 'sha'), size: member(entry, 'size') || 0, mode: member(entry, 'mode'), type: member(entry, 'type') }));
      res.json({
        sha, truncated: !!member(tree, 'truncated'), count: files.length,
        files: files.slice(0, 4000)
      });
    } catch (e) { fail(res, e); }
  });

  /* A hard reset: the branch pointer moved back, erasing later commits from it. */
  app.post('/api/repo/:owner/:repo/reset', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('branch.reset'), async (req: Request, res: Response) => {
    try {
      const suppliedSha = field(req, 'sha');
      const suppliedBranch = field(req, 'branch');
      const expectedHeadSha = field(req, 'expectedHeadSha');
      if (!suppliedSha || !suppliedBranch) { res.status(400).json({ error: 'sha and branch required' }); return; }
      const sha = normalizeCommitSha(suppliedSha);
      const branch = normalizeBranchName(suppliedBranch);
      if (expectedHeadSha) {
        const ref = await deps.gh(account(req), `${repositoryPath(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
        deps.assertExpectedHead(expectedHeadSha, member(member(ref, 'object'), 'sha'));
      }
      await deps.gh(account(req), `${repositoryPath(req)}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH', body: { sha, force: true }
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

export function registerSnapshotRoutes(app: Application, deps: SnapshotDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail, recovery } = deps;
  const providerOf = (req: Request): unknown => member(account(req), 'provider') || 'github';

  app.get('/api/repo/:owner/:repo/refs-snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), capabilityAccess('branches.read'), auth, async (req: Request, res: Response) => {
    try { res.json(await recovery.captureRefsSnapshot(targetOf(req, account(req)), req.query.manifest === '1')); }
    catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/snapshot-compare', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      const result = await recovery.compareWith(targetOf(req, account(req)), req.body && read(req.body, 'snapshot'));
      res.json({
        kind: 'nebulaverse-snapshot-comparison', version: 1, generatedAt: new Date().toISOString(),
        baselineCapturedAt: member(result.baseline, 'capturedAt') || null,
        currentCapturedAt: result.current.capturedAt,
        comparison: result.comparison
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/restore-preview', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      const result = await recovery.compareWith(targetOf(req, account(req)), req.body && read(req.body, 'snapshot'));
      const currentByName = new Map((result.current.refs || []).map(ref => [ref.name, ref]));
      const actions: { name: string; action: 'reset' | 'recreate'; from: unknown; to: unknown; protected: boolean }[] = [];
      for (const item of result.comparison.refs.move) {
        const current = currentByName.get(item.name);
        actions.push({ name: item.name, action: 'reset', from: item.current, to: item.expected, protected: !!(current && current.protected) });
      }
      for (const item of result.comparison.refs.recreate) {
        actions.push({ name: item.name, action: 'recreate', from: '', to: item.expected, protected: false });
      }
      const warnings: string[] = [];
      if (member(result.baseline, 'refsTruncated')) warnings.push('The snapshot branch inventory was truncated.');
      if (member(result.baseline, 'tagsTruncated')) warnings.push('The snapshot tag inventory was truncated. Tags are compared but not changed by ref restore.');
      if (result.comparison.truncated) warnings.push('At least one file manifest is truncated, so file counts are incomplete.');
      const requiresReset = actions.some(action => action.action === 'reset');
      if (requiresReset) warnings.push('Existing branch resets are unavailable: this provider API has no expected-old compare-and-swap. Use commit restoration to recover file contents while preserving newer commits.');
      if (actions.length > 50) warnings.push('This preview contains more than 50 branch changes. Split recovery into smaller, reviewed snapshots before restoring.');
      if (deps.protectedPatternsForReq(req).length) warnings.push('Nebulaverse-X protected-path policies are active. The actual restore remains blocked until those policies are unlocked.');
      if (deps.safetyOf(req).readOnly) warnings.push('Nebulaverse-X read-only mode is active. Disable it before restoring branch references.');
      const canRestore = !requiresReset && result.comparison.compatible && actions.length > 0 && actions.length <= 50 && !member(result.baseline, 'refsTruncated') && !deps.protectedPatternsForReq(req).length && !deps.safetyOf(req).readOnly;
      const authorization = canRestore ? recovery.createRestoreAuthorization(targetOf(req, account(req)), actions) : '';
      res.json({
        kind: 'nebulaverse-restore-preview', version: 1, generatedAt: new Date().toISOString(),
        repository: `${req.params.owner}/${req.params.repo}`,
        canRestore,
        authorization,
        authorizationExpiresInSeconds: canRestore ? Math.floor(RESTORE_AUTH_TTL_MS / 1000) : 0,
        actions,
        preservedBranches: result.comparison.refs.preserve,
        unchangedBranches: result.comparison.refs.unchanged,
        fileImpact: result.comparison.files,
        counts: result.comparison.counts,
        warnings
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/signed-snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      if (!(await deps.dbReady())) { res.status(503).json({ error: 'Signed snapshots require the existing Neon DATABASE_URL' }); return; }
      const includeManifest = !(req.body && read(req.body, 'manifest') === false);
      const snapshot = await recovery.captureRefsSnapshot(targetOf(req, account(req)), includeManifest);
      const snapshotId = crypto.randomUUID();
      const signature = deps.signatures.sign(snapshotId, snapshot);
      const provider = providerOf(req);
      const identity = deps.identityKey(account(req));
      await deps.pool().query(
        `INSERT INTO nv_recovery_snapshots(snapshot_id,provider,owner,repo,identity_key,snapshot,signature)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [snapshotId, provider, req.params.owner, req.params.repo, identity, JSON.stringify(snapshot), signature]
      );
      await deps.pool().query(RETENTION_SQL, [provider, req.params.owner, req.params.repo, identity, deps.retentionCount]);
      const evidence = await deps.appendEvidence(deps.scopedEvidenceKey(provider, req.params.owner, req.params.repo, identity), 'recovery-snapshot', snapshotId, { snapshot, signature });
      res.status(201).json({
        snapshotId,
        signature,
        signatureKeyId: deps.signatures.activeKeyId,
        evidence,
        snapshot
      });
    } catch (e) { fail(res, e); }
  });

  /*
   * Emergency containment: the references captured, the identity's
   * repositories made read-only and their sync frozen, the identity's other
   * sessions revoked and their live streams closed, all in one signed
   * manifest. A hosted alpha scopes every change to a repository, so it
   * refuses these identity-wide controls.
   */
  app.post('/api/repo/:owner/:repo/emergency-manifest', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), capabilityAccess('branches.read'), auth, async (req: Request, res: Response) => {
    try {
      if (String((req.body && read(req.body, 'confirm')) || '').toUpperCase() !== 'FREEZE') {
        res.status(400).json({ error: 'Type FREEZE to confirm emergency containment' });
        return;
      }
      if (deps.alphaEnabled) {
        res.status(403).json({
          error: 'Emergency Shield changes identity-wide controls, which are unavailable in a repository-scoped alpha. Use repository Safeguards and session revocation instead.',
          code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED'
        });
        return;
      }
      const captured = await recovery.captureRefsSnapshot(targetOf(req, account(req)), true);
      Object.assign(req, { effectiveSafety: await deps.savePersistentSafety(req, { readOnly: true, freezeSync: true }) });
      /* Once the controls have committed, containment finishes even if this session ended meanwhile. */
      await deps.saveSessionSafetyCopy(req, res);

      const inventory = await deps.sessionsForIdentity(req);
      const requestedRevocations = inventory.available
        ? inventory.rows.filter(row => !row.current).map(row => row.sid)
        : [];
      const revokedIds = await deps.revokeContainedSessions(req, requestedRevocations);
      const streamsClosed = deps.closeLiveSessions(revokedIds, 'emergency-containment');

      const manifestId = crypto.randomUUID();
      const manifest = {
        ...captured,
        kind: 'nebulaverse-emergency-manifest',
        version: 1,
        incidentId: manifestId,
        activatedAt: new Date().toISOString(),
        activatedBy: deps.retainedActor(req),
        controls: {
          readOnly: true,
          freezeSync: true,
          sessionsRevoked: revokedIds.length,
          streamsClosed,
          sessionRevocationAvailable: !!inventory.available
        }
      };
      const signature = deps.signatures.sign(manifestId, manifest);
      const signatureVerification = deps.signatures.verify(signature, manifestId, manifest);
      if (!signatureVerification.valid) {
        throw Object.assign(new Error('Emergency manifest signature verification failed'), { code: 'SNAPSHOT_SIGNATURE_VERIFICATION_FAILED' });
      }
      let persisted = false;
      let evidence: unknown = null;
      if (await deps.dbReady()) {
        const provider = providerOf(req);
        const identity = deps.identityKey(account(req));
        await deps.pool().query(
          `INSERT INTO nv_recovery_snapshots(snapshot_id,provider,owner,repo,identity_key,snapshot,signature)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [manifestId, provider, req.params.owner, req.params.repo, identity, JSON.stringify(manifest), signature]
        );
        await deps.pool().query(RETENTION_SQL, [provider, req.params.owner, req.params.repo, identity, deps.retentionCount]);
        evidence = await deps.appendEvidence(deps.scopedEvidenceKey(provider, req.params.owner, req.params.repo, identity), 'emergency-manifest', manifestId, { manifest, signature });
        persisted = true;
      }
      res.status(201).json({
        manifestId,
        signature,
        signatureKeyId: signatureVerification.keyId,
        signatureValid: signatureVerification.valid,
        persisted,
        evidence,
        manifest
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/signed-snapshots', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      if (!(await deps.dbReady())) { res.json({ available: false, snapshots: [] }); return; }
      const found = await deps.pool().query(
        `SELECT snapshot_id,snapshot,signature,created_at FROM nv_recovery_snapshots
       WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4
       ORDER BY created_at DESC LIMIT 25`,
        [providerOf(req), req.params.owner, req.params.repo, deps.identityKey(account(req))]
      );
      res.json({ available: true, snapshots: rowsOf(found).map(row => {
        const verification = deps.signatures.verify(member(row, 'signature'), member(row, 'snapshot_id'), member(row, 'snapshot'));
        return {
          snapshotId: member(row, 'snapshot_id'),
          signature: member(row, 'signature'),
          signatureValid: verification.valid,
          signatureKeyId: verification.keyId,
          signatureLegacy: verification.legacy,
          createdAt: member(row, 'created_at'),
          snapshot: member(row, 'snapshot')
        };
      }) });
    } catch (e) { fail(res, e); }
  });

  /*
   * The restore a preview authorized: only recreations, since the provider
   * has no compare-and-swap for moving an existing branch; refused when any
   * branch head changed since the preview; and the grant spent only then,
   * immediately before the references are written.
   */
  app.post('/api/repo/:owner/:repo/restore-refs', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('recovery.restore-refs'), async (req: Request, res: Response) => {
    try {
      const authorization = field(req, 'authorization');
      const confirm = field(req, 'confirm');
      if (String(confirm || '').toUpperCase() !== 'RESTORE') { res.status(400).json({ error: 'Type RESTORE to confirm recovery', code: 'RESTORE_CONFIRMATION_REQUIRED' }); return; }
      const grant = recovery.prepareRestoreAuthorization(targetOf(req, account(req)), authorization);
      if (grant.actions.some(action => action.action !== 'recreate')) {
        res.status(409).json({
          error: 'Resetting an existing branch requires provider-enforced expected-old comparison. Use commit restoration to preserve concurrent work.',
          code: 'RESTORE_ATOMIC_RESET_UNAVAILABLE'
        });
        return;
      }
      const conflicts = await recovery.preflightRestoreActions(targetOf(req, account(req)), grant.actions);
      if (conflicts.length) {
        res.status(409).json({
          error: 'Repository branch heads changed after the recovery preview. Generate a new preview before restoring.',
          code: 'RESTORE_PREVIEW_STALE', conflicts
        });
        return;
      }
      await recovery.claimRestoreAuthorization(grant);
      const report: Record<string, unknown>[] = [];
      for (const action of grant.actions) {
        try {
          /* The provider creates only absent references: a branch created after the preflight is refused, not overwritten. */
          await deps.gh(account(req), `${repositoryPath(req)}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${action.name}`, sha: action.to } });
          const execution = deps.executionSnapshot();
          report.push({
            name: action.name, ok: true, action: 'recreated',
            operationId: (execution && execution.operationIds[execution.operationIds.length - 1]) || null
          });
        } catch (error) {
          const execution = deps.executionSnapshot();
          report.push({
            name: action.name, ok: false,
            operationId: (execution && execution.operationIds[execution.operationIds.length - 1]) || null,
            error: cleanText(member(error, 'message') || 'Provider rejected branch recovery', 300)
          });
        }
      }
      const ok = report.every(item => item.ok);
      const mutation = member(req, 'mutation');
      const metadata = mutation && member(mutation, 'metadata');
      res.json({
        ok, partialFailure: !ok && report.some(item => item.ok), previewBound: true,
        batchHash: (metadata && member(metadata, 'batchHash')) || null,
        report
      });
    } catch (e) { fail(res, e); }
  });
}

function rowsOf(result: unknown): readonly unknown[] {
  const rows = member(result, 'rows');
  if (!Array.isArray(rows)) throw new TypeError('r.rows.map is not a function');
  return rows;
}
