'use strict';
/*
 * The composed server, invite-only.
 *
 * The hosted alpha runs the server with invitations on
 * (NV_ALPHA_ACCESS_MODE=invite), which needs the database: a tester redeems
 * an invitation for an access session, signs in to GitHub in it, and the
 * provider session is owned by the tester. Each check builds the application
 * the server listens with, invite-only, on a database of its own that is
 * dropped afterwards (test/helpers/disposable-database.js), readies the
 * store as the server does at boot, and asks it how it behaves.
 */
const assert = require('node:assert/strict');
const { composedApplication, browser, standInForOutbound, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');

const TERMS = '2026-07-29';
const TOKEN = `ghp_${'z'.repeat(36)}`;
const INVITE_ONLY = Object.freeze({
  NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(48), NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn',
  NV_ALPHA_ACCESS_MODE: 'invite', NV_ALPHA_INVITE_PEPPER: 'p'.repeat(64), NV_ALPHA_TERMS_VERSION: TERMS
});

(async () => {
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('alpha');
  /* The webhook live events register on GitHub: what it was given, and whether it is gone. */
  const hook = { config: null, deleted: false };
  const github = standInForOutbound([
    ['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
    ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
    ['POST /repos/acme/demo/hooks$', (href, options) => {
      hook.config = JSON.parse(options.body).config;
      return { status: 201, body: { id: 991, active: true } };
    }],
    ['GET /repos/acme/demo/hooks/991$', () => (hook.deleted
      ? { status: 404, body: { message: 'Not Found' } }
      : { body: { id: 991, active: true, config: { url: hook.config.url } } })],
    ['DELETE /repos/acme/demo/hooks/991$', () => {
      hook.deleted = true;
      return { status: 204, body: {} };
    }]
  ]);
  const application = await composedApplication({ ...INVITE_ONLY, DATABASE_URL: database.url });
  const client = await database.client();
  const ownLog = console.log;
  try {
    assert.equal(await application.core.ready(), true, 'the store is opened and migrated');
    const page = browser(application);
    const invite = await application.core.alphaStore.issueInvite({ testerLabel: 'composition tester', termsVersion: TERMS, repositoryScopes: ['github:github.com/acme/demo'] });
    assert.equal((await page.request('/api/alpha/redeem', { method: 'POST', body: { code: invite.code, acceptedTermsVersion: TERMS } })).status, 200);
    assert.equal((await page.signIn(TOKEN)).status, 200);
    const csrf = await page.csrf();

    /*
     * ---- A tester who disconnects GitHub leaves no webhook behind ----
     * The central disconnect removes the webhooks the account created on its
     * repositories, and only then ends the provider session. It made each
     * removal outside the mutation gateway, which refuses every provider write
     * made outside a mutation: nothing reached GitHub, the webhook stayed
     * there, the cleanup stayed pending, and the tester stayed connected. Each
     * removal now runs inside the gateway, as that repository's
     * webhook.disconnect, put to policy like any other.
     */
    {
      const connected = await page.request('/api/repo/acme/demo/live-events/connect', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf } });
      assert.equal(connected.status, 201, 'live events are connected, which registers a webhook on GitHub');
      const from = github.requests.length;
      const events = [];
      console.log = (...line) => events.push(line.join(' '));
      const disconnected = await page.request('/api/alpha/providers/disconnect-all', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf } });
      console.log = ownLog;
      assert.deepEqual([disconnected.status, (await bodyOf(disconnected)).ok], [200, true], 'disconnecting GitHub completes');
      assert.deepEqual(github.requests.slice(from).map(request => `${request.method} ${request.url}`).filter(line => !/\/permission$/.test(line)), [
        'DELETE https://api.github.com/repos/acme/demo/hooks/991',
        'GET https://api.github.com/repos/acme/demo/hooks/991'
      ], 'the webhook is removed from GitHub, and read back gone');
      assert(events.some(line => /"event":"policy.evaluated"/.test(line) && /"action":"webhook.disconnect"/.test(line) && /"scopeKey":"github:github.com:acme\/demo"/.test(line)),
        'the removal ran inside the mutation gateway, as the repository\'s webhook.disconnect, put to policy');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM nv_webhooks')).rows[0].n, 0, 'the server\'s own record of it goes too');
      const signedOut = await page.request('/api/me');
      assert.deepEqual([signedOut.status, (await bodyOf(signedOut)).code], [401, 'AUTH_REQUIRED'], 'the provider session ends');
      assert.equal((await bodyOf(await page.request('/api/alpha/status'))).authenticated, true, 'and the invitation\'s access session stays');
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
