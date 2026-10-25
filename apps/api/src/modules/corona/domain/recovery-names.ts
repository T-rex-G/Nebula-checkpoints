/*
 * The names a restore is allowed to act on: a repository path, a branch and
 * a commit, each refused with a 400 when it is not one; and a path as a Git
 * LFS attribute pattern, escaped so it matches only itself.
 */
import { isCommitSha } from '../../../../../../packages/contracts/src/ids.ts';

export type InvalidName = Error & { status: number; code: string };
function invalid(message: string, code: string): InvalidName {
  return Object.assign(new Error(message), { status: 400, code });
}

export function normalizeRepoPath(value: unknown, label = 'path'): string {
  const raw = String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  if (!raw || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw) || raw.endsWith('/') ||
      raw.split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid(`Invalid repository ${label}`, 'INVALID_REPOSITORY_PATH');
  }
  return raw;
}

export function normalizeBranchName(value: unknown, label = 'branch'): string {
  const name = String(value == null ? '' : value);
  if (!name || name === '@' || name.length > 255 || /[\u0000- \u007f~^:?*\\]/.test(name) || name.includes('[') ||
      name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('..') ||
      name.includes('//') || name.includes('@{') ||
      name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw invalid(`Invalid ${label} name`, 'INVALID_BRANCH_NAME');
  }
  return name;
}

/* A full object id in either case, answered in lower case. */
export function normalizeCommitSha(value: unknown, label = 'commit SHA'): string {
  const sha = String(value == null ? '' : value);
  if (!isCommitSha(sha.toLowerCase())) throw invalid(`Invalid ${label}`, 'INVALID_COMMIT_SHA');
  return sha.toLowerCase();
}

export function lfsAttributePattern(repoPath: unknown): string {
  return '/' + normalizeRepoPath(repoPath)
    .replace(/[\\*?\[\]#]/g, ch => `\\${ch}`)
    .replace(/ /g, '\\ ');
}
