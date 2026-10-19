export class ProviderCredentialError extends Error {
  override readonly name = 'ProviderCredentialError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Fields = Readonly<Record<string, unknown>>;

/* Mints the installation credential a GitHub App account works with. */
export interface InstallationBroker {
  resolveInstallationAccount(account: Fields): Promise<unknown>;
}

export interface CredentialDependencies {
  readonly githubAppBroker?: Partial<InstallationBroker> | null;
}

/*
 * The account with the credential it works with: a personal token or OAuth
 * grant as stored, or an installation credential the broker mints. Nothing is
 * resolved for an account whose identity or method is not one the server
 * supports.
 */
export async function resolveProviderAccount(account: unknown, dependencies: CredentialDependencies = {}): Promise<Record<string, unknown>> {
  if (!account || typeof account !== 'object') {
    throw new ProviderCredentialError('A provider account is required', 'PROVIDER_ACCOUNT_INVALID');
  }
  const fields = account as Fields;
  const provider = String(fields.provider || 'github');
  const authMethod = String(fields.authMethod || 'token');
  const login = String(fields.login || '').trim();
  if (!login || !['github'].includes(provider)) {
    throw new ProviderCredentialError('Provider account identity is invalid', 'PROVIDER_ACCOUNT_INVALID');
  }
  if (provider === 'github' && authMethod === 'github-app') {
    const broker = dependencies.githubAppBroker;
    if (!broker || typeof broker.resolveInstallationAccount !== 'function') {
      throw new ProviderCredentialError('GitHub App credential broker is unavailable', 'GITHUB_APP_BROKER_UNAVAILABLE', 503);
    }
    const resolved = await broker.resolveInstallationAccount(fields);
    if (!resolved || typeof resolved !== 'object' || !String((resolved as Fields).token || '')) {
      throw new ProviderCredentialError('GitHub App credential broker returned no credential', 'GITHUB_APP_CREDENTIAL_UNAVAILABLE', 503);
    }
    return { ...resolved };
  }
  if (!['token', 'oauth'].includes(authMethod)) {
    throw new ProviderCredentialError('Provider authentication method is invalid', 'PROVIDER_ACCOUNT_INVALID');
  }
  const token = String(fields.token || '');
  if (!token) throw new ProviderCredentialError('Provider account credential is unavailable', 'PROVIDER_CREDENTIAL_UNAVAILABLE');
  return { ...fields };
}
