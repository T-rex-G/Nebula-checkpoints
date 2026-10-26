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
