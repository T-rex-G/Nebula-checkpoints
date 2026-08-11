'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { createGithubAppState } = require('../src/github-app');
const { hashJson } = require('../src/intelligence');

const root = path.resolve(__dirname, '..');
const port = 30100 + Math.floor(Math.random() * 500);
const sessionSecret = 'github-app-configured-test-secret-0123456789abcdef-0123456789abcdef';
const snapKey = `${sessionSecret}:snapshot`;
const sessionKey = crypto.createHash('sha256').update(sessionSecret).digest();

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function responseCookie(response, fallback) {
  const raw = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)nv_session=([^;]+)/.exec(raw);
  return match ? `nv_session=${match[1]}` : fallback;
}
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyBase64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const clientSecret = 'configured-server-client-secret';
const webhookSecret = 'configured-server-webhook-secret';
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: sessionSecret,
    NV_SNAPSHOT_SIGNING_KEY_ID: 'github-app-configured-snapshot-key',
    NV_SNAPSHOT_SIGNING_SECRET: snapKey,
    DATABASE_URL: '',
    GITHUB_APP_ID: '4242',
    GITHUB_APP_SLUG: 'nebula-configured-test',
    GITHUB_APP_CLIENT_ID: 'Iv1.configuredtest',
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_PRIVATE_KEY: '',
    GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
    GITHUB_APP_CALLBACK_URL: `https://nebula.example/api/github-app/oauth/callback`,
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${logs}`);
}

(async () => {
  try {
    await waitForServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.strictEqual(response.status, 200);
    const config = await response.json();
    assert.deepStrictEqual(config.githubApp, { enabled: true, webhookConfigured: true });
    const publicPayload = JSON.stringify(config);
    for (const secret of [clientSecret, webhookSecret, privateKeyBase64, 'Iv1.configuredtest']) {
      assert(!publicPayload.includes(secret), `public config leaked ${secret.slice(0, 12)}`);
      assert(!logs.includes(secret), `server logs leaked ${secret.slice(0, 12)}`);
    }
    const callback = await fetch(`http://127.0.0.1:${port}/api/github-app/oauth/callback?code=x&state=y`, { redirect: 'manual' });
    assert.strictEqual(callback.status, 302);
    assert.match(callback.headers.get('location') || '', /^\/?\?githubApp=error&code=AUTH_REQUIRED$/);

    const replayAccount = { provider: 'github', authMethod: 'token', login: 'alice', avatar: '', baseUrl: '', token: 'not-used' };
    const replayIdentity = hashJson({ provider: 'github', baseUrl: '', login: 'alice' });
    const replayNonce = 'setup-replay-nonce';
    const replaySessionNonce = 'a'.repeat(48);
    const replayState = createGithubAppState(sessionSecret, {
      purpose: 'installation-claim', sessionBinding: replaySessionNonce, identityKey: replayIdentity
    }, { nonce: replayNonce, ttlMs: 600000 });
    const replayCookie = `nv_session=${seal({
      accounts: [replayAccount], active: 0,
      security: { sessionNonce: replaySessionNonce, githubApp: { installation: {
        nonce: replayNonce, expiresAt: Date.now() + 600000, identityKey: replayIdentity,
        userToken: 'temporary-user-token', userId: 1, login: 'alice'
      } } }
    })}`;
    const replayUrl = `http://127.0.0.1:${port}/api/github-app/setup?installation_id=0&state=${encodeURIComponent(replayState)}`;
    const firstSetup = await fetch(replayUrl, { headers: { cookie: replayCookie }, redirect: 'manual' });
    assert.match(firstSetup.headers.get('location') || '', /code=GITHUB_APP_INSTALLATION_INVALID/);
    const replayedSetup = await fetch(replayUrl, { headers: { cookie: replayCookie }, redirect: 'manual' });
    assert.match(replayedSetup.headers.get('location') || '', /code=GITHUB_APP_STATE_REPLAY/);

    let cookie = `nv_session=${seal({
      accounts: [{
        provider: 'github', authMethod: 'github-app', login: 'nebula-org', avatar: '', installationId: 77,
        installationAccountId: 501, installationAccountType: 'Organization', repositorySelection: 'selected',
        permissions: { contents: 'write' }, authorizedByLogin: 'authorizer', authorizedById: 9001,
        authorizedByIdentityKey: 'identity-key-for-authorizer', installationStatus: 'connected',
        lastVerifiedAt: '2026-07-21T22:00:00.000Z'
      }],
      active: 0
    })}`;
    const meResponse = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { cookie } });
    assert.strictEqual(meResponse.status, 200, 'tokenless app identity metadata must remain manageable without a provider call');
    const me = await meResponse.json();
    assert.strictEqual(me.authMethod, 'github-app');
    assert.strictEqual(me.login, 'nebula-org');
    assert.strictEqual(me.caps.notif, false);
    cookie = responseCookie(meResponse, cookie);

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/github-app/status`, { headers: { cookie } });
    assert.strictEqual(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.strictEqual(status.connections.length, 1);
    assert.strictEqual(status.connections[0].installationId, 77);

    const csrfResponse = await fetch(`http://127.0.0.1:${port}/api/security/csrf`, { headers: { cookie } });
    assert.strictEqual(csrfResponse.status, 200);
    const csrf = await csrfResponse.json();
    cookie = responseCookie(csrfResponse, cookie);
    const disconnect = await fetch(`http://127.0.0.1:${port}/api/github-app/disconnect`, {
      method: 'POST',
      headers: { cookie, 'x-nv': '1', 'x-nv-csrf': csrf.token, 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: 77 })
    });
    assert.strictEqual(disconnect.status, 200);
    assert.strictEqual((await disconnect.json()).empty, true);
    console.log('github app configured server tests passed');
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
