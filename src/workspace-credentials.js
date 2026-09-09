'use strict';

const { verifiedHumanIdentity, workspaceError } = require('./workspace-identity');

function bindingFields(binding) {
  return {
    sessionHash: binding.sessionHash, principalId: binding.principalId,
    workspaceId: binding.workspaceId, connectionId: binding.connection.id,
    provider: binding.connection.provider, instance: binding.connection.instance,
    providerUserId: binding.connection.providerUserId
  };
}

function matchesAccount(account, connection) {
  try {
    const identity = verifiedHumanIdentity(account);
    return typeof account.token === 'string' && account.token.length > 0 && account.token.length <= 4096
      && identity.provider === connection.provider && identity.instance === connection.instance
      && identity.providerUserId === connection.providerUserId;
  } catch { return false; }
}

function sealWorkspaceCredential(account, binding, seal) {
  if (typeof seal !== 'function' || !matchesAccount(account, binding.connection)) {
    throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
  }
  // Allowlist the credential envelope; never copy arbitrary provider responses.
  const credential = {
    provider: account.provider, baseUrl: account.baseUrl || '', token: account.token,
    providerAccountId: account.providerAccountId, login: String(account.login || ''), authMethod: 'token'
  };
  return seal({ kind: 'workspace-credential/v1', binding: bindingFields(binding), credential });
}

function openWorkspaceCredential(ciphertext, binding, unseal) {
  let value;
  try { value = typeof unseal === 'function' ? unseal(ciphertext) : null; } catch { value = null; }
  const expected = bindingFields(binding);
  if (value?.kind !== 'workspace-credential/v1' || !value.binding
    || Object.keys(expected).some(key => value.binding[key] !== expected[key])
    || !matchesAccount(value.credential, binding.connection)) {
    throw workspaceError('WORKSPACE_CREDENTIAL_REQUIRED', 401);
  }
  return value.credential;
}

module.exports = { sealWorkspaceCredential, openWorkspaceCredential };
