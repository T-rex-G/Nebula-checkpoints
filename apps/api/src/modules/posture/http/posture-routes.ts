/*
 * Posture's routes: the workspace posture the overview scores, the security
 * posture and the findings inbox drawn from what the stores already hold for
 * an identity, and a branch's provider rules beside the server's own
 * safeguards.
 *
 * The guards are handed in under the names the route policy records, and the
 * routes are registered in its order (test/oracles/route-policy.json): the
 * workspace three together, branch protection later among the repository
 * routes, so each has its own registration function.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { normalizeBranchName } from '../../corona/index.ts';
import { member } from '../../../platform/values/fields.ts';
import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { readBranchProtection } from '../application/branch-protection.ts';
import { createPostureReader, type RawResponse, type WorkspacePosture } from '../application/posture-reader.ts';
import { buildInbox, type InboxInput } from '../domain/findings-inbox.ts';
import { summarizePosture, type PostureInput } from '../domain/posture-summary.ts';
import { exposureSummary } from '../domain/workspace-posture.ts';

/* The guards every posture route stands behind. */
export interface PostureGuards {
  readonly providerSessionAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => unknown;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
}

/* Whose workspace: a plain record, as the stores read their input. */
type WorkspaceScope = {
  readonly provider: string;
  readonly authority: string;
  readonly identityKey: string;
};

/* What the workspace routes read: the stores, each as the server builds it, and the database's state. */
export interface WorkspacePostureDeps extends PostureGuards {
  /* The provider transport the posture reader measures the credential with. */
  gh(account: unknown, apiPath: string, options: { readonly raw: true; readonly timeoutMs: number }): Promise<RawResponse>;
  dbReady(): Promise<unknown>;
  pool(): Queryable;
  identityKey(account: unknown): string;
  normalizePolicyScope(scope: { provider: string; baseUrl: unknown; owner: string; repo: string }): { readonly authority: string };
  readonly databaseConfigured: boolean;
  readonly maintenance: boolean;
  readonly hostedAlpha: boolean;
  /* Uranus's audit history; null without a database. */
  auditHistory(): {
    workspace(input: WorkspaceScope & { readonly now: number; readonly weeks: number }): Promise<unknown>;
    workspaceFindings(input: WorkspaceScope & { readonly now: number }): Promise<unknown>;
  } | null;
  /* Quasar's exposure scans; throws without a database. */
  exposureService(): {
    workspaceSummary(scope: WorkspaceScope): Promise<unknown>;
    workspaceTrend(input: WorkspaceScope & { readonly now: number; readonly weeks: number }): Promise<unknown>;
    workspaceFindings(scope: WorkspaceScope): Promise<unknown>;
  };
  /* Kepler's governance decisions. */
  governanceStore(): { countMergeOutcomes(input: { readonly actorIdentityKey: string; readonly since: number }): Promise<unknown> };
  /* Quasar's severity for an exposure rule, and its masking of a path for display. */
  severityOf(rule: string): unknown;
  displayPath(filePath: string): string;
  /* Kepler's triage vocabulary, sent with the inbox so the page names each state as the server does. */
  readonly triageVocabulary: unknown;
}

/* How many weeks the security posture's trend reads back. */
const POSTURE_WEEKS = 12;

/* A store the server did not build is a failure of that one reading, as calling it on null always was. */
function present<T>(store: T | null): T {
  if (store === null) throw new TypeError('the store is not configured');
  return store;
}
/* One reading: its value, or null when it failed, so a store that fails leaves only its own part unmeasured. */
function settle<T>(run: () => Promise<T>): Promise<T | null> {
  return Promise.resolve().then(run).then(value => value, () => null);
}
/* Only a GitHub account has a workspace these routes can read; anything else is refused, as the routes always have. */
function requireGithub(account: unknown, refusal: string): void {
  if (!account || (member(account, 'provider') || 'github') !== 'github') {
    throw Object.assign(new Error(refusal), { code: 'PROVIDER_ACCOUNT_INVALID', status: 401 });
  }
}
/* The workspace its readings are scoped to: worked out only once the database is known to be there, as it always was. */
function githubWorkspace(deps: WorkspacePostureDeps, account: unknown): WorkspaceScope {
  const provider = 'github';
  const authority = deps.normalizePolicyScope({ provider, baseUrl: member(account, 'baseUrl') || '', owner: 'scope', repo: 'scope' }).authority;
  return { provider, authority, identityKey: deps.identityKey(account) };
}

export function registerWorkspacePostureRoutes(app: Application, deps: WorkspacePostureDeps): void {
  const { providerSessionAccess, capabilityAccess, auth, account, fail } = deps;

  /*
   * What the overview scores, read rather than assumed. Every decision lives
   * in the posture reader; this passes it the transports and stores it reads.
   */
  let reader: { read(account: unknown): Promise<WorkspacePosture> } | null = null;
  const postureReader = (): { read(account: unknown): Promise<WorkspacePosture> } => {
    if (!reader) {
      reader = createPostureReader({
        gh: deps.gh, dbReady: deps.dbReady, pool: deps.pool, identityKey: deps.identityKey, normalizePolicyScope: deps.normalizePolicyScope,
        exposureStore: () => deps.exposureService(),
        severityOf: deps.severityOf,
        databaseConfigured: deps.databaseConfigured,
        maintenance: deps.maintenance,
        hostedAlpha: deps.hostedAlpha
      });
    }
    return reader;
  };

  app.get('/api/workspace/posture', providerSessionAccess, auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await postureReader().read(account(req))); } catch (e) { fail(res, e); }
  });

  /*
   * The security posture on the Overview: what the audit history, the
   * exposure scans and the governance decisions already hold for this
   * identity, read together. Nothing is fetched from the provider. Without a
   * database there is nothing to read, and the page is told so rather than
   * shown a clean workspace; a store that fails leaves its own part
   * unmeasured and the rest standing.
   */
  app.get('/api/workspace/security-posture', providerSessionAccess, capabilityAccess('workspace.posture'), auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const session = account(req);
      requireGithub(session, 'Workspace posture requires GitHub');
      if (!deps.databaseConfigured) { res.json({ available: false, reason: 'not-configured' }); return; }
      if (!(await deps.dbReady().catch(() => false))) { res.json({ available: false, reason: 'database-unavailable' }); return; }
      const scope = githubWorkspace(deps, session);
      const now = Date.now();
      const [audit, exposureRows, exposureTrend, merges] = await Promise.all([
        settle(() => present(deps.auditHistory()).workspace({ ...scope, now, weeks: POSTURE_WEEKS })),
        settle(() => deps.exposureService().workspaceSummary(scope)),
        settle(() => deps.exposureService().workspaceTrend({ ...scope, now, weeks: POSTURE_WEEKS })),
        settle(() => deps.governanceStore().countMergeOutcomes({ actorIdentityKey: scope.identityKey, since: now - 7 * 24 * 60 * 60 * 1000 }))
      ]);
      const exposure = exposureRows ? { available: true, repositories: exposureSummary(exposureRows, deps.severityOf) } : null;
      const input: PostureInput = { audit, exposure, exposureTrend, merges, now, weeks: POSTURE_WEEKS };
      res.json({ available: true, ...summarizePosture(input) });
    } catch (e) { fail(res, e); }
  });

  /*
   * The findings inbox: every open finding across the workspace, from the
   * audit history and the exposure scans this identity holds, with its state
   * and a team's decision where one applies. Nothing is fetched from the
   * provider; a path from an exposure scan is masked as the findings screen
   * masks it. A store that fails leaves its part unmeasured.
   */
  app.get('/api/workspace/findings', providerSessionAccess, capabilityAccess('findings.inbox'), auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const session = account(req);
      requireGithub(session, 'The findings inbox requires GitHub');
      if (!deps.databaseConfigured) { res.json({ available: false, reason: 'not-configured' }); return; }
      if (!(await deps.dbReady().catch(() => false))) { res.json({ available: false, reason: 'database-unavailable' }); return; }
      const scope = githubWorkspace(deps, session);
      const now = Date.now();
      const [audit, exposure] = await Promise.all([
        settle(() => present(deps.auditHistory()).workspaceFindings({ ...scope, now })),
        settle(() => deps.exposureService().workspaceFindings(scope))
      ]);
      const input: InboxInput = { audit, exposure, now, severityOf: deps.severityOf, displayPath: deps.displayPath };
      res.json({
        available: true,
        vocabulary: deps.triageVocabulary,
        ...buildInbox(input)
      });
    } catch (e) { fail(res, e); }
  });
}

/* What the branch protection route reads: the provider, through the session's account. */
export interface BranchProtectionDeps extends PostureGuards {
  readonly alphaRepositoryAccess: RequestHandler;
  gh(account: unknown, apiPath: string): Promise<unknown>;
}

/*
 * What the provider enforces on a branch, beside Nebulaverse-X's own
 * safeguards. Read-only: every path and every judgement is in the branch
 * protection reading; this binds its reader to the open repository.
 */
export function registerBranchProtectionRoutes(app: Application, deps: BranchProtectionDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account, fail } = deps;
  app.get('/api/repo/:owner/:repo/branch-protection', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), capabilityAccess('branches.read'), auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const session = account(req);
      const provider = String(member(session, 'provider') || 'github');
      const branch = req.query.branch ? normalizeBranchName(String(req.query.branch)) : '';
      const repository = `/repos/${req.params.owner}/${req.params.repo}`;
      const read = (apiPath: string): Promise<unknown> => deps.gh(session, `${repository}${apiPath}`);
      const webBase = 'https://github.com';
      res.json(await readBranchProtection({ provider, owner: req.params.owner, repo: req.params.repo, branch, read, webBase }));
    } catch (e) { fail(res, e); }
  });
}
