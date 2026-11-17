'use strict';
const { serverEntry } = require('./helpers/server-entry');
const { freePort } = require('./helpers/free-port');
const { withLifetime } = require('./fixtures/local-session');

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { KEY_PURPOSES, deriveKey } = require('../apps/api/src/platform/crypto/key-derivation.ts');

const root = path.resolve(__dirname, '..');

/*
 * The single-use guards -- a step-up grant, the GitHub App's OAuth state and a
 * restore's authorization -- each answer through a promise, because the guard
 * behind them may not be in this process. An unawaited answer is a truthy
 * Promise: the request would go on as if the guard had said yes. Each is held
 * by what it does:
 *   - every promise in the server and the contracts is awaited, handled or let
 *     go explicitly (eslint.config.js, nebulaverse/promises, by the type
 *     checker);
 *   - a grant the guard says is spent is refused, and a guard that cannot
 *     answer refuses rather than falling back to this instance's memory; which
 *     guard answers is the configuration's, not the database's mood
 *     (test/session-security.test.js);
 *   - one instance's spent grant, state or authorization is spent on every
 *     instance (test/multi-instance-contract.test.js, and the composed server
 *     in test/composition-postgres.test.js), and an App state is spent once
 *     (test/composition.test.js, test/github-app-configured-server.test.js);
 *   - a restore's authorization is claimed after its preflight, so a stale
 *     preview leaves it unspent, and before the first reference is written, so
 *     a replay writes nothing; the shared store says whether it is spent, and
 *     one that cannot answer refuses; and no existing branch is force-updated
 *     (test/corona-recovery.test.js).
 */
const secret = 'security-server-test-secret-0123456789abcdef-0123456789abcdef';
const snapKey = ['security', 'server', 'snapshot', 'secret',
  'fedcba9876543210', 'fedcba9876543210'].join('-');
/* The server derives a purpose-specific session key; mirror that derivation
   rather than the raw digest it replaced. */
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const port = freePort();

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime(value)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function responseCookie(response, fallback) {
  const raw = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)nv_session=([^;]+)/.exec(raw);
  return match ? `nv_session=${match[1]}` : fallback;
}

const child = spawn(process.execPath, [serverEntry()], {
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
