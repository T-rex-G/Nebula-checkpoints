/*
 * Pulsar's activity routes: one repository's recent activity, and the
 * overview's feed across the workspace.
 *
 * The provider's answers are read as JavaScript reads them: a property of a
 * missing entry fails the request, as `entry.sha` always did, while a missing
 * property is left out. Only what reaches the caller is shaped here; the feed's
 * selection and merging are the activity feed's (domain/activity-feed.ts).
 *
 * The guards are handed in under the names the route policy records, and the
 * routes are registered in its order (test/oracles/route-policy.json).
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { normalizeBranchName } from '../../corona/index.ts';
import { member } from '../../../platform/values/fields.ts';
import { feed as buildActivityFeed, selectRepositories } from '../domain/activity-feed.ts';

export interface ActivityRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly alphaRepositoryListAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The provider account the session is acting as. */
  readonly account: (req: Request) => unknown;
  readonly fail: (res: Response, error: unknown) => unknown;
  /* The provider, through the server's guarded transport. */
  gh(account: unknown, apiPath: string): Promise<unknown>;
  /* Whether the session's provider and deployment support a capability the route may add. */
  supportsCapability(req: Request, feature: string): boolean;
  /* The first page of the session's repositories, as the repository list reads it. */
  listRepositories(req: Request): Promise<readonly unknown[]>;
  /* What a caller may be told about a failure: the body every refusal is sent as. */
  publicErrorBody(error: unknown, context: { readonly correlationId: unknown }): { readonly error?: unknown };
}

const DAY_MS = 86400000;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/* How many days back a request reads: 14 unless it asks for 1 to 90. */
function daysOf(value: unknown): number {
  return Math.min(Math.max(parseInt(String(value || '14'), 10) || 14, 1), 90);
}
/* The first line of a provider's text; a value that is not text fails the request, as `.split` on it did. */
function firstLine(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('the provider answered a message that is not text');
  return value.split('\n')[0] ?? '';
}
/* `value` as a Date, exactly as `new Date(value)` reads whatever the provider sent. */
function dateOf(value: unknown): Date {
  const date: Date = Reflect.construct(Date, [value]);
  return date;
}
/* A provider list, or the request fails, as `.map` on anything else did. */
function listed(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`the provider's ${what} are not a list`);
  return value;
}
/* `a && a.b && a.b.c`, read property by property as JavaScript does. */
function path(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current) return current;
    current = member(current, key);
  }
  return current;
}

export function registerActivityRoutes(app: Application, deps: ActivityRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, alphaRepositoryListAccess, capabilityAccess, auth, account, fail } = deps;

  app.get('/api/repo/:owner/:repo/activity', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      const days = daysOf(req.query.days);
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const generatedAt = new Date().toISOString();
      const includePulls = deps.supportsCapability(req, 'pulls.read');
      const includeIssues = deps.supportsCapability(req, 'issues.read');
      const includeReleases = deps.supportsCapability(req, 'releases.read');
      /* An empty ref is the default branch: a repository with no branch selected yet asks this way. */
      const ref = req.query.ref == null || req.query.ref === '' ? '' : normalizeBranchName(req.query.ref);
      const base = {
        kind: 'nebulaverse-activity', version: 1, generatedAt,
        owner: req.params.owner, repo: req.params.repo, days, since, ref: ref || null
      };
      const repository = `/repos/${req.params.owner}/${req.params.repo}`;
      const sourceRequests = [
        { name: 'commits', limit: 100, requested: true, path: `${repository}/commits?since=${encodeURIComponent(since)}&per_page=100${ref ? `&sha=${encodeURIComponent(ref)}` : ''}` },
        { name: 'pulls', limit: 30, requested: includePulls, path: `${repository}/pulls?state=all&sort=updated&direction=desc&per_page=30` },
        { name: 'issues', limit: 30, requested: includeIssues, path: `${repository}/issues?state=all&sort=updated&direction=desc&per_page=30` },
        { name: 'releases', limit: 20, requested: includeReleases, path: `${repository}/releases?per_page=20` }
      ];
      const session = account(req);
      const settled = await Promise.allSettled(sourceRequests.map(source => source.requested ? deps.gh(session, source.path) : Promise.resolve([])));
      const sources: Record<string, { requested: boolean; available: boolean; truncated: boolean }> = {};
      const rows: Record<string, readonly unknown[]> = {};
      sourceRequests.forEach((source, index) => {
        const outcome = settled[index];
        const value = outcome && outcome.status === 'fulfilled' ? outcome.value : undefined;
        const available = source.requested && outcome !== undefined && outcome.status === 'fulfilled' && Array.isArray(value);
        const list = available && Array.isArray(value) ? value : [];
        rows[source.name] = list;
        sources[source.name] = { requested: source.requested, available, truncated: available && list.length >= source.limit };
      });
      const fresh = (d: unknown): unknown => d && dateOf(d) >= new Date(since);
      res.json({
        ...base,
        sources,
        partial: Object.values(sources).some(source => source.requested && (!source.available || source.truncated)),
        commits: (rows.commits || []).map(c => ({
          sha: member(c, 'sha'),
          parentShas: (Array.isArray(member(c, 'parents')) ? listed(member(c, 'parents'), 'parents') : [])
            .map(parent => member(parent, 'sha')).filter(sha => COMMIT_SHA.test(String(sha))),
          message: firstLine(path(c, 'commit', 'message') || ''),
          author: path(c, 'commit', 'author', 'name') || '',
          date: path(c, 'commit', 'author', 'date')
        })),
        pulls: (rows.pulls || []).filter(p => fresh(member(p, 'updated_at'))).map(p => ({
          number: member(p, 'number'), title: member(p, 'title'), state: member(p, 'merged_at') ? 'merged' : member(p, 'state'), updated: member(p, 'updated_at')
        })),
        issues: (rows.issues || []).filter(i => !member(i, 'pull_request') && fresh(member(i, 'updated_at'))).map(i => ({
          number: member(i, 'number'), title: member(i, 'title'), state: member(i, 'state'), updated: member(i, 'updated_at')
        })),
        releases: (rows.releases || []).filter(r => fresh(member(r, 'published_at') || member(r, 'created_at'))).map(r => ({
          tag: member(r, 'tag_name'), name: member(r, 'name'), published: member(r, 'published_at') || member(r, 'created_at')
        }))
      });
    } catch (e) { fail(res, e); }
  });

  /*
   * The overview's activity feed.
   *
   * The overview has no repository in hand -- that is the whole difficulty.
   * The cheap cross-repository source, GitHub's per-user event stream, is one
   * request for everything, and it is not usable here: it does not exist for a
   * GitHub App installation, which has no user to attribute events to, and it
   * would be a new provider read that this project does not let itself claim
   * as verified until a live run has earned it. So the feed is assembled from
   * reads already earned, over a bounded set of repositories.
   *
   * Bounded is the operative word. Every repository here is a separate round
   * trip against someone's rate limit, and an inventory of two hundred
   * repositories must not turn opening the overview into two hundred
   * requests. The activity feed caps the fan-out; this asks only for commits,
   * because commits are the signal a feed is mostly made of and pulls, issues
   * and releases would triple the cost of a screen the reader has not asked
   * to drill into. The response says which kinds it carries so the card can
   * describe itself truthfully rather than imply it is showing everything
   * that happened.
   *
   * One repository failing is not the feed failing. Each read is settled
   * independently and a repository that refused is named in the payload,
   * because a card that quietly shows the other five is telling the reader
   * the sixth was quiet when it was in fact unreadable.
   */
  app.get('/api/activity/recent', providerSessionAccess, alphaRepositoryListAccess, capabilityAccess('repository.read'), auth, async (req: Request, res: Response) => {
    try {
      const days = daysOf(req.query.days);
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const inventory = await deps.listRepositories(req);
      /* How many repositories to fan out over, not which ones -- the feed caps
         it either way. Named so nobody reads it as a list of names. */
      const selected = selectRepositories(inventory, req.query.repositoryLimit);
      const session = account(req);

      const results = await Promise.all(selected.map(async entry => {
        try {
          const commits = listed(await deps.gh(session, `/repos/${entry.owner}/${entry.name}/commits?since=${encodeURIComponent(since)}&per_page=20`), 'commits')
            .map(c => ({
              sha: member(c, 'sha'),
              message: firstLine(path(c, 'commit', 'message') || ''),
              author: path(c, 'commit', 'author', 'name') || '',
              date: path(c, 'commit', 'committer', 'date') || path(c, 'commit', 'author', 'date')
            }));
          return { repo: entry.full_name, commits };
        } catch (error) {
          /*
           * The reason, not a stack. The public error body is what every other
           * route uses to decide what a caller may be told, so the feed does not
           * invent its own disclosure rule for the same provider errors.
           */
          const body = deps.publicErrorBody(error, { correlationId: res.locals.correlationId });
          return { repo: entry.full_name, error: (body && body.error) || 'unavailable' };
        }
      }));

      res.json({
        kind: 'nebulaverse-activity-feed',
        version: 1,
        generatedAt: new Date().toISOString(),
        days,
        since,
        kinds: ['commit'],
        perRepositoryLimit: 20,
        inventoryScope: 'first-page',
        inventoryCount: inventory.length,
        ...buildActivityFeed(results, { limit: req.query.limit })
      });
    } catch (e) { fail(res, e); }
  });
}
