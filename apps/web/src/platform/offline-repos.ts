/*
 * The repositories a reader has chosen to keep for offline use, in this
 * browser, under the cache scope the server gave their session.
 *
 * The list is kept per scope -- one reader's choices are never read under
 * another's -- holds at most a hundred names, and is read as nothing when
 * storage holds anything but a list of strings. A request for one of these
 * repositories, or for the account's repository list while any is kept,
 * carries the scope and the repository so the service worker may keep its
 * answer; every other request carries neither.
 */
import { OFFLINE_REPO_HEADER, OFFLINE_SCOPE_HEADER } from '../../../../packages/contracts/src/offline-cache-policy.ts';
import { field } from './values.ts';

export const OFFLINE_REPOS_LIMIT = 100;

/* Who is reading, as far as offline keeping is concerned. */
export interface OfflineIdentity {
  readonly offlineCacheScope?: unknown;
  readonly provider?: unknown;
}

/* What storage the list is read from and written to; any of it may throw. */
export interface OfflineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const scopeOf = (identity: unknown): string => {
  const scope = field(identity, 'offlineCacheScope');
  return scope ? String(scope) : '';
};
const providerOf = (identity: unknown): string => String(field(identity, 'provider') || 'github');

/* The storage key of the reader's list, or nothing for a session without a cache scope. */
export function offlineRepoStorageKey(identity: unknown): string {
  const scope = scopeOf(identity);
  return scope ? `nv_offline_repos:${scope}` : '';
}

/* The reader's list: the strings storage holds under their key, at most a hundred, or none. */
export function offlineRepoList(identity: unknown, storage: OfflineStorage | null): string[] {
  const key = offlineRepoStorageKey(identity);
  if (!key || !storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, OFFLINE_REPOS_LIMIT) : [];
  } catch { return []; }
}

/* How the list names a repository: its provider, owner and name, in lower case. */
export function offlineRepoKey(identity: unknown, owner: unknown, repo: unknown): string {
  return `${providerOf(identity)}:${String(owner)}/${String(repo)}`.toLowerCase();
}

/* The list with a repository added or taken out, as it is to be stored. */
export function withOfflineRepo(list: readonly string[], repoKey: string, enabled: boolean): string[] {
  const repos = new Set(list);
  if (enabled) repos.add(repoKey); else repos.delete(repoKey);
  return [...repos].slice(0, OFFLINE_REPOS_LIMIT);
}

export type OfflineHeaders = Readonly<Record<string, string>>;

/*
 * The headers that let the service worker keep a read's answer: only on a
 * GET, only for a session with a cache scope that keeps some repository, and
 * then for the account's repository list, or for a repository on the list.
 */
export function offlineHeadersForPath(path: string, method: string | undefined, identity: unknown, storage: OfflineStorage | null): OfflineHeaders {
  if (String(method || 'GET').toUpperCase() !== 'GET') return {};
  const scope = scopeOf(identity);
  const list = offlineRepoList(identity, storage);
  if (!scope || list.length === 0) return {};
  if (/^\/api\/repos(?:[?/]|$)/.test(path)) return { [OFFLINE_SCOPE_HEADER]: scope, [OFFLINE_REPO_HEADER]: 'account' };
  const match = /^\/api\/repo\/([^/]+)\/([^/?]+)/.exec(path);
  if (!match) return {};
  /* A path whose escapes do not decode names no repository on the list; it is asked uncached rather than not at all. */
  let repoKey: string;
  try { repoKey = offlineRepoKey(identity, decodeURIComponent(match[1] ?? ''), decodeURIComponent(match[2] ?? '')); } catch { return {}; }
  if (!list.includes(repoKey)) return {};
  return { [OFFLINE_SCOPE_HEADER]: scope, [OFFLINE_REPO_HEADER]: repoKey };
}
