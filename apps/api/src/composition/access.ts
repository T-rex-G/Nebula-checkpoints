/*
 * Who may do what: the alpha's sessions, the guards a request passes before a
 * route reads or changes anything, which repositories it may reach, the
 * context a repository or governance change runs in, and an account's life in
 * a session. Built once over the core; the routes are handed them by name, the
 * names the route policy records.
 */
import { scopedEvidenceKey, guardSafety, defaultSafety } from '../modules/corona/index.ts';
import { githubRepositoryScopes, scopedCodeQuery, validateCodeQuery, validateRepositoryCreation } from '../modules/github-provider/index.ts';
import {
  alphaActorLabel, createAccountLifecycle, createAlphaSessions, createGithubAppConnectionView, createRepositoryAccess,
  createRequestGuards, identityKey, sessionAccountCapacity
} from '../modules/identity-access/index.ts';
import { activePolicySetStepEvaluator, createGovernanceContext } from '../modules/kepler/index.ts';
import { mergeFactsFor } from '../modules/uranus/index.ts';
import { sendFailure } from '../http/errors.ts';
import { readCookie } from '../platform/authorization/session-cookie.ts';
import { createRepositoryMutationContext } from '../platform/mutation-gateway/mutation-context.ts';
import type { Settings } from './configuration.ts';
import type { Core } from './core.ts';
import { ALPHA_SESSION_ID, accountOf, type GuardedRequest } from './request-context.ts';
import type { Fields } from '../platform/values/fields.ts';

/* A request an upload scan reads: the account it acts as, and the repository its route may name. */
type ScannedRequest = object & { readonly gh?: Fields; readonly params?: { readonly owner?: string; readonly repo?: string } | null };

/* What is built after access, and reached from it only once it exists. */
export interface Later {
  readonly parallaxJobs: () => { readonly site: { forget(key: string): void }; readonly rendered: { forget(key: string): void } };
}

export function composeAccess(settings: Settings, core: Core, later: Later) {
  const alphaConfig = settings.settings.alphaAccess;
  const { databaseConfigured } = settings;
  const { sessions, security, github, mutationGateway, authorizationResolver } = core;

  const alphaSessions = createAlphaSessions({
    config: alphaConfig, store: core.alphaStore, seal: core.seal, unseal: core.unseal, getCookie: readCookie,
    sessionIdKey: ALPHA_SESSION_ID, production: () => process.env.NODE_ENV === 'production'
  });
  const guards = createRequestGuards({
    sessionOf: sessions.sessionOf, resolveAccount: core.resolveAccount, ensureSessionSecurity: security.ensureSessionSecurity,
    verifyRequestCsrf: security.verifyRequestCsrf, consumeStepUpAuthorization: security.consumeStepUpAuthorization,
    loadSafety: core.safety.loadPersistentSafety, guardSafety
  });
  const repositories = createRepositoryAccess({
    alphaEnabled: alphaConfig.enabled, fail: sendFailure, defaultSafety,
    validateRepositoryCreation, validateCodeQuery, githubRepositoryScopes, scopedCodeQuery
  });
  const { mutationContext } = createRepositoryMutationContext({
    gateway: mutationGateway, identityKey, retainedActor: repositories.retainedActor,
    resolveAuthorization: input => authorizationResolver.resolve(input), alphaEnabled: alphaConfig.enabled, alphaActorLabel,
    mergeFacts: (req: GuardedRequest) => mergeFactsFor(core.codeAudit, { account: accountOf(req), owner: req.params.owner, repo: req.params.repo }, req.params.num),
    inspectRestoreAuthorization: (target, authorization) => core.recovery.inspectRestoreAuthorization(target, authorization),
    ready: core.ready, resolveActivePolicySet: input => core.governance.ensureGovernanceStore().resolveActivePolicySetInScope(input),
    stepEvaluator: activePolicySetStepEvaluator, fail: sendFailure
  });
  const governance = createGovernanceContext({
    gateway: mutationGateway, governanceService: core.governance.governanceService,
    resolveAuthorization: input => authorizationResolver.resolve(input), identityKey, retainedActor: repositories.retainedActor
  });
  const lifecycle = createAccountLifecycle({
    alphaEnabled: alphaConfig.enabled, databaseConfigured, accountCap: () => sessionAccountCapacity(databaseConfigured), ready: core.ready, pool: core.pool,
    gh: github.gh, resolveAccount: core.resolveAccount, appBroker: core.githubAppBroker,
    removeGithubAppInstallation: core.githubAppRecords.removeGithubAppInstallation, recordGithubAppAudit: core.githubAppRecords.recordGithubAppAudit,
    retainedActor: repositories.retainedActor,
    forgetJobs: account => {
      const jobs = later.parallaxJobs();
      core.codeAudit.jobs.forget(identityKey(account)); jobs.site.forget(identityKey(account)); jobs.rendered.forget(identityKey(account));
    },
    sessionOf: sessions.sessionOf, setSession: sessions.setSession, sessionIdFromRequest: sessions.sessionIdFromRequest,
    clearStepUpAuthorization: security.clearStepUpAuthorization, readCookie, writeCookie: core.writeCookie,
    seal: core.seal, unseal: core.unseal, closeLiveSessions: core.closeLiveSessions, privacyStore: core.alphaPrivacyStore
  });
  const githubAppConnectionView = createGithubAppConnectionView({ config: alphaConfig, identityKey });
  /* A repository's evidence chain, for the identity the request acts as; asked only of a request naming a repository. */
  const evidenceKeyOf = (req: ScannedRequest) => {
    const account = req.gh!;
    return scopedEvidenceKey(account.provider || 'github', req.params!.owner, req.params!.repo, identityKey(account));
  };

  return { alphaSessions, guards, repositories, mutationContext, governance, lifecycle, githubAppConnectionView, evidenceKeyOf };
}

export type Access = ReturnType<typeof composeAccess>;
