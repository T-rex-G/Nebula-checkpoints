'use strict';
/*
 * The composed server, invite-only.
 *
 * The hosted alpha runs the server with invitations on
 * (NV_ALPHA_ACCESS_MODE=invite), which needs the database: a tester redeems
 * an invitation for an access session, signs in to GitHub in it, and the
 * provider session is owned by the tester. Each check builds the application
 * the server listens with, invite-only, on a database of its own that is
 * dropped afterwards (test/helpers/disposable-database.js), readies the store
 * as the server does at boot, and asks it how it behaves. Each says which
 * source-text assertion it replaced.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { composedApplication, browser, standInForOutbound, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');
const { hashJson } = require('../apps/api/src/platform/values/stable-hash.ts');
const { alphaActorLabel, alphaRetentionPolicy } = require('../apps/api/src/modules/identity-access/index.ts');
const { version: RELEASE } = require('../package.json');

const TERMS = '2026-07-29';
const SCOPE = 'github:github.com/acme/demo';
const INVITE_ONLY = Object.freeze({
  NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(48), NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn',
  NV_ALPHA_ACCESS_MODE: 'invite', NV_ALPHA_INVITE_PEPPER: 'p'.repeat(64), NV_ALPHA_TERMS_VERSION: TERMS
});
/* A tester's GitHub token says who signs in: octo-1, octo-2, ... A user token the GitHub App is granted says the same. */
const tokenOf = n => `ghp_${String(n).padStart(4, '0')}${'z'.repeat(32)}`;
const userTokenOf = n => `ghu_${String(n).padStart(4, '0')}${'u'.repeat(32)}`;
const loginOf = authorization => `octo-${Number(/gh[pu]_(\d{4})/.exec(String(authorization))[1])}`;
const INSTALLATION_TOKEN = `ghs_${'i'.repeat(36)}`;

(async () => {
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('alpha');
  /* The webhooks live events register on GitHub: what each was given, and whether it is gone. */
  const hooks = new Map();
  /* The installation tokens the App's broker has minted. */
  const minted = [];
  const github = standInForOutbound([
    ['GET /user$', (href, options) => {
      const login = loginOf(new Headers(options.headers || {}).get('authorization'));
      return { body: { login, id: login.length, name: login }, headers: { 'x-oauth-scopes': 'repo' } };
    }],
    ['GET /repos/acme/demo/collaborators/[\\w-]+/permission$', href => {
      const login = /collaborators\/([\w-]+)\//.exec(href)[1];
      return { body: { permission: 'admin', role_name: 'admin', user: { login, id: login.length } } };
    }],
    /* The GitHub App's side of a connection; the installation's own token is refused on the repository. */
    ['POST //github.com/login/oauth/access_token$', (href, options) => ({ body: { access_token: userTokenOf(Number(/granted-(\d+)/.exec(JSON.parse(options.body).code)[1])), expires_in: 28800 } })],
    ['GET /user/installations\\?', { body: { total_count: 1, installations: [{ id: 42, app_id: 123, account: { login: 'install-owner', id: 9, type: 'Organization' } }] } }],
    ['GET /app/installations/42$', {
      body: { id: 42, app_id: 123, account: { login: 'install-owner', id: 9, type: 'Organization' }, repository_selection: 'selected', permissions: { contents: 'write' } }
    }],
    ['POST /app/installations/42/access_tokens$', () => {
      minted.push(Date.now());
      return { status: 201, body: { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600e3).toISOString() } };
    }],
    ['GET /repos/acme/demo$', { status: 401, body: { message: 'Bad credentials' } }],
    ['GET /repos/acme/demo/git/ref/heads/main$', { body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit' } } }],
    ['POST /repos/acme/demo/git/refs$', { status: 201, body: { ref: 'refs/heads/feature', object: { sha: 'a'.repeat(40) } } }],
    ['POST /repos/acme/demo/hooks$', (href, options) => {
      const id = 900 + hooks.size;
      hooks.set(id, { config: JSON.parse(options.body).config, deleted: false });
      return { status: 201, body: { id, active: true } };
    }],
    ['GET /repos/acme/demo/hooks/\\d+$', href => {
      const hook = hooks.get(Number(/hooks\/(\d+)$/.exec(href)[1]));
      return !hook || hook.deleted ? { status: 404, body: { message: 'Not Found' } } : { body: { active: true, config: { url: hook.config.url } } };
    }],
    ['DELETE /repos/acme/demo/hooks/\\d+$', href => {
      const hook = hooks.get(Number(/hooks\/(\d+)$/.exec(href)[1]));
      if (hook) hook.deleted = true;
      return { status: 204, body: {} };
    }]
  ]);
  const application = await composedApplication({ ...INVITE_ONLY, DATABASE_URL: database.url });
  const client = await database.client();
  const ownLog = console.log;
  let testers = 0;
  /* A tester admitted by an invitation, signed in to GitHub as a login of its own. */
  const admitted = async () => {
    testers += 1;
    const page = browser(application);
    const invite = await application.core.alphaStore.issueInvite({ testerLabel: `composition tester ${testers}`, termsVersion: TERMS, repositoryScopes: [SCOPE] });
    assert.equal((await page.request('/api/alpha/redeem', { method: 'POST', body: { code: invite.code, acceptedTermsVersion: TERMS } })).status, 200);
    assert.equal((await page.signIn(tokenOf(testers))).status, 200);
    return { page, csrf: await page.csrf(), testerId: (await client.query('SELECT tester_id FROM nv_alpha_testers WHERE tester_label=$1', [`composition tester ${testers}`])).rows[0].tester_id };
  };
  try {
    /*
     * ---- The alpha's privacy retention runs once the store is ready ----
     * Replaces the privacy CLI test's checks that the composition built the
     * retention with the alpha's configuration and store, and started it when
     * the store became ready.
     */
    {
      const logged = [];
      console.log = (...line) => logged.push(line.join(' '));
      try {
        assert.equal(await application.core.ready(), true, 'the store is opened and migrated');
        for (let wait = 0; wait < 100 && !logged.some(line => line.includes('"alphaRetention"')); wait += 1) await new Promise(resolve => setTimeout(resolve, 20));
      } finally {
        console.log = ownLog;
      }
      const runs = logged.filter(line => line.includes('"alphaRetention"')).map(line => Object.keys(JSON.parse(line).alphaRetention));
      assert.deepEqual(runs, [[
        'alphaSessionsRemoved', 'providerSessionsRemoved', 'eventsRemoved', 'snapshotsRemoved',
        'evidenceExportsRemoved', 'feedbackRemoved', 'testerMetadataPurged', 'inviteMetadataPurged'
      ]], 'once the store is ready, the alpha\'s retention runs over its own store');
    }

    /*
     * ---- An invitation admits a tester, to the repositories it names ----
     * Replaces the privacy server contract's check that the composition
     * registered the alpha's access routes with its sessions, and the
     * disconnect contract's that it built the privacy store and gave the
     * account lifecycle that store. Without an invitation nothing is
     * answered. Redeemed, the tester signs in to GitHub, and the provider
     * session is owned by the tester; a repository the invitation does not
     * name is refused.
     */
    const first = browser(application);
    {
      const refused = await first.request('/api/me');
      assert.deepEqual([refused.status, (await bodyOf(refused)).code], [401, 'ALPHA_ACCESS_REQUIRED'], 'without an invitation, nothing is answered');
      assert.equal((await bodyOf(await first.request('/api/alpha/status'))).authenticated, false);
      const invite = await application.core.alphaStore.issueInvite({ testerLabel: 'first tester', termsVersion: TERMS, repositoryScopes: [SCOPE] });
      const redeemed = await first.request('/api/alpha/redeem', { method: 'POST', body: { code: invite.code, acceptedTermsVersion: TERMS } });
      assert.deepEqual([redeemed.status, (await bodyOf(redeemed)).repositoryScopes], [200, [SCOPE]], 'an invitation is redeemed for the repositories it names');
      const status = await bodyOf(await first.request('/api/alpha/status'));
      assert.deepEqual([status.authenticated, status.testerLabel], [true, 'first tester'], 'and admits the tester');
      assert.equal((await first.signIn(tokenOf(0))).status, 200, 'who signs in to GitHub');
      const owned = await client.query(
        `SELECT (SELECT count(*)::int FROM nv_alpha_provider_bindings) AS bindings, (SELECT count(*)::int FROM nv_alpha_provider_session_ownership) AS sessions`
      );
      assert.deepEqual(owned.rows[0], { bindings: 1, sessions: 1 }, 'and the provider session is the tester\'s own, bound to the identity');
      const csrf = await first.csrf();
      const elsewhere = await first.request('/api/repo/other/thing/branches', { method: 'POST', body: { name: 'x', from: 'main' }, headers: { 'x-nv-csrf': csrf } });
      assert.deepEqual([elsewhere.status, (await bodyOf(elsewhere)).code], [403, 'ALPHA_REPOSITORY_NOT_ALLOWED'], 'a repository the invitation does not name is refused');
      const named = await first.request('/api/repo/acme/demo/branches', { method: 'POST', body: { name: 'feature', from: 'main' }, headers: { 'x-nv-csrf': csrf } });
      assert.equal(named.status, 200, 'and one it names is worked on');
    }

    /*
     * ---- What the alpha keeps names the tester by label, never by login ----
     * Replaces the disconnect contract's checks that the composition gave the
     * repository guards the alpha's flag, that no persistence it composed
     * kept req.gh.login as an actor, and that it handed the upload scan the
     * retained actor. The policy decision the write left is the tester's
     * label's. A file with a malware signature leaves evidence whose hashed
     * payload names the label, as matching the hash shows. And no column of
     * any table holds a GitHub login.
     */
    {
      const testerId = (await client.query("SELECT tester_id FROM nv_alpha_testers WHERE tester_label='first tester'")).rows[0].tester_id;
      const label = alphaActorLabel({ testerId });
      const decisions = (await client.query('SELECT actor_login FROM nv_governance_policy_decisions')).rows.map(row => row.actor_login);
      assert.deepEqual(decisions, [label], 'the write\'s policy decision is recorded under the tester\'s label');

      const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
      const before = Date.now();
      const blocked = await first.request('/api/repo/acme/demo/upload?path=docs%2Fsample.txt&branch=main', { method: 'POST', body: EICAR, headers: { 'x-nv-csrf': await first.csrf() } });
      const after = Date.now();
      assert.equal(blocked.status, 422, 'a file with a malware signature is refused');
      await new Promise(resolve => setTimeout(resolve, 50));
      const [{ payload_hash: hashed }] = (await client.query("SELECT payload_hash FROM nv_evidence_chain WHERE kind='malware-blocked'")).rows;
      const named = actor => {
        for (let at = before; at <= after; at += 1) {
          const payload = {
            actor, path: 'docs/sample.txt', size: EICAR.length,
            matches: [{ engine: 'builtin', rule: 'EICAR_TEST_FILE', severity: 'critical' }], blockedAt: new Date(at).toISOString()
          };
          if (hashJson(payload) === hashed) return true;
        }
        return false;
      };
      assert.deepEqual([named(label), named('octo-0')], [true, false], 'and its evidence names the tester\'s label, not the login');

      const columns = (await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY')`
      )).rows;
      const holding = [];
      for (const { table_name: table, column_name: column } of columns) {
        const { n } = (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text LIKE '%octo-%'`)).rows[0];
        if (n) holding.push(`${table}.${column}`);
      }
      assert.deepEqual(holding, [], 'no column of any table holds a GitHub login');
    }

    /*
     * ---- The privacy routes answer from the alpha's terms, and feedback is kept for this release ----
     * Replaces the privacy server contract's check that the composition
     * registered the privacy routes with the alpha's configuration, its
     * privacy store and the release's version.
     */
    {
      const privacy = await bodyOf(await first.request('/api/alpha/privacy'));
      assert.deepEqual([privacy.termsVersion, privacy.retention], [TERMS, alphaRetentionPolicy()], 'the privacy notice is the alpha\'s terms and retention');
      const sent = await first.request('/api/alpha/feedback', {
        method: 'POST', headers: { 'x-nv-csrf': await first.csrf() },
        body: { feature: 'upload', correlationId: 'nvx-0123456789abcdef', provider: 'github', capabilityStatus: 'Supported', errorCode: 'UPLOAD_FAILED', runtime: 'chrome' }
      });
      assert.equal(sent.status, 201);
      assert.deepEqual((await client.query('SELECT release_version FROM nv_alpha_feedback')).rows, [{ release_version: RELEASE }], 'feedback is kept for this release');
    }

    /*
     * ---- Every route that disconnects a tester runs the central disconnect ----
     * Replaces the privacy server contract's checks that the composition
     * registered the alpha's disconnect routes with the central disconnect
     * and the cookie it clears, and the disconnect contract's that it built
     * that one helper and handed it to the account, alpha and App routes.
     * Signing out, removing the account, disconnecting GitHub and deleting
     * the alpha's data each remove the webhook the tester's live events
     * registered, inside the mutation gateway, end the provider session and
     * clear its cookie. The central disconnect made each removal outside the
     * gateway, which refused it: nothing reached GitHub, the webhook stayed
     * there, the cleanup stayed pending and the tester stayed connected.
     */
    for (const [route, body] of [
      ['/api/logout', {}],
      ['/api/accounts/remove', { idx: 0 }],
      ['/api/alpha/providers/disconnect-all', {}],
      ['/api/alpha/delete', { confirm: 'DELETE ALPHA DATA' }]
    ]) {
      const { page, csrf } = await admitted();
      const connected = await page.request('/api/repo/acme/demo/live-events/connect', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf } });
      assert.equal(connected.status, 201, 'live events are connected, which registers a webhook on GitHub');
      const id = [...hooks.keys()].at(-1);
      const from = github.requests.length;
      const events = [];
      console.log = (...line) => events.push(line.join(' '));
      const disconnected = await page.request(route, { method: 'POST', body, headers: { 'x-nv-csrf': csrf } });
      console.log = ownLog;
      assert.deepEqual([disconnected.status, (await bodyOf(disconnected)).ok], [200, true], `${route} completes`);
      assert.deepEqual(github.requests.slice(from).map(request => `${request.method} ${request.url}`).filter(line => !/\/permission$/.test(line)), [
        `DELETE https://api.github.com/repos/acme/demo/hooks/${id}`,
        `GET https://api.github.com/repos/acme/demo/hooks/${id}`
      ], `${route} removes the webhook from GitHub, and reads it back gone`);
      assert(events.some(line => /"event":"policy.evaluated"/.test(line) && /"action":"webhook.disconnect"/.test(line) && /"scopeKey":"github:github.com:acme\/demo"/.test(line)),
        `${route}'s removal ran inside the mutation gateway, as the repository's webhook.disconnect, put to policy`);
      assert.equal(page.cookieValue('nv_session'), '', `${route} clears the provider session's cookie`);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_webhooks')).rows[0].n, 0, 'and the server\'s record of the webhook goes');
      const signedOut = await page.request('/api/me');
      assert.equal(signedOut.status, 401, `after ${route}, the provider session is over`);
    }

    /*
     * ---- A tester ends the access session ----
     * The access routes' last: the invitation's session ends when the tester
     * ends it.
     */
    {
      const ended = await first.request('/api/alpha/end', { method: 'POST', body: {}, headers: { 'x-nv-csrf': await first.csrf() } });
      assert.equal(ended.status, 200);
      assert.equal((await bodyOf(await first.request('/api/alpha/status'))).authenticated, false, 'the tester ends the access session');
    }

    /*
     * ---- Invite-only, an App connection is the tester's, and holds nothing of the installation's identity ----
     * Replaces the disconnect contract's checks that the composition gave
     * the App records, the App connection view and GitHub's REST client the
     * alpha's flag, and that no App audit it composed keeps a login. A tester
     * connects the App: the connection is shown by its stable key alone, the
     * account by the tester's label, nothing is copied into the legacy
     * installations table, and the audit names the label. A refusal of the
     * installation's token does not drop it from the broker other testers'
     * work shares.
     */
    {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const withApp = await composedApplication({
        ...INVITE_ONLY, DATABASE_URL: database.url, GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'nebula-composition', GITHUB_APP_CLIENT_ID: 'Iv1.composition',
        GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40), GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
        GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1/api/github-app/oauth/callback', GITHUB_APP_WEBHOOK_SECRET: 'w'.repeat(32)
      });
      try {
        testers += 1;
        const page = browser(withApp);
        const invite = await withApp.core.alphaStore.issueInvite({ testerLabel: `composition tester ${testers}`, termsVersion: TERMS, repositoryScopes: [SCOPE] });
        assert.equal((await page.request('/api/alpha/redeem', { method: 'POST', body: { code: invite.code, acceptedTermsVersion: TERMS } })).status, 200);
        assert.equal((await page.signIn(tokenOf(testers))).status, 200);
        const connect = await bodyOf(await page.request('/api/github-app/connect', { method: 'POST', body: {}, headers: { 'x-nv-csrf': await page.csrf() } }));
        const granted = await page.request(`/api/github-app/oauth/callback?code=granted-${testers}&state=${encodeURIComponent(new URL(connect.url).searchParams.get('state'))}`);
        const install = new URL(String(granted.headers.get('location')));
        const setup = await page.request(`/api/github-app/setup?installation_id=42&state=${encodeURIComponent(install.searchParams.get('state'))}`);
        assert.deepEqual([setup.status, setup.headers.get('location')], [302, '/?githubApp=connected'], 'the tester connects the App');

        const { connections } = await bodyOf(await page.request('/api/github-app/status'));
        assert.deepEqual(connections.map(connection => Object.keys(connection).sort()), [['accountType', 'active', 'connectionKey', 'lastVerifiedAt', 'repositorySelection', 'status']],
          'the connection is shown by its stable key, with no installation number and no login');
        assert.match(connections[0].connectionKey, /^[0-9a-f]{64}$/);
        const testerId = (await client.query('SELECT tester_id FROM nv_alpha_testers WHERE tester_label=$1', [`composition tester ${testers}`])).rows[0].tester_id;
        const label = alphaActorLabel({ testerId });
        assert.equal((await bodyOf(await page.request('/api/me'))).login, label, 'and the account by the tester\'s label');
        assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_github_app_installations')).rows[0].n, 0, 'nothing is copied into the legacy installations table');
        const audits = (await client.query('SELECT details FROM nv_github_app_audit')).rows.map(row => row.details);
        assert.deepEqual(audits.map(details => details.actor), [label], 'the connection\'s audit names the tester by label');
        assert.deepEqual(audits.filter(details => /octo-|install-owner/.test(JSON.stringify(details))), [], 'and no login');

        const { sid } = withApp.core.unseal(page.cookieValue('nv_session'));
        const owned = withApp.core.unseal((await client.query('SELECT data FROM nv_sessions WHERE sid=$1', [sid])).rows[0].data);
        const appAccount = owned.accounts.find(account => account.authMethod === 'github-app');
        assert.equal('token' in appAccount, false, 'the owned App account carries no token');
        const resolved = await withApp.core.resolveAccount(appAccount);
        assert.equal(minted.length, 1);
        await assert.rejects(withApp.core.github.gh(resolved, '/repos/acme/demo'), error => error.status === 401);
        await withApp.core.resolveAccount(appAccount);
        assert.equal(minted.length, 1, 'a refused installation token stays in the broker, shared as it is, rather than being dropped for every tester');
      } finally {
        await withApp.close();
      }
    }
  } finally {
    console.log = ownLog;
    await client.end();
    github.restore();
    await application.close();
    await database.drop();
  }
  /* A warning is emitted on the next turn; it has had one by now. */
  await new Promise(resolve => setImmediate(resolve));
  overlapping.stop();
  assert.deepEqual(overlapping.seen, [], 'no database client was handed a query while it was still running one');
  console.log('composition, invite-only: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
