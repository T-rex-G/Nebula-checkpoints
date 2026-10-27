'use strict';
/*
 * Where the provider session is kept (identity-access/application/provider-sessions.ts):
 * a row in nv_sessions, the hosted alpha's privacy store, or the cookie
 * itself. Each is driven through a fake store, a fake pool and the real
 * cookie codec and local session policy.
 */
const assert = require('assert');
const {
  createProviderSessions, HOSTED_SESSION_BASE, HOSTED_SESSION_REVISION, ownedSessionRefusal, alphaConnectionRefusal, identityKey
} = require('../apps/api/src/modules/identity-access/index.ts');
const { createSessionSeal, readCookie, createSessionCookieWriter } = require('../apps/api/src/platform/authorization/session-cookie.ts');
const { createLocalSessionPolicy } = require('../apps/api/src/platform/authorization/local-session-policy.ts');
const { deriveKey, KEY_PURPOSES } = require('../apps/api/src/platform/crypto/key-derivation.ts');

const { seal, unseal } = createSessionSeal(deriveKey('s'.repeat(48), KEY_PURPOSES.SESSION_CONTENT));
const alice = { login: 'alice', token: 't-a' };
const bob = { login: 'bob', token: 't-b' };
const retired = { login: 'old', provider: 'gitea', baseUrl: 'https://git.example' };

function harness({ database = true, alpha = false, ready = true } = {}) {
  const calls = [];
  const rows = new Map();
  const owned = new Map();
  const state = { ready, readFails: false, updateMisses: false, storeError: null, concurrent: null };
  const pool = () => ({
    async query(text, values) {
      calls.push(['query', text.split(' ')[0], values && values[0]]);
      if (/^SELECT/.test(text)) {
        if (state.readFails) throw new Error('connection reset');
        return { rows: rows.has(values[0]) ? [{ data: rows.get(values[0]) }] : [], rowCount: 0 };
      }
      if (/^UPDATE/.test(text)) {
        if (state.updateMisses || !rows.has(values[0])) return { rows: [], rowCount: 0 };
        rows.set(values[0], values[1]);
        calls.push(['identity_keys', values[2]]);
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT/.test(text)) { rows.set(values[0], values[1]); calls.push(['identity_keys', values[2]]); return { rows: [], rowCount: 1 }; }
      if (/^DELETE/.test(text)) { rows.delete(values[0]); return { rows: [], rowCount: 1 }; }
      throw new Error(text);
    }
  });
  const privacyStore = {
    async readHostedProviderSession({ testerId, sessionId }) {
      calls.push(['read', testerId, sessionId]);
      if (state.storeError) throw state.storeError;
      const row = owned.get(`${testerId}|${sessionId}`);
      if (!row) throw Object.assign(new Error('none'), { code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE' });
      return { session: structuredClone(row.session), revision: row.revision };
    },
    async mutateHostedProviderSession({ testerId, sessionId, mutate }) {
      calls.push(['mutate', testerId, sessionId]);
      if (state.storeError) throw state.storeError;
      const row = owned.get(`${testerId}|${sessionId}`) || { session: { accounts: [] }, revision: 0 };
      const current = state.concurrent ? state.concurrent(structuredClone(row.session)) : structuredClone(row.session);
      const next = mutate(current);
      owned.set(`${testerId}|${sessionId}`, { session: next, revision: row.revision + 1 });
      return { session: structuredClone(next), revision: row.revision + 1 };
    }
  };
  const localSessionPolicy = createLocalSessionPolicy({ now: () => Date.now() });
  const sessions = createProviderSessions({
    databaseConfigured: database, /* As the lifecycle answers: never ready without a database. */
    ready: async () => { calls.push(['ready']); return database && state.ready; }, pool,
    config: { enabled: alpha }, privacyStore: alpha ? privacyStore : null,
    seal, unseal, readCookie, writeCookie: createSessionCookieWriter(() => false), localSessionPolicy,
    closeLiveSessions: (ids, reason) => calls.push(['closeLive', ids, reason])
  });
  let jar = '';
  const request = (alphaSession = null) => ({ headers: jar ? { cookie: jar } : {}, alpha: alphaSession });
  const response = () => ({
    headers: [],
    setHeader(name, value) {
      this.headers.push([name, value]);
      const match = /^nv_session=([^;]*);/.exec(value);
      jar = match && match[1] ? `nv_session=${match[1]}` : '';
    }
  });
  return {
    sessions, calls, rows, owned, state, localSessionPolicy, request, response,
    cookie: () => unseal((jar || '=').split('=').slice(1).join('=')),
    setJar: value => { jar = value; }
  };
}
const fails = (status, code, message) => error => error.status === status && error.code === code && (!message || error.message === message);

async function main() {
  /* With a database: a new session is a new row, the cookie carries only its id, and a write goes back to that row. */
  {
    const h = harness();
    const res = h.response();
    await h.sessions.setSession(h.request(), res, { accounts: [alice, bob, alice], active: 1, retiredSelection: false });
    const { sid } = h.cookie();
    assert.match(sid, /^[0-9a-f]{48}$/);
    assert.deepStrictEqual(Object.keys(h.cookie()), ['sid'], 'the cookie carries the id alone');
    assert.match(res.headers[0][1], /; Max-Age=2592000$/);
    assert.deepStrictEqual(unseal(h.rows.get(sid)), { accounts: [alice, bob, alice], active: 1 }, 'retiredSelection is never stored');
    assert.deepStrictEqual(h.calls.find(call => call[0] === 'identity_keys')[1], [identityKey(alice), identityKey(bob)], 'each identity once');
    assert.deepStrictEqual(h.sessions.sessionIdFromRequest(h.request()), sid);
    await h.sessions.setSession(h.request(), h.response(), { accounts: [bob], active: 0 });
    assert.strictEqual(h.cookie().sid, sid, 'the same session, rewritten');
    assert.deepStrictEqual(unseal(h.rows.get(sid)), { accounts: [bob], active: 0 });
    await h.sessions.setSession(h.request(), h.response(), { accounts: [bob], active: 0 }, { createNew: true });
    assert.notStrictEqual(h.cookie().sid, sid, 'a new session when asked for one');
    assert.strictEqual(h.rows.size, 2);

    h.state.updateMisses = true;
    await assert.rejects(h.sessions.setSession(h.request(), h.response(), { accounts: [bob] }),
      fails(401, 'SESSION_REVOKED', 'This session ended. Sign in again.'), 'a write to an ended session is refused');
    h.state.ready = false;
    await assert.rejects(h.sessions.setSession(h.request(), h.response(), { accounts: [bob] }),
      error => error.status === 503 && error.message === 'Session database is temporarily unavailable' && error.code === undefined);
    const before = h.calls.length;
    await assert.rejects(h.sessions.sessionOf(h.request()), error => error.status === 503);
    assert.deepStrictEqual(h.calls.slice(before), [['ready']], 'nothing is read from a store that is not ready');
  }

  /* Reading it back: GitHub accounts only, unless the retired ones are asked for; an outage is not "no session". */
  {
    const h = harness();
    await h.sessions.setSession(h.request(), h.response(), { accounts: [retired, alice], active: 1 });
    assert.deepStrictEqual(await h.sessions.sessionOf(h.request()), {
      accounts: [alice], active: 0, retiredSelection: false, security: { stepUp: null }
    });
    assert.deepStrictEqual(await h.sessions.sessionOf(h.request(), { retainRetiredAccounts: true }), { accounts: [retired, alice], active: 1 });
    h.state.readFails = true;
    await assert.rejects(h.sessions.sessionOf(h.request()), error => error.status === 503 && error.message === 'Session database is temporarily unavailable');
    h.state.readFails = false;
    await h.sessions.setSession(h.request(), h.response(), { accounts: [], active: 0 });
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'a session without accounts is none');
    await h.sessions.setSession(h.request(), h.response(), { accounts: [retired] });
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'nothing to act through is none');
    assert.deepStrictEqual(await h.sessions.sessionOf(h.request(), { retainRetiredAccounts: true }), { accounts: [retired] });
    h.rows.clear();
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'a row that is gone is no session');
    h.setJar(`nv_session=${seal(h.localSessionPolicy.prepare({ accounts: [alice], active: 0 }))}`);
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'a whole session in the cookie, valid where there is no database, is refused where there is one');
    h.setJar('nv_session=forged');
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null);
    h.setJar('');
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null);
    assert.strictEqual(h.sessions.sessionIdFromRequest(h.request()), '');
    h.setJar(`nv_session=${seal({ sid: 12 })}`);
    assert.strictEqual(h.sessions.sessionIdFromRequest(h.request()), '', 'an id that is not text is none');
  }

  /* Signing out: the row goes, the live streams close, and the cookie is cleared; an outage says so. */
  {
    const h = harness();
    await h.sessions.setSession(h.request(), h.response(), { accounts: [alice] });
    const { sid } = h.cookie();
    h.state.ready = false;
    await assert.rejects(h.sessions.destroySession(h.request(), h.response()),
      error => error.status === 503 && error.message === 'Session database is temporarily unavailable; sign-out was not completed');
    assert(h.rows.has(sid), 'nothing was removed');
    h.state.ready = true;
    const res = h.response();
    await h.sessions.destroySession(h.request(), res);
    assert(!h.rows.has(sid));
    assert.deepStrictEqual(h.calls.filter(call => call[0] === 'closeLive'), [['closeLive', [sid], 'session-ended']]);
    assert.deepStrictEqual(res.headers, [['Set-Cookie', 'nv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']]);
    const fresh = harness();
    const cleared = fresh.response();
    await fresh.sessions.destroySession(fresh.request(), cleared);
    assert.deepStrictEqual(fresh.calls, [], 'without a session there is nothing to remove or close');
    assert.strictEqual(cleared.headers.length, 1, 'the cookie is still cleared');
  }

  /* Without a database: the session is the cookie, bounded by the local policy, and sign-out revokes it. */
  {
    const h = harness({ database: false });
    const req = h.request();
    const res = h.response();
    await h.sessions.setSession(req, res, { accounts: [alice], active: 0 });
    const stored = h.cookie();
    assert.deepStrictEqual(stored.accounts, [alice]);
    assert.strictEqual(typeof stored.lifetime.expiresAt, 'number');
    assert.deepStrictEqual(req.session, stored, 'the request carries what was written');
    const maxAge = Number(/Max-Age=(\d+)/.exec(res.headers[0][1])[1]);
    assert(Math.abs(maxAge - Math.ceil((stored.lifetime.expiresAt - Date.now()) / 1000)) <= 1, 'the cookie lives as long as the session');
    assert.deepStrictEqual((await h.sessions.sessionOf(h.request())).accounts, [alice]);
    await h.sessions.setSession(h.request(), h.response(), { ...stored, accounts: [alice, bob] });
    assert.strictEqual(h.cookie().lifetime.expiresAt, stored.lifetime.expiresAt, 'a rewrite keeps the lifetime');
    const kept = `nv_session=${seal(h.cookie())}`;
    await h.sessions.destroySession(h.request(), h.response());
    assert(!h.calls.some(call => call[0] === 'query' || call[0] === 'ready'), 'no database is asked');
    h.setJar(kept);
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'a revoked cookie is no session');
    h.setJar(`nv_session=${seal({ accounts: [alice] })}`);
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null, 'a cookie without a lifetime is no session');
    await h.sessions.setSession(h.request(), h.response(), { accounts: [] });
    assert.strictEqual(await h.sessions.sessionOf(h.request()), null);
    h.setJar(`nv_session=${seal({ sid: 'a'.repeat(48) })}`);
    await assert.rejects(h.sessions.sessionOf(h.request()), error => error.status === 503, 'an id in the cookie still needs the store');
    /* Signing out such a cookie asks nothing of a database there is not, and still ends its streams. */
    const out = h.response();
    await h.sessions.destroySession(h.request(), out);
    assert.deepStrictEqual(h.calls.filter(call => call[0] === 'closeLive').at(-1), ['closeLive', ['a'.repeat(48)], 'session-ended']);
    assert.strictEqual(out.headers.length, 1);
  }

  /* The hosted alpha: the privacy store's session, owned by the tester, written as a merge. */
  {
    const h = harness({ alpha: true });
    const sid = 'c'.repeat(48);
    await assert.rejects(h.sessions.setSession(h.request({ testerId: 'tester-1' }), h.response(), { accounts: [alice] }),
      fails(401, 'ALPHA_PROVIDER_SESSION_UNAVAILABLE'), 'a tester whose cookie names no session has none to write');
    assert(!h.calls.some(call => call[0] === 'mutate'), 'and nothing is written for one');
    h.setJar(`nv_session=${seal({ sid })}`);
    await assert.rejects(h.sessions.setSession(h.request(null), h.response(), { accounts: [alice] }),
      fails(401, 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', 'Owned provider session is unavailable'));
    await assert.rejects(h.sessions.sessionOf(h.request(null)), fails(401, 'ALPHA_ACCESS_REQUIRED', 'Alpha access is required'));
    const tester = { testerId: 'tester-1' };
    assert.strictEqual(await h.sessions.sessionOf(h.request(tester)), null, 'a session the store does not hold is none');

    h.owned.set(`tester-1|${sid}`, { session: { accounts: [alice], active: 0, theme: 'dark' }, revision: 4 });
    const req = h.request(tester);
    const read = await h.sessions.sessionOf(req);
    assert.deepStrictEqual(read, { accounts: [alice], active: 0, theme: 'dark' });
    assert.deepStrictEqual(req[HOSTED_SESSION_BASE], read);
    assert.notStrictEqual(req[HOSTED_SESSION_BASE], read, 'the base is a copy');
    assert.strictEqual(req[HOSTED_SESSION_REVISION], 4);

    /* Another request adds an account between this read and this write; both survive. */
    h.state.concurrent = current => ({ ...current, accounts: [...current.accounts, bob], theme: 'light' });
    const res = h.response();
    await h.sessions.setSession(req, res, { ...read, accounts: [alice], active: 0, note: 'mine' });
    assert.deepStrictEqual(req.session, { accounts: [alice, bob], active: 0, theme: 'light', note: 'mine' });
    assert.deepStrictEqual(req[HOSTED_SESSION_BASE], req.session);
    assert.strictEqual(req[HOSTED_SESSION_REVISION], 5);
    assert.deepStrictEqual(h.cookie(), { sid }, 'the cookie keeps naming the same session');
    assert(!h.calls.some(call => call[0] === 'query'), 'the hosted alpha never writes nv_sessions');
    h.state.concurrent = null;

    /* A write that read nothing takes what it writes as what it read: it adds, and removes nothing it did not know of. */
    const blind = h.request(tester);
    await h.sessions.setSession(blind, h.response(), { accounts: [bob], active: 0 });
    assert.deepStrictEqual(blind.session.accounts, [bob, alice]);

    /* The store's refusals. */
    const ended = Object.assign(new Error('ended'), { code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE' });
    h.state.storeError = ended;
    await assert.rejects(h.sessions.setSession(h.request(tester), h.response(), { accounts: [alice] }),
      error => error === ended && error.status === 401, 'ended between read and write: signed out');
    assert.strictEqual(await h.sessions.sessionOf(h.request(tester)), null);
    for (const [code, status, mapped] of [
      ['ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT', 403, 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'],
      ['ALPHA_TESTER_REVOKED', 401, 'ALPHA_ACCESS_REQUIRED'],
      ['ALPHA_TESTER_UNAVAILABLE', 401, 'ALPHA_ACCESS_REQUIRED'],
      ['ALPHA_TESTER_DELETING', 409, 'ALPHA_TESTER_DELETING']
    ]) {
      h.state.storeError = Object.assign(new Error('refused'), { code });
      await assert.rejects(h.sessions.sessionOf(h.request(tester)), fails(status, mapped), code);
      await assert.rejects(h.sessions.setSession(h.request(tester), h.response(), { accounts: [alice] }), fails(status, mapped), code);
    }
    const fault = new Error('store fault');
    h.state.storeError = fault;
    await assert.rejects(h.sessions.sessionOf(h.request(tester)), error => error === fault, 'a fault is passed on as it is');
  }

  /* The answers for the store's refusals, and for an account this alpha access has let go. */
  {
    assert.deepStrictEqual(Object.assign({}, ownedSessionRefusal({ code: 'ALPHA_TESTER_DELETING' })), { status: 409, code: 'ALPHA_TESTER_DELETING' });
    assert.strictEqual(ownedSessionRefusal({ code: 'ALPHA_TESTER_DELETING' }).message, 'Alpha data deletion is in progress');
    assert.strictEqual(ownedSessionRefusal({ code: 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT' }).message, 'This sign-in belongs to another alpha session');
    const other = { code: 'OTHER' };
    assert.strictEqual(ownedSessionRefusal(other), other);
    assert.strictEqual(ownedSessionRefusal(null), null);
    for (const code of ['ALPHA_PROVIDER_LIFECYCLE_STARTED', 'ALPHA_PROVIDER_BINDING_CONFLICT']) {
      const answer = alphaConnectionRefusal({ code });
      assert.deepStrictEqual({ ...answer, message: answer.message }, {
        status: 409, code: 'ALPHA_PROVIDER_IDENTITY_RETIRED', providerChanged: false,
        safeState: 'Nothing was connected. The disconnected account stays disconnected.',
        nextAction: 'Sign in with another GitHub account, or end the alpha session and ask the operator for a new invitation to use this one.',
        message: 'This GitHub account was disconnected from this alpha access and cannot be connected to it again.'
      });
    }
    const full = alphaConnectionRefusal({ code: 'ALPHA_PROVIDER_ACCOUNT_CAPACITY' });
    assert.deepStrictEqual({ ...full, message: full.message }, {
      status: 409, code: 'ALPHA_PROVIDER_ACCOUNT_CAPACITY', providerChanged: false, safeState: 'Nothing was connected.',
      message: 'This session already holds the most accounts it can. Remove one first.'
    });
    assert.strictEqual(alphaConnectionRefusal({ code: 'ALPHA_TESTER_REVOKED' }).code, 'ALPHA_ACCESS_REQUIRED', 'and otherwise the store\'s answers');
    assert.strictEqual(alphaConnectionRefusal(other), other);
  }

  finished = true;
  console.log('provider sessions tests passed');
}

/* A deferred nobody settles leaves main() waiting with nothing left to run, and Node would exit cleanly. */
let finished = false;
process.on('exit', () => {
  if (finished) return;
  console.error('provider sessions tests did not finish');
  process.exitCode = 1;
});
main().catch(error => { console.error(error); process.exit(1); });
