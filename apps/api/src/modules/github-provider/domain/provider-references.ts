/*
 * What GitHub's answers about references say, in one form: the commit a
 * reference points at, whichever of GitHub's shapes carries it, and a
 * repository's branches with their protection and head commit.
 */
import { listOf, read } from '../../../platform/values/fields.ts';

/* The commit a reference names, lower-cased, or '' when none of its shapes carries a full object id. */
export function referenceSha(reference: unknown): string {
  const object = read(reference, 'object');
  const commit = read(reference, 'commit');
  const target = read(reference, 'target');
  const value = reference && (
    object && (read(object, 'sha') || read(object, 'id')) ||
    commit && (read(commit, 'sha') || read(commit, 'id')) ||
    target && (read(target, 'sha') || read(target, 'id')) ||
    read(reference, 'sha') || read(reference, 'id')
  );
  return /^[0-9a-f]{40}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
}

export interface ProviderBranch {
  readonly name: unknown;
  readonly protected: unknown;
  readonly sha: unknown;
}

/* A repository's branches as GitHub lists them. Only GitHub is a provider now; any other is refused. */
export function normalizeProviderBranches(provider: unknown, branches: unknown): ProviderBranch[] {
  if (provider !== 'github') throw new TypeError('Provider branches require GitHub');
  return listOf(branches).map(branch => {
    const commit = branch && read(branch, 'commit');
    return {
      name: branch && read(branch, 'name'),
      protected: branch && read(branch, 'protected'),
      sha: commit && read(commit, 'sha') || ''
    };
  });
}
