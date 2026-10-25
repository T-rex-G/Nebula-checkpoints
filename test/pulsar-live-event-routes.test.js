'use strict';
/*
 * Pulsar's live events, as the module serves them (D12): the open-stream
 * registry, and the five routes over a database, a provider and the alpha's
 * records handed in. What these hold used to be read out of server.js's text;
 * here it is what the routes do.
 *
 *  - A stream is admitted only under the limits for its key and for the
 *    instance, and a session that ends closes its own streams, saying why.
 *  - A webhook the provider created but the server could not record is
 *    removed, and its row with it, so nothing delivers to a hook nobody holds.
 *  - In the invite-only alpha, connecting claims the webhook for the tester,
 *    and disconnecting runs through the cleanup record: ownership is decided
 *    before the provider is asked to delete anything, and a deletion is
 *    trusted only once a read-back finds the webhook gone.
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveHub, registerLiveEventRoutes, encodeEventCursor } = require('../apps/api/src/modules/pulsar/index.ts');

/* A stream's response: what was written to it, and whether it was ended. */
function client() {
  return { written: [], writableEnded: false, write(chunk) { this.written.push(String(chunk)); return true; }, end() { this.writableEnded = true; } };
}

/* The registry. */
{
  const hub = createLiveHub({ maxTotal: 3, maxPerKey: 2 });
  const [a, b, c, d] = [client(), client(), client(), client()];
  assert(hub.admits('repo-1'));
  hub.add('repo-1', a, 'sid-a');
  hub.add('repo-1', b, 'sid-b');
  assert(!hub.admits('repo-1'), 'two streams per repository and identity');
  assert(hub.admits('repo-2'));
  hub.add('repo-2', c, null);
  assert.equal(hub.count(), 3);
  assert(!hub.admits('repo-3'), 'three streams on the instance');

  hub.broadcast('repo-1', 'event: intelligence\ndata: {}\n\n');
  assert.deepEqual([a.written.length, b.written.length, c.written.length], [1, 1, 0], 'a delivery reaches its own key only');

  assert.equal(hub.closeSessions([null, '', 'sid-b', 'sid-unknown'], 'session-ended'), 1, 'only the named sessions, and never one without an id');
  assert(b.writableEnded && /event: session-revoked/.test(b.written.at(-1)) && /"reason":"session-ended"/.test(b.written.at(-1)));
  assert(!a.writableEnded);
  assert.equal(hub.count(), 2);

  hub.closeAlpha('repo-1', a);
  assert(a.writableEnded && /event: alpha-access-ended/.test(a.written.at(-1)));
  hub.remove('repo-2', c);
  assert.equal(hub.count(), 0);

  hub.add('repo-4', d, 'sid-d');
  hub.shutdown('SIGTERM');
  assert(d.writableEnded && /event: shutdown/.test(d.written.at(-1)) && /"signal":"SIGTERM"/.test(d.written.at(-1)));
  assert.equal(hub.count(), 0);
  assert.equal(hub.closeSessions(null), 0);
}

/* The routes, against a database, a provider and alpha records that record every call. */
function world(overrides = {}) {
  const calls = [];
  const settings = {
    alpha: false, ready: true, rows: [], backfill: null, hookCreate: { id: 91 }, hookDelete: 'ok', hookRead: 'gone',
    cleanupTask: { cleanupId: 'c1' }, inspection: { verified: false, shared: false }, completion: { verified: true }, events: [],
    ...overrides
  };
  const hash = reference => `hash:${reference}`;
  const deps = {
    providerSessionAccess: null, alphaRepositoryAccess: null, capabilityAccess: () => null, auth: null, mutationContext: () => null,
    account: req => req.gh,
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code || 'FAILED', error: error.message }),
    gh: async (account, apiPath, options = {}) => {
      const method = options.method || 'GET';
      calls.push(['gh', method, apiPath, options.body && options.body.config ? options.body.config.url : undefined]);
      if (apiPath.endsWith('/hooks')) {
        if (settings.hookCreate instanceof Error) throw settings.hookCreate;
        return settings.hookCreate;
      }
      const outcome = method === 'DELETE' ? settings.hookDelete : settings.hookRead;
      if (outcome === 'ok') return {};
      throw Object.assign(new Error(outcome), { status: outcome === 'gone' ? 404 : 502 });
    },
    dbReady: async () => settings.ready,
    pool: () => ({
      query: async (sql, params) => {
        calls.push(['sql', sql.trim().split(/\s+/)[0], ...params]);
        if (/FROM nv_webhooks/.test(sql)) return { rows: settings.rows };
        if (/RETURNING alpha_resource_key_hash/.test(sql)) return { rows: settings.backfill || [{ alpha_resource_key_hash: params[0] }] };
        if (/FROM nv_intelligence_events/.test(sql)) return { rows: settings.events };
        return { rows: [], rowCount: 1 };
      }
    }),
    identityKey: account => `github:${account.login}`,
    databaseConfigured: true,
    publicBase: () => 'https://nebulaverse.example',
    seal: value => `sealed(${Object.keys(value)})`,
    scopedEvidenceKey: (provider, owner, repo, identity) => `${provider}:${owner}/${repo}:${identity}`.toLowerCase(),
    appendEvidence: async (key, kind) => { calls.push(['evidence', kind]); },
    retainedActor: () => 'actor',
    providerResourceKeyHash: input => hash(input.resourceReference),
    providerAuthority: () => 'github.com',
    alphaEnabled: settings.alpha,
    alphaTesterId: req => req.alpha.testerId,
    alphaSessionId: () => 'alpha-session',
    readAlphaSession: async () => ({}),
    alphaWebhooks: settings.alpha ? {
      claimProviderWebhookOwnership: async input => { calls.push(['alpha.claim', input.resourceKeyHash]); },
      createCleanupTask: async () => { calls.push(['alpha.task']); return settings.cleanupTask; },
      inspectProviderWebhookCleanup: async () => { calls.push(['alpha.inspect']); return settings.inspection; },
      completeProviderWebhookCleanup: async input => { calls.push(['alpha.complete', input.providerVerifiedAbsent]); return settings.completion; }
    } : null,
    sessionSid: req => req.sid,
    hub: createLiveHub({ maxTotal: 10, maxPerKey: 1 })
  };
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) app[method] = (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers.at(-1));
  registerLiveEventRoutes(app, deps);
  const call = async (key, extra = {}) => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, headers: {}, written: [],
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      flushHeaders() {}, write(chunk) { this.written.push(String(chunk)); return true; }, end() { this.writableEnded = true; }
    });
    const req = Object.assign(new EventEmitter(), { gh: { provider: 'github', login: 'ann' }, params: { owner: 'Acme', repo: 'Demo' }, query: {}, sid: 'sid-1', alpha: { testerId: 'tester-1' }, ...extra });
    await routes.get(key)(req, res);
    return { status: res.statusCode, body: res.body, headers: res.headers, written: res.written, req, res };
  };
  return { calls, call, settings, deps };
}

(async () => {
  /* Status: GitHub only, the database's word, then the stored connection. */
  {
    const { call } = world({ rows: [{ active: true, created_at: '2026-09-01T00:00:00Z' }] });
    assert.deepEqual((await call('GET /api/repo/:owner/:repo/live-events/status')).body, { available: true, connected: true, createdAt: '2026-09-01T00:00:00Z' });
    assert.deepEqual((await call('GET /api/repo/:owner/:repo/live-events/status', { gh: { provider: 'gitlab', login: 'ann' } })).body.reason, 'GitHub-only in v5.2');
    assert.equal((await world({ ready: false }).call('GET /api/repo/:owner/:repo/live-events/status')).body.available, false);
  }

  /* Connecting: a sealed secret stored first, then the provider's webhook, delivering to this deployment. */
  {
    const { call, calls } = world();
    const connected = await call('POST /api/repo/:owner/:repo/live-events/connect');
    assert.deepEqual([connected.status, connected.body], [201, { available: true, connected: true }]);
    const insert = calls.find(entry => entry[0] === 'sql' && entry[1] === 'INSERT');
    assert.deepEqual(insert.slice(3), ['acme', 'demo', 'github:ann', 'sealed(secret)']);
    const created = calls.find(entry => entry[0] === 'gh');
    assert.deepEqual(created.slice(0, 3), ['gh', 'POST', '/repos/Acme/Demo/hooks']);
    assert.equal(created[3], `https://nebulaverse.example/hooks/github/${insert[2]}`, 'the provider delivers to the hook id the row holds');
    assert(calls.some(entry => entry[0] === 'evidence' && entry[1] === 'live-events-connected'));
  }

  /* A webhook the server could not record is removed, its row with it, and the refusal explained. */
  {
    const { call, calls } = world({ hookCreate: Object.assign(new Error('Forbidden'), { status: 403 }) });
    const refused = await call('POST /api/repo/:owner/:repo/live-events/connect');
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /Webhooks: write permission/);
    assert(calls.some(entry => entry[0] === 'sql' && entry[1] === 'DELETE'), 'the row is removed');
    const recordFails = world({ hookCreate: { id: 77 } });
    recordFails.deps.pool = () => ({
      query: async (sql, params) => {
        recordFails.calls.push(['sql', sql.trim().split(/\s+/)[0], ...params]);
        if (/^UPDATE/.test(sql.trim())) throw new Error('database lost');
        return { rows: [] };
      }
    });
    const routes = new Map();
    registerLiveEventRoutes({ get() {}, delete() {}, post: (route, ...handlers) => routes.set(route, handlers.at(-1)) }, recordFails.deps);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get('/api/repo/:owner/:repo/live-events/connect')({ gh: { provider: 'github', login: 'ann' }, params: { owner: 'Acme', repo: 'Demo' }, query: {} }, res);
    assert.equal(res.statusCode, 500);
    assert(recordFails.calls.some(entry => entry[0] === 'gh' && entry[1] === 'DELETE' && entry[2] === '/repos/Acme/Demo/hooks/77'),
      'the webhook the provider created is removed when the server cannot record it');
  }

  /* In the alpha, connecting claims the webhook for the tester; an existing connection is claimed and backfilled, not duplicated. */
  {
    const fresh = world({ alpha: true, hookCreate: { id: 91 } });
    assert.equal((await fresh.call('POST /api/repo/:owner/:repo/live-events/connect')).status, 201);
    assert(fresh.calls.some(entry => entry[0] === 'alpha.claim' && entry[1] === 'hash:91'));
    const existing = world({ alpha: true, rows: [{ hook_id: 'h1', provider_hook_id: 55, active: true, alpha_resource_key_hash: null }] });
    assert.equal((await existing.call('POST /api/repo/:owner/:repo/live-events/connect')).status, 409);
    assert(existing.calls.some(entry => entry[0] === 'sql' && entry[1] === 'UPDATE' && entry[2] === 'hash:55'), 'the stored row gains its resource key');
    assert(existing.calls.some(entry => entry[0] === 'alpha.claim' && entry[1] === 'hash:55'));
    assert(!existing.calls.some(entry => entry[0] === 'gh'), 'no second webhook');
  }

  /* Disconnecting outside the alpha: a webhook already gone is fine, and the row is removed. */
  {
    const { call, calls } = world({ rows: [{ hook_id: 'h1', provider_hook_id: 55 }], hookDelete: 'gone' });
    assert.deepEqual((await call('DELETE /api/repo/:owner/:repo/live-events')).body, { ok: true, disconnected: true });
    assert(calls.some(entry => entry[0] === 'sql' && entry[1] === 'DELETE'));
    assert.deepEqual((await world().call('DELETE /api/repo/:owner/:repo/live-events')).body, { ok: true, disconnected: false });
  }

  /* Disconnecting in the alpha: ownership first, then deletion, then a read-back that must find it gone. */
  {
    const proven = world({ alpha: true, rows: [{ hook_id: 'h1', provider_hook_id: 55, alpha_resource_key_hash: 'hash:55' }], hookDelete: 'ok', hookRead: 'gone' });
    assert.deepEqual((await proven.call('DELETE /api/repo/:owner/:repo/live-events')).body, { ok: true, disconnected: true });
    const order = proven.calls.map(entry => entry[0] === 'gh' ? `gh ${entry[1]}` : entry[0]).filter(step => step !== 'sql' && step !== 'evidence');
    assert.deepEqual(order, ['alpha.task', 'alpha.inspect', 'gh DELETE', 'gh GET', 'alpha.complete']);
    assert(proven.calls.some(entry => entry[0] === 'alpha.complete' && entry[1] === true));

    const stillThere = world({ alpha: true, rows: [{ hook_id: 'h1', provider_hook_id: 55, alpha_resource_key_hash: 'hash:55' }], hookDelete: 'ok', hookRead: 'ok' });
    const pending = await stillThere.call('DELETE /api/repo/:owner/:repo/live-events');
    assert.deepEqual([pending.status, pending.body], [202, { ok: false, status: 'pending', cleanupId: 'c1' }], 'a deletion the read-back contradicts is not trusted');
    assert(!stillThere.calls.some(entry => entry[0] === 'alpha.complete'));

    const shared = world({ alpha: true, rows: [{ hook_id: 'h1', provider_hook_id: 55, alpha_resource_key_hash: 'hash:55' }], inspection: { verified: false, shared: true } });
    assert.equal((await shared.call('DELETE /api/repo/:owner/:repo/live-events')).status, 200);
    assert(!shared.calls.some(entry => entry[0] === 'gh'), 'a webhook another tester also holds is not deleted from the provider');

    const foreign = world({ alpha: true, rows: [{ hook_id: 'h1', provider_hook_id: 55, alpha_resource_key_hash: 'hash:other' }] });
    assert.deepEqual((await foreign.call('DELETE /api/repo/:owner/:repo/live-events')).body, { ok: false, status: 'pending' }, 'a row recorded under another resource is left alone');
  }

  /* Stored events, a page at a time: newest first without a cursor, and a cursor that continues after the last read. */
  {
    const events = Array.from({ length: 3 }, (_, index) => ({ event_id: `e${index}`, event_type: 'push', created_at: `2026-09-0${index + 1}T00:00:00.000Z`, reasons: null, paths: null, metadata: null }));
    const page = await world({ events }).call('GET /api/repo/:owner/:repo/intelligence/events', { query: { limit: '2' } });
    assert.equal(page.body.truncatedBefore, true);
    assert.deepEqual(page.body.events.map(event => event.id), ['e1', 'e0'], 'the newest page, oldest first');
    assert.equal(page.body.cursor, encodeEventCursor('2026-09-01T00:00:00.000Z', 'e0'));
    const after = world({ events });
    await after.call('GET /api/repo/:owner/:repo/intelligence/events', { query: { after: encodeEventCursor('2026-09-01T00:00:00.000Z', 'e0') } });
    assert.deepEqual(after.calls.find(entry => entry[0] === 'sql').slice(-2), ['2026-09-01T00:00:00.000Z', 'e0']);
    assert.equal((await world({ ready: false }).call('GET /api/repo/:owner/:repo/intelligence/events')).body.available, false);
  }

  /* The stream: admitted under the limit, ready at once, forgotten when its reader goes. */
  {
    const { call, deps } = world();
    const stream = await call('GET /api/repo/:owner/:repo/live-events/stream');
    assert.equal(stream.headers['content-type'], 'text/event-stream');
    assert.match(stream.written[0], /^event: ready\ndata: \{"repository":"Acme\/Demo"/);
    assert.equal(deps.hub.count(), 1);
    const second = await call('GET /api/repo/:owner/:repo/live-events/stream');
    assert.equal(second.status, 429, 'one stream per repository and identity here');
    assert.equal(deps.hub.closeSessions(['sid-1'], 'session-ended'), 1, 'the stream belongs to the session that opened it');
    stream.req.emit('close');
    assert.equal(deps.hub.count(), 0);
  }
  console.log('pulsar live-event route tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
