/*
 * The workbench's one way to change a branch: a new commit of tree entries on
 * top of the head it read, through the Git Data API, and the branch moved to
 * it without force. A head that moved since the caller's view refuses the
 * write before anything is created; a branch that moves between the read and
 * the update is refused by the provider and answered as the same refusal.
 *
 * An entry keeps the mode and type of the path it replaces (or of the path it
 * is moved from) unless it says otherwise, so an executable or a submodule
 * survives an edit. When the base tree is too large to list at once, the
 * entries' prior paths are looked up one level at a time instead.
 */
import { member } from '../../../platform/values/fields.ts';
import { normalizeRepoPath } from '../../corona/index.ts';
import { assertExpectedHead, branchChangedError, destinationExistsError } from '../domain/head-checks.ts';

export interface GhRequest {
  readonly method?: string;
  readonly body?: unknown;
}
/* The provider's REST API, as the server reaches it for the session's account. */
export type Gh = (account: unknown, apiPath: string, options?: GhRequest) => Promise<unknown>;

/* What `options.mustNotExist` may name: paths the commit creates and must not find already there. */
export interface CommitOptions {
  readonly mustNotExist?: unknown;
}

export interface CommitWriter {
  gitTreeEntryByPath(account: unknown, owner: unknown, repo: unknown, rootTreeSha: unknown, repoPath: unknown, cache?: Map<unknown, unknown>): Promise<unknown>;
  assertPathsFree(account: unknown, owner: unknown, repo: unknown, rootTreeSha: unknown, existing: ReadonlyMap<unknown, unknown>, complete: boolean, targets: readonly unknown[], removed: ReadonlySet<unknown>): Promise<void>;
  commitTree(account: unknown, owner: unknown, repo: unknown, branch: string, message: unknown, treeEntries: readonly unknown[], expectedHeadSha?: unknown, options?: CommitOptions): Promise<unknown>;
}

/* `(x.tree || []).find(...)` and `.map(...)`, as JavaScript calls them on a provider's answer and names them when they fail. */
function entriesOf(value: unknown, expression: string): readonly unknown[] {
  const list = value || [];
  if (!Array.isArray(list)) throw new TypeError(`${expression} is not a function`);
  return list;
}

/* `target.split('/')`, as JavaScript calls it on a path it was given. */
function segments(target: unknown): string[] {
  if (typeof target !== 'string') throw new TypeError('target.split is not a function');
  return target.split('/');
}

export function createCommitWriter(gh: Gh): CommitWriter {
  async function gitTreeEntryByPath(account: unknown, owner: unknown, repo: unknown, rootTreeSha: unknown, repoPath: unknown, cache = new Map<unknown, unknown>()): Promise<unknown> {
    const parts = normalizeRepoPath(repoPath).split('/');
    let treeSha = rootTreeSha;
    for (let index = 0; index < parts.length; index += 1) {
      let tree = cache.get(treeSha);
      if (!tree) {
        tree = await gh(account, `/repos/${String(owner)}/${String(repo)}/git/trees/${String(treeSha)}`);
        cache.set(treeSha, tree);
      }
      const entry = entriesOf(member(tree, 'tree'), '(tree.tree || []).find').find(item => member(item, 'path') === parts[index]);
      if (!entry) return null;
      if (index === parts.length - 1) return entry;
      if (member(entry, 'type') !== 'tree') return null;
      treeSha = member(entry, 'sha');
    }
    return null;
  }

  async function assertPathsFree(account: unknown, owner: unknown, repo: unknown, rootTreeSha: unknown, existing: ReadonlyMap<unknown, unknown>, complete: boolean, targets: readonly unknown[], removed: ReadonlySet<unknown>): Promise<void> {
    const cache = new Map<unknown, unknown>();
    const lookup = async (target: string): Promise<unknown> => (complete ? existing.get(target) || null
      : await gitTreeEntryByPath(account, owner, repo, rootTreeSha, target, cache));
    for (const target of targets) {
      const parts = segments(target);
      const named = parts.join('/');
      for (let index = 1; index < parts.length; index += 1) {
        const parent = parts.slice(0, index).join('/');
        if (removed.has(parent)) continue;
        const found = await lookup(parent);
        if (found && member(found, 'type') !== 'tree') throw destinationExistsError(named, parent);
        if (!found) break;
      }
      if (removed.has(target)) continue;
      if (await lookup(named)) throw destinationExistsError(named);
    }
  }

  async function commitTree(account: unknown, owner: unknown, repo: unknown, branch: string, message: unknown, treeEntries: readonly unknown[], expectedHeadSha: unknown = '', options: CommitOptions = {}): Promise<unknown> {
    const repository = `/repos/${String(owner)}/${String(repo)}`;
    const ref = await gh(account, `${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
    const parentSha = member(member(ref, 'object'), 'sha');
    assertExpectedHead(expectedHeadSha, parentSha);
    const parent = await gh(account, `${repository}/git/commits/${String(parentSha)}`);
    let existing = new Map<unknown, unknown>();
    let baseTreeTruncated = false;
    let baseTreeRead = false;
    try {
      const base = await gh(account, `${repository}/git/trees/${String(member(member(parent, 'tree'), 'sha'))}?recursive=1`);
      existing = new Map(entriesOf(member(base, 'tree'), '(base.tree || []).map').map(entry => [member(entry, 'path'), entry]));
      baseTreeTruncated = !!member(base, 'truncated');
      baseTreeRead = true;
    } catch {}
    const mustNotExist: readonly unknown[] = Array.isArray(options.mustNotExist) ? options.mustNotExist : [];
    if (mustNotExist.length) {
      const removed = new Set(treeEntries.filter(entry => member(entry, 'sha') === null).map(entry => member(entry, 'path')));
      await assertPathsFree(account, owner, repo, member(member(parent, 'tree'), 'sha'), existing, baseTreeRead && !baseTreeTruncated, mustNotExist, removed);
    }
    if (baseTreeTruncated) {
      const treeCache = new Map<unknown, unknown>();
      for (const entry of treeEntries) {
        if (member(entry, 'forceMode')) continue;
        const priorPath = member(entry, 'preserveFrom') || member(entry, 'path');
        if (existing.has(priorPath)) continue;
        const prior = await gitTreeEntryByPath(account, owner, repo, member(member(parent, 'tree'), 'sha'), priorPath, treeCache);
        if (prior) existing.set(priorPath, prior);
      }
    }
    const normalizedEntries = treeEntries.map(entry => {
      const prior = existing.get(member(entry, 'preserveFrom') || member(entry, 'path'));
      const forceMode = member(entry, 'forceMode');
      const mode = forceMode && member(entry, 'mode') ? member(entry, 'mode') : (prior && member(prior, 'mode')) || member(entry, 'mode') || '100644';
      const type = forceMode && member(entry, 'type') ? member(entry, 'type') : (prior && member(prior, 'type')) || member(entry, 'type') || (mode === '160000' ? 'commit' : 'blob');
      const out: Record<string, unknown> = { path: member(entry, 'path'), mode, type };
      if (Object.prototype.hasOwnProperty.call(entry, 'sha')) out.sha = member(entry, 'sha');
      else if (Object.prototype.hasOwnProperty.call(entry, 'content')) out.content = member(entry, 'content');
      return out;
    });
    const tree = await gh(account, `${repository}/git/trees`, {
      method: 'POST', body: { base_tree: member(member(parent, 'tree'), 'sha'), tree: normalizedEntries }
    });
    const commit = await gh(account, `${repository}/git/commits`, {
      method: 'POST', body: { message, tree: member(tree, 'sha'), parents: [parentSha] }
    });
    try {
      await gh(account, `${repository}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH', body: { sha: member(commit, 'sha'), force: false }
      });
    } catch (error) {
      if (member(error, 'status') === 409 || member(error, 'status') === 422) throw branchChangedError();
      throw error;
    }
    return member(commit, 'sha');
  }

  return { gitTreeEntryByPath, assertPathsFree, commitTree };
}
