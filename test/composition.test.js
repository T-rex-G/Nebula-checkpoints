'use strict';
/*
 * The composed server, asked how it behaves.
 *
 * How the server is put together -- which setting reaches which service,
 * which service is handed to which route, what is no longer served -- used to
 * be checked by reading the composition's source for the text that wires it.
 * Text is a poor witness: a check passes on a line that never runs, fails on
 * a rename that changes nothing, and says nothing about what the server does
 * with what it was handed. Each check here builds the application the server
 * listens with (apps/api/src/composition/application.ts) in this process,
 * from an environment of its own, and asks the result.
 *
 * Every check states the source-text assertion it replaced, so the ledger can
 * account for each one.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { composedApplication, browser, standInForOutbound, bodyOf } = require('./helpers/composed-application');
const { CORRELATION_HEADER } = require('../packages/contracts/src/api-envelope.ts');

const SECRET = 's'.repeat(48);
const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: SECRET, NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });

/* A stand-in for a live-stream reader: it accepts every write and can be ended. */
const reader = () => ({ write: () => true, end() {} });

/* Opens readers on one stream key until the hub refuses, and says how many it admitted. */
function admitAll(hub, key, limit = 1000) {
  let admitted = 0;
  while (admitted < limit && hub.admits(key)) {
    hub.add(key, reader(), `${key}#${admitted}`);
    admitted += 1;
  }
  return admitted;
}

(async () => {
  /*
   * ---- The live streams are held to both of the deployment's caps ----
   * Replaces hardening-contract's text checks that the composition passed
   * liveClientsPerRepo and liveClientsTotal to createLiveHub. The values are
   * distinct from each other and from both defaults, so a cap read from the
   * wrong setting, or a default left in its place, admits the wrong number.
   */
  {
    const application = await composedApplication({ ...BASE, NV_LIVE_CLIENTS_PER_REPO: '3', NV_LIVE_CLIENTS_TOTAL: '11' }, { listen: false });
    try {
      const hub = application.core.liveHub;
      assert.equal(admitAll(hub, 'github:acme/one'), 3, 'one repository\'s stream admits as many readers as NV_LIVE_CLIENTS_PER_REPO allows');
      let total = 3;
      for (let index = 0; index < 20 && hub.admits(`github:acme/repo-${index}`); index += 1) {
        total += admitAll(hub, `github:acme/repo-${index}`);
      }
      assert.equal(total, 11, 'all the streams together admit as many readers as NV_LIVE_CLIENTS_TOTAL allows');
      assert.equal(hub.count(), 11);
    } finally {
      await application.close();
    }
  }

  /*
   * ---- The font proxy stays retired ----
   * Replaces hardening-contract's check that the composition no longer held
   * FONT_ASSET_RX, and verify.js's that it held no Google Fonts host. The
   * server once proxied /gfonts/css2 and /gstatic/* to Google; typefaces are
   * now served from this origin. Asked for either, the composed server
   * reaches no third party and answers with neither a stylesheet nor a font.
   */
  {
    const outbound = standInForOutbound([]);
    const application = await composedApplication(BASE);
    try {
      const stylesheet = await fetch(`${application.url}/gfonts/css2?family=Inter:wght@400;700&display=swap`);
      assert.doesNotMatch(String(stylesheet.headers.get('content-type')), /text\/css/, 'the former stylesheet proxy serves no stylesheet');
      await stylesheet.arrayBuffer();
      const font = await fetch(`${application.url}/gstatic/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2`);
      assert.equal(font.status, 404, 'the former font proxy serves no font');
      await font.arrayBuffer();
      assert.deepEqual(outbound.requests, [], 'and neither reaches Google');
    } finally {
      outbound.restore();
      await application.close();
    }
  }

  /*
   * ---- What the page is told, and what it is served ----
   * Replaces upload-transport-choice's check that the published Git Data
   * boundary was the composition's own constant (contentsMaxMb), verify.js's
   * that the vendor route read the pinned copies in public/vendor, and its
   * that the probes were registered. The page labels a queued file against
   * the ceilings the server publishes, so each must be the one the server
   * holds; a pinned library must come from the release, not from a CDN; and
   * readiness must say a database is not configured, not that it is down.
   */
  {
    const outbound = standInForOutbound([]);
    const application = await composedApplication({ ...BASE, NV_UPLOAD_MAX_MB: '300', NV_GIT_DATA_MAX_MB: '33', NV_NATIVE_PUSH_MAX_MB: '44' });
    try {
      const published = await bodyOf(await fetch(`${application.url}/api/config`));
      const MB = 1024 * 1024;
      const { limits, settings } = application.settings;
      assert.deepEqual(
        { uploadMaxMb: published.uploadMaxMb, gitDataMaxMb: published.gitDataMaxMb, nativePushMaxMb: published.nativePushMaxMb, contentsMaxMb: published.contentsMaxMb },
        { uploadMaxMb: 300, gitDataMaxMb: 33, nativePushMaxMb: 44, contentsMaxMb: limits.contentsMax / MB },
        'the page is told the ceilings this deployment holds, the Git Data boundary among them'
      );
      assert.equal(limits.uploadMax, settings.uploadMaxMb * MB, 'and the ceiling the server holds is the one it publishes');

      const file = 'codemirror/5.65.16/codemirror.min.js';
      const served = await fetch(`${application.url}/vendor/${file}`);
      assert.equal(served.status, 200, 'a pinned library is served');
      const pinned = require('node:fs').readFileSync(require('node:path').join(application.release.root, 'public', 'vendor', file));
      assert(Buffer.from(await served.arrayBuffer()).equals(pinned), 'a pinned library is served from the release\'s own copy');

      const readiness = await fetch(`${application.url}/readyz`);
      assert.deepEqual([readiness.status, await bodyOf(readiness)], [200, { ok: true, database: 'optional-not-configured' }],
        'readiness says no database is configured, rather than that one is down');
      assert.deepEqual(outbound.requests, [], 'none of it reaches past this origin');
    } finally {
      outbound.restore();
      await application.close();
    }
  }

  /*
   * ---- GitHub's webhook deliveries pass the sender's rate first ----
   * Replaces verify.js's checks that the composition built the webhook intake,
   * registered its route and handed it the webhook limiter. A sender gets 120
   * deliveries a minute; before that, a deployment without a database says
   * live events need one. A delivery past the rate is refused before anything
   * is read.
   */
  {
    const application = await composedApplication(BASE);
    try {
      const statuses = [];
      for (let delivery = 0; delivery < 122; delivery += 1) {
        const answer = await fetch(`${application.url}/hooks/github/${'a'.repeat(32)}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, body: '{}'
        });
        statuses.push(answer.status);
        await answer.arrayBuffer();
      }
      assert.deepEqual(statuses.slice(0, 120), Array(120).fill(503), 'within the rate, a delivery reaches the intake, which needs a database');
      assert.deepEqual(statuses.slice(120), [429, 429], 'past it, the sender is refused');
    } finally {
      await application.close();
    }
  }

  /*
   * ---- GitHub is written to only through the mutation gateway, and read with the account's own credential ----
   * Replaces the mutation-coverage and mutation-gateway contracts' checks that
   * the composition handed GitHub's REST client the gateway's check, and the
   * authorization resolver contract's that it built one resolver asking GitHub
   * through that client. A write with no mutation in progress is refused
   * before anything leaves the server; a read, and the resolver's question
   * about the account's permission on a repository, go to GitHub with that
   * account's credential and no other.
   */
  {
    const github = standInForOutbound([
      ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
      ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo' } }]
    ]);
    const application = await composedApplication(BASE, { listen: false });
    const asked = () => github.requests.map(({ method, url, authorization }) => [method, url, authorization]);
    try {
      const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');
      const token = `ghp_${'c'.repeat(36)}`;
      const account = Object.freeze({ provider: 'github', login: 'octo', id: 7, token, authMethod: 'token' });
      await assert.rejects(
        application.core.github.gh(account, '/repos/acme/demo/contents/notes.md', { method: 'PUT', body: { message: 'write', content: 'eA==' } }),
        error => error.code === 'MUTATION_GATEWAY_REQUIRED',
        'a write with no mutation in progress is the gateway\'s to refuse'
      );
      assert.deepEqual(asked(), [], 'and nothing leaves the server');

      await application.core.github.gh(account, '/repos/acme/demo');
      assert.deepEqual(asked(), [['GET', 'https://api.github.com/repos/acme/demo', `Bearer ${token}`]],
        'a read goes to GitHub with the account\'s credential');

      github.requests.length = 0;
      const snapshot = await application.core.authorizationResolver.resolve({ account, owner: 'acme', repo: 'demo', actorIdentityKey: identityKey(account) });
      assert.deepEqual(asked(), [['GET', 'https://api.github.com/repos/acme/demo/collaborators/octo/permission', `Bearer ${token}`]],
        'the resolver asks GitHub for the account\'s permission, with the account\'s own credential');
      assert.equal(snapshot.scope.scopeKey, 'github:github.com:acme/demo');
      assert.equal(snapshot.executionPrincipal.login, 'octo');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- A GitHub App is optional, and when configured its credentials are the broker's ----
   * Replaces the GitHub App contract's checks that the composition loaded the
   * App's optional configuration, built the installation credential broker
   * and resolved provider accounts through one boundary. Without the App's
   * variables the page is told there is none and an App account cannot be
   * used; with them, an App account's credential is minted by the broker,
   * which proves itself to GitHub as the configured App.
   */
  {
    const crypto = require('node:crypto');
    const appAccount = Object.freeze({
      provider: 'github', authMethod: 'github-app', login: 'acme', installationId: 42, installationAccountId: 9, authorizedByIdentityKey: 'k'.repeat(64)
    });
    const github = standInForOutbound([
      ['GET /app/installations/42$', { body: { id: 42, app_id: 123, account: { login: 'acme', id: 9, type: 'Organization' }, repository_selection: 'selected', permissions: { contents: 'write' } } }],
      ['POST /app/installations/42/access_tokens$', { status: 201, body: { token: `ghs_${'i'.repeat(36)}`, expires_at: new Date(Date.now() + 3600e3).toISOString() } }]
    ]);
    try {
      const without = await composedApplication(BASE);
      try {
        assert.deepEqual((await bodyOf(await fetch(`${without.url}/api/config`))).githubApp, { enabled: false, webhookConfigured: false },
          'with none of its variables, the page is told there is no GitHub App');
        assert.equal(without.core.githubAppBroker, null, 'and no broker is built');
        await assert.rejects(without.core.resolveAccount(appAccount), error => error.code === 'GITHUB_APP_BROKER_UNAVAILABLE',
          'so an App account cannot be used');
      } finally {
        await without.close();
      }

      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const configured = await composedApplication({
        ...BASE, GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'nebula-composition', GITHUB_APP_CLIENT_ID: 'Iv1.composition',
        GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40), GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
        GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1/api/github-app/oauth/callback', GITHUB_APP_WEBHOOK_SECRET: 'w'.repeat(32)
      });
      const logged = [];
      const ownLog = console.log;
      try {
        assert.deepEqual((await bodyOf(await fetch(`${configured.url}/api/config`))).githubApp, { enabled: true, webhookConfigured: true },
          'with them, the page is told the App and its webhook are configured');
        console.log = (...line) => logged.push(line.join(' '));
        /* A refusal is kept as the answer, so a broker that is missing fails the check below rather than the test. */
        const resolved = await configured.core.resolveAccount(appAccount).catch(error => ({ refused: error.code || error.message }));
        console.log = ownLog;
        assert.equal(resolved.token, `ghs_${'i'.repeat(36)}`, 'an App account\'s credential is the installation token the broker minted');
        assert.deepEqual(github.requests.map(request => `${request.method} ${request.url}`), [
          'GET https://api.github.com/app/installations/42',
          'POST https://api.github.com/app/installations/42/access_tokens'
        ]);
        for (const request of github.requests) {
          const [scheme, jwt] = String(request.authorization).split(' ');
          const [header, payload, signature] = jwt.split('.');
          assert.equal(scheme, 'Bearer');
          assert(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')),
            'the broker proves itself with the configured App\'s key');
          assert.equal(String(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).iss), '123', 'as the configured App');
        }
        assert(logged.some(line => /"event":"github-app-lifecycle"/.test(line) && /"type":"authorization.refreshed"/.test(line) && /"installationId":42/.test(line)),
          'and the credential it minted is audited through identity and access\'s App records');
      } finally {
        console.log = ownLog;
        await configured.close();
      }
    } finally {
      github.restore();
    }
  }

  /*
   * ---- Every mutation is put to governance's policy, under the deployment's failure mode ----
   * Replaces the governance enforcement contracts' checks that the composition
   * built governance's runtime, handed it to the mutation gateway as its
   * policy evaluator, gave it the configured failure mode, and logged that
   * mode. Without a database the policy cannot be evaluated: in warn mode the
   * mutation proceeds under a warning, in block mode it is refused before it
   * runs, and either way the log names the mode and the gateway's events say
   * what was decided.
   */
  {
    const authorization = Object.freeze({
      schemaVersion: 1,
      scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
      executionPrincipal: { kind: 'user', identityKey: 'a'.repeat(64), login: 'Alice', authMethod: 'token' },
      governanceActor: { kind: 'human', identityKey: 'a'.repeat(64), login: 'Alice', verified: true },
      repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
      governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true }, installationCapabilities: null,
      evidence: { status: 'resolved', fetchedAt: '2026-07-22T18:00:00.000Z', expiresAt: '2026-07-22T19:00:00.000Z', reasonCode: null }
    });
    const mutation = Object.freeze({
      mutationId: '11111111-1111-4111-8111-111111111111', action: 'file.write', provider: 'github', owner: 'Acme', repo: 'Demo',
      actorIdentityKey: 'a'.repeat(64), actorLogin: 'Alice', method: 'PUT', route: '/api/repo/Acme/Demo/file',
      metadata: { branch: 'main', path: 'README.md' }, authorization
    });
    const outcomes = {};
    for (const mode of ['warn', 'block']) {
      const application = await composedApplication({ ...BASE, NV_GOVERNANCE_RUNTIME_FAILURE_MODE: mode }, { listen: false });
      const ownError = console.error;
      const ownLog = console.log;
      const errors = [];
      const events = [];
      console.error = (...line) => errors.push(JSON.parse(line.join(' ')));
      console.log = (...line) => events.push(JSON.parse(line.join(' ')));
      let ran = false;
      try {
        const gateway = application.core.mutationGateway;
        outcomes[mode] = await gateway.run(mutation, () => {
          ran = true;
          return gateway.current().policyDecision.enforcementOutcome;
        }).catch(error => `refused ${error.code} ${error.status}`);
      } finally {
        console.error = ownError;
        console.log = ownLog;
        await application.close();
      }
      assert.equal(ran, mode === 'warn', `in ${mode} mode the mutation ${mode === 'warn' ? 'runs' : 'never runs'}`);
      assert.deepEqual(errors.map(entry => [entry.warn, entry.code, entry.failureMode]),
        [['runtime policy evaluation unavailable', 'GOVERNANCE_DATABASE_REQUIRED', mode]], 'the log names the failure mode that applied');
      assert.deepEqual(events.map(entry => [entry.event, entry.outcome, entry.blockCode, entry.warningCodes]),
        mode === 'warn'
          ? [['policy.evaluated', 'warn', null, ['POLICY_EVALUATION_UNAVAILABLE']]]
          : [['policy.evaluated', 'block', null, ['POLICY_EVALUATION_UNAVAILABLE']], ['policy.blocked', null, 'POLICY_EVALUATION_UNAVAILABLE', []]],
        'and the gateway\'s events say what was decided');
    }
    assert.deepEqual(outcomes, { warn: 'warn', block: 'refused POLICY_EVALUATION_UNAVAILABLE 503' },
      'an unevaluable policy warns or refuses as NV_GOVERNANCE_RUNTIME_FAILURE_MODE says');
  }

  /*
   * ---- A signed-in write passes the session's guards, its mutation context, and only then GitHub ----
   * Replaces the security-foundation contract's checks that the composition
   * built the request guards, the session's security and repository access,
   * and that auth enforced CSRF and single-use step-up grants; verify.js's that
   * it registered the security and session-containment routes and built the
   * session's security; and the authorization-resolver and mutation-gateway
   * contracts' that it built the repository mutation context. A write needs
   * the session's own CSRF token; with it, the account's permission is
   * resolved with its credential, the mutation is put to policy, and only then
   * does GitHub see the write. A sensitive action needs a step-up grant, which
   * is spent the first time it is used.
   */
  {
    const application = await composedApplication(BASE);
    const sha = 'a'.repeat(40);
    const token = `ghp_${'z'.repeat(36)}`;
    const github = standInForOutbound([
      ['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
      ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
      ['GET /repos/acme/demo/git/ref/heads/main$', { body: { ref: 'refs/heads/main', object: { sha, type: 'commit' } } }],
      ['POST /repos/acme/demo/git/refs$', { status: 201, body: { ref: 'refs/heads/feature', object: { sha } } }]
    ]);
    const ownLog = console.log;
    const events = [];
    try {
      const page = browser(application);
      const other = browser(application);
      assert.equal((await page.request('/api/security/csrf')).status, 401, 'a CSRF token is a signed-in session\'s');
      assert.equal((await page.signIn(token)).status, 200);
      assert.equal((await other.signIn(token)).status, 200);
      const csrf = await page.csrf();
      const otherCsrf = await other.csrf();
      const write = headers => page.request('/api/repo/acme/demo/branches', { method: 'POST', body: { name: 'feature', from: 'main' }, headers });
      const signInRequests = github.requests.length;

      const bare = await write({});
      assert.deepEqual([bare.status, (await bodyOf(bare)).code], [403, 'CSRF_REQUIRED'], 'a write without the session\'s CSRF token is refused');
      const borrowed = await write({ 'x-nv-csrf': otherCsrf });
      assert.deepEqual([borrowed.status, (await bodyOf(borrowed)).code], [403, 'CSRF_INVALID'], 'and so is one with another session\'s');
      assert.equal(github.requests.length, signInRequests, 'before GitHub is asked anything');

      console.log = (...line) => events.push(line.join(' '));
      const created = await write({ 'x-nv-csrf': csrf });
      console.log = ownLog;
      assert.deepEqual([created.status, await bodyOf(created)], [200, { ok: true, name: 'feature', sha }], 'with the session\'s own token, the write is made');
      assert.deepEqual(github.requests.slice(signInRequests).map(request => [request.method, request.url, request.authorization]), [
        ['GET', 'https://api.github.com/repos/acme/demo/collaborators/octo/permission', `Bearer ${token}`],
        ['GET', 'https://api.github.com/repos/acme/demo/git/ref/heads/main', `Bearer ${token}`],
        ['POST', 'https://api.github.com/repos/acme/demo/git/refs', `Bearer ${token}`]
      ], 'the permission is resolved first, then GitHub is read and written with the account\'s credential');
      assert(events.some(line => /"event":"policy.evaluated"/.test(line) && /"action":"branch.create"/.test(line)),
        'and the write was put to policy before it reached GitHub');

      const sensitive = grant => page.request('/api/security/revoke-others', { method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf, ...(grant ? { 'x-nv-step-up': grant } : {}) } });
      const unproven = await sensitive();
      assert.deepEqual([unproven.status, (await bodyOf(unproven)).code], [403, 'STEP_UP_REQUIRED'], 'a sensitive action needs a step-up grant');
      const stepUp = await page.request('/api/security/step-up', {
        method: 'POST', body: { action: 'sessions.revoke-others', scope: {}, confirm: 'octo', credential: token }, headers: { 'x-nv-csrf': csrf }
      });
      const { grant, assurance } = await bodyOf(stepUp);
      assert.deepEqual([stepUp.status, assurance], [200, 'credential'], 'which the account earns by proving its credential again');
      const spent = await sensitive(grant);
      assert.deepEqual([spent.status, await bodyOf(spent)], [400, { error: 'Confirmation required' }], 'the grant lets the action through to its own checks');
      const replayed = await sensitive(grant);
      assert.deepEqual([replayed.status, (await bodyOf(replayed)).code], [403, 'STEP_UP_REPLAY'], 'once');

      const sessions = await page.request('/api/security/sessions');
      assert.notEqual(sessions.status, 404, 'the sessions an identity holds elsewhere are answered for');
      assert.match(String(sessions.headers.get('content-type')), /application\/json/);
      await sessions.arrayBuffer();
    } finally {
      console.log = ownLog;
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- A GitHub App flow's state is the server's own, and is spent once ----
   * Replaces the GitHub App contract's check that the composition handed the
   * App's routes the state verifier. The App's setup is reached by a redirect
   * carrying the state the server signed when the flow began, bound to the
   * session and the identity. A state signed with any other key is refused;
   * the server's own passes, once.
   */
  {
    const crypto = require('node:crypto');
    const { withLifetime } = require('./fixtures/local-session');
    const { createGithubAppState } = require('../apps/api/src/modules/github-provider/index.ts');
    const { hashJson } = require('../apps/api/src/platform/values/stable-hash.ts');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const github = standInForOutbound([]);
    const application = await composedApplication({
      ...BASE, GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'nebula-composition', GITHUB_APP_CLIENT_ID: 'Iv1.composition',
      GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40), GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
      GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1/api/github-app/oauth/callback', GITHUB_APP_WEBHOOK_SECRET: 'w'.repeat(32)
    });
    try {
      const account = { provider: 'github', authMethod: 'token', login: 'alice', avatar: '', baseUrl: '', token: 'not-used' };
      const identityKey = hashJson({ provider: 'github', baseUrl: '', login: 'alice' });
      const sessionNonce = 'a'.repeat(48);
      const awaiting = nonce => `nv_session=${application.core.seal(withLifetime({
        accounts: [account], active: 0,
        security: { sessionNonce, githubApp: { installation: { nonce, expiresAt: Date.now() + 600000, identityKey, userToken: 'temporary-user-token', userId: 1, login: 'alice' } } }
      }))}`;
      const signedWith = (key, nonce) => createGithubAppState(key, { purpose: 'installation-claim', sessionBinding: sessionNonce, identityKey }, { nonce, ttlMs: 600000 });
      const setup = async (cookie, state) => {
        const answer = await fetch(`${application.url}/api/github-app/setup?installation_id=0&state=${encodeURIComponent(state)}`, { headers: { cookie }, redirect: 'manual' });
        return new URLSearchParams(String(answer.headers.get('location')).split('?')[1]).get('code');
      };
      assert.equal(await setup(awaiting('first'), signedWith(crypto.randomBytes(32), 'first')), 'GITHUB_APP_STATE_INVALID',
        'a state the server did not sign is refused');
      const cookie = awaiting('second');
      const own = signedWith(application.settings.secrets.keys.githubAppState, 'second');
      assert.equal(await setup(cookie, own), 'GITHUB_APP_INSTALLATION_INVALID', 'the server\'s own state passes, on to the installation it names');
      assert.equal(await setup(cookie, own), 'GITHUB_APP_STATE_REPLAY', 'once');
      assert.deepEqual(github.requests, [], 'and neither is taken to GitHub');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- What an account can do follows the credential it holds ----
   * Replaces the GitHub App contract's check that the composition handed the
   * signed-in person's routes the provider capabilities. A token is a person's
   * own credential; an App account acts through an installation, which cannot
   * read a person's notifications. The page is told so.
   */
  {
    const crypto = require('node:crypto');
    const { withLifetime } = require('./fixtures/local-session');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const github = standInForOutbound([['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }]]);
    const application = await composedApplication({
      ...BASE, GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'nebula-composition', GITHUB_APP_CLIENT_ID: 'Iv1.composition',
      GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40), GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
      GITHUB_APP_CALLBACK_URL: 'http://127.0.0.1/api/github-app/oauth/callback', GITHUB_APP_WEBHOOK_SECRET: 'w'.repeat(32)
    });
    try {
      const person = browser(application);
      await person.signIn(`ghp_${'z'.repeat(36)}`);
      const own = (await bodyOf(await person.request('/api/me'))).caps;
      const installation = browser(application);
      installation.cookie = `nv_session=${application.core.seal(withLifetime({
        accounts: [{ provider: 'github', authMethod: 'github-app', login: 'acme', avatar: '', baseUrl: '', installationId: 42, installationAccountId: 9, authorizedByIdentityKey: 'k'.repeat(64) }],
        active: 0, security: { sessionNonce: 'b'.repeat(48) }
      }))}`;
      const installed = await bodyOf(await installation.request('/api/me'));
      assert.deepEqual([installed.authMethod, installed.installationId], ['github-app', 42]);
      assert.deepEqual({ token: own.notif, installation: installed.caps.notif }, { token: true, installation: false },
        'notifications are a person\'s own credential\'s to read, never an installation\'s');
      assert.deepEqual({ ...installed.caps, notif: true }, own, 'and everything else the two can do alike');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- An upload is scanned, held to this deployment's ceilings, and sent the way its size calls for ----
   * Replaces the hardening contract's check that the composition handed the
   * upload routes the platform's scanner and the workbench's upload scan, and
   * the upload-transport contract's that it handed them this deployment's four
   * ceilings. A file carrying a malware signature is refused, and GitHub is
   * asked nothing. The ceilings are set apart from each other -- 11 MB for a
   * blob, 41 MB for a native push and 42 MB for an upload, beside the Git Data
   * API's fixed 40 MB -- and each is asked from both sides. A declared length
   * one byte over a route's ceiling is refused before any of it is read; a body
   * exactly at it is taken. The transport a file goes by shows in what GitHub
   * is asked first: the Git Data API up to its 40 MB, a native push up to the
   * push ceiling, Git LFS above it.
   */
  {
    const MB = 1024 * 1024;
    const head = 'c'.repeat(40);
    const blobSha = 'b'.repeat(40);
    const commitSha = 'f'.repeat(40);
    const application = await composedApplication({ ...BASE, NV_GIT_DATA_MAX_MB: '11', NV_NATIVE_PUSH_MAX_MB: '41', NV_UPLOAD_MAX_MB: '42' });
    const github = standInForOutbound([
      ['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
      ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
      ['POST /repos/acme/demo/git/blobs$', { status: 201, body: { sha: blobSha } }],
      ['GET /repos/acme/demo/git/ref/heads/main$', { body: { ref: 'refs/heads/main', object: { sha: head, type: 'commit' } } }],
      [`GET /repos/acme/demo/git/commits/${head}$`, { body: { sha: head, tree: { sha: 'd'.repeat(40) } } }],
      ['GET /repos/acme/demo/git/trees/', { body: { sha: 'd'.repeat(40), tree: [], truncated: false } }],
      ['POST /repos/acme/demo/git/trees$', { status: 201, body: { sha: 'e'.repeat(40) } }],
      ['POST /repos/acme/demo/git/commits$', { status: 201, body: { sha: commitSha } }],
      ['PATCH /repos/acme/demo/git/refs/heads/main$', { body: { object: { sha: commitSha } } }],
      ['GET //github.com/acme/demo\\.git/info/refs\\?service=git-receive-pack$', { status: 409, body: { message: 'stood in for: a native push' } }],
      ['POST //github.com/acme/demo\\.git/info/lfs/objects/batch$', { status: 422, body: { message: 'stood in for: Git LFS' } }]
    ]);
    try {
      const page = browser(application);
      await page.signIn(`ghp_${'z'.repeat(36)}`);
      const csrf = await page.csrf();
      const headers = { 'x-nv-csrf': csrf };
      /* What GitHub is asked while one request is answered, past the account's permission, which every write resolves first. */
      const asking = async send => {
        const from = github.requests.length;
        const response = await send();
        /* A declared length alone is answered with a status, or with null when nothing is answered. */
        const answer = response === null || typeof response === 'number' ? { status: response } : { status: response.status, body: await bodyOf(response) };
        const asked = github.requests.slice(from).map(request => `${request.method} ${request.url}`).filter(line => !/\/collaborators\/octo\/permission$/.test(line));
        return { ...answer, asked };
      };
      const upload = (name, bytes) => page.request(`/api/repo/acme/demo/upload?path=${encodeURIComponent(name)}&branch=main`, { method: 'POST', body: bytes, headers });
      const blob = bytes => page.request('/api/repo/acme/demo/blob?path=docs%2Fbatch.bin', { method: 'POST', body: bytes, headers });
      const sized = bytes => Buffer.alloc(bytes);

      const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
      for (const [route, send] of [['upload', () => upload('docs/sample.txt', EICAR)], ['blob', () => blob(EICAR)]]) {
        const scanned = await asking(send);
        assert.deepEqual([scanned.status, scanned.body.code, scanned.asked], [422, 'MALWARE_DETECTED', []],
          `a file with a malware signature is refused by the ${route} route, and GitHub is asked nothing`);
      }

      const overBlob = await asking(() => page.declare('/api/repo/acme/demo/blob?path=docs%2Fbatch.bin', 11 * MB + 1, { headers }));
      assert.deepEqual([overBlob.status, overBlob.asked], [413, []], 'a blob declared one byte over NV_GIT_DATA_MAX_MB is refused before it is read');
      const atBlob = await asking(() => blob(sized(11 * MB)));
      assert.deepEqual([atBlob.status, atBlob.body.sha, atBlob.body.size, atBlob.asked], [200, blobSha, 11 * MB, ['POST https://api.github.com/repos/acme/demo/git/blobs']],
        'and one exactly at it is taken');

      const overUpload = await asking(() => page.declare('/api/repo/acme/demo/upload?path=docs%2Fbig.bin&branch=main', 42 * MB + 1, { headers }));
      assert.deepEqual([overUpload.status, overUpload.asked], [413, []], 'an upload declared one byte over NV_UPLOAD_MAX_MB is refused before it is read');

      const gitData = await asking(() => upload('docs/forty.bin', sized(40 * MB)));
      assert.deepEqual([gitData.status, gitData.body.size, gitData.body.strategy, gitData.body.commit], [200, 40 * MB, 'git-data-api', commitSha],
        'a file at the Git Data API\'s 40 MB is committed through it');
      assert.equal(gitData.asked[0], 'POST https://api.github.com/repos/acme/demo/git/blobs');

      const nativePush = await asking(() => upload('docs/forty-one.bin', sized(41 * MB)));
      assert.deepEqual([nativePush.status, nativePush.asked], [409, ['GET https://github.com/acme/demo.git/info/refs?service=git-receive-pack']],
        'one over it, and at the native push ceiling, is pushed natively (and GitHub\'s refusal of the push is the answer)');

      const lfs = await asking(() => upload('docs/forty-two.bin', sized(42 * MB)));
      assert.deepEqual([lfs.status, lfs.asked], [502, ['POST https://github.com/acme/demo.git/info/lfs/objects/batch']],
        'and one over that, exactly at NV_UPLOAD_MAX_MB, is taken and goes by Git LFS');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- A failure is answered one way, whichever module's route fails ----
   * Replaces the public-error contract's checks that the composition loads
   * the central failure answer and hands it, and nothing else under its name,
   * to every route that takes one (test/composition-root.test.js holds the
   * second over the root's syntax tree). GitHub fails under three routes
   * registered in three places -- the repository list, the workbench's
   * CODEOWNERS and the platform's rate -- and each failure is answered with
   * the central public error body: what failed, a code, the request's
   * correlation id, whether the provider changed, the safe state and the next
   * action. GitHub's words pass through only when they carry nothing that
   * looks like a credential; these do, and are not repeated.
   */
  {
    const application = await composedApplication({ ...BASE });
    const internal = 'stood-in-internal-detail';
    const github = standInForOutbound([
      ['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
      ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
      ['GET /user/repos\\?', { status: 500, body: { message: `authorization: Bearer ${internal}` } }],
      ['GET /repos/acme/demo/contents/', { status: 500, body: { message: `authorization: Bearer ${internal}` } }],
      ['GET /rate_limit$', { status: 500, body: { message: `authorization: Bearer ${internal}` } }]
    ]);
    try {
      const page = browser(application);
      await page.signIn(`ghp_${'z'.repeat(36)}`);
      const answers = {};
      for (const route of ['/api/repos', '/api/repo/acme/demo/codeowners', '/api/rate']) {
        const correlation = `nvx-${crypto.randomBytes(8).toString('hex')}`;
        const failed = await page.request(route, { headers: { [CORRELATION_HEADER]: correlation } });
        const body = await bodyOf(failed);
        answers[route] = [failed.status >= 500, Object.keys(body).sort(), body.correlationId === correlation, JSON.stringify(body).includes(internal)];
      }
      const central = [true, ['code', 'correlationId', 'error', 'nextAction', 'providerChanged', 'safeState'], true, false];
      assert.deepEqual(answers, { '/api/repos': central, '/api/repo/acme/demo/codeowners': central, '/api/rate': central },
        'each failure is the central answer, for this request, and repeats nothing that looks like a credential');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- The release and the capabilities the server answers are the package's and the registry's ----
   * Replaces verify.js's check that the server loads the package-backed
   * version module, and the capability registry contract's that it loads the
   * registry and keeps no capability table of its own. A signed-in account is
   * told the release package.json names; the capabilities answered for GitHub
   * are the registry document's, as the registry projects them for this
   * deployment.
   */
  {
    const application = await composedApplication({ ...BASE });
    const github = standInForOutbound([['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }]]);
    try {
      const page = browser(application);
      await page.signIn(`ghp_${'z'.repeat(36)}`);
      assert.equal((await bodyOf(await page.request('/api/me'))).release, require('../package.json').version, 'the release is the package\'s');
      const registry = require('../src/capability-registry.js');
      const { DEPLOYMENT_PROFILE } = require('../apps/api/src/composition/configuration.ts');
      const document = registry.loadCapabilityDocument(path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json'));
      const expected = registry.projectCapabilities(document, { provider: 'github', authority: 'github.com', deployment: DEPLOYMENT_PROFILE });
      assert.deepEqual(await bodyOf(await page.request('/api/capabilities?provider=github')), JSON.parse(JSON.stringify(expected)),
        'the capabilities are the registry\'s, for this deployment');
    } finally {
      github.restore();
      await application.close();
    }
  }

  /*
   * ---- A production snapshot signing secret that is the session secret is refused ----
   * Replaces the key derivation test's check that the composition hands the
   * snapshot signing configuration the session secret as it is: the refusal
   * compares the two, so it must be given the secret itself, not a key derived
   * from it. A production deployment is composed as configured; with its
   * snapshot secret set to its session secret, it is refused.
   */
  {
    const production = {
      NODE_ENV: 'production', SESSION_SECRET: SECRET, NV_SNAPSHOT_SIGNING_KEY_ID: 'composition-snapshot-key', NV_SNAPSHOT_SIGNING_SECRET: 'k'.repeat(48),
      DATABASE_URL: 'postgresql://composition@db.nebula.invalid:5432/nv?sslmode=verify-full', PUBLIC_BASE_URL: 'https://nebula.example.com'
    };
    const configured = await composedApplication(production, { listen: false });
    await configured.close();
    await assert.rejects(composedApplication({ ...production, NV_SNAPSHOT_SIGNING_SECRET: SECRET }, { listen: false }),
      /NV_SNAPSHOT_SIGNING_SECRET must differ from SESSION_SECRET/, 'a snapshot secret that is the session secret is refused');
  }

  /*
   * ---- The workbench's transports write only inside a mutation ----
   * Replaces the mutation gateway contract's checks that the composition
   * handed the native push and the LFS upload the gateway's check. Each writes
   * to GitHub outside its REST client, so each asks the gateway itself before
   * it writes, and the gateway answers only inside a request's mutation.
   * Called as composed, outside any request, each is refused before GitHub is
   * asked anything.
   */
  {
    const application = await composedApplication({ ...BASE }, { listen: false });
    const github = standInForOutbound([]);
    const file = path.join(os.tmpdir(), `nv-composition-${process.pid}`);
    fs.writeFileSync(file, 'outside any mutation');
    try {
      const account = { provider: 'github', authMethod: 'token', login: 'octo', baseUrl: '', token: `ghp_${'z'.repeat(36)}` };
      const { nativePush, lfsTransfer } = application.work.transports;
      for (const [transport, write] of [
        ['native push', () => nativePush.push(account, 'acme', 'demo', 'main', 'docs/outside.bin', file, 'Outside any mutation')],
        ['LFS upload', () => lfsTransfer.upload(account, 'acme', 'demo', 'main', 'docs/outside.bin', file, 'a'.repeat(64), 20, 'Outside any mutation')]
      ]) {
        await assert.rejects(write(), error => error.code === 'MUTATION_GATEWAY_REQUIRED', `the ${transport} is refused outside a mutation`);
      }
      assert.deepEqual(github.requests, [], 'and GitHub is asked nothing');
    } finally {
      fs.rmSync(file, { force: true });
      github.restore();
      await application.close();
    }
  }

  console.log('composition tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
