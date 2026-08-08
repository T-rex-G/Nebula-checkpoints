'use strict';

class ProviderCredentialError extends Error {
  constructor(message, code, status = 401) {
    super(message);
    this.name = 'ProviderCredentialError';
    this.code = code;
    this.status = status;
  }
}

async function resolveProviderAccount(account, dependencies = {}) {
  if (!account || typeof account !== 'object') {
    throw new ProviderCredentialError('A provider account is required', 'PROVIDER_ACCOUNT_INVALID');
  }
  const provider = String(account.provider || 'github');
  const authMethod = String(account.authMethod || 'token');
  const login = String(account.login || '').trim();
  if (!login || !['github', 'gitlab', 'gitea'].includes(provider)) {
    throw new ProviderCredentialError('Provider account identity is invalid', 'PROVIDER_ACCOUNT_INVALID');
  }
  if (provider === 'github' && authMethod === 'github-app') {
    const broker = dependencies.githubAppBroker;
    if (!broker || typeof broker.resolveInstallationAccount !== 'function') {
      throw new ProviderCredentialError('GitHub App credential broker is unavailable', 'GITHUB_APP_BROKER_UNAVAILABLE', 503);
    }
    const resolved = await broker.resolveInstallationAccount(account);
    if (!resolved || typeof resolved !== 'object' || !String(resolved.token || '')) {
      throw new ProviderCredentialError('GitHub App credential broker returned no credential', 'GITHUB_APP_CREDENTIAL_UNAVAILABLE', 503);
    }
    return { ...resolved };
  }
  const token = String(account.token || '');
  if (!token) throw new ProviderCredentialError('Provider account credential is unavailable', 'PROVIDER_CREDENTIAL_UNAVAILABLE');
  return { ...account };
}

module.exports = { ProviderCredentialError, resolveProviderAccount };
