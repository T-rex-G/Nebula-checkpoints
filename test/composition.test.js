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
const { composedApplication } = require('./helpers/composed-application');

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
    const application = await composedApplication(BASE);
    const ownFetch = globalThis.fetch;
    const outbound = [];
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith(application.url)) {
        outbound.push(String(url));
        return new Response('', { status: 599 });
      }
      return ownFetch(url, options);
    };
    try {
      const stylesheet = await ownFetch(`${application.url}/gfonts/css2?family=Inter:wght@400;700&display=swap`);
      assert.doesNotMatch(String(stylesheet.headers.get('content-type')), /text\/css/, 'the former stylesheet proxy serves no stylesheet');
      await stylesheet.arrayBuffer();
      const font = await ownFetch(`${application.url}/gstatic/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2`);
      assert.equal(font.status, 404, 'the former font proxy serves no font');
      await font.arrayBuffer();
      assert.deepEqual(outbound, [], 'and neither reaches Google');
    } finally {
      globalThis.fetch = ownFetch;
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
    const application = await composedApplication({ ...BASE, NV_UPLOAD_MAX_MB: '300', NV_GIT_DATA_MAX_MB: '33', NV_NATIVE_PUSH_MAX_MB: '44' });
    const ownFetch = globalThis.fetch;
    const outbound = [];
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith(application.url)) {
        outbound.push(String(url));
        return new Response('', { status: 599 });
      }
      return ownFetch(url, options);
    };
    try {
      const published = await (await ownFetch(`${application.url}/api/config`)).json();
      const MB = 1024 * 1024;
      const { limits, settings } = application.settings;
      assert.deepEqual(
        { uploadMaxMb: published.uploadMaxMb, gitDataMaxMb: published.gitDataMaxMb, nativePushMaxMb: published.nativePushMaxMb, contentsMaxMb: published.contentsMaxMb },
        { uploadMaxMb: 300, gitDataMaxMb: 33, nativePushMaxMb: 44, contentsMaxMb: limits.contentsMax / MB },
        'the page is told the ceilings this deployment holds, the Git Data boundary among them'
      );
      assert.equal(limits.uploadMax, settings.uploadMaxMb * MB, 'and the ceiling the server holds is the one it publishes');

      const file = 'codemirror/5.65.16/codemirror.min.js';
      const served = await ownFetch(`${application.url}/vendor/${file}`);
      assert.equal(served.status, 200);
      const pinned = require('node:fs').readFileSync(require('node:path').join(application.release.root, 'public', 'vendor', file));
      assert(Buffer.from(await served.arrayBuffer()).equals(pinned), 'a pinned library is served from the release\'s own copy');

      const readiness = await ownFetch(`${application.url}/readyz`);
      assert.deepEqual([readiness.status, await readiness.json()], [200, { ok: true, database: 'optional-not-configured' }],
        'readiness says no database is configured, rather than that one is down');
      assert.deepEqual(outbound, [], 'none of it reaches past this origin');
    } finally {
      globalThis.fetch = ownFetch;
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
    const application = await composedApplication(BASE, { listen: false });
    const ownFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET', authorization: new Headers(options.headers || {}).get('authorization') });
      const body = /\/permission$/.test(String(url))
        ? { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } }
        : { full_name: 'acme/demo' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');
      const token = `ghp_${'c'.repeat(36)}`;
      const account = Object.freeze({ provider: 'github', login: 'octo', id: 7, token, authMethod: 'token' });
      await assert.rejects(
        application.core.github.gh(account, '/repos/acme/demo/contents/notes.md', { method: 'PUT', body: { message: 'write', content: 'eA==' } }),
        error => error.code === 'MUTATION_GATEWAY_REQUIRED',
        'a write with no mutation in progress is the gateway\'s to refuse'
      );
      assert.deepEqual(requests, [], 'and nothing leaves the server');

      await application.core.github.gh(account, '/repos/acme/demo');
      assert.deepEqual(requests, [{ url: 'https://api.github.com/repos/acme/demo', method: 'GET', authorization: `Bearer ${token}` }],
        'a read goes to GitHub with the account\'s credential');

      requests.length = 0;
      const snapshot = await application.core.authorizationResolver.resolve({ account, owner: 'acme', repo: 'demo', actorIdentityKey: identityKey(account) });
      assert.deepEqual(requests, [{ url: 'https://api.github.com/repos/acme/demo/collaborators/octo/permission', method: 'GET', authorization: `Bearer ${token}` }],
        'the resolver asks GitHub for the account\'s permission, with the account\'s own credential');
      assert.equal(snapshot.scope.scopeKey, 'github:github.com:acme/demo');
      assert.equal(snapshot.executionPrincipal.login, 'octo');
    } finally {
      globalThis.fetch = ownFetch;
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
    const ownFetch = globalThis.fetch;
    const appRequests = [];
    let local = '';
    globalThis.fetch = async (url, options = {}) => {
      if (local && String(url).startsWith(local)) return ownFetch(url, options);
      appRequests.push({ url: String(url), method: options.method || 'GET', authorization: new Headers(options.headers || {}).get('authorization') });
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (/\/app\/installations\/42$/.test(String(url))) return json({ id: 42, app_id: 123, account: { login: 'acme', id: 9, type: 'Organization' }, repository_selection: 'selected', permissions: { contents: 'write' } });
      if (/\/app\/installations\/42\/access_tokens$/.test(String(url))) return json({ token: `ghs_${'i'.repeat(36)}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
      return json({ message: 'unexpected' }, 404);
    };
    try {
      const without = await composedApplication(BASE);
      try {
        local = without.url;
        assert.deepEqual((await (await fetch(`${without.url}/api/config`)).json()).githubApp, { enabled: false, webhookConfigured: false },
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
        local = configured.url;
        assert.deepEqual((await (await fetch(`${configured.url}/api/config`)).json()).githubApp, { enabled: true, webhookConfigured: true },
          'with them, the page is told the App and its webhook are configured');
        console.log = (...line) => logged.push(line.join(' '));
        const resolved = await configured.core.resolveAccount(appAccount);
        console.log = ownLog;
        assert.equal(resolved.token, `ghs_${'i'.repeat(36)}`, 'an App account\'s credential is the installation token the broker minted');
        assert.deepEqual(appRequests.map(request => `${request.method} ${request.url}`), [
          'GET https://api.github.com/app/installations/42',
          'POST https://api.github.com/app/installations/42/access_tokens'
        ]);
        for (const request of appRequests) {
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
      globalThis.fetch = ownFetch;
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

  console.log('composition tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
