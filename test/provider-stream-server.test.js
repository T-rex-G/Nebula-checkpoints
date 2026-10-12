'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { withLifetime } = require('./fixtures/local-session');
const secret = crypto.randomBytes(40).toString('hex');
function sessionCookie(accounts, active = 0) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT), iv);
  const data = Buffer.from(JSON.stringify(withLifetime({ accounts, active })));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return 'nv_session=' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
const port = 23000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['-r', './test/fixtures/provider-stream-fetch.js', 'server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '',
    NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local',
    SESSION_SECRET: secret },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
async function healthy() {
  if (child.exitCode !== null) return false;
  try { const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) }); await response.body.cancel(); return response.status === 200; }
  catch { return false; }
}
async function main() {
  try {
    const until = Date.now() + 10000;
    while (!await healthy()) {
      assert(child.exitCode === null && Date.now() < until, 'stream fixture server must start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const provider of ['gitlab', 'gitea', 'unknown-provider', '', null, ['github']]) {
      const before = (logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length;
      const login = await fetch(`${origin}/api/login`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider, token: 'retired-provider-secret' }) });
      assert.equal(login.status, 400, `${provider} login must be rejected`);
      assert.equal((await login.json()).code, 'PROVIDER_UNSUPPORTED');
      const query = Array.isArray(provider) ? 'provider=github&provider=github' : `provider=${encodeURIComponent(String(provider))}`;
      const capabilities = await fetch(`${origin}/api/capabilities?${query}`);
      assert.equal(capabilities.status, 400, `${provider} capabilities must be rejected`);
      assert.equal((await capabilities.json()).code, 'PROVIDER_UNSUPPORTED');
      assert.equal((logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length, before,
        'unsupported provider input must never dispatch an upstream request');
    }
    const beforeLegacy = (logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length;
    for (const provider of ['gitlab', 'gitea']) {
      const retired = { provider, login: 'retired', token: 'retired-provider-secret', baseUrl: `https://${provider}.example` };
      const cookie = sessionCookie([retired]);
      for (const route of ['/api/me', '/api/accounts', '/api/repos', '/api/account/capabilities', '/api/repo/Acme/Demo/raw?path=ok.bin&ref=main']) {
        const response = await fetch(origin + route, { headers: { cookie } });
        assert.equal(response.status, 401, `${provider} saved session ${route} must be unauthenticated`);
        await response.body.cancel();
      }
      const csrf = await fetch(origin + '/api/security/csrf', { headers: { cookie } });
      assert.equal(csrf.status, 200, 'retired account may obtain only local cleanup authorization');
      const csrfBody = await csrf.json();
      const cleanupCookie = csrf.headers.get('set-cookie')?.split(';')[0] || cookie;
      const logout = await fetch(origin + '/api/logout', { method: 'POST',
        headers: { cookie: cleanupCookie, 'x-nv': '1', 'x-nv-csrf': csrfBody.token } });
      assert.equal(logout.status, 200, await logout.text());
      const replay = await fetch(origin + '/api/security/csrf', { headers: { cookie: cleanupCookie } });
      assert.equal(replay.status, 401, 'retired account logout must revoke the saved cookie');
      await replay.body.cancel();
      const github = { provider: 'github', login: 'fixture-github', token: 'stream-fixture-only' };
      for (const active of [0, 1]) {
        /* Beside a GitHub account a retired one is listed, marked, so it can be removed; the selection is never moved for the person. */
        const accounts = await fetch(origin + '/api/accounts', { headers: { cookie: sessionCookie([retired, github], active) } });
        assert.equal(accounts.status, 200);
        const body = await accounts.json();
        assert.equal(body.active, active);
        assert.deepEqual(body.accounts.map(account => [account.provider, account.retired]), [[provider, true], ['github', false]]);
        assert.equal(body.accounts[1].login, 'fixture-github');
        if (active === 0) {
          const me = await fetch(origin + '/api/me', { headers: { cookie: sessionCookie([retired, github], active) } });
          assert.equal(me.status, 409, 'a retired selection asks for a choice and acts as no one');
          assert.equal((await me.json()).code, 'ACCOUNT_SELECTION_REQUIRED');
        }
      }
    }
    for (const baseUrl of ['https://gitlab.com', 'https://gitea.example', 'http://127.0.0.1', 'https://github.com']) {
      const login = await fetch(origin + '/api/login', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider: 'github', token: 'stream-fixture-only', baseUrl }) });
      assert.equal(login.status, 400, 'custom authority must not silently route a credential to GitHub');
      assert.equal((await login.json()).code, 'PROVIDER_AUTHORITY_UNSUPPORTED');
    }
    assert.equal((logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length, beforeLegacy,
      'retired saved sessions and cleanup must never dispatch provider transport');
    /*
     * Signing in with GitHub is a choice: the new account is selected, and the
     * choice holds on the next read. The flag that asked for it belongs to the
     * read that computed it, never to the saved session.
     */
    for (const provider of ['gitlab', 'gitea']) {
      const retired = { provider, login: 'retired', token: 'retired-provider-secret', baseUrl: `https://${provider}.example` };
      const github = { provider: 'github', login: 'fixture-github', token: 'stream-fixture-only' };
      const relogin = await fetch(`${origin}/api/login`, { method: 'POST',
        headers: { cookie: sessionCookie([retired, github], 0), 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider: 'github', token: 'stream-fixture-only' }) });
      assert.equal(relogin.status, 200, await relogin.clone().text());
      const chosen = relogin.headers.get('set-cookie').split(';')[0];
      const after = await fetch(origin + '/api/me', { headers: { cookie: chosen } });
      assert.equal(after.status, 200, `${provider}: a GitHub sign-in left the session asking for a choice it had just made`);
      await after.body.cancel();
    }
    for (const provider of ['github']) {
      const login = await fetch(`${origin}/api/login`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider, token: 'stream-fixture-only' }) });
      assert.equal(login.status, 200, await login.text());
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const request = route => fetch(`${origin}/api/repo/Acme/Demo/${route}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
      /* Only what is Supported is served: each capability awaiting qualification is refused with its typed error, before any provider request. */
      const beforeRefusals = (logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length;
      for (const [method, route, feature] of [
        ['POST', '/api/repos', 'repository.create'],
        ['DELETE', '/api/repo/Acme/Demo', 'repository.delete'],
        ['GET', '/api/notifications', 'notifications'],
        ['GET', '/api/repo/Acme/Demo/live-events/stream', 'live-events']
      ]) {
        const refused = await fetch(origin + route, { method, headers: { cookie, 'content-type': 'application/json', 'x-nv': '1' },
          ...(method === 'POST' ? { body: JSON.stringify({ name: 'never-created' }) } : {}), signal: AbortSignal.timeout(3000) });
        assert.equal(refused.status, 409, `${method} ${route}`);
        const body = await refused.json();
        assert.deepStrictEqual([body.code, body.feature], ['PROVIDER_CAPABILITY_EXPERIMENTAL', feature], `${method} ${route}`);
      }
      assert.equal((logs.match(/STREAM_FIXTURE_REQUEST/g) || []).length, beforeRefusals, 'a refused capability never reaches the provider');
      const good = await request('raw?ref=main&path=ok.bin');
      assert.equal(good.status, 200);
      assert.equal((await good.arrayBuffer()).byteLength, 1024);
      const routes = ['raw?ref=main&path=broken.bin'];
      routes.unshift('zip?ref=main');
      for (const route of routes) {
        await assert.rejects(async () => { const response = await request(route); await response.arrayBuffer(); },
          undefined, 'a partial download must fail visibly');
        assert.equal(await healthy(), true, `${provider} ${route}: a post-header upstream failure must not kill the server`);
      }
      const before = (logs.match(/STREAM_FIXTURE_CANCELLED/g) || []).length;
      const cancelled = await request('raw?ref=main&path=cancel.bin');
      const reader = cancelled.body.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel();
      const deadline = Date.now() + 3000;
      while ((logs.match(/STREAM_FIXTURE_CANCELLED/g) || []).length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert((logs.match(/STREAM_FIXTURE_CANCELLED/g) || []).length > before, 'client cancellation must cancel the provider reader');
      assert.equal(await healthy(), true);
    }
    assert(!logs.includes("Unhandled 'error' event"));
    assert(!logs.includes('ERR_HTTP_HEADERS_SENT'));
    console.log('GitHub-only HTTP auth/session rejection, local cleanup, streaming failures and cancellation passed');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }
}
main().catch(error => { console.error(error.message); console.error(logs.slice(-3000)); process.exitCode = 1; });
