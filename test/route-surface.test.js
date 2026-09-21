'use strict';

/*
 * A characterization test for the /api/security surface, written before those
 * routes were moved out of server.js and unchanged by the move. That is the
 * whole point: it describes what a caller observes, not where the code lives,
 * so it can only stay green if the extraction changed nothing a caller can
 * see.
 *
 * It is deliberately not an inventory of methods and paths. A list of routes
 * that still exist cannot tell you that one of them lost its `auth`, its
 * capability gate or its repository check on the way -- the path is still
 * there, still answers, and now answers anyone. What distinguishes those cases
 * is the status and code each route gives to a caller who should not get
 * through, so that is what is recorded here.
 *
 * Each expectation below was taken from the running server before the
 * extraction rather than written from the handler's source, so a handler that
 * never behaved the way its code reads is still captured as it really is.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');

const root = path.resolve(__dirname, '..');
const secret = 'route-surface-test-secret-0123456789abcdef-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const port = 34500 + Math.floor(Math.random() * 400);

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

const account = {
  provider: 'gitea', authMethod: 'token', login: 'surface-user',
  token: 'fixture-token', baseUrl: 'https://gitea.example'
};
const sessionCookie = `nv_session=${seal({
  accounts: [account], active: 0,
  security: { sessionNonce: 'a'.repeat(48), stepUp: null }
})}`;

/*
 * Anonymous must be refused by every route, and a session must reach each
 * route's own gate -- which is the part an inventory cannot see. A step-up
 * request arriving with no action is rejected by the handler; revoke-others is
 * stopped at the CSRF boundary. Those two differ precisely because their
 * middleware differs.
 */
const EXPECTATIONS = [
  { method: 'GET', path: '/api/security/scanner-status', anonymous: [401, 'AUTH_REQUIRED'], session: [200, null] },
  { method: 'GET', path: '/api/security/csrf', anonymous: [401, 'AUTH_REQUIRED'], session: [200, null] },
  { method: 'POST', path: '/api/security/step-up', anonymous: [401, 'AUTH_REQUIRED'], session: [400, 'STEP_UP_ACTION_INVALID'] },
  { method: 'GET', path: '/api/security/sessions', anonymous: [401, 'AUTH_REQUIRED'], session: [200, null] },
  { method: 'POST', path: '/api/security/revoke-others', anonymous: [401, 'AUTH_REQUIRED'], session: [403, 'CSRF_REQUIRED'] }
];

/*
 * Behaviour cannot see everything. `capabilityAccess('upload-security')` on
 * scanner-status refuses a provider that lacks the feature, but every session
 * this test can cheaply build has it, so dropping that gate changes no status
 * this file could assert -- verified by removing it and watching the
 * behavioural half stay green.
 *
 * So the chain is also read as text. Structural where behaviour is blind,
 * behavioural everywhere else; neither on its own is enough. The source is
 * searched wherever these routes live, so moving them out of server.js does
 * not quietly turn this half of the test into a check of an empty string.
 */
const ROUTE_SOURCES = ['server.js', path.join('src', 'routes', 'security.js')]
  .map(relative => path.join(root, relative))
  .filter(file => fs.existsSync(file))
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n');

const MIDDLEWARE = [
  ['get', '/api/security/scanner-status', ['auth', "capabilityAccess('upload-security')"]],
  ['get', '/api/security/csrf', ['accountAuth']],
  ['post', '/api/security/step-up', ['providerSessionAccess', 'alphaStepUpRepositoryAccess', 'auth']],
  ['get', '/api/security/sessions', ['auth']],
  ['post', '/api/security/revoke-others', ['auth']]
];

for (const [method, routePath, expected] of MIDDLEWARE) {
  const line = ROUTE_SOURCES.split('\n').find(candidate =>
    candidate.includes(`.${method}('${routePath}'`));
  assert(line, `${method.toUpperCase()} ${routePath} is not registered in any known route file`);
  let cursor = line.indexOf(routePath);
  for (const name of expected) {
    const at = line.indexOf(name, cursor);
    assert(
      at > -1,
      `${method.toUpperCase()} ${routePath} must still be guarded by ${name}`
    );
    cursor = at + name.length;
  }
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: secret, DATABASE_URL: '',
    NV_GIT_HOST_ALLOWLIST: 'gitea.example', NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function call(method, pathname, headers) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    /* x-nv marks an unsafe call as coming from the app; without it every POST
       stops at the browser boundary and never reaches the route being tested. */
    headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json', 'x-nv': '1' } : {}) },
    body: method === 'POST' ? '{}' : undefined
  });
  let body = {};
  try { body = await response.json(); } catch { /* an empty or non-JSON body is still a status */ }
  return { status: response.status, code: body && body.code ? body.code : null };
}

(async () => {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs}`);
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (ready.body) await ready.body.cancel();
      if (ready.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become ready\n${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  for (const entry of EXPECTATIONS) {
    const anonymous = await call(entry.method, entry.path, {});
    assert.deepStrictEqual(
      [anonymous.status, anonymous.code], entry.anonymous,
      `${entry.method} ${entry.path} must refuse an anonymous caller exactly as it did before`
    );

    const authorized = await call(entry.method, entry.path, { cookie: sessionCookie });
    assert.deepStrictEqual(
      [authorized.status, authorized.code], entry.session,
      `${entry.method} ${entry.path} must answer a session exactly as it did before`
    );
  }

  /*
   * A route that disappears must fail loudly rather than quietly become a 404
   * that nothing asserts against, so the set is closed: every path above is
   * reachable, and none of them answers 404.
   */
  for (const entry of EXPECTATIONS) {
    const probe = await call(entry.method, entry.path, { cookie: sessionCookie });
    assert.notStrictEqual(
      probe.status, 404,
      `${entry.method} ${entry.path} is no longer mounted`
    );
  }

  console.log(`route surface tests passed (${EXPECTATIONS.length} security routes, anonymous and authorized)`);
  child.kill('SIGTERM');
})().catch(error => {
  child.kill('SIGTERM');
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
