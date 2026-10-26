/*
 * Corona's access surface: who and what can reach a repository -- its
 * collaborators and their permission, its deploy keys and its webhooks -- read
 * from the provider's administration APIs a page at a time, scored by the
 * access-surface rules (domain/access-surface.ts). A list that could not be
 * read or was cut short leaves the surface partial and says why, rather than
 * looking smaller than it is.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { cleanText } from '../../../platform/values/text.ts';
import { member } from '../../../platform/values/fields.ts';
import { riskForAccessSurface } from '../domain/access-surface.ts';

export interface AccessSurfaceDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly account: (req: Request) => unknown;
  readonly fail: (res: Response, error: unknown) => unknown;
  gh(account: unknown, apiPath: string): Promise<unknown>;
}

/* A permission as the provider names it, or the highest of its flags. */
function permissionFromCollaborator(item: unknown): string {
  if (item && member(item, 'role_name')) return cleanText(member(item, 'role_name'), 40).toLowerCase();
  const p = (item && member(item, 'permissions')) || {};
  if (member(p, 'admin')) return 'admin';
  if (member(p, 'maintain')) return 'maintain';
  if (member(p, 'push')) return 'write';
  if (member(p, 'triage')) return 'triage';
  if (member(p, 'pull')) return 'read';
  return 'unknown';
}

/* The host a webhook delivers to, and nothing else of its address. */
function webhookHost(raw: unknown): string {
  try {
    const u = new URL(String(raw || ''));
    return ['http:', 'https:'].includes(u.protocol) ? u.hostname.toLowerCase().slice(0, 253) : '';
  } catch { return ''; }
}

/* `value.slice(...)`, as JavaScript calls it on a page that was read: a list. */
function listed(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('items.slice is not a function');
  return value;
}

export function registerAccessSurfaceRoutes(app: Application, deps: AccessSurfaceDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account, fail } = deps;

  /* A provider collection, three pages of a hundred at most. */
  const pagedGithubCollection = async (req: Request, resource: string, maxPages = 3): Promise<{ items: unknown[]; truncated: boolean }> => {
    const items: unknown[] = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const join = resource.includes('?') ? '&' : '?';
      const batch = await deps.gh(account(req), `/repos/${req.params.owner}/${req.params.repo}/${resource}${join}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (batch.length < 100) return { items, truncated: false };
      if (page === maxPages) truncated = true;
    }
    return { items, truncated };
  };
  const failureOf = (settled: PromiseSettledResult<unknown>): unknown => (settled.status === 'rejected' ? settled.reason : undefined);
  const pageOf = (settled: PromiseSettledResult<{ items: unknown[]; truncated: boolean }>): { items: unknown[]; truncated: boolean } =>
    (settled.status === 'fulfilled' ? settled.value : { items: [], truncated: false });

  app.get('/api/repo/:owner/:repo/access-surface', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('access-surface'), auth, async (req: Request, res: Response) => {
    try {
      if ((member(account(req), 'provider') || 'github') !== 'github') {
        res.json({ available: false, partial: true, reason: 'Shadow Access Radar currently uses GitHub administration APIs.', collaborators: [], deployKeys: [], webhooks: [], risk: riskForAccessSurface({ partial: true }) });
        return;
      }
      const [repositoryRead, collaboratorRead, keyRead, hookRead] = await Promise.allSettled([
        deps.gh(account(req), `/repos/${req.params.owner}/${req.params.repo}`),
        pagedGithubCollection(req, 'collaborators?affiliation=all', 3),
        pagedGithubCollection(req, 'keys', 3),
        pagedGithubCollection(req, 'hooks', 3)
      ]);
      const errors: string[] = [];
      const repo = repositoryRead.status === 'fulfilled' ? repositoryRead.value : null;
      if (repositoryRead.status === 'rejected') errors.push(`repository: ${cleanText(failureOf(repositoryRead) && member(failureOf(repositoryRead), 'message'), 160)}`);
      const collaboratorPage = pageOf(collaboratorRead);
      if (collaboratorRead.status === 'rejected') errors.push(`collaborators: ${cleanText(failureOf(collaboratorRead) && member(failureOf(collaboratorRead), 'message'), 160)}`);
      const keyPage = pageOf(keyRead);
      if (keyRead.status === 'rejected') errors.push(`deploy keys: ${cleanText(failureOf(keyRead) && member(failureOf(keyRead), 'message'), 160)}`);
      const hookPage = pageOf(hookRead);
      if (hookRead.status === 'rejected') errors.push(`webhooks: ${cleanText(failureOf(hookRead) && member(failureOf(hookRead), 'message'), 160)}`);

      const collaborators = listed(collaboratorPage.items).slice(0, 300).map(item => ({
        login: cleanText(member(item, 'login') || '', 100),
        avatar: cleanText(member(item, 'avatar_url') || '', 500),
        permission: permissionFromCollaborator(item),
        type: cleanText(member(item, 'type') || 'User', 40),
        siteAdmin: !!member(item, 'site_admin')
      })).filter(item => item.login);
      const deployKeys = listed(keyPage.items).slice(0, 300).map(item => ({
        id: Number(member(item, 'id') || 0),
        title: cleanText(member(item, 'title') || 'Deploy key', 160),
        readOnly: member(item, 'read_only') !== false,
        verified: member(item, 'verified') !== false,
        enabled: member(item, 'enabled') !== false,
        addedBy: cleanText(member(item, 'added_by') || '', 100),
        createdAt: member(item, 'created_at') || null,
        lastUsed: member(item, 'last_used') || null
      })).filter(item => item.id);
      const webhooks = listed(hookPage.items).slice(0, 300).map(item => {
        const events = member(item, 'events');
        const config = member(item, 'config');
        return {
          id: Number(member(item, 'id') || 0),
          name: cleanText(member(item, 'name') || 'web', 80),
          active: member(item, 'active') !== false,
          events: Array.isArray(events) ? events.slice(0, 50).map(event => cleanText(event, 80)) : [],
          host: webhookHost(config && member(config, 'url')),
          insecureSsl: String((config && member(config, 'insecure_ssl')) || '0') === '1',
          updatedAt: member(item, 'updated_at') || null
        };
      }).filter(item => item.id);
      const partial = errors.length > 0 || collaboratorPage.truncated || keyPage.truncated || hookPage.truncated;
      const permissions = repo && member(repo, 'permissions');
      const surface = {
        available: true,
        partial,
        errors,
        currentIdentity: cleanText(member(account(req), 'login') || '', 100),
        currentPermission: repo && permissions ? permissionFromCollaborator({ permissions }) : 'unknown',
        collaborators,
        deployKeys,
        webhooks,
        truncated: { collaborators: collaboratorPage.truncated, deployKeys: keyPage.truncated, webhooks: hookPage.truncated }
      };
      const risk = riskForAccessSurface(surface);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...surface, risk });
    } catch (e) { fail(res, e); }
  });
}
