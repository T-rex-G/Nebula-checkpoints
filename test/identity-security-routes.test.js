'use strict';
/*
 * Identity and access's GitHub App, security and OAuth routes over HTTP
 * (D12), on the module's registrations: an App connection made, refreshed
 * and disconnected; the scanner's state, the CSRF token and a step-up grant;
 * OAuth sign-in; and the sessions an identity holds elsewhere.
 *
 * What each must hold: the chain the baseline inventory recorded; the App's
 * two states signed for their purpose, bound to the session and identity,
 * spent once and refused for another nonce, user or installation owner; an
 * App connection that holds no token and is addressed by its hashed key in
 * the hosted alpha; a step-up that asks for proof made now and binds its
 * grant to one action and scope; an OAuth exchange that refuses redirects,
 * reads the provider's answer defensively and clears its state cookie on
 * every failure; and ending only the other sessions, their streams with
 * them.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const identity = require('../apps/api/src/modules/identity-access/index.ts');
const { GithubAppError, createGithubAppState, verifyGithubAppState } = require('../apps/api/src/modules/github-provider/index.ts');
const { verifyCsrfToken, scopeHash } = require('../apps/api/src/platform/authorization/security-foundation.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
const MOVED = [
  'POST /api/github-app/connect', 'GET /api/github-app/oauth/callback', 'GET /api/github-app/setup', 'GET /api/github-app/status',
  'POST /api/github-app/refresh', 'POST /api/github-app/disconnect', 'GET /api/security/scanner-status', 'GET /api/security/csrf',
  'POST /api/security/step-up', 'GET /api/oauth/login', 'GET /api/oauth/callback', 'GET /api/security/sessions', 'POST /api/security/revoke-others'
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
  const fromServer = [...now.values()].filter(entry => entry.at.startsWith('server.js:'));
  assert.deepEqual(fromServer, [], 'server.js registers no route itself');
}

/* ---- A server with the module's registrations, a scripted broker and the real states and grants ---- */
const SECRET = Buffer.alloc(32, 7);
const NONCE = 'b'.repeat(48);
const keyOf = account => (/^[0-9a-f]{64}$/.test(String(account && account.identityKey || '')) ? account.identityKey : crypto.createHash('sha256').update(`id:${account && account.login}`).digest('hex'));
const TOKEN = { provider: 'github', login: 'alice', token: 't1', authMethod: 'token' };
const OAUTH = { provider: 'github', login: 'bob', token: 't2', authMethod: 'oauth' };
const APP = { provider: 'github', login: 'acme', authMethod: 'github-app', installationId: '42', identityKey: 'c'.repeat(64), authorizedById: 1, authorizedByLogin: 'alice', authorizedByIdentityKey: keyOf(TOKEN) };
const APP_TWO = { ...APP, login: 'beta', installationId: 7, identityKey: 'd'.repeat(64) };
const INSTALLATION = { id: 42, account: { id: 70, login: 'acme', avatarUrl: 'c.png', type: 'Organization' }, repositorySelection: 'selected', permissions: { contents: 'write' }, htmlUrl: 'https://github.com/x/42' };

async function start({ alpha = false, database = false, app = true, brokered = app, oauth = true, production = false, webhooks = true } = {}) {
  const calls = [];
  const state = {
    session: { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE } }, refuse: false, user: { id: 1, login: 'alice' },
    exchange: { token: 'ghu_user', expiresIn: 28800 }, authorizedUser: { id: 1, login: 'alice' }, visible: { account: { id: 70, login: 'ACME' } },
    installation: INSTALLATION, claim: true, addedKey: 'e'.repeat(64), cleanups: [], reread: null,
    fetch: () => new Response('{"access_token":"gho_user"}'), inventory: { available: false }, alphaOperation: null
  };
  const answer = value => { if (value instanceof Error) throw value; return structuredClone(value); };
  const sessionSecurityState = session => {
    if (!session.security || typeof session.security !== 'object') session.security = {};
    return session.security;
  };
  const guard = name => (req, res, next) => {
    calls.push([name]);
    if (state.refuse) return res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
    req.session = structuredClone(state.session);
    req.sessionAccount = req.session.accounts[Math.min(Number(req.session.active) || 0, req.session.accounts.length - 1)];
    req.gh = { ...req.sessionAccount };
    if (state.alphaOperation) req.alphaStepUpOperation = state.alphaOperation;
    return next();
  };
  const setSession = async (req, res, session) => { calls.push(['setSession', structuredClone(session)]); };
  const broker = brokered ? {
    authorizationUrl: s => `https://github.com/login/oauth/authorize?state=${s}`,
    exchangeUserCode: async code => { calls.push(['exchange', code]); return answer(state.exchange); },
    getAuthorizedUser: async token => { calls.push(['authorizedUser', token]); return answer(state.authorizedUser); },
    installationUrl: s => `https://github.com/apps/nebula/installations/new?state=${s}`,
    findUserInstallation: async (token, id) => { calls.push(['findUserInstallation', token, id]); return answer(state.visible); },
    getInstallation: async id => { calls.push(['getInstallation', id]); return answer(state.installation); },
    invalidate: id => { calls.push(['invalidate', id]); }
  } : null;
  const common = {
    auth: guard('auth'), accountAuth: guard('accountAuth'), fail: (res, error) => res.status(error.status || 500).json({ error: error.message, code: error.code }),
    config: { enabled: alpha }, identityKey: keyOf, providerIdentity: async acct => { calls.push(['providerIdentity', acct.token]); return answer(state.user); },
    requestSecurityContext: req => {
      const sessionBinding = String(sessionSecurityState(req.session || {}).sessionNonce || '');
      if (!sessionBinding || !req.gh) throw Object.assign(new Error('Security context is unavailable for this session'), { status: 401, code: 'SECURITY_CONTEXT_REQUIRED' });
      return { sessionBinding, identityKey: keyOf(req.gh) };
    },
    sessionSecurityState, setSession
  };
  const expressApp = express();
  expressApp.use(express.json());
  const connectionView = identity.createGithubAppConnectionView({ config: common.config, identityKey: keyOf });
  identity.registerGithubAppRoutes(expressApp, {
    ...common, githubApp: { enabled: app, webhookConfigured: webhooks }, broker: () => broker,
    client: { AppError: GithubAppError, createState: createGithubAppState, verifyState: verifyGithubAppState },
    stateSecret: SECRET, replayKey: Buffer.alloc(32, 9), databaseConfigured: () => database,
    durableSingleUseStore: () => ({ consumeOnce: async claim => { calls.push(['consumeOnce', claim.kind]); if (state.claim instanceof Error) throw state.claim; return state.claim; } }),
    connectionView,
    /* As the server's does: a session without its binding is given one, and written. */
    ensureSessionSecurity: async (req, res) => {
      const security = sessionSecurityState(req.session);
      if (/^[0-9a-f]{48}$/i.test(String(security.sessionNonce || ''))) return security;
      security.sessionNonce = 'a'.repeat(48);
      await setSession(req, res, req.session);
      return security;
    },
    sessionOf: async () => structuredClone(state.reread || state.session), destroySession: async () => { calls.push(['destroySession']); },
    addAccount: async (req, res, token, user, providerName, baseUrl, options) => {
      calls.push(['addAccount', token, user, options]);
      if (options.account) req.session.accounts.push({ login: user.login, authMethod: 'github-app', ...options.account, identityKey: state.addedKey });
    },
    clearStepUpAuthorization: session => { calls.push(['clearStepUp']); sessionSecurityState(session).stepUp = null; },
    disconnectProviderAccounts: async (req, account) => {
      calls.push(['disconnect', account.login]);
      const cleanup = state.cleanups.shift() || { complete: true, supportedComplete: true, results: [], manualCleanup: [] };
      if (cleanup.complete) req.session = { ...req.session, accounts: req.session.accounts.filter(item => item.login !== account.login), active: 0 };
      return cleanup;
    },
    clearProviderSessionCookie: (req, res) => { calls.push(['clearProviderCookie']); res.setHeader('Set-Cookie', 'nv_session=; Max-Age=0'); },
    persistGithubAppInstallation: async (identityValue, installation, user, status) => { calls.push(['persist', identityValue, status]); },
    recordGithubAppAudit: async (identityValue, eventType, installationId, details) => { calls.push(['audit', eventType, details.status, details.reasonCode]); },
    retainedActor: () => 'tester-7'
  });
  identity.registerSecurityRoutes(expressApp, {
    ...common, providerSessionAccess: guard('providerSessionAccess'), capabilityAccess: () => (req, res, next) => next(),
    alphaStepUpRepositoryAccess: (req, res, next) => next(), scannerStatus: () => ({ yara: { configured: false }, signatures: 12 }),
    csrf: { secret: Buffer.alloc(32, 11), ttlMs: 7200000 }, stepUp: { secret: Buffer.alloc(32, 13), ttlMs: 300000 },
    getInstallation: id => broker.getInstallation(id)
  });
  identity.registerOAuthRoutes(expressApp, {
    oauth: { clientId: oauth ? 'oauth-client' : '', clientSecret: 'oauth-secret' }, production: () => production,
    getCookie: (req, name) => (String(req.headers.cookie || '').match(new RegExp(`${name}=([^;]+)`)) || [])[1] || null,
    fetch: async (url, init) => { calls.push(['fetch', url, init.redirect, JSON.parse(init.body)]); return state.fetch(); },
    gh: async (token, apiPath) => { calls.push(['gh', token, apiPath]); return { login: 'alice' }; },
    addAccount: async (req, res, token, user, providerName, baseUrl, options) => { calls.push(['addAccount', token, options]); }
  });
  identity.registerSessionContainmentRoutes(expressApp, {
    auth: common.auth, fail: common.fail, sessionsForIdentity: async () => structuredClone(state.inventory),
    revokeContainedSessions: async (req, ids) => { calls.push(['revoke', ids]); return ids; },
    closeLiveSessions: (ids, reason) => { calls.push(['closeLive', ids, reason]); return ids.length; }
  });
  const server = await new Promise(resolve => { const s = expressApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const send = async (method, url, { body, cookie } = {}) => {
    calls.length = 0;
    const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), cache: response.headers.get('cache-control'), cookies: response.headers.getSetCookie(), body: /^[[{]/.test(text) ? JSON.parse(text) : text };
  };
  const signed = (purpose, nonce, options = {}) => createGithubAppState(SECRET, { sessionBinding: options.binding || NONCE, identityKey: options.identityKey || keyOf(state.session.accounts[0]), purpose }, { now: options.now || Date.now(), ttlMs: 600000, nonce });
  return { state, calls, send, signed, close: () => new Promise(resolve => server.close(resolve)) };
}
const called = (calls, name) => calls.filter(call => call[0] === name);
const pendingIn = (calls, slot) => (called(calls, 'setSession').at(-1) || [, {}])[1].security.githubApp[slot];

(async () => {
  /* ---- The App switched off: none of its flow is there ---- */
  for (const options of [{ app: false }, { app: false, brokered: true }, { app: true, brokered: false }]) {
    const t = await start(options);
    for (const [method, url] of [['POST', '/api/github-app/connect'], ['GET', '/api/github-app/oauth/callback'], ['GET', '/api/github-app/setup'], ['POST', '/api/github-app/refresh']]) {
      assert.deepEqual((await t.send(method, url, { body: method === 'POST' ? {} : undefined })).body.code, 'GITHUB_APP_DISABLED', `${url} needs the App configured and its broker (${JSON.stringify(options)})`);
    }
    assert.deepEqual((await t.send('GET', '/api/github-app/status')).body, { enabled: options.app, webhookConfigured: true, connections: [] });
    await t.close();
  }

  /* ---- Connecting, locally ---- */
  const t = await start();
  {
    t.state.session = { accounts: [APP], active: 0, security: { sessionNonce: NONCE } };
    assert.equal((await t.send('POST', '/api/github-app/connect', { body: {} })).body.code, 'GITHUB_APP_USER_ACCOUNT_REQUIRED', 'an App connection cannot connect another');
    t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE } };
    for (const user of [{ id: 0, login: 'alice' }, { id: 1 }, null]) {
      t.state.user = user;
      const refused = await t.send('POST', '/api/github-app/connect', { body: {} });
      assert.deepEqual([refused.status, refused.body.code], [502, 'GITHUB_APP_USER_INVALID']);
      assert.deepEqual(called(t.calls, 'audit'), [['audit', 'authorization.rejected', undefined, 'GITHUB_APP_USER_INVALID']]);
    }
    t.state.user = { id: 1, login: 'alice' };
    const connected = await t.send('POST', '/api/github-app/connect', { body: {} });
    assert.equal(connected.cache, 'no-store');
    const state = new URL(connected.body.url).searchParams.get('state');
    const claims = verifyGithubAppState(SECRET, state, { sessionBinding: NONCE, identityKey: keyOf(TOKEN), purpose: 'user-auth' });
    const pending = pendingIn(t.calls, 'userAuth');
    assert.deepEqual(pending, { nonce: claims.nonce, expiresAt: Date.parse(new Date(claims.iat).toISOString()) + 600000, identityKey: keyOf(TOKEN), userId: 1, login: 'alice' });
    assert.throws(() => verifyGithubAppState(SECRET, state, { sessionBinding: NONCE, identityKey: keyOf(TOKEN), purpose: 'installation-claim' }), { code: 'GITHUB_APP_STATE_CONTEXT' });
  }

  /* GitHub's first return: the user authorization, spent once. */
  {
    const pending = { nonce: 'n-1', expiresAt: Date.now() + 60000, identityKey: keyOf(TOKEN), userId: 1, login: 'Alice' };
    t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE, githubApp: { userAuth: pending } } };
    t.state.exchange = { token: 'ghu_user', expiresIn: 120 };
    const first = await t.send('GET', `/api/github-app/oauth/callback?state=${t.signed('user-auth', 'n-1')}&code=c1`);
    assert.equal(first.status, 302);
    const installState = new URL(first.location).searchParams.get('state');
    const claims = verifyGithubAppState(SECRET, installState, { sessionBinding: NONCE, identityKey: keyOf(TOKEN), purpose: 'installation-claim' });
    assert.equal(claims.exp - claims.iat, 120000, 'the installation state lasts no longer than the user token');
    const saved = called(t.calls, 'setSession');
    assert.equal(saved[0][1].security.githubApp.userAuth, undefined, 'the user authorization is spent before anything else');
    assert.deepEqual(pendingIn(t.calls, 'installation'), { nonce: claims.nonce, expiresAt: claims.exp, identityKey: keyOf(TOKEN), userToken: 'ghu_user', userId: 1, login: 'alice' });
    const replay = await t.send('GET', `/api/github-app/oauth/callback?state=${t.signed('user-auth', 'n-1')}&code=c1`);
    assert.equal(replay.location, '/?githubApp=error&code=GITHUB_APP_STATE_REPLAY', 'the same state is refused the second time');
    /* A spend is the state's nonce for one identity: the same nonce for another identity is a different state. */
    t.state.session = { accounts: [OAUTH], active: 0, security: { sessionNonce: NONCE, githubApp: { userAuth: { ...pending, identityKey: keyOf(OAUTH) } } } };
    t.state.authorizedUser = { id: 1, login: 'alice' };
    const other = await t.send('GET', `/api/github-app/oauth/callback?state=${t.signed('user-auth', 'n-1', { identityKey: keyOf(OAUTH) })}&code=c1`);
    assert.match(other.location, /^https:\/\/github\.com\/apps\/nebula\/installations\/new/);
    /* A session without its binding is given one before the state is checked against it. */
    t.state.session = { accounts: [TOKEN], active: 0, security: { githubApp: { userAuth: { ...pending, nonce: 'n-9' } } } };
    const bound = await t.send('GET', `/api/github-app/oauth/callback?state=${t.signed('user-auth', 'n-9', { binding: 'a'.repeat(48) })}&code=c1`);
    assert.match(bound.location, /^https:\/\/github\.com\/apps\/nebula\/installations\/new/, 'the callback binds the session first');
    for (const [stored, query, code] of [
      [{ ...pending, nonce: 'n-2' }, t.signed('user-auth', 'n-3'), 'GITHUB_APP_STATE_REPLAY'],
      [{ ...pending, nonce: 'n-4', identityKey: 'f'.repeat(64) }, t.signed('user-auth', 'n-4'), 'GITHUB_APP_STATE_REPLAY'],
      [{ ...pending, nonce: 'n-5', expiresAt: Date.now() - 1 }, t.signed('user-auth', 'n-5'), 'GITHUB_APP_STATE_REPLAY'],
      [{ ...pending, nonce: 'n-6' }, t.signed('installation-claim', 'n-6'), 'GITHUB_APP_STATE_CONTEXT'],
      [{ ...pending, nonce: 'n-7' }, `${t.signed('user-auth', 'n-7').slice(0, -2)}xx`, 'GITHUB_APP_STATE_INVALID']
    ]) {
      t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE, githubApp: { userAuth: stored } } };
      assert.equal((await t.send('GET', `/api/github-app/oauth/callback?state=${query}&code=c1`)).location, `/?githubApp=error&code=${code}`);
    }
    t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE, githubApp: { userAuth: { ...pending, nonce: 'n-8' } } } };
    t.state.authorizedUser = { id: 2, login: 'alice' };
    assert.equal((await t.send('GET', `/api/github-app/oauth/callback?state=${t.signed('user-auth', 'n-8')}&code=c1`)).location, '/?githubApp=error&code=GITHUB_APP_USER_MISMATCH');
    t.state.authorizedUser = { id: 1, login: 'alice' };
    t.state.session = { accounts: [TOKEN], active: 0, retiredSelection: true, security: { sessionNonce: NONCE } };
    assert.equal((await t.send('GET', `/api/github-app/oauth/callback?state=x`)).location, '/?githubApp=error&code=ACCOUNT_SELECTION_REQUIRED');
  }

  /* GitHub's second return: the installation, accepted only for an owner the user can see; the account holds no token. */
  {
    const pending = { nonce: 'i-1', expiresAt: Date.now() + 60000, identityKey: keyOf(TOKEN), userToken: 'ghu_user', userId: 1, login: 'alice' };
    const begin = nonce => { t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE, githubApp: { installation: { ...pending, nonce } } } }; };
    begin('i-1');
    const connected = await t.send('GET', `/api/github-app/setup?state=${t.signed('installation-claim', 'i-1')}&installation_id=42`);
    assert.equal(connected.location, '/?githubApp=connected');
    assert.deepEqual(called(t.calls, 'findUserInstallation'), [['findUserInstallation', 'ghu_user', 42]]);
    const [[, token, user, options]] = called(t.calls, 'addAccount');
    assert.equal(token, '', 'an App account holds no token');
    assert.deepEqual(user, { login: 'acme', avatar_url: 'c.png' });
    assert.equal(options.authMethod, 'github-app');
    assert.equal(options.account.authorizedByIdentityKey, keyOf(TOKEN));
    assert.deepEqual(called(t.calls, 'persist'), [['persist', keyOf(TOKEN), 'connected']], 'locally the installation is recorded under the user who connected it');
    for (const [setup, query, code] of [
      [() => { t.state.visible = { account: { id: 99, login: 'acme' } }; }, 42, 'GITHUB_APP_INSTALLATION_OWNERSHIP'],
      [() => { t.state.visible = { account: { id: 70, login: 'other' } }; }, 42, 'GITHUB_APP_INSTALLATION_OWNERSHIP'],
      [() => {}, 'x', 'GITHUB_APP_INSTALLATION_INVALID'],
      [() => {}, 1.5, 'GITHUB_APP_INSTALLATION_INVALID'],
      [() => { t.state.addedKey = 'not-a-key'; }, 42, 'GITHUB_APP_ACCOUNT_INVALID']
    ]) {
      t.state.visible = { account: { id: 70, login: 'ACME' } };
      t.state.addedKey = 'e'.repeat(64);
      setup();
      const nonce = `i-${Math.random()}`;
      begin(nonce);
      assert.equal((await t.send('GET', `/api/github-app/setup?state=${t.signed('installation-claim', nonce)}&installation_id=${query}`)).location, `/?githubApp=error&code=${code}`);
    }
    t.state.addedKey = 'e'.repeat(64);
    t.state.visible = { account: { id: 70, login: 'ACME' } };
  }

  /* What the session holds; a refresh and a disconnect, by installation locally. */
  {
    t.state.session = { accounts: [TOKEN, APP, APP_TWO], active: 1, security: { sessionNonce: NONCE, stepUp: { jti: 'x' } } };
    const status = await t.send('GET', '/api/github-app/status');
    assert.deepEqual(status.body.connections.map(item => [item.installationId, item.active]), [[42, true], [7, false]]);
    assert.equal((await t.send('POST', '/api/github-app/refresh', { body: { installationId: 5 } })).status, 404);
    const refreshed = await t.send('POST', '/api/github-app/refresh', { body: { installationId: 42 } });
    assert.equal(refreshed.body.connection.accountLogin, 'acme');
    assert.equal(refreshed.body.connection.active, true);
    assert.deepEqual(called(t.calls, 'invalidate'), [['invalidate', 42]], 'locally the broker forgets the old credential');
    assert.equal(called(t.calls, 'setSession')[0][1].security.stepUp, null, 'a refresh clears the step-up');
    t.state.installation = new GithubAppError('suspended', 'GITHUB_APP_INSTALLATION_SUSPENDED', 403);
    const suspended = await t.send('POST', '/api/github-app/refresh', { body: { installationId: 7 } });
    assert.equal(suspended.status, 403);
    assert.deepEqual(called(t.calls, 'audit'), [['audit', 'installation.suspended', 'suspended', 'GITHUB_APP_INSTALLATION_SUSPENDED']], 'a suspended installation is marked so');
    t.state.installation = INSTALLATION;
    assert.equal((await t.send('POST', '/api/github-app/disconnect', { body: { installationId: 1.5 } })).body.code, 'GITHUB_APP_INSTALLATION_INVALID');
    t.state.cleanups = [{ complete: false, supportedComplete: true, results: [{ reasonCode: 'PENDING' }], manualCleanup: [] }];
    assert.equal((await t.send('POST', '/api/github-app/disconnect', { body: { installationId: 42 } })).status, 202);
    const kept = await t.send('POST', '/api/github-app/disconnect', { body: { installationId: 42 } });
    assert.deepEqual(kept.body, { ok: true, installationId: 42, active: 'alice' });
    t.state.session = { accounts: [APP], active: 0, security: { sessionNonce: NONCE } };
    const emptied = await t.send('POST', '/api/github-app/disconnect', { body: { installationId: 42 } });
    assert.deepEqual(emptied.body, { ok: true, empty: true, installationId: 42 });
    assert.deepEqual(called(t.calls, 'destroySession'), [['destroySession']]);
  }

  /* ---- The session's own security ---- */
  {
    t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE } };
    const scanner = await t.send('GET', '/api/security/scanner-status');
    assert.equal(scanner.cache, 'no-store');
    assert.match(scanner.body.note, /^Built-in bounded signatures are active/);
    const asked = Date.now();
    const csrf = await t.send('GET', '/api/security/csrf');
    assert.equal(csrf.cache, 'no-store');
    const lasts = Date.parse(csrf.body.expiresAt) - asked;
    assert(lasts >= 7200000 && lasts < 7205000, `the token is said to last its two hours (${lasts})`);
    verifyCsrfToken(Buffer.alloc(32, 11), csrf.body.token, { sessionBinding: NONCE, identityKey: keyOf(TOKEN) });
    const step = body => t.send('POST', '/api/security/step-up', { body });
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'someone', credential: 'fresh' })).body.code, 'STEP_UP_CONFIRMATION_REQUIRED');
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'alice' })).body.code, 'STEP_UP_CREDENTIAL_REQUIRED');
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'alice', credential: 'x'.repeat(1025) })).body.code, 'STEP_UP_CREDENTIAL_REQUIRED');
    t.state.user = Object.assign(new Error('Bad credentials'), { status: 401 });
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'alice', credential: 'stale' })).body.code, 'STEP_UP_CREDENTIAL_INVALID');
    t.state.user = { login: 'mallory' };
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'alice', credential: 'other' })).body.code, 'STEP_UP_IDENTITY_MISMATCH');
    t.state.user = { login: 'ALICE' };
    const granted = await step({ action: 'pull.merge', scope: { owner: 'acme', repo: 'demo', pullNumber: 3, method: 'squash' }, confirm: ' alice ', credential: ' fresh ' });
    assert.equal(granted.status, 200);
    assert.deepEqual(called(t.calls, 'providerIdentity'), [['providerIdentity', 'fresh']], 'the proof is the token entered now');
    assert.equal(granted.body.assurance, 'credential');
    assert.equal(Date.parse(granted.body.expiresAt) - Date.now() <= 300000, true);
    const [[, written]] = called(t.calls, 'setSession');
    assert.equal(written.security.stepUp.scopeHash, scopeHash({ provider: 'github', owner: 'acme', repo: 'demo', pullNumber: 3, method: 'squash' }));
    t.state.session = { accounts: [APP], active: 0, security: { sessionNonce: NONCE } };
    t.state.installation = { ...INSTALLATION, account: { login: 'someone-else' } };
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'acme' })).body.code, 'STEP_UP_IDENTITY_MISMATCH', 'an App connection is checked against its installation');
    t.state.installation = INSTALLATION;
    t.state.session = { accounts: [OAUTH], active: 0, security: { sessionNonce: NONCE } };
    t.state.user = { login: 'carol' };
    assert.equal((await step({ action: 'sessions.revoke-others', confirm: 'bob' })).body.code, 'STEP_UP_IDENTITY_MISMATCH', 'an OAuth session is checked against the provider now');
    t.state.user = { login: 'bob' };
    t.state.alphaOperation = { action: 'sessions.revoke-others', scope: { provider: 'github', identityKey: 'a'.repeat(64) } };
    await step({ action: 'pull.merge', confirm: 'bob' });
    assert.equal(called(t.calls, 'setSession')[0][1].security.stepUp.scopeHash, scopeHash(t.state.alphaOperation.scope), "the alpha's own operation is the one granted");
    t.state.alphaOperation = null;
  }

  /* ---- The sessions an identity holds elsewhere ---- */
  {
    t.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE } };
    assert.deepEqual((await t.send('GET', '/api/security/sessions')).body.sessions.map(item => item.current), [true]);
    t.state.inventory = { available: true, login: 'alice', rows: [{ sid: 's1', current: true, updated: 1, provider: 'github' }, { sid: 's2', current: false, updated: 2, provider: 'github' }] };
    assert.deepEqual((await t.send('GET', '/api/security/sessions')).body, { available: true, login: 'alice', sessions: [{ current: true, updated: 1, provider: 'github' }, { current: false, updated: 2, provider: 'github' }] });
    assert.deepEqual((await t.send('POST', '/api/security/revoke-others', { body: {} })).body, { error: 'Confirmation required' });
    const revoked = await t.send('POST', '/api/security/revoke-others', { body: { confirm: true } });
    assert.deepEqual(revoked.body, { available: true, login: 'alice', revoked: 1, streamsClosed: 1 });
    assert.deepEqual(t.calls.slice(1), [['revoke', ['s2']], ['closeLive', ['s2'], 'session-revoked']], 'only the other sessions end, and their streams close');
  }

  /* ---- OAuth sign-in ---- */
  {
    const login = await t.send('GET', '/api/oauth/login?permission=repository-delete');
    assert.match(login.location, /scope=repo%20delete_repo&state=[0-9a-f]{32}$/);
    assert.match(login.cookies[0], /^nv_oauth=[0-9a-f]{32}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
    assert.match((await t.send('GET', '/api/oauth/login')).location, /scope=repo&state=/);
    const back = (query, cookie = 'nv_oauth=s-1') => t.send('GET', `/api/oauth/callback?${query}`, { cookie });
    for (const [query, cookie] of [['code=c&state=s-2', undefined], ['state=s-1', undefined], ['code=c&state=s-1', 'other=1']]) {
      const refused = await back(query, cookie);
      assert.equal(refused.location, '/?oauth=state_mismatch');
      assert.match(refused.cookies.at(-1), /^nv_oauth=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/, 'every failure clears the state cookie');
    }
    for (const [fetched, reason] of [
      [() => new Response('<!DOCTYPE html><title>Rate limited</title>'), 'provider_unreadable'],
      [() => new Response('{"error":"bad_verification_code"}'), 'bad_verification_code'],
      [() => new Response('{}'), 'exchange_failed'],
      [() => { throw new Error('connect ECONNREFUSED'); }, 'unexpected']
    ]) {
      t.state.fetch = fetched;
      assert.equal((await back('code=c&state=s-1')).location, `/?oauth=${reason}`);
    }
    t.state.fetch = () => new Response('{"access_token":"gho_user"}');
    const signedIn = await back('code=c9&state=s-1');
    assert.equal(signedIn.location, '/?entered=1');
    assert.deepEqual(t.calls, [
      ['fetch', 'https://github.com/login/oauth/access_token', 'error', { client_id: 'oauth-client', client_secret: 'oauth-secret', code: 'c9' }],
      ['gh', 'gho_user', '/user'],
      ['addAccount', 'gho_user', { authMethod: 'oauth' }]
    ], 'the exchange refuses redirects, and the account is added as OAuth');
  }
  await t.close();

  /* ---- In the hosted alpha, with a database: connections by their hashed key, spends shared ---- */
  const a = await start({ alpha: true, database: true, oauth: false, production: true, webhooks: false });
  {
    assert.deepEqual((await a.send('GET', '/api/oauth/login')).body, { error: 'OAuth not configured' });
    a.state.session = { accounts: [TOKEN, APP, APP_TWO], active: 1, security: { sessionNonce: NONCE } };
    assert.equal((await a.send('GET', '/api/github-app/status')).body.webhookConfigured, false);
    assert.deepEqual((await a.send('GET', '/api/github-app/status')).body.connections.map(item => [item.connectionKey, item.active, 'installationId' in item]), [['c'.repeat(64), true, false], ['d'.repeat(64), false, false]]);
    assert.equal((await a.send('POST', '/api/github-app/refresh', { body: { installationId: 42 } })).status, 404, 'an alpha connection is not addressed by its installation');
    const refreshed = await a.send('POST', '/api/github-app/refresh', { body: { connectionKey: 'c'.repeat(64) } });
    assert.equal(refreshed.body.connection.connectionKey, 'c'.repeat(64));
    assert.equal(refreshed.body.connection.active, true);
    const other = await a.send('POST', '/api/github-app/refresh', { body: { connectionKey: 'd'.repeat(64) } });
    assert.equal(other.body.connection.active, false, 'a refreshed connection is active only when it is the selected one');
    assert.deepEqual(called(a.calls, 'invalidate'), [], 'the shared broker is not invalidated from one tester');
    assert.equal((await a.send('POST', '/api/github-app/disconnect', { body: { connectionKey: 'nope' } })).body.code, 'GITHUB_APP_CONNECTION_INVALID');
    a.state.reread = { accounts: [TOKEN, APP_TWO], active: '1' };
    assert.deepEqual((await a.send('POST', '/api/github-app/disconnect', { body: { connectionKey: 'c'.repeat(64) } })).body, { ok: true, active: 1 });
    a.state.reread = null;
    a.state.session = { accounts: [APP], active: 0, security: { sessionNonce: NONCE } };
    const last = await a.send('POST', '/api/github-app/disconnect', { body: { connectionKey: 'c'.repeat(64) } });
    assert.deepEqual(last.body, { ok: true, empty: true });
    assert.deepEqual(last.cookies, ['nv_session=; Max-Age=0']);
    /* The installation is recorded under the connection's own identity in the alpha; a spend the database refuses or cannot make is told apart. */
    const pending = { nonce: 'a-1', expiresAt: Date.now() + 60000, identityKey: keyOf(TOKEN), userToken: 'ghu_user', userId: 1, login: 'alice' };
    const begin = nonce => { a.state.session = { accounts: [TOKEN], active: 0, security: { sessionNonce: NONCE, githubApp: { installation: { ...pending, nonce } } } }; };
    begin('a-1');
    assert.equal((await a.send('GET', `/api/github-app/setup?state=${a.signed('installation-claim', 'a-1')}&installation_id=42`)).location, '/?githubApp=connected');
    assert.deepEqual(called(a.calls, 'consumeOnce'), [['consumeOnce', 'github-app-state']], 'with a database the spend is shared');
    assert.deepEqual(called(a.calls, 'persist'), [['persist', 'e'.repeat(64), 'connected']]);
    a.state.claim = false;
    begin('a-2');
    assert.equal((await a.send('GET', `/api/github-app/setup?state=${a.signed('installation-claim', 'a-2')}&installation_id=42`)).location, '/?githubApp=error&code=GITHUB_APP_STATE_REPLAY');
    a.state.claim = new Error('database down');
    begin('a-3');
    assert.equal((await a.send('GET', `/api/github-app/setup?state=${a.signed('installation-claim', 'a-3')}&installation_id=42`)).location, '/?githubApp=error&code=GITHUB_APP_STATE_UNAVAILABLE');
    const login = await start({ production: true });
    assert.match((await login.send('GET', '/api/oauth/login')).cookies[0], /; Max-Age=600; Secure$/);
    login.state.fetch = () => new Response('{}');
    assert.match((await login.send('GET', '/api/oauth/callback?code=c&state=s-1', { cookie: 'nv_oauth=s-1' })).cookies.at(-1), /; Max-Age=0; Secure$/);
    await login.close();
  }
  await a.close();
  console.log('identity security route tests passed');
})().catch(error => { console.error(error); process.exit(1); });
