'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { deriveKey, KEY_PURPOSES } = require('../src/key-derivation');
const root = path.join(__dirname, '..');
const secret = 'local-session-regression-0123456789abcdef-0123456789';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const port = 28000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
let child, logs = '';

function decode(cookie) {
  const raw = Buffer.from(cookie.split('=')[1], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
}
function encode(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return `nv_session=${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}
function cookieFrom(response, fallback = '') {
  const match = /nv_session=([^;]*)/.exec(response.headers.get('set-cookie') || '');
  return match ? `nv_session=${match[1]}` : fallback;
}
async function start() {
  child = spawn(process.execPath, ['-r', './test/fixtures/session-provider-fetch.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: secret,
      DATABASE_URL: '', NV_ALPHA_ACCESS_MODE: 'off', NV_DEPLOYMENT_PROFILE: 'local' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', value => { logs += value; });
  child.stderr.on('data', value => { logs += value; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Session regression server exited early');
    if (await fetch(`${base}/healthz`).then(r => r.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Session regression server did not start');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
async function login() {
  const response = await fetch(`${base}/api/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nv': '1' },
    body: JSON.stringify({ provider: 'github', token: 'synthetic-session-fixture' }) });
  assert.strictEqual(response.status, 200, await response.text());
  return cookieFrom(response);
}
async function accountStatus(cookie) {
  const response = await fetch(`${base}/api/accounts`, { headers: { cookie } });
  await response.body.cancel();
  return response.status;
}
async function main() {
  try {
    await start();
    let cookie = await login();
    assert.strictEqual(await accountStatus(cookie), 200);
    const csrf = await fetch(`${base}/api/security/csrf`, { headers: { cookie } });
    cookie = cookieFrom(csrf, cookie);
    const token = (await csrf.json()).token;
    const logout = await fetch(`${base}/api/logout`, { method: 'POST',
      headers: { cookie, 'x-nv': '1', 'x-nv-csrf': token, 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(logout.status, 200, await logout.text());
    assert.strictEqual(await accountStatus(cookie), 401, 'a copied cookie must stop working after a successful logout');

    cookie = await login();
    const data = decode(cookie);
    assert(data.lifetime && data.lifetime.expiresAt > data.lifetime.issuedAt, 'server must issue a bounded absolute lifetime');
    const csrfAgain = await fetch(`${base}/api/security/csrf`, { headers: { cookie } });
    await csrfAgain.body.cancel();
    assert.deepStrictEqual(decode(cookieFrom(csrfAgain, cookie)).lifetime, data.lifetime, 'session writes must not extend absolute expiry');
    const expired = { ...data, lifetime: { ...data.lifetime, expiresAt: Date.now() - 1 } };
    assert.strictEqual(await accountStatus(encode(expired)), 401, 'the server must reject an expired cookie even if its browser expiry is bypassed');
    const legacy = { ...data }; delete legacy.lifetime;
    assert.strictEqual(await accountStatus(encode(legacy)), 401, 'unbounded legacy cookies must require sign-in');
    await stop();
    await start();
    assert.strictEqual(await accountStatus(cookie), 401, 'local sessions must not revive after a process restart loses revocation memory');
    assert.strictEqual(await accountStatus(await login()), 200, 'fresh sign-in must work after restart');
    console.log('local session lifetime, logout replay and restart regression passed');
  } finally { await stop(); }
}
main().catch(error => { console.error(error.stack, logs); process.exitCode = 1; });
