'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { verifiedHumanIdentity, workspaceError } = require('../src/workspace-identity');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('async function verifyWorkspaceAccount(input) {');
const end = source.indexOf('async function disconnectAlphaProviderAccount', start);
assert(start > 0 && end > start);
let verifiedAccount, upstream = { id: 42, login: 'actual-user', type: 'User' }, validations = 0;
let listed = 0, capabilityChecked = 0;
const context = vm.createContext({
  verifiedHumanIdentity, workspaceError, ALPHA_CONFIG: { enabled: true },
  assertPublicBase: async base => { validations++; if (base.includes('private.example')) throw new Error('blocked host'); return base; },
  providerIdentity: async account => { verifiedAccount = account; if (upstream instanceof Error) throw upstream; return upstream; },
  stableProviderIdentityKey: () => 'a'.repeat(64), identityKey: () => 'b'.repeat(64),
  assertProviderCapability: (account, feature) => { assert.strictEqual(feature, 'repository.read'); capabilityChecked++; },
  gh: async (account, route, options) => {
    listed++; assert(route.startsWith('/user/repos?')); assert.strictEqual(options, undefined, 'repository listing must use GET');
    return [{ name: 'private', full_name: 'actual-user/private', private: true, default_branch: 'main', secret: 'must-not-be-projected' }];
  }
});
const verify = vm.runInContext(source.slice(start, end) + '\nverifyWorkspaceAccount;', context);
(async () => {
  const result = await verify({ token: 'test-credential', providerAccountId: 999, principalId: 'forged' });
  assert.strictEqual(result.identity.providerUserId, '42', 'only the upstream /user ID may bind the human');
  assert.strictEqual(verifiedAccount.token, 'test-credential');
  assert(!JSON.stringify(result).includes('test-credential'), 'only verified metadata leaves the adapter');
  assert.strictEqual(result.legacyIdentityKey, 'a'.repeat(64));
  const connect = vm.runInContext('connectWorkspaceAccount', context);
  const connected = await connect({ provider: 'github', token: 'test-credential' });
  assert.strictEqual(connected.credential.token, 'test-credential', 'credential is retained only by the explicit connect adapter');
  assert.strictEqual(connected.credential.providerAccountId, 42);
  const list = vm.runInContext('listWorkspaceRepositories', context);
  const repositories = await list(connected.credential);
  assert.strictEqual(repositories.repositories[0].fullName, 'actual-user/private');
  assert(!JSON.stringify(repositories).includes('must-not-be-projected'));
  assert.strictEqual(capabilityChecked, 1);
  await assert.rejects(() => list({ provider: 'gitlab' }), { code: 'WORKSPACE_PROVIDER_UNSUPPORTED' });
  assert.strictEqual(listed, 1);
  await verify({ provider: 'gitea', token: 'test-credential', baseUrl: 'https://code.example/team' });
  assert.strictEqual(validations, 1, 'self-hosted verification must retain host validation');
  await assert.rejects(() => verify({ provider: 'gitea', token: 'test-credential', baseUrl: 'https://private.example' }), { code: 'WORKSPACE_PROVIDER_VERIFICATION_FAILED' });
  for (const input of [{ token: '' }, { token: 42 }, { provider: 'unsupported', token: 'x' }, { provider: 'github', token: 'x', baseUrl: 'https://other.example' }]) {
    await assert.rejects(() => verify(input), { code: 'WORKSPACE_INPUT_INVALID' });
  }
  for (const user of [{ id: 42, type: 'Bot' }, { id: 42, bot: true }, { login: 'no-stable-id' }, { id: '42' }]) {
    upstream = user;
    await assert.rejects(() => verify({ token: 'x' }), { code: 'WORKSPACE_HUMAN_IDENTITY_REQUIRED' });
  }
  upstream = Object.assign(new Error('provider response with private credential'), { status: 401 });
  await assert.rejects(() => verify({ token: 'x' }), error => error.code === 'WORKSPACE_PROVIDER_VERIFICATION_FAILED'
    && error.status === 401 && !error.message.includes('private credential'));
  console.log('workspace provider verification tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
