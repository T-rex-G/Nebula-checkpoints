'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadGithubAppConfig } = require('../src/config');
const { GithubAppBroker, GithubAppError } = require('../src/github-app');

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clientSecret = ['server-only', 'client-secret'].join('-');
  const config = loadGithubAppConfig({
    GITHUB_APP_ID: '42',
    GITHUB_APP_SLUG: 'nebula-test',
    GITHUB_APP_CLIENT_ID: 'Iv1.nebulatest',
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_APP_CALLBACK_URL: 'https://nebula.example/api/github-app/oauth/callback'
  }, { production: true });

  const requests = [];
  const installation = {
    id: 77,
    app_id: 42,
    account: { login: 'nebula-org', id: 501, type: 'Organization', avatar_url: 'https://avatars.example/501' },
    repository_selection: 'selected',
    permissions: { contents: 'write', pull_requests: 'write' },
    suspended_at: null,
    html_url: 'https://github.com/organizations/nebula-org/settings/installations/77'
  };
  const fetchImpl = async (url, options = {}) => {
    const record = { url: String(url), method: options.method || 'GET', headers: { ...(options.headers || {}) }, body: options.body || '', signal: options.signal };
    requests.push(record);
    if (record.url === 'https://github.com/login/oauth/access_token') {
      return json(200, { access_token: 'ghu_ephemeral_user_authorization', expires_in: 600, token_type: 'bearer' });
    }
    if (record.url === 'https://api.github.com/user') {
      assert.strictEqual(record.headers.Authorization, 'Bearer ghu_ephemeral_user_authorization');
      return json(200, { id: 9001, login: 'authorizer', name: 'Authorized User', avatar_url: 'https://avatars.example/9001' });
    }
    if (record.url === 'https://api.github.com/user/installations?per_page=100&page=1') {
      assert.strictEqual(record.headers.Authorization, 'Bearer ghu_ephemeral_user_authorization');
      return json(200, { total_count: 1, installations: [installation] });
    }
    throw new Error(`Unexpected URL ${record.url}`);
  };

  const broker = new GithubAppBroker(config, { fetchImpl });
  const state = 'signed-state-value';
  const authorizationUrl = new URL(broker.authorizationUrl(state));
  assert.strictEqual(authorizationUrl.origin, 'https://github.com');
  assert.strictEqual(authorizationUrl.pathname, '/login/oauth/authorize');
  assert.strictEqual(authorizationUrl.searchParams.get('client_id'), config.clientId);
  assert.strictEqual(authorizationUrl.searchParams.get('redirect_uri'), config.callbackUrl);
  assert.strictEqual(authorizationUrl.searchParams.get('state'), state);

  const installUrl = new URL(broker.installationUrl(state));
  assert.strictEqual(installUrl.origin, 'https://github.com');
  assert.strictEqual(installUrl.pathname, '/apps/nebula-test/installations/new');
  assert.strictEqual(installUrl.searchParams.get('state'), state);

  const exchange = await broker.exchangeUserCode('single-use-code');
  assert.deepStrictEqual(exchange, { token: 'ghu_ephemeral_user_authorization', expiresIn: 600 });
  const exchangeRequest = requests[0];
  assert.strictEqual(exchangeRequest.method, 'POST');
  const exchangeBody = JSON.parse(exchangeRequest.body);
  assert.deepStrictEqual(exchangeBody, {
    client_id: config.clientId,
    client_secret: clientSecret,
    code: 'single-use-code',
    redirect_uri: config.callbackUrl
  });
  assert(!exchangeRequest.url.includes(clientSecret));

  const user = await broker.getAuthorizedUser(exchange.token);
  assert.deepStrictEqual(user, {
    id: 9001, login: 'authorizer', name: 'Authorized User', avatarUrl: 'https://avatars.example/9001'
  });
  const claimed = await broker.findUserInstallation(exchange.token, 77);
  assert.strictEqual(claimed.id, 77);
  assert.strictEqual(claimed.account.login, 'nebula-org');
  assert.strictEqual(claimed.repositorySelection, 'selected');

  await assert.rejects(
    broker.findUserInstallation(exchange.token, 99),
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_INSTALLATION_OWNERSHIP'
  );
  await assert.rejects(
    broker.exchangeUserCode(''),
    error => error instanceof GithubAppError && error.code === 'GITHUB_APP_CODE_INVALID'
  );
  assert(requests.every(item => item.signal instanceof AbortSignal), 'user authorization requests must have timeout signals');
  const serialized = JSON.stringify({ user, claimed, requests: requests.map(item => ({ url: item.url, method: item.method })) });
  assert(!serialized.includes(clientSecret));
  assert(!serialized.includes('ghu_ephemeral_user_authorization'));
  console.log('github app user authorization flow tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
