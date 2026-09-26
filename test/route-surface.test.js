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

/*
 * The growth ratchet.
 *
 * This number is a speed bump with a message on it, and it is worth being
 * plain about that: a hardcoded count proves nothing about the code it
 * guards, and anyone can raise it in the same commit that breaks it. What it
 * does is make growing server.js a deliberate act with a diff line attached,
 * rather than the path of least resistance it is today at a hundred and
 * forty-seven routes and seven thousand lines.
 *
 * The rule it is here to carry:
 *
 *   A new route's *logic* belongs in a module under src/ behind a narrow
 *   contract, with server.js holding only the registration. That is the
 *   pattern that has actually worked here -- src/single-use-store.js,
 *   src/live-stream.js and src/rate-limit-identity.js each took real logic
 *   out and each made what remained smaller and testable on its own.
 *
 * What was measured and deliberately not done: lifting a whole URL prefix
 * into a router module. Every candidate group needs between twenty-two and
 * ninety-nine of server.js's top-level bindings passed in to work. That
 * dependency count is the finding, not an obstacle to route around -- routes
 * and helpers here are entangled, and moving routes behind a large injected
 * dependency object relocates the entanglement across a parameter list
 * without reducing it. Extracting logic reduces it; extracting URLs does not.
 */
/*
 * Raised from 147 to 153 for exposure scanning, deliberately and with the
 * reason the ratchet asks for.
 *
 * The six routes are registration and nothing else: each one validates a
 * couple of parameters, calls one method on `src/exposure-store.js`,
 * `src/exposure-reader.js` or `src/exposure-narration.js`, and returns the
 * result. The identity boundary is a parameter passed into the store, where it
 * lands in a WHERE clause; the decisions about coverage, disposition and
 * wording are all in modules with their own tests. That is exactly the shape
 * this ratchet exists to encourage, so the number moves rather than the logic
 * being pushed back into this file to avoid moving it.
 *
 * 153 to 155 adds the two verification routes. The verify handler is the
 * longest of the eight and worth naming: it re-reads a blob, re-detects, mints
 * a bound grant and records an attempt. Every one of those is a call into a
 * module with its own tests -- the handler sequences them and decides nothing
 * itself, which is the line this ratchet is drawn at.
 *
 * 155 to 157 adds the two readability-probe routes, which make the prober
 * reachable at all. The probe handler is the same shape as the verify handler
 * beside it and the same argument applies: it discovers a project, mints a
 * grant bound to the relation and columns an operator named, and records the
 * answer. What it does not do is choose any of them -- the relation and the
 * projection arrive from the request and the prober refuses whatever it will
 * not ask for, so no judgement about somebody's database lives in this file.
 *
 * 157 to 159 adds the exposure history read and the clear. The history
 * handler reads one page of scans and one query of rule counts, and sums the
 * counts by the narration table's severity; the clear checks a confirmation
 * word and calls one store method, whose transaction is where every decision
 * about what is removed lives and is tested against a real database.
 *
 * 159 to 166 adds the governance lifecycle: switching a policy off, archiving,
 * restoring, discarding a draft, withdrawing a version, resetting a repository,
 * and listing what was archived. Each handler passes the scope, the verified
 * authorization and the request body to one method of the governance service
 * and returns what it answers. The role is checked twice, here and in the
 * service; every decision -- what may be switched off, whether a key is free,
 * whose draft it is, what a reset touches -- is in `src/governance-api.js` and
 * `src/governance-store.js`, and is tested against a real database.
 *
 * 166 to 167 adds the workspace posture read the overview scores. The handler
 * is one call: the credential classification, the recovery and exposure
 * summaries and the boundary state are all in `src/workspace-posture.js`,
 * tested there, and the exposure query is in the store, tested against a real
 * database.
 *
 * 167 to 168 adds the repository audit. The handler opens a guarded read
 * session, calls one function and closes the session; which files are read,
 * every rule, the registry lookups and the scoring are in
 * `src/code-audit.js` and tested there rule by rule.
 *
 * 168 to 169 adds the anonymous site check. The handler throttles per
 * identity and calls one function; the requests, the rules and the scoring are
 * in `src/site-check.js`, and the anonymous transport profile it uses is in
 * `src/guarded-fetch.js`, each tested where it lives.
 */
const SERVER_ROUTE_CEILING = 169;
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const registeredInServer = serverSource
  .split('\n')
  .filter(line => /^app\.(get|post|put|patch|delete)\('/.test(line)).length;

assert(
  registeredInServer <= SERVER_ROUTE_CEILING,
  `server.js now registers ${registeredInServer} routes, above the ${SERVER_ROUTE_CEILING} it held when this ratchet was set. `
  + 'Put the new route\'s logic in a module under src/ behind a narrow contract and leave the registration here, '
  + 'or raise this number deliberately and say why.'
);

/* The ratchet may only tighten. A count that has drifted below the ceiling
   means the ceiling is stale and is quietly permitting growth again. */
assert(
  registeredInServer >= SERVER_ROUTE_CEILING - 5,
  `server.js registers ${registeredInServer} routes, well under the ${SERVER_ROUTE_CEILING} ceiling. `
  + 'Lower SERVER_ROUTE_CEILING to match so the ratchet keeps meaning something.'
);

/* A route module that nothing mounts is worse than no route module: it reads
   as covered and serves nothing. */
const routesDir = path.join(root, 'src', 'routes');
if (fs.existsSync(routesDir)) {
  for (const file of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
    const moduleName = file.replace(/\.js$/, '');
    assert(
      serverSource.includes(`routes/${moduleName}`),
      `src/routes/${file} is never mounted from server.js`
    );
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
