'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');

const root = path.resolve(__dirname, '..');

/*
 * Consumption of a step-up grant is asynchronous, because the guard behind it
 * may not live in this process. An un-awaited call assigns a Promise, and a
 * Promise is truthy -- the sensitive action would run, and the audit record
 * that reads req.stepUp.action would write undefined for every field. The
 * mistake leaves no trace at runtime, so it is pinned here at the source.
 */
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
for (const line of serverSource.split('\n')) {
  if (!line.includes('consumePendingStepUp(')) continue;
  if (line.trimStart().startsWith('*') || line.includes('require(')) continue;
  assert.match(
    line, /await consumePendingStepUp\(/,
    `every consumePendingStepUp call must be awaited: ${line.trim()}`
  );
}
assert.match(
  serverSource, /async function consumeStepUpAuthorization\(/,
  'consumeStepUpAuthorization must stay asynchronous so its callers keep awaiting it'
);

/*
 * Which guard answers is a question about configuration, not about whether the
 * database is reachable this second. A deployment that has a database has one
 * shared guard; when it cannot be reached the claim fails and the action is
 * refused. Falling back to the in-process Map there would be the worst of both,
 * because every instance would answer "unspent" for a grant another instance
 * had already spent -- a replay let through precisely during an outage.
 */
assert.match(
  serverSource, /function stepUpReplayStore\(\)\s*\{\s*\n\s*if \(!DB_URL\) return USED_STEP_UP_GRANTS;/,
  'the replay guard must be chosen by configuration, not by database availability'
);
assert.strictEqual(
  /catch[\s\S]{0,200}USED_STEP_UP_GRANTS/.test(serverSource), false,
  'no failure path may fall back to the in-process replay guard'
);

/*
 * The GitHub App OAuth state is the same guard under another kind, and carries
 * the same hazard: an un-awaited claim is a truthy Promise, so the callback
 * would go on to exchange the code with GitHub having verified nothing.
 */
assert.match(
  serverSource, /async function consumeGithubAppPending\(/,
  'consuming an OAuth state must be asynchronous: the guard may not be in this process'
);
for (const line of serverSource.split('\n')) {
  if (!line.includes('consumeGithubAppPending(')) continue;
  if (line.includes('async function')) continue;
  assert.match(
    line, /await consumeGithubAppPending\(/,
    `every consumeGithubAppPending call must be awaited: ${line.trim()}`
  );
}
assert.strictEqual(
  /catch[\s\S]{0,200}USED_GITHUB_APP_STATES/.test(serverSource), false,
  'no failure path may fall back to the in-process OAuth state guard'
);

/*
 * The recovery authorization was not a single-use guard at all. Its check and
 * its record sat either side of `await preflightRestoreActions`, a series of
 * reads against the provider, so two requests carrying one authorization both
 * passed the check while the first was still on the network and both went on
 * to restore the refs. One process was enough for that: an await is all it
 * takes to interleave a read and a write.
 *
 * The claim is now one operation, and where it sits is the fix. After the
 * preflight, so a stale preview still leaves the authorization unspent; before
 * the refs are written, so nothing is restored on an authorization that was
 * not claimed.
 */
assert.match(
  serverSource, /async function claimRestoreAuthorization\(/,
  'claiming a recovery authorization must be asynchronous'
);
for (const line of serverSource.split('\n')) {
  if (!line.includes('claimRestoreAuthorization(')) continue;
  if (line.includes('async function')) continue;
  assert.match(
    line, /await claimRestoreAuthorization\(/,
    `every claimRestoreAuthorization call must be awaited: ${line.trim()}`
  );
}

const restoreRoute = serverSource.slice(serverSource.indexOf("app.post('/api/repo/:owner/:repo/restore-refs'"));
const preflightAt = restoreRoute.indexOf('await preflightRestoreActions(');
const claimAt = restoreRoute.indexOf('await claimRestoreAuthorization(');
const writeAt = restoreRoute.indexOf("method: 'PATCH'");
assert(preflightAt > -1 && claimAt > -1 && writeAt > -1, 'the restore route must still preflight, claim and write');
assert(
  claimAt > preflightAt,
  'the claim must follow the preflight, so a stale preview leaves the authorization unspent'
);
assert(
  claimAt < writeAt,
  'the claim must precede the first ref write, so nothing is restored on an unclaimed authorization'
);

assert.strictEqual(
  /USED_RESTORE_AUTHORIZATIONS\.(set|has|delete)\(/.test(serverSource), false,
  'the recovery guard must be reached through the claim contract, never poked directly'
);
assert.strictEqual(
  /catch[\s\S]{0,200}USED_RESTORE_AUTHORIZATIONS/.test(serverSource), false,
  'no failure path may fall back to the in-process recovery guard'
);
for (const line of serverSource.split('\n')) {
  if (!line.includes('consumeStepUpAuthorization(')) continue;
  if (line.includes('async function')) continue;
  assert.match(
    line, /await consumeStepUpAuthorization\(/,
    `every consumeStepUpAuthorization call must be awaited: ${line.trim()}`
  );
}
const secret = 'security-server-test-secret-0123456789abcdef-0123456789abcdef';
const snapKey = ['security', 'server', 'snapshot', 'secret',
  'fedcba9876543210', 'fedcba9876543210'].join('-');
/* The server derives a purpose-specific session key; mirror that derivation
   rather than the raw digest it replaced. */
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const port = 28500 + Math.floor(Math.random() * 1000);

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function responseCookie(response, fallback) {
  const raw = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)nv_session=([^;]+)/.exec(raw);
  return match ? `nv_session=${match[1]}` : fallback;
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: secret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'security-test-snapshot-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapKey,
    DATABASE_URL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function request(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await request('/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

(async () => {
  try {
    await waitForServer();
    let cookie = `nv_session=${seal({
      accounts: [
        { token: 'test-token-a', login: 'alice', avatar: '', provider: 'github', baseUrl: '', authMethod: 'token' },
        { token: 'test-token-b', login: 'bob', avatar: '', provider: 'github', baseUrl: '', authMethod: 'token' }
      ],
      active: 0
    })}`;

    const csrfResponse = await request('/api/security/csrf', { headers: { cookie } });
    assert.strictEqual(csrfResponse.status, 200);
    const aliceCsrf = await csrfResponse.json();
    assert(aliceCsrf.token && aliceCsrf.expiresAt, 'CSRF endpoint must issue a bounded token');
    cookie = responseCookie(csrfResponse, cookie);

    const missing = await request('/api/accounts/switch-idx', {
      method: 'POST',
      headers: { cookie, 'x-nv': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ idx: 1 })
    });
    assert.strictEqual(missing.status, 403);
    assert.strictEqual((await missing.json()).code, 'CSRF_REQUIRED');

    const switched = await request('/api/accounts/switch-idx', {
      method: 'POST',
      headers: { cookie, 'x-nv': '1', 'x-nv-csrf': aliceCsrf.token, 'content-type': 'application/json' },
      body: JSON.stringify({ idx: 1 })
    });
    assert.strictEqual(switched.status, 200);
    assert.strictEqual((await switched.json()).login, 'bob');
    cookie = responseCookie(switched, cookie);

    const staleIdentityToken = await request('/api/accounts/switch-idx', {
      method: 'POST',
      headers: { cookie, 'x-nv': '1', 'x-nv-csrf': aliceCsrf.token, 'content-type': 'application/json' },
      body: JSON.stringify({ idx: 0 })
    });
    assert.strictEqual(staleIdentityToken.status, 403);
    assert.strictEqual((await staleIdentityToken.json()).code, 'CSRF_INVALID');

    const bobCsrfResponse = await request('/api/security/csrf', { headers: { cookie } });
    assert.strictEqual(bobCsrfResponse.status, 200);
    const bobCsrf = await bobCsrfResponse.json();
    const switchedBack = await request('/api/accounts/switch-idx', {
      method: 'POST',
      headers: { cookie, 'x-nv': '1', 'x-nv-csrf': bobCsrf.token, 'content-type': 'application/json' },
      body: JSON.stringify({ idx: 0 })
    });
    assert.strictEqual(switchedBack.status, 200);
    assert.strictEqual((await switchedBack.json()).login, 'alice');

    console.log('security foundation server integration tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref();
    });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
