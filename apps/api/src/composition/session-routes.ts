/*
 * The alpha's front door and everything about the signed-in person rather
 * than a repository: their accounts, the deployment's configuration and
 * capabilities, a GitHub App connection, the session's own security, OAuth
 * sign-in, a tester's own data, signing out, who the account is, its GitHub
 * API budget, and the workspace and security posture. Registered in the order
 * the route policy records.
 */
import type { Application } from 'express';
import { projectCapabilities } from './commonjs.ts';
import { GithubAppError, createGithubAppState, verifyGithubAppState } from '../modules/github-provider/index.ts';
import {
  CSRF_TTL_MS, STEP_UP_TTL_MS, identityKey, isGithubAccount, registerAccountRoutes, registerAlphaAccessRoutes, registerAlphaDisconnectRoutes,
  registerAlphaPrivacyRoutes, registerGithubAppRoutes, registerMeRoute, registerOAuthRoutes, registerSecurityRoutes, registerSignOutRoute
} from '../modules/identity-access/index.ts';
import { normalizePolicyScope } from '../modules/kepler/index.ts';
import { registerWorkspacePostureRoutes } from '../modules/posture/index.ts';
import { exposureSeverityOf, safeDisplayPath } from '../modules/quasar/index.ts';
import { auditTriage } from '../modules/uranus/index.ts';
import { sendFailure } from '../http/errors.ts';
import { registerConfigRoutes, registerProviderRateRoute } from '../http/routes/index.ts';
import type { maintenanceMode } from '../http/pipeline/index.ts';
import { scannerStatus } from '../platform/files/file-security.ts';
import { readCookie } from '../platform/authorization/session-cookie.ts';
import { fetchWithDeadline } from '../platform/network/timed-fetch.ts';
import { APP_VERSION } from '../platform/release/version.ts';
import { BYTES_PER_MB, DEPLOYMENT_PROFILE, type Release, type Settings } from './configuration.ts';
import type { Core } from './core.ts';
import type { Access } from './access.ts';
import { accountOf } from './request-context.ts';

type Maintenance = ReturnType<typeof maintenanceMode>;

export function registerSessionSurface(app: Application, release: Release, settings: Settings, core: Core, access: Access, maintenance: Maintenance) {
  const { secrets, settings: env, limits, databaseConfigured } = settings;
  const alphaConfig = env.alphaAccess;
  const { guards, repositories, lifecycle } = access;
  const { capabilityAccess, providerCapabilities, providerCapabilityContext } = core.capabilities;
  const { sessions, security, github } = core;
  const disconnect = { disconnectProviderAccounts: lifecycle.disconnectAlphaProviderAccount, clearProviderSessionCookie: lifecycle.clearProviderSessionCookie };

  registerAlphaAccessRoutes(app, { sessions: access.alphaSessions, config: alphaConfig, store: core.alphaStore, seal: core.seal, getCookie: readCookie });
  /* Accounts: sign-in with a token, the list, switching and removing one; signing out reads the same. */
  const accountDeps = {
    accountAuth: guards.accountAuth, config: alphaConfig, fail: sendFailure, providerIdentity: lifecycle.providerIdentity, addAccount: lifecycle.addAccount,
    signedOutWithoutGithub: guards.signedOutWithoutGithub, retainedActor: repositories.retainedActor, githubAppConnectionView: access.githubAppConnectionView,
    isGithubAccount, clearStepUpAuthorization: security.clearStepUpAuthorization, setSession: sessions.setSession, sessionOf: sessions.sessionOf,
    destroySession: sessions.destroySession, ...disconnect
  };
  registerAccountRoutes(app, accountDeps);
  registerConfigRoutes(app, {
    providerSessionAccess: guards.providerSessionAccess,
    hostedConfig: () => ({
      profile: secrets.hostingProfile, alphaMode: alphaConfig.mode, termsVersion: alphaConfig.termsVersion,
      limits: env.publicAlphaLimits, database: core.database.readiness()
    }),
    oauth: !!(env.oauth.clientId && env.oauth.clientSecret),
    githubApp: { enabled: env.githubApp.enabled, webhookConfigured: env.githubApp.enabled && env.githubApp.webhookConfigured },
    /* Published because the browser labels queued files against them; a copy written into the browser would be a second source of truth. */
    uploads: { uploadMaxMb: env.uploadMaxMb, gitDataMaxMb: env.gitDataMaxMb, nativePushMaxMb: env.nativePushMaxMb, contentsMaxMb: limits.contentsMax / BYTES_PER_MB },
    qualificationCapabilities: release.qualificationCapabilities,
    projectCapabilities: context => projectCapabilities(release.capabilityDocument, context),
    deployment: DEPLOYMENT_PROFILE,
    accountCapabilityContext: providerCapabilityContext, account: accountOf
  });
  registerGithubAppRoutes(app, {
    auth: guards.auth, accountAuth: guards.accountAuth, fail: sendFailure, config: alphaConfig, identityKey, githubApp: env.githubApp,
    broker: () => core.githubAppBroker,
    client: { AppError: GithubAppError, createState: createGithubAppState, verifyState: verifyGithubAppState },
    stateSecret: secrets.keys.githubAppState, replayKey: secrets.keys.githubAppStateReplay,
    databaseConfigured: () => databaseConfigured, durableSingleUseStore: core.durableSingleUseStore, connectionView: access.githubAppConnectionView,
    providerIdentity: lifecycle.providerIdentity, requestSecurityContext: security.requestSecurityContext, sessionSecurityState: security.sessionSecurityState,
    ensureSessionSecurity: security.ensureSessionSecurity, sessionOf: sessions.sessionOf, setSession: sessions.setSession, destroySession: sessions.destroySession,
    addAccount: lifecycle.addAccount, clearStepUpAuthorization: security.clearStepUpAuthorization, ...disconnect,
    persistGithubAppInstallation: core.githubAppRecords.persistGithubAppInstallation, recordGithubAppAudit: core.githubAppRecords.recordGithubAppAudit,
    retainedActor: repositories.retainedActor
  });
  registerSecurityRoutes(app, {
    auth: guards.auth, accountAuth: guards.accountAuth, providerSessionAccess: guards.providerSessionAccess, capabilityAccess,
    alphaStepUpRepositoryAccess: repositories.alphaStepUpRepositoryAccess, fail: sendFailure,
    csrf: { secret: secrets.keys.csrf, ttlMs: CSRF_TTL_MS }, stepUp: { secret: secrets.keys.stepUp, ttlMs: STEP_UP_TTL_MS },
    requestSecurityContext: security.requestSecurityContext, sessionSecurityState: security.sessionSecurityState, setSession: sessions.setSession,
    providerIdentity: lifecycle.providerIdentity, getInstallation: installationId => core.githubAppBroker!.getInstallation(installationId), identityKey, scannerStatus
  });
  registerOAuthRoutes(app, {
    oauth: { clientId: env.oauth.clientId, clientSecret: env.oauth.clientSecret }, production: () => process.env.NODE_ENV === 'production',
    getCookie: readCookie, fetch: fetchWithDeadline, gh: github.gh, addAccount: lifecycle.addAccount
  });
  registerAlphaPrivacyRoutes(app, { config: alphaConfig, privacyStore: core.alphaPrivacyStore, releaseVersion: APP_VERSION });
  registerSignOutRoute(app, accountDeps);
  registerAlphaDisconnectRoutes(app, {
    config: alphaConfig, privacyStore: core.alphaPrivacyStore, accountAuth: guards.accountAuth, fail: sendFailure, sessions: access.alphaSessions, ...disconnect
  });
  registerMeRoute(app, {
    accountAuth: guards.accountAuth, config: alphaConfig, fail: sendFailure, signedOutWithoutGithub: guards.signedOutWithoutGithub, isGithubAccount,
    retainedActor: repositories.retainedActor, githubAppConnectionView: access.githubAppConnectionView, gh: github.gh, providerCapabilities,
    offlineCacheScope: security.offlineCacheScope, releaseVersion: APP_VERSION
  });
  registerProviderRateRoute(app, { auth: guards.auth, capabilityAccess, account: accountOf, fail: sendFailure, gh: github.gh });
  registerWorkspacePostureRoutes(app, {
    providerSessionAccess: guards.providerSessionAccess, capabilityAccess, auth: guards.auth, account: accountOf, fail: sendFailure,
    gh: github.gh, dbReady: core.ready, pool: core.pool, identityKey, normalizePolicyScope,
    databaseConfigured, maintenance, hostedAlpha: secrets.hostingProfile === 'hosted-alpha',
    auditHistory: () => core.codeAudit.history(), exposureService: core.exposure.exposureService, governanceStore: core.governance.ensureGovernanceStore,
    severityOf: exposureSeverityOf, displayPath: safeDisplayPath, triageVocabulary: auditTriage.VOCABULARY
  });
}
