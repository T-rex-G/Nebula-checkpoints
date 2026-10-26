'use strict';
const { serverEntry } = require('./helpers/server-entry');
const { withLifetime } = require('./fixtures/local-session');

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
const { KEY_PURPOSES, deriveKey } = require('../apps/api/src/platform/crypto/key-derivation.ts');

const root = path.resolve(__dirname, '..');
const secret = 'route-surface-test-secret-0123456789abcdef-0123456789abcdef';
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const port = 19000 + Math.floor(Math.random() * 1000);

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime(value)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

const account = {
  provider: 'github', authMethod: 'token', login: 'surface-user',
  token: 'fixture-token'
};
const sessionCookie = () => `nv_session=${seal({
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
const ROUTE_SOURCES = ['server.js', path.join('apps', 'api', 'src', 'modules', 'identity-access', 'http', 'security-routes.ts')]
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
 *   pattern that has actually worked here -- apps/api/src/platform/rate-limit/single-use-store.ts,
 *   Pulsar's live stream (apps/api/src/modules/pulsar/application/live-stream.ts) and
 *   apps/api/src/platform/rate-limit/rate-limit-identity.ts each took real logic
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
 * couple of parameters, calls one method on the exposure store, reader or
 * narration (now `apps/api/src/modules/quasar`), and returns the
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
 * whose draft it is, what a reset touches -- is in `apps/api/src/modules/kepler/application/governance-api.ts` and
 * `apps/api/src/modules/kepler/persistence/governance-store.ts`, and is tested against a real database.
 *
 * 166 to 167 adds the workspace posture read the overview scores. The handler
 * is one call: the credential classification, the recovery and exposure
 * summaries and the boundary state are all in the posture module
 * (`apps/api/src/modules/posture`), tested there, and the exposure query is
 * in the store, tested against a real database.
 *
 * 167 to 168 adds the repository audit. The handler opens a guarded read
 * session, calls one function and closes the session; which files are read,
 * every rule, the registry lookups and the scoring are in
 * the Uranus module and tested there rule by rule.
 *
 * 168 to 169 adds the anonymous site check. The handler throttles per
 * identity and calls one function; the requests, the rules and the scoring are
 * in Parallax (`apps/api/src/modules/parallax/`), and the anonymous transport profile it uses is in
 * `apps/api/src/platform/network/guarded-fetch.ts`, each tested where it lives.
 *
 * 169 to 171 adds `/.well-known/security.txt` and `/robots.txt`. Both are
 * static text built from configuration: the security contact a researcher
 * needs, with an expiry the RFC requires, and a crawler rule that keeps the
 * API out of indexes. Neither touches a session, a provider or a store.
 *
 * 171 to 172 adds the provider's branch rules for the Safeguards panel. The
 * handler binds a reader to the open repository and calls one function; which
 * provider paths are read, how classic protection and rulesets combine, and
 * why a hidden detail is unknown rather than on are in
 * `apps/api/src/modules/posture/application/branch-protection.ts`, tested there provider by provider.
 *
 * 172 to 176 adds the kept audits: a branch's history, one past audit's
 * findings, the watch over its components, and the clear. Each handler is one
 * call to Uranus's audit history (`apps/api/src/modules/uranus/persistence/`) -- what is stored, how it is reduced so
 * that no part of the repository is, what is kept and for how long, and when
 * the watch asks again are all there and tested against a real database; what
 * the watch asks, and what counts as new, is in `apps/api/src/modules/uranus/application/audit-watch.ts`.
 */
/*
 * 176 to 177 adds the site check on its own, for an address rather than a
 * repository's homepage. It is the same handler as the repository route --
 * one function that validates the address, throttles, and hands the check to
 * the job runner (apps/api/src/platform/jobs/audit-jobs.ts) -- registered twice; every rule is
 * in Parallax (`apps/api/src/modules/parallax/`).
 */
/*
 * 177 to 184 adds a team's decisions about its audit findings, the clocks
 * and time to fix, and the merge gate: the decisions as a list, one decision,
 * taking one back and one finding's record of them; where a branch stands
 * against its clocks; the gate on a pull request; and the grade worked out
 * again after a decision. Each handler is a call into a module --
 * Uranus's triage (`domain/audit-triage.ts`: the decisions and how they lie over
 * an audit; `application/merge-gate.ts`: the gate and its policy preview), its
 * audit history (first-seen dates,
 * resolutions and the metrics) and `apps/api/src/modules/kepler/domain/code-audit-policy.ts` (the clock) --
 * each tested on its own, against a real database where it keeps rows.
 */
/*
 * 184 to 185 adds the Overview's security posture: one read across the audit
 * history, the exposure scans and the governance decisions the identity
 * already holds. The handler calls the three stores and hands what they
 * returned to `apps/api/src/modules/posture/domain/posture-summary.ts`, which decides every figure and is
 * tested on its own; the store queries are tested against a real database.
 */
/*
 * 185 to 187 adds the findings inbox and the CODEOWNERS read beside it. The
 * inbox reads the two stores and hands their rows to `apps/api/src/modules/posture/domain/findings-inbox.ts`,
 * which decides every state and the order; the CODEOWNERS route reads one file
 * through the qualified file read and hands it to `packages/contracts/src/codeowners.ts`,
 * which parses and matches it the way GitHub documents. Both are tested on
 * their own, the store queries against a real database.
 */
/*
 * From D12 the routes leave server.js for registration functions in the
 * modules (`apps/api/src/modules/<module>/http`), so the number server.js
 * registers itself only falls, and each move lowers this ceiling to match.
 * 187 to 185: Parallax's two site-check routes (its four rendered-audit
 * routes were already registered from their own file).
 * 185 to 181: Posture's four.
 * 181 to 174: Pulsar's seven.
 * 174 to 162: Quasar's twelve.
 * 162 to 150: Uranus's twelve.
 * 150 to 135: Corona's fifteen.
 * 135 to 85: Kepler's fifty.
 * 85 to 65: the workbench's repository, content and history routes, and CODEOWNERS.
 * 65 to 40: the workbench's collaboration routes (pull requests, issues,
 * notifications, search, stars, workflow runs, releases), its uploads, the
 * folder move and the dependency audit.
 * 40 to 27: the platform's own routes -- the probes, the public files and the
 * page, the vendor libraries, the webhook intake, the configuration and
 * capabilities, the API budget, the build's identity and the shell fallback.
 * 27 to 24: identity and access's alpha front door -- the status, the
 * redemption and the end of a session -- with the access boundary before them.
 * 24 to 13: identity and access's accounts (sign-in with a token, the list,
 * the switches and the removal), signing out, who the account is, and the
 * tester's own data (the privacy notice, feedback, every provider
 * disconnected, deletion).
 * 13 to 0: the GitHub App connection, the session's own security (the
 * scanner's state, the CSRF token, the step-up grant), OAuth sign-in and the
 * sessions an identity holds elsewhere. server.js registers no route itself;
 * every route is a module's or the platform's.
 */
const SERVER_ROUTE_CEILING = 0;
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
   as covered and serves nothing. Every registration function a module's http
   folder exports is called by the server. */
const modulesRoot = path.join(root, 'apps', 'api', 'src', 'modules');
for (const moduleName of fs.readdirSync(modulesRoot)) {
  const httpDir = path.join(modulesRoot, moduleName, 'http');
  if (!fs.existsSync(httpDir)) continue;
  for (const file of fs.readdirSync(httpDir).filter(name => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(httpDir, file), 'utf8');
    for (const [, name] of source.matchAll(/^export function (register[A-Z]\w*)\(/gm)) {
      assert(
        new RegExp(`\\b${name}\\(app\\b`).test(serverSource),
        `${moduleName}/http/${file}: ${name} is never called by server.js`
      );
    }
  }
}

const child = spawn(process.execPath, [serverEntry()], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: secret, DATABASE_URL: '',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn'
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

    const authorized = await call(entry.method, entry.path, { cookie: sessionCookie() });
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
    const probe = await call(entry.method, entry.path, { cookie: sessionCookie() });
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
