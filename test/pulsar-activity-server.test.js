'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { withLifetime } = require('./fixtures/local-session');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-pulsar-activity-'));
const log = path.join(temp, 'requests.jsonl');
const secret = crypto.randomBytes(40).toString('hex');
function sessionCookie() {
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT), iv);
const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime({ accounts: [{ provider: 'github', login: 'operator', token: 'pulsar-fixture-only' }], active: 0 }))), cipher.final()]);
return 'nv_session=' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
let cookie;
const port = 25000 + Math.floor(Math.random() * 2000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['-r', './test/fixtures/pulsar-activity-fetch.js', 'server.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: secret,
    DATABASE_URL: '', NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local', NV_PULSAR_REQUEST_LOG: log },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const reads = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function request(repo, query = '') {
  const response = await fetch(`${origin}/api/repo/acme/${repo}/activity?days=30${query}`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function main() {
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Activity fixture exited ${child.exitCode}: ${logs}`);
      try { const response = await fetch(origin + '/healthz'); await response.body.cancel(); ready = response.ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready, `Activity server did not start: ${logs}`);
    cookie = sessionCookie();
    const selected = await request('demo', '&ref=feature%2Fnested');
    assert.equal(selected.ref, 'feature/nested', 'response scope must identify the selected branch');
    assert.equal(selected.commits[0].sha, 'b'.repeat(40), 'provider must read selected branch, not default');
    assert.deepEqual(selected.commits[0].parentShas, ['c'.repeat(40)], 'provider ancestry must survive the boundary');
    assert.equal(selected.sources.commits.available, true);
    assert.equal(selected.sources.commits.truncated, false);
    assert.equal(selected.partial, false);
    const partial = await request('partial', '&ref=main');
    assert.equal(partial.partial, true);
    assert.equal(partial.sources.issues.available, false);
    assert.equal(partial.sources.commits.available, true);
    assert.equal(partial.commits.length, 1);
    const unavailable = await request('unavailable');
    assert.equal(unavailable.partial, true);
    for (const source of ['commits', 'pulls', 'issues', 'releases']) assert.equal(unavailable.sources[source].available, false);
    const bounded = await request('bounded');
    assert.equal(bounded.sources.commits.truncated, true, 'first-page cap must remain visible');
    assert.equal(bounded.partial, true);
    const before = reads().length;
    const invalid = await fetch(`${origin}/api/repo/acme/demo/activity?ref=../other`, { headers: { cookie } });
    assert.equal(invalid.status, 400);
    await invalid.body.cancel();
    assert.equal(reads().length, before, 'invalid ref must not dispatch provider reads');
    assert(reads().some(entry => entry.path === '/repos/acme/demo/commits' && new URLSearchParams(entry.query).get('sha') === 'feature/nested'));
    console.log('pulsar activity server tests passed');
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
