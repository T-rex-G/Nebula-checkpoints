/*
 * The GitHub provider: the App that mints installation credentials, the
 * account operations that are checked against what GitHub reads back, the
 * credential each account works with, and what its answers about references
 * and branches say. The rest of the server reaches this module through this
 * file only.
 */
export {
  GithubAppBroker,
  GithubAppError,
  TOKEN_REFRESH_MARGIN_MS,
  createGithubAppJwt,
  createGithubAppState,
  sanitizeInstallation,
  verifyGithubAppState
} from './client/github-app.ts';
export type { GithubAppConfig, Installation, StateContext, StatePayload } from './client/github-app.ts';
export {
  connectionRestriction,
  createVerifiedRepository,
  githubRepositoryScopes,
  githubTokenKind,
  listAccessibleNotifications,
  scopedCodeQuery,
  searchAccessibleCode,
  validateCodeQuery,
  validateRepositoryCreation,
  verifyRepositoryDeletion
} from './domain/github-account-operations.ts';
export type { ProviderRequest, Refusal, RepositoryCreation, TokenKind } from './domain/github-account-operations.ts';
export { ProviderCredentialError, resolveProviderAccount } from './domain/provider-credentials.ts';
export { normalizeProviderBranches, referenceSha } from './domain/provider-references.ts';
export type { ProviderBranch } from './domain/provider-references.ts';
export type { CredentialDependencies, InstallationBroker } from './domain/provider-credentials.ts';
