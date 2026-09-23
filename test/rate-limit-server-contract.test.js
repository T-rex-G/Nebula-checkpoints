'use strict';

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
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');

const root = path.resolve(__dirname, '..');
const port = 33000 + Math.floor(Math.random() * 1000);
const secret = 'rate-limit-server-test-secret-0123456789abcdef-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const LIMIT = 300;

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function session(sessionNonce, login = 'rate-fixture-user') {
  return {
    accounts: [{ provider: 'gitea', authMethod: 'token', login, token: 'fixture-token', baseUrl: 'https://gitea.example' }],
    active: 0,
    security: { sessionNonce, stepUp: null }
  };
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: secret,
    DATABASE_URL: '',
    NV_GIT_HOST_ALLOWLIST: 'gitea.example',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

/* /api/rate needs no provider call to be counted: the limiter runs before the route. */
async function call(cookie) {
  const headers = cookie ? { cookie } : {};
  const response = await fetch(`http://127.0.0.1:${port}/api/rate`, { headers });
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
 * design; asserted here because no behavioural test without a database can see
 * it.
 */
{
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  /* Bounded to this middleware. A slice that runs to the end of the file would
     find every later handler's next() and report them as this one's. */
  const limiterStart = serverSource.indexOf("app.use('/api', (req, res, next) => {\n  const { key } = rateLimitIdentity(");
  assert(limiterStart > -1, 'the API limiter middleware was not found');
  const limiterEnd = serverSource.indexOf('\n});', limiterStart);
  assert(limiterEnd > limiterStart, 'the API limiter middleware has no visible end');
  const limiter = serverSource.slice(limiterStart, limiterEnd);
  const refusedAt = limiter.indexOf('b.refusedUntil > now');
  const storeAt = limiter.indexOf('apiRateLimitStore()');
  assert(refusedAt > -1, 'the limiter must remember a refusal locally');
  assert(storeAt > -1, 'the limiter must consult the shared counter');
  assert(
    refusedAt < storeAt,
    'an already-refused caller must be answered from memory before the shared counter is asked, '
    + 'or a throttled flood becomes a query per request'
  );

  /* A counter that cannot answer must not fall back to the local count: that
     count says "well within" on every instance that has not seen the caller. */
  const catchAt = limiter.indexOf('.catch(');
  const unavailableAt = limiter.indexOf('RATE_LIMIT_UNAVAILABLE');
  assert(catchAt > -1 && unavailableAt > catchAt,
    'a shared-counter failure must be caught and reported as unavailable rather than permitting the request');
  assert.strictEqual(
    /catch[\s\S]{0,400}next\(\)/.test(limiter.slice(catchAt)), false,
    'no failure path may call next(): an unanswerable counter has not said the caller is within their limit'
  );
  assert.match(
    serverSource, /inclusiveReset: false/,
    'the API window keeps its own boundary rather than adopting the webhook one'
  );
  assert.match(
    serverSource, /inclusiveReset: true/,
    'and the webhook window keeps its own'
  );
}

(async () => {
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
   * What the route itself answers is beside the point — the fixture session
   * carries no capability grant, so /api/rate refuses it with a 409. Anything
   * other than 429 means the request reached the route with its own bucket.
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
