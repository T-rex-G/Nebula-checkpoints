/*
 * What a person's safety controls refuse, for a request.
 *
 * Read-only mode refuses every write. Protected paths refuse a write that
 * names one of them, and, while any are protected, a write that acts on the
 * whole repository: a restore, a reset, a reference restore, a branch's
 * deletion or the repository's. A request's controls are the ones its guard
 * loaded for the identity (effectiveSafety), else the session's copy.
 *
 * Not every write is the repository's. The controls themselves, the session's
 * security, sign-out, the accounts and the GitHub App are always reachable,
 * so a person can unlock what they locked. A snapshot comparison, a restore
 * preview and an emergency manifest only read or contain. Governance changes
 * rows this server owns, not the repository, so read-only containment and
 * protected paths do not apply to its lifecycle routes either.
 */
import { pathMatches } from '../../../platform/values/path-patterns.ts';
import { defaultSafety, type SafetyControls } from './safety-controls.ts';
import { protectedPatternsForRepository } from './safeguards.ts';

export const SAFETY_EXEMPT: readonly string[] = ['/api/safety', '/api/security', '/api/logout', '/api/accounts', '/api/github-app'];

export interface GuardedRequest {
  readonly method?: string;
  readonly path?: string;
  readonly params?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly effectiveSafety?: unknown;
  readonly session?: { readonly safety?: unknown } | null;
}

interface PathFields {
  readonly path?: unknown; readonly from?: unknown; readonly to?: unknown; readonly newPath?: unknown;
  readonly oldPath?: unknown; readonly prefix?: unknown; readonly p?: unknown;
  readonly paths?: unknown; readonly files?: unknown; readonly ops?: unknown;
}

export function safetyOf(req: GuardedRequest): SafetyControls {
  return defaultSafety(req.effectiveSafety || req.session && req.session.safety);
}

/* Every repository path a request names, in its body or its query. */
export function candidatePaths(req: GuardedRequest): string[] {
  const b = (req.body || {}) as PathFields, q = (req.query || {}) as PathFields;
  const out: string[] = [];
  for (const v of [b.path, b.from, b.to, b.newPath, b.oldPath, b.prefix, q.path, q.p]) if (typeof v === 'string' && v) out.push(v);
  if (Array.isArray(b.paths)) for (const v of b.paths) if (typeof v === 'string') out.push(v);
  if (Array.isArray(b.files)) for (const f of b.files) if (f && typeof f.path === 'string') out.push(f.path);
  if (Array.isArray(b.ops)) for (const op of b.ops) if (op && typeof op.path === 'string') out.push(op.path);
  return out.map(p => p.replace(/^\/+/, ''));
}

export function protectedPatternsForReq(req: GuardedRequest): string[] {
  const sf = safetyOf(req);
  const { owner, repo } = req.params || {};
  if (!owner || !repo) return [];
  return protectedPatternsForRepository(sf.protected, owner, repo);
}

/* The first path a protected pattern covers, as it was handed in; paths come from a request or the provider, so any value is matched as the matcher reads it. */
export function protectedPathHit(req: GuardedRequest, paths: readonly unknown[] | null | undefined): unknown {
  const list = protectedPatternsForReq(req);
  return (paths || []).find(p => list.some(pattern => pathMatches(pattern, p))) || '';
}

export function protectedPathError(req: GuardedRequest, paths: readonly unknown[] | null | undefined): string {
  const hit = protectedPathHit(req, paths);
  return hit ? `${hit} is a protected file — unlock it in Safeguards to change it.` : '';
}

export function enforceProtectedPaths(req: GuardedRequest, paths: readonly unknown[] | null | undefined): void {
  const error = protectedPathError(req, paths);
  if (error) throw Object.assign(new Error(error), { status: 423, code: 'PROTECTED_PATH' });
}

export function isCurrentGovernanceControlPlaneRequest(req: GuardedRequest): boolean {
  const method = String(req.method || '').toUpperCase();
  const route = String(req.path || '');
  const prefix = '^/api/repo/[^/]+/[^/]+/governance/policies';
  /*
   * Governance changes rows this server owns, not the repository, so read-only
   * containment and protected paths do not apply to them -- and without the
   * lifecycle routes listed here, "/restore" and "/reset" were read as
   * repository-wide writes and refused whenever any path was protected.
   */
  const patterns = method === 'PATCH'
    ? [new RegExp(`${prefix}/[^/]+/drafts/[^/]+$`)]
    : method === 'DELETE'
      ? [new RegExp(`${prefix}/[^/]+/drafts/[^/]+$`)]
    : method === 'POST'
      ? [
          new RegExp(`${prefix}$`),
          new RegExp(`${prefix}/[^/]+/validate$`),
          new RegExp(`${prefix}/[^/]+/drafts$`),
          new RegExp(`${prefix}/[^/]+/drafts/[^/]+/validate$`),
          new RegExp(`${prefix}/[^/]+/drafts/[^/]+/submit$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/simulate$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/reviewers/me$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/decisions$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/activate$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/rollback$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/exceptions$`),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/baselines/generate$'),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/exceptions/[^/]+/decision$'),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/exceptions/[^/]+/revoke$'),
          new RegExp(`${prefix}/[^/]+/deactivate$`),
          new RegExp(`${prefix}/[^/]+/archive$`),
          new RegExp(`${prefix}/[^/]+/restore$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/withdraw$`),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/reset$')
        ]
      : [];
  return patterns.some(pattern => pattern.test(route));
}

/* Why the controls refuse this request, or null when they do not. */
export function guardSafety(req: GuardedRequest): string | null {
  const r = req as GuardedRequest & { readonly path: string; readonly method: string };
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) return null;
  if (isCurrentGovernanceControlPlaneRequest(r)) return null;
  if (r.path.endsWith('/snapshot-compare') || r.path.endsWith('/restore-preview') || r.path.endsWith('/emergency-manifest')) return null;
  if (SAFETY_EXEMPT.some(p => r.path.startsWith(p))) return null;
  const sf = safetyOf(r);
  if (sf.readOnly) return 'Read-only mode is on — writes are disabled. Turn it off in Safeguards.';
  const list = protectedPatternsForReq(r);
  if (list.length) {
    const hit = protectedPathError(r, candidatePaths(r));
    if (hit) return hit;
    const repositoryWide = r.path.endsWith('/restore') || r.path.endsWith('/reset') ||
      r.path.endsWith('/restore-refs') ||
      (r.method === 'DELETE' && /^\/api\/repo\/[^/]+\/[^/]+$/.test(r.path)) ||
      (r.method === 'DELETE' && r.path.includes('/branches/'));
    if (repositoryWide) return 'This repository contains protected paths. Unlock them before a repository-wide restore, reset, branch/reference deletion, or repository deletion.';
  }
  return null;
}
