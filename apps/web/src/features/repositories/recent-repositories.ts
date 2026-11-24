/*
 * The repositories this browser opened last, and who is visiting.
 *
 * The recent list is names only, at most five, under the nv_recent: prefix
 * the account boundary's purge removes. Somebody else's repository is
 * remembered as such, so a picker for the reader's own leaves it out, and a
 * deleted one is forgotten. A storage that refuses keeps no list, and
 * nothing is lost.
 */
import { REPO_PART } from './repository-reference.ts';

export const RECENT_REPOSITORIES = 'nv_recent:repositories';
export const RECENT_LIMIT = 5;

export interface RecentRepository { readonly owner: string; readonly name: string; readonly visitor?: true }
export interface RecentStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

const named = (item: unknown): item is { owner: string; name: string; visitor?: unknown } => {
  if (!item || typeof item !== 'object') return false;
  const { owner, name } = item as { owner?: unknown; name?: unknown };
  return typeof owner === 'string' && typeof name === 'string' && REPO_PART.test(owner) && REPO_PART.test(name);
};

export function recentRepositories(storage: () => RecentStorage): RecentRepository[] {
  try {
    const list: unknown = JSON.parse(storage().getItem(RECENT_REPOSITORIES) || '[]');
    return (Array.isArray(list) ? list : [])
      .filter(named)
      .map(item => (item.visitor === true ? { owner: item.owner, name: item.name, visitor: true as const } : { owner: item.owner, name: item.name }))
      .slice(0, RECENT_LIMIT);
  } catch { return []; }
}

/* The repository put first, once whatever its case, the list kept to five. */
export function rememberRepository(storage: () => RecentStorage, owner: string, name: string, visitor = false): void {
  try {
    const rest = recentRepositories(storage).filter(item => `${item.owner}/${item.name}`.toLowerCase() !== `${owner}/${name}`.toLowerCase());
    storage().setItem(RECENT_REPOSITORIES, JSON.stringify([visitor ? { owner, name, visitor: true } : { owner, name }, ...rest].slice(0, RECENT_LIMIT)));
  } catch { /* private mode: no recent list, and nothing is lost */ }
}

/* A repository that is gone, forgotten from the list whatever its case; the rest kept as they were. */
export function forgetRepository(storage: () => RecentStorage, owner: string, name: string): void {
  try {
    const kept = recentRepositories(storage);
    const rest = kept.filter(item => `${item.owner}/${item.name}`.toLowerCase() !== `${owner}/${name}`.toLowerCase());
    if (rest.length !== kept.length) storage().setItem(RECENT_REPOSITORIES, JSON.stringify(rest));
  } catch { /* private mode: no recent list to forget it from */ }
}

/* Somebody else's repository, by the permission the provider reports: open read-only, and nothing offers to change it. */
export function repositoryVisitor(permission: unknown): boolean {
  return permission === 'read' || permission === 'triage' || permission === 'none';
}
/* The tools that would change a repository, not offered to a visitor. */
export const VISITOR_TABS: ReadonlySet<string> = new Set(['upload', 'governance', 'safeguards']);
