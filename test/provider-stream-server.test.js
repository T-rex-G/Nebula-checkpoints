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
        const accounts = await fetch(origin + '/api/accounts', { headers: { cookie: sessionCookie([retired, github], active) } });
        assert.equal(accounts.status, 200);
        const body = await accounts.json();
        assert.equal(body.active, 0);
        assert.deepEqual(body.accounts.map(account => account.provider), ['github']);
        assert.equal(body.accounts[0].login, 'fixture-github');
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
    for (const provider of ['github']) {
      const login = await fetch(`${origin}/api/login`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider, token: 'stream-fixture-only' }) });
      assert.equal(login.status, 200, await login.text());
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const request = route => fetch(`${origin}/api/repo/Acme/Demo/${route}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
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
