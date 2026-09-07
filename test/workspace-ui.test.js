'use strict';

/*
 * The owner setup transport, exercised as the browser runs it. The module is
 * loaded into a sandbox with a recording fetch, so every assertion here is
 * about the request that would actually leave the page -- its path, method,
 * headers and body -- rather than about the shape of the source.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace-ui.js'), 'utf8');

function load(responder) {
  const calls = [];
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const reply = await responder(calls.length, { url, options });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (reply.invalidJson) throw new SyntaxError('Response body was interrupted');
        return reply.payload || {};
      }
    };
  };
  vm.runInNewContext(source, sandbox, { filename: 'workspace-ui.js' });
  return { ui: sandbox.window.NebulaWorkspaceUI, calls };
}

const SECRET = 'a'.repeat(43);
const sessionReply = (extra = {}) => ({ status: 200, payload: { authenticated: false, csrfToken: 'csrf-1', ...extra } });
const claimedReply = {
  status: 201,
  payload: {
    authenticated: true, csrfToken: 'csrf-2',
    context: { principalId: 'p1', workspaceId: 'w1', role: 'owner', connection: null }
  }
};

/* CommonJS: no top-level await, so the whole run is one async body. */
(async function main() {
/* A 404 from the router is the switched-off answer, and must read as off. */
{
  const { ui } = load(async () => ({ status: 404, payload: { code: 'WORKSPACE_FOUNDATION_DISABLED' } }));
  const result = await ui.probe();
  assert.strictEqual(result.available, false, 'a 404 must report the foundation as disabled');
  assert.strictEqual(result.authenticated, false);
  await assert.rejects(() => ui.claim({ token: 't', setupSecret: SECRET }), { code: 'WORKSPACE_FOUNDATION_DISABLED' });
}

/*
 * Unreachable is not disabled. A network failure that reported "off" would
 * hide the card from an owner whose deployment has the foundation enabled,
 * and it would do so silently.
 */
{
  const { ui } = load(async () => { throw new Error('offline'); });
  assert.strictEqual((await ui.probe()).available, null, 'a transport failure must stay unknown, never off');
  assert.strictEqual((await ui.probe()).authenticated, false);
}
{
  const { ui } = load(async () => ({ status: 503, payload: { code: 'WORKSPACE_UNAVAILABLE' } }));
  assert.strictEqual((await ui.probe()).available, null, 'a 503 must stay unknown, never off');
}

/* Setup: the request the server actually accepts. */
{
  const { ui, calls } = load(async n => (n === 1 ? sessionReply() : claimedReply));
  const result = await ui.claim({ provider: 'github', baseUrl: '', token: '  ghp_x  ', setupSecret: SECRET });

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, '/api/workspace/session');
  assert.strictEqual(calls[0].options.method, 'GET');

  const write = calls[1];
  assert.strictEqual(write.url, '/api/workspace/setup');
  assert.strictEqual(write.options.method, 'POST');
  assert.strictEqual(write.options.credentials, 'same-origin');
  assert.strictEqual(write.options.headers['x-nv'], '1');
  assert.strictEqual(write.options.headers['x-nv-csrf'], 'csrf-1',
    'the write must carry the token the workspace router issued, not the app session token');
  assert.strictEqual(write.body.token, 'ghp_x', 'the token must be trimmed before it is sent');
  assert.strictEqual(write.body.setupSecret, SECRET);
  assert.strictEqual('baseUrl' in write.body, false,
    'the server refuses a github request that carries a base URL at all, so an empty field must be absent');
  assert.deepStrictEqual(Object.keys(write.body).sort(), ['provider', 'setupSecret', 'token']);

  assert.strictEqual(result.authenticated, true);
  assert.strictEqual(result.context.workspaceId, 'w1');
  assert.strictEqual(ui.current().authenticated, true, 'the reply must be adopted as current state');
}

/* A self-hosted provider does carry its base URL. */
{
  const { ui, calls } = load(async n => (n === 1 ? sessionReply() : claimedReply));
  await ui.claim({ provider: 'gitea', baseUrl: ' https://gitea.example.com ', token: 't', setupSecret: SECRET });
  assert.strictEqual(calls[1].body.baseUrl, 'https://gitea.example.com');
  assert.deepStrictEqual(Object.keys(calls[1].body).sort(), ['baseUrl', 'provider', 'setupSecret', 'token']);
}

/*
 * A malformed credential is refused before it is sent. The server counts five
 * failures and then locks setup for fifteen minutes; spending one of those on
 * a typo is a real cost, so the shape is checked here first.
 */
{
  const { ui, calls } = load(async () => sessionReply());
  await assert.rejects(() => ui.claim({ token: 't', setupSecret: 'too-short' }), { code: 'WORKSPACE_INPUT_INVALID' });
  assert.strictEqual(calls.filter(c => c.url.endsWith('/setup')).length, 0,
    'a malformed setup credential must never reach the server');
}
{
  const { ui, calls } = load(async () => sessionReply());
  await assert.rejects(() => ui.signIn({ token: '   ' }), { code: 'WORKSPACE_INPUT_INVALID' });
  assert.strictEqual(calls.filter(c => c.url.endsWith('/sign-in')).length, 0,
    'an empty token must never reach the server');
}

/*
 * The challenge cookie behind an unauthenticated write lives five minutes, and
 * a person reading setup instructions will routinely take longer. A stale
 * challenge must be re-fetched and the write replayed, once.
 */
{
  let issued = 0;
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) { issued += 1; return sessionReply({ csrfToken: `csrf-${issued}` }); }
    return issued < 2 ? { status: 403, payload: { code: 'CSRF_EXPIRED' } } : claimedReply;
  });
  const result = await ui.claim({ token: 't', setupSecret: SECRET });
  assert.strictEqual(result.authenticated, true, 'an expired challenge must be recovered, not surfaced');
  const writes = calls.filter(c => c.url.endsWith('/setup'));
  assert.strictEqual(writes.length, 2, 'exactly one replay');
  assert.strictEqual(writes[0].options.headers['x-nv-csrf'], 'csrf-1');
  assert.strictEqual(writes[1].options.headers['x-nv-csrf'], 'csrf-2', 'the replay must use the newly issued token');
}

/* The replay is bounded. A server that always answers CSRF must not loop. */
{
  const { ui, calls } = load(async (n, call) => (call.url.endsWith('/session')
    ? sessionReply() : { status: 403, payload: { code: 'CSRF_INVALID' } }));
  await assert.rejects(() => ui.claim({ token: 't', setupSecret: SECRET }), { code: 'CSRF_INVALID' });
  assert.strictEqual(calls.filter(c => c.url.endsWith('/setup')).length, 2, 'at most one replay');
}

/* Refusals keep their code, so the card can explain the actual reason. */
{
  for (const [status, code] of [[403, 'WORKSPACE_SETUP_REJECTED'], [401, 'WORKSPACE_HUMAN_IDENTITY_REQUIRED'],
    [429, 'WORKSPACE_AUTH_RATE_LIMIT'], [502, 'WORKSPACE_PROVIDER_VERIFICATION_FAILED']]) {
    const { ui } = load(async (n, call) => (call.url.endsWith('/session') ? sessionReply() : { status, payload: { code } }));
    await assert.rejects(() => ui.claim({ token: 't', setupSecret: SECRET }), error => {
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.status, status);
      assert.strictEqual(error.message, ui.explain(code));
      assert.notStrictEqual(error.message, ui.explain('WORKSPACE_UNAVAILABLE'),
        `${code} must have its own explanation, not the generic one`);
      return true;
    });
  }
}

/* A refused attempt must not leave the card claiming an owner session. */
{
  const { ui } = load(async (n, call) => (call.url.endsWith('/session')
    ? sessionReply() : { status: 403, payload: { code: 'WORKSPACE_SETUP_REJECTED' } }));
  await assert.rejects(() => ui.claim({ token: 't', setupSecret: SECRET }));
  assert.strictEqual(ui.current().authenticated, false, 'a refusal must not authenticate the card');
  assert.strictEqual(ui.current().context, null);
}

/* Sign-out clears the local state as well as the server session. */
{
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) return sessionReply();
    if (call.url.endsWith('/setup')) return claimedReply;
    return { status: 200, payload: { ok: true } };
  });
  await ui.claim({ token: 't', setupSecret: SECRET });
  const result = await ui.signOut();
  assert.strictEqual(result.authenticated, false);
  assert.strictEqual(result.context, null);
  assert.strictEqual(result.available, true, 'signing out does not disable the foundation');
  const out = calls.find(c => c.url.endsWith('/sign-out'));
  assert.deepStrictEqual(out.body, {}, 'sign-out sends no fields; the router refuses any it did not name');
}

/* A lost reply cannot establish whether a write committed. Reconcile with a
 * credential-free session read, never by automatically repeating the write. */
for (const operation of ['setup', 'sign-in', 'sign-out']) {
  for (const failure of ['before-commit', 'after-commit', 'lost-cookie', 'invalid-json', 'invalid-payload', 'unavailable', 'offline']) {
    let authenticated = operation === 'sign-out';
    let committed = false;
    let interrupted = false;
    const { ui, calls } = load(async (n, call) => {
      if (call.options.method === 'GET') {
        if (interrupted && failure === 'offline') throw new TypeError('Offline');
        return authenticated ? { status: 200, payload: claimedReply.payload } : sessionReply();
      }
      interrupted = true;
      if (failure !== 'before-commit') {
        committed = true;
        authenticated = operation !== 'sign-out' && failure !== 'lost-cookie';
      }
      if (failure === 'invalid-json') return { status: 200, invalidJson: true };
      if (failure === 'invalid-payload') return { status: 200, payload: {} };
      if (failure === 'unavailable') return { status: 503, payload: { code: 'WORKSPACE_UNAVAILABLE' } };
      throw new TypeError('Response lost');
    });
    await ui.probe();
    const act = operation === 'setup' ? () => ui.claim({ token: 'ghp_example', setupSecret: SECRET })
      : operation === 'sign-in' ? () => ui.signIn({ token: 'ghp_example' }) : () => ui.signOut();
    await assert.rejects(act, error => {
      assert.match(error.code, /OUTCOME_UNKNOWN$/, `${operation}/${failure}: report an uncertain outcome`);
      assert.match(error.message, /may have completed/i);
      assert.doesNotMatch(error.message, /nothing was changed/i);
      if (operation === 'setup') assert.match(error.message, /signing in with the same provider account/i);
      return true;
    });
    assert.strictEqual(committed, failure !== 'before-commit');
    assert.strictEqual(calls.filter(c => c.options.method === 'POST').length, 1, 'never replay an ambiguous write');
    assert.strictEqual(calls.length, 3, 'one initial probe, one write, one recovery probe');
    const recovery = calls[2];
    assert.strictEqual(recovery.url, '/api/workspace/session');
    assert.strictEqual(recovery.options.method, 'GET');
    assert.strictEqual(recovery.body, null, 'recovery never resends credentials');
    assert.strictEqual(recovery.options.headers['x-nv-csrf'], undefined);
    assert.strictEqual(ui.current().authenticated, failure === 'offline' ? false : authenticated);
    assert.strictEqual(ui.current().available, failure === 'offline' ? null : true);
    assert.strictEqual(ui.current().outcomeUnknown, true, 'the card must retain the recovery explanation');
  }
}

/* Unknown preflight state cannot authorize sending a credential-bearing write. */
{
  const { ui, calls } = load(async () => { throw new TypeError('Offline'); });
  await assert.rejects(() => ui.signIn({ token: 'ghp_example' }), { code: 'WORKSPACE_UNAVAILABLE' });
  assert.strictEqual(calls.filter(c => c.options.method === 'POST').length, 0);
}

/* A later deliberate sign-in can recover setup whose cookie was lost. */
{
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) return sessionReply();
    if (call.url.endsWith('/setup')) throw new TypeError('Setup cookie lost');
    return { status: 200, payload: claimedReply.payload };
  });
  await assert.rejects(() => ui.claim({ token: 'ghp_example', setupSecret: SECRET }));
  const recovered = await ui.signIn({ token: 'ghp_example' });
  assert.strictEqual(recovered.authenticated, true);
  assert.strictEqual(recovered.outcomeUnknown, false);
  assert.strictEqual(calls.filter(c => c.url.endsWith('/setup')).length, 1);
  assert.strictEqual(calls.filter(c => c.url.endsWith('/sign-in')).length, 1);
}

/*
 * No request may ever carry the token or the setup credential outside the two
 * routes that verify them. Everything the module sends is checked, not just
 * the calls a particular test happened to make.
 */
{
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) return sessionReply();
    if (call.url.endsWith('/setup')) return claimedReply;
    return { status: 200, payload: { ok: true } };
  });
  await ui.claim({ provider: 'github', token: 'ghp_secret_value', setupSecret: SECRET });
  await ui.signOut();
  await ui.probe();
  for (const call of calls) {
    const serialised = JSON.stringify(call.body || {});
    if (call.url.endsWith('/setup')) continue;
    assert.strictEqual(serialised.includes('ghp_secret_value'), false, `${call.url} must not carry the token`);
    assert.strictEqual(serialised.includes(SECRET), false, `${call.url} must not carry the setup credential`);
  }
  assert.strictEqual(calls.some(c => c.options.headers && JSON.stringify(c.options.headers).includes('ghp_secret_value')),
    false, 'no header may carry the token');
}

/* Connection management uses the same isolated transport, never a token URL. */
{
  let selected = false;
  const connection = { id: 'c1', provider: 'github', instance: 'https://github.com', providerUserId: '99', login: 'git-account' };
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) return { status: 200, payload: claimedReply.payload };
    if (call.url.endsWith('/connections/connect')) return { status: 201, payload: { id: 'c1' } };
    if (call.url.endsWith('/connections/select')) {
      selected = true;
      return { status: 200, payload: { context: { ...claimedReply.payload.context, connection } } };
    }
    if (call.url.endsWith('/connections/disconnect')) return { status: 200, payload: { ok: true } };
    if (call.url.endsWith('/connections')) return { status: 200, payload: { connections: [{ ...connection, selected, credentialStored: true }] } };
    return { status: 200, payload: { repositories: [{ fullName: 'git-account/private', private: true }], hasMore: false } };
  });
  await ui.probe();
  await ui.connect({ provider: 'github', token: 'synthetic-connection-token', baseUrl: '' });
  assert.strictEqual(ui.current().context.connection, null, 'connecting never silently switches execution accounts');
  const result = await ui.selectConnection('c1');
  assert.strictEqual(result.context.principalId, 'p1');
  assert.strictEqual(result.context.connection.providerUserId, '99');
  assert.strictEqual((await ui.listConnections())[0].selected, true);
  assert.strictEqual((await ui.repositories()).repositories[0].fullName, 'git-account/private');
  await ui.disconnect('c1');
  assert.strictEqual(ui.current().context.connection, null);
  assert.strictEqual(ui.current().authenticated, true, 'disconnect is not owner sign-out');
  assert.deepStrictEqual(calls.find(c => c.url.endsWith('/connections/select')).body, { workspaceId: 'w1', connectionId: 'c1' });
  assert(calls.filter(c => c.options.method === 'GET').every(c => c.body === null));
  assert(!calls.some(c => c.url.includes('synthetic-connection-token')));
}

/* A connection may be stored before its reply is lost. Discover it by reading
 * the list; never replay a credential-bearing connect automatically. */
{
  let connected = false;
  const { ui, calls } = load(async (n, call) => {
    if (call.url.endsWith('/session')) return { status: 200, payload: claimedReply.payload };
    if (call.url.endsWith('/connections/connect')) { connected = true; throw new TypeError('Lost connection reply'); }
    return { status: 200, payload: { connections: connected ? [{ id: 'c1', credentialStored: true }] : [] } };
  });
  await ui.probe();
  await assert.rejects(() => ui.connect({ token: 'synthetic-connection-token' }), { code: 'WORKSPACE_OUTCOME_UNKNOWN' });
  assert.strictEqual(calls.filter(c => c.options.method === 'POST').length, 1);
  assert.strictEqual((await ui.listConnections())[0].credentialStored, true);
}

/* Every code the router can return is explainable. */
{
  const { ui } = load(async () => sessionReply());
  /*
   * Matched at the sites that actually produce a code, not on the bare name:
   * NV_WORKSPACE_FOUNDATION_ENABLED and the two setup variables are
   * configuration keys that share the prefix and are never sent to a reader.
   */
  const codeSite = /(?:workspaceError\(\s*'|code:\s*')(WORKSPACE_[A-Z_]+)'/g;
  const codes = new Set();
  for (const file of ['workspace-api.js', 'workspace-store.js', 'workspace-identity.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    for (const match of text.matchAll(codeSite)) codes.add(match[1]);
  }
  assert(codes.size >= 8, `expected the workspace modules to define refusal codes, found ${codes.size}`);
  const generic = ui.explain('WORKSPACE_UNAVAILABLE');
  const unexplained = [...codes]
    .filter(code => code !== 'WORKSPACE_UNAVAILABLE' && ui.explain(code) === generic).sort();
  assert.deepStrictEqual(unexplained, [],
    'a server refusal with no explanation reaches the reader as "something went wrong"');
}

  console.log('workspace UI transport tests passed');
})().catch(error => { console.error(error); process.exit(1); });
