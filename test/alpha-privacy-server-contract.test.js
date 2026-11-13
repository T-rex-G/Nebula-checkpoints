'use strict';
/*
 * The alpha's privacy contract across its two halves: the access boundary,
 * which admits a tester whose session has ended for one request alone --
 * deleting their data, confirmed, by the tester sealed in their cookie -- and
 * the deletion route, which then scrubs what the tester owns before either
 * cookie is cleared. Here the boundary and the routes run together, as the
 * server registers them, over a recording privacy store.
 *
 * Each half is asked on its own where it lives:
 *   - the boundary: a session read from the store on every request, its
 *     tester matched against the cookie's, and a deletion recovery only for
 *     that route, that confirmation and the sealed tester, never one a body
 *     names (test/alpha-access-routes.test.js);
 *   - the routes: the privacy notice, from the alpha's terms and retention;
 *     feedback, bounded, sanitized, for the session's tester and this release;
 *     disconnecting every provider; deletion, confirmed before it
 *     authenticates, the provider cleanup verified, a blocked request answered
 *     by its blocks' codes and counts alone, and the session's tester deleted
 *     whatever the body names (test/identity-account-routes.test.js);
 *   - what a lifecycle tells a tester to revoke by hand
 *     (test/provider-disconnect-server-contract.test.js), and the composed
 *     invite-only server, end to end (test/composition-alpha.test.js);
 *   - that no module takes a tester from a request's body
 *     (test/module-rules.test.js).
 */
const assert = require('node:assert/strict');
const express = require('express');
const identity = require('../apps/api/src/modules/identity-access/index.ts');

const TESTER = '0f9e8d7c-6b5a-4c3d-8e2f-1a2b3c4d5e6f';
const CONFIRM = { confirm: 'DELETE ALPHA DATA' };
const PROVIDER_CLEARED = 'nv_session=; Max-Age=0';
const ACCESS_CLEARED = /^nv_alpha_access=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/;
const seal = value => `s1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const unseal = text => {
  if (!String(text).startsWith('s1.')) return null;
  try { return JSON.parse(Buffer.from(String(text).slice(3), 'base64url').toString('utf8')); } catch { return null; }
};
const getCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
};

async function start() {
  const calls = [];
  const state = {
    session: () => { throw Object.assign(new identity.AlphaAccessError('Alpha access expired', 'ALPHA_SESSION_EXPIRED'), { code: 'ALPHA_SESSION_EXPIRED' }); },
    purge: { status: 'complete', providerCleanupVerified: true, removedRows: 4 }
  };
  const store = { readSession: async () => state.session(), redeemInvite: async () => { throw new Error('not here'); } };
  const config = { enabled: true, mode: 'invite', termsVersion: '2026-07-30' };
  const sessions = identity.createAlphaSessions({ config, store, seal, unseal, getCookie, sessionIdKey: Symbol('alpha session id'), production: () => false });
  const app = express();
  app.use(express.json());
  identity.registerAlphaAccessRoutes(app, { sessions, config, store, seal, getCookie });
  identity.registerAlphaDisconnectRoutes(app, {
    config, sessions,
    accountAuth: (req, res, next) => {
      calls.push(['accountAuth']);
      req.session = { accounts: [{ provider: 'github', login: 'alice', token: 'ghp_alice' }], active: 0 };
      return next();
    },
    fail: (res, error) => res.status(error.status || 500).json({ error: error.message, code: error.code }),
    disconnectProviderAccounts: async (req, accounts) => {
      calls.push(['disconnect', accounts.map(account => account.login)]);
      return { complete: true, supportedComplete: true, results: [], manualCleanup: [] };
    },
    clearProviderSessionCookie: (req, res) => { calls.push(['clearProviderCookie']); res.setHeader('Set-Cookie', PROVIDER_CLEARED); },
    privacyStore: {
      createDeletionRequest: async input => { calls.push(['createDeletionRequest', input]); return { status: 'recorded' }; },
      purgeTester: async input => { calls.push(['purgeTester', input]); return state.purge; }
    }
  });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const send = async (url, { cookie, body } = {}) => {
    calls.length = 0;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `${identity.ALPHA_COOKIE}=${cookie}` } : {}) },
      body: JSON.stringify(body || {})
    });
    return { status: response.status, cookies: response.headers.getSetCookie(), body: await response.json() };
  };
  return { calls, state, send, close: () => new Promise(resolve => server.close(resolve)) };
}
const names = calls => calls.map(call => call[0]);

(async () => {
  const t = await start();
  try {
    /* An ended session, confirmed: the sealed tester's data is scrubbed by the store, then both cookies are cleared. */
    {
      const deleted = await t.send('/api/alpha/delete', { cookie: seal({ alphaSid: 'gone', testerId: TESTER.toUpperCase() }), body: CONFIRM });
      assert.deepEqual([deleted.status, deleted.body], [200, { ok: true, status: 'complete', providerCleanupVerified: true, removedRows: 4 }]);
      assert.deepEqual(t.calls, [['purgeTester', { testerId: TESTER }], ['clearProviderCookie']],
        'recovery goes straight to the store\'s purge, for the sealed tester, without signing in');
      assert.equal(deleted.cookies.length, 2);
      assert.equal(deleted.cookies[0], PROVIDER_CLEARED);
      assert.match(deleted.cookies[1], ACCESS_CLEARED, 'both cookies are cleared once the store has scrubbed what the tester owns');
    }
    /* A purge the store cannot finish keeps both cookies, so the tester can try again. */
    {
      t.state.purge = { status: 'blocked', cleanupBlocks: [{ code: 'PROVIDER_SESSION_PENDING', count: 2, cleanupId: 'cleanup-9' }] };
      const blocked = await t.send('/api/alpha/delete', { cookie: seal({ alphaSid: 'gone', testerId: TESTER }), body: CONFIRM });
      assert.deepEqual([blocked.status, blocked.body.code, blocked.body.cleanupBlocks], [409, 'ALPHA_DELETION_BLOCKED', [{ code: 'PROVIDER_SESSION_PENDING', count: 2 }]]);
      assert.deepEqual([names(t.calls), blocked.cookies], [['purgeTester'], []], 'nothing is cleared before the store succeeds');
      t.state.purge = { status: 'complete', providerCleanupVerified: false };
      const unverified = await t.send('/api/alpha/delete', { cookie: seal({ alphaSid: 'gone', testerId: TESTER }), body: CONFIRM });
      assert.deepEqual([unverified.status, unverified.cookies], [409, []], 'nor before the provider cleanup is verified');
      t.state.purge = { status: 'complete', providerCleanupVerified: true, removedRows: 4 };
    }
    /* Anything else from an ended session is refused at the boundary, and its cookie cleared. */
    for (const [url, body, sealed] of [
      ['/api/alpha/delete', { confirm: 'delete alpha data' }, { alphaSid: 'gone', testerId: TESTER }],
      ['/api/alpha/providers/disconnect-all', CONFIRM, { alphaSid: 'gone', testerId: TESTER }],
      ['/api/alpha/delete', { ...CONFIRM, testerId: TESTER }, { alphaSid: 'gone' }]
    ]) {
      const refused = await t.send(url, { cookie: seal(sealed), body });
      assert.equal(refused.status, 401, `${url} with ${JSON.stringify(body)} is no deletion recovery`);
      assert.deepEqual(t.calls, [], 'and reaches nothing');
      assert.equal(refused.cookies.length, 1);
      assert.match(refused.cookies[0], ACCESS_CLEARED);
    }
    /* A live session deletes as a signed-in tester: every provider disconnected and the request recorded before the purge. */
    {
      t.state.session = () => ({ testerId: TESTER, testerLabel: 'tester-7', repositoryScopes: [], termsVersion: '2026-07-30', expiresAt: '2026-11-09T12:00:00.000Z' });
      const unconfirmed = await t.send('/api/alpha/delete', { cookie: seal({ alphaSid: 'live', testerId: TESTER }), body: { confirm: 'delete alpha data' } });
      assert.deepEqual([unconfirmed.status, unconfirmed.body.code, t.calls], [400, 'ALPHA_DELETION_CONFIRMATION_REQUIRED', []],
        'an unconfirmed deletion reaches nothing, not even the sign-in check');
      const deleted = await t.send('/api/alpha/delete', { cookie: seal({ alphaSid: 'live', testerId: TESTER }), body: CONFIRM });
      assert.equal(deleted.status, 200);
      assert.deepEqual(names(t.calls), ['accountAuth', 'disconnect', 'createDeletionRequest', 'purgeTester', 'clearProviderCookie']);
      assert.deepEqual(t.calls.find(call => call[0] === 'createDeletionRequest')[1], { testerId: TESTER });
    }
  } finally {
    await t.close();
  }
  console.log('alpha privacy server contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
