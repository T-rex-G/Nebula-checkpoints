'use strict';
/*
 * The provider disconnect's server contract: a route that removes an account
 * hands the account lifecycle's own disconnect the session as it stands, and
 * answers with what the disconnect decided -- which accounts remain, which one
 * stays selected, and what must be revoked by hand. Here identity and access's
 * routes run over the real lifecycle, outside the alpha, against a recording
 * provider and database.
 *
 * The contract's other halves are asked where they live:
 *   - each removal route's answers, a pending cleanup included, and that the
 *     cleanup is asked while the session still holds the account
 *     (test/identity-account-routes.test.js,
 *     test/identity-security-routes.test.js);
 *   - the disconnect itself: the identity's webhooks taken from the inventory
 *     by their provider ids, each removed through the gateway and read back
 *     before it counts as gone, a retired account's cleanup task recorded and
 *     the accounts after it still disconnected, each step through the privacy
 *     store (test/account-lifecycle.test.js, test/provider-disconnect.test.js),
 *     and the composed invite-only server end to end
 *     (test/composition-alpha.test.js);
 *   - a tester's provider session, read and written through the record the
 *     tester owns, never the raw session id (test/provider-sessions.test.js);
 *     its sessions elsewhere found and revoked through that ownership
 *     (test/account-lifecycle.test.js), by revoking other sessions and by
 *     emergency containment (test/identity-security-routes.test.js,
 *     test/corona-routes.test.js);
 *   - an App connection's identity, the same across testers and authorizers
 *     (test/account-identity.test.js); its records and audits, the alpha
 *     keeping no installation metadata and no login
 *     (test/github-app-records.test.js); its routes, addressed by the
 *     connection's key in the alpha and never invalidating the shared broker
 *     there (test/identity-security-routes.test.js, test/github-rest.test.js);
 *   - no request that carries a credential follows a redirect -- the REST
 *     client, the OAuth exchange, each LFS exchange -- and LFS storage is
 *     HTTPS without credentials in its address (test/github-rest.test.js,
 *     test/identity-security-routes.test.js,
 *     test/workbench-collaboration-routes.test.js,
 *     test/workbench-repository-routes.test.js);
 *   - evidence and audits name the tester's label in the alpha, never a login
 *     (test/repository-access.test.js, test/upload-scan.test.js,
 *     test/account-lifecycle.test.js);
 *   - only the routes that remove an account disconnect one, and only that
 *     disconnect removes an installation's record (test/module-rules.test.js).
 */
const assert = require('node:assert/strict');
const express = require('express');
const identity = require('../apps/api/src/modules/identity-access/index.ts');

const { createAccountLifecycle, registerAccountRoutes, registerSignOutRoute, providerRevocationGuidance } = identity;

const ALICE = { provider: 'github', login: 'alice', token: 'ghp_alice', authMethod: 'token' };
const BOB = { provider: 'github', login: 'bob', token: 'gho_bob', authMethod: 'oauth' };
const CAROL = { provider: 'github', login: 'carol', token: 'ghp_carol', authMethod: 'token' };
const AUTHORIZER = 'c'.repeat(64);
const ACME = {
  provider: 'github', login: 'acme', authMethod: 'github-app', installationId: 42, installationAccountId: 9,
  authorizedByIdentityKey: AUTHORIZER, authorizedByLogin: 'alice'
};
const DAVE = { provider: 'gitlab', login: 'dave', token: 't4', baseUrl: 'https://gitlab.example.com/api/v4' };
/* What a retired account leaves to be revoked by hand, as the routes answer it. */
const byHand = account => {
  const guidance = providerRevocationGuidance(account);
  return { label: guidance.label, url: guidance.url || null, automatic: false };
};

async function start() {
  const calls = [];
  const state = { session: null };
  const lifecycle = createAccountLifecycle({
    alphaEnabled: false, databaseConfigured: true, accountCap: () => 5, ready: async () => true,
    pool: () => ({
      async query(text, values) { calls.push(['query', String(text).replace(/\s+/g, ' ').trim(), values]); return { rows: [] }; }
    }),
    gh: async (account, apiPath) => { calls.push(['gh', account.login, apiPath]); return {}; },
    resolveAccount: async account => account,
    runProviderMutation: async (req, target, work) => work(),
    appBroker: { invalidate(id) { calls.push(['invalidate', id]); } },
    removeGithubAppInstallation: async (key, installationId) => { calls.push(['removeInstallation', key, installationId]); },
    recordGithubAppAudit: async (key, eventType, installationId, details) => { calls.push(['audit', key, eventType, installationId, details]); },
    forgetJobs: account => { calls.push(['forget', account.login]); },
    retainedActor: req => req.gh && req.gh.login,
    sessionOf: async () => null,
    setSession: async () => { throw new Error('outside the alpha, the disconnect leaves the session to the route'); },
    sessionIdFromRequest: () => '',
    clearStepUpAuthorization: session => { calls.push(['clearStepUp']); delete session.stepUp; },
    readCookie: () => undefined,
    writeCookie: () => {},
    seal: JSON.stringify,
    unseal: () => null,
    closeLiveSessions: () => 0,
    privacyStore: null
  });
  const isGithubAccount = account => !!account && (account.provider || 'github') === 'github' && !account.baseUrl;
  const accountAuth = (req, res, next) => {
    req.session = structuredClone(state.session);
    req.sessionAccount = req.session.accounts[Math.min(Number(req.session.active) || 0, req.session.accounts.length - 1)];
    req.gh = { ...req.sessionAccount };
    next();
  };
  const deps = {
    accountAuth, isGithubAccount,
    config: { enabled: false, mode: 'off' },
    fail: (res, error) => res.status(error.status || 500).json({ error: error.message, code: error.code }),
    retainedActor: req => req.gh && req.gh.login,
    clearStepUpAuthorization: session => { delete session.stepUp; },
    setSession: async (req, res, session) => { calls.push(['setSession', structuredClone(session)]); },
    sessionOf: async () => { throw new Error('outside the alpha, a removal does not read the session again'); },
    destroySession: async () => { calls.push(['destroySession']); },
    /* The lifecycle's own disconnect, as the composition hands it to these routes. */
    disconnectProviderAccounts: lifecycle.disconnectAlphaProviderAccount,
    clearProviderSessionCookie: () => { calls.push(['clearProviderCookie']); }
  };
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, deps);
  registerSignOutRoute(app, deps);
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const send = async (url, body = {}) => {
    calls.length = 0;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { state, calls, send, close: () => new Promise(resolve => server.close(resolve)) };
}
const called = (calls, name) => calls.filter(call => call[0] === name).map(call => call.slice(1));
const logins = session => session.accounts.map(account => account.login);

(async () => {
  const t = await start();
  try {
    /* An account before the selected one leaves: the selected identity stays selected. */
    {
      t.state.session = { accounts: [ALICE, BOB, CAROL], active: 1 };
      const removed = await t.send('/api/accounts/remove', { idx: 0 });
      assert.deepEqual([removed.status, removed.body], [200, { ok: true, removed: 'alice', active: 'bob' }]);
      const [[written]] = called(t.calls, 'setSession');
      assert.deepEqual([logins(written), written.active], [['bob', 'carol'], 0], 'the session keeps the identity it had selected');
    }
    /* The selected account leaves: a GitHub account is chosen, never a retired one. */
    {
      t.state.session = { accounts: [ALICE, DAVE, BOB], active: 0 };
      const removed = await t.send('/api/accounts/remove', { idx: 0 });
      assert.deepEqual(removed.body, { ok: true, removed: 'alice', active: 'bob' });
      const [[written]] = called(t.calls, 'setSession');
      assert.deepEqual([logins(written), written.active], [['dave', 'bob'], 1]);
    }
    /* The last GitHub account leaves: the retired ones go with it, named for revoking by hand, and the session ends. */
    {
      t.state.session = { accounts: [ALICE, DAVE], active: 0 };
      const last = await t.send('/api/accounts/remove', { idx: 0 });
      assert.deepEqual(last.body, { ok: true, removed: 'alice', empty: true, revocationGuidance: [byHand(DAVE)] });
      assert.deepEqual(called(t.calls, 'forget'), [['alice'], ['dave']], 'each account is disconnected, the retired one after');
      assert.deepEqual(called(t.calls, 'destroySession'), [[]]);
      assert.deepEqual(called(t.calls, 'setSession'), [], 'nothing is written for a session that ends');
    }
    /* Signing out disconnects every account: an App's installation is forgotten and its record removed, audited under who acted. */
    {
      t.state.session = { accounts: [ALICE, ACME, DAVE], active: 0 };
      const out = await t.send('/api/logout');
      assert.deepEqual([out.status, out.body], [200, { ok: true, revocationGuidance: [byHand(DAVE)] }]);
      assert.deepEqual(called(t.calls, 'forget'), [['alice'], ['acme'], ['dave']], 'retired accounts too');
      assert.deepEqual(called(t.calls, 'invalidate'), [[42]], 'the broker forgets the installation');
      assert.deepEqual(called(t.calls, 'removeInstallation'), [[AUTHORIZER, 42]], 'its record is removed under the user who connected it');
      assert.deepEqual(called(t.calls, 'audit'), [[AUTHORIZER, 'installation.disconnected', 42, { actor: 'alice', status: 'disconnected' }]]);
      assert.deepEqual(called(t.calls, 'destroySession'), [[]]);
    }
  } finally {
    await t.close();
  }
  console.log('provider disconnect server contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
