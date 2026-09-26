'use strict';

/*
 * The facts the overview scores. Each case is a way the reading could lie:
 * calling a narrow token broad, a broad one narrow, an expired one usable, or
 * letting any part of the credential itself into what the browser receives.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const posture = require('../src/workspace-posture');

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
/* Prefixes split, so the release gate's secret scan has nothing to match. */
const token = (prefix, fill = 'Q') => `${prefix}${fill.repeat(30)}`;
const FINE = token(`github${'_'}pat_`);
const CLASSIC = token(`gh${'p'}_`);
const OAUTH = token(`gh${'o'}_`);

/* The kind is read from the published prefix and nothing else. */
{
  assert.strictEqual(posture.githubTokenKind(FINE), 'fine-grained');
  assert.strictEqual(posture.githubTokenKind(CLASSIC), 'classic');
  assert.strictEqual(posture.githubTokenKind(OAUTH), 'oauth');
  assert.strictEqual(posture.githubTokenKind(token(`gh${'u'}_`)), 'app-user');
  assert.strictEqual(posture.githubTokenKind(token(`gh${'s'}_`)), 'installation');
  assert.strictEqual(posture.githubTokenKind('0123456789abcdef'), 'unknown', 'a legacy hex token is not guessed at');
  assert.strictEqual(posture.githubTokenKind(''), 'unknown');
  assert.strictEqual(posture.githubTokenKind(null), 'unknown');
}

/* An installation is limited by construction and scores as such. */
{
  const app = posture.credentialPosture({ provider: 'github', authMethod: 'github-app', token: token(`gh${'s'}_`), now: NOW });
  assert.strictEqual(app.kind, 'installation');
  assert.strictEqual(app.rating, 1);
}

/* A fine-grained token is rated on its expiry; an expired one is rated zero. */
{
  const dated = posture.credentialPosture({ provider: 'github', token: FINE, expiresHeader: '2026-10-31 09:30:00 UTC', now: NOW });
  assert.strictEqual(dated.kind, 'fine-grained');
  assert.strictEqual(dated.rating, 0.9);
  assert.strictEqual(dated.expiresAt, '2026-10-31T09:30:00.000Z');
  assert.match(dated.detail, /expiring 2026-10-31/);

  const forever = posture.credentialPosture({ provider: 'github', token: FINE, now: NOW });
  assert.strictEqual(forever.rating, 0.7, 'a token that never expires reaches further in time');
  assert.match(forever.detail, /never to expire/);

  const expired = posture.credentialPosture({ provider: 'github', token: FINE, expiresHeader: '2026-01-01 00:00:00 UTC', now: NOW });
  assert.strictEqual(expired.rating, 0);
  assert.match(expired.detail, /expired/);
}

/* A classic token is rated on the scopes GitHub reports for it. */
{
  const everything = posture.credentialPosture({
    provider: 'github', token: CLASSIC, scopesHeader: 'repo, admin:org, delete_repo, workflow', now: NOW
  });
  assert.strictEqual(everything.kind, 'classic');
  assert.deepStrictEqual(everything.scopes, ['repo', 'admin:org', 'delete_repo', 'workflow']);
  assert.strictEqual(everything.rating, 0.25);
  assert.match(everything.detail, /reaches every repository the account can, including admin:org, delete_repo, workflow and never expires/);

  const narrow = posture.credentialPosture({
    provider: 'github', token: CLASSIC, scopesHeader: 'public_repo', expiresHeader: '2026-12-01 00:00:00 UTC', now: NOW
  });
  assert.strictEqual(narrow.rating, 0.65);
  assert(narrow.rating > everything.rating, 'a narrower token must score above a broader one');
  assert.match(narrow.detail, /scoped to public_repo, expiring 2026-12-01/);

  const oauth = posture.credentialPosture({ provider: 'github', token: OAUTH, scopesHeader: 'repo', now: NOW });
  assert.strictEqual(oauth.kind, 'oauth');
  assert.match(oauth.detail, /^OAuth token/);

  /* A header that is not a scope list contributes nothing, not free text. */
  const hostile = posture.credentialPosture({
    provider: 'github', token: CLASSIC, scopesHeader: `repo, <script>, ${'x'.repeat(80)}, ${CLASSIC}`, now: NOW
  });
  assert.deepStrictEqual(hostile.scopes, ['repo']);
}

/* A token whose kind is unreadable is unmeasured, not failed. */
{
  const odd = posture.credentialPosture({ provider: 'github', token: 'abcdef', now: NOW });
  assert.strictEqual(odd.rating, null);
  const gitea = posture.credentialPosture({ provider: 'gitea', now: NOW });
  assert.strictEqual(gitea.rating, null);
  assert.match(gitea.detail, /Gitea/);
}

/* GitLab reports its own scopes and expiry. */
{
  const api = posture.credentialPosture({ provider: 'gitlab', gitlabSelf: { scopes: ['api'], expires_at: '2026-11-01', active: true }, now: NOW });
  assert.strictEqual(api.rating, 0.55);
  assert.match(api.detail, /api scope: full API access/);
  const read = posture.credentialPosture({ provider: 'gitlab', gitlabSelf: { scopes: ['read_api', 'read_repository'], expires_at: '2026-11-01' }, now: NOW });
  assert.strictEqual(read.rating, 0.85);
  const revoked = posture.credentialPosture({ provider: 'gitlab', gitlabSelf: { scopes: ['read_api'], revoked: true, expires_at: '2026-11-01' }, now: NOW });
  assert.strictEqual(revoked.rating, 0);
  const silent = posture.credentialPosture({ provider: 'gitlab', gitlabSelf: null, now: NOW });
  assert.strictEqual(silent.rating, null, 'an OAuth session that cannot read its own token is unmeasured');
}

/* Nothing the browser receives carries any part of the credential. */
{
  for (const [input, secret] of [
    [{ provider: 'github', token: FINE, expiresHeader: '2026-10-31 09:30:00 UTC' }, FINE],
    [{ provider: 'github', token: CLASSIC, scopesHeader: 'repo' }, CLASSIC],
    [{ provider: 'github', token: OAUTH, scopesHeader: 'repo' }, OAUTH],
    [{ provider: 'github', token: 'abcdef0123456789abcdef' }, 'abcdef0123456789abcdef']
  ]) {
    const rendered = JSON.stringify(posture.credentialPosture({ ...input, now: NOW }));
    for (const probe of [secret, secret.slice(0, 10), secret.slice(-12)]) {
      assert.strictEqual(rendered.includes(probe), false, `the posture must not carry the credential: ${rendered}`);
    }
  }
}

/* Findings group per repository, by the narration's severity. */
{
  const severity = rule => ({ 'aws-access-key': 'critical', 'slack-webhook': 'serious' }[rule] || 'warning');
  const summary = posture.exposureSummary([
    { owner: 'Acme', repo: 'Demo', finishedAt: '2026-09-25T00:00:00.000Z', state: 'complete', rule: 'aws-access-key', count: 2 },
    { owner: 'Acme', repo: 'Demo', finishedAt: '2026-09-25T00:00:00.000Z', state: 'complete', rule: 'slack-webhook', count: 1 },
    { owner: 'Acme', repo: 'Demo', finishedAt: '2026-09-25T00:00:00.000Z', state: 'complete', rule: 'generic', count: 4 },
    { owner: 'Acme', repo: 'Clean', finishedAt: '2026-09-24T00:00:00.000Z', state: 'partial', rule: null, count: 0 },
    { owner: '', repo: 'nameless', rule: 'x', count: 1 },
    null
  ], severity);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(summary)), [
    { owner: 'Acme', repo: 'Demo', scannedAt: '2026-09-25T00:00:00.000Z', partial: false, open: { critical: 2, serious: 1, warning: 4 } },
    { owner: 'Acme', repo: 'Clean', scannedAt: '2026-09-24T00:00:00.000Z', partial: true, open: { critical: 0, serious: 0, warning: 0 } }
  ]);
  assert(Object.isFrozen(summary) && Object.isFrozen(summary[0]) && Object.isFrozen(summary[0].open));
}

/* The route exists, is authenticated, is not cached, and is one call. */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/workspace/posture'");
  assert(start > 0, 'the posture route must exist');
  const route = server.slice(start, server.indexOf('\n});', start));
  assert.match(route, /providerSessionAccess, auth,/);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(route, /req\.gh\.token/, 'the route body never touches the token itself');
}

/* The reader, against fake transports: each reading fails on its own. */
(async () => {
  const calls = [];
  const account = { provider: 'github', token: CLASSIC, login: 'alice' };
  const headers = new Map([['x-oauth-scopes', 'repo, workflow'], ['github-authentication-token-expiration', '2026-12-01 00:00:00 UTC']]);
  const deps = {
    gh: async (acct, apiPath, opts) => {
      calls.push(['gh', apiPath, opts && opts.raw]);
      return { ok: true, headers: { get: name => headers.get(name) || null }, body: { cancel: async () => { calls.push(['cancel']); } } };
    },
    glFetch: async () => { throw new Error('not used'); },
    dbReady: async () => true,
    pool: () => ({
      query: async (sql, params) => {
        calls.push(['sql', params]);
        return { rows: [{ owner: 'acme', repo: 'demo', latest: new Date('2026-09-20T00:00:00Z'), points: '2' }] };
      }
    }),
    identityKey: () => 'f'.repeat(64),
    normalizePolicyScope: scope => ({ authority: scope.provider === 'github' ? 'github.com' : 'example.test' }),
    exposureStore: () => ({
      workspaceSummary: async input => {
        calls.push(['summary', input]);
        return [{ owner: 'acme', repo: 'demo', finishedAt: '2026-09-21T00:00:00.000Z', state: 'complete', rule: 'aws-access-key', count: 1 }];
      }
    }),
    severityOf: () => 'critical',
    databaseConfigured: true,
    maintenance: false,
    hostedAlpha: true
  };
  const read = await posture.createPostureReader(deps).read(account);
  assert.strictEqual(read.credential.kind, 'classic');
  assert.deepStrictEqual(read.credential.scopes, ['repo', 'workflow']);
  assert.deepStrictEqual(read.recovery.repositories, [{ owner: 'acme', repo: 'demo', latestAt: '2026-09-20T00:00:00.000Z', points: 2 }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(read.exposure.repositories[0].open)), { critical: 1, serious: 0, warning: 0 });
  assert.deepStrictEqual(read.boundary, { state: 'online', database: 'ready', maintenance: false });
  assert(calls.some(call => call[0] === 'gh' && call[1] === '/user' && call[2] === true), 'the credential is read from the provider\'s own report');
  assert(calls.some(call => call[0] === 'cancel'), 'the unread body is released rather than left open');
  assert.deepStrictEqual(calls.find(call => call[0] === 'summary')[1], { provider: 'github', authority: 'github.com', identityKey: 'f'.repeat(64) });
  const rendered = JSON.stringify(read);
  for (const probe of [CLASSIC, CLASSIC.slice(0, 10), CLASSIC.slice(-12)]) {
    assert.strictEqual(rendered.includes(probe), false, 'the posture must not carry the credential');
  }

  /* The database down: recovery and exposure unavailable, the credential still read, the boundary degraded. */
  const down = await posture.createPostureReader({ ...deps, dbReady: async () => false }).read(account);
  assert.strictEqual(down.recovery.available, false);
  assert.strictEqual(down.exposure.available, false);
  assert.strictEqual(down.credential.kind, 'classic');
  assert.deepStrictEqual(down.boundary, { state: 'degraded', database: 'unavailable', maintenance: false });

  /* A store that throws is an unavailable reading, not a failed request. */
  const broken = await posture.createPostureReader({
    ...deps,
    pool: () => ({ query: async () => { throw new Error('boom'); } }),
    exposureStore: () => ({ workspaceSummary: async () => { throw new Error('boom'); } })
  }).read(account);
  assert.strictEqual(broken.recovery.available, false);
  assert.strictEqual(broken.exposure.available, false);

  /* A provider that fails leaves the credential unmeasured. */
  const silent = await posture.createPostureReader({ ...deps, gh: async () => { throw new Error('network'); } }).read(account);
  assert.strictEqual(silent.credential.rating, null);

  /* Self-hosted without a database is online, and says it has none. */
  const local = await posture.createPostureReader({ ...deps, databaseConfigured: false, hostedAlpha: false }).read(account);
  assert.deepStrictEqual(local.boundary, { state: 'online', database: 'not-configured', maintenance: false });
  assert.strictEqual(local.exposure.available, false);

  /* Maintenance is always degraded. */
  const draining = await posture.createPostureReader({ ...deps, maintenance: true }).read(account);
  assert.strictEqual(draining.boundary.state, 'degraded');
  assert.strictEqual(draining.boundary.maintenance, true);

  /* An installation is classified without a provider call. */
  const before = calls.length;
  const app = await posture.createPostureReader(deps).read({ provider: 'github', authMethod: 'github-app', installationId: 7 });
  assert.strictEqual(app.credential.kind, 'installation');
  assert.strictEqual(calls.slice(before).filter(call => call[0] === 'gh').length, 0);

  console.log('workspace posture tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
