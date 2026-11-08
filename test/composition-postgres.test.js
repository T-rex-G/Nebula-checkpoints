'use strict';
/*
 * The composed server, asked how it behaves with its database.
 *
 * test/composition.test.js asks the server what it does without one. The
 * checks here need the store a deployment names: where a session lives, which
 * sessions an identity holds, the protections it sets, what a webhook
 * delivery leaves behind, and the snapshots, evidence and restores Corona
 * keeps. Each builds the application the server listens with, on a database
 * of its own (test/helpers/disposable-database.js) that is dropped afterwards,
 * and states the source-text assertion it replaced.
 *
 * The server readies its store at boot (main.ts starts governance's delivery,
 * which waits for it); the application here is built without booting, so the
 * first check readies the store itself.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { composedApplication, browser, standInForOutbound, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');
const { freePort } = require('./helpers/free-port');
const { withLifetime } = require('./fixtures/local-session');
const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');
const OFFLINE_CACHE = require('../packages/contracts/src/offline-cache-policy.ts');

const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(48), NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });
/* Two people: the token says who signs in. */
const OCTO = `ghp_o${'z'.repeat(35)}`;
const OTHER = `ghp_t${'z'.repeat(35)}`;
const octoKey = identityKey({ provider: 'github', login: 'octo', baseUrl: '' });
/* The GitHub App's secrets, and the credentials it is given: none may appear in anything the server answers. */
const APP_SECRETS = Object.freeze({ clientSecret: 'c'.repeat(40), webhookSecret: 'w'.repeat(32), userToken: `ghu_${'u'.repeat(36)}` });
const INSTALLATION_TOKEN = `ghs_${'i'.repeat(36)}`;
const MIGRATIONS = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
  .filter(name => name.endsWith('.sql')).map(name => name.replace(/\.sql$/, '')).sort();

/* A session as a server without a database keeps it: the whole of it in the cookie. */
const carriedSession = application => `nv_session=${application.core.seal(withLifetime({
  accounts: [{ provider: 'github', authMethod: 'token', login: 'octo', avatar: '', baseUrl: '', token: OCTO }],
  active: 0, security: { sessionNonce: 'c'.repeat(48) }
}))}`;

(async () => {
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('composition');
  /* The installation tokens the App's broker has minted. */
  const minted = [];
  /* The repository's branches, as GitHub has them: a test deletes one, and a restore recreates it. */
  const branches = new Map([['main', 'a'.repeat(40)], ['feature', 'b'.repeat(40)]]);
  const github = standInForOutbound([
    ['GET /user$', (href, options) => {
      const login = String(new Headers(options.headers || {}).get('authorization')).includes(OTHER) ? 'other' : 'octo';
      return { body: { login, id: login === 'octo' ? 7 : 8, name: login }, headers: { 'x-oauth-scopes': 'repo' } };
    }],
    ['GET /repos/acme/demo/collaborators/(?:octo|other)/permission$', href => {
      const login = /collaborators\/(\w+)\//.exec(href)[1];
      return { body: { permission: 'admin', role_name: 'admin', user: { login, id: login === 'octo' ? 7 : 8 } } };
    }],
    ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo', default_branch: 'main', private: true, visibility: 'private', permissions: { admin: true } } }],
    /* A public repository the person reads but is no collaborator on: GitHub says who may push only to those who can. */
    ['GET /repos/acme/open/collaborators/octo/permission$', { status: 403, body: { message: 'Must have push access to view repository collaborators.' } }],
    ['GET /repos/acme/open$', { body: { full_name: 'acme/open', default_branch: 'main', private: false, visibility: 'public', permissions: { admin: false, push: false, pull: true } } }],
    ['GET /repos/acme/demo/branches\\?', () => ({ body: [...branches].map(([name, sha]) => ({ name, commit: { sha }, protected: false })) })],
    ['GET /repos/acme/demo/tags\\?', { body: [] }],
    ['GET /repos/acme/demo/collaborators\\?', { body: [{ login: 'octo', id: 7, permissions: { admin: true }, role_name: 'admin' }] }],
    ['GET /repos/acme/demo/keys\\?', { body: [{ id: 5, title: 'deploy', key: 'ssh-ed25519 AAAA', read_only: false, verified: true }] }],
    ['GET /repos/acme/demo/hooks\\?', { body: [] }],
    ['POST /repos/acme/demo/hooks$', { status: 201, body: { id: 991, active: true } }],
    /* The GitHub App's side of a connection: the person's grant, the installation they can see, and the App's own view of it. */
    ['POST //github.com/login/oauth/access_token$', { body: { access_token: APP_SECRETS.userToken, expires_in: 28800, token_type: 'bearer' } }],
    ['GET /user/installations\\?', { body: { total_count: 1, installations: [{ id: 42, app_id: 123, account: { login: 'install-owner', id: 9, type: 'Organization' } }] } }],
    ['GET /app/installations/42$', {
      body: { id: 42, app_id: 123, account: { login: 'install-owner', id: 9, type: 'Organization' }, repository_selection: 'selected', permissions: { contents: 'write' } }
    }],
    ['POST /app/installations/42/access_tokens$', () => {
      minted.push(Date.now());
      return { status: 201, body: { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600e3).toISOString() } };
    }],
    ['POST /repos/acme/demo/git/refs$', (href, options) => {
      const { ref, sha } = JSON.parse(options.body);
      branches.set(ref.replace(/^refs\/heads\//, ''), sha);
      return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
    }]
  ]);
  const application = await composedApplication({ ...BASE, DATABASE_URL: database.url, NV_SNAPSHOT_RETENTION_COUNT: '5' });
  const client = await database.client();
  try {
    /*
     * ---- The store the deployment names is opened, and migrated by the runner ----
     * Replaces verify.js's checks that the composition opened its pool on
     * DATABASE_URL with createDatabasePool and ran the numbered migrations.
     */
    {
      assert.equal(await application.core.ready(), true, 'the store DATABASE_URL names is opened');
      const applied = await client.query('SELECT migration_id FROM nv_schema_migrations ORDER BY migration_id').then(result => result.rows.map(row => row.migration_id), () => []);
      assert.deepEqual(applied, MIGRATIONS, 'and every numbered migration is applied to it, once, by the runner');
      const readiness = await fetch(`${application.url}/readyz`);
      assert.deepEqual([readiness.status, await bodyOf(readiness)], [200, { ok: true, database: 'connected', migration: MIGRATIONS.at(-1) }],
        'and readiness says it is connected, at the last migration');
    }

    /*
     * ---- A session is the database's; the cookie is only its key ----
     * Replaces the hardening contract's check that the provider sessions were
     * told a database is configured, not whether it is reachable. Signed in,
     * the cookie carries the session's key alone and the session is stored
     * under the identity that holds it. A cookie that carries a whole session,
     * as a server without a database writes one, is no session here. With the
     * store configured but down, a session is refused rather than written to
     * the cookie, and a carried session is still not read as one.
     */
    {
      const page = browser(application);
      assert.equal((await page.signIn(OCTO)).status, 200);
      const cookie = application.core.unseal(page.cookieValue('nv_session'));
      assert.deepEqual(Object.keys(cookie), ['sid'], 'the cookie carries the session\'s key alone');
      const stored = await client.query('SELECT identity_keys FROM nv_sessions WHERE sid=$1', [cookie.sid]);
      assert.deepEqual(stored.rows.map(row => row.identity_keys), [[octoKey]], 'and the session is stored under the identity that holds it');
      assert.equal((await page.request('/api/me')).status, 200);

      const carried = browser(application);
      carried.cookie = carriedSession(application);
      const refused = await carried.request('/api/me');
      assert.deepEqual([refused.status, (await bodyOf(refused)).code], [401, 'AUTH_REQUIRED'], 'a cookie carrying a whole session is no session');

      const signedOut = await page.request('/api/logout', { method: 'POST', body: {}, headers: { 'x-nv-csrf': await page.csrf() } });
      assert.equal(signedOut.status, 200);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_sessions WHERE sid=$1', [cookie.sid])).rows[0].n, 0, 'signing out deletes the session');

      const down = await composedApplication({ ...BASE, DATABASE_URL: `postgresql://postgres@127.0.0.1:${freePort()}/none?sslmode=disable` }, { listen: false });
      const ownError = console.error;
      console.error = () => {};
      try {
        const written = [];
        const response = { setHeader: (name, value) => written.push([name, value]) };
        const account = { provider: 'github', authMethod: 'token', login: 'octo', avatar: '', baseUrl: '', token: OCTO };
        await assert.rejects(down.core.sessions.setSession({ headers: {} }, response, { accounts: [account], active: 0 }),
          error => error.status === 503, 'with the store configured but down, a session is refused');
        assert.deepEqual(written, [], 'rather than written to the cookie');
        assert.equal(await down.core.sessions.sessionOf({ headers: { cookie: carriedSession(down) } }), null, 'and a carried session is still not one');
      } finally {
        console.error = ownError;
        await down.close();
      }
    }

    /*
     * ---- An identity's sessions are listed, and the others can be ended ----
     * Replaces the hardening contract's check that the composition handed the
     * session inventory its database query by identity. Two sessions of one
     * identity are listed to each other, and a third person's is not. Ending
     * the others, with a step-up grant, signs the second out and leaves the
     * first, and the other person, signed in.
     */
    {
      const first = browser(application);
      const second = browser(application);
      const stranger = browser(application);
      for (const [page, token] of [[first, OCTO], [second, OCTO], [stranger, OTHER]]) assert.equal((await page.signIn(token)).status, 200);
      const listed = await bodyOf(await first.request('/api/security/sessions'));
      const sessions = listed.sessions || [];
      assert.deepEqual([listed.available, listed.login, sessions.length, sessions.filter(session => session.current).length], [true, 'octo', 2, 1],
        'an identity\'s two sessions are listed, this one marked, and another person\'s is not');

      const csrf = await first.csrf();
      const stepUp = await bodyOf(await first.request('/api/security/step-up', {
        method: 'POST', body: { action: 'sessions.revoke-others', scope: {}, confirm: 'octo', credential: OCTO }, headers: { 'x-nv-csrf': csrf }
      }));
      const revoked = await first.request('/api/security/revoke-others', { method: 'POST', body: { confirm: true }, headers: { 'x-nv-csrf': csrf, 'x-nv-step-up': stepUp.grant } });
      const answer = await bodyOf(revoked);
      assert.deepEqual([revoked.status, answer.available, answer.revoked], [200, true, 1], 'ending the others ends the second session');
      assert.deepEqual([(await second.request('/api/me')).status, (await first.request('/api/me')).status, (await stranger.request('/api/me')).status], [401, 200, 200],
        'which is signed out, while this one and the other person stay signed in');
    }

    /*
     * ---- Protections belong to the identity, in every session ----
     * Replaces verify.js's check that the guards loaded the identity's
     * persisted safety state. A folder protected from one session is
     * protected in another session of the same identity, which is refused a
     * write beneath it.
     */
    const page = browser(application);
    assert.equal((await page.signIn(OCTO)).status, 200);
    const csrf = await page.csrf();
    {
      const protectedNow = await page.request('/api/safety', { method: 'POST', body: { protect: { repo: 'acme/demo', path: 'docs/' } }, headers: { 'x-nv-csrf': csrf } });
      assert.deepEqual([protectedNow.status, (await bodyOf(protectedNow)).protected], [200, { 'acme/demo': ['docs/'] }]);
      const elsewhere = browser(application);
      assert.equal((await elsewhere.signIn(OCTO)).status, 200);
      assert.deepEqual((await bodyOf(await elsewhere.request('/api/safety'))).protected, { 'acme/demo': ['docs/'] },
        'another session of the identity holds the protection');
      const write = await elsewhere.request('/api/repo/acme/demo/file', {
        method: 'PUT', body: { path: 'docs/guide.md', content: 'eA==', message: 'edit', branch: 'main' }, headers: { 'x-nv-csrf': await elsewhere.csrf() }
      });
      assert.deepEqual([write.status, (await bodyOf(write)).locked], [423, true], 'and is refused a write beneath it');
    }

    /*
     * ---- A delivery is stored, chained into the identity's evidence, scored against its protections, and streamed ----
     * Replaces the hardening contract's checks that the composition built
     * Corona's evidence chain and handed the webhook intake its evidence key,
     * the chain's append and the live hub, and verify.js's that it registered
     * the live-event routes. Live events are connected through their own
     * route, which gives GitHub the delivery address and its secret; a
     * delivery signed with that secret is accepted, stored, appended to the
     * identity's evidence for the repository, scored against the folder it
     * protects, and sent to the identity's open stream.
     */
    {
      const connected = await page.request('/api/repo/acme/demo/live-events/connect', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf } });
      assert.deepEqual([connected.status, await bodyOf(connected)], [201, { available: true, connected: true }], 'live events are connected through their route');
      const registration = github.requests.find(request => request.method === 'POST' && request.url === 'https://api.github.com/repos/acme/demo/hooks');
      const { url, secret } = JSON.parse(registration.body).config;
      assert.match(url, new RegExp(`^${application.url}/hooks/github/[0-9a-f]{32,64}$`), 'GitHub is given this server\'s delivery address');

      const stopped = new AbortController();
      const stream = await fetch(`${application.url}/api/repo/acme/demo/live-events/stream`, { headers: { 'x-nv': '1', origin: application.url, cookie: page.cookie }, signal: stopped.signal });
      assert.match(String(stream.headers.get('content-type')), /^text\/event-stream/);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      const next = () => Promise.race([
        reader.read().then(chunk => decoder.decode(chunk.value)),
        new Promise(resolve => { setTimeout(() => resolve('(nothing within five seconds)'), 5000).unref(); })
      ]);
      assert.match(await next(), /^event: ready\n/, 'the stream opens');

      const payload = JSON.stringify({
        ref: 'refs/heads/main', before: 'c'.repeat(40), after: 'd'.repeat(40), forced: false,
        repository: { name: 'demo', owner: { login: 'acme' }, default_branch: 'main' }, pusher: { name: 'octo' }, sender: { login: 'octo' },
        commits: [{ id: 'd'.repeat(40), added: [], modified: ['docs/guide.md'], removed: [] }]
      });
      const delivery = await fetch(url, {
        method: 'POST', body: payload,
        headers: {
          'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'delivery-1',
          'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`
        }
      });
      assert.deepEqual([delivery.status, await bodyOf(delivery)], [202, { ok: true, accepted: true, event: 'push' }], 'a delivery signed with that secret is accepted');
      const event = (await client.query('SELECT event_id, reasons FROM nv_intelligence_events WHERE owner=$1 AND repo=$2 AND identity_key=$3', ['acme', 'demo', octoKey])).rows;
      assert.equal(event.length, 1, 'stored for the identity that connected it');
      assert.deepEqual(event[0].reasons.filter(reason => reason.code === 'PROTECTED_PATH_CHANGED').length, 1, 'and scored against the folder the identity protects');
      const chained = (await client.query('SELECT kind, record_id FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq', [`github:acme/demo:${octoKey}`])).rows;
      assert.deepEqual(chained.map(row => row.kind), ['live-events-connected', 'webhook'], 'the connection and the delivery are chained into the identity\'s evidence');
      assert.equal(chained[1].record_id, event[0].event_id, 'the delivery\'s record is the stored event');
      const streamed = await next();
      assert.match(streamed, new RegExp(`^id: ${event[0].event_id}\nevent: intelligence\n`), 'and the delivery is sent to the identity\'s open stream');
      stopped.abort();

      /*
       * The stored events, a page at a time: every event once, in the order the
       * page sorts them, each page starting after the last one's final event --
       * though events are stored to the microsecond, several share one, and a
       * cursor names its event to the millisecond.
       */
      const stamps = ['2026-10-01T09:00:00.123456Z', '2026-10-01T09:00:00.123456Z', '2026-10-01T09:00:00.123900Z', '2026-10-01T09:00:00.124001Z', '2026-10-01T09:00:01.000000Z'];
      for (const [index, stamp] of stamps.entries()) {
        await client.query(
          `INSERT INTO nv_intelligence_events(event_id, provider, owner, repo, identity_key, event_type, created_at) VALUES($1, 'github', 'acme', 'demo', $2, 'push', $3)`,
          [`paged-${'edcba'[index]}`, octoKey, stamp]
        );
      }
      const all = (await client.query(
        `SELECT event_id FROM nv_intelligence_events WHERE owner='acme' AND repo='demo' AND identity_key=$1 ORDER BY date_trunc('milliseconds', created_at), event_id`, [octoKey]
      )).rows.map(row => row.event_id);
      assert.equal(all.length, 6);
      for (const limit of [1, 2, 4]) {
        const seen = [];
        let after = encodeURIComponent('2026-01-01T00:00:00.000Z');
        for (let pages = 0; pages < 10; pages += 1) {
          const listed = await bodyOf(await page.request(`/api/repo/acme/demo/intelligence/events?limit=${limit}&after=${after}`));
          seen.push(...listed.events.map(item => item.id));
          if (!listed.hasMore) break;
          assert.notEqual(listed.cursor, after, 'a page with more after it moves its cursor on');
          after = listed.cursor;
        }
        assert.deepEqual(seen, all, `pages of ${limit}: every event once, in order`);
      }
      const newest = await bodyOf(await page.request('/api/repo/acme/demo/intelligence/events?limit=2'));
      assert.deepEqual(newest.events.map(item => item.id), all.slice(-2), 'without a cursor, the newest page, oldest first');
      const caughtUp = await bodyOf(await page.request(`/api/repo/acme/demo/intelligence/events?limit=2&after=${newest.cursor}`));
      assert.deepEqual([caughtUp.events, caughtUp.hasMore], [[], false], 'and its cursor is caught up');
      await client.query("DELETE FROM nv_intelligence_events WHERE event_id LIKE 'paged-%'");
    }

    /*
     * ---- Signed snapshots are kept to the deployment's count, and exported with the evidence ----
     * Replaces the hardening contract's check that the composition gave the
     * recovery routes the snapshot retention count, and verify.js's that it
     * registered the evidence and snapshot routes. Six snapshots signed with
     * NV_SNAPSHOT_RETENTION_COUNT at five keep the latest five. The evidence
     * export verifies the identity's chain and holds the delivery and the
     * snapshots.
     */
    {
      const taken = [];
      for (let snapshot = 0; snapshot < 6; snapshot += 1) {
        const signed = await page.request('/api/repo/acme/demo/signed-snapshot', { method: 'POST', body: { manifest: false }, headers: { 'x-nv-csrf': csrf } });
        assert.equal(signed.status, 201, 'a signed snapshot is taken');
        taken.push((await bodyOf(signed)).snapshotId);
      }
      const kept = await bodyOf(await page.request('/api/repo/acme/demo/signed-snapshots'));
      assert.deepEqual(new Set((kept.snapshots || []).map(snapshot => snapshot.snapshotId)), new Set(taken.slice(1)), 'the latest five of six are kept');

      const exported = await bodyOf(await page.request('/api/repo/acme/demo/evidence'));
      assert.deepEqual([exported.chain?.valid, exported.chain?.complete], [true, true], 'the export verifies the identity\'s chain for the repository');
      assert.deepEqual((exported.records || []).map(record => record.kind), ['live-events-connected', 'webhook', ...Array(6).fill('recovery-snapshot')],
        'which records the connection, the delivery and all six snapshots: evidence is kept when a snapshot is not');
      assert.deepEqual([exported.events?.length, exported.snapshots?.length], [1, 5], 'and holds the delivery and the kept snapshots');
    }

    /*
     * ---- A restore is previewed against what changed, and its grant is spent once ----
     * Replaces the mutation-coverage contract's check that the composition
     * handed the mutation context Corona's inspection of a restore grant, and
     * verify.js's that it registered the snapshot comparison and restore
     * preview. A snapshot is compared with what GitHub now holds: a branch
     * deleted since. While the repository has a protected folder, the preview
     * grants nothing and a restore is refused. Unprotected, the preview grants
     * the branch's recreation; the restore recreates it, once, and the same
     * grant is refused the second time.
     */
    {
      const before = await bodyOf(await page.request('/api/repo/acme/demo/refs-snapshot'));
      branches.delete('feature');
      const compared = await bodyOf(await page.request('/api/repo/acme/demo/snapshot-compare', { method: 'POST', body: { snapshot: before }, headers: { 'x-nv-csrf': csrf } }));
      assert.deepEqual((compared.comparison?.refs.recreate || []).map(ref => [ref.name, ref.expected]), [['feature', 'b'.repeat(40)]], 'the comparison finds the branch deleted since');
      const preview = () => page.request('/api/repo/acme/demo/restore-preview', { method: 'POST', body: { snapshot: before }, headers: { 'x-nv-csrf': csrf } }).then(bodyOf);
      const restore = authorization => page.request('/api/repo/acme/demo/restore-refs', { method: 'POST', body: { authorization, confirm: 'RESTORE' }, headers: { 'x-nv-csrf': csrf } });

      const guarded = await preview();
      assert.deepEqual([guarded.canRestore, guarded.authorization], [false, ''], 'while a folder is protected, the preview grants nothing');
      const locked = await restore('');
      assert.deepEqual([locked.status, (await bodyOf(locked)).locked], [423, true], 'and a restore is refused');
      const unlocked = await page.request('/api/safety', { method: 'POST', body: { protect: { repo: 'acme/demo', path: 'docs/', on: false } }, headers: { 'x-nv-csrf': csrf } });
      assert.deepEqual((await bodyOf(unlocked)).protected, {});

      const granted = await preview();
      assert.deepEqual([granted.canRestore, (granted.actions || []).map(action => [action.name, action.action])], [true, [['feature', 'recreate']]],
        'unprotected, the preview grants the branch\'s recreation');
      const restored = await restore(granted.authorization);
      const report = await bodyOf(restored);
      assert.deepEqual([restored.status, report.ok, report.previewBound, (report.report || []).map(entry => [entry.name, entry.action])],
        [200, true, true, [['feature', 'recreated']]], 'the restore is bound to the preview, and recreates the branch it named');
      assert.equal(branches.get('feature'), 'b'.repeat(40), 'where the snapshot had it');
      const again = await restore(granted.authorization);
      assert.deepEqual([again.status, (await bodyOf(again)).code], [409, 'RESTORE_AUTHORIZATION_REPLAY'], 'and the same grant is refused the second time');
    }

    /*
     * ---- Who can reach the repository is answered, and weighed ----
     * Replaces verify.js's check that the composition registered the access
     * surface. The repository's collaborators, deploy keys and webhooks are
     * read for the signed-in identity, and a deploy key that can write is
     * named as a risk.
     */
    {
      const surface = await bodyOf(await page.request('/api/repo/acme/demo/access-surface'));
      assert.deepEqual([surface.available, surface.currentIdentity, surface.currentPermission, (surface.collaborators || []).map(person => person.login)],
        [true, 'octo', 'admin', ['octo']], 'the repository\'s access surface is read for the signed-in identity');
      assert.deepEqual((surface.risk?.reasons || []).map(reason => reason.code), ['WRITABLE_DEPLOY_KEY'], 'and a deploy key that can write is named as a risk');
    }

    /*
     * ---- A governance webhook to a name that does not resolve is refused as such ----
     * A webhook's destination is looked up before the webhook is kept. A
     * lookup that failed -- a typo, a name since removed -- was answered as
     * the service failing, 500; it is refused as the destination's, 422, as
     * a lookup that finds nothing already was.
     */
    {
      const page = browser(application);
      assert.equal((await page.signIn(OCTO)).status, 200);
      const refused = await page.request('/api/repo/acme/demo/governance/webhooks', {
        method: 'POST', body: { name: 'Receiver', url: 'https://receiver.invalid/events', eventTypes: ['policy.decision.allow'], enabled: true },
        headers: { 'x-nv-csrf': await page.csrf(), 'Idempotency-Key': 'composition-webhook-unresolved' }
      });
      assert.deepEqual([refused.status, (await bodyOf(refused)).code], [422, 'GOVERNANCE_WEBHOOK_DNS_INVALID'],
        'a webhook to a name that does not resolve is refused as the destination\'s');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_governance_webhooks')).rows[0].n, 0, 'and nothing is kept');
    }

    /*
     * ---- An answer is bound to the offline cache only for the account and repository asked for ----
     * Replaces the offline cache contract's check that the composition keeps
     * the API's no-store step with the session's own binding. Every API answer
     * is no-store, unless the service worker asks to keep it under the
     * account's offline scope, for this repository, and is answered: then the
     * answer names the same scope and repository, and the worker may keep it.
     * Asked under another scope, it is not bound.
     */
    {
      const page = browser(application);
      assert.equal((await page.signIn(OCTO)).status, 200);
      const { offlineCacheScope } = await bodyOf(await page.request('/api/me'));
      assert(OFFLINE_CACHE.validScope(offlineCacheScope), 'the account is told its offline scope');
      const asked = async scope => {
        const headers = scope ? { [OFFLINE_CACHE.OFFLINE_SCOPE_HEADER]: scope, [OFFLINE_CACHE.OFFLINE_REPO_HEADER]: 'github:acme/demo' } : {};
        const answered = await page.request('/api/repo/acme/demo', { headers });
        await answered.arrayBuffer();
        const decision = OFFLINE_CACHE.classifyApiRequest(new URL(`${application.url}/api/repo/acme/demo`), 'GET', new Headers(headers));
        return [answered.status, answered.headers.get('cache-control'), OFFLINE_CACHE.responseMatchesBinding(answered.headers, decision)];
      };
      assert.deepEqual(await asked(null), [200, 'no-store', false], 'unasked, an answer is no-store');
      const [status, cacheControl, bound] = await asked(offlineCacheScope);
      assert.deepEqual([status, cacheControl === 'no-store', bound], [200, false, true], 'asked under the account\'s scope, it is bound for the worker to keep');
      assert.deepEqual(await asked('x'.repeat(32)), [200, 'no-store', false], 'asked under another scope, it is not');
    }

    /*
     * ---- A step-up grant is spent once, on whichever instance it is spent ----
     * Replaces the security foundation test's check that the composition says
     * whether a database is configured, not whether it can be reached, and so
     * hands session security the shared single-use store. Two servers share the
     * database, as a deployment's instances do. A grant is spent on the first,
     * and held, with the session's row locked, after it has claimed the grant
     * and before it has written the session: the second still reads the grant
     * as pending, and only the shared store can know it is spent. Asked to
     * spend it then, the second refuses at once, as a replay; let go, the
     * first completes.
     */
    {
      const second = await composedApplication({ ...BASE, DATABASE_URL: database.url, NV_SNAPSHOT_RETENTION_COUNT: '5' });
      const hold = await database.client();
      let holding = false;
      try {
        assert.equal(await second.core.ready(), true);
        const page = browser(application);
        assert.equal((await page.signIn(OCTO)).status, 200);
        const csrf = await page.csrf();
        const elsewhere = browser(second);
        elsewhere.cookie = page.cookie;
        const sensitive = (on, grant) => on.request('/api/security/revoke-others', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf, 'x-nv-step-up': grant } });
        const stepUp = await page.request('/api/security/step-up', {
          method: 'POST', body: { action: 'sessions.revoke-others', scope: {}, confirm: 'octo', credential: OCTO }, headers: { 'x-nv-csrf': csrf }
        });
        const { grant } = await bodyOf(stepUp);
        assert.equal(stepUp.status, 200, 'the account proves its credential again, and is granted a step up');
        const { sid } = application.core.unseal(page.cookieValue('nv_session'));
        await hold.query('BEGIN');
        await hold.query('SELECT 1 FROM nv_sessions WHERE sid=$1 FOR UPDATE', [sid]);
        holding = true;
        const first = sensitive(page, grant);
        for (const deadline = Date.now() + 10_000; ;) {
          /* The spend's own session write, not any query: the store's retention sweep may be held as well. */
          const waiting = (await client.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ~ '^\\s*UPDATE nv_sessions'"
          )).rows[0].n;
          if (waiting > 0) break;
          assert(Date.now() < deadline, 'the first spend should reach its session write and wait there');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        const replayed = await Promise.race([
          sensitive(elsewhere, grant).then(async answer => [answer.status, (await bodyOf(answer)).code]),
          new Promise(resolve => setTimeout(() => resolve('let through, and held at its own session write'), 3000))
        ]);
        assert.deepEqual(replayed, [403, 'STEP_UP_REPLAY'], 'the second instance refuses the grant at once, as spent by the first');
        await hold.query('ROLLBACK');
        holding = false;
        const spent = await first;
        assert.deepEqual([spent.status, await bodyOf(spent)], [400, { error: 'Confirmation required' }], 'and the first lets the action through to its own checks');
      } finally {
        if (holding) await hold.query('ROLLBACK').catch(() => {});
        await hold.end();
        await second.close();
      }
    }

    /*
     * ---- A public reader is let into their own work, and nowhere else ----
     * Replaces the authorization resolver contract's checks that the
     * composition handed Kepler's own-work allowance to each module whose
     * routes take it, and used it nowhere else, and that it took no governance
     * roles or repository access from a request's body. Reading a public
     * repository makes nobody a collaborator on it: the person's own scans and
     * audits of it are theirs to see, while its governance is its
     * collaborators'. A body that claims roles and access changes neither.
     */
    {
      const page = browser(application);
      assert.equal((await page.signIn(OCTO)).status, 200);
      for (const [work, route] of [['exposure scans', '/api/repo/acme/open/exposure/scans'], ['audit history', '/api/repo/acme/open/code-audit/history?ref=main']]) {
        const own = await page.request(route);
        assert.equal(own.status, 200, `a public reader sees their own ${work} of a public repository: ${JSON.stringify(await bodyOf(own))}`);
      }
      const shared = await page.request('/api/repo/acme/open/governance/policies');
      assert.deepEqual([shared.status, (await bodyOf(shared)).code], [403, 'GOVERNANCE_COLLABORATORS_ONLY'], 'and not its governance, which is its collaborators\'');
      const claimed = await page.request('/api/repo/acme/open/governance/webhooks', {
        method: 'POST',
        body: {
          name: 'Claimed', url: 'https://receiver.invalid/events', eventTypes: ['policy.decision.allow'], enabled: true,
          governanceRoles: ['administrator'], repositoryAccess: { baseRole: 'admin', source: 'github.collaborator.permission' }, actorIdentityKey: 'a'.repeat(64)
        },
        headers: { 'x-nv-csrf': await page.csrf(), 'Idempotency-Key': 'composition-claimed-roles' }
      });
      assert.deepEqual([claimed.status, (await bodyOf(claimed)).code], [403, 'GOVERNANCE_ROLE_REQUIRED'],
        'roles and access a request\'s body claims are not taken: the person is the reader GitHub says, not the administrator the body says');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_governance_webhooks')).rows[0].n, 0, 'and nothing is kept');
    }

    /*
     * ---- Connecting the GitHub App completes, and is recorded ----
     * On a database without invitations, connecting the App added the
     * account to the stored session, but the request kept the session as it
     * had read it. The setup could not find the account it had just added,
     * so it answered with an error, and neither the installation's record
     * nor its audit was written. The request now carries the session as
     * stored.
     *
     * ---- An App account holds no credential; its token is the broker's, and goes when it does ----
     * Replaces the GitHub App contract's checks that the composition kept
     * App session accounts tokenless, built the App records, handed the
     * account lifecycle the broker, and never answered with an App secret,
     * and the disconnect contract's that no App audit it composed keeps the
     * installation account's login as such. The stored session's App account carries no
     * token: the broker mints one when the account is used, and disconnecting
     * the account drops it, so the next use mints again. Nothing the server
     * answered along the way holds a secret or a credential.
     */
    {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
      const { clientSecret, webhookSecret } = APP_SECRETS;
      const withApp = await composedApplication({
        ...BASE, DATABASE_URL: database.url, GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'nebula-composition', GITHUB_APP_CLIENT_ID: 'Iv1.composition',
        GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: pem,
        GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1/api/github-app/oauth/callback', GITHUB_APP_WEBHOOK_SECRET: webhookSecret
      });
      /* Everything the server answers in the App's flow, headers and all. */
      const answered = [];
      const kept = async pending => {
        const response = await pending;
        answered.push(`${JSON.stringify([...response.headers])}\n${await response.clone().text()}`);
        return response;
      };
      try {
        const person = browser(withApp);
        assert.equal((await kept(person.signIn(OCTO))).status, 200);
        const connect = await bodyOf(await kept(person.request('/api/github-app/connect', { method: 'POST', body: {}, headers: { 'x-nv-csrf': await person.csrf() } })));
        const granted = await kept(person.request(`/api/github-app/oauth/callback?code=granted&state=${encodeURIComponent(new URL(connect.url).searchParams.get('state'))}`));
        assert.equal(granted.status, 302, 'the person\'s grant is exchanged, and the installation asked for');
        const install = new URL(String(granted.headers.get('location')));
        const setup = await kept(person.request(`/api/github-app/setup?installation_id=42&state=${encodeURIComponent(install.searchParams.get('state'))}`));
        assert.deepEqual([setup.status, setup.headers.get('location')], [302, '/?githubApp=connected'], 'the setup completes');
        assert.deepEqual((await client.query('SELECT installation_id, account_login, status FROM nv_github_app_installations')).rows,
          [{ installation_id: '42', account_login: 'install-owner', status: 'connected' }], 'the installation is recorded');
        assert.deepEqual((await client.query("SELECT event_type, installation_id FROM nv_github_app_audit WHERE event_type <> 'authorization.refreshed'")).rows,
          [{ event_type: 'installation.connected', installation_id: '42' }], 'and its connection audited');

        const { sid } = withApp.core.unseal(person.cookieValue('nv_session'));
        const stored = withApp.core.unseal((await client.query('SELECT data FROM nv_sessions WHERE sid=$1', [sid])).rows[0].data);
        const appAccount = stored.accounts.find(account => account.authMethod === 'github-app');
        assert.deepEqual([appAccount.installationId, 'token' in appAccount], [42, false], 'the stored App account carries no token');
        const status = await bodyOf(await kept(person.request('/api/github-app/status')));
        assert.deepEqual(status.connections.map(connection => [connection.installationId, connection.accountLogin, connection.status]), [[42, 'install-owner', 'connected']],
          'outside the alpha, the connection is shown with its installation');

        await withApp.core.resolveAccount(appAccount);
        await withApp.core.resolveAccount(appAccount);
        assert.equal(minted.length, 1, 'the broker mints the account\'s token once, and keeps it');
        const disconnected = await kept(person.request('/api/github-app/disconnect', { method: 'POST', body: { installationId: 42 }, headers: { 'x-nv-csrf': await person.csrf() } }));
        assert.deepEqual([disconnected.status, (await bodyOf(disconnected)).installationId], [200, 42]);
        await withApp.core.resolveAccount(appAccount);
        assert.equal(minted.length, 2, 'disconnecting the account drops its token from the broker, so its next use mints again');

        const audits = (await client.query('SELECT event_type, details FROM nv_github_app_audit ORDER BY created_at')).rows;
        assert.deepEqual(audits.filter(audit => 'accountLogin' in audit.details).map(audit => audit.event_type), [],
          'no App audit keeps the installation account\'s login; outside the alpha its actor is the acting account\'s');
        const secrets = { ...APP_SECRETS, installationToken: INSTALLATION_TOKEN, privateKey: pem.split('\n')[1] };
        assert.deepEqual(Object.keys(secrets).filter(name => answered.some(answer => answer.includes(secrets[name]))), [],
          'nothing the server answered holds an App secret or credential');
      } finally {
        await withApp.close();
      }
    }
  } finally {
    await client.end();
    github.restore();
    await application.close();
    await database.drop();
  }
  await new Promise(resolve => setImmediate(resolve));
  overlapping.stop();
  assert.deepEqual(overlapping.seen, [], 'no database client was handed a query while it was still running one');
  console.log('composition with a database: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
