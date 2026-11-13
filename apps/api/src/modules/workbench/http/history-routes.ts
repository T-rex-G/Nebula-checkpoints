/*
 * The workbench's history routes: a branch's commits a page at a time, a
 * commit with its changed files, and a commit reverted -- its inverse
 * committed on top of the branch's head, never a history rewrite.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { PRODUCT_NAME } from '../../../platform/release/version.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { normalizeBranchName, normalizeCommitSha } from '../../corona/index.ts';
import type { CommitWriter, Gh } from '../application/commit-writer.ts';
import { bodyField, firstLine, iterated, listed, repositoryPath } from './provider-values.ts';

export interface HistoryRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  readonly commits: CommitWriter;
  /* Why a change to these paths is refused by the session's safeguards, or nothing. */
  protectedPathError(req: Request, paths: readonly unknown[]): string;
}

export function registerHistoryRoutes(app: Application, deps: HistoryRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail, gh, commits } = deps;
  const R = repositoryPath;

  app.get('/api/repo/:owner/:repo/commits', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      /* One page of 25 in one shape for every provider: the list pages by the count it receives. */
      const page = Math.max(1, Math.min(1000, parseInt(String(req.query.page || '1'), 10) || 1));
      const pathFilter = req.query.path ? `&path=${encodeURIComponent(String(req.query.path))}` : '';
      const list = await gh(account(req),
        `${R(req)}/commits?sha=${encodeURIComponent(String(req.query.ref))}&per_page=25&page=${page}${pathFilter}`);
      res.json(listed(list, 'commits.map').map(c => ({
        sha: member(c, 'sha'), message: member(member(c, 'commit'), 'message'),
        author: (member(member(c, 'commit'), 'author') && member(member(member(c, 'commit'), 'author'), 'name')) || (member(c, 'author') && member(member(c, 'author'), 'login')) || '?',
        avatar: member(c, 'author') && member(member(c, 'author'), 'avatar_url'),
        date: member(member(c, 'commit'), 'author') && member(member(member(c, 'commit'), 'author'), 'date')
      })));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/commit/:sha', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      const c = await gh(account(req), `${R(req)}/commits/${encodeURIComponent(String(req.params.sha))}`);
      res.json({
        sha: member(c, 'sha'), message: member(member(c, 'commit'), 'message'), stats: member(c, 'stats'),
        files: listed(member(c, 'files') || [], '(c.files || []).map').map(f => ({
          filename: member(f, 'filename'), status: member(f, 'status'), additions: member(f, 'additions'), deletions: member(f, 'deletions'), patch: member(f, 'patch')
        }))
      });
    } catch (e) { fail(res, e); }
  });

  /* One commit reverted: its inverse applied on top of the branch's current head. */
  app.post('/api/repo/:owner/:repo/revert', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.revert'), async (req: Request, res: Response) => {
    try {
      const requestedSha = bodyField(req, 'sha');
      const requestedBranch = bodyField(req, 'branch');
      const expectedHeadSha = bodyField(req, 'expectedHeadSha');
      if (!requestedSha || !requestedBranch) { res.status(400).json({ error: 'sha and branch required' }); return; }
      const sha = normalizeCommitSha(requestedSha);
      const branch = normalizeBranchName(requestedBranch);
      const c = await gh(account(req), `${R(req)}/commits/${sha}`);
      const parents = member(c, 'parents') || [];
      if (member(parents, 'length') !== 1) {
        res.status(400).json({ error: 'Only non-merge commits can be reverted (this one has ' + String(member(member(c, 'parents') || [], 'length')) + ' parents)' });
        return;
      }
      const parentSha = member(member(member(c, 'parents'), '0'), 'sha');
      const parent = await gh(account(req), `${R(req)}/commits/${String(parentSha)}`);
      const ptree = await gh(account(req), `${R(req)}/git/trees/${String(member(member(member(parent, 'commit'), 'tree'), 'sha'))}?recursive=1`);
      if (member(ptree, 'truncated')) { res.status(400).json({ error: 'Repository too large for automatic revert' }); return; }
      const parentMap = new Map(listed(member(ptree, 'tree') || [], '(ptree.tree || []).filter')
        .filter(t => member(t, 'type') === 'blob' || member(t, 'type') === 'commit')
        .map(t => [member(t, 'path'), { sha: member(t, 'sha'), mode: member(t, 'mode'), type: member(t, 'type') }]));
      const entries: Record<string, unknown>[] = [];
      for (const f of iterated(member(c, 'files') || [])) {
        const prev = parentMap.get(member(f, 'filename'));
        const status = member(f, 'status');
        if (status === 'added' || status === 'copied') {
          entries.push({ path: member(f, 'filename'), mode: '100644', type: 'blob', sha: null });
        } else if (status === 'renamed') {
          entries.push({ path: member(f, 'filename'), mode: '100644', type: 'blob', sha: null });
          const old = parentMap.get(member(f, 'previous_filename'));
          if (old) entries.push({ path: member(f, 'previous_filename'), mode: old.mode, type: old.type, sha: old.sha, forceMode: true });
        } else if (prev) { /* removed | modified | changed */
          entries.push({ path: member(f, 'filename'), mode: prev.mode, type: prev.type, sha: prev.sha, forceMode: true });
        }
      }
      if (!entries.length) { res.status(400).json({ error: 'Nothing to revert in that commit' }); return; }
      const protectedError = deps.protectedPathError(req, entries.map(entry => entry.path));
      if (protectedError) { res.status(423).json({ error: protectedError, locked: true }); return; }
      const msg = `Revert "${firstLine(member(member(c, 'commit'), 'message') || '', '(c.commit.message || "").split')}" (${sha.slice(0, 7)}) via ${PRODUCT_NAME}`;
      const commit = await commits.commitTree(account(req), req.params.owner, req.params.repo, branch, msg, entries, expectedHeadSha);
      res.json({ ok: true, commit, changed: entries.length });
    } catch (e) { fail(res, e); }
  });
}
