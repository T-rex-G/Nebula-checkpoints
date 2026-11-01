'use strict';
/*
 * Exposure scanning's life in the process (Quasar's exposure host): whether
 * the capability document lets scanning start; the worker, started once and
 * never without a database or once shutdown has begun, with its store, reader,
 * fingerprint key, a scan's session and its transport; a nudge; the store the
 * routes read; a scan's session; and stopping. What the host builds -- the
 * store, the worker, the session resolver and the guarded transport -- is a
 * recording stand-in it is handed through a module hook.
 */
const assert = require('assert');
const { registerHooks } = require('module');

const STAND_INS = `
const S = () => globalThis.__exposureHost;
export const READER = 'the repository reader';
export const PROFILES = Object.freeze({ PROVIDER_READ: 'provider-read', SIGNED_POST: 'signed-post' });
export const DEFAULT_BUDGETS = Object.freeze({ readConcurrency: 3 });
export function createGuardedSession(options) { S().calls.push(['transport', options]); return { transport: true }; }
export class ExposureStore { constructor(options) { S().calls.push(['store', options]); this.id = S().calls.length; } }
export function startExposureWorker(options) {
  S().calls.push(['worker', options]);
  return {
    run() { S().calls.push(['run']); return S().runFails ? Promise.reject(new Error('scan failed')) : Promise.resolve({ claimed: false }); },
    stop() { S().calls.push(['stop']); return S().drained; }
  };
}
export async function resolveExposureSession(input, deps) { S().calls.push(['session', input, deps]); return { token: 't' }; }
`;
const STANDS_IN_FOR = new Set(['../../../platform/network/guarded-fetch.ts', '../client/exposure-reader.ts', '../persistence/exposure-store.ts', './exposure-session.ts', './exposure-worker.ts']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && context.parentURL.endsWith('/quasar/application/exposure-host.ts') && STANDS_IN_FOR.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(STAND_INS)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const { createExposureHost } = require('../apps/api/src/modules/quasar/index.ts');

const document = status => ({ providers: { gitlab: { 'hosted-alpha': {} }, github: { 'hosted-alpha': { 'exposure.scan': [status, 'note'] } } } });
const SESSION = { alphaEnabled: true, unseal() {}, identityKey() {}, providerAuthority() {}, resolveAccount() {}, readAlphaSession() {}, readOwnedSession() {}, repositoryAllowed() {} };

function host({ databaseConfigured = true, capabilityDocument = document('Supported'), shuttingDown = false } = {}) {
  const state = { calls: [], drained: Promise.resolve('scanned') };
  globalThis.__exposureHost = state;
  let pools = 0;
  const life = createExposureHost({
    databaseConfigured, capabilityDocument, deployment: 'hosted-alpha', fingerprintKey: 'fingerprint-key',
    pool: () => { pools += 1; return { pool: pools }; },
    shuttingDown: () => shuttingDown,
    session: SESSION
  });
  return { life, state, built: name => state.calls.filter(call => call[0] === name).map(call => call[1]) };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

let finished = false;
process.on('unhandledRejection', error => { console.error('a rejection went unanswered:', error && error.message); process.exitCode = 1; });
process.on('exit', code => { if (!finished && code === 0) { console.error('the exposure host tests did not finish'); process.exitCode = 1; } });

(async () => {
  /* ---- What the capability document says ------------------------------------------------- */
  {
    for (const status of ['Supported', 'Experimental']) assert.strictEqual(host({ capabilityDocument: document(status) }).life.exposureScanningAvailable(), true, status);
    for (const capabilityDocument of [
      document('Unavailable'), document('Planned'),
      { providers: { github: { 'self-hosted': { 'exposure.scan': ['Supported'] } } } },
      { providers: { github: { 'hosted-alpha': { 'exposure.scan': 'Supported' } } } },
      { providers: { github: { 'hosted-alpha': { 'exposure.scan': { 0: 'Supported' } } } } },
      { providers: { github: null } }, { providers: null }, null
    ]) {
      assert.strictEqual(host({ capabilityDocument }).life.exposureScanningAvailable(), false, JSON.stringify(capabilityDocument));
    }
  }

  /* ---- The worker ---------------------------------------------------------------------------- */
  {
    for (const [label, options] of [
      ['without a database', { databaseConfigured: false }], ['once shutdown has begun', { shuttingDown: true }],
      ['while the document says it is unavailable', { capabilityDocument: document('Unavailable') }]
    ]) {
      const { life, state } = host(options);
      assert.strictEqual(life.ensureExposureWorker(), null, `no worker ${label}`);
      assert.deepStrictEqual(state.calls, []);
    }
    const { life, state, built } = host();
    const worker = life.ensureExposureWorker();
    assert(worker, 'a worker where scanning is available');
    assert.strictEqual(life.ensureExposureWorker(), worker, 'and only one');
    assert.deepStrictEqual(built('store'), [{ pool: { pool: 1 }, cursorKey: 'fingerprint-key' }], 'its store over the pool, its cursor keyed');
    const [options] = built('worker');
    assert.deepStrictEqual(Object.keys(options), ['store', 'reader', 'fingerprintKey', 'sessionResolver', 'createTransport']);
    assert.strictEqual(options.store.id, 1);
    assert.strictEqual(options.reader.READER, 'the repository reader', 'it reads through the repository reader');
    assert.strictEqual(options.fingerprintKey, 'fingerprint-key', 'and keys what it finds');
    assert.strictEqual(options.sessionResolver, life.resolveExposureSession, 'a scan finds its session as the host does');
    assert.deepStrictEqual(options.createTransport(), { transport: true });
    assert.deepStrictEqual(built('transport'), [{ profile: 'provider-read', maxSockets: 3 }], 'over a provider-read session sized by the read budget');
    assert.strictEqual(life.exposureService().id, 1, 'the routes read the store the worker writes');
    assert.strictEqual(state.calls.filter(call => call[0] === 'store').length, 1);
  }

  /* ---- A nudge ------------------------------------------------------------------------------------ */
  {
    const { life, state } = host();
    life.nudgeExposureWorker();
    assert.deepStrictEqual(state.calls.map(call => call[0]), ['store', 'worker'], 'a nudge starts the worker');
    await turn();
    assert.deepStrictEqual(state.calls.map(call => call[0]), ['store', 'worker', 'run'], 'and runs it now rather than at its next tick');
    state.runFails = true;
    life.nudgeExposureWorker();
    await turn();
    await turn();
    assert.strictEqual(state.calls.filter(call => call[0] === 'run').length, 2, 'a failed run is left for the next tick');
    const idle = host({ capabilityDocument: document('Unavailable') });
    idle.life.nudgeExposureWorker();
    await turn();
    assert.deepStrictEqual(idle.state.calls, [], 'without a worker a nudge does nothing');
  }

  /* ---- The routes' store, and a scan's session ---------------------------------------------------- */
  {
    const offline = host({ databaseConfigured: false });
    assert.throws(() => offline.life.exposureService(), error => {
      assert.deepStrictEqual([error.message, error.status, error.code], ['Exposure scanning requires the configured PostgreSQL DATABASE_URL', 503, 'EXPOSURE_DATABASE_REQUIRED']);
      return true;
    }, 'without a database the routes say so');
    assert.strictEqual(await offline.life.resolveExposureSession({ scanId: 's' }), null, 'and a scan has no session');
    assert.deepStrictEqual(offline.state.calls, []);
    const { life, state, built } = host({ capabilityDocument: document('Unavailable') });
    const store = life.exposureService();
    assert.strictEqual(life.exposureService(), store, 'one store for the routes');
    assert.strictEqual(built('store').length, 1);
    assert.deepStrictEqual(await life.resolveExposureSession({ scanId: 's', requestedBy: 'k', scope: {} }), { token: 't' });
    const [[, input, deps]] = state.calls.filter(call => call[0] === 'session');
    assert.deepStrictEqual(input, { scanId: 's', requestedBy: 'k', scope: {} });
    assert.deepStrictEqual(deps, { ...SESSION, pool: { pool: 2 } }, 'resolved from a session still signed in, through the pool as it is now');
  }

  /* ---- Stopping ----------------------------------------------------------------------------------------- */
  {
    assert.strictEqual(host().life.stop(), null, 'nothing to wait for when no worker started');
    const { life, state } = host();
    life.ensureExposureWorker();
    assert.strictEqual(life.stop(), state.drained, 'the scan in flight is handed back to wait on');
  }

  finished = true;
  console.log('Exposure host tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
