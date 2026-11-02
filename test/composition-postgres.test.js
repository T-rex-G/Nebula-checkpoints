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
const { disposableDatabase } = require('./helpers/disposable-database');
const { freePort } = require('./helpers/free-port');
const { withLifetime } = require('./fixtures/local-session');
const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');

const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(48), NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });
/* Two people: the token says who signs in. */
const OCTO = `ghp_o${'z'.repeat(35)}`;
const OTHER = `ghp_t${'z'.repeat(35)}`;
const octoKey = identityKey({ provider: 'github', login: 'octo', baseUrl: '' });
const MIGRATIONS = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
  .filter(name => name.endsWith('.sql')).map(name => name.replace(/\.sql$/, '')).sort();

/* A session as a server without a database keeps it: the whole of it in the cookie. */
const carriedSession = application => `nv_session=${application.core.seal(withLifetime({
  accounts: [{ provider: 'github', authMethod: 'token', login: 'octo', avatar: '', baseUrl: '', token: OCTO }],
  active: 0, security: { sessionNonce: 'c'.repeat(48) }
}))}`;

(async () => {
  const database = await disposableDatabase('composition');
  /* The repository's branches, as GitHub has them: a test deletes one, and a restore recreates it. */
  const branches = new Map([['main', 'a'.repeat(40)], ['feature', 'b'.repeat(40)]]);
  const github = standInForOutbound([
    ['GET /user$', (href, options) => {
      const login = String(new Headers(options.headers || {}).get('authorization')).includes(OCTO) ? 'octo' : 'other';
      return { body: { login, id: login === 'octo' ? 7 : 8, name: login }, headers: { 'x-oauth-scopes': 'repo' } };
    }],
    ['GET /repos/acme/demo/collaborators/(?:octo|other)/permission$', href => {
      const login = /collaborators\/(\w+)\//.exec(href)[1];
      return { body: { permission: 'admin', role_name: 'admin', user: { login, id: login === 'octo' ? 7 : 8 } } };
    }],
    ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo', default_branch: 'main', private: true, visibility: 'private', permissions: { admin: true } } }],
    ['GET /repos/acme/demo/branches\\?', () => ({ body: [...branches].map(([name, sha]) => ({ name, commit: { sha }, protected: false })) })],
    ['GET /repos/acme/demo/tags\\?', { body: [] }],
    ['GET /repos/acme/demo/collaborators\\?', { body: [{ login: 'octo', id: 7, permissions: { admin: true }, role_name: 'admin' }] }],
    ['GET /repos/acme/demo/keys\\?', { body: [{ id: 5, title: 'deploy', key: 'ssh-ed25519 AAAA', read_only: false, verified: true }] }],
    ['GET /repos/acme/demo/hooks\\?', { body: [] }],
    ['POST /repos/acme/demo/hooks$', { status: 201, body: { id: 991, active: true } }],
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
      const cookie = application.core.unseal(page.cookie.slice('nv_session='.length));
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
  } finally {
    await client.end();
    github.restore();
    await application.close();
    await database.drop();
  }
  console.log('composition with a database: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
