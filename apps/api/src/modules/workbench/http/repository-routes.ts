/*
 * The workbench's repository routes: the repositories a session may see and
 * a new one, a repository's view with its branches and what the account may
 * do there, its deletion, its archive, a branch created or deleted, and two
 * refs compared.
 *
 * The guards are handed in under the names the route policy records.
 */
import { pipeline } from 'node:stream/promises';
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { createVerifiedRepository, normalizeProviderBranches, verifyRepositoryDeletion } from '../../github-provider/index.ts';
import { normalizeBranchName } from '../../corona/index.ts';
import { siteCheck } from '../../parallax/index.ts';
import type { Gh } from '../application/commit-writer.ts';
import type { ListRepositories } from '../application/repository-list.ts';
import { repositoryPermission } from '../domain/repository-view.ts';
import { bodyField, firstLine, fromWebBody, listed, repositoryPath, sliced, text } from './provider-values.ts';

export interface RepositoryRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  /* A hosted alpha's refusal of a repository list it cannot filter. */
  readonly alphaRepositoryListAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  /* A hosted alpha's refusal of a new repository, and the confirmation a deletion must carry. */
  readonly repositoryCreationAccess: RequestHandler;
  readonly repositoryDeletionConfirmation: RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  readonly listRepositories: ListRepositories;
  /* The repository's archive, its redirect to the codeload host followed and checked. */
  archiveResponse(account: Fields, owner: string, repo: string, ref: unknown): Promise<globalThis.Response>;
}

export function registerRepositoryRoutes(app: Application, deps: RepositoryRouteDeps): void {
  const {
    providerSessionAccess, alphaRepositoryListAccess, alphaRepositoryAccess, capabilityAccess,
    repositoryCreationAccess, repositoryDeletionConfirmation, auth, mutationContext, account, fail, gh
  } = deps;
  const R = repositoryPath;

  app.get('/api/repos', providerSessionAccess, alphaRepositoryListAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      res.json(await deps.listRepositories(req, req.query));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repos', providerSessionAccess, capabilityAccess('repository.create'), repositoryCreationAccess, auth, mutationContext('repository.create'), async (req: Request, res: Response) => {
    try {
      const result = await createVerifiedRepository((route, options) => gh(account(req), route, options), account(req), req.body);
      res.status(201).json(result);
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), capabilityAccess('branches.read'), auth, async (req: Request, res: Response) => {
    try {
      const [info, branches] = await Promise.all([
        gh(account(req), R(req)),
        gh(account(req), `${R(req)}/branches?per_page=100`)
      ]);
      res.json({
        full_name: member(info, 'full_name'), default_branch: member(info, 'default_branch'),
        private: member(info, 'private'), description: member(info, 'description'),
        homepage: siteCheck.declaredSite(member(info, 'homepage') || member(info, 'website')),
        permission: repositoryPermission(info),
        archived: member(info, 'archived') === true,
        branches: normalizeProviderBranches(account(req).provider || 'github', branches)
      });
    } catch (e) { fail(res, e); }
  });

  /* A deletion needs a credential allowed to delete repositories. */
  app.delete('/api/repo/:owner/:repo', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.delete'), repositoryDeletionConfirmation, auth, mutationContext('repository.delete'), async (req: Request, res: Response) => {
    try {
      await verifyRepositoryDeletion((route, options) => gh(account(req), route, options), `${req.params.owner}/${req.params.repo}`, account(req));
      await gh(account(req), R(req), { method: 'DELETE' });
      res.json({ ok: true });
    } catch (e) {
      if (member(e, 'status') === 403 && member(e, 'code') === 'PROVIDER_FORBIDDEN') {
        Object.assign(Object(e), {
          nextAction: 'For OAuth, use Accounts → Allow repository deletion on GitHub. Otherwise check repository administrator access and deletion permission on the connected credential.',
          providerChanged: false
        });
      }
      fail(res, e);
    }
  });

  app.get('/api/repo/:owner/:repo/zip', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      const ref = req.query.ref || '';
      const r = await deps.archiveResponse(account(req), String(req.params.owner), String(req.params.repo), ref);
      if (!r.ok) { res.status(r.status).json({ error: 'Could not download archive' }); return; }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition',
        `attachment; filename="${req.params.repo}-${text(ref || 'default', '(ref || "default").replace').replace(/[^\w.-]/g, '_')}.zip"`);
      await pipeline(fromWebBody(r.body), res);
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/branches', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('branches.write'), auth, mutationContext('branch.create'), async (req: Request, res: Response) => {
    try {
      const requestedName = bodyField(req, 'name');
      const requestedFrom = bodyField(req, 'from');
      if (!requestedName || !requestedFrom) { res.status(400).json({ error: 'name and from required' }); return; }
      const name = normalizeBranchName(requestedName, 'new branch');
      const from = normalizeBranchName(requestedFrom, 'source branch');
      const ref = await gh(account(req), `${R(req)}/git/ref/heads/${encodeURIComponent(from)}`);
      await gh(account(req), `${R(req)}/git/refs`, {
        method: 'POST', body: { ref: `refs/heads/${name}`, sha: member(member(ref, 'object'), 'sha') }
      });
      res.json({ ok: true, name, sha: member(member(ref, 'object'), 'sha') });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/repo/:owner/:repo/branches/:name', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('branches.write'), auth, mutationContext('branch.delete'), async (req: Request, res: Response) => {
    try {
      const name = normalizeBranchName(req.params.name);
      await gh(account(req), `${R(req)}/git/refs/heads/${encodeURIComponent(name)}`, { method: 'DELETE' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/compare', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req: Request, res: Response) => {
    try {
      const { base, head } = req.query;
      const c = await gh(account(req),
        `${R(req)}/compare/${encodeURIComponent(String(base))}...${encodeURIComponent(String(head))}`);
      res.json({
        status: member(c, 'status'), ahead_by: member(c, 'ahead_by'), behind_by: member(c, 'behind_by'), total_commits: member(c, 'total_commits'),
        commits: listed(sliced(member(c, 'commits') || [], -20, '(c.commits || []).slice'), '(c.commits || []).slice(...).map').map(x => ({
          sha: member(x, 'sha'),
          message: firstLine(member(member(x, 'commit'), 'message'), 'x.commit.message.split'),
          author: member(member(x, 'commit'), 'author') && member(member(member(x, 'commit'), 'author'), 'name')
        })),
        files: listed(member(c, 'files') || [], '(c.files || []).map').map(f => ({
          filename: member(f, 'filename'), status: member(f, 'status'), additions: member(f, 'additions'), deletions: member(f, 'deletions'), patch: member(f, 'patch')
        }))
      });
    } catch (e) { fail(res, e); }
  });
}
