'use strict';

/*
 * How the page asks its server (platform/transport.ts) and which reads it
 * keeps for offline use (platform/offline-repos.ts): asked of the modules,
 * against a stand-in server that records every request and answers from a
 * script, and a clock the test moves.
 */

const assert = require('node:assert/strict');
const { createTransport, statusMessage } = require('../apps/web/src/platform/transport.ts');
const offline = require('../apps/web/src/platform/offline-repos.ts');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* A stand-in server: each path answers from its queue, or 200 {} when the queue is empty. */
function harness({ identity = null, storage = null, storageThrows = false } = {}) {
  const requests = [];
  const queues = new Map();
  const effects = [];
  const clock = { now: Date.UTC(2026, 10, 15, 12) };
  const gates = new Map();
  const answer = (path, response) => { if (!queues.has(path)) queues.set(path, []); queues.get(path).push(response); };
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (gates.has(url)) await gates.get(url);
    const queue = queues.get(url) || [];
    const response = queue.length ? queue.shift() : { status: 200, json: {} };
    const headers = new Map(Object.entries(response.headers || {}));
    return {
      ok: response.status >= 200 && response.status < 300, status: response.status,
      headers: { get: name => (headers.has(name) ? headers.get(name) : null) },
      json: async () => { if (!('json' in response)) throw new SyntaxError('Unexpected token <'); return response.json; }
    };
  };
  const transport = createTransport({
    fetch, identity: () => identity, now: () => clock.now,
    storage: () => { if (storageThrows) throw new Error('SecurityError'); return storage; },
    onBranchChanged: () => effects.push('branch'),
    /* Clearing takes a turn of the event loop, as the page's own (storage, caches) does. */
    onAlphaEnded: async code => { await new Promise(setImmediate); effects.push(`ended:${code}`); }
  });
  const token = (value = 't1', inMs = 3600e3) => answer('/api/security/csrf', { status: 200, json: { token: value, expiresAt: new Date(clock.now + inMs).toISOString() } });
  const gate = url => { let open; gates.set(url, new Promise(resolve => { open = resolve; })); return () => { gates.delete(url); open(); }; };
  return { transport, requests, answer, token, effects, clock, gate, paths: () => requests.map(r => r.url) };
}

/* ---- What a status means without the server's JSON ---------------------------------------- */
test('the edge\'s statuses are said for what they mean', () => {
  assert.match(statusMessage(429, false), /hosting edge is limiting/);
  for (const status of [502, 503, 504, 520, 527]) assert.match(statusMessage(status, false), /did not answer in time/, String(status));
  for (const status of [500, 519, 528, 404]) assert.equal(statusMessage(status, false), `Request failed (${status})`);
  assert.equal(statusMessage(429, true), 'Request failed (429)', 'the server\'s own refusal is its own');
  assert.equal(statusMessage(503, true), 'Request failed (503)');
});

/* ---- A read ----------------------------------------------------------------------------------- */
test('a read goes same-origin, uncached, marked as the page\'s, with no token', async () => {
  const h = harness();
  h.answer('/api/me', { status: 200, json: { login: 'alice' } });
  assert.deepEqual(await h.transport.api('/api/me'), { login: 'alice' });
  assert.deepEqual(h.requests, [{ url: '/api/me', init: { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'x-nv': '1' } } }]);
});

test('a caller\'s headers, cache mode and signal go with it; the page\'s mark is its own', async () => {
  const h = harness();
  const controller = new AbortController();
  await h.transport.api('/api/me', { headers: { 'x-a': '1', 'x-nv': 'mine' }, cache: 'reload', signal: controller.signal });
  const { init } = h.requests[0];
  assert.equal(init.cache, 'reload');
  assert.equal(init.signal, controller.signal);
  assert.deepEqual(init.headers, { 'x-a': '1', 'x-nv': '1' });
});

/* ---- A write ---------------------------------------------------------------------------------- */
test('a write asks for a token first and carries it, with its body as JSON', async () => {
  const h = harness();
  h.token('tok-1');
  await h.transport.api('/api/repo/a/b/file', { method: 'put', body: { path: 'x' } });
  assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/repo/a/b/file']);
  assert.deepEqual(h.requests[0].init, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'x-nv': '1' } });
  assert.deepEqual(h.requests[1].init, {
    method: 'PUT', credentials: 'same-origin', cache: 'no-store',
    headers: { 'x-nv': '1', 'x-nv-csrf': 'tok-1', 'Content-Type': 'application/json' }, body: '{"path":"x"}'
  });
});

test('a caller\'s step-up grant goes beside the token', async () => {
  const h = harness();
  h.token('tok');
  await h.transport.api('/api/repo/a/b', { method: 'DELETE', headers: { 'x-nv-step-up': 'grant-1' } });
  assert.deepEqual(h.requests[1].init.headers, { 'x-nv-step-up': 'grant-1', 'x-nv': '1', 'x-nv-csrf': 'tok' });
});

test('the sign-in itself needs no token; HEAD and OPTIONS are reads', async () => {
  const h = harness();
  await h.transport.api('/api/login', { method: 'POST', body: { token: 'x' } });
  await h.transport.api('/api/me', { method: 'HEAD' });
  await h.transport.api('/api/me', { method: 'options' });
  assert.deepEqual(h.paths(), ['/api/login', '/api/me', '/api/me']);
  assert.equal(h.requests[0].init.headers['x-nv-csrf'], undefined);
});

test('a token is used until half a minute before it lapses, then asked for again', async () => {
  const h = harness();
  h.token('first', 60e3);
  await h.transport.api('/api/a', { method: 'POST' });
  h.clock.now += 29e3;
  await h.transport.api('/api/a', { method: 'POST' });
  h.clock.now += 2e3;
  h.answer('/api/security/csrf', { status: 200, json: { token: 'second', expiresAt: h.clock.now + 3600e3 } });
  await h.transport.api('/api/a', { method: 'POST' });
  assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/a', '/api/a', '/api/security/csrf', '/api/a']);
  assert.equal(h.requests[4].init.headers['x-nv-csrf'], 'second');
  /* An expiry given as milliseconds is read as milliseconds. */
  await h.transport.api('/api/a', { method: 'POST' });
  assert.equal(h.paths().filter(p => p === '/api/security/csrf').length, 2);
});

test('a token with no expiry is used once', async () => {
  const h = harness();
  h.answer('/api/security/csrf', { status: 200, json: { token: 'x' } });
  h.answer('/api/security/csrf', { status: 200, json: { token: 'y' } });
  await h.transport.api('/api/a', { method: 'POST' });
  await h.transport.api('/api/a', { method: 'POST' });
  assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/a', '/api/security/csrf', '/api/a']);
  assert.deepEqual(h.requests.filter(r => r.url === '/api/a').map(r => r.init.headers['x-nv-csrf']), ['x', 'y']);
});

test('a token refused is said with its status and code, and nothing is sent', async () => {
  const h = harness();
  h.answer('/api/security/csrf', { status: 503, json: { error: 'Session store unavailable', code: 'STORE_DOWN' } });
  await assert.rejects(h.transport.api('/api/a', { method: 'POST' }), error => {
    assert.deepEqual({ message: error.message, status: error.status, code: error.code }, { message: 'Session store unavailable', status: 503, code: 'STORE_DOWN' });
    assert.equal('edge' in error, false, 'only its status and code');
    return true;
  });
  h.answer('/api/security/csrf', { status: 200, json: { token: '' } });
  await assert.rejects(h.transport.ensureCsrfToken(), { message: 'Unable to establish the request security context', status: 200, code: '' });
  /* A refusal that names a token anyway is still a refusal. */
  h.answer('/api/security/csrf', { status: 500, json: { token: 'stray' } });
  await assert.rejects(h.transport.ensureCsrfToken(), { status: 500 });
  assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/security/csrf', '/api/security/csrf']);
});

test('a write refused for its token is sent once more with a new one, and only once', async () => {
  for (const code of ['CSRF_REQUIRED', 'CSRF_INVALID', 'CSRF_EXPIRED']) {
    const h = harness();
    h.token('old'); h.token('new');
    h.answer('/api/a', { status: 403, json: { code } });
    h.answer('/api/a', { status: 200, json: { ok: 1 } });
    assert.deepEqual(await h.transport.api('/api/a', { method: 'POST' }), { ok: 1 });
    assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/a', '/api/security/csrf', '/api/a'], code);
    assert.equal(h.requests[3].init.headers['x-nv-csrf'], 'new');
  }
  const h = harness();
  h.token('a'); h.token('b');
  h.answer('/api/a', { status: 403, json: { code: 'CSRF_INVALID', error: 'first' } });
  h.answer('/api/a', { status: 403, json: { code: 'CSRF_INVALID', error: 'second' } });
  await assert.rejects(h.transport.api('/api/a', { method: 'POST' }), { message: 'second', code: 'CSRF_INVALID' });
  assert.equal(h.paths().length, 4);
  /* Another refusal is not retried; nor is a refused sign-in. */
  const other = harness();
  other.token();
  other.answer('/api/a', { status: 403, json: { code: 'POLICY' } });
  await assert.rejects(other.transport.api('/api/a', { method: 'POST' }), { code: 'POLICY' });
  other.answer('/api/login', { status: 403, json: { code: 'CSRF_INVALID' } });
  await assert.rejects(other.transport.api('/api/login', { method: 'POST' }), { code: 'CSRF_INVALID' });
  assert.deepEqual(other.paths(), ['/api/security/csrf', '/api/a', '/api/login']);
});

test('writes made together share one request for a token', async () => {
  const h = harness();
  const open = h.gate('/api/security/csrf');
  h.token('shared');
  const writes = [h.transport.api('/api/a', { method: 'POST' }), h.transport.api('/api/b', { method: 'POST' }), h.transport.ensureCsrfToken()];
  await new Promise(setImmediate);
  open();
  const [, , token] = await Promise.all(writes);
  assert.equal(token, 'shared');
  assert.deepEqual(h.paths().filter(p => p === '/api/security/csrf'), ['/api/security/csrf']);
  assert.deepEqual(h.requests.filter(r => r.url !== '/api/security/csrf').map(r => r.init.headers['x-nv-csrf']), ['shared', 'shared']);
});

test('a token asked for before the session changed is not kept after it', async () => {
  const h = harness();
  const open = h.gate('/api/security/csrf');
  h.token('before');
  const asked = h.transport.ensureCsrfToken();
  await new Promise(setImmediate);
  /* The account changes while the token is on its way: the page forgets the session's token. */
  h.transport.clearCsrfToken();
  open();
  assert.equal(await asked, 'before', 'the caller that asked still hears its answer');
  h.token('after');
  await h.transport.api('/api/a', { method: 'POST' });
  assert.deepEqual(h.paths(), ['/api/security/csrf', '/api/security/csrf', '/api/a']);
  assert.equal(h.requests[2].init.headers['x-nv-csrf'], 'after', 'the token asked before the change is not used after it');
});

test('a sign-in, sign-out or account change forgets the token once it succeeds', async () => {
  for (const path of ['/api/login', '/api/logout', '/api/accounts/switch', '/api/accounts/switch-idx', '/api/accounts/remove']) {
    const h = harness();
    h.token('a'); h.token('b');
    await h.transport.api('/api/a', { method: 'POST' });
    await h.transport.api(path, { method: 'POST' });
    await h.transport.api('/api/a', { method: 'POST' });
    /* The first token serves the write and the change itself; the next write asks for another. */
    assert.equal(h.paths().filter(p => p === '/api/security/csrf').length, 2, path);
    assert.equal(h.requests[h.requests.length - 1].init.headers['x-nv-csrf'], 'b', path);
  }
  /* A refused one forgets nothing. */
  const h = harness();
  h.token('a');
  await h.transport.api('/api/a', { method: 'POST' });
  h.answer('/api/logout', { status: 500, json: {} });
  await assert.rejects(h.transport.api('/api/logout', { method: 'POST' }));
  await h.transport.api('/api/a', { method: 'POST' });
  assert.equal(h.paths().filter(p => p === '/api/security/csrf').length, 1);
  /* A path that only begins like one is not one. */
  const near = harness();
  near.token('a');
  await near.transport.api('/api/a', { method: 'POST' });
  await near.transport.api('/api/logout/now', { method: 'POST' });
  await near.transport.api('/api/a', { method: 'POST' });
  assert.equal(near.paths().filter(p => p === '/api/security/csrf').length, 1);
});

/* ---- A refusal ------------------------------------------------------------------------------- */
test('a refusal carries what the server said of it', async () => {
  const h = harness();
  h.answer('/api/a', {
    status: 409, headers: { 'retry-after': '12', 'x-nebulaverse-correlation-id': 'from-header' },
    json: { error: 'Branch moved', code: 'POLICY', correlationId: 'from-body', providerChanged: 'partial', safeState: 'unchanged', nextAction: 'retry', safePassage: { available: true, path: 'a' } }
  });
  await assert.rejects(h.transport.api('/api/a'), error => {
    assert.ok(error instanceof Error);
    assert.deepEqual({ ...error, message: error.message }, {
      message: 'Branch moved', status: 409, code: 'POLICY', edge: false, retryAfter: 12, correlationId: 'from-body',
      providerChanged: 'partial', safeState: 'unchanged', nextAction: 'retry', safePassage: { available: true, path: 'a' }
    });
    return true;
  });
});

test('a refusal without the server\'s word is said by its status, and marked as the edge\'s', async () => {
  const h = harness();
  h.answer('/api/a', { status: 502, headers: { 'retry-after': 'soon', 'x-nebulaverse-correlation-id': 'edge-1' } });
  await assert.rejects(h.transport.api('/api/a'), error => {
    assert.match(error.message, /did not answer in time/);
    assert.deepEqual([error.edge, error.retryAfter, error.correlationId, error.code, error.providerChanged, error.safeState, error.nextAction, error.safePassage],
      [true, 0, 'edge-1', '', 'unknown', '', '', null]);
    return true;
  });
});

test('a refusal whose JSON is no record is still a refusal, not a TypeError', async () => {
  for (const json of [null, 7, 'denied', [1, 2]]) {
    const h = harness();
    h.answer('/api/a', { status: 500, json });
    await assert.rejects(h.transport.api('/api/a'), error => {
      assert.equal(error.message, 'Request failed (500)', JSON.stringify(json));
      assert.equal(error.edge, false);
      assert.equal(error.code, '');
      return true;
    });
  }
  /* A route to approval that is not a record is none; a list is kept as it came. */
  const h = harness();
  h.answer('/api/a', { status: 403, json: { safePassage: 'yes' } });
  await assert.rejects(h.transport.api('/api/a'), { safePassage: null });
  h.answer('/api/a', { status: 403, json: { safePassage: [1] } });
  await assert.rejects(h.transport.api('/api/a'), { safePassage: [1] });
});

test('a write refused because its branch moved has the repository read again', async () => {
  const h = harness();
  h.token();
  h.answer('/api/a', { status: 409, json: { code: 'BRANCH_CHANGED' } });
  await assert.rejects(h.transport.api('/api/a', { method: 'POST' }), { code: 'BRANCH_CHANGED' });
  assert.deepEqual(h.effects, ['branch']);
});

test('an ended alpha session clears the page before the refusal reaches the caller', async () => {
  for (const code of ['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED']) {
    const h = harness();
    h.answer('/api/a', { status: 401, json: { code } });
    await assert.rejects(h.transport.api('/api/a'), error => { assert.deepEqual(h.effects, [`ended:${code}`], 'already cleared when the caller hears'); return error.code === code; });
  }
  const h = harness();
  h.answer('/api/a', { status: 401, json: { code: 'AUTH_REQUIRED' } });
  await assert.rejects(h.transport.api('/api/a'));
  assert.deepEqual(h.effects, []);
});

/* ---- The memory of reads --------------------------------------------------------------------- */
test('a read kept in memory is answered from it while it is young', async () => {
  const h = harness();
  h.answer('/api/r', { status: 200, json: { n: 1 } });
  h.answer('/api/r', { status: 200, json: { n: 2 } });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 1 });
  h.clock.now += 44999;
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 1 }, 'forty-five seconds by default');
  h.clock.now += 1;
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 2 });
  h.answer('/api/r', { status: 200, json: { n: 3 } });
  h.clock.now += 1000;
  assert.deepEqual(await h.transport.apiCached('/api/r', 1000), { n: 3 }, 'or as long as asked');
  assert.equal(h.paths().length, 3);
});

test('a refused read is not kept; a write forgets every read; the page may forget or keep one', async () => {
  const h = harness();
  h.answer('/api/r', { status: 500, json: {} });
  await assert.rejects(h.transport.apiCached('/api/r'));
  h.answer('/api/r', { status: 200, json: { n: 1 } });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 1 });
  h.token();
  await h.transport.api('/api/w', { method: 'PATCH' });
  h.answer('/api/r', { status: 200, json: { n: 2 } });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 2 }, 'a write forgets what was read');
  h.transport.cache.clear();
  h.answer('/api/r', { status: 200, json: { n: 3 } });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 3 });
  h.transport.cache.set('/api/r', { n: 'kept' });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 'kept' });
  /* The memory is the page's alone: a plain read neither reads nor fills it. */
  h.answer('/api/r', { status: 200, json: { n: 4 } });
  assert.deepEqual(await h.transport.api('/api/r'), { n: 4 });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 'kept' });
});

test('two readers of one path at once share one request', async () => {
  const h = harness();
  const open = h.gate('/api/r');
  h.answer('/api/r', { status: 200, json: { n: 1 } });
  const first = h.transport.apiCached('/api/r');
  const second = h.transport.apiCached('/api/r', 1000);
  await new Promise(setImmediate);
  open();
  assert.deepEqual(await Promise.all([first, second]), [{ n: 1 }, { n: 1 }]);
  assert.deepEqual(h.paths(), ['/api/r']);
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 1 }, 'and the answer is kept');
  assert.deepEqual(h.paths(), ['/api/r']);
  /* A refusal is shared too, and nothing is kept of it. */
  const r = harness();
  const gate = r.gate('/api/r');
  r.answer('/api/r', { status: 500, json: {} });
  const a = r.transport.apiCached('/api/r');
  const b = r.transport.apiCached('/api/r');
  await new Promise(setImmediate);
  gate();
  await assert.rejects(a); await assert.rejects(b);
  r.answer('/api/r', { status: 200, json: { n: 2 } });
  assert.deepEqual(await r.transport.apiCached('/api/r'), { n: 2 });
  assert.deepEqual(r.paths(), ['/api/r', '/api/r']);
});

test('a read that set out before a write is not kept after it', async () => {
  const h = harness();
  const open = h.gate('/api/r');
  h.answer('/api/r', { status: 200, json: { n: 'before the write' } });
  const read = h.transport.apiCached('/api/r');
  await new Promise(setImmediate);
  h.token();
  await h.transport.api('/api/w', { method: 'POST' });
  /* A reader after the write does not wait on the read from before it. */
  h.answer('/api/r', { status: 200, json: { n: 'after the write' } });
  const after = h.transport.apiCached('/api/r');
  open();
  assert.deepEqual(await read, { n: 'before the write' }, 'its own reader still hears it');
  assert.deepEqual(await after, { n: 'after the write' });
  assert.deepEqual(await h.transport.apiCached('/api/r'), { n: 'after the write' }, 'and what is kept is from after the write');
  /* The page forgetting its memory does the same. */
  const p = harness();
  const gate = p.gate('/api/r');
  p.answer('/api/r', { status: 200, json: { n: 'stale' } });
  const stale = p.transport.apiCached('/api/r');
  await new Promise(setImmediate);
  p.transport.cache.clear();
  gate();
  await stale;
  p.answer('/api/r', { status: 200, json: { n: 'fresh' } });
  assert.deepEqual(await p.transport.apiCached('/api/r'), { n: 'fresh' });
});

/* ---- Reads kept for offline use ------------------------------------------------------------------ */
function store(entries = {}) {
  const items = new Map(Object.entries(entries));
  return { items, getItem: key => (items.has(key) ? items.get(key) : null), setItem: (key, value) => items.set(key, value) };
}

test('the offline list is the reader\'s own, a list of names, at most a hundred', () => {
  const me = { offlineCacheScope: 'scope-1', provider: 'GitHub' };
  assert.equal(offline.offlineRepoStorageKey(me), 'nv_offline_repos:scope-1');
  assert.equal(offline.offlineRepoStorageKey({}), '');
  assert.equal(offline.offlineRepoStorageKey(null), '');
  const many = Array.from({ length: 120 }, (_, i) => `github:o/r${i}`);
  assert.deepEqual(offline.offlineRepoList(me, store({ 'nv_offline_repos:scope-1': JSON.stringify([...many.slice(0, 2), 7, null]) })), many.slice(0, 2));
  assert.equal(offline.offlineRepoList(me, store({ 'nv_offline_repos:scope-1': JSON.stringify(many) })).length, 100);
  for (const garbage of ['not json', '{"a":1}', '"x"', 'null']) assert.deepEqual(offline.offlineRepoList(me, store({ 'nv_offline_repos:scope-1': garbage })), [], garbage);
  assert.deepEqual(offline.offlineRepoList(me, store({ 'nv_offline_repos:other': '["github:o/r"]' })), [], 'another reader\'s list is not theirs');
  assert.deepEqual(offline.offlineRepoList({}, store({ 'nv_offline_repos:': '["github:o/r"]' })), [], 'no scope, no list');
  assert.deepEqual(offline.offlineRepoList(me, null), []);
  assert.deepEqual(offline.offlineRepoList(me, { getItem() { throw new Error('blocked'); } }), []);
  assert.equal(offline.offlineRepoKey(me, 'Acme', 'Widget'), 'github:acme/widget');
  assert.equal(offline.offlineRepoKey({}, 'a', 'b'), 'github:a/b', 'GitHub where no provider is named');
  assert.deepEqual(offline.withOfflineRepo(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.deepEqual(offline.withOfflineRepo(['a', 'b'], 'a', true), ['a', 'b']);
  assert.deepEqual(offline.withOfflineRepo(['a', 'b'], 'a', false), ['b']);
  assert.equal(offline.withOfflineRepo(many, 'new', true).length, 100);
});

test('a read is marked for keeping only for a repository on the list, or the account\'s list while any is kept', () => {
  const me = { offlineCacheScope: 'sc', provider: 'github' };
  const kept = store({ 'nv_offline_repos:sc': JSON.stringify(['github:acme/widget', 'github:a b/c']) });
  const headers = (p, method = 'GET', who = me, storage = kept) => offline.offlineHeadersForPath(p, method, who, storage);
  assert.deepEqual(headers('/api/repos'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'account' });
  assert.deepEqual(headers('/api/repos?page=2'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'account' });
  assert.deepEqual(headers('/api/repos/starred'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'account' });
  assert.deepEqual(headers('/api/reposx'), {});
  assert.deepEqual(headers('/api/repo/acme/widget/tree'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'github:acme/widget' });
  assert.deepEqual(headers('/api/repo/Acme/Widget?ref=main'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'github:acme/widget' });
  assert.deepEqual(headers('/api/repo/a%20b/c/file'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'github:a b/c' }, 'names as they were before escaping');
  assert.deepEqual(headers('/api/repo/acme/other/tree'), {}, 'a repository not on the list');
  assert.deepEqual(headers('/api/repo/%E0%A4%A/c'), {}, 'an escape that does not decode names nothing');
  assert.deepEqual(headers('/api/me'), {});
  for (const method of ['POST', 'put', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) assert.deepEqual(headers('/api/repos', method), {}, `only GET: ${method}`);
  assert.deepEqual(headers('/api/repos', undefined), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'account' }, 'no method is a read');
  assert.deepEqual(headers('/api/repos', 'get'), { 'x-nv-offline-scope': 'sc', 'x-nv-offline-repo': 'account' });
  assert.deepEqual(headers('/api/repos', 'GET', { provider: 'github' }), {}, 'no scope');
  assert.deepEqual(headers('/api/repos', 'GET', me, store()), {}, 'nothing kept');
  assert.deepEqual(headers('/api/repo/acme/widget', 'GET', { offlineCacheScope: 'sc', provider: 'gitlab' }), {}, 'another provider\'s repository of that name');
});

test('the transport marks kept reads, and asks the rest unmarked when storage cannot be read', async () => {
  const me = { offlineCacheScope: 'sc' };
  const h = harness({ identity: me, storage: store({ 'nv_offline_repos:sc': '["github:acme/widget"]' }) });
  await h.transport.api('/api/repo/acme/widget/tree');
  assert.equal(h.requests[0].init.headers['x-nv-offline-repo'], 'github:acme/widget');
  const blocked = harness({ identity: me, storageThrows: true });
  await blocked.transport.api('/api/repo/acme/widget/tree');
  assert.deepEqual(blocked.requests[0].init.headers, { 'x-nv': '1' });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.log(`not ok - ${name}`); console.log(error); }
  }
  if (failed) { console.log(`${failed} of ${tests.length} transport checks failed`); process.exit(1); }
  console.log(`transport: ${tests.length} checks passed`);
})();
