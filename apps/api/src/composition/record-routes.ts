/*
 * What is kept and observed about a repository: its snapshots and their
 * signatures, its activity, who and what can reach it, the repository audit,
 * the rendered audit and the site check, a branch's protection, its
 * dependencies, its verified live events and evidence chain -- then the
 * identity's sessions elsewhere, the build's identity, and last of all the
 * page for any route the browser owns. Registered in the order the route
 * policy records.
 */
import type { Application } from 'express';
import {
  protectedPatternsForReq, registerAccessSurfaceRoutes, registerEvidenceRoutes, registerSnapshotRoutes, safetyOf, scopedEvidenceKey
} from '../modules/corona/index.ts';
import { identityKey, providerAuthority, providerResourceKeyHash, registerSessionContainmentRoutes } from '../modules/identity-access/index.ts';
import { OWN_WORK } from '../modules/kepler/index.ts';
import { registerParallaxRoutes } from '../modules/parallax/index.ts';
import { registerBranchProtectionRoutes } from '../modules/posture/index.ts';
import { publicCallbackBase, registerActivityRoutes, registerLiveEventRoutes } from '../modules/pulsar/index.ts';
import { registerCodeAuditRoutes } from '../modules/uranus/index.ts';
import { registerDependencyAuditRoute, type ListRepositories } from '../modules/workbench/index.ts';
import { publicErrorBody, sendFailure } from '../http/errors.ts';
import { registerShellFallback, registerVersionRoute } from '../http/routes/index.ts';
import { fetchWithDeadline } from '../platform/network/timed-fetch.ts';
import { PRODUCT_NAME } from '../platform/release/version.ts';
import type { Release, Settings } from './configuration.ts';
import type { Core } from './core.ts';
import type { Access } from './access.ts';
import { accountOf, alphaSessionOf, alphaTesterOf, governanceOf, viewerOf } from './request-context.ts';


export function registerRepositoryRecords(app: Application, release: Release, settings: Settings, core: Core, access: Access, listRepositories: ListRepositories) {
  const { settings: env, databaseConfigured } = settings;
  const { providerSessionAccess, auth, accountAuth } = access.guards;
  const { alphaRepositoryAccess, alphaRepositoryListAccess, retainedActor } = access.repositories;
  const { capabilityAccess, requestSupportsCapability } = core.capabilities;
  const { gh } = core.github;
  const { lifecycle } = access;
  const { sessions } = core;
  const guarded = { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth };
  const reads = { ...guarded, account: accountOf, fail: sendFailure, gh };

  registerSnapshotRoutes(app, {
    ...guarded, mutationContext: access.mutationContext, account: accountOf, fail: sendFailure, gh,
    recovery: core.recovery, dbReady: core.ready, pool: core.pool, identityKey, scopedEvidenceKey,
    appendEvidence: core.evidenceChain.appendEvidence, signatures: settings.snapshotSignatures,
    retentionCount: env.snapshotRetentionCount, safetyOf, protectedPatternsForReq, alphaEnabled: env.alphaAccess.enabled,
    savePersistentSafety: core.safety.savePersistentSafety, saveSessionSafetyCopy: core.safety.saveSessionSafetyCopy,
    sessionsForIdentity: lifecycle.sessionsForIdentity, revokeContainedSessions: lifecycle.revokeContainedSessions,
    closeLiveSessions: core.closeLiveSessions, retainedActor,
    executionSnapshot: () => core.mutationGateway.executionSnapshot()
  });
  registerActivityRoutes(app, {
    ...guarded, alphaRepositoryListAccess, account: accountOf, fail: sendFailure,
    gh: (acct, apiPath) => gh(acct, apiPath), supportsCapability: requestSupportsCapability,
    listRepositories: req => listRepositories(req), publicErrorBody
  });
  registerAccessSurfaceRoutes(app, reads);
  registerCodeAuditRoutes(app, {
    ...guarded, accountAuth, governanceAccess: access.governance.governanceAccess, OWN_WORK,
    governanceMutationContext: access.governance.governanceMutationContext, governance: governanceOf, account: accountOf,
    fail: sendFailure, publicErrorBody, retainedActor, identityKey, service: core.codeAudit
  });
  const parallax = registerParallaxRoutes(app, { ...guarded, viewer: viewerOf, fail: sendFailure });
  registerBranchProtectionRoutes(app, reads);
  registerDependencyAuditRoute(app, { ...reads, fetch: fetchWithDeadline });
  registerLiveEventRoutes(app, {
    ...guarded, mutationContext: access.mutationContext, account: accountOf, fail: sendFailure,
    gh, dbReady: core.ready, pool: core.pool, identityKey, databaseConfigured, publicBase: req => publicCallbackBase(req, process.env), seal: core.seal,
    scopedEvidenceKey, appendEvidence: core.evidenceChain.appendEvidence, retainedActor, providerResourceKeyHash, providerAuthority,
    alphaEnabled: env.alphaAccess.enabled, alphaTesterId: alphaTesterOf, alphaSessionId: alphaSessionOf,
    readAlphaSession: (sessionId, options) => core.alphaStore!.readSession(sessionId, options), alphaWebhooks: core.alphaPrivacyStore,
    sessionSid: sessions.sessionIdFromRequest, hub: core.liveHub
  });
  registerEvidenceRoutes(app, {
    ...guarded, account: accountOf, fail: sendFailure, identityKey, scopedEvidenceKey, verifyEvidenceChain: core.evidenceChain.verifyEvidenceChain,
    dbReady: core.ready, pool: core.pool, signatures: settings.snapshotSignatures
  });
  registerSessionContainmentRoutes(app, {
    auth, fail: sendFailure, sessionsForIdentity: lifecycle.sessionsForIdentity,
    revokeContainedSessions: lifecycle.revokeContainedSessions, closeLiveSessions: core.closeLiveSessions
  });
  registerVersionRoute(app, {
    product: PRODUCT_NAME, releaseTreeSha256: release.releaseTreeSha256, servedAssetsSha256: release.webBuild.servedAssetsSha256,
    serverRuntime: { mode: release.runtime.mode, buildSha256: release.runtime.buildSha256 }
  });
  registerShellFallback(app, { webBuild: release.webBuild });
  return { jobs: { site: parallax.site, rendered: parallax.rendered } };
}
