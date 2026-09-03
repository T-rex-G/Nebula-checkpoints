'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadGithubAppConfig } = require('../src/config');
const {
  GithubAppError,
  createGithubAppJwt,
  createGithubAppState,
  verifyGithubAppState,
  GithubAppBroker
} = require('../src/github-app');

function response(status, body) {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

(async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const escapedPem = String(pem).replace(/\n/g, '\\n');
  const clientSecret = ['client', 'secret', 'value'].join('-');
  const webhookSecret = ['webhook', 'secret', 'value'].join('-');

  assert.deepStrictEqual(loadGithubAppConfig({}, { production: false }), { enabled: false });
  assert.throws(() => loadGithubAppConfig({ GITHUB_APP_ID: '10' }, { production: false }), /incomplete/i);
  assert.throws(() => loadGithubAppConfig({
    GITHUB_APP_ID: '10', GITHUB_APP_SLUG: 'nebula-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: escapedPem,
    GITHUB_APP_CALLBACK_URL: 'http://example.com/api/github-app/oauth/callback'
  }, { production: true }), /https/i);
  assert.throws(() => loadGithubAppConfig({
    GITHUB_APP_ID: '10', GITHUB_APP_SLUG: 'nebula-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: escapedPem,
    GITHUB_APP_CALLBACK_URL: 'https://nebula.example/api/github-app/oauth/callback?next=unsafe'
  }, { production: true }), /query/i);

  const config = loadGithubAppConfig({
    GITHUB_APP_ID: '10', GITHUB_APP_SLUG: 'nebula-test', GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_CLIENT_SECRET: clientSecret, GITHUB_APP_PRIVATE_KEY: escapedPem,
    GITHUB_APP_CALLBACK_URL: 'https://nebula.example/api/github-app/oauth/callback',
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret
  }, { production: true });
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.privateKey.includes('BEGIN PRIVATE KEY'), true);
  assert.strictEqual(config.setupUrl, 'https://nebula.example/api/github-app/setup');
  assert.strictEqual(config.webhookConfigured, true);

  const now = Date.UTC(2026, 6, 21, 22, 0, 0);
  const jwt = createGithubAppJwt(config, { now });
  const [encodedHeader, encodedPayload, signature] = jwt.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
  assert.strictEqual(claims.iss, '10');
  assert(claims.iat <= Math.floor(now / 1000));
  assert(claims.exp - Math.floor(now / 1000) <= 600);
  assert(crypto.verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(signature, 'base64url')));

  const stateSecret = 'state-secret-0123456789abcdef-state-secret-0123456789';
  const context = { purpose: 'user-auth', sessionBinding: 'session-a', identityKey: 'identity-a' };
  const state = createGithubAppState(stateSecret, context, { now, ttlMs: 600000, nonce: 'nonce-a' });
  const verified = verifyGithubAppState(stateSecret, state, context, { now: now + 1000 });
  assert.strictEqual(verified.nonce, 'nonce-a');
  assert.throws(() => verifyGithubAppState(stateSecret, `${state}x`, context, { now }), /signature|malformed/i);
  assert.throws(() => verifyGithubAppState(stateSecret, state, { ...context, identityKey: 'identity-b' }, { now }), /context/i);
  assert.throws(() => verifyGithubAppState(stateSecret, state, context, { now: now + 600001 }), /expired/i);

  let currentTime = now;
  const calls = [];
  let tokenCounter = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', authorization: options.headers && options.headers.Authorization, signal: options.signal });
    if (String(url).endsWith('/app/installations/77')) {
      return response(200, {
        id: 77, app_id: 10, account: { login: 'nebula-org', id: 501, type: 'Organization', avatar_url: 'https://avatars.example/1' },
        repository_selection: 'selected', permissions: { contents: 'write', pull_requests: 'write' }, suspended_at: null,
        html_url: 'https://github.com/organizations/nebula-org/settings/installations/77'
      });
    }
    if (String(url).endsWith('/app/installations/77/access_tokens')) {
      tokenCounter += 1;
      return response(201, { token: `ghs_secret_${tokenCounter}`, expires_at: new Date(currentTime + 3600000).toISOString() });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const audits = [];
  const broker = new GithubAppBroker(config, { fetchImpl, now: () => currentTime, audit: event => audits.push(event) });
  const stored = { provider: 'github', authMethod: 'github-app', login: 'nebula-org', installationId: 77, installationAccountId: 501, authorizedByIdentityKey: 'github:first-authorizer' };
  const [resolvedA, resolvedB] = await Promise.all([
    broker.resolveInstallationAccount(stored), broker.resolveInstallationAccount(stored)
  ]);
  assert.notStrictEqual(resolvedA, stored);
  assert.strictEqual(stored.token, undefined);
  assert.strictEqual(resolvedA.token, 'ghs_secret_1');
  assert.strictEqual(resolvedB.token, 'ghs_secret_1');
  assert.strictEqual(resolvedA.installation.id, 77, 'resolved account must include fresh sanitized installation evidence');
  assert(Object.isFrozen(resolvedA.installation) && Object.isFrozen(resolvedA.installation.permissions));
  assert.strictEqual(tokenCounter, 1, 'concurrent resolution must coalesce');
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(JSON.stringify(audits).includes('ghs_secret'), false);

  const cached = await broker.resolveInstallationAccount(stored);
  assert.strictEqual(cached.token, 'ghs_secret_1');
  assert.strictEqual(tokenCounter, 1, 'valid cached token must be reused');

  const secondIdentity = await broker.resolveInstallationAccount({
    ...stored, authorizedByIdentityKey: 'github:second-authorizer'
  });
  assert.strictEqual(secondIdentity.token, 'ghs_secret_2');
  assert.strictEqual(tokenCounter, 2, 'installation credentials must not be reused across authorizing identities');

  currentTime += 3545000;
  const refreshed = await broker.resolveInstallationAccount(stored);
  assert.strictEqual(refreshed.token, 'ghs_secret_3');
  assert.strictEqual(tokenCounter, 3, 'token inside the refresh margin must be replaced');
  assert(broker.invalidate(77));
  assert.strictEqual(broker.cacheSize(), 0);

  let raceMintCount = 0;
  const raceReleases = new Map();
  const raceWaiters = [];
  const waitForRaceMint = count => raceMintCount >= count ? Promise.resolve() : new Promise(resolve => raceWaiters.push({ count, resolve }));
  const invalidationRaceBroker = new GithubAppBroker(config, {
    now: () => now,
    fetchImpl: async url => {
      if (String(url).endsWith('/app/installations/99')) return response(200, {
        id: 99, app_id: 10, account: { login: 'race-org', id: 99, type: 'Organization' },
        repository_selection: 'selected', permissions: { contents: 'read' }, suspended_at: null
      });
      if (String(url).endsWith('/app/installations/99/access_tokens')) {
        raceMintCount += 1;
        for (const waiter of raceWaiters.splice(0)) {
          if (raceMintCount >= waiter.count) waiter.resolve(); else raceWaiters.push(waiter);
        }
        const mintNumber = raceMintCount;
        return new Promise(resolve => { raceReleases.set(mintNumber, () => resolve(response(201, {
          token: `ghs_race_token_${mintNumber}`, expires_at: new Date(now + 3600000).toISOString()
        }))); });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  const raceAccount = {
    provider: 'github', authMethod: 'github-app', login: 'race-org', installationId: 99, installationAccountId: 99,
    authorizedByIdentityKey: 'github:race-authorizer'
  };
  const oldResolution = invalidationRaceBroker.resolveInstallationAccount(raceAccount);
  await waitForRaceMint(1);
  invalidationRaceBroker.invalidate(99);
  const newResolutionA = invalidationRaceBroker.resolveInstallationAccount(raceAccount);
  const newResolutionB = invalidationRaceBroker.resolveInstallationAccount(raceAccount);
  await waitForRaceMint(2);
  raceReleases.get(1)();
  await assert.rejects(
    oldResolution,
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_CREDENTIAL_INVALIDATED'
  );
  const newResolutionC = invalidationRaceBroker.resolveInstallationAccount(raceAccount);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(raceMintCount, 2, 'an invalidated request must not delete a newer in-flight refresh');
  raceReleases.get(2)();
  const raceResults = await Promise.all([newResolutionA, newResolutionB, newResolutionC]);
  assert(raceResults.every(result => result.token === 'ghs_race_token_2'));
  assert.strictEqual(invalidationRaceBroker.cacheSize(), 1);

  await assert.rejects(
    broker.resolveInstallationAccount({ provider: 'github', authMethod: 'github-app', login: 'nebula-org', installationId: 77 }),
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_ACCOUNT_INVALID'
  );

  const mismatchBroker = new GithubAppBroker(config, {
    now: () => now,
    fetchImpl: async url => {
      if (String(url).endsWith('/app/installations/77')) return response(200, {
        id: 77, app_id: 10, account: { login: 'nebula-org', id: 501, type: 'Organization' },
        repository_selection: 'selected', permissions: { contents: 'write' }, suspended_at: null
      });
      if (String(url).endsWith('/app/installations/77/access_tokens')) return response(201, {
        token: 'ghs_mismatch_token', expires_at: new Date(now + 3600000).toISOString()
      });
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  await assert.rejects(
    mismatchBroker.resolveInstallationAccount({
      provider: 'github', authMethod: 'github-app', login: 'different-org', installationId: 77,
      installationAccountId: 999, authorizedByIdentityKey: 'github:mismatch-authorizer'
    }),
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_ACCOUNT_MISMATCH'
  );
  assert.strictEqual(mismatchBroker.cacheSize(), 0);

  const suspendedFetch = async url => {
    if (String(url).endsWith('/app/installations/88')) return response(200, {
      id: 88, app_id: 10, account: { login: 'suspended-org', id: 9, type: 'Organization' },
      repository_selection: 'all', permissions: {}, suspended_at: '2026-07-21T20:00:00Z'
    });
    throw new Error('token endpoint must not be reached for suspended installation');
  };
  const suspended = new GithubAppBroker(config, { fetchImpl: suspendedFetch, now: () => now });
  await assert.rejects(
    suspended.resolveInstallationAccount({ provider: 'github', authMethod: 'github-app', login: 'suspended-org', installationId: 88, installationAccountId: 9, authorizedByIdentityKey: 'github:suspension-authorizer' }),
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_INSTALLATION_SUSPENDED'
  );

  assert(calls.every(call => call.signal instanceof AbortSignal), 'every GitHub App request must have a timeout signal');
  assert(calls.every(call => !call.url.includes('client-secret-value') && !call.url.includes('ghs_secret')));
  console.log('github app unit tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
