'use strict';
/*
 * The server's own life: the work it starts beside requests, and how it stops.
 *
 * apps/api/src/main.ts listens with the composed application, then starts
 * what runs beside requests -- the upkeep of stale upload files, governance's
 * webhook delivery and exposure scanning's worker -- and stops once, on SIGTERM
 * or SIGINT. The composition hands the platform's graceful shutdown (its order
 * is test/graceful-shutdown.test.js's) the workers whose work it waits for
 * before the pool closes. These checks ask the server itself:
 *
 *   - The server, started on a database holding work from before it started,
 *     takes that work up unasked: a delivery governance had queued is
 *     attempted, a scan exposure scanning had queued is run, and a stale upload
 *     file is removed. Stopped by either signal, it exits cleanly.
 *   - The composed server, stopped part way through a delivery or a scan,
 *     waits for that work, then closes the pool, then exits cleanly.
 *
 * Nothing leaves the machine. The webhook's destination is a name under
 * .invalid, which never resolves (RFC 6761): it is stood in for while the
 * webhook is kept, and fails, as it would, when a delivery looks it up. Each
 * scan stops before it reads a repository.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { composedApplication, browser, standInForOutbound, standInForNames, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');
const { freePort } = require('./helpers/free-port');
const { serverEntry } = require('./helpers/server-entry');
const { loadServerSecrets } = require('../apps/api/src/platform/config/server-settings.ts');
const { DETECTION_ENGINE_VERSION, RULES_VERSION } = require('../apps/api/src/modules/quasar/domain/exposure-detection.ts');
const { FINGERPRINT_KEY_VERSION, fingerprintKeyId } = require('../apps/api/src/modules/quasar/domain/exposure-findings.ts');
const { EXPOSURE_CONFIG_VERSION } = require('../apps/api/src/modules/quasar/persistence/exposure-store.ts');

const RUNTIME = process.env.NV_SERVER_RUNTIME;
const SECRET = 's'.repeat(48);
const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: SECRET, NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });
const OCTO = `ghp_o${'z'.repeat(35)}`;
const RECEIVER = 'receiver.invalid';
const SCOPE = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/* A condition the server should reach, waited for; what it is waiting for is the message when it does not. */
async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

/* A scan as the scan route queues one: these versions, on this repository, for an identity that holds no session. */
const scanRequest = (fingerprintKey, idempotencyKey) => ({
  scope: SCOPE, identityKey: 'e'.repeat(64), requestedBy: 'octo', refName: 'main', commitSha: 'c'.repeat(40),
  rulesVersion: RULES_VERSION, engineVersion: DETECTION_ENGINE_VERSION, fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
  fingerprintKeyId: fingerprintKey, configVersion: EXPOSURE_CONFIG_VERSION, scanMode: 'tree', idempotencyKey
});

(async () => {
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('lifecycle');
  const github = standInForOutbound([
    ['GET /user$', { body: { login: 'octo', id: 7, name: 'octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
    ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
    ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo', default_branch: 'main', private: true, visibility: 'private', permissions: { admin: true } } }]
  ]);
  const environment = { ...BASE, DATABASE_URL: database.url };
  const client = await database.client();
  const servers = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-lifecycle-'));
  try {
    const deliveries = async () => (await client.query('SELECT delivery_id, status, attempt_count FROM nv_governance_webhook_deliveries ORDER BY created_at, delivery_id')).rows;
    const scanOf = async scanId => (await client.query('SELECT state, skipped_reason FROM nv_exposure_scans WHERE scan_id=$1', [scanId])).rows[0];
    /*
     * Whether a query of the given kind is waiting on a lock. Not just any
     * query: the store's retention sweep, which it starts when it opens,
     * deletes old sessions, and held behind the same lock it would answer
     * for a worker that had not yet reached it.
     */
    const waitingOn = pattern => async () => (await client.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ~ $1",
      [pattern]
    )).rows[0].n > 0;

    /*
     * The application, readied, with a person signed in, to leave work for the
     * server under test. Governance starts its delivery worker on first need,
     * and the worker's first batch at once, which would take up any delivery
     * already queued: it is started before anything is queued, and stopped
     * once that batch is done, so what is queued here is left for the server
     * under test. Only governed changes start it, so nothing else here does.
     */
    const leaving = async work => {
      const application = await composedApplication(environment);
      try {
        assert.equal(await application.core.ready(), true, 'the store is opened and migrated');
        application.core.governance.ensureGovernanceStore();
        await application.core.governance.stop();
        const page = browser(application);
        assert.equal((await page.signIn(OCTO)).status, 200);
        return await work(application, page, await page.csrf());
      } finally {
        await application.close();
      }
    };
    /* A governed change: its policy decision is an event the webhook listens for, so a delivery is queued. */
    const governedChange = async (page, csrf, idempotencyKey) => {
      const before = (await deliveries()).length;
      const changed = await page.request('/api/repo/acme/demo/governance/notifications/preferences', {
        method: 'PUT', body: { enabled: true, eventTypes: ['policy.activated'] }, headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': idempotencyKey }
      });
      assert.equal(changed.status, 200, 'a governed change is made');
      const queued = (await deliveries()).slice(before);
      assert.deepEqual(queued.map(row => [row.status, row.attempt_count]), [['pending', 0]], 'and a delivery of its decision is queued');
      return queued[0].delivery_id;
    };

    /* The server's own process, as a deployment starts it, with the temporary directory the test gives it. */
    const start = () => {
      const port = freePort();
      const child = spawn(process.execPath, [serverEntry()], {
        env: { PATH: process.env.PATH, ...environment, PORT: String(port), TMPDIR: temp, ...(RUNTIME ? { NV_SERVER_RUNTIME: RUNTIME } : {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const server = { child, url: `http://127.0.0.1:${port}`, logs: '' };
      child.stdout.on('data', chunk => { server.logs += chunk; });
      child.stderr.on('data', chunk => { server.logs += chunk; });
      server.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      servers.push(server);
      return server;
    };
    const answering = server => until('the server to answer', async () => {
      if (server.child.exitCode !== null) throw new Error(`the server exited before it answered:\n${server.logs}`);
      try {
        const health = await fetch(`${server.url}/healthz`);
        await health.arrayBuffer();
        return health.ok;
      } catch { return false; }
    }, 25_000);
    const stopped = async (server, signal) => {
      server.child.kill(signal);
      const exit = await Promise.race([server.exited, pause(15_000).then(() => ({ code: 'still running', signal: null }))]);
      assert.deepEqual(exit, { code: 0, signal: null }, `on ${signal} the server stops, and exits cleanly:\n${server.logs}`);
      assert.match(server.logs, new RegExp(`"event":"shutdown","signal":"${signal}"`), `and says why it stopped:\n${server.logs}`);
    };

    /*
     * Left for the server: a webhook listening for policy decisions, and a
     * delivery of one; and a scan asked for under a fingerprint key the server
     * does not hold. The webhook's destination is looked up before it is kept,
     * so the name is stood in for while it is; a delivery that looks it up
     * later finds nothing, as it would.
     */
    const { firstDelivery, queuedScan } = await leaving(async (application, page, csrf) => {
      const names = standInForNames({ [RECEIVER]: ['93.184.216.34'] });
      let created;
      try {
        created = await page.request('/api/repo/acme/demo/governance/webhooks', {
          method: 'POST', body: { name: 'Receiver', url: `https://${RECEIVER}/events`, eventTypes: ['policy.decision.allow'], enabled: true },
          headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': 'lifecycle-webhook' }
        });
      } finally {
        names.restore();
      }
      assert.equal(created.status, 201, JSON.stringify(await bodyOf(created)));
      const delivery = await governedChange(page, csrf, 'lifecycle-change-1');
      const { scan } = await application.core.exposure.exposureService().requestScan(scanRequest('f'.repeat(64), 'lifecycle-before-start'));
      return { firstDelivery: delivery, queuedScan: scan.scanId };
    });
    assert.equal((await scanOf(queuedScan)).state, 'queued');

    /*
     * ---- The server takes up, unasked, the work it was left ----
     * Replaces exposure scanning's checks that main.ts started its worker,
     * through Quasar's index, with the release's capability document, and
     * governance delivery's that the server loaded its worker through Kepler's
     * index. The server starts on a database holding work from before it
     * started, with no request made of it:
     *   - its upkeep removes an upload's temporary file older than the
     *     stale-upload age, and only that;
     *   - governance's delivery attempts the delivery it had queued;
     *   - exposure scanning's worker runs the scan it had queued, at its first
     *     look: one asked for under a fingerprint key the server no longer
     *     holds, which it stops as asked under another configuration.
     * Stopped by SIGTERM, and started again and stopped by SIGINT, it says why
     * and exits cleanly.
     */
    {
      const upload = name => path.join(temp, name);
      for (const name of ['nv-0123456789abcdef', 'nv-fedcba9876543210', 'notes.txt']) fs.writeFileSync(upload(name), 'left behind');
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      for (const name of ['nv-0123456789abcdef', 'notes.txt']) fs.utimesSync(upload(name), old, old);

      const server = start();
      await answering(server);
      await until('the stale upload file to be removed', () => !fs.existsSync(upload('nv-0123456789abcdef')));
      assert.deepEqual(['nv-fedcba9876543210', 'notes.txt'].filter(name => fs.existsSync(upload(name))), ['nv-fedcba9876543210', 'notes.txt'],
        'a recent upload file, and a file that is not an upload\'s, are left');
      await until('the delivery queued before the start to be attempted', async () => (await deliveries()).some(row => row.delivery_id === firstDelivery && row.attempt_count === 1));
      assert.deepEqual((await deliveries()).map(row => [row.status, row.attempt_count]), [['retry', 1]],
        'the delivery is attempted, and, its destination not found, kept for another try');
      /* Claimed, a scan is running for a moment before it is stopped: what is waited for is its end. */
      await until('the scan queued before the start to be run to its end', async () => !['queued', 'running'].includes((await scanOf(queuedScan)).state), 25_000);
      assert.deepEqual(await scanOf(queuedScan), { state: 'failed', skipped_reason: 'configuration-changed' },
        'the scan is run, and stopped as asked under another configuration');
      await stopped(server, 'SIGTERM');

      const again = start();
      await answering(again);
      await stopped(again, 'SIGINT');
    }

    /*
     * The composed server, stopped as a signal stops it, with the process's
     * exit stood in for: when it exits, and with what.
     */
    const stopping = application => {
      const ownExit = process.exit;
      const stop = { code: undefined };
      stop.exited = new Promise(resolve => {
        process.exit = code => {
          stop.code = code;
          resolve(code);
        };
      });
      stop.restore = () => { process.exit = ownExit; };
      void application.core.shutdown('SIGTERM');
      return stop;
    };
    const exitOf = stop => Promise.race([stop.exited, pause(8_000).then(() => 'no exit')]);
    /*
     * Afterwards, whatever happened: the process's exit given back, the hold
     * let go, and an application that was never stopped closed, so a check
     * that failed part way ends the test rather than holding it open.
     */
    const settle = async (application, stop, hold) => {
      if (stop) stop.restore();
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (!stop) await application.close().catch(() => {});
    };

    /*
     * ---- Stopped mid-delivery, the server waits for it before the pool closes ----
     * Replaces governance delivery's check that the composition drains its
     * worker at shutdown. Delivery's first batch is held at the deliveries
     * table, then the server is stopped: it does not exit while the batch is
     * held. Let go, the batch attempts the delivery and records the attempt;
     * only then is the pool closed, and the exit clean. Undrained, the pool
     * would close under the batch, and the delivery stay leased as if sending.
     */
    {
      const delivery = await leaving((application, page, csrf) => governedChange(page, csrf, 'lifecycle-change-2'));
      const application = await composedApplication(environment);
      const hold = await database.client();
      let stop = null;
      try {
        assert.equal(await application.core.ready(), true);
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE nv_governance_webhook_deliveries IN ACCESS EXCLUSIVE MODE');
        await application.core.governance.bootstrapGovernanceDelivery();
        await until('the delivery batch to be held', waitingOn('FROM nv_governance_webhook_deliveries'));
        stop = stopping(application);
        await pause(400);
        assert.equal(stop.code, undefined, 'the stopped server does not exit while a delivery batch is in flight');
        await hold.query('COMMIT');
        assert.equal(await exitOf(stop), 0, 'once the batch is done, it exits cleanly');
        const row = (await deliveries()).find(item => item.delivery_id === delivery);
        assert.deepEqual([row.status, row.attempt_count], ['retry', 1], 'the batch recorded its attempt before the pool closed');
        assert.deepEqual((await deliveries()).filter(item => item.status === 'delivering'), [], 'and left no delivery leased');
        await assert.rejects(application.core.pool().query('SELECT 1'), 'the pool is closed');
      } finally {
        await settle(application, stop, hold);
      }
    }

    /*
     * ---- Stopped mid-scan, the server waits for it before the pool closes ----
     * Replaces exposure scanning's check that the composition drains its
     * worker at shutdown. A scan is queued under the server's own
     * configuration and the worker asked to run it; the scan is held where it
     * looks for its requester's session, then the server is stopped: it does
     * not exit while the scan is held. Let go, the scan finds no session and
     * is stopped as revoked; only then is the pool closed, and the exit clean.
     * Undrained, the pool would close under the scan, and leave it running.
     */
    {
      const application = await composedApplication(environment);
      const hold = await database.client();
      let stop = null;
      try {
        assert.equal(await application.core.ready(), true);
        const { keys } = loadServerSecrets({ SESSION_SECRET: SECRET });
        const { scan } = await application.core.exposure.exposureService().requestScan(scanRequest(fingerprintKeyId(keys.exposureFingerprint), 'lifecycle-in-flight'));
        await hold.query('BEGIN');
        await hold.query('LOCK TABLE nv_sessions IN ACCESS EXCLUSIVE MODE');
        application.core.exposure.nudgeExposureWorker();
        await until('the scan to be held', waitingOn('SELECT sid, data, session_key_hash FROM nv_sessions'));
        assert.equal((await scanOf(scan.scanId)).state, 'running', 'the worker has claimed the scan');
        stop = stopping(application);
        await pause(400);
        assert.equal(stop.code, undefined, 'the stopped server does not exit while a scan is in flight');
        await hold.query('COMMIT');
        assert.equal(await exitOf(stop), 0, 'once the scan is done, it exits cleanly');
        assert.deepEqual(await scanOf(scan.scanId), { state: 'failed', skipped_reason: 'authorization-revoked' },
          'the scan finished before the pool closed: with no session to read with, it is stopped as revoked');
        await assert.rejects(application.core.pool().query('SELECT 1'), 'the pool is closed');
      } finally {
        await settle(application, stop, hold);
      }
    }
  } finally {
    for (const server of servers) if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
    await client.end();
    github.restore();
    await database.drop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  /* A warning is emitted on the next turn; it has had one by now. */
  await new Promise(resolve => setImmediate(resolve));
  overlapping.stop();
  assert.deepEqual(overlapping.seen, [], 'no database client was handed a query while it was still running one');
  console.log('composition, its life: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
