'use strict';
/*
 * The hosted alpha's front door over HTTP (D12), on identity and access's
 * registration: the access boundary every API route after it passes, the
 * status, the redemption of an invitation and the end of a session.
 *
 * What each must hold: the boundary's place among the pipeline's steps, with
 * the routes the baseline recorded before it still before it; the access
 * cookie HttpOnly, SameSite=Lax, for the whole site and seven days, and
 * Secure in production; a session read from the store on every request, its
 * tester lower-cased and matched against the cookie's; a store that cannot be
 * read answered 503 with the cookie kept, and every other refusal clearing
 * it; a deletion request let through on the sealed tester id alone; and a
 * redemption that issues a cookie only for a valid session and tester.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const identity = require('../apps/api/src/modules/identity-access/index.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const { AlphaAccessError, AlphaAccessOperationalError } = identity;

/* ---- The registration and the boundary's place, as the baseline inventory recorded them and the route policy reads them now ---- */
{
  const entries = locations(root);
  const routes = new Map(entries.filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  for (const key of ['GET /api/alpha/status', 'POST /api/alpha/redeem', 'POST /api/alpha/end']) {
    const entry = routes.get(key);
    assert(entry, `${key} is registered`);
    assert.deepEqual(entry.guards, [], `${key} has no guard of its own`);
    assert(entry.at.startsWith('apps/api/src/modules/identity-access/http/'), `${key} is registered by identity and access (${entry.at})`);
  }
  const boundaries = entries.filter(entry => entry.kind === 'use' && entry.label === 'alpha-access-boundary');
  assert.equal(boundaries.length, 1, 'one alpha access boundary');
  assert.equal(boundaries[0].mount, '/api');
  assert(boundaries[0].at.startsWith('apps/api/src/modules/identity-access/http/'), 'the boundary is registered by identity and access');
  const at = entries.indexOf(boundaries[0]);
  for (const route of inventory.routes) {
    const index = entries.indexOf(routes.get(`${route.method} ${route.path}`));
    assert(index >= 0, `${route.method} ${route.path} is registered`);
    assert.equal(index < at, route.beforeAlphaBoundary, `${route.method} ${route.path} stays ${route.beforeAlphaBoundary ? 'before' : 'behind'} the alpha boundary`);
  }
}

/* ---- A server with the module's registration, a scripted store and a codec ---- */
const TESTER = '0f9e8d7c-6b5a-4c3d-8e2f-1a2b3c4d5e6f';
const SESSION = { testerLabel: 'tester-7', repositoryScopes: ['github:github.com/acme/demo'], termsVersion: '2026-07-30', expiresAt: '2026-11-02T12:00:00.000Z' };
const SID = Symbol('alpha session id');
const seal = value => `s1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const unseal = text => {
  if (!text.startsWith('s1.')) return null;
  try { return JSON.parse(Buffer.from(text.slice(3), 'base64url').toString('utf8')); } catch { return null; }
};
const getCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

async function start({ enabled = true, production = false, withStore = enabled } = {}) {
  const state = { read: [], redeemed: [], session: () => ({ testerId: TESTER, ...SESSION }), redemption: null };
  const store = withStore ? {
    readSession: async sid => { state.read.push(sid); return state.session(); },
    redeemInvite: async input => { state.redeemed.push(input); return state.redemption(); }
  } : null;
  const config = { enabled, mode: enabled ? 'invite' : 'off', termsVersion: '2026-07-30' };
  const sessions = identity.createAlphaSessions({ config, store, seal, unseal, getCookie, sessionIdKey: SID, production: () => production });
  const app = express();
  app.use(express.json());
  identity.registerAlphaAccessRoutes(app, { sessions, config, store, seal, getCookie });
  app.use((req, res) => res.json({ reached: true, alpha: req.alpha || null, frozen: Object.isFrozen(req.alpha), sid: req[SID] || null }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, url, { cookie, body } = {}) => {
    const headers = {};
    if (cookie !== undefined) headers.cookie = `theme=dark; ${identity.ALPHA_COOKIE}=${cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, cookies: response.headers.getSetCookie(), body: await response.json() };
  };
  return { state, send, close: () => new Promise(resolve => server.close(resolve)) };
}
const cleared = response => response.cookies.length === 1 && /^nv_alpha_access=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/.test(response.cookies[0]);
const refusal = (code, message) => Object.assign(new AlphaAccessError(message, code), { code });

(async () => {
  /* The alpha off: nothing is gated, and there is nothing to redeem. */
  {
    const t = await start({ enabled: false });
    const status = await t.send('GET', '/api/alpha/status', { cookie: seal({ alphaSid: 'sid-1' }) });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { mode: 'off', authenticated: false, termsVersion: '2026-07-30', testerLabel: null, repositoryScopes: [], expiresAt: null });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await t.send('POST', '/api/alpha/redeem', { body: { code: 'x' } })).body, { error: 'Not found' });
    const open = await t.send('GET', '/api/repos');
    assert.equal(open.body.reached, true);
    assert.equal(open.body.alpha, null);
    await t.close();
    /* Off is off even with a store to hand: the configuration decides, not the store's presence. */
    const handed = await start({ enabled: false, withStore: true });
    handed.state.redemption = () => ({ sessionId: 'sid-9', tester: { testerId: TESTER, ...SESSION }, expiresAt: SESSION.expiresAt });
    assert.equal((await handed.send('POST', '/api/alpha/redeem', { body: { code: 'x' } })).status, 404);
    assert.deepEqual(handed.state.redeemed, []);
    assert.equal((await handed.send('GET', '/api/repos', { cookie: seal({ alphaSid: 'sid-1' }) })).body.reached, true);
    assert.deepEqual(handed.state.read, []);
    await handed.close();
  }

  const t = await start();
  /* Without a cookie: the status says signed out; the public routes pass; every other API route is refused and the cookie cleared. */
  {
    const status = await t.send('GET', '/api/alpha/status');
    assert.equal(status.body.authenticated, false);
    assert.equal(status.body.mode, 'invite');
    assert.deepEqual(status.cookies, []);
    for (const url of ['/api/version', '/api/config', '/api/capabilities', '/api/capabilities?provider=github']) {
      assert.equal((await t.send('GET', url)).body.reached, true, `${url} is public`);
    }
    for (const [method, url] of [['GET', '/api/repos'], ['POST', '/api/version'], ['GET', '/api/me'], ['GET', '/api/alpha/privacy']]) {
      const refused = await t.send(method, url);
      assert.equal(refused.status, 401, `${method} ${url} needs a session`);
      assert.deepEqual(refused.body, { error: 'Alpha access is required', code: 'ALPHA_ACCESS_REQUIRED' });
      assert(cleared(refused), `${method} ${url} clears the cookie`);
    }
    assert.equal((await t.send('GET', '/settings')).body.reached, true, 'the boundary is mounted on the API only');
    assert.deepEqual(t.state.read, [], 'no cookie, no store read');
  }

  /* A redemption issues a sealed cookie for the session and its tester, lower-cased. */
  {
    t.state.redemption = () => ({ sessionId: 'sid-9', tester: { testerId: TESTER.toUpperCase(), ...SESSION, expiresAt: 'stale' }, expiresAt: SESSION.expiresAt });
    const redeemed = await t.send('POST', '/api/alpha/redeem', { body: { code: 'NVX-ALPHA-1', acceptedTermsVersion: '2026-07-30', termsVersion: 'ignored' } });
    assert.equal(redeemed.status, 200);
    assert.deepEqual(redeemed.body, { ok: true, testerLabel: 'tester-7', repositoryScopes: SESSION.repositoryScopes, expiresAt: SESSION.expiresAt });
    assert.equal(redeemed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(t.state.redeemed.at(-1), { code: 'NVX-ALPHA-1', termsVersion: '2026-07-30', ip: '127.0.0.1' });
    assert.equal(redeemed.cookies.length, 1);
    const [pair, ...attributes] = redeemed.cookies[0].split('; ');
    assert.deepEqual(attributes, ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']);
    assert.deepEqual(unseal(pair.slice('nv_alpha_access='.length)), { alphaSid: 'sid-9', testerId: TESTER });

    for (const [answer, status, code] of [
      [() => { throw refusal('ALPHA_INVITE_REJECTED', 'Invitation could not be redeemed'); }, 403, 'ALPHA_INVITE_REJECTED'],
      [() => { throw refusal('ALPHA_REDEMPTION_LOCKED', 'Invitation could not be redeemed'); }, 429, 'ALPHA_REDEMPTION_LOCKED'],
      [() => { throw refusal('ALPHA_SESSION_EXPIRED', 'Alpha session expired'); }, 500, undefined],
      [() => { throw new Error('connection reset'); }, 500, undefined],
      [() => ({ sessionId: '', tester: { testerId: TESTER, ...SESSION }, expiresAt: SESSION.expiresAt }), 500, undefined],
      [() => ({ sessionId: 'sid-9', tester: { testerId: '0f9e8d7c-6b5a-6c3d-8e2f-1a2b3c4d5e6f', ...SESSION }, expiresAt: SESSION.expiresAt }), 500, undefined],
      [() => ({ sessionId: 'sid-9', tester: { testerId: TESTER, ...SESSION, repositoryScopes: null }, expiresAt: SESSION.expiresAt }), 500, undefined]
    ]) {
      t.state.redemption = answer;
      const failed = await t.send('POST', '/api/alpha/redeem', { body: { code: 'NVX-ALPHA-1' } });
      assert.equal(failed.status, status);
      assert.deepEqual(failed.body, code ? { error: 'Invitation could not be redeemed', code } : { error: 'Alpha access operation could not be completed' });
      assert.deepEqual(failed.cookies, [], 'a failed redemption sets no cookie');
    }
    t.state.redemption = () => { throw new AlphaAccessOperationalError(); };
    const down = await t.send('POST', '/api/alpha/redeem', { body: { code: 'NVX-ALPHA-1' } });
    assert.equal(down.status, 503);
    assert.equal(down.headers.get('retry-after'), '5');
    assert.equal(down.body.code, 'ALPHA_ACCESS_UNAVAILABLE');
  }

  /* A valid session reaches the route behind the boundary, its tester and session id on the request. */
  const cookie = seal({ alphaSid: 'sid-1', testerId: TESTER });
  {
    t.state.session = () => ({ testerId: TESTER.toUpperCase(), ...SESSION });
    const reached = await t.send('GET', '/api/repos', { cookie });
    assert.deepEqual(reached.body, { reached: true, alpha: { ...SESSION, testerId: TESTER }, frozen: false, sid: 'sid-1' });
    assert.deepEqual(reached.cookies, []);
    assert.equal(t.state.read.at(-1), 'sid-1');
    const status = await t.send('GET', '/api/alpha/status', { cookie });
    assert.deepEqual(status.body, {
      mode: 'invite', authenticated: true, termsVersion: '2026-07-30',
      testerLabel: SESSION.testerLabel, repositoryScopes: SESSION.repositoryScopes, expiresAt: SESSION.expiresAt
    });
    assert.equal((await t.send('GET', '/api/repos', { cookie: seal({ alphaSid: 'sid-1' }) })).body.reached, true, 'a cookie from before testers were sealed still reads');
  }

  /* Refusals: each clears the cookie with its own answer; one naming another tester, or a store answer without a valid tester, is an operational failure. */
  for (const [session, status, body] of [
    [() => { throw refusal('ALPHA_SESSION_EXPIRED', 'x'); }, 401, { error: 'Alpha session expired', code: 'ALPHA_SESSION_EXPIRED' }],
    [() => { throw refusal('ALPHA_ACCESS_REVOKED', 'x'); }, 403, { error: 'Alpha access was revoked', code: 'ALPHA_ACCESS_REVOKED' }],
    [() => { throw refusal('ALPHA_INVITE_REJECTED', 'x'); }, 500, { error: 'Alpha access operation could not be completed' }],
    [() => ({ testerId: '11111111-2222-4333-8444-555555555555', ...SESSION }), 500, { error: 'Alpha access operation could not be completed' }],
    [() => ({ testerId: 'not-a-uuid', ...SESSION }), 500, { error: 'Alpha access operation could not be completed' }],
    [() => ({ testerId: TESTER, ...SESSION, termsVersion: 7 }), 500, { error: 'Alpha access operation could not be completed' }]
  ]) {
    t.state.session = session;
    const refused = await t.send('GET', '/api/repos', { cookie });
    assert.equal(refused.status, status);
    assert.deepEqual(refused.body, body);
    assert(cleared(refused), 'a refusal clears the cookie');
    const signedOut = await t.send('GET', '/api/alpha/status', { cookie });
    if (status === 500) {
      assert.equal(signedOut.status, 500);
    } else {
      assert.equal(signedOut.status, 200);
      assert.equal(signedOut.body.authenticated, false);
    }
    assert(cleared(signedOut), 'the status clears a refused cookie too');
  }
  for (const garbage of ['garbage', seal({ alphaSid: '' }), seal({ alphaSid: 5 }), seal(null)]) {
    assert.equal((await t.send('GET', '/api/repos', { cookie: garbage })).status, 401);
  }

  /* A store that cannot be read is the database's fault: 503, Retry-After, and the cookie kept. */
  {
    t.state.session = () => { throw new AlphaAccessOperationalError(); };
    for (const url of ['/api/repos', '/api/alpha/status']) {
      const down = await t.send('GET', url, { cookie });
      assert.equal(down.status, 503, url);
      assert.equal(down.headers.get('retry-after'), '5');
      assert.deepEqual(down.body, { error: 'Alpha access is temporarily unavailable. Try again in a few seconds.', code: 'ALPHA_ACCESS_UNAVAILABLE' });
      assert.deepEqual(down.cookies, [], `${url} keeps the cookie`);
    }
  }

  /* Deletion goes through on the sealed tester alone, confirmed, to that one route; the recovery is frozen. */
  {
    t.state.session = () => { throw refusal('ALPHA_SESSION_EXPIRED', 'x'); };
    const recovered = await t.send('POST', '/api/alpha/delete', { cookie: seal({ testerId: TESTER.toUpperCase() }), body: { confirm: 'DELETE ALPHA DATA' } });
    assert.deepEqual(recovered.body, { reached: true, alpha: { testerId: TESTER, deletionRecovery: true }, frozen: true, sid: null });
    const queried = await t.send('POST', '/api/alpha/delete?now=1', { cookie: seal({ testerId: TESTER }), body: { confirm: 'DELETE ALPHA DATA' } });
    assert.equal(queried.body.alpha.deletionRecovery, true, 'the route is named without its query string');
    for (const [url, body, sealed] of [
      ['/api/alpha/delete', { confirm: 'delete alpha data' }, { testerId: TESTER }],
      ['/api/alpha/delete', {}, { testerId: TESTER }],
      ['/api/alpha/feedback', { confirm: 'DELETE ALPHA DATA' }, { testerId: TESTER }],
      ['/api/alpha/delete', { confirm: 'DELETE ALPHA DATA' }, { testerId: '0f9e8d7c-6b5a-6c3d-8e2f-1a2b3c4d5e6f' }],
      ['/api/alpha/delete', { confirm: 'DELETE ALPHA DATA', testerId: TESTER }, {}]
    ]) {
      const refused = await t.send('POST', url, { cookie: seal(sealed), body });
      assert.equal(refused.status, 401, `${url} with ${JSON.stringify(body)} is not a deletion recovery`);
      assert(cleared(refused));
    }
  }

  /* Ending a session clears the cookie whatever it held. */
  {
    const ended = await t.send('POST', '/api/alpha/end');
    assert.equal(ended.status, 401, 'ending is behind the boundary');
    t.state.session = () => ({ testerId: TESTER, ...SESSION });
    const done = await t.send('POST', '/api/alpha/end', { cookie });
    assert.deepEqual(done.body, { ok: true });
    assert(cleared(done));
    assert.equal(done.headers.get('cache-control'), 'no-store');
  }
  await t.close();

  /* In production the cookie is Secure, issued and cleared alike. */
  {
    const p = await start({ production: true });
    p.state.redemption = () => ({ sessionId: 'sid-9', tester: { testerId: TESTER, ...SESSION }, expiresAt: SESSION.expiresAt });
    const redeemed = await p.send('POST', '/api/alpha/redeem', { body: { code: 'NVX-ALPHA-1' } });
    assert.match(redeemed.cookies[0], /; Max-Age=604800; Secure$/);
    const ended = await p.send('POST', '/api/alpha/end', { cookie });
    assert.match(ended.cookies[0], /^nv_alpha_access=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0; Secure$/);
    await p.close();
  }
  console.log('alpha access route tests passed');
})().catch(error => { console.error(error); process.exit(1); });
