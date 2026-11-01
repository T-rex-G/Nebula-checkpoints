/*
 * Identity and access: who may use the alpha, the provider identities they
 * bind, and the privacy lifecycle that ends them. The rest of the server
 * reaches this module through this file only.
 */
export {
  AlphaAccessError,
  canonicalRepositoryScope,
  digestInviteSecret,
  inviteUnbound,
  parseInviteCode,
  parseRepositoryScope,
  parseStoredRepositoryScope,
  repositoryAllowed
} from './domain/alpha-access.ts';
export type { ParsedRepositoryScope } from './domain/alpha-access.ts';
export {
  alphaActorLabel,
  alphaRetentionPolicy,
  buildSupportBundle,
  providerRevocationGuidance,
  sanitizeFeedback
} from './domain/alpha-privacy.ts';
export type { AlphaRetentionPolicy, RevocationGuidance, SupportBundle } from './domain/alpha-privacy.ts';
export { disconnectProviderAccount, providerResourceKeyHash, providerSessionKeyHash } from './domain/provider-disconnect.ts';
export type { DisconnectOptions, DisconnectResult } from './domain/provider-disconnect.ts';
export { AlphaAccessOperationalError, AlphaAccessStore, GENERIC_REDEMPTION_ERROR } from './persistence/alpha-access-store.ts';
export type { AlphaSession, AlphaTester, IssuedInvite, Redemption } from './persistence/alpha-access-store.ts';
export { AlphaPrivacyStore, AlphaPrivacyStoreError } from './persistence/alpha-privacy-store.ts';
export type { PurgeReport, SessionCodec } from './persistence/alpha-privacy-store.ts';
export {
  assertGithubAccount, githubSession, identityKey, isGithubAccount, persistedSession, providerAuthority, stableProviderIdentityKey
} from './domain/account-identity.ts';
export type { AccountLike, SessionAccounts } from './domain/account-identity.ts';
export { hostedAccountKey, mergeHostedSessionValue, recomputeHostedSessionMutation } from './domain/hosted-session-merge.ts';
export type { HostedSession } from './domain/hosted-session-merge.ts';
export {
  alphaConnectionRefusal, createProviderSessions, HOSTED_SESSION_BASE, HOSTED_SESSION_REVISION, ownedSessionRefusal
} from './application/provider-sessions.ts';
export type { ProviderSessionDeps, ProviderSessions } from './application/provider-sessions.ts';
export { createSessionSecurity, CSRF_TTL_MS, STEP_UP_TTL_MS } from './application/session-security.ts';
export type { SessionSecurity, SessionSecurityDeps } from './application/session-security.ts';
export { createRequestGuards } from './application/request-guards.ts';
export type { RequestGuardDeps, RequestGuards } from './application/request-guards.ts';
export { createRepositoryAccess } from './application/repository-access.ts';
export type { RepositoryAccess, RepositoryAccessDeps } from './application/repository-access.ts';
export { RETIRED_CLEANUP, createAccountLifecycle } from './application/account-lifecycle.ts';
export type { AccountLifecycle, AccountLifecycleDeps, LifecyclePrivacyStore } from './application/account-lifecycle.ts';
export { createAlphaPrivacyRetention } from './application/alpha-privacy-retention.ts';
export type { AlphaPrivacyRetention, AlphaPrivacyRetentionDeps } from './application/alpha-privacy-retention.ts';
export { ALPHA_COOKIE, createAlphaSessions } from './http/alpha-sessions.ts';
export type { AlphaSessionDeps, AlphaSessions, AlphaSessionView } from './http/alpha-sessions.ts';
export { registerAlphaAccessRoutes } from './http/alpha-access-routes.ts';
export type { AlphaAccessRouteDeps } from './http/alpha-access-routes.ts';
export { providerDisconnectPending, uniqueGuidance } from './http/disconnect-answers.ts';
export type { DisconnectProviderAccounts, ProviderCleanup, ProviderSession, RevocationStep } from './http/disconnect-answers.ts';
export { registerAccountRoutes, registerMeRoute, registerSignOutRoute } from './http/account-routes.ts';
export type { AccountRouteDeps, MeRouteDeps } from './http/account-routes.ts';
export { registerAlphaDisconnectRoutes, registerAlphaPrivacyRoutes } from './http/alpha-lifecycle-routes.ts';
export type { AlphaDisconnectRouteDeps, AlphaFeedbackRouteDeps, AlphaPrivacyOperations, AlphaPrivacyRouteDeps } from './http/alpha-lifecycle-routes.ts';
export { createGithubAppConnectionView, registerGithubAppRoutes } from './http/github-app-routes.ts';
export type { GithubAppBrokerOperations, GithubAppClient, GithubAppConnectionViewDeps, GithubAppRouteDeps } from './http/github-app-routes.ts';
export { registerSecurityRoutes, registerSessionContainmentRoutes } from './http/security-routes.ts';
export type { SecurityRouteDeps, SessionContainmentRouteDeps } from './http/security-routes.ts';
export { registerOAuthRoutes } from './http/oauth-routes.ts';
export type { OAuthRouteDeps } from './http/oauth-routes.ts';
