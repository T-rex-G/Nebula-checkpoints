'use strict';

/*
 * The facts the overview scores, read rather than assumed.
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
const GITHUB_BROAD_SCOPES = Object.freeze([
  'admin:org', 'admin:enterprise', 'admin:repo_hook', 'admin:org_hook', 'admin:public_key',
  'admin:gpg_key', 'admin:ssh_signing_key', 'delete_repo', 'site_admin', 'user', 'write:packages',
  'delete:packages', 'workflow'
]);

const GITLAB_BROAD_SCOPES = Object.freeze(['api', 'sudo', 'admin_mode', 'write_registry']);

function githubTokenKind(token) {
  const value = String(token || '');
  const match = GITHUB_PREFIXES.find(entry => value.startsWith(entry.prefix));
  return match ? match.kind : 'unknown';
}

function scopeList(header) {
  return String(header || '')
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => /^[a-z_:]{2,40}$/.test(scope))
    .slice(0, 40);
}

function isoDate(value) {
  if (!value) return null;
  /* GitHub writes "2026-10-31 09:30:00 UTC"; GitLab writes "2026-10-31". */
  const normalised = String(value).trim().replace(/ UTC$/, 'Z').replace(' ', 'T');
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/*
 * One rating per kind, with the reasons that moved it. The rating is how far
 * the credential's reach is limited -- to the repositories chosen, and in time
 * -- not how strong a password is: a stolen fine-grained token that expires on
 * Friday is a smaller incident than a stolen classic one that never does.
 */
function credentialPosture(input = {}) {
  const provider = String(input.provider || 'github');
  const now = Number.isFinite(input.now) ? input.now : Date.now();
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
    const expired = expiresAt && Date.parse(expiresAt) <= now;
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
  if (provider === 'gitlab') {
    const self = input.gitlabSelf;
    if (!self || !Array.isArray(self.scopes)) {
      return Object.freeze({
        kind: 'unknown', rating: null, scopes: [], expiresAt: null,
        detail: 'GitLab did not report this token’s scopes, so its reach is not scored.'
      });
    }
    const scopes = self.scopes.map(String).filter(scope => /^[a-z_]{2,40}$/.test(scope)).slice(0, 40);
    const expiresAt = isoDate(self.expires_at);
    const expired = expiresAt && Date.parse(expiresAt) <= now;
    const broad = scopes.filter(scope => GITLAB_BROAD_SCOPES.includes(scope));
    let rating = broad.length ? 0.55 : 0.85;
    if (!expiresAt) rating -= 0.1;
    if (expired || self.active === false || self.revoked === true) rating = 0;
    const time = expired ? ' and has expired' : expiresAt ? `, expiring ${expiresAt.slice(0, 10)}` : ' and never expires';
    return Object.freeze({
      kind: 'personal-access-token', rating: Math.max(0, Math.round(rating * 100) / 100), scopes, expiresAt,
      detail: broad.length
        ? `GitLab token with ${broad.join(', ')} scope: full API access to everything the account can reach${time}.`
        : `GitLab token scoped to ${scopes.join(', ') || 'no named scope'}${time}.`
    });
  }
  return Object.freeze({
    kind: 'unknown', rating: null, scopes: [], expiresAt: null,
    detail: 'Gitea does not report a token’s scope, so its reach is not scored.'
  });
}

/*
 * Open findings per repository, by severity, from rows of
 * { owner, repo, finishedAt, state, rule, count }. Severity comes from the
 * narration table the findings screen already uses, so the overview and the
 * screen can never call the same finding two different things.
 */
function exposureSummary(rows, severityForRule) {
  const byRepo = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.owner || !row.repo) continue;
    const key = `${row.owner}/${row.repo}`.toLowerCase();
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        owner: row.owner, repo: row.repo,
        scannedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
        partial: row.state === 'partial',
        open: { critical: 0, serious: 0, warning: 0 }
      });
    }
    const entry = byRepo.get(key);
    const count = Number(row.count) || 0;
    if (!row.rule || !count) continue;
    const severity = severityForRule(row.rule);
    const bucket = severity === 'critical' ? 'critical' : severity === 'serious' ? 'serious' : 'warning';
    entry.open[bucket] += count;
  }
  return Object.freeze([...byRepo.values()].map(entry => Object.freeze({
    ...entry, open: Object.freeze(entry.open)
  })));
}

/*
 * The reader behind GET /api/workspace/posture. Four independent readings,
 * each allowed to fail on its own: a database that is down makes recovery and
 * exposure unavailable, not the credential; a provider that will not describe
 * its token makes the credential unmeasured, not the database.
 *
 * Every provider request goes through the transports the server hands in --
 * the same guarded ones every other route uses -- and the token never leaves
 * this function except as the kind its prefix names.
 */
function createPostureReader(deps) {
  const {
    gh, glFetch, dbReady, pool, identityKey, normalizePolicyScope, exposureStore, severityOf,
    databaseConfigured, maintenance, hostedAlpha
  } = deps;

  async function credential(account) {
    const provider = account.provider || 'github';
    try {
      if (provider === 'github' && account.authMethod !== 'github-app') {
        const response = await gh(account, '/user', { raw: true, timeoutMs: 8000 });
        const scopesHeader = response.ok ? response.headers.get('x-oauth-scopes') : '';
        const expiresHeader = response.ok ? response.headers.get('github-authentication-token-expiration') : '';
        if (response.body) await response.body.cancel();
        return credentialPosture({ provider, token: account.token, scopesHeader, expiresHeader });
      }
      if (provider === 'gitlab') {
        const self = await glFetch(account, '/personal_access_tokens/self', { timeoutMs: 8000 }).catch(() => null);
        return credentialPosture({ provider, gitlabSelf: self });
      }
      return credentialPosture({ provider, authMethod: account.authMethod });
    } catch {
      return credentialPosture({ provider: 'unknown' });
    }
  }

  async function recovery(account) {
    if (!(await dbReady())) return { available: false, repositories: [] };
    const rows = await pool().query(
      `SELECT owner, repo, max(created_at) AS latest, count(*) AS points FROM nv_recovery_snapshots
        WHERE provider=$1 AND identity_key=$2
        GROUP BY owner, repo ORDER BY max(created_at) DESC LIMIT 500`,
      [account.provider || 'github', identityKey(account)]
    );
    return {
      available: true,
      repositories: rows.rows.map(row => ({
        owner: row.owner,
        repo: row.repo,
        latestAt: row.latest ? new Date(row.latest).toISOString() : null,
        points: Number(row.points) || 0
      }))
    };
  }

  async function exposure(account) {
    if (!databaseConfigured || !(await dbReady())) return { available: false, repositories: [] };
    const provider = account.provider || 'github';
    /* The same authority the exposure routes key their rows by. */
    const authority = normalizePolicyScope({ provider, baseUrl: account.baseUrl || '', owner: 'scope', repo: 'scope' }).authority;
    const rows = await exposureStore().workspaceSummary({ provider, authority, identityKey: identityKey(account) });
    return { available: true, repositories: exposureSummary(rows, severityOf) };
  }

  async function read(account) {
    const settle = promise => promise.then(value => value, () => null);
    const [credentialReading, recoveryReading, exposureReading, databaseReady] = await Promise.all([
      credential(account),
      settle(recovery(account)),
      settle(exposure(account)),
      databaseConfigured ? settle(dbReady()) : Promise.resolve(false)
    ]);
    const database = databaseConfigured ? (databaseReady ? 'ready' : 'unavailable') : 'not-configured';
    return {
      credential: credentialReading,
      recovery: recoveryReading || { available: false, repositories: [] },
      exposure: exposureReading || { available: false, repositories: [] },
      boundary: {
        state: maintenance || (hostedAlpha && database !== 'ready') ? 'degraded' : 'online',
        database,
        maintenance: Boolean(maintenance)
      }
    };
  }

  return Object.freeze({ read });
}

module.exports = Object.freeze({
  GITHUB_BROAD_SCOPES, GITLAB_BROAD_SCOPES,
  githubTokenKind, credentialPosture, exposureSummary, createPostureReader
});
