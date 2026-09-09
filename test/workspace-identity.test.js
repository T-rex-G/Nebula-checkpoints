'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { verifiedHumanIdentity, loadWorkspaceConfig, verifySetupSecret } = require('../src/workspace-identity');

const account = { provider: 'github', providerAccountId: 42, login: 'before', authMethod: 'token' };
const before = verifiedHumanIdentity(account);
const renamed = verifiedHumanIdentity({ ...account, login: 'after', token: 'ignored' });
assert.strictEqual(before.key, renamed.key, 'renames and credential rotation cannot change the person');
assert.strictEqual(renamed.login, 'after');
assert.notStrictEqual(before.key, verifiedHumanIdentity({ ...account, providerAccountId: 43 }).key);
assert(!JSON.stringify(renamed).includes('ignored'), 'identity projection must not contain a credential');
for (const invalid of [
  { ...account, providerAccountId: undefined }, { ...account, providerAccountId: -1 },
  { ...account, providerAccountId: Number.MAX_SAFE_INTEGER + 1 },
  { ...account, authMethod: 'github-app', installationId: 42 },
  { ...account, type: 'Bot' }, { ...account, bot: true }
]) assert.throws(() => verifiedHumanIdentity(invalid), { code: 'WORKSPACE_HUMAN_IDENTITY_REQUIRED' });

const gitea = { ...account, provider: 'gitea', baseUrl: 'https://CODE.example/team/' };
const canonical = verifiedHumanIdentity(gitea);
assert.strictEqual(canonical.instance, 'https://code.example/team');
assert.strictEqual(canonical.key, verifiedHumanIdentity({ ...gitea, baseUrl: 'https://code.example:443/team' }).key);
assert.notStrictEqual(canonical.key, verifiedHumanIdentity({ ...gitea, baseUrl: 'https://code.example/other' }).key);
assert.notStrictEqual(canonical.key, verifiedHumanIdentity({ ...gitea, provider: 'gitlab' }).key);
for (const baseUrl of ['https://user:password@code.example', 'https://code.example/?q=1', 'https://code.example/#x', 'http://code.example']) {
  assert.throws(() => verifiedHumanIdentity({ ...gitea, baseUrl }), { code: 'WORKSPACE_HUMAN_IDENTITY_REQUIRED' });
}
assert.strictEqual(verifiedHumanIdentity({ ...account, provider: 'gitlab' }).instance, 'https://gitlab.com');

const secret = crypto.randomBytes(32).toString('base64url');
const configEnv = {
  NV_WORKSPACE_FOUNDATION_ENABLED: '1',
  NV_WORKSPACE_SETUP_SHA256: crypto.createHash('sha256').update(secret).digest('hex'),
  NV_WORKSPACE_SETUP_EXPIRES_AT: '2030-01-01T00:00:00Z'
};
const config = loadWorkspaceConfig(configEnv, { databaseUrl: 'configured' });
assert.strictEqual(config.enabled, true);
assert(!JSON.stringify(config).includes(secret));
assert.strictEqual(verifySetupSecret(config, secret, Date.parse('2029-12-31T23:59:59Z')), true);
assert.strictEqual(verifySetupSecret(config, secret, Date.parse('2030-01-01T00:00:00Z')), false);
assert.strictEqual(verifySetupSecret(config, 'x'.repeat(43), 1), false);
assert.strictEqual(loadWorkspaceConfig({}).enabled, false);
assert.throws(() => loadWorkspaceConfig(configEnv), /DATABASE_URL/);
assert.throws(() => loadWorkspaceConfig({ ...configEnv, NV_WORKSPACE_SETUP_EXPIRES_AT: '' }, { databaseUrl: 'configured' }), /together/);
assert.throws(() => loadWorkspaceConfig({ ...configEnv, NV_WORKSPACE_SETUP_EXPIRES_AT: 'tomorrow' }, { databaseUrl: 'configured' }), /timestamp/);
assert.strictEqual(loadWorkspaceConfig({ NV_WORKSPACE_FOUNDATION_ENABLED: '1' }, { databaseUrl: 'configured' }).setupDigest, '',
  'claimed deployments may remove setup configuration and still sign in');
console.log('workspace identity tests passed');
