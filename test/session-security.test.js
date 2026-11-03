'use strict';
/*
 * The session's own security (identity-access/application/session-security.ts):
 * its nonce, the security context a token is bound to, CSRF, step-up with its
 * replay guard chosen by configuration, and the offline cache's scope and
 * binding. Tokens are minted with the platform's own functions.
 */
const assert = require('assert');
const crypto = require('crypto');
const {
  createSessionSecurity, CSRF_TTL_MS, STEP_UP_TTL_MS, identityKey
} = require('../apps/api/src/modules/identity-access/index.ts');
const { createCsrfToken, createStepUpGrant, scopeHash } = require('../apps/api/src/platform/authorization/security-foundation.ts');
const { SAFE_API_METHODS } = require('../apps/api/src/http/pipeline/index.ts');
const { createSessionSeal, readCookie } = require('../apps/api/src/platform/authorization/session-cookie.ts');

const CSRF_SECRET = 'c'.repeat(43);
const STEP_UP_SECRET = 's'.repeat(43);
const OFFLINE_KEY = Buffer.alloc(32, 7);
const { seal, unseal } = createSessionSeal(Buffer.alloc(32, 9));
const alice = { login: 'alice' };

function harness({ database = false, guard = [] } = {}) {
  const writes = [];
  const claims = [];
  let opened = 0;
  const durable = {
    async consumeOnce(entry) {
      claims.push(entry);
      const answer = guard.shift() || 'claim';
      if (answer === 'fail') throw new Error('database blinked');
      return answer === 'claim';
    }
  };
  const security = createSessionSecurity({
    databaseConfigured: database,
    durableSingleUseStore: () => { opened += 1; return durable; },
    setSession: async (req, res, data) => { writes.push(structuredClone(data)); },
    csrfSecret: CSRF_SECRET, stepUpSecret: STEP_UP_SECRET, safeMethods: SAFE_API_METHODS,
    offlineCacheScopeKey: OFFLINE_KEY,
    sessionIdFromRequest: req => { const value = unseal(readCookie(req, 'nv_session') || ''); return value && typeof value.sid === 'string' ? value.sid : ''; }
  });
  return { security, writes, claims, opened: () => opened };
}
const request = ({ session = {}, gh = alice, method = 'GET', headers = {}, url = '/api/repos' } = {}) => ({ session, gh, method, headers, originalUrl: url, url });
const refused = (status, code) => error => error.status === status && error.code === code;

async function main() {
  assert.strictEqual(CSRF_TTL_MS, 30 * 60 * 1000);
  assert.strictEqual(STEP_UP_TTL_MS, 5 * 60 * 1000);

  /* The state, the nonce and the context. */
  {
    const { security, writes } = harness();
    for (const value of [undefined, null, 'text', 7]) {
      const session = { security: value };
      const state = security.sessionSecurityState(session);
      assert.deepStrictEqual(state, {});
      assert.strictEqual(session.security, state, 'made on the session itself');
    }
    const kept = { security: { sessionNonce: 'n', other: 1 } };
    assert.strictEqual(security.sessionSecurityState(kept), kept.security);

    const session = { security: { stepUp: { jti: 'x' } } };
    const req = request({ session });
    assert.throws(() => security.requestSecurityContext(req), refused(401, 'SECURITY_CONTEXT_REQUIRED'), 'no nonce yet');
    const state = await security.ensureSessionSecurity(req, {});
    assert.match(state.sessionNonce, /^[0-9a-f]{48}$/);
    assert.strictEqual(state.stepUp, null, 'a new nonce ends any step-up');
    assert.deepStrictEqual(writes, [session], 'and the session is written');
    assert.deepStrictEqual(security.requestSecurityContext(req), { sessionBinding: state.sessionNonce, identityKey: identityKey(alice) });
    await security.ensureSessionSecurity(req, {});
    assert.strictEqual(writes.length, 1, 'a session with a nonce is left alone');
    session.security.sessionNonce = 'A'.repeat(48);
    await security.ensureSessionSecurity(req, {});
    assert.strictEqual(writes.length, 1, 'the nonce is read without regard to case');
    session.security.sessionNonce = 'a'.repeat(47);
    await security.ensureSessionSecurity(req, {});
    assert.strictEqual(writes.length, 2, 'a nonce out of shape is replaced');
    assert.throws(() => security.requestSecurityContext(request({ session, gh: null })), refused(401, 'SECURITY_CONTEXT_REQUIRED'), 'no identity acting');
    assert.throws(() => security.requestSecurityContext({ session: undefined, gh: alice }), refused(401, 'SECURITY_CONTEXT_REQUIRED'), 'no session');
    security.clearStepUpAuthorization(session);
    assert.strictEqual(session.security.stepUp, null);
    const bare = {};
    security.clearStepUpAuthorization(bare);
    assert.deepStrictEqual(bare, { security: { stepUp: null } });
  }

  /* CSRF: only a changing method needs one, and only this session's, this identity's, fresh one opens. */
  {
    const { security } = harness();
    const session = { security: { sessionNonce: 'b'.repeat(48) } };
    const context = { sessionBinding: 'b'.repeat(48), identityKey: identityKey(alice) };
    for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.strictEqual(security.verifyRequestCsrf(request({ session, method })), null, method);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.throws(() => security.verifyRequestCsrf(request({ session, method })), refused(403, 'CSRF_REQUIRED'), method);
    }
    const token = createCsrfToken(CSRF_SECRET, context, { ttlMs: CSRF_TTL_MS });
    assert(security.verifyRequestCsrf(request({ session, method: 'POST', headers: { 'x-nv-csrf': token } })), 'a fresh token for this session and identity');
    for (const [label, other] of [
      ['another session', createCsrfToken(CSRF_SECRET, { ...context, sessionBinding: 'c'.repeat(48) })],
      ['another identity', createCsrfToken(CSRF_SECRET, { ...context, identityKey: 'd'.repeat(64) })],
      ['another secret', createCsrfToken('x'.repeat(43), context)],
      ['expired', createCsrfToken(CSRF_SECRET, context, { now: Date.now() - CSRF_TTL_MS - 1000, ttlMs: CSRF_TTL_MS })]
    ]) {
      assert.throws(() => security.verifyRequestCsrf(request({ session, method: 'POST', headers: { 'x-nv-csrf': other } })), error => error.status === 403, label);
    }
    assert.throws(() => security.verifyRequestCsrf(request({ session: {}, method: 'POST', headers: { 'x-nv-csrf': token } })), refused(401, 'SECURITY_CONTEXT_REQUIRED'));
  }

  /* Step-up: a grant for this action and scope, pending in this session, claimed once. */
  for (const database of [false, true]) {
    const guard = [];
    const h = harness({ database, guard });
    const operation = { action: 'repository.delete', scope: { repo: 'acme/demo' } };
    const nonce = 'e'.repeat(48);
    const context = { sessionBinding: nonce, identityKey: identityKey(alice) };
    const arm = (session, overrides = {}) => {
      const jti = crypto.randomUUID();
      session.security.stepUp = { jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt: Date.now() + STEP_UP_TTL_MS, assurance: 'credential', ...overrides };
      return createStepUpGrant(STEP_UP_SECRET, { ...context, ...operation, assurance: 'credential' }, { jti, ttlMs: STEP_UP_TTL_MS });
    };
    const session = { security: { sessionNonce: nonce } };
    await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST' }), {}, operation), refused(403, 'STEP_UP_REQUIRED'));
    const grant = arm(session);
    const req = request({ session, method: 'POST', headers: { 'x-nv-step-up': grant } });
    const consumed = await h.security.consumeStepUpAuthorization(req, {}, operation);
    assert.deepStrictEqual({ action: consumed.action, assurance: consumed.assurance }, { action: 'repository.delete', assurance: 'credential' });
    assert.strictEqual(req.stepUp, consumed, 'the request carries the authorization for its audit');
    assert.strictEqual(session.security.stepUp, null, 'spent');
    assert.deepStrictEqual(h.writes.at(-1).security.stepUp, null, 'and the spent state is written');
    await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST', headers: { 'x-nv-step-up': grant } }), {}, operation),
      refused(403, 'STEP_UP_REPLAY'), 'once');
    if (database) {
      assert.strictEqual(h.claims.length, 1, 'the shared guard is asked');
      assert.deepStrictEqual([h.claims[0].kind, typeof h.claims[0].key], ['step-up', 'string']);
      guard.push('refuse');
      await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST', headers: { 'x-nv-step-up': arm(session) } }), {}, operation),
        refused(403, 'STEP_UP_REPLAY'), 'spent elsewhere');
      guard.push('fail');
      await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST', headers: { 'x-nv-step-up': arm(session) } }), {}, operation),
        error => error.status === 503, 'a guard that cannot answer refuses, and says why');
      assert(session.security.stepUp, 'an unclaimed grant stays pending');
      assert(h.opened() >= 1);
    } else {
      assert.strictEqual(h.claims.length, 0, 'without a database the shared guard is never asked');
      assert.strictEqual(h.opened(), 0, 'nor opened');
    }
    const wrong = arm(session);
    await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST', headers: { 'x-nv-step-up': wrong } }), {}, { ...operation, action: 'branch.reset' }),
      error => error.status === 403, 'another action');
    await assert.rejects(h.security.consumeStepUpAuthorization(request({ session, method: 'POST', headers: { 'x-nv-step-up': wrong } }), {}, { ...operation, scope: { repo: 'acme/other' } }),
      error => error.status === 403, 'another scope');
  }

  /* The offline cache's scope: this session and this identity. */
  {
    const { security } = harness();
    const withCookie = (cookie, gh = alice, session) => ({ headers: cookie ? { cookie } : {}, gh, method: 'GET', ...(session ? { session } : {}) });
    const scopeOf = (binding, identity = alice) => crypto.createHmac('sha256', OFFLINE_KEY).update(`${binding}|${identityKey(identity)}`).digest('base64url').slice(0, 32);
    const sid = 'f'.repeat(48);
    const sidCookie = `nv_session=${seal({ sid })}`;
    const expected = scopeOf(sid);
    assert.strictEqual(security.offlineCacheScope(withCookie(sidCookie)), expected, 'a session the database keeps is named by its id');
    assert.notStrictEqual(security.offlineCacheScope(withCookie(sidCookie, { login: 'bob' })), expected, 'another identity, another scope');
    /* A session its cookie alone keeps is named by its nonce, however often the cookie is sealed again. */
    const nonce = 'a'.repeat(48);
    const kept = { accounts: [alice], security: { sessionNonce: nonce } };
    const sealed = [seal(kept), seal(kept)];
    assert.notStrictEqual(sealed[0], sealed[1], 'the cookie is sealed afresh on every write');
    const scopes = sealed.map(cookie => security.offlineCacheScope(withCookie(`nv_session=${cookie}`, alice, kept)));
    assert.deepStrictEqual(scopes, [scopeOf(nonce), scopeOf(nonce)], 'a session its cookie keeps is named by its nonce, whichever cookie carries it');
    assert.strictEqual(security.offlineCacheScope(withCookie(sidCookie, alice, kept)), expected, 'a session id, where there is one, names the session');
    const other = { accounts: [alice], security: { sessionNonce: 'b'.repeat(48) } };
    assert.notStrictEqual(security.offlineCacheScope(withCookie(`nv_session=${seal(other)}`, alice, other)), scopes[0], 'another session, another scope');
    const bare = { accounts: [alice] };
    assert.strictEqual(security.offlineCacheScope(withCookie(`nv_session=${seal(bare)}`, alice, bare)), '', 'a session with neither an id nor a nonce has no scope');
    assert.deepStrictEqual(bare, { accounts: [alice] }, 'and asking leaves it as it was');
    const malformed = { accounts: [alice], security: { sessionNonce: 'not-a-nonce' } };
    assert.strictEqual(security.offlineCacheScope(withCookie(`nv_session=${seal(malformed)}`, alice, malformed)), '', 'nor does one whose nonce is malformed');
    assert.strictEqual(security.offlineCacheScope(withCookie('')), '', 'nor a request with no session at all');
    assert.strictEqual(security.offlineCacheScope(withCookie(sidCookie, null)), '', 'no identity, no scope');

    /* The binding: a private-cache GET whose headers name this scope and the repository in its path. */
    const scope = security.offlineCacheScope(withCookie(sidCookie));
    /* As Express hands a middleware mounted at /api: the URL relative to the mount, the original whole. */
    const bound = (url, repo, overrides = {}) => security.offlineCacheResponseBinding({
      method: 'GET', gh: alice, originalUrl: url, url: typeof url === 'string' ? url.replace(/^\/api/, '') : url,
      headers: { cookie: sidCookie, 'x-nv-offline-scope': scope, 'x-nv-offline-repo': repo }, ...overrides
    });
    assert.deepStrictEqual(bound('/api/repos', 'account'), { scope, repoKey: 'account' });
    assert.deepStrictEqual(bound('/api/repo/Acme/Demo/tree/main', 'github:acme/demo'), { scope, repoKey: 'github:acme/demo' }, 'the repository by its lower-case name');
    assert.deepStrictEqual(bound('/api/repo/%61cme/D%65mo/tree/main', 'github:acme/demo'), { scope, repoKey: 'github:acme/demo' }, 'the repository by its decoded name');
    assert.strictEqual(bound('/api/repo/acme/demo/tree/main', 'github:acme/other'), null, 'another repository');
    assert.strictEqual(bound('/api/repo/acme/demo/tree/main', 'account'), null);
    assert.strictEqual(bound('/api/repos', 'account', { headers: { cookie: sidCookie, 'x-nv-offline-scope': 'Z'.repeat(32), 'x-nv-offline-repo': 'account' } }), null, 'another scope');
    assert.strictEqual(bound('/api/repos', 'account', { method: 'POST' }), null);
    assert.strictEqual(bound('/api/repos', 'account', { gh: null }), null);
    assert.strictEqual(bound('/api/me', 'account'), null, 'not a cacheable path');
    assert.strictEqual(bound('/api/repo/acme/demo/raw/x', 'github:acme/demo'), null, 'a sensitive path');
    assert.strictEqual(bound('/api/repo/%E0%A4%A/demo/tree', 'github:x/demo'), null, 'a path that does not decode');
    assert.deepStrictEqual(bound(undefined, 'account', { url: '/api/repos', originalUrl: undefined }), { scope, repoKey: 'account' }, 'the URL when there is no original');
  }

  finished = true;
  console.log('session security tests passed');
}

let finished = false;
process.on('exit', () => {
  if (finished) return;
  console.error('session security tests did not finish');
  process.exitCode = 1;
});
main().catch(error => { console.error(error); process.exit(1); });
