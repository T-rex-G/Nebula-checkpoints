'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');
const vm = require('vm');
const { loadMigrations, runMigrations } = require('../src/migrations');
const { hashJson } = require('../src/intelligence');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('../src/key-derivation');
const { createCsrfToken, createStepUpGrant, normalizeStepUpRequest, scopeHash } = require('../src/security-foundation');

const root = path.join(__dirname, '..');
const adminUrl = process.env.NV_TEST_DATABASE_URL;
assert(adminUrl, 'NV_TEST_DATABASE_URL must name a disposable local PostgreSQL test service');
const database = `nv_corona_${crypto.randomBytes(6).toString('hex')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
databaseUrl.searchParams.set('sslmode', 'disable');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-corona-'));
const providerLog = path.join(temporary, 'provider.jsonl');
const secret = crypto.randomBytes(40).toString('hex');
const account = { provider: 'github', login: 'alice', providerAccountId: 7, authMethod: 'token', token: 'fixture-admin' };
const identityKey = hashJson({ provider: 'github', login: 'alice', baseUrl: '' });
/* An account of a provider this product no longer supports, as an old session may still hold it. */
const retired = { provider: 'gitlab', login: 'alice-old', providerAccountId: 9, authMethod: 'token', baseUrl: 'https://gitlab.com', token: 'fixture-retired' };
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const csrfSecret = deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN);
const stepUpSecret = deriveSecret(secret, KEY_PURPOSES.STEP_UP_GRANT);
let child;
let logs = '';

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

async function seedSession(client, { stepUp = false, accounts = [account], active = 0 } = {}) {
  const sid = crypto.randomBytes(24).toString('hex');
  const sessionNonce = crypto.randomBytes(24).toString('hex');
  const security = { sessionNonce, stepUp: null };
  const headers = {
    cookie: `nv_session=${seal({ sid })}`, 'x-nv': '1', 'content-type': 'application/json',
    'x-nv-csrf': createCsrfToken(csrfSecret, { sessionBinding: sessionNonce, identityKey })
  };
  if (stepUp) {
    const operation = normalizeStepUpRequest('sessions.revoke-others', {}, { provider: 'github', identityKey });
    const jti = crypto.randomUUID();
    security.stepUp = { jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt: Date.now() + 300000, assurance: 'credential' };
    headers['x-nv-step-up'] = createStepUpGrant(stepUpSecret, {
      sessionBinding: sessionNonce, identityKey, ...operation, assurance: 'credential'
    }, { jti });
  }
  const data = { accounts, active, security, safety: { readOnly: false, freezeSync: false, protected: {} } };
  const keys = accounts.map(item => hashJson({ provider: item.provider, login: item.login, baseUrl: item.baseUrl || '' }));
  await client.query('INSERT INTO nv_sessions(sid,data,identity_keys,updated) VALUES($1,$2,$3,now())', [sid, seal(data), keys]);
  return { sid, headers };
}

async function waitFor(check, description) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (child && child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    if (Date.now() >= deadline) throw new Error(`${description} timed out\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
    // Execute the production persistence functions against independent pool
    // connections. Both requests carry stale middleware/session snapshots.
    const safetyPool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
      const functions = source.slice(source.indexOf('function defaultSafety('), source.indexOf('async function appendEvidence('));
      const context = { DB_URL: databaseUrl.toString(), dbReady: async () => true, pool: () => safetyPool, identityKey: () => identityKey };
      vm.createContext(context);
      vm.runInContext(functions + ';this.save = savePersistentSafety;', context);
      const staleRequest = () => ({ gh: account, session: { safety: { readOnly: false, freezeSync: false, protected: {} } } });
      const readState = async () => (await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1', [identityKey])).rows[0].state;
      // Also exercises the initially absent row: row locks alone cannot serialize it.
      await Promise.all([
        context.save(staleRequest(), { readOnly: true, freezeSync: true }),
        context.save(staleRequest(), { protect: { repo: 'alice/demo', path: 'private', on: true } })
      ]);
      assert.deepStrictEqual(await readState(), { readOnly: true, freezeSync: true, protected: { 'alice/demo': ['private'] } }, 'a stale protection request must not undo emergency containment');
      await Promise.all([
        context.save(staleRequest(), { protect: { repo: 'alice/demo', path: 'credentials', on: true } }),
        context.save(staleRequest(), { protect: { repo: 'alice/demo', path: 'deploy', on: true } })
      ]);
      assert.deepStrictEqual((await readState()).protected['alice/demo'], ['credentials', 'deploy', 'private'], 'concurrent path additions must both persist');
      await context.save(staleRequest(), { readOnly: false });
      assert.deepStrictEqual(await readState(), { readOnly: false, freezeSync: true, protected: { 'alice/demo': ['credentials', 'deploy', 'private'] } }, 'an explicit unlock must change only its requested control');
      await assert.rejects(context.save(staleRequest(), { protect: { repo: 'alice/demo', path: '../escape' } }), error => error.status === 400 && error.code === 'SAFETY_INPUT_INVALID');
      assert.deepStrictEqual((await readState()).protected['alice/demo'], ['credentials', 'deploy', 'private'], 'invalid patches roll back without changing controls');
      /* A database that refuses the connection, or fails inside the transaction, makes the controls unavailable, never an unexplained server error. */
      const brokenPools = [
        { connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } },
        { connect: async () => ({ query: async sql => { if (sql === 'ROLLBACK') return null; throw Object.assign(new Error('terminating connection'), { code: '57P01' }); }, release() {} }) }
      ];
      for (const broken of brokenPools) {
        context.pool = () => broken;
        await assert.rejects(context.save(staleRequest(), { readOnly: true }), error => error.status === 503 && error.code === 'SAFETY_STATE_UNAVAILABLE');
      }
      context.pool = () => safetyPool;
      await assert.rejects(context.save(staleRequest(), { protect: { repo: 'not a repository', path: 'x' } }), error => error.status === 400 && error.code === 'SAFETY_INPUT_INVALID', 'a refused change still says why');
      const cookieOnly = staleRequest();
      context.DB_URL = '';
      await context.save(cookieOnly, { readOnly: true });
      await context.save(cookieOnly, { protect: { repo: 'alice/demo', path: 'private' } });
      assert.strictEqual(cookieOnly.session.safety.readOnly, true, 'cookie-only deployments retain controls across patches');
      assert.deepStrictEqual(Array.from(cookieOnly.session.safety.protected['alice/demo']), ['private']);
      await client.query('DELETE FROM nv_security_state WHERE identity_key=$1', [identityKey]);
      console.log('Corona concurrent safety patch regressions passed');
    } finally { await safetyPool.end(); }
    const port = await freePort();
    child = spawn(process.execPath, ['-r', './test/fixtures/capability-promotion.js', '-r', './test/fixtures/corona-fetch.js', 'server.js'], {
      cwd: root,
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: secret, NV_TEST_PROMOTE_CAPABILITIES: 'repository.create,repository.delete,notifications,live-events',
        DATABASE_URL: databaseUrl.toString(), NV_DB_INSECURE: '1', NV_ALPHA_ACCESS_MODE: 'off',
        NV_DEPLOYMENT_PROFILE: 'local', NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn',
        NV_ACCOUNT_OPERATIONS_LOG: providerLog, NV_CORONA_BARRIER: temporary
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const request = async (route, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    await waitFor(async () => {
      try { return (await request('/healthz')).status === 200; } catch { return false; }
    }, 'HTTP startup');

    const stale = await seedSession(client);
    await client.query('INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2,now())', [identityKey, { readOnly: true, freezeSync: true, protected: {} }]);
    const creation = { method: 'POST', headers: stale.headers, body: JSON.stringify({ name: 'corona-fixture' }) };
    const locked = await request('/api/repos', creation);
    assert.strictEqual(locked.status, 423, JSON.stringify(locked));
    await client.query('ALTER TABLE nv_security_state RENAME TO nv_security_state_unavailable');
    let unavailable;
    try { unavailable = await request('/api/repos', creation); }
    finally { await client.query('ALTER TABLE nv_security_state_unavailable RENAME TO nv_security_state'); }
    const writesDuringOutage = fs.existsSync(providerLog)
      ? fs.readFileSync(providerLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(event => event.method === 'POST')
      : [];
    console.log(JSON.stringify({ case: 'safety-read-outage', lockedStatus: locked.status, outageStatus: unavailable.status, providerWrites: writesDuringOutage.length }));

    await client.query('UPDATE nv_security_state SET state=$2 WHERE identity_key=$1', [identityKey, { readOnly: false, freezeSync: false, protected: {} }]);
    const survivor = await seedSession(client, { stepUp: true });
    const revoked = await seedSession(client);
    const reauthentication = request('/api/security/step-up', {
      method: 'POST', headers: revoked.headers,
      body: JSON.stringify({ action: 'sessions.revoke-others', scope: {}, confirm: 'alice', credential: 'fixture-delayed' })
    });
    await waitFor(() => fs.existsSync(path.join(temporary, 'reauth-started')), 'reauthentication barrier');
    const revoke = await request('/api/security/revoke-others', {
      method: 'POST', headers: survivor.headers, body: JSON.stringify({ confirm: true })
    });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke));
    assert.strictEqual((await client.query('SELECT 1 FROM nv_sessions WHERE sid=$1', [revoked.sid])).rowCount, 0, 'the revocation route must delete the paused session');
    fs.writeFileSync(path.join(temporary, 'reauth-release'), 'continue');
    const reauthenticated = await reauthentication;
    const replay = await request('/api/security/csrf', { headers: revoked.headers });
    console.log(JSON.stringify({ case: 'revocation-races-session-save', revokeStatus: revoke.status, reauthenticationStatus: reauthenticated.status, oldCookieStatus: replay.status }));

    assert.deepStrictEqual({
      safetyStatus: unavailable.status, providerWrites: writesDuringOutage.length,
      reauthenticationStatus: reauthenticated.status, revokedCookieStatus: replay.status
    }, {
      safetyStatus: 503, providerWrites: 0,
      reauthenticationStatus: 401, revokedCookieStatus: 401
    }, 'durable safety must fail closed, and in-flight session saves must never resurrect revoked sessions');

    const login = await request('/api/login', {
      method: 'POST', headers: revoked.headers,
      body: JSON.stringify({ provider: 'github', token: 'fixture-admin' })
    });
    assert.strictEqual(login.status, 200, 'fresh authentication must recover from a revoked cookie');
    assert(login.cookie && login.cookie !== revoked.headers.cookie, 'reauthentication must issue a new cookie');
    assert.strictEqual((await client.query('SELECT 1 FROM nv_sessions WHERE sid=$1', [revoked.sid])).rowCount, 0, 'login must not resurrect the revoked session ID');
    assert.strictEqual((await request('/api/security/csrf', { headers: { cookie: login.cookie } })).status, 200);
    assert.strictEqual((await request('/api/security/csrf', { headers: revoked.headers })).status, 401, 'fresh login must leave the stolen old cookie revoked');
    console.log('Corona durable safety and revocation HTTP regressions passed');

    /* ---- A session that ends while its safety change commits ---------------------- */
    const sessionRow = async sid => (await client.query('SELECT 1 FROM nv_sessions WHERE sid=$1', [sid])).rowCount;
    const evidenceCount = async (kind, repoKey) => Number((await client.query(
      'SELECT count(*)::int AS n FROM nv_evidence_chain WHERE kind=$1 AND ($2::text IS NULL OR repo_key=$2)', [kind, repoKey || null])).rows[0].n);
    await client.query('CREATE TABLE nv_test_session_end(sid text PRIMARY KEY)');
    await client.query(`CREATE FUNCTION nv_test_end_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM nv_sessions WHERE sid IN (SELECT sid FROM nv_test_session_end); RETURN NEW; END $$`);
    await client.query('CREATE TRIGGER nv_test_end_session AFTER INSERT OR UPDATE ON nv_security_state FOR EACH ROW EXECUTE FUNCTION nv_test_end_session()');
    {
      const ending = await seedSession(client);
      await client.query('INSERT INTO nv_test_session_end(sid) VALUES($1)', [ending.sid]);
      const before = await evidenceCount('safety-change', `safety:${identityKey}`);
      const change = await request('/api/safety', { method: 'POST', headers: ending.headers, body: JSON.stringify({ readOnly: true }) });
      assert.strictEqual(change.status, 200, `a committed change is not reported as failed: ${JSON.stringify(change)}`);
      assert.strictEqual(change.body.readOnly, true);
      assert.strictEqual((await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1', [identityKey])).rows[0].state.readOnly, true);
      assert.strictEqual(await evidenceCount('safety-change', `safety:${identityKey}`), before + 1, 'the committed change has its evidence');
      assert.strictEqual(await sessionRow(ending.sid), 0);
      await client.query('DELETE FROM nv_test_session_end');
      await client.query('UPDATE nv_security_state SET state=$2 WHERE identity_key=$1', [identityKey, { readOnly: false, freezeSync: false, protected: {} }]);
    }
    {
      const bystander = await seedSession(client);
      const ending = await seedSession(client, { stepUp: true });
      await client.query('INSERT INTO nv_test_session_end(sid) VALUES($1)', [ending.sid]);
      const before = await evidenceCount('emergency-manifest');
      const freeze = await request('/api/repo/alice/demo/emergency-manifest', { method: 'POST', headers: ending.headers, body: JSON.stringify({ confirm: 'FREEZE' }) });
      assert.strictEqual(freeze.status, 201, `containment finishes once its controls are committed: ${JSON.stringify(freeze)}`);
      assert.strictEqual(freeze.body.persisted, true);
      assert.strictEqual(freeze.body.manifest.controls.sessionsRevoked >= 1, true);
      assert.strictEqual(await evidenceCount('emergency-manifest'), before + 1);
      assert.strictEqual(await sessionRow(bystander.sid), 0, 'the other sessions are still revoked');
      const state = (await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1', [identityKey])).rows[0].state;
      assert.deepStrictEqual([state.readOnly, state.freezeSync], [true, true]);
      await client.query('DELETE FROM nv_test_session_end');
      await client.query('UPDATE nv_security_state SET state=$2 WHERE identity_key=$1', [identityKey, { readOnly: false, freezeSync: false, protected: {} }]);
    }
    console.log('Corona committed changes keep their evidence when the session ends meanwhile');

    /* ---- Retired provider credentials do not outlive the GitHub session ------------ */
    {
      /* Only a retired account: signing in again replaces the session and removes the old row with its credential. */
      const stale = await seedSession(client, { accounts: [retired] });
      const login = await request('/api/login', { method: 'POST', headers: stale.headers, body: JSON.stringify({ provider: 'github', token: 'fixture-admin' }) });
      assert.strictEqual(login.status, 200, JSON.stringify(login));
      assert.strictEqual(await sessionRow(stale.sid), 0, 'the row holding the retired credential is gone');
    }
    {
      /* Removing the retired account keeps the GitHub one and says what to revoke at the old provider. */
      const mixed = await seedSession(client, { accounts: [retired, account], active: 1 });
      const removed = await request('/api/accounts/remove', { method: 'POST', headers: mixed.headers, body: JSON.stringify({ idx: 0 }) });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed));
      assert(Array.isArray(removed.body.revocationGuidance) && removed.body.revocationGuidance.length === 1);
      const listed = await request('/api/accounts', { headers: mixed.headers });
      assert.deepStrictEqual(listed.body.accounts.map(item => item.login), ['alice']);
    }
    {
      /* Removing the last GitHub account ends the session, retired accounts included. */
      const mixed = await seedSession(client, { accounts: [retired, account], active: 1 });
      const removed = await request('/api/accounts/remove', { method: 'POST', headers: mixed.headers, body: JSON.stringify({ idx: 1 }) });
      assert.strictEqual(removed.status, 200, JSON.stringify(removed));
      assert.strictEqual(removed.body.empty, true);
      assert(Array.isArray(removed.body.revocationGuidance) && removed.body.revocationGuidance.length === 1);
      assert.strictEqual(await sessionRow(mixed.sid), 0, 'no row keeps the retired credential');
    }
    console.log('Corona retired provider sessions leave no stored credential');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (client) await client.end();
    if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
