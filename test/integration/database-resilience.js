'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { createDatabasePool, DATABASE_BUDGETS } = require('../../src/database-pool');
const root = path.join(__dirname, '../..');
const adminUrl = String(process.env.NV_TEST_DATABASE_URL || '');
if (!adminUrl) throw new Error('NV_TEST_DATABASE_URL is required for the real database resilience gate');
const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Database resilience requires a disposable loopback PostgreSQL server');
const database = `nv_resilience_${crypto.randomBytes(6).toString('hex')}`;
const appName = database;
const port = 30000 + Math.floor(Math.random() * 900);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, logs = '', scratch, workload;
const admin = new Client({ connectionString: adminUrl });

async function eventually(check, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Application exited during ${label}: ${logs}`);
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function status(route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(15000) });
  await response.body.cancel();
  return response.status;
}
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  try {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    url.searchParams.set('sslmode', 'disable');
    url.searchParams.set('application_name', appName);
    scratch = new Client({ connectionString: url.toString() });
    await scratch.connect();
    child = spawn(process.execPath, ['server.js'], { cwd: root,
      env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: url.toString(),
        NV_DB_INSECURE: '1', NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local',
        NV_DATABASE_MIGRATION_MODE: 'apply', SESSION_SECRET: crypto.randomBytes(40).toString('hex') },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await eventually(() => status('/readyz').then(code => code === 200, () => false), 'initial readiness');

    // Terminate a real idle web connection twice. Liveness survives; readiness
    // drains during the reconnect backoff and recovers with verified migrations.
    const scratchPid = (await scratch.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    for (let attempt = 0; attempt < 2; attempt++) {
      let pid;
      await eventually(async () => {
        const clients = await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle' AND pid<>$2", [appName, scratchPid]);
        pid = clients.rows[0]?.pid;
        return Boolean(pid);
      }, 'an idle web connection');
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await eventually(() => status('/readyz').then(code => code === 503, () => false), 'readiness to drain', 5000);
      assert.strictEqual(await status('/healthz'), 200, 'idle loss must not kill the process');
      await eventually(() => status('/readyz').then(code => code === 200, () => false), 'readiness recovery');
    }
    assert.match(logs, /database-idle-disconnect/, 'the connection fault must be observable without leaking connection details');
    assert(!logs.includes("Unhandled 'error' event"));

    const faults = [];
    workload = createDatabasePool(url.toString(), error => faults.push(error.code));
    const connection = await workload.connect();
    const limits = await connection.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle");
    assert.deepStrictEqual(limits.rows[0], { statement: '10s', lock: '3s', idle: '15s' });
    const activePid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = connection.query('SELECT pg_sleep(60)');
    const failed = assert.rejects(pending, /terminating connection|Connection terminated/);
    await admin.query('SELECT pg_terminate_backend($1)', [activePid]);
    await failed;
    connection.release(true);
    assert.strictEqual((await workload.query('SELECT 42 AS n')).rows[0].n, 42, 'active-query loss must permit a replacement connection');

    // A checked-out client can also lose its socket between queries, without a
    // query promise available to catch the error. Its event must be handled.
    const between = await workload.connect();
    const betweenPid = (await between.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1)', [betweenPid]);
    await eventually(() => Promise.resolve(faults.includes('57P01')), 'checked-out connection error handling', 3000);
    between.release(true);

    let started = Date.now();
    await assert.rejects(workload.query('SELECT pg_sleep(60)'), /statement timeout/);
    assert(Date.now() - started < DATABASE_BUDGETS.query_timeout + 2000, 'query execution must be bounded');
    await scratch.query('CREATE TABLE resilience_lock(id integer)');
    await scratch.query('BEGIN');
    await scratch.query('LOCK TABLE resilience_lock IN ACCESS EXCLUSIVE MODE');
    try {
      started = Date.now();
      await assert.rejects(workload.query('SELECT * FROM resilience_lock'), /lock timeout/);
      assert(Date.now() - started < 6000, 'lock contention must fail within its budget');
    } finally { await scratch.query('ROLLBACK'); }
    assert.strictEqual((await workload.query('SELECT count(*)::int AS n FROM resilience_lock')).rows[0].n, 0);
    assert.strictEqual(await status('/readyz'), 200);
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    assert.strictEqual(child.exitCode, 0, 'graceful shutdown must drain and close the pool');
    console.log('real PostgreSQL repeated idle loss, active loss, query/lock deadlines, recovery and shutdown passed');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => child.kill('SIGKILL'), 10000).unref(); });
    }
    if (workload) await workload.end();
    if (scratch) await scratch.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error.stack, logs); process.exitCode = 1; });
