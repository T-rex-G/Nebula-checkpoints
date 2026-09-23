'use strict';

/*
 * The property the whole foundation plan exists for, asserted the only way it
 * can honestly be asserted: two processes, one database, one set of keys.
 *
 * Everything else in this branch is proved against a fake database or a source
 * assertion. Those catch the mistakes they were written for, but none of them
 * can tell you whether a guard actually holds when the second process is real
 * -- which is the exact claim being made. A limit that is N per instance and a
 * grant that can be spent once per instance both pass every unit test in the
 * repository.
 *
 * It refuses rather than skips when there is no server, for the same reason
 * the migration gate does: a gate that quietly passes when its dependency is
 * missing is the same as not having the gate.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { loadMigrations, runMigrations } = require('../src/migrations');
const { SingleUseStore } = require('../src/single-use-store');
const { RateLimitStore } = require('../src/rate-limit-store');

const root = path.resolve(__dirname, '..');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();
if (!ADMIN_URL) {
  throw new Error(
    'NV_TEST_DATABASE_URL is required: this gate proves the multi-instance properties against a real PostgreSQL server'
  );
}

const SECRET = 'multi-instance-contract-secret-0123456789abcdef-0123456789abcdef';
const scratch = `nvx_multi_instance_${crypto.randomBytes(6).toString('hex')}`;

function urlFor(databaseName) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

function startInstance(port, databaseUrl) {
  const withoutTls = databaseUrl
    ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}sslmode=disable`
    : '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      SESSION_SECRET: SECRET,
      DATABASE_URL: withoutTls,
      NV_GIT_HOST_ALLOWLIST: 'gitea.example',
      NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn',
      /*
       * The test server is a container on the same host, not a hosted
       * database, and it speaks no TLS. Production still refuses to disable it
       * -- src/config.js throws on sslmode=disable when NODE_ENV is production
       * regardless of this flag -- so the switch cannot be turned on where it
       * would matter.
       */
      NV_DB_INSECURE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.logs = '';
  child.stdout.on('data', chunk => { child.logs += chunk.toString(); });
  child.stderr.on('data', chunk => { child.logs += chunk.toString(); });
  return child;
}

async function waitReady(child, port) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`instance on ${port} exited early\n${child.logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.body) await response.body.cancel();
      if (response.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`instance on ${port} never became ready\n${child.logs}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

const portA = 36000 + Math.floor(Math.random() * 300);
const portB = portA + 1;
let instanceA = null;
let instanceB = null;

(async () => {
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${scratch}`));
  const databaseUrl = urlFor(scratch);

  try {
    /* The schema the instances will share. */
    await withClient(databaseUrl, client =>
      runMigrations(client, loadMigrations(path.join(root, 'db', 'migrations'))));

    /*
     * A single-use grant is spent once, across connections. Two stores on two
     * pools is the smallest honest model of two processes: nothing is shared
     * between them but the table.
     */
    {
      const poolA = new Client({ connectionString: databaseUrl });
      const poolB = new Client({ connectionString: databaseUrl });
      await poolA.connect(); await poolB.connect();
      try {
        const storeA = new SingleUseStore({ pool: poolA });
        const storeB = new SingleUseStore({ pool: poolB });
        const claim = { kind: 'step-up', key: `grant-${crypto.randomUUID()}`, expiresAt: Date.now() + 300_000 };

        assert.strictEqual(await storeA.consumeOnce(claim), true, 'the first connection claims the grant');
        assert.strictEqual(
          await storeB.consumeOnce(claim), false,
          'a second connection must be refused: this is the property a per-process Map cannot hold'
        );

        /* And simultaneously, which is the case a sequential test cannot see. */
        const contended = { kind: 'github-app-state', key: `state-${crypto.randomUUID()}`, expiresAt: Date.now() + 300_000 };
        const raced = await Promise.all([storeA.consumeOnce(contended), storeB.consumeOnce(contended)]);
        assert.strictEqual(
          raced.filter(Boolean).length, 1,
          'exactly one of two simultaneous connections may claim one grant'
        );

        /* All three kinds, since each replaced a separate Map. */
        for (const kind of ['step-up', 'github-app-state', 'restore-authorization']) {
          const key = `kind-${crypto.randomUUID()}`;
          assert.strictEqual(await storeA.consumeOnce({ kind, key, expiresAt: Date.now() + 300_000 }), true);
          assert.strictEqual(
            await storeB.consumeOnce({ kind, key, expiresAt: Date.now() + 300_000 }), false,
            `${kind} must be single-use across connections`
          );
        }
      } finally {
        await poolA.end(); await poolB.end();
      }
    }

    /* A limit of N is N across connections rather than N for each. */
    {
      const poolA = new Client({ connectionString: databaseUrl });
      const poolB = new Client({ connectionString: databaseUrl });
      await poolA.connect(); await poolB.connect();
      try {
        const storeA = new RateLimitStore({ pool: poolA });
        const storeB = new RateLimitStore({ pool: poolB });
        const key = `caller-${crypto.randomUUID()}`;
        const shared = { namespace: 'api', key, windowMs: 60_000, limit: 10, inclusiveReset: false };

        let allowed = 0;
        for (let i = 0; i < 20; i += 1) {
          const verdict = await (i % 2 === 0 ? storeA : storeB).count(shared);
          if (verdict.allowed) allowed += 1;
        }
        assert.strictEqual(
          allowed, 10,
          'two connections share one ceiling; per-process counters would have allowed twenty'
        );
      } finally {
        await poolA.end(); await poolB.end();
      }
    }

    /*
     * Now the same claim through two real servers. The limiter runs before
     * authentication, so an anonymous request is enough to be counted, and
     * both instances see the same address -- which is the identity the limiter
     * falls back to and therefore the one they must share.
     */
    instanceA = startInstance(portA, databaseUrl);
    instanceB = startInstance(portB, databaseUrl);
    await Promise.all([waitReady(instanceA, portA), waitReady(instanceB, portB)]);

    {
      let refusedBy = null;
      let sent = 0;
      /* Generous: the ceiling is 300, and a per-process pair would need 600. */
      for (let i = 0; i < 420 && refusedBy === null; i += 1) {
        const port = i % 2 === 0 ? portA : portB;
        const response = await fetch(`http://127.0.0.1:${port}/api/config`);
        if (response.body) await response.body.cancel();
        sent += 1;
        if (response.status === 429) refusedBy = port;
      }
      assert.notStrictEqual(
        refusedBy, null,
        'neither instance ever refused: the limit is still being counted per process'
      );
      assert(
        sent <= 340,
        `the shared ceiling of 300 was reached after ${sent} requests split across two instances; `
        + 'a per-process count would not have refused before 600'
      );
    }

    /* Without a database an instance still boots and serves, on its own. */
    {
      const portC = portB + 1;
      const solo = startInstance(portC, '');
      try {
        await waitReady(solo, portC);
        const response = await fetch(`http://127.0.0.1:${portC}/healthz`);
        if (response.body) await response.body.cancel();
        assert.strictEqual(response.ok, true, 'the no-database profile must still serve');
      } finally {
        solo.kill('SIGTERM');
      }
    }

    console.log('multi-instance contract tests passed (two processes, one database)');
  } finally {
    if (instanceA) instanceA.kill('SIGTERM');
    if (instanceB) instanceB.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    await withClient(ADMIN_URL, client =>
      client.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`)).catch(() => {});
  }
})().catch(error => {
  if (instanceA) instanceA.kill('SIGTERM');
  if (instanceB) instanceB.kill('SIGTERM');
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
