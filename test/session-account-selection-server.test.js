'use strict';

/*
 * Which account acts, across the writes that change it, against the real
 * server and a real PostgreSQL session store.
 *
 *   - A sign-in made while a retired account is selected chooses the new
 *     GitHub account, and that choice holds on the next read. The "choose an
 *     account" flag is computed per read; it is never saved.
 *   - Removing an account listed before the selected one keeps the same
 *     identity selected, rather than whichever account slid into its index.
 *   - A session store that cannot be read during a sign-in is unavailable, not
 *     empty: the existing session is kept, never deleted as if nothing were
 *     there.
 */

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { loadMigrations, runMigrations } = require('../src/migrations');
const { hashJson } = require('../src/intelligence');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('../src/key-derivation');
const { createCsrfToken } = require('../src/security-foundation');

const root = path.join(__dirname, '..');
const adminUrl = process.env.NV_TEST_DATABASE_URL;
assert(adminUrl, 'NV_TEST_DATABASE_URL must name a disposable local PostgreSQL test service');
const database = `nv_selection_${crypto.randomBytes(6).toString('hex')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
databaseUrl.searchParams.set('sslmode', 'disable');
const secret = crypto.randomBytes(40).toString('hex');
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const csrfSecret = deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN);
const github = login => ({ provider: 'github', login, providerAccountId: login.length, authMethod: 'token', token: `fixture-${login}` });
/* An account of a provider this product no longer supports, as an old session may still hold it. */
const retired = { provider: 'gitlab', login: 'old', providerAccountId: 9, authMethod: 'token', baseUrl: 'https://gitlab.com', token: 'fixture-retired' };
const keyOf = account => hashJson({ provider: account.provider, login: account.login, baseUrl: account.baseUrl || '' });
let child;
let logs = '';

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function unseal(value) {
  const raw = Buffer.from(value, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}
async function seedSession(client, accounts, active) {
  const sid = crypto.randomBytes(24).toString('hex');
  const sessionNonce = crypto.randomBytes(24).toString('hex');
  const data = { accounts, active, security: { sessionNonce, stepUp: null }, safety: { readOnly: false, freezeSync: false, protected: {} } };
  await client.query('INSERT INTO nv_sessions(sid,data,identity_keys,updated) VALUES($1,$2,$3,now())', [sid, seal(data), accounts.map(keyOf)]);
  return {
    sid,
    headers: {
      cookie: `nv_session=${seal({ sid })}`, 'x-nv': '1', 'content-type': 'application/json',
      'x-nv-csrf': createCsrfToken(csrfSecret, { sessionBinding: sessionNonce, identityKey: keyOf(accounts[active]) })
    }
  };
}
async function stored(client, sid) {
  const result = await client.query('SELECT data FROM nv_sessions WHERE sid=$1', [sid]);
  return result.rows.length ? unseal(result.rows[0].data) : null;
}
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
    const port = await freePort();
    child = spawn(process.execPath, ['-r', './test/fixtures/github-account-operations-fetch.js', 'server.js'], {
      cwd: root,
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: secret,
        DATABASE_URL: databaseUrl.toString(), NV_DB_INSECURE: '1', NV_ALPHA_ACCESS_MODE: 'off',
        NV_DEPLOYMENT_PROFILE: 'local', NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const request = async (route, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { if ((await request('/healthz')).status === 200) break; } catch {}
      if (Date.now() >= deadline) throw new Error(`HTTP startup timed out\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    /* 1. A GitHub sign-in over a retired selection is the choice it asks for, and it holds. */
    {
      const seeded = await seedSession(client, [retired, github('bob')], 0);
      const before = await request('/api/me', { headers: seeded.headers });
      assert.strictEqual(before.status, 409, JSON.stringify(before.body));
      assert.strictEqual(before.body.code, 'ACCOUNT_SELECTION_REQUIRED');
      /* The fixture's identity endpoint answers as alice. */
      const login = await request('/api/login', { method: 'POST', headers: seeded.headers, body: JSON.stringify({ provider: 'github', token: 'fixture-alice' }) });
      assert.strictEqual(login.status, 200, JSON.stringify(login.body));
      const cookie = login.cookie || seeded.headers.cookie;
      const me = await request('/api/me', { headers: { cookie } });
      assert.strictEqual(me.status, 200, `a GitHub sign-in left the session asking for a choice it had just made: ${JSON.stringify(me.body)}`);
      assert.strictEqual(me.body.login, 'alice');
      /* Provider routes read the GitHub-only view of the session, where the flag would refuse every one. */
      const repos = await request('/api/repos', { headers: { cookie } });
      assert.notStrictEqual(repos.body && repos.body.code, 'ACCOUNT_SELECTION_REQUIRED',
        `a provider route still asks for an account choice after the sign-in made it: ${JSON.stringify(repos.body)}`);
      const saved = await stored(client, seeded.sid);
      assert(saved, 'the sign-in kept the session row');
      assert(!('retiredSelection' in saved), 'a per-read flag was written into the stored session');
    }

    /* 2. Removing an account listed before the selected one keeps the same identity selected. */
    {
      const seeded = await seedSession(client, [github('carol'), github('bob'), github('dave')], 1);
      const removed = await request('/api/accounts/remove', { method: 'POST', headers: seeded.headers, body: JSON.stringify({ idx: 0 }) });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
      assert.strictEqual(removed.body.active, 'bob', `removing carol made ${removed.body.active} the acting account`);
      const saved = await stored(client, seeded.sid);
      assert.deepStrictEqual(saved.accounts.map(account => account.login), ['bob', 'dave']);
      assert.strictEqual(saved.accounts[saved.active].login, 'bob');
    }

    /* 3. A session store that cannot be read during a sign-in keeps the session it could not read. */
    {
      const seeded = await seedSession(client, [github('bob')], 0);
      await client.query('ALTER TABLE nv_sessions RENAME COLUMN data TO data_unavailable');
      let login;
      try {
        login = await request('/api/login', { method: 'POST', headers: seeded.headers, body: JSON.stringify({ provider: 'github', token: 'fixture-alice' }) });
      } finally {
        await client.query('ALTER TABLE nv_sessions RENAME COLUMN data_unavailable TO data');
      }
      assert.strictEqual(login.status, 503, `an unreadable session store must answer unavailable: ${JSON.stringify(login)}`);
      const saved = await stored(client, seeded.sid);
      assert(saved, 'a sign-in during a database fault deleted the session it could not read');
      assert.deepStrictEqual(saved.accounts.map(account => account.login), ['bob']);
    }

    console.log('session account selection server regressions passed');
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
