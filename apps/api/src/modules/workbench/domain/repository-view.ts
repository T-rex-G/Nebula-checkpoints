/*
 * What the signed-in account may do in a repository, as the provider reports
 * it on the repository itself: the page opens a repository somebody else owns
 * -- any public one -- read-only, and says so, rather than offering changes
 * the provider would refuse. The provider still decides every change.
 */
import { member } from '../../../platform/values/fields.ts';

export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';

export function repositoryPermission(info: unknown): RepositoryPermission {
  const permissions = info && member(info, 'permissions');
  if (!permissions || typeof permissions !== 'object') return 'unknown';
  return member(permissions, 'admin') ? 'admin'
    : member(permissions, 'maintain') ? 'maintain'
      : member(permissions, 'push') ? 'write'
        : member(permissions, 'triage') ? 'triage'
          : member(permissions, 'pull') ? 'read' : 'none';
}
