/*
 * The workbench's folder move: every file under a folder linked under its new
 * place and removed from the old, in one commit on the head the files were
 * listed from. Moving into a folder that exists merges into it; moving onto a
 * file that exists is refused, as is a folder moved into itself, a tree too
 * large to list, a folder of more than 800 files, and a protected path.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { normalizeBranchName, normalizeRepoPath } from '../../corona/index.ts';
import type { CommitWriter, Gh } from '../application/commit-writer.ts';
import { assertExpectedHead, requireAggregateExpectedHead } from '../domain/head-checks.ts';
import { bodyField, listed, repositoryPath, text } from './provider-values.ts';

export interface FolderMoveRouteDeps {
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
  readonly commits: Pick<CommitWriter, 'commitTree'>;
  /* Refuses a change to a path the session's safeguards protect. */
  enforceProtectedPaths(req: Request, paths: readonly unknown[]): void;
}

export function registerFolderMoveRoute(app: Application, deps: FolderMoveRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail, gh } = deps;
  const R = repositoryPath;

  app.post('/api/repo/:owner/:repo/move-dir', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('folder.move'), auth, mutationContext('directory.move'), async (req: Request, res: Response) => {
    try {
      const { owner, repo } = req.params;
      const requestedFrom = bodyField(req, 'from');
      const requestedTo = bodyField(req, 'to');
      const requestedBranch = bodyField(req, 'branch');
      const message = bodyField(req, 'message');
      const requestedHead = bodyField(req, 'expectedHeadSha');
      if (!requestedFrom || !requestedTo || !requestedBranch) { res.status(400).json({ error: 'from, to, branch required' }); return; }
      const from = normalizeRepoPath(requestedFrom, 'source folder');
      const to = normalizeRepoPath(requestedTo, 'destination folder');
      const branch = normalizeBranchName(requestedBranch);
      const expectedHeadSha = requireAggregateExpectedHead(requestedHead);
      const src = from, dst = to;
      if (!src || !dst) { res.status(400).json({ error: 'Invalid paths' }); return; }
      if (dst === src) { res.status(400).json({ error: 'Destination equals source' }); return; }
      if ((dst + '/').startsWith(src + '/')) { res.status(400).json({ error: 'Cannot move a folder inside itself' }); return; }
      const ref = await gh(account(req), `${R(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
      const full = await gh(account(req), `${R(req)}/git/trees/${String(member(member(ref, 'object'), 'sha'))}?recursive=1`);
      if (member(full, 'truncated')) { res.status(413).json({ error: 'Repository tree too large for folder move' }); return; }
      const inside = listed(member(full, 'tree') || [], '(full.tree || []).filter').filter(e => (member(e, 'type') === 'blob' || member(e, 'type') === 'commit')
        && (member(e, 'path') === src || text(member(e, 'path'), 'e.path.startsWith').startsWith(src + '/')));
      if (!inside.length) { res.status(404).json({ error: 'Folder is empty or not found' }); return; }
      if (inside.length > 800) { res.status(413).json({ error: `Folder has ${inside.length} files — over the 800-file move limit` }); return; }
      const entries: Record<string, unknown>[] = [];
      const affectedPaths: unknown[] = [];
      const destinations: string[] = [];
      for (const e of inside) {
        const rest = text(member(e, 'path'), 'e.path.slice').slice(src.length);
        const destinationPath = dst + rest;
        affectedPaths.push(member(e, 'path'), destinationPath);
        destinations.push(destinationPath);
        entries.push({ path: destinationPath, mode: member(e, 'mode'), type: member(e, 'type'), sha: member(e, 'sha'), forceMode: true });
        entries.push({ path: member(e, 'path'), mode: member(e, 'mode'), type: member(e, 'type'), sha: null, forceMode: true });
      }
      deps.enforceProtectedPaths(req, affectedPaths);
      /*
       * Moving into a folder that already exists merges into it; moving onto a
       * file that exists would replace it, and is refused. The head the files
       * were listed from is the head the commit has to land on.
       */
      assertExpectedHead(expectedHeadSha, member(member(ref, 'object'), 'sha'));
      const commit = await deps.commits.commitTree(account(req), owner, repo, branch, message || `Move ${src} -> ${dst}`, entries, member(member(ref, 'object'), 'sha'), { mustNotExist: destinations });
      res.json({ ok: true, commit, moved: inside.length });
    } catch (e) { fail(res, e); }
  });
}
