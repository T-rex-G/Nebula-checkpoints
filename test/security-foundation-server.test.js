'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const secret = 'security-server-test-secret-0123456789abcdef-0123456789abcdef';
const snapKey = `${secret}:snapshot`;
const key = crypto.createHash('sha256').update(secret).digest();
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
