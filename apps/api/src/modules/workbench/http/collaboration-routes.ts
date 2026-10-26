/*
 * The workbench's collaboration routes: code search held to the repository,
 * pull requests (listed, read, opened, merged on the head the reviewer saw,
 * reviewed), issues (listed, read, opened, commented on, closed or reopened),
 * the account's notifications and code search across what it may see, a
 * repository's star, workflow runs with their jobs and a re-run, and
 * releases.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { isCommitSha } from '../../../../../../packages/contracts/src/ids.ts';
import { listAccessibleNotifications, scopedCodeQuery, searchAccessibleCode } from '../../github-provider/index.ts';
import { pullListItem } from '../../posture/index.ts';
import type { Gh } from '../application/commit-writer.ts';
import { bodyField, listed, repositoryPath } from './provider-values.ts';

export interface CollaborationRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  /* Refuses a cross-repository search the session's scope cannot hold. */
  readonly githubSearchAccess: RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  /* The repositories a hosted alpha's invitation reaches, as owner/name, or null outside the alpha. */
  alphaRepositories(req: Request): readonly string[] | null;
  /* The session's protected path patterns for this repository, and the refusal of a change to one. */
  protectedPatternsForReq(req: Request): readonly unknown[];
  enforceProtectedPaths(req: Request, paths: readonly unknown[]): void;
}

const STATES: readonly unknown[] = ['open', 'closed', 'all'];
const MERGE_METHODS: readonly unknown[] = ['merge', 'squash', 'rebase'];
const REVIEW_EVENTS: readonly unknown[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

export function registerCollaborationRoutes(app: Application, deps: CollaborationRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, githubSearchAccess, auth, mutationContext, account, fail, gh } = deps;
  const R = repositoryPath;
  const labelsOf = (value: unknown): unknown[] => listed(member(value, 'labels') || [], '(i.labels || []).map').map(l => ({ name: member(l, 'name'), color: member(l, 'color') }));

  app.get('/api/repo/:owner/:repo/search', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('search'), auth, async (req: Request, res: Response) => {
    try {
      /*
       * The repository is the server's to name. The query used to be the
       * reader's text with " repo:owner/name" appended, and GitHub ORs repeated
       * repo qualifiers -- so "x repo:someone/else" searched a repository this
       * route was never asked about, outside any invitation scope. The shared
       * guard refuses qualifiers and boolean operators, and the results are held
       * to the one repository as well, in case the provider's parser ever reads a
       * query differently from ours.
       */
      const repository = `${req.params.owner}/${req.params.repo}`;
      const query = scopedCodeQuery(req.query.q, repository);
      const out = await gh(account(req), `/search/code?q=${encodeURIComponent(query)}&per_page=30`);
      res.json(listed(member(out, 'items') || [], '(out.items || []).filter')
        .filter(i => String(member(i, 'repository') && member(member(i, 'repository'), 'full_name') || '').toLowerCase() === repository.toLowerCase())
        .map(i => ({ name: member(i, 'name'), path: member(i, 'path') })));
    } catch (e) { fail(res, e); }
  });

  /* Every path a pull request changes must be free of the session's protected paths before it merges. */
  async function enforceProtectedPullMerge(req: Request, number: unknown): Promise<void> {
    if (!deps.protectedPatternsForReq(req).length) return;
    const changedPaths: unknown[] = [];
    const pr = await gh(account(req), `${R(req)}/pulls/${encodeURIComponent(String(number))}`);
    if (Number(member(pr, 'changed_files') || 0) > 1000) {
      throw Object.assign(new Error('This pull request has more than 1,000 changed files, so protected-path verification cannot be completed safely.'), { status: 423, code: 'PROTECTED_PATH_SCAN_INCOMPLETE' });
    }
    for (let page = 1; page <= 10; page++) {
      const batch = await gh(account(req), `${R(req)}/pulls/${encodeURIComponent(String(number))}/files?per_page=100&page=${page}`);
      for (const item of Array.isArray(batch) ? batch : []) {
        if (item && member(item, 'previous_filename')) changedPaths.push(member(item, 'previous_filename'));
        if (item && member(item, 'filename')) changedPaths.push(member(item, 'filename'));
      }
      if (!Array.isArray(batch) || batch.length < 100) break;
    }
    deps.enforceProtectedPaths(req, [...new Set(changedPaths)]);
  }

  app.get('/api/repo/:owner/:repo/pulls', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.read'), auth, async (req: Request, res: Response) => {
    try {
      const state = STATES.includes(req.query.state) ? req.query.state : 'open';
      const pulls = await gh(account(req), `${R(req)}/pulls?state=${String(state)}&per_page=30&sort=updated&direction=desc`);
      res.json(listed(pulls, 'pulls.map').map(pullListItem));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/pulls/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.read'), auth, async (req: Request, res: Response) => {
    try {
      const [p, files] = await Promise.all([
        gh(account(req), `${R(req)}/pulls/${req.params.num}`),
        gh(account(req), `${R(req)}/pulls/${req.params.num}/files?per_page=100`)
      ]);
      res.json({
        number: member(p, 'number'), title: member(p, 'title'), body: member(p, 'body'), state: member(p, 'state'), draft: member(p, 'draft'),
        merged: member(p, 'merged'), mergeable: member(p, 'mergeable'), mergeable_state: member(p, 'mergeable_state'),
        user: member(p, 'user') && member(member(p, 'user'), 'login'), head: member(member(p, 'head'), 'ref'), base: member(member(p, 'base'), 'ref'),
        headSha: /^[0-9a-f]{40}$/i.test(String(member(p, 'head') && member(member(p, 'head'), 'sha') || '')) ? String(member(member(p, 'head'), 'sha')).toLowerCase() : null,
        additions: member(p, 'additions'), deletions: member(p, 'deletions'), changed_files: member(p, 'changed_files'),
        files: listed(files, 'files.map').map(f => ({ filename: member(f, 'filename'), status: member(f, 'status'), additions: member(f, 'additions'), deletions: member(f, 'deletions'), patch: member(f, 'patch') }))
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/pulls', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write'), auth, mutationContext('pull.create'), async (req: Request, res: Response) => {
    try {
      const title = bodyField(req, 'title');
      const head = bodyField(req, 'head');
      const base = bodyField(req, 'base');
      const body = bodyField(req, 'body');
      const draft = bodyField(req, 'draft');
      if (!title || !head || !base) { res.status(400).json({ error: 'title, head, base required' }); return; }
      const p = await gh(account(req), `${R(req)}/pulls`, {
        method: 'POST', body: { title, head, base, body: body || '', draft: !!draft }
      });
      res.json({ ok: true, number: member(p, 'number') });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/repo/:owner/:repo/pulls/:num/merge', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write'), auth, mutationContext('pull.merge'), async (req: Request, res: Response) => {
    try {
      const requestedMethod = req.body && member(req.body, 'method');
      const method = MERGE_METHODS.includes(requestedMethod) ? requestedMethod : 'merge';
      /*
       * The head the reviewer looked at is the head that merges. Without it a
       * merge confirmed against one set of commits would take whatever had been
       * pushed to the branch since -- reviewed or not. Both providers take the
       * head as a precondition and refuse the merge when it has moved.
       */
      const expected = String(req.body && member(req.body, 'expectedHeadSha') || '').trim().toLowerCase();
      if (expected && !isCommitSha(expected)) {
        res.status(400).json({ error: 'expectedHeadSha must be a 40-character commit SHA', code: 'INVALID_EXPECTED_HEAD' });
        return;
      }
      const headMoved = (): Error => Object.assign(new Error('The pull request gained commits since it was reviewed. Reload it and review the new head before merging.'), {
        status: 409, code: 'PULL_HEAD_CHANGED'
      });
      await enforceProtectedPullMerge(req, req.params.num);
      let out: unknown;
      try {
        out = await gh(account(req), `${R(req)}/pulls/${req.params.num}/merge`, {
          method: 'PUT', body: { merge_method: method, ...(expected ? { sha: expected } : {}) }
        });
      } catch (error) {
        if (expected && member(error, 'status') === 409) throw headMoved();
        throw error;
      }
      res.json({ ok: true, sha: member(out, 'sha'), message: member(out, 'message') });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/issues', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.read'), auth, async (req: Request, res: Response) => {
    try {
      const state = STATES.includes(req.query.state) ? req.query.state : 'open';
      const issues = await gh(account(req), `${R(req)}/issues?state=${String(state)}&per_page=30&sort=updated`);
      res.json(listed(issues, 'issues.filter').filter(i => !member(i, 'pull_request')).map(i => ({
        number: member(i, 'number'), title: member(i, 'title'), state: member(i, 'state'),
        user: member(i, 'user') && member(member(i, 'user'), 'login'), avatar: member(i, 'user') && member(member(i, 'user'), 'avatar_url'),
        comments: member(i, 'comments'), updated_at: member(i, 'updated_at'),
        labels: labelsOf(i)
      })));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/issues/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.read'), auth, async (req: Request, res: Response) => {
    try {
      const [i, comments] = await Promise.all([
        gh(account(req), `${R(req)}/issues/${req.params.num}`),
        gh(account(req), `${R(req)}/issues/${req.params.num}/comments?per_page=50`)
      ]);
      res.json({
        number: member(i, 'number'), title: member(i, 'title'), body: member(i, 'body'), state: member(i, 'state'),
        user: member(i, 'user') && member(member(i, 'user'), 'login'), created_at: member(i, 'created_at'),
        labels: labelsOf(i),
        comments: listed(comments, 'comments.map').map(c => ({ user: member(c, 'user') && member(member(c, 'user'), 'login'), avatar: member(c, 'user') && member(member(c, 'user'), 'avatar_url'), body: member(c, 'body'), created_at: member(c, 'created_at') }))
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/issues', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write'), auth, mutationContext('issue.create'), async (req: Request, res: Response) => {
    try {
      const title = bodyField(req, 'title');
      const body = bodyField(req, 'body');
      if (!title) { res.status(400).json({ error: 'title required' }); return; }
      const i = await gh(account(req), `${R(req)}/issues`, { method: 'POST', body: { title, body: body || '' } });
      res.json({ ok: true, number: member(i, 'number') });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/issues/:num/comments', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write'), auth, mutationContext('issue.comment'), async (req: Request, res: Response) => {
    try {
      const body = bodyField(req, 'body');
      if (!body) { res.status(400).json({ error: 'body required' }); return; }
      await gh(account(req), `${R(req)}/issues/${req.params.num}/comments`, { method: 'POST', body: { body } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/repo/:owner/:repo/issues/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write'), auth, mutationContext('issue.update'), async (req: Request, res: Response) => {
    try {
      const state = req.body && member(req.body, 'state') === 'closed' ? 'closed' : 'open';
      await gh(account(req), `${R(req)}/issues/${req.params.num}`, { method: 'PATCH', body: { state } });
      res.json({ ok: true, state });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/notifications', providerSessionAccess, capabilityAccess('notifications'), auth, async (req: Request, res: Response) => {
    try {
      const repositories = deps.alphaRepositories(req);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await listAccessibleNotifications(route => gh(account(req), route), repositories));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.read'), auth, async (req: Request, res: Response) => {
    if (account(req).authMethod === 'github-app') { res.json({ starred: false, unsupported: true }); return; }
    try { await gh(account(req), `/user/starred/${req.params.owner}/${req.params.repo}`); res.json({ starred: true }); }
    catch (e) { if (member(e, 'status') === 404) { res.json({ starred: false }); return; } fail(res, e); }
  });

  app.put('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.write'), auth, mutationContext('repository.star'), async (req: Request, res: Response) => {
    if (account(req).authMethod === 'github-app') {
      res.status(403).json({ error: 'GitHub App installations cannot manage user stars', code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE' });
      return;
    }
    try { await gh(account(req), `/user/starred/${req.params.owner}/${req.params.repo}`, { method: 'PUT' }); res.json({ ok: true, starred: true }); }
    catch (e) { fail(res, e); }
  });

  app.delete('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.write'), auth, mutationContext('repository.unstar'), async (req: Request, res: Response) => {
    if (account(req).authMethod === 'github-app') {
      res.status(403).json({ error: 'GitHub App installations cannot manage user stars', code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE' });
      return;
    }
    try { await gh(account(req), `/user/starred/${req.params.owner}/${req.params.repo}`, { method: 'DELETE' }); res.json({ ok: true, starred: false }); }
    catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/pulls/:num/reviews', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write'), auth, mutationContext('pull.review'), async (req: Request, res: Response) => {
    try {
      const requestedEvent = req.body && member(req.body, 'event');
      const event = REVIEW_EVENTS.includes(requestedEvent) ? requestedEvent : 'COMMENT';
      const text = String((req.body && member(req.body, 'body')) || '');
      if (!/^\d{1,10}$/.test(String(req.params.num))) { res.status(400).json({ error: 'Invalid pull request number', code: 'PULL_NUMBER_INVALID' }); return; }
      await gh(account(req), `${R(req)}/pulls/${req.params.num}/reviews`, {
        method: 'POST', body: { event, body: text }
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/actions/:runId/jobs', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.read'), auth, async (req: Request, res: Response) => {
    try {
      if (!/^\d{1,20}$/.test(String(req.params.runId))) { res.status(400).json({ error: 'Invalid workflow run id', code: 'WORKFLOW_RUN_INVALID' }); return; }
      const out = await gh(account(req), `${R(req)}/actions/runs/${req.params.runId}/jobs?per_page=20`);
      res.json(listed(member(out, 'jobs') || [], '(out.jobs || []).map').map(jb => ({
        name: member(jb, 'name'), status: member(jb, 'status'), conclusion: member(jb, 'conclusion'),
        steps: listed(member(jb, 'steps') || [], '(jb.steps || []).map').map(st => ({ name: member(st, 'name'), status: member(st, 'status'), conclusion: member(st, 'conclusion') }))
      })));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/actions/:runId/rerun', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.rerun'), auth, mutationContext('workflow.rerun'), async (req: Request, res: Response) => {
    try {
      /* A run id is a number; anything else would be a path segment. */
      if (!/^\d{1,20}$/.test(String(req.params.runId))) { res.status(400).json({ error: 'Invalid workflow run id', code: 'WORKFLOW_RUN_INVALID' }); return; }
      await gh(account(req), `${R(req)}/actions/runs/${req.params.runId}/rerun`, { method: 'POST' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/search', providerSessionAccess, capabilityAccess('global-search'), githubSearchAccess, auth, async (req: Request, res: Response) => {
    try {
      const repositories = deps.alphaRepositories(req);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await searchAccessibleCode(route => gh(account(req), route), req.query.q, repositories));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/actions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.read'), auth, async (req: Request, res: Response) => {
    try {
      const branch = req.query.branch ? `&branch=${encodeURIComponent(String(req.query.branch))}` : '';
      const out = await gh(account(req), `${R(req)}/actions/runs?per_page=25${branch}`);
      res.json(listed(member(out, 'workflow_runs') || [], '(out.workflow_runs || []).map').map(r => ({
        id: member(r, 'id'), name: member(r, 'name'), status: member(r, 'status'), conclusion: member(r, 'conclusion'),
        branch: member(r, 'head_branch'), event: member(r, 'event'), sha: member(r, 'head_sha'),
        created_at: member(r, 'created_at'), html_url: member(r, 'html_url'),
        attempt: member(r, 'run_attempt'), number: member(r, 'run_number')
      })));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/releases', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('releases.read'), auth, async (req: Request, res: Response) => {
    try {
      const rel = await gh(account(req), `${R(req)}/releases?per_page=20`);
      res.json(listed(rel, 'rel.map').map(r => ({
        id: member(r, 'id'), tag: member(r, 'tag_name'), name: member(r, 'name'), body: member(r, 'body'), draft: member(r, 'draft'),
        prerelease: member(r, 'prerelease'), created_at: member(r, 'created_at'),
        assets: listed(member(r, 'assets') || [], '(r.assets || []).map').map(a => ({ name: member(a, 'name'), size: member(a, 'size'), downloads: member(a, 'download_count') }))
      })));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/repo/:owner/:repo/releases', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('releases.write'), auth, mutationContext('release.create'), async (req: Request, res: Response) => {
    try {
      const tag = bodyField(req, 'tag');
      const name = bodyField(req, 'name');
      const body = bodyField(req, 'body');
      const target = bodyField(req, 'target');
      const prerelease = bodyField(req, 'prerelease');
      if (!tag) { res.status(400).json({ error: 'tag required' }); return; }
      const r = await gh(account(req), `${R(req)}/releases`, {
        method: 'POST',
        body: { tag_name: tag, name: name || tag, body: body || '', target_commitish: target || undefined, prerelease: !!prerelease }
      });
      res.json({ ok: true, id: member(r, 'id'), tag: member(r, 'tag_name') });
    } catch (e) { fail(res, e); }
  });
}
