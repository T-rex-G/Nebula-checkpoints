'use strict';

/*
 * The hosted drills, run against a world that plays Render, Neon, GitHub and
 * the staging deployment, with just enough state to answer the way each one
 * does. What is pinned:
 *
 *   - a deployment that behaves produces a record every check of which passes,
 *     and which the hosted gate accepts once the operator has signed it;
 *   - nothing the drills hold in memory -- invitations, cookies, tokens, the
 *     database address, the pepper -- reaches the report;
 *   - a target that deploys on its own, does not declare itself a
 *     qualification deployment, or is not serving this candidate is refused
 *     before anything is changed on it;
 *   - a deployment that answers 500 during a database interruption fails that
 *     drill, and the compute is enabled again regardless;
 *   - the signing tool refuses a failed run, and the record it prints is the
 *     one the gate validates.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHostedDrills } = require('../ci/run-alpha17-hosted-drills');
const { validateOperationalRecord } = require('../ci/run-hosted-alpha17-validation');
const operator = require('../scripts/alpha17-operator-record');
const hostedTesters = require('../ci/run-alpha17-hosted-testers');

const BASE = 'https://nebulaverse-x-staging.onrender.com';
const CANDIDATE = 'c'.repeat(64);
const PARENT_FINGERPRINT = 'p'.repeat(64).replace(/p/g, 'a');
const SOURCE_COMMIT = '1'.repeat(40);
const SOURCE_PARENT = '2'.repeat(40);
/* Built from parts so no credential-shaped literal sits in the tree. */
const SECRETS = Object.freeze({
  render: ['rnd', 'fixture', 'render', 'key'].join('_'),
  neon: ['napi', 'fixture', 'neon', 'key'].join('_'),
  mutation: ['fixture', 'mutation', 'credential'].join('-'),
  readOnly: ['fixture', 'read', 'credential'].join('-'),
  database: ['postgresql://drill', 'fixture-password@db.example/neondb'].join(':'),
  pepper: 'pepper-'.repeat(8)
});

function env(overrides = {}) {
  return {
    NV_ALPHA_BASE_URL: BASE,
    NV_ALPHA17_RENDER_SERVICE_ID: 'srv-staging1',
    RENDER_API_KEY: SECRETS.render,
    NV_ALPHA17_NEON_PROJECT_ID: 'dark-lake-1',
    NV_ALPHA17_COHORT_NEON_BRANCH_ID: 'br-cohort-1',
    NEON_API_KEY: SECRETS.neon,
    NV_ALPHA17_REPOSITORY: 'acme/qualification',
    NV_ALPHA17_MUTATION_CREDENTIAL: SECRETS.mutation,
    NV_ALPHA17_READ_ONLY_CREDENTIAL: SECRETS.readOnly,
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: 'd'.repeat(64),
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: SOURCE_COMMIT,
    NV_PUBLIC_ALPHA_SOURCE_PARENT: SOURCE_PARENT,
    NV_ALPHA17_WORKFLOW_RUN_ID: '4242',
    ...overrides
  };
}

/*
 * The world. `faults` changes one behaviour at a time, so each refusal and
 * failure is the only thing wrong in its run.
 */
function world(faults = {}) {
  const state = {
    clock: Date.parse('2026-10-12T20:00:00Z'),
    bootId: crypto.randomUUID(),
    fingerprint: CANDIDATE,
    endpoint: { id: 'ep-cohort', branch_id: 'br-cohort-1', type: 'read_write', current_state: 'active', disabled: false },
    hooks: new Map(),
    deliveries: new Map(),
    branches: new Set(['main']),
    streams: new Set(),
    invites: new Map(),
    testers: new Map(),
    sessions: new Map(),
    searches: 0,
    limitedUntil: 0,
    nextId: 1,
    deletedIdentity: false
  };
  const id = prefix => `${prefix}${state.nextId++}`;
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const cookies = init => Object.fromEntries(String((init && init.headers && init.headers.cookie) || '').split(';').map(part => part.trim().split('=')).filter(pair => pair[0]));
  const databaseDown = () => state.endpoint.disabled;

  function app(url, init) {
    const route = url.pathname;
    const method = (init && init.method) || 'GET';
    const jar = cookies(init);
    const body = init && init.body ? JSON.parse(init.body) : {};
    const tester = state.testers.get(jar.nv_alpha_access);
    const session = state.sessions.get(jar.nv_session);
    if (route === '/api/capabilities') return json(200, { features: { 'live-events': { status: faults.noQualification ? 'Experimental' : 'Supported' } } });
    if (route === '/api/config') {
      return json(200, { termsVersion: '2026-07-29', ...(faults.noQualification || faults.promoted ? {} : { qualification: { capabilities: ['live-events'] } }) });
    }
    if (route === '/api/version') return json(200, { releaseTreeSha256: faults.otherCandidate ? 'e'.repeat(64) : state.fingerprint });
    if (route === '/healthz') return json(200, { ok: true, bootId: state.bootId });
    if (route === '/readyz') return databaseDown() ? json(503, { ok: false, database: 'unavailable' }) : json(200, { ok: true, database: 'connected' });
    if (route === '/api/alpha/redeem') {
      const invite = state.invites.get(body.code);
      if (!invite || invite.redeemed) return json(403, { code: 'ALPHA_INVITE_INVALID' });
      invite.redeemed = true;
      const testerCookie = id('t');
      state.testers.set(testerCookie, invite.tester);
      return json(200, { ok: true }, { 'set-cookie': `nv_alpha_access=${testerCookie}; Path=/; HttpOnly` });
    }
    if (route.startsWith('/api/') && databaseDown()) return json(faults.outageAnswers || 503, { code: 'ALPHA_ACCESS_UNAVAILABLE' });
    if (!tester) return json(401, { code: 'ALPHA_ACCESS_REQUIRED' });
    if (tester.revoked) return json(403, { code: 'ALPHA_ACCESS_REVOKED' });
    if (route === '/api/login') {
      const sid = id('s');
      state.sessions.set(sid, { login: 'drill-bot', alive: true });
      return json(200, { ok: true }, { 'set-cookie': `nv_session=${sid}; Path=/; HttpOnly` });
    }
    if (route === '/api/security/csrf') return json(200, { token: 'csrf' });
    if (!session || !session.alive) return json(session && faults.replayAnswers || 401, { code: 'SIGNED_OUT' });
    if (route === '/api/me') return json(200, { login: session.login });
    if (route === '/api/repo/acme/qualification') return json(200, { default_branch: 'main' });
    if (route === '/api/search') {
      state.searches += 1;
      if (state.clock < state.limitedUntil) return json(429, { code: 'PROVIDER_RATE_LIMITED' }, { 'retry-after': '30' });
      if (state.searches === 10) {
        state.limitedUntil = state.clock + 30000;
        return json(429, { code: 'PROVIDER_RATE_LIMITED' }, { 'retry-after': '30' });
      }
      return json(200, { items: [] });
    }
    if (route === '/api/alpha/providers/disconnect-all') {
      session.alive = false;
      return json(200, { ok: true }, { 'set-cookie': 'nv_session=; Path=/; Max-Age=0' });
    }
    if (route === '/api/alpha/delete') {
      /* As the store's purge does: the tester is revoked and the identity's sessions go. */
      tester.revoked = true;
      for (const value of state.sessions.values()) value.alive = false;
      state.deletedIdentity = true;
      return json(200, { ok: true, status: 'complete', providerCleanupVerified: true });
    }
    const live = /^\/api\/repo\/acme\/qualification\/live-events(\/connect|\/stream)?$/.exec(route);
    if (live && live[1] === '/connect' && method === 'POST') {
      const hook = Number(String(state.nextId++).padStart(1, '0')) + 1000;
      state.hooks.set(hook, { id: hook, config: { url: `${BASE}/hooks/github/${'a'.repeat(32)}` } });
      state.deliveries.set(hook, []);
      return json(201, { connected: true });
    }
    if (live && live[1] === '/stream') {
      let controller;
      const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n')); } });
      const entry = { push: text => controller.enqueue(new TextEncoder().encode(text)) };
      state.streams.add(entry);
      init.signal.addEventListener('abort', () => { state.streams.delete(entry); try { controller.close(); } catch {} });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (live && !live[1] && method === 'DELETE') {
      state.hooks.clear();
      return json(200, { ok: true });
    }
    return json(404, { error: 'not in this world' });
  }

  function github(url, init) {
    const method = (init && init.method) || 'GET';
    const route = url.pathname;
    if (route === '/user') return json(200, { login: 'drill-bot' });
    if (route === '/repos/acme/qualification') return json(200, { default_branch: 'main' });
    if (route === '/repos/acme/qualification/git/ref/heads/main') return json(200, { object: { sha: 'f'.repeat(40) } });
    if (route === '/repos/acme/qualification/git/refs' && method === 'POST') {
      state.branches.add(JSON.parse(init.body).ref.replace('refs/heads/', ''));
      return json(201, {});
    }
    const content = /^\/repos\/acme\/qualification\/contents\//.exec(route);
    if (content && method === 'PUT') {
      const branch = JSON.parse(init.body).branch;
      for (const [hook, list] of state.deliveries) if (state.hooks.has(hook)) list.push({ event: 'push', status_code: 202 });
      for (const stream of state.streams) stream.push(`id: 1\nevent: intelligence\ndata: ${JSON.stringify({ type: 'push', ref: branch })}\n\n`);
      return json(201, {});
    }
    const ref = /^\/repos\/acme\/qualification\/git\/refs\/heads\/(.+)$/.exec(route);
    if (ref && method === 'DELETE') { state.branches.delete(decodeURIComponent(ref[1])); return new Response(null, { status: 204 }); }
    if (route === '/repos/acme/qualification/hooks') return json(200, [...state.hooks.values()]);
    const hook = /^\/repos\/acme\/qualification\/hooks\/(\d+)(\/deliveries)?$/.exec(route);
    if (hook && hook[2]) return json(200, state.deliveries.get(Number(hook[1])) || []);
    if (hook) return state.hooks.has(Number(hook[1])) ? json(200, {}) : json(404, {});
    return json(404, {});
  }

  function render(url, init) {
    const method = (init && init.method) || 'GET';
    const route = url.pathname;
    if (route === '/v1/services/srv-staging1') return json(200, { id: 'srv-staging1', autoDeploy: faults.autoDeploy ? 'yes' : 'no' });
    if (route === '/v1/services/srv-staging1/env-vars') {
      return json(200, [{ envVar: { key: 'DATABASE_URL', value: SECRETS.database }, cursor: 'a' }, { envVar: { key: 'NV_ALPHA_INVITE_PEPPER', value: SECRETS.pepper }, cursor: 'b' }]);
    }
    if (route === '/v1/services/srv-staging1/restart' && method === 'POST') { state.bootId = crypto.randomUUID(); return json(202, {}); }
    if (route === '/v1/services/srv-staging1/deploys' && method === 'POST') {
      const commit = JSON.parse(init.body).commitId;
      state.fingerprint = commit === SOURCE_COMMIT ? CANDIDATE : PARENT_FINGERPRINT;
      state.bootId = crypto.randomUUID();
      return json(201, { id: 'dep-1' });
    }
    if (route === '/v1/services/srv-staging1/deploys/dep-1') return json(200, { status: 'live' });
    return json(404, {});
  }

  function neon(url, init) {
    const method = (init && init.method) || 'GET';
    const route = url.pathname;
    if (route === '/api/v2/projects/dark-lake-1/endpoints') return json(200, { endpoints: [{ ...state.endpoint }] });
    if (route === '/api/v2/projects/dark-lake-1/endpoints/ep-cohort/suspend' && method === 'POST') { state.endpoint.current_state = 'idle'; return json(200, {}); }
    if (route === '/api/v2/projects/dark-lake-1/endpoints/ep-cohort' && method === 'PATCH') {
      state.endpoint.disabled = JSON.parse(init.body).endpoint.disabled;
      state.endpoint.current_state = state.endpoint.disabled ? 'idle' : 'active';
      return json(200, {});
    }
    return json(404, {});
  }

  const calls = [];
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    calls.push(`${init.method || 'GET'} ${url.host}${url.pathname}`);
    if (url.origin === BASE) return app(url, init);
    if (url.host === 'api.github.com') return github(url, init);
    if (url.host === 'api.render.com') return render(url, init);
    if (url.host === 'console.neon.tech') return neon(url, init);
    throw new Error(`unexpected host ${url.host}`);
  }

  const pool = {
    async query(sql, params) {
      if (/FROM nv_alpha_testers WHERE invite_id/.test(sql)) {
        const invite = [...state.invites.values()].find(item => item.inviteId === params[0]);
        return { rows: invite ? [{ tester_id: invite.tester.id }] : [] };
      }
      if (/FROM nv_sessions WHERE identity_keys/.test(sql)) return { rows: [{ n: state.deletedIdentity ? 0 : 1 }] };
      if (/FROM nv_alpha_sessions/.test(sql)) return { rows: [{ n: 0 }] };
      if (/FROM nv_alpha_testers WHERE tester_label LIKE/.test(sql)) {
        return { rows: [{ n: [...state.invites.values()].filter(item => !item.tester.revoked).length }] };
      }
      throw new Error(`unexpected query ${sql}`);
    },
    async end() {}
  };
  const store = {
    async issueInvite(input) {
      const inviteId = `${id('invite')}x`.padEnd(20, '0');
      const code = `nvx_alpha_${inviteId}.secret${state.nextId}`;
      state.invites.set(code, { inviteId, redeemed: false, tester: { id: crypto.randomUUID(), label: input.testerLabel, revoked: false } });
      return { inviteId, code };
    },
    async revokeTester(testerId) {
      for (const invite of state.invites.values()) if (invite.tester.id === testerId) invite.tester.revoked = true;
      return { sessionsRevoked: 1 };
    }
  };
  return {
    state, calls,
    options: {
      fetch: fetchImpl,
      sleep: async ms => { state.clock += ms; },
      now: () => state.clock,
      createPool: connectionString => { assert.strictEqual(connectionString, SECRETS.database); return pool; },
      createStore: (givenPool, pepper) => { assert.strictEqual(pepper, SECRETS.pepper); return store; },
      log: () => {},
      candidateFingerprint: CANDIDATE
    }
  };
}

(async () => {
  /* ---- A deployment that behaves --------------------------------------- */
  const good = world();
  const result = await runHostedDrills({ env: env(), ...good.options });
  assert.strictEqual(result.ok, true, JSON.stringify(result, null, 2));
  assert.strictEqual(result.record.cleanupVerified, true);
  assert.deepStrictEqual(Object.keys(result.record.checks).sort(), [
    'active-session-revocation', 'application-rollback', 'database-interruption-recovery', 'disposable-tester-purge',
    'ephemeral-filesystem-restart', 'live-events-delivery', 'memory-restart-observation', 'neon-scale-to-zero-wake',
    'provider-429-outage', 'provider-disconnect'
  ]);
  assert.strictEqual(good.state.endpoint.disabled, false, 'the compute is enabled again');
  assert.strictEqual(good.state.fingerprint, CANDIDATE, 'the candidate is served again');
  assert.strictEqual(good.state.hooks.size, 0, 'no webhook is left at GitHub');
  assert.deepStrictEqual([...good.state.branches], ['main'], 'the drill branch is deleted');
  assert(good.calls.includes('POST api.render.com/v1/services/srv-staging1/restart'));
  assert(good.state.searches >= 10, 'the searches reached the limit');

  const printed = JSON.stringify(result);
  for (const [name, value] of Object.entries(SECRETS)) assert(!printed.includes(value), `the report carries the ${name}`);
  assert(!/nvx_alpha_|nv_session=|nv_alpha_access=/.test(printed), 'the report carries an invitation or a cookie');

  /* ---- Signed, it is the record the gate accepts ----------------------- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-operator-'));
  try {
    const key = operator.keygen({ out: path.join(dir, 'keys') });
    assert.strictEqual(fs.statSync(key.privateKeyPath).mode & 0o777, 0o600, 'the private key is readable by its owner only');
    assert.throws(() => operator.keygen({ out: path.join(dir, 'keys') }), /never overwritten/);
    const log = path.join(dir, 'job.log');
    fs.writeFileSync(log, [
      '2026-10-12T20:41:00.1234567Z drill live-events-delivery: {"status":"pass"}',
      '2026-10-12T20:41:00.2234567Z ALPHA17_DRILL_REPORT_BEGIN',
      `2026-10-12T20:41:00.3234567Z ${JSON.stringify(result)}`,
      '2026-10-12T20:41:00.4234567Z ALPHA17_DRILL_REPORT_END',
      ''
    ].join('\n'));
    const signed = operator.sign({ report: log, key: key.privateKeyPath, 'key-id': key.keyId, now: result.record.completedAt });
    const record = JSON.parse(Buffer.from(signed.recordBase64, 'base64').toString('utf8'));
    const validated = validateOperationalRecord(record, {
      expectedSubjectHash: 'd'.repeat(64), expectedSourceCommit: SOURCE_COMMIT,
      publicKeyBase64: key.publicKeyBase64, now: new Date(Date.parse(result.record.completedAt) + 3600000)
    });
    assert.strictEqual(validated.signature.keyId, key.keyId);
    /* A record altered after signing is refused. */
    const altered = { ...record, checks: { ...record.checks, 'provider-429-outage': { status: 'pass', retryBounded: true } }, cleanupVerified: true, completedAt: record.completedAt };
    altered.checks['application-rollback'] = { status: 'pass', candidateRestored: true };
    altered.sourceCommit = '3'.repeat(40);
    assert.throws(() => validateOperationalRecord(altered, {
      expectedSubjectHash: 'd'.repeat(64), expectedSourceCommit: '3'.repeat(40), publicKeyBase64: key.publicKeyBase64, now: new Date(Date.parse(result.record.completedAt))
    }), error => error.code === 'ALPHA17_OPERATIONAL_SIGNATURE_INVALID');
    /* A failed run is not signed. */
    const failedReport = path.join(dir, 'failed.json');
    fs.writeFileSync(failedReport, JSON.stringify({ ...result, ok: false }));
    assert.throws(() => operator.sign({ report: failedReport, key: key.privateKeyPath, 'key-id': key.keyId }), /did not pass/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---- The hosted gate's five testers, made and released in the job ----- */
  {
    const load = world();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-testers-'));
    const file = path.join(dir, 'testers.json');
    try {
      const made = await hostedTesters.provision(file, { env: env({ NV_ALPHA_BASE_URL: `${BASE}/` }), ...load.options });
      assert.deepStrictEqual(made, { testers: 5, branch: 'nvx-alpha17-4242-load' });
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the plan holds live cookies and is readable by its owner only');
      const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(plan.cookies.length, 5);
      assert(plan.cookies.every(cookie => /nv_alpha_access=/.test(cookie) && /nv_session=/.test(cookie)), 'each tester is redeemed and signed in');
      assert.deepStrictEqual([plan.mutation.method, plan.mutation.path, plan.mutation.body, plan.mutation.expectedStatus],
        ['POST', '/api/repo/acme/qualification/branches', { name: 'nvx-alpha17-4242-load', from: 'main' }, 200]);
      assert.deepStrictEqual([plan.cleanup.method, plan.cleanup.path, plan.cleanup.expectedStatus],
        ['DELETE', '/api/repo/acme/qualification/branches/nvx-alpha17-4242-load', 200]);
      assert(plan.mutation.headers['x-nv-csrf'] && plan.mutation.headers['x-nv'] === '1', 'the mutation carries what the server requires of a change');
      const loginCredentials = [...load.state.invites.values()].length;
      assert.strictEqual(loginCredentials, 5);
      assert(!JSON.stringify(made).includes('nv_session'), 'what is printed carries no cookie');
      const released = await hostedTesters.release(file, { env: env(), ...load.options });
      assert.deepStrictEqual(released, { released: 5 });
      assert(!fs.existsSync(file), 'the plan is removed once its testers are released');
      assert([...load.state.invites.values()].every(invite => invite.tester.revoked), `every tester is revoked or deleted: ${JSON.stringify([...load.state.invites.values()].map(invite => [invite.tester.label, invite.tester.revoked]))}`);
      assert.strictEqual(load.state.deletedIdentity, true, 'the shared identity\'s sessions are deleted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ---- Targets refused before anything changes -------------------------- */
  for (const [fault, why] of [['autoDeploy', /deploys on its own/], ['noQualification', /qualification deployment/], ['otherCandidate', /not serving the candidate/]]) {
    const refused = world({ [fault]: true });
    await assert.rejects(runHostedDrills({ env: env(), ...refused.options }), error => error.code === 'ALPHA17_DRILL_TARGET_REFUSED' && why.test(error.message), fault);
    assert(!refused.calls.some(call => /^(POST|PATCH|DELETE|PUT) /.test(call)), `${fault}: nothing was changed on a refused target`);
  }
  await assert.rejects(runHostedDrills({ env: env({ NV_ALPHA_BASE_URL: 'http://staging.example' }), ...world().options }),
    error => error.code === 'ALPHA17_DRILL_CONFIGURATION');
  await assert.rejects(runHostedDrills({ env: env({ NV_ALPHA_BASE_URL: `${BASE}/path` }), ...world().options }),
    error => error.code === 'ALPHA17_DRILL_CONFIGURATION', 'a base URL is an origin, not a page');

  /* ---- The origin as a browser copies it, trailing slash and all ------- */
  const slashed = await runHostedDrills({ env: env({ NV_ALPHA_BASE_URL: `${BASE}/` }), ...world().options });
  assert.strictEqual(slashed.ok, true, 'one trailing slash is the same origin, as the target verifier already reads it');
  assert(Object.values(slashed.record.checks).every(check => check.status === 'pass'));

  /* ---- A replayed session the server faults on fails that drill, and says so --- */
  const replayed = world({ replayAnswers: 500 });
  const replayedResult = await runHostedDrills({ env: env(), ...replayed.options });
  assert.strictEqual(replayedResult.ok, false);
  assert.deepStrictEqual(replayedResult.record.checks['provider-disconnect'], { status: 'fail', browserStatePurged: false },
    'a check whose claim is false is not reported as a pass');
  assert.strictEqual(replayedResult.observations['provider-disconnect'].replayStatus, 500);
  assert(Object.entries(replayedResult.record.checks).every(([key, check]) => key === 'provider-disconnect' || check.status === 'pass'),
    'only the failing drill fails');

  /* ---- Once live events are promoted, the switch is gone and the drills still run --- */
  const promoted = world({ promoted: true });
  assert.strictEqual((await runHostedDrills({ env: env(), ...promoted.options })).ok, true,
    'a staging deployment whose registry calls live events Supported is still a target');

  /* ---- A server fault during the interruption fails that drill --------- */
  const faulty = world({ outageAnswers: 500 });
  const faultyResult = await runHostedDrills({ env: env(), ...faulty.options });
  assert.strictEqual(faultyResult.ok, false);
  assert.strictEqual(faultyResult.record.checks['database-interruption-recovery'].failClosedDuringInterruption, false);
  assert.strictEqual(faultyResult.record.checks['database-interruption-recovery'].status, 'fail');
  assert.strictEqual(faultyResult.observations['database-interruption-recovery'].sessionDuring, 500);
  assert.strictEqual(faulty.state.endpoint.disabled, false, 'the compute is enabled again after a failed drill');

  console.log('alpha17 hosted drill tests passed');
})().catch(error => { console.error(error); process.exit(1); });
