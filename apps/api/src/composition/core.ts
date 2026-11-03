/*
 * The services every part of the server stands on, built once, in the order
 * the server has always built them: the database, the stores a request's
 * admission and grants are kept in, the session and its security, a person's
 * safety controls and the evidence chain, the live streams, the GitHub App,
 * the shutdown, governance and the mutation gateway, and the services the
 * routes and the guards share -- GitHub's REST client, exposure scanning,
 * recovery and the repository audit. Building a service starts nothing: each
 * starts its work on first need, or when the entry point says.
 *
 * Two things are only known once the routes are registered and the server
 * listens: the rendered-audit and site-check job queues Parallax's routes
 * build, and the HTTP server. The shutdown reaches them through `later`.
 */
import type { Server } from 'node:http';
import { CapabilityError, assertCapabilityAvailable, legacyCapsFor, resolveCapability } from './commonjs.ts';
import { createEvidenceChain, createRecovery, createSafetyState } from '../modules/corona/index.ts';
import { GithubAppBroker, createGithubRestClient, githubTokenKind, resolveProviderAccount } from '../modules/github-provider/index.ts';
import {
  AlphaAccessStore, AlphaPrivacyStore, createAlphaPrivacyRetention, createGithubAppRecords, createProviderSessions,
  createSessionSecurity, identityKey, inviteUnbound, providerAuthority, repositoryAllowed
} from '../modules/identity-access/index.ts';
import { createGovernanceHost } from '../modules/kepler/index.ts';
import { createLiveHub } from '../modules/pulsar/index.ts';
import { createExposureHost, exposureReader } from '../modules/quasar/index.ts';
import { createCodeAuditService } from '../modules/uranus/index.ts';
import { SAFE_API_METHODS } from '../http/pipeline/index.ts';
import { createAuthorizationResolver } from '../platform/authorization/authorization-resolver.ts';
import { createCapabilityAccess } from '../platform/authorization/capability-access.ts';
import { createLocalSessionPolicy } from '../platform/authorization/local-session-policy.ts';
import { createSessionCookieWriter, createSessionSeal, readCookie } from '../platform/authorization/session-cookie.ts';
import { createGracefulShutdown } from '../platform/lifecycle/graceful-shutdown.ts';
import { createMutationGateway } from '../platform/mutation-gateway/mutation-gateway.ts';
import { fetchWithDeadline } from '../platform/network/timed-fetch.ts';
import { createDatabaseLifecycle } from '../platform/persistence/database-lifecycle.ts';
import { createDatabasePool } from '../platform/persistence/database-pool.ts';
import { loadMigrations, runMigrations, verifyMigrations } from '../platform/persistence/migrations.ts';
import { createDurableStores } from '../platform/rate-limit/durable-stores.ts';
import { APP_VERSION, PRODUCT_NAME } from '../platform/release/version.ts';
import { DEPLOYMENT_PROFILE, type Release, type Settings } from './configuration.ts';
import * as path from 'node:path';

/* What is built after the core, and reached from it only once the server is running. */
export interface Later {
  readonly parallaxJobs: () => { readonly site: { close(): void }; readonly rendered: { close(): void } };
  readonly httpServer: () => Server;
}

export function composeCore(release: Release, settings: Settings, later: Later) {
  const { secrets, evidence, settings: env, limits, databaseConfigured } = settings;
  const alphaConfig = env.alphaAccess;
  const localSessionPolicy = createLocalSessionPolicy();

  /* The one pool, the store's readiness and its upkeep; once the store is ready, the alpha's privacy retention starts. */
  const database = createDatabaseLifecycle({
    databaseUrl: env.databaseUrl, migrationMode: secrets.databaseMigrationMode, migrationsDirectory: path.join(release.root, 'db', 'migrations'),
    productName: PRODUCT_NAME, eventRetentionDays: env.eventRetentionDays, sessionRetentionDays: env.sessionRetentionDays,
    openPool: createDatabasePool, migrations: { load: loadMigrations, run: runMigrations, verify: verifyMigrations },
    onReady: () => alphaPrivacyRetention.start()
  });
  const { pool, ready } = database;
  const { apiRateLimitStore, durableSingleUseStore } = createDurableStores({ databaseConfigured, pool });
  const githubAppRecords = createGithubAppRecords({ alphaEnabled: alphaConfig.enabled, ready, pool });
  const { seal, unseal } = createSessionSeal(secrets.keys.sessionContent);
  /* The alpha's access and privacy stores, through the one pool. */
  const storePool = {
    connect: () => pool().connect(),
    query: (...args: [text: string, values?: unknown[]]) => pool().query(...args)
  };
  const alphaStore = alphaConfig.enabled ? new AlphaAccessStore({
    pool: storePool, pepper: alphaConfig.pepper, inviteTtlMs: alphaConfig.inviteTtlMs,
    sessionTtlMs: alphaConfig.sessionAbsoluteTtlMs, idleTtlMs: alphaConfig.sessionIdleTtlMs
  }) : null;
  const alphaPrivacyStore = alphaConfig.enabled ? new AlphaPrivacyStore({
    pool: storePool, sessionCodec: { encode: seal, decode: unseal, identityKey }
  }) : null;
  const writeCookie = createSessionCookieWriter(() => process.env.NODE_ENV === 'production');
  /* Ends the live streams the sessions named hold open. */
  const closeLiveSessions = (sessionIds: readonly unknown[], reason = 'session-revoked') => liveHub.closeSessions(sessionIds, reason);
  const sessions = createProviderSessions({
    databaseConfigured, ready, pool, config: alphaConfig, privacyStore: alphaPrivacyStore,
    seal, unseal, readCookie, writeCookie, localSessionPolicy, closeLiveSessions
  });
  const security = createSessionSecurity({
    databaseConfigured, durableSingleUseStore, setSession: sessions.setSession, csrfSecret: secrets.keys.csrf, stepUpSecret: secrets.keys.stepUp,
    safeMethods: SAFE_API_METHODS, offlineCacheScopeKey: secrets.keys.offlineCacheScope, sessionIdFromRequest: sessions.sessionIdFromRequest
  });
  const safety = createSafetyState({ databaseConfigured, ready, pool, identityKey, setSession: sessions.setSession });
  const evidenceChain = createEvidenceChain({
    ready, pool, ledgerSecret: secrets.keys.evidenceLedger, keyring: evidence.keyring,
    legacyProbe: evidence.legacyProbe, legacyAccepted: evidence.legacyAccepted
  });
  const liveHub = createLiveHub({ maxTotal: env.liveClientsTotal, maxPerKey: env.liveClientsPerRepo });
  const githubAppBroker = env.githubApp.enabled ? new GithubAppBroker(env.githubApp, {
    audit(event) {
      return githubAppRecords.recordGithubAppAudit(
        String(event && event.identityKey || 'system:github-app'),
        String(event && event.type || 'authorization.refreshed'),
        event && event.installationId,
        event || {}
      );
    }
  }) : null;
  const resolveAccount = (account: unknown) => resolveProviderAccount(account, { githubAppBroker });
  /* Stopping, once, on the first signal: no new jobs, the live streams told why, the workers' work finished, then the pool. */
  const { shutdown, shuttingDown } = createGracefulShutdown({
    closeJobs: () => { const jobs = later.parallaxJobs(); jobs.rendered.close(); jobs.site.close(); codeAudit.jobs.close(); },
    closeStreams: signal => liveHub.shutdown(signal),
    drain: () => [governance.stop(), exposure.stop()],
    server: later.httpServer, closeDatabase: () => database.close(), exit: code => process.exit(code)
  });
  /* Governance's life in this process: the runtime's policy decisions, the API service and webhook delivery. */
  const governance = createGovernanceHost({
    databaseConfigured, ready, pool, auditSecret: env.governanceAuditSecret,
    runtimeFailureMode: env.governanceRuntimeFailureMode, shuttingDown
  });
  /* The gateway is handed its policy port here, the one place both are built; it imports no policy module. */
  const mutationGateway = createMutationGateway({
    policyEvaluator: governance.runtime,
    eventSink(event) {
      if (!event || !['policy.evaluated', 'policy.blocked'].includes(event.type)) return;
      console.log(JSON.stringify({
        t: new Date().toISOString(), event: event.type, mutationId: event.mutationId, action: event.action,
        scopeKey: event.scopeKey, outcome: event.enforcementOutcome || null, blockCode: event.blockCode || null,
        warningCodes: event.warningCodes || [], decisionId: event.decisionId || null
      }));
    }
  });
  /* GitHub's REST API and the archive transport. */
  const github = createGithubRestClient({
    fetch: fetchWithDeadline, assertProviderMutation: descriptor => mutationGateway.assertProviderMutation(descriptor),
    userAgent: `${PRODUCT_NAME}/${APP_VERSION}`, transferTimeoutMs: limits.uploadTimeoutMs, appBroker: githubAppBroker, alphaEnabled: alphaConfig.enabled
  });
  const authorizationResolver = createAuthorizationResolver({ request: async ({ account, apiPath }) => github.gh(account, apiPath) });
  /* The alpha's privacy retention, started once the store is ready. */
  const alphaPrivacyRetention = createAlphaPrivacyRetention({ config: alphaConfig, store: alphaPrivacyStore });
  /* Exposure scanning's life in this process: the worker, a scan's session, and the store the routes read. */
  const exposure = createExposureHost({
    databaseConfigured, pool, capabilityDocument: release.capabilityDocument, deployment: DEPLOYMENT_PROFILE,
    fingerprintKey: secrets.keys.exposureFingerprint, shuttingDown,
    session: {
      unseal, identityKey, providerAuthority, resolveAccount, alphaEnabled: alphaConfig.enabled,
      readAlphaSession: id => alphaStore!.readSession(id, { touch: false }),
      readOwnedSession: input => alphaPrivacyStore!.readHostedProviderSession(input),
      repositoryAllowed: (access, scope) => inviteUnbound(access.repositoryScopes) || repositoryAllowed(access.repositoryScopes, scope)
    }
  });
  /* What the account can do here, by the capability document. */
  const capabilities = createCapabilityAccess({
    document: release.capabilityDocument, qualification: release.qualificationCapabilities, deployment: DEPLOYMENT_PROFILE,
    registry: { resolveCapability, assertCapabilityAvailable, legacyCapsFor, CapabilityError }, providerAuthority, githubTokenKind
  });
  /*
   * Corona's recovery: snapshots of a repository's references, their
   * comparison, and the single-use grant a restore preview hands to its
   * restore; the mutation descriptor reads that grant too.
   */
  const recovery = createRecovery({
    gh: github.gh, seal, unseal, identityKey, databaseConfigured, durableSingleUse: durableSingleUseStore, manifestMax: env.snapshotManifestMax
  });
  /* Uranus's repository audit, its kept history and watch, the team's decisions and the merge gate; the governed merge, sign-out and shutdown reach it as well as its routes. */
  const codeAudit = createCodeAuditService({
    databaseConfigured, pool, identityKey, gh: github.gh, dbReady: ready, governanceStore: governance.ensureGovernanceStore,
    resolveAuthorization: input => authorizationResolver.resolve(input), reader: exposureReader
  });

  return {
    database, pool, ready, apiRateLimitStore, durableSingleUseStore, githubAppRecords, seal, unseal, alphaStore, alphaPrivacyStore,
    writeCookie, closeLiveSessions, sessions, security, safety, evidenceChain, liveHub, githubAppBroker, resolveAccount,
    shutdown, governance, mutationGateway, github, authorizationResolver, exposure, capabilities, recovery, codeAudit
  };
}

export type Core = ReturnType<typeof composeCore>;
