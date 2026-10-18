'use strict';

/*
 * A database that cannot be reached is not a tester who has been turned away.
 *
 * Against the real server and a real PostgreSQL store, with invitations on:
 *
 *   - while the access store cannot be read, a tester's request answers 503
 *     ALPHA_ACCESS_UNAVAILABLE with a Retry-After, and the access cookie is
 *     kept. It used to answer 500 and clear the cookie, and an invitation is
 *     redeemed once: a scale-to-zero wake that failed, or a minute of Neon
 *     maintenance, signed every tester out for good;
 *   - /api/alpha/status says the same and keeps the cookie the same way;
 *   - once the store answers again, the same cookie is the same session;
 *   - an invitation redeemed while the store cannot be written answers 503
 *     and is not spent: it redeems once the store is back;
 *   - a revoked tester is still turned away, and that cookie is still cleared.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { loadMigrations, runMigrations } = require('../src/migrations');
const { AlphaAccessStore } = require('../src/alpha-access-store');

const root = path.join(__dirname, '..');
const adminUrl = process.env.NV_TEST_DATABASE_URL;
assert(adminUrl, 'NV_TEST_DATABASE_URL must name a disposable local PostgreSQL test service');
const database = `nv_alpha_outage_${crypto.randomBytes(6).toString('hex')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
databaseUrl.searchParams.set('sslmode', 'disable');
const pepper = crypto.randomBytes(32).toString('hex');
const termsVersion = '2026-07-29';
const repository = 'github:github.com/acme/sandbox';
let child;
let logs = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const clearsAccess = response => (response.headers.getSetCookie ? response.headers.getSetCookie() : [])
  .some(line => /^nv_alpha_access=;/.test(line) || (/^nv_alpha_access=/.test(line) && /Max-Age=0/i.test(line)));

async function main() {
  const admin = new Client({ connectionString: adminUrl });
  let client;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    client = new Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    await runMigrations(client, loadMigrations(path.join(root, 'db/migrations')));
    const store = new AlphaAccessStore({ pool: { query: (...args) => client.query(...args), connect: async () => ({ query: (...args) => client.query(...args), release() {} }) }, pepper });
    const port = await freePort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: crypto.randomBytes(40).toString('hex'),
        DATABASE_URL: databaseUrl.toString(), NV_DB_INSECURE: '1', NV_DEPLOYMENT_PROFILE: 'local',
        NV_ALPHA_ACCESS_MODE: 'invite', NV_ALPHA_INVITE_PEPPER: pepper, NV_ALPHA_TERMS_VERSION: termsVersion,
        NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const origin = `http://127.0.0.1:${port}`;
    const send = (route, options = {}) => fetch(`${origin}${route}`, {
      ...options, headers: { 'x-nv': '1', 'content-type': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(15000)
    });
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { if ((await send('/healthz')).ok) break; } catch {}
      if (Date.now() >= deadline) throw new Error(`HTTP startup timed out\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const redeem = code => send('/api/alpha/redeem', { method: 'POST', body: JSON.stringify({ code, acceptedTermsVersion: termsVersion }) });

    const first = await store.issueInvite({ testerLabel: 'outage tester', termsVersion, repositoryScopes: [repository] });
    const redeemed = await redeem(first.code);
    assert.strictEqual(redeemed.status, 200, await redeemed.clone().text());
    const cookie = redeemed.headers.getSetCookie().find(line => line.startsWith('nv_alpha_access=')).split(';')[0];
    const statusBefore = await (await send('/api/alpha/status', { headers: { cookie } })).json();
    assert.deepStrictEqual([statusBefore.authenticated, statusBefore.testerLabel], [true, 'outage tester'], JSON.stringify(statusBefore));

    /* 1. The store cannot be read: unavailable, not turned away, and the cookie stays. */
    await client.query('ALTER TABLE nv_alpha_sessions RENAME TO nv_alpha_sessions_unavailable');
    let during;
    let statusDuring;
    try {
      during = await send('/api/me', { headers: { cookie } });
      statusDuring = await send('/api/alpha/status', { headers: { cookie } });
    } finally {
      await client.query('ALTER TABLE nv_alpha_sessions_unavailable RENAME TO nv_alpha_sessions');
    }
    const duringBody = await during.json();
    assert.strictEqual(during.status, 503, `an unreadable access store is unavailable, not a server fault: ${during.status} ${JSON.stringify(duringBody)}`);
    assert.strictEqual(duringBody.code, 'ALPHA_ACCESS_UNAVAILABLE');
    assert(Number(during.headers.get('retry-after')) > 0, 'the answer says when to try again');
    assert(!clearsAccess(during), 'a database outage cleared the access cookie; the invitation behind it cannot be redeemed again');
    assert.strictEqual(statusDuring.status, 503);
    assert(!clearsAccess(statusDuring), '/api/alpha/status cleared the access cookie during an outage');

    /* 2. The store is back: the same cookie is the same session. */
    const statusAfter = await (await send('/api/alpha/status', { headers: { cookie } })).json();
    assert.deepStrictEqual([statusAfter.authenticated, statusAfter.testerLabel], [true, 'outage tester'], `the session did not survive the outage: ${JSON.stringify(statusAfter)}`);

    /* 3. An invitation redeemed while the store cannot be written is not spent. */
    const second = await store.issueInvite({ testerLabel: 'second tester', termsVersion, repositoryScopes: [repository] });
    await client.query('ALTER TABLE nv_alpha_sessions RENAME TO nv_alpha_sessions_unavailable');
    let blocked;
    try {
      blocked = await redeem(second.code);
    } finally {
      await client.query('ALTER TABLE nv_alpha_sessions_unavailable RENAME TO nv_alpha_sessions');
    }
    const blockedBody = await blocked.json();
    assert.strictEqual(blocked.status, 503, `a redemption that could not be recorded is unavailable: ${blocked.status} ${JSON.stringify(blockedBody)}`);
    assert.strictEqual(blockedBody.code, 'ALPHA_ACCESS_UNAVAILABLE');
    const retried = await redeem(second.code);
    assert.strictEqual(retried.status, 200, `the invitation was spent by a redemption that failed: ${await retried.clone().text()}`);

    /* 4. A revoked tester is still turned away, and that cookie is cleared. */
    const tester = await client.query('SELECT tester_id FROM nv_alpha_testers WHERE invite_id=$1', [first.inviteId]);
    await store.revokeTester(tester.rows[0].tester_id, 'outage test revocation');
    const revoked = await send('/api/me', { headers: { cookie } });
    assert.deepStrictEqual([revoked.status, (await revoked.json()).code], [403, 'ALPHA_ACCESS_REVOKED']);
    assert(clearsAccess(revoked), 'a revoked tester\'s cookie is cleared');

    console.log('alpha access outage server regressions passed');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    if (client) await client.end().catch(() => {});
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

main().catch(error => { console.error(error); console.error(logs.slice(-4000)); process.exit(1); });
