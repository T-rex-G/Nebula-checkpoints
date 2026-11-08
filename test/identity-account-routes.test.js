'use strict';
/*
 * Identity and access's account routes over HTTP (D12), on the module's
 * registrations: sign-in with a token, the accounts listed, switched and
 * removed, signing out and who the account is; and the tester's own data in
 * the hosted alpha, the privacy notice, feedback, every provider
 * disconnected and deletion.
 *
 * What each must hold: the chain the baseline inventory recorded; GitHub
 * only, and a retired account listed and removable but never chosen; a
 * removal or sign-out that waits for the provider cleanup and names what must
 * be revoked by hand, once per step; the last GitHub account taking the
 * retired ones with it; the hosted alpha clearing the provider cookie where a
 * local session is destroyed, and showing an App connection as the tester's;
 * feedback refused, never stripped, for a field the notice does not name;
 * and a deletion that needs the exact words, lets an ended session through on
 * its sealed tester alone, and clears both cookies only once the store has
 * verified the provider cleanup.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const identity = require('../apps/api/src/modules/identity-access/index.ts');
const { APP_VERSION } = require('../apps/api/src/platform/release/version.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
const MOVED = [
  'POST /api/login', 'GET /api/accounts', 'POST /api/accounts/switch-idx', 'POST /api/accounts/remove', 'POST /api/accounts/switch',
  'GET /api/alpha/privacy', 'POST /api/alpha/feedback', 'POST /api/logout', 'POST /api/alpha/providers/disconnect-all',
  'POST /api/alpha/delete', 'GET /api/me'
];
{
  const now = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const baseline = new Map(inventory.routes.map(route => [`${route.method} ${route.path}`, route]));
  for (const key of MOVED) {
    const route = baseline.get(key);
    assert(route && route.owner === 'identity-access', `${key} is identity and access's`);
    const entry = now.get(key);
    assert(entry, `${key} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${key} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/modules/identity-access/http/'), `${key} is registered by identity and access (${entry.at})`);
  }
}

/* ---- A server with the module's registrations and scripted server functions ---- */
const TOKEN = { provider: 'github', login: 'alice', avatar: 'a.png', token: 't1', authMethod: 'token' };
const OAUTH = { provider: 'github', login: 'bob', avatar: 'b.png', token: 't2', authMethod: 'oauth' };
const APP = { provider: 'github', login: 'acme', avatar: 'c.png', authMethod: 'github-app', installationId: '42', repositorySelection: 'all', authorizedByLogin: 'carol' };
const RETIRED = { provider: 'gitlab', login: 'dave', token: 't4', baseUrl: 'https://gitlab.example.com/api/v4' };
const TESTER = '0f9e8d7c-6b5a-4c3d-8e2f-1a2b3c4d5e6f';
const OTHER_TESTER = '11111111-2222-4333-8444-555555555555';
const GUIDE = { label: 'Revoke on GitLab', url: 'https://gitlab.example.com/-/profile/applications' };
const done = (results = []) => ({ complete: true, supportedComplete: true, results, manualCleanup: [] });

async function start({ alpha = false } = {}) {
  const calls = [];
  const state = {
    session: { accounts: [TOKEN], active: 0 }, refuse: false, alpha: { testerId: TESTER }, reread: null,
    cleanups: [], user: { login: 'alice', name: 'Alice', avatar_url: 'a.png' }, recorded: { recorded: true, createdAt: 'now' },
    deletion: { status: 'recorded' }, purge: { status: 'complete', providerCleanupVerified: true, removedRows: 3 }
  };
  const isGithubAccount = account => !!account && (account.provider || 'github') === 'github' && !account.baseUrl;
  const config = { enabled: alpha, mode: alpha ? 'invite' : 'off', termsVersion: '2026-07-30' };
  const accountAuth = (req, res, next) => {
    calls.push(['accountAuth']);
    if (state.refuse) return res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
    req.session = structuredClone(state.session);
    req.sessionAccount = req.session.accounts[Math.min(Number(req.session.active) || 0, req.session.accounts.length - 1)];
    req.gh = { ...req.sessionAccount };
    return next();
  };
  const fail = (res, error) => res.status(error.status || 500).json({ error: error.message, code: error.code });
  const deps = {
    accountAuth, config, fail, isGithubAccount,
    providerIdentity: async acct => { calls.push(['providerIdentity', acct]); if (state.user instanceof Error) throw state.user; return state.user; },
    addAccount: async (req, res, ...args) => { calls.push(['addAccount', ...args]); },
    signedOutWithoutGithub: (req, res) => {
      if (req.session.accounts.some(isGithubAccount)) return false;
      res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
      return true;
    },
    retainedActor: () => 'tester-7',
    githubAppConnectionView: (account, active) => ({ connectionKey: `key-${account.login}`, active }),
    clearStepUpAuthorization: session => { calls.push(['clearStepUp']); session.stepUp = null; },
    setSession: async (req, res, session) => { calls.push(['setSession', structuredClone(session)]); },
    sessionOf: async () => { calls.push(['sessionOf']); return structuredClone(state.reread); },
    destroySession: async () => { calls.push(['destroySession']); },
    /* As the server's helper does, a completed disconnect leaves the request a new session without those accounts, its selection at the first. */
    disconnectProviderAccounts: async (req, accounts) => {
      const gone = new Set([accounts].flat().map(account => account.login));
      calls.push(['disconnect', [...gone]]);
      calls.push(['heldWhenAsked', req.session.accounts.map(account => account.login)]);
      const cleanup = state.cleanups.shift() || done();
      if (cleanup.supportedComplete) req.session = { ...req.session, accounts: req.session.accounts.filter(account => !gone.has(account.login)), active: 0 };
      return cleanup;
    },
    clearProviderSessionCookie: (req, res) => { calls.push(['clearProviderCookie']); res.setHeader('Set-Cookie', 'nv_session=; Max-Age=0'); },
    gh: async (account, apiPath) => { calls.push(['gh', account.login, apiPath]); return state.user; },
    providerCapabilities: account => ({ contents: account.authMethod === 'oauth' ? 'write' : 'read' }),
    offlineCacheScope: () => 'scope-1', releaseVersion: APP_VERSION
  };
  const privacyStore = {
    recordFeedback: async input => { calls.push(['recordFeedback', input]); if (state.recorded instanceof Error) throw state.recorded; return state.recorded; },
    createDeletionRequest: async input => { calls.push(['createDeletionRequest', input]); return state.deletion; },
    purgeTester: async input => { calls.push(['purgeTester', input]); return state.purge; }
  };
  const sessions = identity.createAlphaSessions({ config, store: null, seal: String, unseal: () => null, getCookie: () => null, sessionIdKey: Symbol('sid'), production: () => false });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (alpha) req.alpha = state.alpha;
    /* Bodies no JSON request can carry, as code before the route might leave them. */
    if (req.get('x-body') === 'bare') req.body = Object.assign(Object.create(null), { feature: 'upload' });
    if (req.get('x-body') === 'none') req.body = undefined;
    if (req.get('x-body') === 'null') req.body = null;
    next();
  });
  identity.registerAccountRoutes(app, deps);
  identity.registerAlphaPrivacyRoutes(app, { config, privacyStore: alpha ? privacyStore : null, releaseVersion: APP_VERSION });
  identity.registerSignOutRoute(app, deps);
  identity.registerAlphaDisconnectRoutes(app, { ...deps, privacyStore: alpha ? privacyStore : null, sessions });
  identity.registerMeRoute(app, deps);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const send = async (method, url, body, shape) => {
    calls.length = 0;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'content-type': 'application/json', ...(shape ? { 'x-body': shape } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body)
    });
    return { status: response.status, cache: response.headers.get('cache-control'), cookies: response.headers.getSetCookie(), body: await response.json() };
  };
  return { state, calls, send, close: () => new Promise(resolve => server.close(resolve)) };
}
const called = (calls, name) => calls.filter(call => call[0] === name);

(async () => {
  /* ---- Locally: the accounts in a session the server destroys ---- */
  const t = await start();
  {
    for (const [body, code] of [[{ token: 'x', provider: 'gitlab' }, 'PROVIDER_UNSUPPORTED'], [{ token: 'x', baseUrl: 'https://ghe.example' }, 'PROVIDER_AUTHORITY_UNSUPPORTED']]) {
      const refused = await t.send('POST', '/api/login', body);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, code);
    }
    assert.deepEqual((await t.send('POST', '/api/login', { token: '   ' })).body, { error: 'Token required' });
    const signedIn = await t.send('POST', '/api/login', { token: ' ghp_abc ', provider: 'github' });
    assert.deepEqual(signedIn.body, { login: 'alice', name: 'Alice', avatar: 'a.png', provider: 'github', authMethod: 'token' });
    assert.deepEqual(t.calls, [['providerIdentity', { provider: 'github', token: 'ghp_abc' }], ['addAccount', 'ghp_abc', t.state.user, 'github', '', { authMethod: 'token' }]]);
    t.state.user = Object.assign(new Error('Bad credentials'), { status: 401, code: 'PROVIDER_AUTH_FAILED' });
    assert.deepEqual((await t.send('POST', '/api/login', { token: 'bad' })).body, { error: 'Invalid token for that provider.' });
    t.state.user = Object.assign(new Error('Alpha access is required'), { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
    assert.equal((await t.send('POST', '/api/login', { token: 'x' })).body.code, 'ALPHA_ACCESS_REQUIRED', 'an alpha refusal is not a bad token');
    t.state.user = { login: 'alice', name: 'Alice', avatar_url: 'a.png' };
  }
  {
    t.state.session = { accounts: [TOKEN, APP, RETIRED], active: 9 };
    const listed = await t.send('GET', '/api/accounts');
    assert.equal(listed.body.active, 2, 'the selection is clamped to the list');
    assert.deepEqual(listed.body.accounts, [
      { login: 'alice', avatar: 'a.png', provider: 'github', retired: false, authMethod: 'token', host: null },
      { login: 'acme', avatar: 'c.png', provider: 'github', retired: false, authMethod: 'github-app', host: null, installationId: 42, repositorySelection: 'all', authorizedByLogin: 'carol', status: 'connected' },
      { login: 'dave', provider: 'gitlab', retired: true, authMethod: 'token', host: 'gitlab.example.com' }
    ]);
    t.state.session = { accounts: [RETIRED], active: 0 };
    assert.equal((await t.send('GET', '/api/accounts')).status, 401, 'no GitHub account left is signed out');
  }
  {
    t.state.session = { accounts: [TOKEN, RETIRED, OAUTH], active: 0, stepUp: { until: 1 } };
    for (const idx of [-1, 3, 'x', {}]) assert.deepEqual((await t.send('POST', '/api/accounts/switch-idx', { idx })).body, { error: 'Bad index' });
    assert.equal((await t.send('POST', '/api/accounts/switch-idx', { idx: 1 })).body.code, 'PROVIDER_UNSUPPORTED');
    assert.deepEqual(t.calls.filter(call => call[0] !== 'accountAuth'), [], 'a retired account is never chosen');
    assert.deepEqual((await t.send('POST', '/api/accounts/switch-idx', { idx: 2 })).body, { ok: true, login: 'bob' });
    assert.deepEqual(t.calls.slice(1), [['clearStepUp'], ['setSession', { accounts: [TOKEN, RETIRED, OAUTH], active: 2, stepUp: null }]]);
    assert.equal((await t.send('POST', '/api/accounts/switch', { login: 'nobody' })).status, 404);
    assert.equal((await t.send('POST', '/api/accounts/switch', { login: 'dave' })).status, 409);
    assert.deepEqual((await t.send('POST', '/api/accounts/switch', { login: 'bob' })).body, { ok: true, login: 'bob' });
    assert.deepEqual(called(t.calls, 'clearStepUp'), [['clearStepUp']], 'switching clears the step-up');
  }
  {
    t.state.session = { accounts: [TOKEN, RETIRED, OAUTH], active: 0 };
    t.state.cleanups = [{ complete: false, supportedComplete: false, results: [{ reasonCode: 'PENDING' }], manualCleanup: [] }];
    const pending = await t.send('POST', '/api/accounts/remove', { idx: 0 });
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.body, { ok: false, status: 'pending', results: [{ reasonCode: 'PENDING' }] });
    assert.deepEqual(called(t.calls, 'setSession'), [], 'nothing is written while the cleanup is pending');
    assert.deepEqual(called(t.calls, 'heldWhenAsked'), [['heldWhenAsked', ['alice', 'dave', 'bob']]], 'the cleanup is asked while the session still holds the account');
    t.state.cleanups = [done()];
    const removed = await t.send('POST', '/api/accounts/remove', { idx: 0 });
    assert.deepEqual(removed.body, { ok: true, removed: 'alice', active: 'bob' }, 'the selected account left: a GitHub account is chosen');
    t.state.session = { accounts: [RETIRED, TOKEN, OAUTH], active: 1 };
    t.state.cleanups = [{ ...done(), manualCleanup: [GUIDE, GUIDE, { label: 'Remove the token' }, { label: '' }] }];
    const reselected = await t.send('POST', '/api/accounts/remove', { idx: 1 });
    assert.deepEqual(called(t.calls, 'heldWhenAsked'), [['heldWhenAsked', ['dave', 'alice', 'bob']]], 'and the selection it decides from');
    assert.equal(reselected.body.active, 'bob', 'the selection moves past the retired account');
    assert.deepEqual(reselected.body.revocationGuidance, [{ label: GUIDE.label, url: GUIDE.url, automatic: false }, { label: 'Remove the token', url: null, automatic: false }]);
    assert.deepEqual(called(t.calls, 'setSession')[0][1].active, 1, 'a GitHub account is selected, never a retired one');
    t.state.session = { accounts: [TOKEN, RETIRED], active: 0 };
    t.state.cleanups = [done(), { ...done(), manualCleanup: [GUIDE] }];
    const last = await t.send('POST', '/api/accounts/remove', { idx: 0 });
    assert.deepEqual(last.body, { ok: true, removed: 'alice', empty: true, revocationGuidance: [{ label: GUIDE.label, url: GUIDE.url, automatic: false }] });
    assert.deepEqual(called(t.calls, 'disconnect'), [['disconnect', ['alice']], ['disconnect', ['dave']]], 'the last GitHub account takes the retired ones with it');
    assert.deepEqual(called(t.calls, 'destroySession'), [['destroySession']]);
  }
  {
    t.state.session = { accounts: [TOKEN, RETIRED], active: 0 };
    t.state.cleanups = [{ ...done(), manualCleanup: [GUIDE, GUIDE] }];
    const out = await t.send('POST', '/api/logout');
    assert.deepEqual(out.body, { ok: true, revocationGuidance: [{ label: GUIDE.label, url: GUIDE.url, automatic: false }] });
    assert.deepEqual(called(t.calls, 'disconnect'), [['disconnect', ['alice', 'dave']]], 'signing out disconnects retired accounts too');
    assert.deepEqual(called(t.calls, 'destroySession'), [['destroySession']]);
    t.state.cleanups = [{ complete: false, supportedComplete: false, results: [], manualCleanup: [] }];
    assert.equal((await t.send('POST', '/api/logout')).status, 202);
  }
  {
    t.state.session = { accounts: [RETIRED, TOKEN], active: 0 };
    assert.equal((await t.send('GET', '/api/me')).body.code, 'ACCOUNT_SELECTION_REQUIRED');
    t.state.session = { accounts: [TOKEN], active: 0 };
    const me = await t.send('GET', '/api/me');
    assert.equal(me.cache, 'no-store');
    assert.deepEqual(me.body, { login: 'alice', name: 'Alice', avatar: 'a.png', provider: 'github', authMethod: 'token', caps: { contents: 'read' }, offlineCacheScope: 'scope-1', release: APP_VERSION });
    t.state.session = { accounts: [APP], active: 0 };
    assert.deepEqual((await t.send('GET', '/api/me')).body, {
      login: 'acme', name: 'acme', avatar: 'c.png', installationId: 42, authorizedByLogin: 'carol', repositorySelection: 'all',
      provider: 'github', authMethod: 'github-app', caps: { contents: 'read' }, offlineCacheScope: 'scope-1', release: APP_VERSION
    });
    assert.deepEqual(called(t.calls, 'gh'), [], 'an App connection is described from the session, not asked of GitHub');
  }
  {
    for (const [method, url] of [['GET', '/api/alpha/privacy'], ['POST', '/api/alpha/feedback'], ['POST', '/api/alpha/providers/disconnect-all']]) {
      assert.deepEqual((await t.send(method, url, {})).body, { error: 'Not found' }, `${url} is the alpha's only`);
    }
    t.state.session = { accounts: [TOKEN], active: 0 };
    const deletion = await t.send('POST', '/api/alpha/delete', {});
    assert.equal(deletion.status, 404, 'with the alpha off, deletion needs no confirmation and is not there');
  }
  await t.close();

  /* ---- In the hosted alpha: the store owns the session ---- */
  const a = await start({ alpha: true });
  {
    a.state.session = { accounts: [TOKEN, APP], active: 1 };
    const listed = await a.send('GET', '/api/accounts');
    assert.deepEqual(listed.body.accounts[1], { login: 'tester-7', avatar: '', provider: 'github', authMethod: 'github-app', connectionKey: 'key-acme', active: true });
    a.state.session = { accounts: [APP], active: 0 };
    assert.deepEqual((await a.send('GET', '/api/me')).body, {
      login: 'tester-7', name: 'tester-7', avatar: '', connectionKey: 'key-acme', active: true,
      provider: 'github', authMethod: 'github-app', caps: { contents: 'read' }, offlineCacheScope: 'scope-1', release: APP_VERSION
    });
    a.state.session = { accounts: [TOKEN, OAUTH], active: 1 };
    a.state.reread = { accounts: [OAUTH, APP], active: '1' };
    assert.deepEqual((await a.send('POST', '/api/accounts/remove', { idx: 0 })).body, { ok: true, removed: 'alice', active: 1 }, 'the store is read again for the selection');
    assert.deepEqual(called(a.calls, 'setSession'), [], 'the store wrote the session; the route does not');
    a.state.reread = { accounts: [RETIRED] };
    a.state.cleanups = [done(), done()];
    assert.equal((await a.send('POST', '/api/accounts/remove', { idx: 1 })).body.empty, true);
    assert.deepEqual(called(a.calls, 'disconnect'), [['disconnect', ['bob']], ['disconnect', ['dave']]]);
    assert.deepEqual([called(a.calls, 'clearProviderCookie').length, called(a.calls, 'destroySession').length], [1, 0]);
    await a.send('POST', '/api/logout');
    assert.deepEqual([called(a.calls, 'clearProviderCookie').length, called(a.calls, 'destroySession').length], [1, 0], 'signing out clears the cookie');
  }
  {
    const privacy = await a.send('GET', '/api/alpha/privacy');
    assert.equal(privacy.cache, 'no-store');
    assert.deepEqual(privacy.body, {
      termsVersion: '2026-07-30', retention: identity.alphaRetentionPolicy(), retainedIntegrityMetadata: true, sourceContentUsedForAnalytics: false
    }, 'the notice: the alpha\'s terms and retention, integrity metadata kept, source content never analysed');
    for (const body of [{ feature: 'upload', description: 'my repository' }, { feature: 'upload', testerId: OTHER_TESTER }, [], [{ feature: 'upload' }]]) {
      const refused = await a.send('POST', '/api/alpha/feedback', body);
      assert.deepEqual([refused.status, refused.body.code], [400, 'ALPHA_FEEDBACK_FIELDS_REJECTED'], `${JSON.stringify(body)} is refused, never stripped`);
    }
    for (const shape of ['bare', 'none', 'null']) {
      const refused = await a.send('POST', '/api/alpha/feedback', {}, shape);
      assert.deepEqual([refused.status, refused.body.code], [400, 'ALPHA_FEEDBACK_FIELDS_REJECTED'], `a ${shape} body is refused`);
    }
    assert.deepEqual(called(a.calls, 'recordFeedback'), []);
    const sent = await a.send('POST', '/api/alpha/feedback', { feature: 'upload', correlationId: 'nvx-0123456789abcdef', provider: 'github', errorCode: 'UPLOAD_FAILED' });
    assert.deepEqual([sent.status, sent.body], [201, { ok: true, createdAt: 'now' }]);
    const [[, recorded]] = called(a.calls, 'recordFeedback');
    assert.equal(recorded.testerId, TESTER);
    assert(Math.abs(Date.parse(recorded.occurredAt) - Date.now()) < 60_000, 'feedback is dated when it is sent');
    assert.equal(recorded.releaseVersion, APP_VERSION);
    assert.equal(recorded.correlationId, 'nvx-0123456789abcdef');
    assert(!('description' in recorded));
    const long = `ref ${'x'.repeat(120)}`;
    await a.send('POST', '/api/alpha/feedback', { feature: 'upload', correlationId: long });
    const cleaned = identity.sanitizeFeedback({ feature: 'upload' }, { releaseVersion: APP_VERSION, correlationId: long, timestamp: new Date() }).correlationId;
    assert.notEqual(cleaned, long);
    assert.equal(called(a.calls, 'recordFeedback')[0][1].correlationId, cleaned, 'feedback is recorded as sanitized, not as sent');
    a.state.recorded = { recorded: 'yes', createdAt: 'now' };
    assert.equal((await a.send('POST', '/api/alpha/feedback', { feature: 'upload' })).body.ok, false, 'only a store that says it recorded the feedback is believed');
    for (const [error, status, code] of [
      [Object.assign(new Error('x'), { code: 'ALPHA_TESTER_DELETING' }), 409, 'ALPHA_FEEDBACK_UNAVAILABLE'],
      [new TypeError('bad'), 400, 'ALPHA_FEEDBACK_INVALID'],
      [new Error('connection reset'), 500, undefined]
    ]) {
      a.state.recorded = error;
      const failed = await a.send('POST', '/api/alpha/feedback', { feature: 'upload' });
      assert.deepEqual([failed.status, failed.body.code], [status, code]);
    }
  }
  {
    a.state.session = { accounts: [TOKEN, RETIRED], active: 0 };
    a.state.cleanups = [{ complete: false, supportedComplete: false, results: [{ reasonCode: 'PENDING' }], manualCleanup: [] }];
    const waiting = await a.send('POST', '/api/alpha/providers/disconnect-all');
    assert.deepEqual([waiting.status, waiting.body, waiting.cookies], [202, { ok: false, status: 'pending', results: [{ reasonCode: 'PENDING' }] }, []],
      'disconnecting every provider keeps the session until each is disconnected');
    a.state.cleanups = [done([{ revocationGuidance: { label: 'Signed out', url: null, automatic: true } }, { revocationGuidance: GUIDE }])];
    const all = await a.send('POST', '/api/alpha/providers/disconnect-all');
    assert.deepEqual(all.body, { ok: true, revocationGuidance: [{ label: 'Signed out', url: null, automatic: true }, GUIDE] });
    assert.deepEqual(all.cookies, ['nv_session=; Max-Age=0']);
    assert.equal(all.cache, 'no-store');
  }
  {
    assert.deepEqual((await a.send('POST', '/api/alpha/delete', { confirm: 'delete alpha data' })).body.code, 'ALPHA_DELETION_CONFIRMATION_REQUIRED');
    assert.deepEqual(a.calls, [], 'an unconfirmed deletion reaches nothing');
    const confirm = { confirm: 'DELETE ALPHA DATA' };
    a.state.cleanups = [{ complete: false, supportedComplete: true, results: [{ reasonCode: 'PROVIDER_RETIRED_MANUAL_CLEANUP_REQUIRED' }], manualCleanup: [GUIDE] }];
    assert.equal((await a.send('POST', '/api/alpha/delete', confirm)).status, 202, 'deletion waits for every provider, retired ones included');
    a.state.deletion = { status: 'blocked', cleanupBlocks: [{ code: 'PROVIDER_HOOK_PENDING', count: 5000, cleanupId: 'cleanup-1' }, { code: 'bad code', count: 1 }, null, ...Array.from({ length: 30 }, (_, i) => ({ code: `BLOCK_${i}`, count: -i }))] };
    const blocked = await a.send('POST', '/api/alpha/delete', confirm);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'ALPHA_DELETION_BLOCKED');
    assert.equal(blocked.body.cleanupBlocks.length, 20);
    assert.deepEqual(blocked.body.cleanupBlocks.slice(0, 2), [{ code: 'PROVIDER_HOOK_PENDING', count: 1000 }, { code: 'BLOCK_0', count: 0 }], 'each block by its code and count, never its cleanup');
    assert.deepEqual(called(a.calls, 'purgeTester'), [], 'a blocked request is not purged');
    a.state.deletion = { status: 'recorded' };
    a.state.purge = { status: 'complete', providerCleanupVerified: false };
    assert.equal((await a.send('POST', '/api/alpha/delete', confirm)).status, 409, 'an unverified provider cleanup blocks the deletion');
    a.state.purge = { status: 'complete', providerCleanupVerified: true, removedRows: 3 };
    const deleted = await a.send('POST', '/api/alpha/delete', { ...confirm, testerId: OTHER_TESTER });
    assert.deepEqual(deleted.body, { ok: true, status: 'complete', providerCleanupVerified: true, removedRows: 3 });
    assert.deepEqual(deleted.cookies, ['nv_session=; Max-Age=0', 'nv_alpha_access=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
    assert.deepEqual(called(a.calls, 'createDeletionRequest'), [['createDeletionRequest', { testerId: TESTER }]], 'the session\'s tester is deleted, whatever the body names');
    assert.deepEqual(called(a.calls, 'purgeTester'), [['purgeTester', { testerId: TESTER }]], 'and purged');
    /* An ended session: the boundary admitted the sealed tester alone, and deletion goes on without the account guard. */
    a.state.alpha = Object.freeze({ testerId: TESTER, deletionRecovery: true });
    a.state.refuse = true;
    const recovered = await a.send('POST', '/api/alpha/delete', confirm);
    assert.equal(recovered.status, 200);
    assert.deepEqual(a.calls.map(call => call[0]), ['purgeTester', 'clearProviderCookie'], 'recovery goes straight to the purge');
    a.state.alpha = { testerId: TESTER, deletionRecovery: 'true' };
    assert.equal((await a.send('POST', '/api/alpha/delete', confirm)).status, 401, 'only a recovery the boundary made skips the account guard');
  }
  await a.close();
  console.log('identity account route tests passed');
})().catch(error => { console.error(error); process.exit(1); });
