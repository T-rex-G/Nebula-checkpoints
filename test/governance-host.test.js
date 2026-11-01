'use strict';
/*
 * Governance's life in the process (Kepler's governance host): the store,
 * the API service and the delivery worker built once, on first need; delivery
 * started at boot, retried until the database answers, and never without one
 * or once shutdown has begun; the runtime's decisions and its failure log; a
 * delivery failure's log; and stopping. What the host builds -- the store, the
 * service, the worker and the runtime -- is a recording stand-in it is handed
 * through a module hook, so each is checked against what it was given.
 */
const assert = require('assert');
const { registerHooks } = require('module');

const STAND_INS = `
const S = () => globalThis.__governanceHost;
export class GovernanceStore {
  constructor(pool, options) { S().calls.push(['store', pool, options]); this.id = S().calls.length; }
  evaluateAndAppendPolicyDecision(input) { S().calls.push(['decision', this.id, input]); return { recorded: input }; }
}
export function createGovernanceApiService(options) { S().calls.push(['service', options.store.id]); return { service: options.store.id }; }
export function startWebhookWorker(options) {
  S().calls.push(['worker', options.store.id, options.masterSecret]);
  S().deliveryFailed = options.onError;
  return { stop() { S().calls.push(['worker.stop']); return S().drained; }, run() {} };
}
export function createGovernanceRuntime(options) { S().runtime = options; return { runtime: options.failureMode }; }
`;
const STANDS_IN_FOR = new Set(['../delivery/governance-webhook-worker.ts', '../domain/governance-enforcement.ts', '../persistence/governance-store.ts', './governance-api.ts']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && context.parentURL.endsWith('/kepler/application/governance-host.ts') && STANDS_IN_FOR.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(STAND_INS)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const { createGovernanceHost } = require('../apps/api/src/modules/kepler/index.ts');

const SECRET = 's'.repeat(40);
const POOL = { pool: 'pg' };

function host({ databaseConfigured = true, ready = [true], failureMode = 'block', shuttingDown = false } = {}) {
  const state = { calls: [], drained: Promise.resolve('delivered'), asked: 0 };
  globalThis.__governanceHost = state;
  const answers = ready.slice();
  const life = createGovernanceHost({
    databaseConfigured, auditSecret: SECRET, runtimeFailureMode: failureMode,
    ready: async () => { state.asked += 1; return answers.length > 1 ? answers.shift() : answers[0]; },
    pool: () => POOL,
    shuttingDown: () => shuttingDown
  });
  return { life, state, built: name => state.calls.filter(call => call[0] === name) };
}
async function logged(stream, fn) {
  const lines = [];
  const real = console[stream];
  console[stream] = line => { lines.push(JSON.parse(line)); };
  try { await fn(); } finally { console[stream] = real; }
  return lines;
}
function timers() {
  const set = [];
  const cleared = [];
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  global.setTimeout = (fn, ms) => { const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; set.push(timer); return timer; };
  global.clearTimeout = timer => { cleared.push(timer); };
  return { set, cleared, restore() { Object.assign(global, real); } };
}

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the governance host tests did not finish'); process.exitCode = 1; } });

(async () => {
  /* ---- The runtime ------------------------------------------------------------------------ */
  {
    const { life, state, built } = host({ ready: [false, true] });
    assert.deepStrictEqual(life.runtime, { runtime: 'block' }, 'the runtime acts as the deployment\'s failure mode says');
    assert.strictEqual(state.runtime.failureMode, 'block');
    await assert.rejects(state.runtime.store.evaluateAndAppendPolicyDecision({ action: 'a' }), error => {
      assert.deepStrictEqual([error.message, error.status, error.code], ['Governance runtime requires PostgreSQL', 503, 'GOVERNANCE_DATABASE_REQUIRED']);
      return true;
    }, 'a decision is not recorded without the database');
    assert.strictEqual(built('store').length, 0, 'and nothing is built for it');
    assert.deepStrictEqual(await state.runtime.store.evaluateAndAppendPolicyDecision({ action: 'b' }), { recorded: { action: 'b' } });
    assert.deepStrictEqual(built('store'), [['store', POOL, { secret: SECRET }]], 'the store is built over the pool, under the audit secret');
    assert.deepStrictEqual(built('decision').map(call => call[2]), [{ action: 'b' }], 'and records the decision');
    const lines = await logged('error', () => {
      state.runtime.onError({ code: 'POLICY_STORE_UNAVAILABLE', action: 'repository.delete', scopeKey: 'github:alice/demo' });
      state.runtime.onError(null);
    });
    assert.deepStrictEqual(lines.map(({ t, ...line }) => [typeof t, line]), [
      ['string', { warn: 'runtime policy evaluation unavailable', code: 'POLICY_STORE_UNAVAILABLE', action: 'repository.delete', scopeKey: 'github:alice/demo', failureMode: 'block' }],
      ['string', { warn: 'runtime policy evaluation unavailable', code: 'POLICY_EVALUATION_FAILED', action: 'unknown', scopeKey: 'unknown', failureMode: 'block' }]
    ], 'a policy that cannot be evaluated is logged with what it was for and the mode');
  }

  /* ---- The store, the service and the worker ----------------------------------------------------- */
  {
    const { life, built } = host();
    const store = life.ensureGovernanceStore();
    assert.strictEqual(life.ensureGovernanceStore(), store, 'one store for the process');
    assert.deepStrictEqual(built('service'), [['service', store.id]], 'one API service on it');
    assert.deepStrictEqual(built('worker'), [['worker', store.id, SECRET]], 'and one delivery worker beside it, under the audit secret');
    assert.deepStrictEqual(await life.governanceService(), { service: store.id });
    assert.strictEqual(built('store').length, 1);
    const offline = host({ ready: [false] });
    await assert.rejects(offline.life.governanceService(), error => {
      assert.deepStrictEqual([error.message, error.status, error.code], ['Governance requires the configured PostgreSQL DATABASE_URL', 503, 'GOVERNANCE_DATABASE_REQUIRED']);
      return true;
    }, 'a route is refused until the database answers');
    const late = host({ ready: [false, true] });
    await assert.rejects(late.life.governanceService());
    const served = await late.life.governanceService();
    assert.deepStrictEqual(served, { service: late.life.ensureGovernanceStore().id }, 'and served once it does');
  }

  /* ---- Delivery at boot ----------------------------------------------------------------------------- */
  {
    for (const [label, options] of [['without a database', { databaseConfigured: false }], ['once shutdown has begun', { shuttingDown: true }]]) {
      const clock = timers();
      try {
        const { life, state } = host(options);
        await life.bootstrapGovernanceDelivery();
        assert.deepStrictEqual([state.calls, clock.set.length], [[], 0], `nothing starts ${label}`);
      } finally { clock.restore(); }
    }
    const clock = timers();
    try {
      const { life, built, state } = host({ ready: [false, false, true] });
      await life.bootstrapGovernanceDelivery();
      assert.deepStrictEqual([built('store').length, clock.set.length, clock.set[0].ms, clock.set[0].unrefed], [0, 1, 30000, true],
        'delivery waits for the database, trying again every thirty seconds without keeping the process alive');
      await clock.set[0].fn();
      assert.strictEqual(clock.set.length, 2, 'and again');
      await clock.set[1].fn();
      assert.strictEqual(built('worker').length, 1, 'until it answers');
      const asked = state.asked;
      await life.bootstrapGovernanceDelivery();
      assert.deepStrictEqual([built('store').length, built('worker').length, clock.set.length, state.asked - asked], [1, 1, 2, 0],
        'and starts once, without asking the database again');
    } finally { clock.restore(); }
  }

  /* ---- A delivery failure ----------------------------------------------------------------------------- */
  {
    const { life, state } = host();
    life.ensureGovernanceStore();
    const lines = await logged('error', () => {
      state.deliveryFailed(Object.assign(new Error('x'), { code: 'GOVERNANCE_WEBHOOK_TIMEOUT' }));
      state.deliveryFailed(null);
      state.deliveryFailed({ code: `long\n${'c'.repeat(200)}` });
    });
    assert.deepStrictEqual(lines.map(({ t, ...line }) => [typeof t, line.warn, line.code]), [
      ['string', 'governance webhook delivery worker failed', 'GOVERNANCE_WEBHOOK_TIMEOUT'],
      ['string', 'governance webhook delivery worker failed', 'GOVERNANCE_WEBHOOK_WORKER_FAILED'],
      ['string', 'governance webhook delivery worker failed', `long ${'c'.repeat(95)}`]
    ], 'logged by its code alone, bounded');
  }

  /* ---- Stopping --------------------------------------------------------------------------------------- */
  {
    const clock = timers();
    try {
      const waiting = host({ ready: [false] });
      await waiting.life.bootstrapGovernanceDelivery();
      assert.strictEqual(waiting.life.stop(), null, 'nothing to wait for when delivery never started');
      assert.deepStrictEqual(clock.cleared, [clock.set[0]], 'and the retry is cleared');
      const running = host();
      await running.life.bootstrapGovernanceDelivery();
      assert.strictEqual(running.life.stop(), running.state.drained, 'the batch in flight is handed back to wait on');
      assert.deepStrictEqual(running.built('worker.stop').length, 1);
    } finally { clock.restore(); }
  }

  finished = true;
  console.log('Governance host tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
