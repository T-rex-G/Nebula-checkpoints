/*
 * The inventory a session may see, in one place.
 *
 * Several screens read this list -- the repositories page, the overview's
 * activity feed, the safeguards' repository picker -- and the filter it
 * applies is a security boundary, not a convenience: the hosted alpha's list
 * filter is what keeps a cohort session from being told about repositories
 * its invitation does not reach. A second copy of this logic is a second place
 * for that filter to be forgotten, so every caller comes through here.
 */
import type { Request } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import type { Gh } from './commit-writer.ts';

export interface RepositoryListDeps {
  gh: Gh;
  /* The provider account the session is acting as, as the guards attached it. */
  account(req: Request): Fields;
  /* Whether the hosted alpha lets this session see a repository; true outside it. */
  listAllowed(req: Request, owner: unknown, repo: unknown): boolean;
}

export interface RepositorySummary {
  readonly full_name: unknown;
  readonly name: unknown;
  readonly owner: unknown;
  readonly private: unknown;
  readonly description: unknown;
  readonly language: unknown;
  readonly default_branch: unknown;
  readonly pushed_at: unknown;
  readonly stars: unknown;
  readonly forks: unknown;
  readonly open_issues: unknown;
}

export type ListRepositories = (req: Request, query?: unknown) => Promise<RepositorySummary[]>;

const SORTS: readonly unknown[] = ['pushed', 'created', 'updated', 'full_name'];

/* `repos.filter(...)`, as JavaScript calls it on the provider's answer. */
function repositoriesOf(value: unknown): readonly unknown[] {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading 'filter')`);
  if (!Array.isArray(value)) throw new TypeError('repos.filter is not a function');
  return value;
}

export function createRepositoryList(deps: RepositoryListDeps): ListRepositories {
  return async (req, query = {}) => {
    const account = deps.account(req);
    const page = parseInt(String(member(query, 'page') || '1'), 10);
    const requestedSort = member(query, 'sort');
    const sort = SORTS.includes(requestedSort) ? requestedSort : 'pushed';
    const result = account.authMethod === 'github-app'
      ? await deps.gh(account, `/installation/repositories?per_page=30&page=${page}`)
      : await deps.gh(account, `/user/repos?sort=${String(sort)}&per_page=30&page=${page}&affiliation=owner,collaborator,organization_member`);
    const installationRepositories = (): readonly unknown[] => {
      const repositories = result && member(result, 'repositories');
      return Array.isArray(repositories) ? repositories : [];
    };
    const repos = account.authMethod === 'github-app' ? installationRepositories() : result;
    return repositoriesOf(repos).filter(r => deps.listAllowed(
      req,
      r && member(r, 'owner') && member(member(r, 'owner'), 'login'),
      r && member(r, 'name')
    )).map(r => ({
      full_name: member(r, 'full_name'), name: member(r, 'name'), owner: member(member(r, 'owner'), 'login'),
      private: member(r, 'private'), description: member(r, 'description'), language: member(r, 'language'),
      default_branch: member(r, 'default_branch'), pushed_at: member(r, 'pushed_at'),
      stars: member(r, 'stargazers_count'), forks: member(r, 'forks_count'), open_issues: member(r, 'open_issues_count')
    }));
  };
}
