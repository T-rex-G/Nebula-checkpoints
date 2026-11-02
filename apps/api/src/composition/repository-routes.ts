/*
 * Working on a repository: the workbench's services and the routes that read
 * and change a repository's contents, history and collaboration, with
 * governance, exposure scanning, recovery and the session's safeguards in their
 * places among them. Registered in the order the route policy records.
 *
 * The workbench's services: the commit writer every content change goes
 * through, Corona's recoveries included; the repositories a session may see,
 * through the hosted alpha's list filter; Git LFS storage; the native Git push;
 * the intake every upload arrives through; the scan every uploaded file passes,
 * a blocked one recorded on the repository's evidence chain; and the upkeep of
 * the files an upload leaves behind.
 */
import type { Application } from 'express';
import {
  enforceProtectedPaths, protectedPathError, protectedPatternsForReq, registerCommitRecoveryRoutes, registerSafeguardRoutes, safetyOf
} from '../modules/corona/index.ts';
import { githubRepositoryScopes } from '../modules/github-provider/index.ts';
import { assertGithubAccount, identityKey } from '../modules/identity-access/index.ts';
import { OWN_WORK, registerGovernanceLifecycleRoutes, registerGovernanceRoutes } from '../modules/kepler/index.ts';
import { credentialVerifier, exposureReader, readabilityProbe, registerExposureRoutes } from '../modules/quasar/index.ts';
import {
  assertExpectedHead, branchChangedError, createCommitWriter, createLfsTransfer, createNativePush, createRepositoryList, createUploadIntake,
  createUploadScan, createUploadUpkeep, registerCodeownersRoute, registerCollaborationRoutes, registerContentRoutes, registerFolderMoveRoute,
  registerHistoryRoutes, registerRepositoryRoutes, registerUploadRoutes, requireAggregateExpectedHead
} from '../modules/workbench/index.ts';
import { publicErrorBody, sendFailure } from '../http/errors.ts';
import { scanUploadFile } from '../platform/files/file-security.ts';
import { fetchWithDeadline } from '../platform/network/timed-fetch.ts';
import type { Settings } from './configuration.ts';
import type { Core } from './core.ts';
import type { Access } from './access.ts';
import { accountOf, governanceOf, type GuardedRequest } from './request-context.ts';

export function registerRepositoryWork(app: Application, settings: Settings, core: Core, access: Access) {
  const { settings: env, limits, secrets } = settings;
  const { providerSessionAccess, auth, accountAuth } = access.guards;
  const {
    alphaRepositoryAccess, alphaRepositoryListAccess, alphaRepositoryListAllowed, repositoryCreationAccess, repositoryDeletionConfirmation,
    githubSearchAccess, alphaSafetyView, alphaSafetyMutationAccess, retainedActor
  } = access.repositories;
  const { capabilityAccess, capabilityAccessWhen, assertProviderBoundLfs } = core.capabilities;
  const { governanceAccess, governanceMutationContext } = access.governance;
  const { mutationContext } = access;
  const { gh, githubArchiveResponse } = core.github;
  const guarded = { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth };
  const governed = { ...guarded, governanceAccess, governanceMutationContext, governance: governanceOf, account: accountOf };

  const commitWriter = createCommitWriter(gh);
  const listRepositories = createRepositoryList({ gh, account: accountOf, listAllowed: alphaRepositoryListAllowed });
  const assertProviderMutation = (target: Parameters<typeof core.mutationGateway.assertProviderMutation>[0]) => core.mutationGateway.assertProviderMutation(target);
  const lfsTransfer = createLfsTransfer({
    fetch: fetchWithDeadline, gh, commits: commitWriter, assertProviderBoundLfs, assertProviderMutation, transferTimeoutMs: limits.uploadTimeoutMs
  });
  const nativePush = createNativePush({
    gh, fetch: fetchWithDeadline, assertProviderMutation, assertGithubAccount, maxBytes: limits.gitPushMax, maxMegabytes: env.nativePushMaxMb
  });
  const uploadIntake = createUploadIntake({ concurrency: env.uploadConcurrency, timeoutMs: limits.uploadTimeoutMs });
  const scanUploadOrThrow = createUploadScan({
    scan: scanUploadFile, appendEvidence: core.evidenceChain.appendEvidence, retainedActor, evidenceKey: access.evidenceKeyOf
  });
  const { startTempMaintenance } = createUploadUpkeep({ staleHours: env.staleUploadHours });

  registerCodeownersRoute(app, { ...guarded, account: accountOf, fail: sendFailure, gh });
  registerGovernanceRoutes(app, { ...governed, gh });
  registerExposureRoutes(app, {
    ...guarded, governanceAccess, OWN_WORK, governanceMutationContext, governance: governanceOf, account: accountOf,
    retainedActor, publicErrorBody, exposureService: core.exposure.exposureService, nudgeWorker: core.exposure.nudgeExposureWorker,
    keys: {
      fingerprint: secrets.keys.exposureFingerprint, verification: secrets.keys.exposureVerification,
      verificationSubject: secrets.keys.exposureVerificationSubject, readability: secrets.keys.exposureReadability
    },
    reader: exposureReader, verifyCredential: credentialVerifier.verifyCredential, probeReadability: readabilityProbe.probeAnonymousReadability
  });
  registerGovernanceLifecycleRoutes(app, { ...governed, gh });
  registerRepositoryRoutes(app, {
    providerSessionAccess, alphaRepositoryListAccess, alphaRepositoryAccess, capabilityAccess,
    repositoryCreationAccess, repositoryDeletionConfirmation, auth, mutationContext, account: accountOf, fail: sendFailure, gh,
    listRepositories, archiveResponse: githubArchiveResponse
  });
  const writes = { ...guarded, mutationContext, account: accountOf, fail: sendFailure, gh };
  registerContentRoutes(app, {
    ...writes,
    ghRaw: (acct, apiPath, options) => gh(acct, apiPath, { ...options, raw: true }),
    commits: commitWriter, lfs: lfsTransfer, assertProviderBoundLfs,
    executionSnapshot: () => core.mutationGateway.executionSnapshot()
  });
  registerHistoryRoutes(app, { ...writes, commits: commitWriter, protectedPathError });
  registerCommitRecoveryRoutes(app, {
    ...writes, commitTree: commitWriter.commitTree, enforceProtectedPaths, assertExpectedHead, branchChangedError, requireAggregateExpectedHead
  });
  registerCollaborationRoutes(app, {
    providerSessionAccess, alphaRepositoryAccess, capabilityAccess, githubSearchAccess, auth, mutationContext, account: accountOf, fail: sendFailure, gh,
    alphaRepositories: (req: GuardedRequest) => (env.alphaAccess.enabled ? githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes) : null),
    protectedPatternsForReq, enforceProtectedPaths
  });
  registerUploadRoutes(app, {
    providerSessionAccess, alphaRepositoryAccess, capabilityAccess, capabilityAccessWhen, auth, mutationContext, account: accountOf, fail: sendFailure, gh,
    commits: commitWriter, intake: uploadIntake, nativePush, lfs: lfsTransfer,
    limits: { blobMaxBytes: limits.blobMax, uploadMaxBytes: limits.uploadMax, gitPushMaxBytes: limits.gitPushMax, gitDataMaxBytes: limits.contentsMax },
    scanUpload: scanUploadOrThrow, enforceProtectedPaths
  });
  registerFolderMoveRoute(app, { ...writes, commits: commitWriter, enforceProtectedPaths });
  registerSafeguardRoutes(app, {
    providerSessionAccess, alphaSafetyMutationAccess, accountAuth, account: accountOf, fail: sendFailure,
    safetyOf, alphaSafetyView, savePersistentSafety: core.safety.savePersistentSafety, saveSessionSafetyCopy: core.safety.saveSessionSafetyCopy,
    appendEvidence: core.evidenceChain.appendEvidence, retainedActor, identityKey
  });
  return { startTempMaintenance, listRepositories };
}
