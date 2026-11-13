import { dateFrom, fieldsOf, listOf } from '../../../platform/values/fields.ts';

/*
 * The facts the overview scores, read rather than assumed: what a credential
 * can reach, and the leaked credentials Exposure has found.
 *
 * The overview used to score three things it had never looked at. The
 * credential was called "a personal access token: broader scope, revoked as a
 * whole" whatever the token actually was -- a fine-grained token limited to one
 * repository and expiring next week read exactly like a classic token with
 * every scope and no expiry. Recovery was "available here" because the
 * provider supports snapshots, whether or not a single recovery point existed.
 * And the leaked credentials Exposure had found did not reach the score at all.
 *
 * Everything here is a classification of something the provider or the store
 * reported. Nothing carries a credential: a token contributes its kind (read
 * from its published prefix), the scope names the provider reports for it and
 * its expiry date, never the token or any part of it.
 */

/*
 * GitHub publishes its token prefixes, and the prefix is the only reliable
 * way to tell the kinds apart without asking for more than the session needs.
 * https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/
 */
const GITHUB_PREFIXES = Object.freeze([
  Object.freeze({ prefix: 'github_pat_', kind: 'fine-grained' }),
  Object.freeze({ prefix: 'ghp_', kind: 'classic' }),
  Object.freeze({ prefix: 'gho_', kind: 'oauth' }),
  Object.freeze({ prefix: 'ghu_', kind: 'app-user' }),
  Object.freeze({ prefix: 'ghs_', kind: 'installation' })
]);

/* Scopes that reach beyond reading and writing code: administration of the
   account, its organisations, its keys or its hooks, and deleting repositories. */
export const GITHUB_BROAD_SCOPES: readonly string[] = Object.freeze([
  'admin:org', 'admin:enterprise', 'admin:repo_hook', 'admin:org_hook', 'admin:public_key',
  'admin:gpg_key', 'admin:ssh_signing_key', 'delete_repo', 'site_admin', 'user', 'write:packages',
  'delete:packages', 'workflow'
]);

export type TokenKind = 'fine-grained' | 'classic' | 'oauth' | 'app-user' | 'installation' | 'unknown';

export function githubTokenKind(token: unknown): TokenKind {
  const value = String(token || '');
  const match = GITHUB_PREFIXES.find(entry => value.startsWith(entry.prefix));
  return match ? match.kind : 'unknown';
}

function scopeList(header: unknown): string[] {
  return String(header || '')
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => /^[a-z_:]{2,40}$/.test(scope))
    .slice(0, 40);
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  /* GitHub writes "2026-10-31 09:30:00 UTC". */
  const normalised = String(value).trim().replace(/ UTC$/, 'Z').replace(' ', 'T');
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export interface CredentialInput {
  readonly provider?: unknown;
  readonly authMethod?: unknown;
  readonly token?: unknown;
  readonly scopesHeader?: unknown;
  readonly expiresHeader?: unknown;
  readonly now?: unknown;
}

export interface CredentialPosture {
  readonly kind: TokenKind;
  /* 0 to 1, or null when the credential's reach could not be read. */
  readonly rating: number | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly detail: string;
}

/*
 * One rating per kind, with the reasons that moved it. The rating is how far
 * the credential's reach is limited -- to the repositories chosen, and in time
 * -- not how strong a password is: a stolen fine-grained token that expires on
 * Friday is a smaller incident than a stolen classic one that never does.
 */
export function credentialPosture(input: CredentialInput = {}): CredentialPosture {
  const provider = String(input.provider || 'github');
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  if (provider === 'github' && input.authMethod === 'github-app') {
    return Object.freeze({
      kind: 'installation',
      rating: 1,
      scopes: [],
      expiresAt: null,
      detail: 'GitHub App installation: short-lived tokens, limited to the repositories the installation was given, revocable per installation.'
    });
  }
  if (provider === 'github') {
    const kind = githubTokenKind(input.token);
    const scopes = scopeList(input.scopesHeader);
    const expiresAt = isoDate(input.expiresHeader);
    const expired = expiresAt !== null && Date.parse(expiresAt) <= now;
    const broad = scopes.filter(scope => GITHUB_BROAD_SCOPES.includes(scope));
    if (kind === 'fine-grained') {
      const rating = expired ? 0 : expiresAt ? 0.9 : 0.7;
      return Object.freeze({
        kind, rating, scopes: [], expiresAt,
        detail: expired
          ? 'Fine-grained token that has expired: it no longer works and should be replaced.'
          : expiresAt
            ? `Fine-grained token limited to the repositories chosen for it, expiring ${expiresAt.slice(0, 10)}.`
            : 'Fine-grained token limited to the repositories chosen for it, set never to expire.'
      });
    }
    if (kind === 'classic' || kind === 'oauth') {
      const label = kind === 'classic' ? 'Classic token' : 'OAuth token';
      const reachesAll = scopes.includes('repo');
      let rating = reachesAll ? 0.5 : scopes.includes('public_repo') ? 0.65 : 0.6;
      if (broad.length) rating -= 0.15;
      if (!expiresAt) rating -= 0.1;
      if (expired) rating = 0;
      const reach = reachesAll
        ? 'reaches every repository the account can'
        : scopes.length ? `scoped to ${scopes.join(', ')}` : 'its scopes were not reported';
      const extra = broad.length ? `, including ${broad.join(', ')}` : '';
      const time = expired ? ' and has expired' : expiresAt ? `, expiring ${expiresAt.slice(0, 10)}` : ' and never expires';
      return Object.freeze({
        kind, rating: Math.max(0, Math.round(rating * 100) / 100), scopes, expiresAt,
        detail: `${label}: ${reach}${extra}${time}.`
      });
    }
    return Object.freeze({
      kind: 'unknown', rating: null, scopes, expiresAt,
      detail: 'The token’s kind could not be read, so its reach is not scored.'
    });
  }
  return Object.freeze({
    kind: 'unknown', rating: null, scopes: [], expiresAt: null,
    detail: 'This account is unsupported or its credential could not be read, so its reach is not scored.'
  });
}

export type Severity3 = 'critical' | 'serious' | 'warning';
export type OpenCounts = Record<Severity3, number>;

export interface RepositoryExposure {
  readonly owner: unknown;
  readonly repo: unknown;
  readonly scannedAt: string | null;
  readonly partial: boolean;
  readonly open: Readonly<OpenCounts>;
}

/*
 * Open findings per repository, by severity, from rows of
 * { owner, repo, finishedAt, state, rule, count }. Severity comes from the
 * narration table the findings screen already uses, so the overview and the
 * screen can never call the same finding two different things.
 */
export function exposureSummary(rows: unknown, severityForRule: (rule: string) => unknown): readonly RepositoryExposure[] {
  const byRepo = new Map<string, { owner: unknown; repo: unknown; scannedAt: string | null; partial: boolean; open: OpenCounts }>();
  for (const value of listOf(rows)) {
    const row = fieldsOf(value);
    if (!value || !row.owner || !row.repo) continue;
    const key = `${String(row.owner)}/${String(row.repo)}`.toLowerCase();
    let entry = byRepo.get(key);
    if (!entry) {
      entry = {
        owner: row.owner, repo: row.repo,
        scannedAt: row.finishedAt ? dateFrom(row.finishedAt).toISOString() : null,
        partial: row.state === 'partial',
        open: { critical: 0, serious: 0, warning: 0 }
      };
      byRepo.set(key, entry);
    }
    const count = Number(row.count) || 0;
    if (!row.rule || !count) continue;
    const severity = severityForRule(String(row.rule));
    const bucket: Severity3 = severity === 'critical' ? 'critical' : severity === 'serious' ? 'serious' : 'warning';
    entry.open[bucket] += count;
  }
  return Object.freeze([...byRepo.values()].map(entry => Object.freeze({
    ...entry, open: Object.freeze(entry.open)
  })));
}
