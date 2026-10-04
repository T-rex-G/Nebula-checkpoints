'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const port = 23000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['-r', './test/fixtures/provider-stream-fetch.js', 'server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '',
    NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local',
    SESSION_SECRET: crypto.randomBytes(40).toString('hex'), NV_GIT_HOST_ALLOWLIST: 'gitea.example,gitlab.example' },
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
    for (const provider of ['gitea', 'gitlab']) {
      const login = await fetch(`${origin}/api/login`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nv': '1' },
        body: JSON.stringify({ provider, baseUrl: `https://${provider}.example`, token: 'stream-fixture-only' }) });
      assert.equal(login.status, 200, await login.text());
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const request = route => fetch(`${origin}/api/repo/Acme/Demo/${route}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
      const good = await request('raw?ref=main&path=ok.bin');
      assert.equal(good.status, 200);
      assert.equal((await good.arrayBuffer()).byteLength, 1024);
      const routes = ['raw?ref=main&path=broken.bin'];
      if (provider === 'gitea') routes.unshift('zip?ref=main');
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
    console.log('real HTTP provider stream failures and client cancellation are contained');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }
}
main().catch(error => { console.error(error.message); console.error(logs.slice(-3000)); process.exitCode = 1; });
