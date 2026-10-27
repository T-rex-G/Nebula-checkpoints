'use strict';
const { serverEntry } = require('./helpers/server-entry');
const { freePort } = require('./helpers/free-port');
const { withLifetime } = require('./fixtures/local-session');

/*
 * The API rate limiter keyed its buckets on the raw session cookie:
 *
 *   const key = (getCookie(req, 'nv_session') || req.ip || '').slice(0, 40);
 *
 * These are the two properties that line did not hold. A caller must not be
 * able to mint bucket identities by varying a cookie it controls, and a
 * session whose cookie is re-sealed must keep the counter it had.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { KEY_PURPOSES, deriveKey } = require('../apps/api/src/platform/crypto/key-derivation.ts');

const root = path.resolve(__dirname, '..');
const port = freePort();
const secret = 'rate-limit-server-test-secret-0123456789abcdef-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const LIMIT = 300;

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime(value)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function session(sessionNonce, login = 'rate-fixture-user') {
  return {
    accounts: [{ provider: 'github', authMethod: 'token', login, token: 'fixture-token' }],
    active: 0,
    security: { sessionNonce, stepUp: null }
  };
}

const child = spawn(process.execPath, [serverEntry()], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: secret,
    DATABASE_URL: '',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

/* CSRF issuance exercises authenticated rate limits without an upstream request. */
async function call(cookie) {
  const headers = cookie ? { cookie } : {};
  const response = await fetch(`http://127.0.0.1:${port}/api/security/csrf`, { headers });
  if (response.body) await response.body.cancel();
  return response.status;
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.body) await response.body.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

/* Spends one bucket to its ceiling and reports where the 429 first appeared. */
async function exhaust(cookieFor) {
  for (let sent = 1; sent <= LIMIT + 1; sent += 1) {
    const status = await cookieFor(sent);
    if (status === 429) return sent;
  }
  return null;
}

/*
 * The shared counter is what makes a limit mean the same on every instance,
 * but consulting it is a query -- and a limiter that queries once per request
 * lets an attacker turn a flood of cheap HTTP into a flood of database work
 * against a pool of three connections.
 *
 * The local bucket in front of it is what prevents that, and only if it is
 * consulted first. Once the shared counter has refused a caller, this process
 * must answer from memory until their window closes, so the caller sending the
 * most requests is the one costing no queries at all. That ordering is the
 * design. No behavioural test against a server without a database can see it,
 * so the limiter is driven here with a counter that records every question.
 */
async function admissionProperties() {
  const {
    apiRateAdmission, API_RATE_LIMIT, API_RATE_WINDOW_MS, LOCAL_ADMISSION_CEILING
  } = require('../apps/api/src/http/pipeline/index.ts');
  assert.strictEqual(API_RATE_LIMIT, LIMIT);
  let now = 1_000_000;
  let answer = () => Promise.resolve({ allowed: true });
  const asked = [];
  const counter = { count(request) { asked.push(request); return answer(request); } };
  let shared = counter;
  const step = apiRateAdmission({ identify: req => req.caller, counter: () => shared, now: () => now });
  /* One request: how it was answered, or that it was passed on. */
  const admit = caller => new Promise(resolve => {
    const res = {
      code: 200,
      status(code) { this.code = code; return this; },
      json(body) { resolve({ status: this.code, body }); return this; }
    };
    step({ caller }, res, () => resolve({ status: 'next' }));
  });

  /* Within the limit the shared counter decides, on the API's own window. */
  assert.deepStrictEqual(await admit('a'), { status: 'next' });
  assert.deepStrictEqual(asked, [{ namespace: 'api', key: 'a', windowMs: API_RATE_WINDOW_MS, limit: LIMIT, inclusiveReset: false }],
    'the API window keeps its own boundary rather than adopting the webhook one');

  /* Refused once by the shared counter, the caller is refused from memory for the rest of the window. */
  answer = () => Promise.resolve({ allowed: false });
  assert.strictEqual((await admit('b')).status, 429);
  const askedBefore = asked.length;
  for (let i = 0; i < 50; i += 1) assert.strictEqual((await admit('b')).status, 429);
  assert.strictEqual(asked.length, askedBefore,
    'an already-refused caller must be answered from memory before the shared counter is asked, '
    + 'or a throttled flood becomes a query per request');
  /* Another caller is still asked about. */
  answer = () => Promise.resolve({ allowed: true });
  assert.deepStrictEqual(await admit('c'), { status: 'next' });
  assert.strictEqual(asked.length, askedBefore + 1);
  /* Once the window has closed, the refused caller is asked about again. */
  now += API_RATE_WINDOW_MS + 1;
  assert.deepStrictEqual(await admit('b'), { status: 'next' });
  assert.strictEqual(asked.length, askedBefore + 2);

  /* A counter that cannot answer has not said the caller is within their limit. */
  answer = () => Promise.reject(new Error('connection refused'));
  const unavailable = await admit('d');
  assert.strictEqual(unavailable.status, 503,
    'a shared-counter failure must be reported as unavailable rather than permitting the request');
  assert.strictEqual(unavailable.body.code, 'RATE_LIMIT_UNAVAILABLE');

  /* The local ceiling is the backstop for a shared counter that never refuses. */
  answer = () => Promise.resolve({ allowed: true });
  now += API_RATE_WINDOW_MS + 1;
  const askedAtStart = asked.length;
  let firstRefusal = null;
  for (let sent = 1; sent <= LOCAL_ADMISSION_CEILING + 5 && firstRefusal === null; sent += 1) {
    if ((await admit('e')).status === 429) firstRefusal = sent;
  }
  assert.strictEqual(firstRefusal, LOCAL_ADMISSION_CEILING + 1);
  assert.strictEqual(asked.length - askedAtStart, LOCAL_ADMISSION_CEILING,
    'the request over the ceiling is refused without a query');

  /* Without a database this process is the only counter, and the local bucket is the limit. */
  shared = null;
  now += API_RATE_WINDOW_MS + 1;
  let localRefusal = null;
  for (let sent = 1; sent <= LIMIT + 5 && localRefusal === null; sent += 1) {
    if ((await admit('f')).status === 429) localRefusal = sent;
  }
  assert.strictEqual(localRefusal, LIMIT + 1);

  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(serverSource, /inclusiveReset: true/, 'and the webhook window keeps its own');
}

(async () => {
  await admissionProperties();
  await waitForServer();

  /* A forged cookie is not a session, so it must not buy its own bucket. */
  const forgedFirst429 = await exhaust(sent => call(`nv_session=forged-${sent}-${'x'.repeat(64)}`));
  assert.strictEqual(
    forgedFirst429, LIMIT + 1,
    `rotating an unsealable cookie must share one bucket: expected a 429 on request ${LIMIT + 1}, got ${forgedFirst429 === null ? 'none in ' + (LIMIT + 1) + ' requests' : 'one on ' + forgedFirst429}`
  );

  /* That bucket is the address, so a second forged shape is already spent. */
  assert.strictEqual(
    await call(`nv_session=${'z'.repeat(80)}`), 429,
    'an unsealable cookie must be counted against the caller address, not its own key'
  );

  /*
   * A sealed session re-issued mid-window keeps its counter. seal() draws a
   * fresh IV and authentication tag every call, so identity has to come from
   * the payload, not the ciphertext.
   */
  const nonce = 'a'.repeat(48);
  let spent = 0;
  for (let i = 0; i < 12; i += 1) {
    const status = await call(`nv_session=${seal(session(nonce))}`);
    assert.strictEqual(status !== 429, true, `a fresh session must not be limited after ${i} requests`);
    spent += 1;
  }
  const resealedFirst429 = await exhaust(() => call(`nv_session=${seal(session(nonce))}`));
  assert.strictEqual(
    resealedFirst429, LIMIT + 1 - spent,
    `re-sealing an unchanged session must not reset its bucket: ${spent} requests were already spent, so the 429 belongs on request ${LIMIT + 1 - spent} of the remainder, not ${resealedFirst429}`
  );

  /*
   * Distinct sessions stay independent: the limit is per session, not global.
   * A distinct session must reach CSRF issuance with its own bucket.
   */
  const otherSession = await call(`nv_session=${seal(session('b'.repeat(48)))}`);
  assert.notStrictEqual(
    otherSession, 429,
    `a different session must have its own bucket, got ${otherSession}`
  );

  console.log('rate-limit-server-contract: ok');
  child.kill('SIGTERM');
})().catch(error => {
  child.kill('SIGTERM');
  console.error(error.message);
  process.exitCode = 1;
});
