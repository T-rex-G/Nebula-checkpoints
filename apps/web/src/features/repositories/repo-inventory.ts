/*
 * The repositories in the browser's inventory, read one way.
 *
 * The security posture card and the pull-request board both start from the
 * repository list the workbench already holds, and both must agree about
 * which repositories it names: the same owner/name parsing, the same
 * case-insensitive key, the same treatment of a duplicate or a malformed
 * entry. Two copies of this drifted apart once a fix landed in only one of
 * them, so there is one.
 */
import { field, hasFields, items } from '../../platform/values.ts';

/* One repository of the inventory: as listed, keyed case-insensitively, and when it was last pushed (0 when unknown). */
export interface InventoryEntry {
  owner: string;
  repo: string;
  key: string;
  pushedAt: number;
}

/* One repository, case-insensitively: GitHub treats `Acme/Web` and `acme/web` as the same one. */
export function repoKey(owner: unknown, name: unknown): string {
  return `${String(owner || '')}/${String(name || '')}`.toLowerCase();
}

/*
 * Each repository once, as `{ owner, repo, key, pushedAt }`, in the order
 * given. `owner` may be a login or a GitHub owner object; an entry with
 * neither an owner and name nor a full_name is left out rather than guessed.
 */
export function inventory(repos: unknown): InventoryEntry[] {
  const list: InventoryEntry[] = [];
  const seen = new Set<string>();
  for (const repo of items(repos)) {
    if (!repo) continue;
    const listedOwner = field(repo, 'owner');
    let owner: unknown = hasFields(listedOwner) ? field(listedOwner, 'login') : listedOwner;
    let name: unknown = field(repo, 'name');
    const fullName = field(repo, 'full_name');
    if ((!owner || !name) && fullName) [owner, name] = String(fullName).split('/');
    if (!owner || !name) continue;
    const key = repoKey(owner, name);
    if (seen.has(key)) continue;
    seen.add(key);
    const pushed = field(repo, 'pushed_at') || field(repo, 'updated_at') || '';
    list.push({ owner: String(owner), repo: String(name), key, pushedAt: Date.parse(String(pushed)) || 0 });
  }
  return list;
}

const RepoInventory = Object.freeze({ inventory, repoKey });
export default RepoInventory;
