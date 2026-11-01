'use strict';
/*
 * An account's life in a session (identity and access's account lifecycle):
 * who an account is; signing in, outside the alpha and into a tester's own
 * provider session; disconnecting, outside the alpha and through the provider
 * disconnect; ending a provider session's cookie; revoking sessions elsewhere;
 * and the identity's sessions elsewhere -- against a recording provider, pool
 * and privacy store.
 */
const assert = require('assert');
const identity = require('../apps/api/src/modules/identity-access/index.ts');

const {
  createAccountLifecycle, RETIRED_CLEANUP, HOSTED_SESSION_BASE, HOSTED_SESSION_REVISION, identityKey, stableProviderIdentityKey,
  providerRevocationGuidance, providerResourceKeyHash, alphaConnectionRefusal
} = identity;

const TESTER = '0b5e3c6a-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const CLEANUP = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTHORIZER = 'c'.repeat(64);
const seal = value => `sealed:${JSON.stringify(value)}`;
const unseal = sealed => {
  if (typeof sealed !== 'string' || !sealed.startsWith('sealed:')) return null;
  try { return JSON.parse(sealed.slice(7)); } catch { return null; }
};
const github = (login, extra = {}) => ({ provider: 'github', login, token: `ghp_${login}`, authMethod: 'token', ...extra });
const app = (installationId = 41, extra = {}) => ({
  provider: 'github', login: 'alice-app', avatar: 'https://avatars.example/a', authMethod: 'github-app', installationId,
  installationAccountId: 9, authorizedByIdentityKey: AUTHORIZER, authorizedByLogin: 'alice', ...extra
});
const retired = (login = 'old') => ({ provider: 'gitlab', login, token: 't', baseUrl: 'https://gitlab.example' });

/*
 * A provider, a pool and a privacy store that record what they are asked and
 * answer as each case says.
 */
function harness(options = {}) {
  const calls = [];
  const at = name => calls.filter(entry => entry[0] === name).map(entry => entry.slice(1));
  const answers = {
    gh: async (account, apiPath, opts) => ({ login: 'from-provider', path: apiPath, opts }),
    rows: () => [],
    prepare: input => ({
      webhooks: input.webhookResourceKeyHashes.map((resourceKeyHash, i) => ({ resourceKeyHash, cleanupId: CLEANUP(i + 1), requesterOwned: true })),
      providerSessions: [{ resourceKeyHash: 'b'.repeat(64), cleanupId: CLEANUP(90) }]
    }),
    complete: () => ({ verified: true }),
    finalize: () => ({ finalized: true }),
    connect: input => ({ session: { accounts: [input.account], active: 0 }, revision: 'rev-1' }),
    hosted: { accounts: [], active: 0 },
    ...options.answers
  };
  const store = {
    prepareProviderDisconnect(input) { calls.push(['prepare', input]); return answers.prepare(input); },
    completeProviderWebhookCleanup(input) { calls.push(['complete', input]); return answers.complete(input); },
    finalizeProviderDisconnect(input) { calls.push(['finalize', input]); return answers.finalize(input); },
    createCleanupTask(input) { calls.push(['cleanupTask', input]); return { cleanupId: CLEANUP(77) }; },
    async mutateHostedProviderSession(input) {
      const next = input.mutate(structuredClone(answers.hosted));
      calls.push(['mutateHosted', { testerId: input.testerId, sessionId: input.sessionId }, next]);
      return { session: next, revision: 'rev-2' };
    },
    async revokeOwnedProviderSessions(input) { calls.push(['revokeOwned', input]); return { revokedSessionIds: new Set(input.sessionIds.slice(0, 1)) }; },
    async connectHostedProviderAccount(input) { calls.push(['connect', input]); return answers.connect(input); }
  };
  const life = createAccountLifecycle({
    alphaEnabled: Boolean(options.alpha), databaseConfigured: options.database !== false, accountCap: () => options.cap || 5,
    ready: async () => options.ready !== false,
    pool: () => ({
      async query(text, values) {
        const sql = String(text).replace(/\s+/g, ' ').trim();
        calls.push(['query', sql, values]);
        return { rows: answers.rows(sql, values) };
      }
    }),
    gh: async (account, apiPath, opts) => { calls.push(['gh', account, apiPath, opts]); return answers.gh(account, apiPath, opts); },
    resolveAccount: async account => { calls.push(['resolve', account]); return { ...account, resolved: true }; },
    appBroker: options.broker === false ? null : { invalidate(id) { calls.push(['invalidate', id]); } },
    removeGithubAppInstallation: async (key, installationId) => { calls.push(['removeInstallation', key, installationId]); },
    recordGithubAppAudit: async (key, eventType, installationId, details) => { calls.push(['audit', key, eventType, installationId, details]); },
    forgetJobs: account => { calls.push(['forget', account]); },
    retainedActor: req => (req.alpha ? 'tester' : req.gh && req.gh.login),
    sessionOf: async req => req.existing || null,
    setSession: async (req, res, data, opts) => { calls.push(['setSession', structuredClone(data), opts]); },
    sessionIdFromRequest: req => req.sid || '',
    clearStepUpAuthorization: session => { calls.push(['clearStepUp']); delete session.stepUp; },
    readCookie: (req, name) => (name === 'nv_session' ? req.cookie : undefined),
    writeCookie: (res, value, maxAge) => { calls.push(['cookie', value, maxAge]); },
    seal, unseal,
    closeLiveSessions: (ids, reason) => { calls.push(['closeLive', ids, reason]); },
    privacyStore: store
  });
  return { life, calls, at };
}
const tester = (extra = {}) => ({ alpha: { testerId: TESTER }, sid: 'sid-held', cookie: seal({ sid: 'sid-held' }), ...extra });
const rejects = async (promise, check, label) => {
  let thrown = null;
  try { await promise; } catch (error) { thrown = error; }
  assert(thrown, `${label}: expected a refusal`);
  check(thrown);
};

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the account lifecycle tests did not finish'); process.exitCode = 1; } });

(async () => {
  /* ---- Who an account is ------------------------------------------------------------- */
  {
    const h = harness();
    assert.deepStrictEqual(await h.life.providerIdentity(app()), { login: 'alice-app', name: 'alice-app', avatar_url: 'https://avatars.example/a', id: 9 }, 'an installation is who it says');
    assert.strictEqual(h.at('gh').length, 0, 'and the provider is not asked');
    const answer = await h.life.providerIdentity(github('alice'));
    assert.strictEqual(answer.path, '/user', 'a token account is who the provider says');
    assert.deepStrictEqual(h.at('gh')[0].slice(0, 2), [github('alice'), '/user']);
  }

  /* ---- Signing in, outside the alpha ---------------------------------------------------- */
  {
    const h = harness();
    const req = { sid: 'old-row', cookie: seal({ sid: 'old-row' }) };
    await h.life.addAccount(req, {}, 'ghp_new', { login: ' alice ', avatar_url: 'https://a', id: '7' });
    const [[data, opts]] = h.at('setSession');
    const expected = { login: 'alice', avatar: 'https://a', providerAccountId: 7, provider: 'github', baseUrl: '', authMethod: 'token', token: 'ghp_new' };
    assert.deepStrictEqual(data.accounts, [{ ...expected, identityKey: identityKey(expected) }], 'the account is trimmed, numbered and keyed as the session keys it');
    assert.notStrictEqual(data.accounts[0].identityKey, stableProviderIdentityKey(expected));
    assert.strictEqual(data.active, 0);
    assert.deepStrictEqual(opts, { createNew: true }, 'a first sign-in starts a session');
    assert.deepStrictEqual(h.at('query'), [['DELETE FROM nv_sessions WHERE sid=$1', ['old-row']]], 'the row the cookie still named goes');
    assert.deepStrictEqual(h.at('closeLive'), [[['old-row'], 'session-ended']], 'and its live streams with it');
    assert.strictEqual(h.at('clearStepUp').length, 1);
    assert.strictEqual(h.at('connect').length, 0);
  }
  {
    const existing = { accounts: [retired('alice'), github('bob'), github('alice')], active: 0, retiredSelection: { provider: 'gitlab' }, stepUp: { grant: 1 } };
    const h = harness({ cap: 3 });
    const req = { sid: 'sid-1', existing };
    await h.life.addAccount(req, {}, 'ghp_again', { login: 'alice' });
    const [[data, opts]] = h.at('setSession');
    assert.deepStrictEqual(data.accounts.map(a => [a.provider, a.login, a.token]), [['gitlab', 'alice', 't'], ['github', 'bob', 'ghp_bob'], ['github', 'alice', 'ghp_again']],
      'the same login at the same provider is replaced, the same login elsewhere kept');
    assert.strictEqual(data.active, 2, 'the new account is selected');
    assert.strictEqual(data.retiredSelection, undefined, 'signing in is the choice a retired selection asked for');
    assert.strictEqual(data.stepUp, undefined, 'a step-up grant does not outlive the change');
    assert.deepStrictEqual(opts, { createNew: false });
    assert.strictEqual(h.at('query').length, 0, 'an existing session\'s row is not replaced');
  }
  {
    const h = harness({ cap: 1 });
    await h.life.addAccount({ existing: { accounts: [github('bob'), github('carol')], active: 0 } }, {}, 'ghp_d', { login: 'dave' });
    assert.deepStrictEqual(h.at('setSession')[0][0].accounts.map(a => a.login), ['dave'], 'the oldest accounts leave first above the cap');
    assert.strictEqual(h.at('setSession')[0][0].active, 0);
  }
  {
    const h = harness({ database: false });
    await h.life.addAccount({ sid: 'old-row' }, {}, 'ghp_x', { login: 'x' }, 'github', '', null);
    assert.strictEqual(h.at('query').length, 0, 'no database, no row to replace');
    assert.strictEqual(h.at('setSession')[0][0].accounts[0].authMethod, 'token', 'no options is a token sign-in');
    const other = harness();
    await other.life.addAccount({}, {}, 'ghp_x', { login: 'x' }, 'github', '', { authMethod: 'nope' });
    assert.strictEqual(other.at('setSession')[0][0].accounts[0].authMethod, 'token', 'an unknown method is a token sign-in');
    await other.life.addAccount({}, {}, 'gho_x', { login: 'y' }, 'github', '', { authMethod: 'oauth' });
    assert.strictEqual(other.at('setSession')[1][0].accounts[0].authMethod, 'oauth');
  }
  {
    const h = harness();
    await rejects(h.life.addAccount({}, {}, 'ghp_x', { login: '  ' }), error => assert.deepStrictEqual([error.message, error.status], ['Provider identity is incomplete', 502]), 'no login');
    await rejects(h.life.addAccount({}, {}, '', { login: 'alice' }), error => assert.deepStrictEqual([error.message, error.status], ['Provider credential is unavailable', 401]), 'no credential');
    for (const installationId of [0, 1.5, 'x', -3]) {
      await rejects(h.life.addAccount({}, {}, '', { login: 'alice' }, 'github', '', { authMethod: 'github-app', account: { installationId } }),
        error => assert.deepStrictEqual([error.status, error.code], [400, 'GITHUB_APP_ACCOUNT_INVALID']), String(installationId));
    }
    assert.strictEqual(h.at('setSession').length, 0);
  }
  {
    const permissions = { contents: 'read' };
    const sameAuthorizer = app(41, { login: 'old-app' });
    const otherAuthorizer = app(41, { login: 'other-app', authorizedByIdentityKey: 'd'.repeat(64) });
    const h = harness();
    await h.life.addAccount({ existing: { accounts: [{ ...sameAuthorizer, installationId: '41' }, otherAuthorizer], active: 0 } }, {}, 'ignored', { login: 'alice-app', avatar_url: 'https://a', id: 5 }, 'github', '', {
      authMethod: 'github-app',
      account: {
        installationId: 41, installationAccountId: '9', installationAccountType: 'Organization'.repeat(5), repositorySelection: 'all', permissions,
        authorizedByLogin: 'y'.repeat(150), authorizedById: '3', authorizedByIdentityKey: AUTHORIZER, installationHtmlUrl: 'https://github.com/settings/installations/41'
      }
    });
    const accounts = h.at('setSession')[0][0].accounts;
    assert.deepStrictEqual(accounts.map(a => a.login), ['other-app', 'alice-app'], 'an installation replaces its own entry, not another authorizer\'s');
    const added = accounts[1];
    assert.strictEqual(added.token, undefined, 'an installation holds no token');
    assert.strictEqual(added.installationAccountId, 9);
    assert.strictEqual(added.installationAccountType.length, 40, 'its text is bounded');
    assert.strictEqual(added.authorizedByLogin.length, 100);
    assert.strictEqual(added.authorizedById, 3);
    assert.strictEqual(added.repositorySelection, 'all');
    assert.deepStrictEqual(added.permissions, permissions);
    assert.notStrictEqual(added.permissions, permissions, 'its permissions are its own copy');
    assert.strictEqual(added.installationStatus, 'connected');
    assert(Math.abs(Date.parse(added.lastVerifiedAt) - Date.now()) < 60000, 'verified now when nothing says when');
    const later = harness();
    await later.life.addAccount({}, {}, '', { login: 'a' }, 'github', '', { authMethod: 'github-app', account: { installationId: 2, repositorySelection: 'some', permissions: 'x', lastVerifiedAt: '2026-10-31T00:00:00Z' } });
    const second = later.at('setSession')[0][0].accounts[0];
    assert.deepStrictEqual([second.repositorySelection, second.permissions, second.lastVerifiedAt, second.installationAccountType], ['selected', {}, '2026-10-31T00:00:00Z', 'User']);
  }

  /* ---- Signing in, into a tester's own provider session --------------------------------------- */
  {
    const h = harness({ alpha: true, cap: 3 });
    const req = tester();
    await h.life.addAccount(req, {}, 'ghp_t', { login: 'alice', id: 7 });
    const [[input]] = h.at('connect');
    const account = { login: 'alice', avatar: '', providerAccountId: 7, provider: 'github', baseUrl: '', authMethod: 'token', token: 'ghp_t' };
    assert.deepStrictEqual(input, { testerId: TESTER, sessionId: 'sid-held', account: { ...account, identityKey: stableProviderIdentityKey(account) }, authority: 'github.com', capacity: 3 },
      'the account joins the session the cookie holds, keyed for the alpha, within the cap');
    assert.deepStrictEqual(req.session, { accounts: [input.account], active: 0 });
    assert.deepStrictEqual(req[HOSTED_SESSION_BASE], req.session, 'the base a later change merges against');
    assert.notStrictEqual(req[HOSTED_SESSION_BASE], req.session, 'is a copy');
    assert.strictEqual(req[HOSTED_SESSION_REVISION], 'rev-1');
    assert.deepStrictEqual(h.at('cookie'), [[seal({ sid: 'sid-held' }), undefined]]);
    assert.strictEqual(h.at('setSession').length, 0, 'the hosted session is the store\'s');
  }
  {
    const h = harness({ alpha: true });
    await h.life.addAccount(tester({ cookie: seal({ sid: 7 }) }), {}, 'ghp_t', { login: 'alice' });
    const sid = h.at('connect')[0][0].sessionId;
    assert.match(sid, /^[0-9a-f]{48}$/, 'a cookie without a session\'s name starts a new one');
    assert.deepStrictEqual(h.at('cookie'), [[seal({ sid }), undefined]]);
  }
  {
    let first = true;
    const h = harness({ alpha: true, answers: { connect: input => {
      if (first) { first = false; throw Object.assign(new Error('ended'), { code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE' }); }
      return { session: { accounts: [input.account], active: 0 }, revision: 'rev-9' };
    } } });
    const req = tester();
    await h.life.addAccount(req, {}, 'ghp_t', { login: 'alice' });
    const sessions = h.at('connect').map(([input]) => input.sessionId);
    assert.strictEqual(sessions[0], 'sid-held');
    assert.match(sessions[1], /^[0-9a-f]{48}$/, 'a cookie naming a session that ended starts a new one');
    assert.deepStrictEqual(h.at('cookie'), [[seal({ sid: sessions[1] }), undefined]]);
    assert.strictEqual(req[HOSTED_SESSION_REVISION], 'rev-9');
  }
  {
    const ended = Object.assign(new Error('ended'), { code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', status: 401 });
    const h = harness({ alpha: true, answers: { connect: () => { throw ended; } } });
    await rejects(h.life.addAccount(tester({ cookie: '' }), {}, 'ghp_t', { login: 'alice' }), error => assert.deepStrictEqual(error, alphaConnectionRefusal(ended)), 'a new session that cannot start');
    assert.strictEqual(h.at('connect').length, 1, 'is not retried');
    const full = Object.assign(new Error('full'), { code: 'ALPHA_PROVIDER_ACCOUNT_CAPACITY' });
    const capped = harness({ alpha: true, answers: { connect: () => { throw full; } } });
    await rejects(capped.life.addAccount(tester(), {}, 'ghp_t', { login: 'alice' }), error => {
      assert.strictEqual(error.message, 'This session already holds the most accounts it can. Remove one first.');
      assert.deepStrictEqual([error.status, error.code, error.providerChanged], [409, 'ALPHA_PROVIDER_ACCOUNT_CAPACITY', false]);
    }, 'a full session');
    assert.strictEqual(capped.at('connect').length, 1, 'only an ended session is started again');
    assert.strictEqual(capped.at('cookie').length, 0);
  }

  /* ---- Disconnecting, outside the alpha ------------------------------------------------------------ */
  {
    const h = harness();
    const req = { gh: github('alice'), session: { accounts: [retired(), github('alice'), app()], active: 1, stepUp: { grant: 1 } } };
    const result = await h.life.disconnectAlphaProviderAccount(req, [retired(), null, 'text']);
    assert.deepStrictEqual(req.session.accounts.map(a => a.login), ['alice', 'alice-app'], 'the account leaves');
    assert.strictEqual(req.session.active, 0, 'and the selected identity stays selected');
    assert.strictEqual(req.session.stepUp, undefined);
    assert.strictEqual(h.at('forget').length, 1, 'only accounts are forgotten');
    assert.deepStrictEqual(result, { complete: true, supportedComplete: true, legacy: true, results: [], manualCleanup: [providerRevocationGuidance(retired())] },
      'a retired account is revoked by hand');
    assert(Object.isFrozen(result) && Object.isFrozen(result.manualCleanup));
    assert.strictEqual(h.at('removeInstallation').length + h.at('audit').length + h.at('invalidate').length, 0, 'a token account has no installation');
  }
  {
    const h = harness();
    const req = { gh: github('alice'), session: { accounts: [retired(), github('alice'), github('bob')], active: 1 } };
    await h.life.disconnectAlphaProviderAccount(req, github('alice'));
    assert.deepStrictEqual(req.session.accounts.map(a => a.login), ['old', 'bob']);
    assert.strictEqual(req.session.active, 1, 'the selected account leaving hands the session to a GitHub one, never a retired one');
    const clamped = harness();
    const far = { session: { accounts: [github('alice'), retired(), github('bob')], active: 5 } };
    await clamped.life.disconnectAlphaProviderAccount(far, retired());
    assert.strictEqual(far.session.active, 1, 'an index past the end selects the last account, which stays selected');
    assert.strictEqual((await clamped.life.disconnectAlphaProviderAccount({ session: { accounts: [], active: 0 } }, [])).complete, true);
  }
  {
    const h = harness();
    const req = { gh: github('alice'), session: { accounts: [app()], active: 0 } };
    await h.life.disconnectAlphaProviderAccount(req, app());
    assert.deepStrictEqual(h.at('invalidate'), [[41]], 'the installation\'s token is dropped');
    assert.deepStrictEqual(h.at('removeInstallation'), [[AUTHORIZER, 41]], 'its grant removed');
    assert.deepStrictEqual(h.at('audit'), [[AUTHORIZER, 'installation.disconnected', 41, { actor: 'alice', status: 'disconnected' }]], 'and recorded');
    const unbrokered = harness({ broker: false });
    await unbrokered.life.disconnectAlphaProviderAccount({ session: { accounts: [app()], active: 0 } }, app());
    assert.strictEqual(unbrokered.at('removeInstallation').length, 1, 'without an App broker the grant still goes');
  }

  /* ---- Disconnecting, through the provider disconnect ------------------------------------------------- */
  const hookRows = [
    { hook_id: 1, provider_hook_id: 100, owner: 'a b', repo: 'demo', alpha_resource_key_hash: null },
    { hook_id: 2, provider_hook_id: 101, owner: 'a b', repo: 'demo', alpha_resource_key_hash: null }
  ];
  const absentOnRead = async (account, apiPath, opts) => {
    if (!opts) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { status: 204 };
  };
  {
    const h = harness({ alpha: true });
    await rejects(h.life.disconnectAlphaProviderAccount({ alpha: { testerId: TESTER }, session: { accounts: [] } }, github('alice')),
      error => assert.deepStrictEqual([error.status, error.code], [401, 'ALPHA_PROVIDER_SESSION_UNAVAILABLE']), 'no provider session');
    await rejects(h.life.disconnectAlphaProviderAccount(tester({ alpha: {} }), github('alice')),
      error => assert.deepStrictEqual([error.status, error.code], [401, 'ALPHA_PROVIDER_SESSION_UNAVAILABLE']), 'no tester');
  }
  {
    const account = github('alice');
    const h = harness({ alpha: true, answers: { rows: sql => (sql.includes('nv_webhooks') ? hookRows.map(row => ({ ...row })) : []), gh: absentOnRead } });
    const result = await h.life.disconnectAlphaProviderAccount(tester(), account);
    assert.deepStrictEqual(h.at('query'), [[
      'SELECT hook_id,provider_hook_id,owner,repo,alpha_resource_key_hash FROM nv_webhooks WHERE provider=$1 AND identity_key=$2 ORDER BY hook_id',
      ['github', identityKey(account)]
    ]], 'the identity\'s own webhooks');
    const hash = reference => providerResourceKeyHash({ provider: 'github', authority: 'github.com', resourceType: 'provider-webhook', resourceReference: reference });
    assert.deepStrictEqual(h.at('prepare')[0][0].webhookResourceKeyHashes, [hash('100'), hash('101')], 'each by its provider id');
    assert.deepStrictEqual(h.at('gh').map(([, apiPath, opts]) => [apiPath, opts]), [
      ['/repos/a%20b/demo/hooks/100', { method: 'DELETE' }], ['/repos/a%20b/demo/hooks/100', undefined],
      ['/repos/a%20b/demo/hooks/101', { method: 'DELETE' }], ['/repos/a%20b/demo/hooks/101', undefined]
    ], 'each removed and read back');
    assert.strictEqual(h.at('resolve').length, 1, 'with the credential resolved once');
    assert.deepStrictEqual(h.at('complete').map(([input]) => input.providerVerifiedAbsent), [true, true]);
    assert.strictEqual(h.at('invalidate').length, 0, 'a token account has no installation token');
    assert.deepStrictEqual(result, {
      complete: true, supportedComplete: true, legacy: false,
      results: [{ providerStateRemoved: true, webhookCleanup: 'verified', brokerCacheCleared: true, providerRevoked: false, revocationGuidance: providerRevocationGuidance(account) }],
      manualCleanup: []
    });
  }
  {
    const claimed = harness({ alpha: true, answers: { rows: sql => (sql.includes('nv_webhooks') ? hookRows.slice(0, 1).map(row => ({ ...row })) : []), gh: async () => ({ status: 204 }) } });
    const result = await claimed.life.disconnectAlphaProviderAccount(tester(), github('alice'));
    assert.strictEqual(result.complete, false, 'a hook the provider still shows is not claimed removed');
    assert.strictEqual(claimed.at('complete').length, 0);
    const inconsistent = harness({ alpha: true, answers: { rows: sql => (sql.includes('nv_webhooks') ? [{ ...hookRows[0], alpha_resource_key_hash: 'e'.repeat(64) }] : []) } });
    await rejects(inconsistent.life.disconnectAlphaProviderAccount(tester(), github('alice')), error => assert.strictEqual(error.message, 'provider webhook inventory hash is inconsistent'), 'a stored hash that disagrees');
  }
  {
    const h = harness({ alpha: true });
    const result = await h.life.disconnectAlphaProviderAccount(tester(), app());
    assert.deepStrictEqual(h.at('invalidate'), [[41]], 'an installation\'s token is dropped once its state is gone');
    assert.deepStrictEqual(h.at('audit'), [[identityKey(app()), 'installation.disconnected', 41, { actor: 'tester', status: 'disconnected' }]]);
    assert.strictEqual(result.complete, true);
  }
  {
    const hosted = { accounts: [retired('other'), retired(), github('alice'), github('bob')], active: 3 };
    const h = harness({ alpha: true, answers: { hosted } });
    const req = tester({ session: { accounts: [] } });
    const result = await h.life.disconnectAlphaProviderAccount(req, [retired(), github('alice')]);
    assert.deepStrictEqual(h.at('cleanupTask')[0][0], {
      testerId: TESTER, identityKey: identityKey(retired()), provider: 'gitlab', resourceType: 'provider-session',
      resourceKeyHash: h.at('cleanupTask')[0][0].resourceKeyHash, reasonCode: RETIRED_CLEANUP
    }, 'a retired account\'s cleanup waits for the operator');
    assert.strictEqual(result.results.length, 2, 'and the accounts after it are still disconnected');
    assert.deepStrictEqual(h.at('mutateHosted')[0].slice(0, 2), [{ testerId: TESTER, sessionId: 'sid-held' }, { accounts: [retired('other'), github('alice'), github('bob')], active: 2 }],
      'its credential leaves the session now, and the selection stays');
    assert.deepStrictEqual(req.session, h.at('mutateHosted')[0][1]);
    assert.deepStrictEqual(req[HOSTED_SESSION_BASE], req.session);
    assert.notStrictEqual(req[HOSTED_SESSION_BASE], req.session);
    assert.strictEqual(req[HOSTED_SESSION_REVISION], 'rev-2');
    assert.deepStrictEqual([result.complete, result.supportedComplete], [false, true], 'complete as far as anything can be');
    assert.deepStrictEqual(result.manualCleanup, [providerRevocationGuidance(retired())]);
    const selected = harness({ alpha: true, answers: { hosted: { accounts: [retired('other'), retired(), github('alice')], active: 1 } } });
    await selected.life.disconnectAlphaProviderAccount(tester(), retired());
    assert.strictEqual(selected.at('mutateHosted')[0][1].active, 1, 'a GitHub account is selected when the selected one leaves');
  }
  {
    const h = harness({ alpha: true, answers: { finalize: () => ({ finalized: false }) } });
    const result = await h.life.disconnectAlphaProviderAccount(tester(), [github('alice'), github('bob')]);
    assert.strictEqual(result.results.length, 1, 'an account whose state stays stops the rest');
    assert.deepStrictEqual([result.complete, result.supportedComplete, result.results[0].providerStateRemoved], [false, false, false]);
    assert.strictEqual(h.at('mutateHosted').length, 0);
  }

  /* ---- Ending a provider session's cookie, and sessions elsewhere ---------------------------------------- */
  {
    const h = harness();
    h.life.clearProviderSessionCookie({ sid: 'sid-1' }, {});
    h.life.clearProviderSessionCookie({}, {});
    assert.deepStrictEqual(h.at('closeLive'), [[['sid-1'], 'session-ended']], 'a session\'s live streams end with it');
    assert.deepStrictEqual(h.at('cookie'), [['', 0], ['', 0]], 'the cookie is cleared');
  }
  {
    const off = harness();
    assert.deepStrictEqual(await off.life.revokeContainedSessions({}, []), []);
    assert.strictEqual(off.calls.length, 0, 'nothing to revoke asks nothing');
    assert.deepStrictEqual(await off.life.revokeContainedSessions({}, ['a', 'b']), ['a', 'b']);
    assert.deepStrictEqual(off.at('query'), [['DELETE FROM nv_sessions WHERE sid = ANY($1::text[])', [['a', 'b']]]]);
    const on = harness({ alpha: true });
    assert.deepStrictEqual(await on.life.revokeContainedSessions(tester(), ['a', 'b']), ['a'], 'what the store revoked, not what was asked');
    assert.deepStrictEqual(on.at('revokeOwned'), [[{ testerId: TESTER, sessionIds: ['a', 'b'] }]]);
  }
  {
    const me = github('alice');
    const other = github('zoe');
    const indexed = [
      { sid: 'cur', updated: 1, data: seal({ accounts: [me] }) },
      { sid: 'two', updated: 2, data: seal({ accounts: [other, { ...me, token: 'other' }] }) },
      { sid: 'bad', updated: 3, data: 'garbage' }
    ];
    const legacy = [
      { sid: 'two', updated: 2, data: seal({ accounts: [me] }) },
      { sid: 'old', updated: 4, data: seal({ accounts: [me] }) },
      { sid: 'odd', updated: 5, data: seal({ accounts: 'x' }) },
      { sid: 'zoe', updated: 6, data: seal({ accounts: [other] }) }
    ];
    const h = harness({ answers: { rows: sql => (sql.includes('cardinality') ? legacy : indexed) } });
    const listed = await h.life.sessionsForIdentity({ gh: me, cookie: seal({ sid: 'cur' }) });
    assert.deepStrictEqual(listed, {
      available: true, currentSid: 'cur', login: 'alice', provider: 'github',
      rows: [{ sid: 'cur', updated: 1, current: true, provider: 'github' }, { sid: 'two', updated: 2, current: false, provider: 'github' }, { sid: 'old', updated: 4, current: false, provider: 'github' }]
    }, 'each row holding the identity once, the current one marked');
    assert.deepStrictEqual(h.at('query'), [
      ['SELECT sid, data, updated FROM nv_sessions WHERE identity_keys @> ARRAY[$1]::text[] ORDER BY updated DESC LIMIT 1000', [identityKey(me)]],
      ['SELECT sid, data, updated FROM nv_sessions WHERE cardinality(identity_keys)=0 ORDER BY updated DESC LIMIT 500', undefined]
    ], 'the indexed rows and the rows written before the index');
    const none = harness();
    assert.deepStrictEqual(await none.life.sessionsForIdentity({ gh: me, cookie: '' }), { available: false, currentSid: '', rows: [] }, 'without a session of its own');
    assert.strictEqual(none.calls.length, 0);
    assert.deepStrictEqual(await harness({ ready: false }).life.sessionsForIdentity({ gh: me, cookie: seal({ sid: 'cur' }) }), { available: false, currentSid: '', rows: [] }, 'without the database');
  }
  {
    const old = retired();
    const h = harness({ alpha: true, answers: { rows: () => [{ sid: 'sid-held', updated: 1, data: seal({ accounts: [old] }) }] } });
    const listed = await h.life.sessionsForIdentity({ ...tester(), gh: old });
    assert.deepStrictEqual(listed.rows, [{ sid: 'sid-held', updated: 1, current: true, provider: 'gitlab' }]);
    const [[sql, values]] = h.at('query');
    assert(sql.includes('JOIN nv_alpha_provider_session_ownership ownership') && sql.includes('AND ownership.released_at IS NULL'), 'only the sessions the tester still owns');
    assert.deepStrictEqual(values, [TESTER, identityKey(old), 'gitlab']);
    assert.strictEqual(h.at('query').length, 1);
  }

  finished = true;
  console.log('Account lifecycle tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
