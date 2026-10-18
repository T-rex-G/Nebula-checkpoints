'use strict';

/*
 * A session that was disconnected stays disconnected, and says so.
 *
 * Against the real server and a real PostgreSQL store, with invitations on: a
 * tester signs in with a GitHub token and disconnects every provider. The
 * browser's cookie is cleared, but a copy of it -- another tab, a saved
 * request, a stolen header -- can still be sent. The hosted disconnect drill
 * sent one and the server answered 500. It must answer 401 AUTH_REQUIRED, the
 * same as any request with no session behind it: the session is gone, and
 * nothing about it is a server fault.
 *
 * The access session is separate and survives: a tester who disconnected
 * GitHub is still an invited tester and can sign in again.
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
const database = `nv_alpha_disconnect_${crypto.randomBytes(6).toString('hex')}`;
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

/* The cookies a browser would hold, updated from each answer. */
function jar() {
  const values = new Map();
  return {
    header: () => [...values].map(([name, value]) => `${name}=${value}`).join('; '),
    snapshot: () => new Map(values),
    take(response) {
      for (const line of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
        const [pair, ...attributes] = line.split(';');
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        const expired = !value || attributes.some(attribute => /max-age=0/i.test(attribute) || /expires=thu, 01 jan 1970/i.test(attribute));
        if (expired) values.delete(name); else values.set(name, value);
      }
    }
  };
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
    const store = new AlphaAccessStore({ pool: { query: (...args) => client.query(...args), connect: async () => ({ query: (...args) => client.query(...args), release() {} }) }, pepper });
    const port = await freePort();
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/provider-identity-fetch.js'), 'server.js'], {
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
    const cookies = jar();
    const send = async (method, route, { body, headers = {}, cookie } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          'x-nv': '1', 'content-type': 'application/json',
          cookie: cookie === undefined ? cookies.header() : cookie, ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (cookie === undefined) cookies.take(response);
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: response.status, data, text };
    };
    const deadline = Date.now() + 15000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { if ((await fetch(`${origin}/healthz`, { headers: { 'x-nv': '1' } })).ok) break; } catch {}
      if (Date.now() >= deadline) throw new Error(`HTTP startup timed out\n${logs}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    const invite = await store.issueInvite({ testerLabel: 'disconnect tester', termsVersion, repositoryScopes: [repository] });
    const redeemed = await send('POST', '/api/alpha/redeem', { body: { code: invite.code, acceptedTermsVersion: termsVersion } });
    assert.strictEqual(redeemed.status, 200, redeemed.text);
    const login = await send('POST', '/api/login', { body: { provider: 'github', token: ['ghp', 'disconnectfixture0000000000000000000000'].join('_') } });
    assert.strictEqual(login.status, 200, login.text);
    const before = await send('GET', '/api/me');
    assert.deepStrictEqual([before.status, before.data && before.data.login], [200, 'disconnect-tester'], before.text);

    /* A copy of the cookies as they were while signed in. */
    const heldCookies = cookies.snapshot();
    const held = [...heldCookies].map(([name, value]) => `${name}=${value}`).join('; ');
    assert(heldCookies.has('nv_session'), 'the signed-in browser holds a provider session cookie');

    const csrf = await send('GET', '/api/security/csrf');
    assert.strictEqual(csrf.status, 200, csrf.text);
    const disconnected = await send('POST', '/api/alpha/providers/disconnect-all', { body: {}, headers: { 'x-nv-csrf': csrf.data.token } });
    assert.strictEqual(disconnected.status, 200, disconnected.text);

    /* The browser that disconnected is signed out. */
    const after = await send('GET', '/api/me');
    assert.deepStrictEqual([after.status, after.data && after.data.code], [401, 'AUTH_REQUIRED'], `the disconnected browser: ${after.status} ${after.text}`);

    /* The copy is refused as signed out -- not a server fault. */
    const replay = await send('GET', '/api/me', { cookie: held });
    assert.deepStrictEqual([replay.status, replay.data && replay.data.code], [401, 'AUTH_REQUIRED'],
      `a disconnected session replayed from a held cookie answered ${replay.status}: ${replay.text}`);

    /* And so for a provider route behind the same session. */
    const repos = await send('GET', '/api/repos', { cookie: held });
    assert.strictEqual(repos.status, 401, `a provider route replayed from a held cookie answered ${repos.status}: ${repos.text}`);

    /*
     * Another invited tester presenting that copy is refused as not theirs:
     * a 403 that names the conflict, not a 500.
     */
    const other = await store.issueInvite({ testerLabel: 'other tester', termsVersion, repositoryScopes: [repository] });
    const otherCookies = jar();
    const otherRedeem = await fetch(`${origin}/api/alpha/redeem`, {
      method: 'POST', headers: { 'x-nv': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code: other.code, acceptedTermsVersion: termsVersion }), signal: AbortSignal.timeout(15000)
    });
    assert.strictEqual(otherRedeem.status, 200);
    otherCookies.take(otherRedeem);
    const foreign = new Map([...otherCookies.snapshot(), ['nv_session', heldCookies.get('nv_session')]]);
    const crossed = await send('GET', '/api/me', { cookie: [...foreign].map(([name, value]) => `${name}=${value}`).join('; ') });
    assert.deepStrictEqual([crossed.status, crossed.data && crossed.data.code], [403, 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT'],
      `another tester replaying a held provider session answered ${crossed.status}: ${crossed.text}`);

    /*
     * The disconnected account keeps its cleanup evidence under this access,
     * so it is not bound to it again: the sign-in is refused, plainly, with
     * nothing connected and the way forward named -- not a 500 asking for a
     * retry that can never succeed.
     */
    const firstToken = ['ghp', 'disconnectfixture0000000000000000000000'].join('_');
    const again = await send('POST', '/api/login', { body: { provider: 'github', token: firstToken } });
    assert.deepStrictEqual([again.status, again.data && again.data.code, again.data && again.data.providerChanged],
      [409, 'ALPHA_PROVIDER_IDENTITY_RETIRED', 'no'], `signing in again after a disconnect answered ${again.status}: ${again.text}`);
    assert.match(again.data.nextAction, /new invitation/);
    assert.strictEqual((await send('GET', '/api/me')).status, 401, 'a refused sign-in leaves the browser signed out');

    /*
     * Still an invited tester: another GitHub account connects -- also from
     * the held copy, whose ended session is replaced by a new one rather than
     * refused as a conflict.
     */
    const secondToken = ['ghp', 'disconnectfixture00000000000000000second'].join('_');
    const fromHeld = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { 'x-nv': '1', 'content-type': 'application/json', cookie: held },
      body: JSON.stringify({ provider: 'github', token: secondToken }), signal: AbortSignal.timeout(15000)
    });
    const fromHeldText = await fromHeld.text();
    assert.strictEqual(fromHeld.status, 200, `signing in from a held cookie answered ${fromHeld.status}: ${fromHeldText}`);
    const renewed = jar();
    for (const [name, value] of heldCookies) renewed.take({ headers: { getSetCookie: () => [`${name}=${value}`] } });
    renewed.take(fromHeld);
    assert.notStrictEqual(renewed.snapshot().get('nv_session'), heldCookies.get('nv_session'), 'the ended session is replaced, not revived');
    const me = await send('GET', '/api/me', { cookie: renewed.header() });
    assert.deepStrictEqual([me.status, me.data && me.data.login], [200, 'second-tester'], me.text);
    const stillEnded = await send('GET', '/api/me', { cookie: held });
    assert.strictEqual(stillEnded.status, 401, 'the held copy stays signed out after the new sign-in');

    console.log('alpha disconnect replay server regressions passed');
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
