'use strict';

const assert = require('assert');
const { resolveProviderAccount } = require('../src/provider-credentials');

(async () => {
  for (const account of [
    { provider: 'github', authMethod: 'token', login: 'alice', token: 'ghp_a' },
    { provider: 'github', authMethod: 'oauth', login: 'alice', token: 'gho_a' }
  ]) {
    const resolved = await resolveProviderAccount(account, {});
    assert.notStrictEqual(resolved, account);
    assert.deepStrictEqual(resolved, account);
  }

  for (const provider of ['gitlab', 'gitea']) {
    let brokerCalls = 0;
    await assert.rejects(resolveProviderAccount({
      provider, authMethod: 'token', login: 'alice', token: 'retired-token'
    }, { githubAppBroker: { resolveInstallationAccount() { brokerCalls++; } } }),
    error => error.code === 'PROVIDER_ACCOUNT_INVALID');
    assert.strictEqual(brokerCalls, 0, 'retired providers are rejected before credential resolution');
  }

  const stored = { provider: 'github', authMethod: 'github-app', login: 'nebula-org', installationId: 77 };
  let passed;
  const resolved = await resolveProviderAccount(stored, {
    githubAppBroker: {
      async resolveInstallationAccount(account) {
        passed = account;
        return { ...account, token: 'ghs_ephemeral' };
      }
    }
  });
  assert.strictEqual(passed, stored);
  assert.strictEqual(resolved.token, 'ghs_ephemeral');
  assert.strictEqual(stored.token, undefined);

  await assert.rejects(resolveProviderAccount(stored, {}), /broker/i);
  await assert.rejects(resolveProviderAccount(null, {}), /account/i);
  await assert.rejects(resolveProviderAccount({ provider: 'github', authMethod: 'token', login: 'alice' }, {}), /credential/i);
  console.log('provider credential tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
