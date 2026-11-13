'use strict';
/*
 * The guards a request passes before a route reads or changes anything
 * (identity-access's request guards): which session and account they attach,
 * what each checks and in what order, what they refuse and how they answer.
 */
const assert = require('assert');
const { createRequestGuards } = require('../apps/api/src/modules/identity-access/index.ts');
const { guardSafety } = require('../apps/api/src/modules/corona/index.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the request guard tests did not finish'); process.exitCode = 1; } });

const alice = { provider: 'github', login: 'alice', token: 't-alice' };
const bob = { provider: 'github', login: 'bob', token: 't-bob' };
const retired = { provider: 'gitlab', login: 'old', token: 't-old', baseUrl: 'https://gitlab.com' };

function harness(options = {}) {
  const calls = [];
  const settings = { stored: { accounts: [alice], active: 0 }, safety: {}, ...options };
  const guards = createRequestGuards({
    sessionOf: async (req, opts) => { calls.push(['sessionOf', opts]); if (settings.stored instanceof Error) throw settings.stored; return settings.stored; },
    resolveAccount: async account => { calls.push(['resolve', account.login]); if (settings.resolve) return settings.resolve(account); return { ...account, token: 'minted' }; },
    ensureSessionSecurity: async (req, res) => { calls.push(['security', res.id]); if (settings.security) throw settings.security; },
    verifyRequestCsrf: req => { calls.push(['csrf', req.method]); if (settings.csrf) throw settings.csrf; },
    consumeStepUpAuthorization: async (req, res, operation) => { calls.push(['stepUp', operation]); if (settings.stepUp) throw settings.stepUp; },
    loadSafety: async req => { calls.push(['safety', req.gh.login]); if (settings.safety instanceof Error) throw settings.safety; return settings.safety; },
    guardSafety: req => { const out = guardSafety(req); calls.push(['guard', out]); return out; }
  });
  return { guards, calls, settings };
}

async function run(guard, h, req) {
  const answer = { next: 0 };
  const res = { id: 'res', status(code) { answer.status = code; return res; }, json(body) { answer.body = body; return 'json'; } };
  answer.returned = await h.guards[guard](req, res, () => { answer.next += 1; });
  return answer;
}
const request = (extra = {}) => ({ method: 'GET', path: '/api/repos', params: {}, body: {}, ...extra });
const names = calls => calls.map(call => call[0]);

(async () => {
  /* ---- providerSessionAccess --------------------------------------------------------- */
  {
    const h = harness();
    const req = request();
    const answer = await run('providerSessionAccess', h, req);
    assert.deepStrictEqual([answer.next, answer.returned], [1, undefined]);
    assert.deepStrictEqual(h.calls, [['sessionOf', { retainRetiredAccounts: false }]], 'a read checks nothing more than the session');
    assert.strictEqual(req.session, h.settings.stored);
    assert.deepStrictEqual(req.gh, alice);
    assert.notStrictEqual(req.gh, req.sessionAccount, 'the request\'s account is a copy, so resolving it never changes the session\'s');

    const attached = request({ session: { accounts: [bob], active: 0 } });
    const own = harness();
    await run('providerSessionAccess', own, attached);
    assert.deepStrictEqual(own.calls, [], 'a session already attached is used as it is');
    assert.strictEqual(attached.gh.login, 'bob');

    for (const [active, login] of [[1, 'bob'], [5, 'bob'], [undefined, 'alice'], [0, 'alice']]) {
      const pickReq = request();
      await run('providerSessionAccess', harness({ stored: { accounts: [alice, bob], active } }), pickReq);
      assert.strictEqual(pickReq.gh.login, login, `active ${active}`);
    }

    const signedOut = await run('providerSessionAccess', harness({ stored: null }), request());
    assert.deepStrictEqual([signedOut.status, signedOut.body, signedOut.next], [401, { error: 'Not signed in', code: 'AUTH_REQUIRED' }, 0]);
    const selection = await run('providerSessionAccess', harness({ stored: { accounts: [retired, alice], active: 1, retiredSelection: true } }), request());
    assert.deepStrictEqual([selection.status, selection.body], [409, { error: 'The selected account is no longer supported. Choose a GitHub account.', code: 'ACCOUNT_SELECTION_REQUIRED' }]);
    const old = await run('providerSessionAccess', harness({ stored: { accounts: [retired], active: 0 } }), request());
    assert.strictEqual(old.next, 0, 'a retired account never reaches a provider route');
    assert(old.status >= 400 && old.status < 500);
    const bare = await run('providerSessionAccess', harness({ stored: Object.assign(new Error(''), {}) }), request());
    assert.deepStrictEqual([bare.status, bare.body], [500, { error: 'Security check failed' }], 'a failure with nothing to say');
    const coded = await run('providerSessionAccess', harness({ stored: Object.assign(new Error('store down'), { status: 503, code: 'SESSION_STORE_UNAVAILABLE' }) }), request());
    assert.deepStrictEqual([coded.status, coded.body], [503, { error: 'store down', code: 'SESSION_STORE_UNAVAILABLE' }]);
  }

  /* ---- auth ------------------------------------------------------------------------- */
  {
    const h = harness();
    const req = request({ method: 'POST', path: '/api/repo/alice/demo/contents', params: { owner: 'alice', repo: 'demo' }, body: { path: 'README.md' } });
    const answer = await run('auth', h, req);
    assert.deepStrictEqual([answer.next, answer.returned], [1, undefined]);
    assert.deepStrictEqual(names(h.calls), ['sessionOf', 'resolve', 'security', 'csrf', 'safety', 'guard'], 'every check, in order');
    assert.deepStrictEqual(h.calls[2], ['security', 'res']);
    assert.strictEqual(req.gh.token, 'minted', 'the request carries the resolved credential');
    assert.strictEqual(req.sessionAccount.token, 't-alice');
    assert.deepStrictEqual(req.effectiveSafety, {});

    const locked = harness({ safety: { readOnly: true } });
    const refused = await run('auth', locked, request({ method: 'POST', path: '/api/repo/alice/demo/contents', params: { owner: 'alice', repo: 'demo' } }));
    assert.deepStrictEqual([refused.status, refused.body, refused.next, refused.returned], [423, { error: 'Read-only mode is on — writes are disabled. Turn it off in Safeguards.', locked: true }, 0, 'json']);
    const fromSession = harness({ safety: undefined });
    const sessionLocked = await run('auth', fromSession, request({ method: 'POST', path: '/api/repo/alice/demo/contents', params: { owner: 'alice' }, session: { accounts: [alice], active: 0, safety: { readOnly: true } } }));
    assert.strictEqual(sessionLocked.status, 423, 'with nothing loaded, the session\'s copy applies');

    const merge = harness();
    const mergeReq = request({ method: 'PUT', path: '/api/repo/alice/demo/pulls/3/merge', params: { owner: 'alice', repo: 'demo', num: '3' }, body: { method: 'squash' } });
    await run('auth', merge, mergeReq);
    assert.deepStrictEqual(merge.calls.at(-1), ['stepUp', { action: 'pull.merge', scope: { provider: 'github', owner: 'alice', repo: 'demo', pullNumber: 3, method: 'squash' } }], 'a sensitive operation spends a step-up grant for exactly what it does');
    const revoke = harness();
    await run('auth', revoke, request({ method: 'POST', path: '/api/security/revoke-others' }));
    assert.deepStrictEqual(revoke.calls.at(-1)[1].action, 'sessions.revoke-others');
    const unnamed = harness({ resolve: account => ({ login: account.login }) });
    await run('auth', unnamed, request({ method: 'DELETE', path: '/api/repo/alice/demo', params: { owner: 'alice', repo: 'demo' } }));
    assert.deepStrictEqual(unnamed.calls.at(-1), ['stepUp', { action: 'repository.delete', scope: { provider: 'github', owner: 'alice', repo: 'demo' } }], 'an account without a provider is GitHub\'s');
    const providerOf = harness({ resolve: account => ({ ...account, provider: 'gitea' }) });
    const unsupported = await run('auth', providerOf, request({ method: 'DELETE', path: '/api/repo/alice/demo', params: { owner: 'alice', repo: 'demo' } }));
    assert.deepStrictEqual([unsupported.status, unsupported.body, unsupported.next], [400, { error: 'Unsupported provider for step-up authorization', code: 'STEP_UP_SCOPE_INVALID' }, 0], 'the step-up names the resolved account\'s provider, and only GitHub\'s is accepted');
    assert(!names(providerOf.calls).includes('stepUp'));
    const read = harness();
    await run('auth', read, request({ method: 'GET', path: '/api/repo/alice/demo', params: { owner: 'alice', repo: 'demo' } }));
    assert(!names(read.calls).includes('stepUp'), 'a read needs no step-up');

    for (const [fault, step, expected] of [
      ['security', 'security', Object.assign(new Error('Session expired'), { status: 401, code: 'SESSION_EXPIRED' })],
      ['csrf', 'csrf', Object.assign(new Error('CSRF token required'), { status: 403, code: 'CSRF_REQUIRED' })],
      ['safety', 'safety', Object.assign(new Error('Safety controls could not be loaded'), { status: 503, code: 'SAFETY_STATE_UNAVAILABLE' })],
      ['stepUp', 'stepUp', Object.assign(new Error('Step-up required'), { status: 403, code: 'STEP_UP_REQUIRED' })]
    ]) {
      const f = harness({ [fault]: expected });
      const answer = await run('auth', f, request({ method: 'DELETE', path: '/api/repo/alice/demo', params: { owner: 'alice', repo: 'demo' } }));
      assert.deepStrictEqual([answer.status, answer.body, answer.next], [expected.status, { error: expected.message, code: expected.code }, 0], fault);
      assert.strictEqual(names(f.calls).at(-1), step, `${fault} is the last thing asked`);
    }
    const plain = await run('auth', harness({ csrf: new Error('') }), request());
    assert.deepStrictEqual([plain.status, plain.body], [500, { error: 'Security check failed' }]);
    const retiredAuth = harness({ stored: { accounts: [retired], active: 0 } });
    const retiredAnswer = await run('auth', retiredAuth, request());
    assert.strictEqual(retiredAnswer.next, 0);
    assert.deepStrictEqual(names(retiredAuth.calls), ['sessionOf'], 'a retired account is refused before its credential is resolved');
  }

  /* ---- accountAuth ------------------------------------------------------------------ */
  {
    const h = harness({ stored: { accounts: [retired], active: 0, retiredSelection: true } });
    const req = request({ method: 'POST', path: '/api/accounts/remove' });
    const answer = await run('accountAuth', h, req);
    assert.strictEqual(answer.next, 1, 'account management accepts a retired account, so it can be removed');
    assert.deepStrictEqual(names(h.calls), ['sessionOf', 'security', 'csrf', 'safety', 'guard'], 'without resolving a credential');
    assert.deepStrictEqual(h.calls[0], ['sessionOf', { retainRetiredAccounts: true }]);
    assert.strictEqual(req.gh.login, 'old');
    const csrf = await run('accountAuth', harness({ csrf: Object.assign(new Error('CSRF token required'), { status: 403, code: 'CSRF_REQUIRED' }) }), request({ method: 'POST', path: '/api/accounts/switch' }));
    assert.deepStrictEqual([csrf.status, csrf.body, csrf.next], [403, { error: 'CSRF token required', code: 'CSRF_REQUIRED' }, 0]);
    const locked = await run('accountAuth', harness({ safety: { readOnly: true } }), request({ method: 'POST', path: '/api/repo/alice/demo/contents', params: { owner: 'alice', repo: 'demo' } }));
    assert.deepStrictEqual([locked.status, locked.body.locked, locked.next], [423, true, 0]);
    const exempt = await run('accountAuth', harness({ safety: { readOnly: true } }), request({ method: 'POST', path: '/api/accounts/remove' }));
    assert.strictEqual(exempt.next, 1, 'account management stays reachable under read-only mode');
  }

  /* ---- signedOutWithoutGithub ----------------------------------------------------------- */
  {
    const h = harness();
    const out = (session) => {
      const answer = {};
      const res = { status(code) { answer.status = code; return res; }, json(body) { answer.body = body; } };
      answer.returned = h.guards.signedOutWithoutGithub({ session }, res);
      return answer;
    };
    assert.deepStrictEqual(out({ accounts: [retired, alice] }), { returned: false });
    for (const session of [{ accounts: [retired] }, { accounts: [] }, { accounts: 'x' }, null]) {
      assert.deepStrictEqual(out(session), { status: 401, body: { error: 'Not signed in', code: 'AUTH_REQUIRED' }, returned: true }, JSON.stringify(session));
    }
  }

  finished = true;
  console.log('Request guard tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
