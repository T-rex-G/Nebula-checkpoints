'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { sealWorkspaceCredential, openWorkspaceCredential } = require('../src/workspace-credentials');
const key = crypto.randomBytes(32);
const seal = data => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
};
const unseal = data => {
  try {
    const bytes = Buffer.from(data, 'base64url');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
  } catch { return null; }
};
const binding = {
  sessionHash: 'a'.repeat(64), principalId: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
  connection: { id: crypto.randomUUID(), provider: 'github', instance: 'https://github.com', providerUserId: '42' }
};
const account = { provider: 'github', providerAccountId: 42, login: 'verified-owner', token: 'synthetic-workspace-token', authMethod: 'token' };
const ciphertext = sealWorkspaceCredential(account, binding, seal);
assert(!ciphertext.includes(account.token));
assert.strictEqual(openWorkspaceCredential(ciphertext, binding, unseal).token, account.token);
for (const field of ['sessionHash', 'principalId', 'workspaceId']) {
  assert.throws(() => openWorkspaceCredential(ciphertext, { ...binding, [field]: 'different' }, unseal), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' });
}
for (const field of ['id', 'provider', 'instance', 'providerUserId']) {
  assert.throws(() => openWorkspaceCredential(ciphertext, { ...binding, connection: { ...binding.connection, [field]: 'different' } }, unseal), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' });
}
assert.throws(() => openWorkspaceCredential(ciphertext.slice(0, -4), binding, unseal), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' });
assert.throws(() => sealWorkspaceCredential({ ...account, providerAccountId: 43 }, binding, seal), { code: 'WORKSPACE_CONNECTION_REJECTED' });
assert.throws(() => sealWorkspaceCredential({ ...account, token: '' }, binding, seal), { code: 'WORKSPACE_CONNECTION_REJECTED' });
assert.throws(() => openWorkspaceCredential(seal({ kind: 'workspace-session/v1', token: account.token }), binding, unseal), { code: 'WORKSPACE_CREDENTIAL_REQUIRED' });
console.log('workspace credential binding tests passed');
