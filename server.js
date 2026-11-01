/* ============================================================
   NEBULAVERSE-X — server.js
   Visual Git operations and repository intelligence platform. Render-ready.
   v2 adds: Pull Requests · Issues · Releases · Branch compare
            Batch (staged) atomic commits · File rename · File history
            Repo zip download · Rate-limit meter · Branch delete
   Plus the v1 core: repos, branches, lazy tree, files, editor commits,
   commit history + diffs, code search, and the smart upload router
   (Git Data API ≤40MB · native Git push up to the configured memory-safe ceiling · automatic Git LFS above it).
   ============================================================ */

const express = require('express');
const crypto = require('crypto');
/* The timed fetch every provider call goes through (apps/api/src/platform/network/timed-fetch.ts). */
const { fetchWithDeadline: fetchT } = require('./apps/api/src/platform/network/timed-fetch.ts');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  CapabilityError, loadCapabilityDocument, projectCapabilities,
  resolveCapability, assertCapabilityAvailable, legacyCapsFor
} = require('./src/capability-registry');
const {
  githubTokenKind, validateRepositoryCreation, githubRepositoryScopes, validateCodeQuery, scopedCodeQuery,
  GithubAppError, createGithubAppState, verifyGithubAppState, GithubAppBroker,
  resolveProviderAccount, createGithubRestClient
} = require('./apps/api/src/modules/github-provider/index.ts');
const CAPABILITY_DOCUMENT = loadCapabilityDocument(
  path.join(__dirname, 'config', 'public-alpha-capabilities.json')
);
const DEPLOYMENT_PROFILE = 'hosted-alpha';
/* A staging deployment's capabilities awaiting the proof only it can give; empty everywhere else. */
const QUALIFICATION_CAPABILITIES = require('./src/qualification-capabilities')
  .loadQualificationCapabilities(process.env, CAPABILITY_DOCUMENT, { deployment: DEPLOYMENT_PROFILE });
const {
  evidenceKeyrings, createEvidenceChain, defaultSafety, createSafetyState, scopedEvidenceKey,
  safetyOf, protectedPatternsForReq, protectedPathError, enforceProtectedPaths, guardSafety,
  createSnapshotSignatures, loadSnapshotSigningConfig, createRecovery,
  registerCommitRecoveryRoutes, registerSafeguardRoutes, registerSnapshotRoutes, registerAccessSurfaceRoutes, registerEvidenceRoutes
} = require('./apps/api/src/modules/corona/index.ts');
const { cleanText } = require('./apps/api/src/platform/values/text.ts');
const {
  createLiveHub, createWebhookLimiter, createWebhookIntake, publicCallbackBase, registerActivityRoutes, registerLiveEventRoutes
} = require('./apps/api/src/modules/pulsar/index.ts');
const { loadTrustedProxies } = require('./apps/api/src/platform/config/config.ts');
const { loadServerSecrets, loadServerSettings } = require('./apps/api/src/platform/config/server-settings.ts');
const {
  AlphaAccessStore,
  AlphaPrivacyStore,
  createAlphaPrivacyRetention,
  alphaActorLabel,
  providerResourceKeyHash,
  repositoryAllowed,
  inviteUnbound,
  createAlphaSessions,
  registerAlphaAccessRoutes,
  registerAccountRoutes,
  registerSignOutRoute,
  registerMeRoute,
  registerAlphaPrivacyRoutes,
  registerAlphaDisconnectRoutes,
  createGithubAppConnectionView,
  registerGithubAppRoutes,
  registerSecurityRoutes,
  registerSessionContainmentRoutes,
  registerOAuthRoutes,
  identityKey,
  providerAuthority,
  assertGithubAccount,
  isGithubAccount,
  createProviderSessions,
  createSessionSecurity,
  createRequestGuards,
  createAccountLifecycle,
  createRepositoryAccess,
  CSRF_TTL_MS,
  STEP_UP_TTL_MS
} = require('./apps/api/src/modules/identity-access/index.ts');
const { PRODUCT_NAME, APP_VERSION } = require('./apps/api/src/platform/release/version.ts');
const { computeReleaseFingerprint } = require('./apps/api/src/platform/release/release-fingerprint.ts');
const { describeServerRuntime } = require('./apps/api/src/platform/release/server-runtime.ts');
const { loadWebBuild } = require('./apps/api/src/platform/release/web-build.ts');
// ADR-067/ADR-072 deliberately bind /api/version to bytes observed at startup.
// An embedded build-time digest would be circular and could attest different bytes.
// The compiled fallback (apps/api/src/platform/release/server-runtime.ts, ADR-088) still names the source it
// was built from, and names its own tree beside it.
const SERVER_RUNTIME = describeServerRuntime(__dirname);
const RELEASE_TREE_SHA256 = computeReleaseFingerprint(SERVER_RUNTIME.sourceRoot);
/*
 * The browser application as built from that tree (scripts/build-web.js). Read
 * once; the server will not start without it. servedAssetsSha256 names the
 * built bytes the way RELEASE_TREE_SHA256 names the source.
 */
const WEB_ROOT = path.join(__dirname, 'dist', 'web');
const WEB_BUILD = loadWebBuild(WEB_ROOT);
/*
 * Bound to the tree rather than the version, so every build invalidates the
 * shell cache it replaces. A stamp that only names the version leaves a
 * returning browser with new HTML and cache-first scripts from an older build.
 */
const { publicErrorBody, sendFailure } = require('./apps/api/src/http/errors.ts');
const {
  registerProbeRoutes, registerPublicFileRoutes, registerVendorRoute, registerWebhookIntakeRoute, registerWebShellRoutes,
  registerConfigRoutes, registerProviderRateRoute, registerVersionRoute, registerShellFallback
} = require('./apps/api/src/http/routes/index.ts');
const {
  retireLegacyCookies, correlationId, structuredLogging, securityHeaders, apiNoStore, SAFE_API_METHODS,
  apiSameOrigin, apiRateAdmission, jsonBody, apiMaintenance, maintenanceMode, staticFiles
} = require('./apps/api/src/http/pipeline/index.ts');
const { loadMigrations, runMigrations, verifyMigrations } = require('./apps/api/src/platform/persistence/migrations.ts');
const { scanUploadFile, scannerStatus } = require('./apps/api/src/platform/files/file-security.ts');
const { createCapabilityAccess } = require('./apps/api/src/platform/authorization/capability-access.ts');
const { rateLimitIdentity } = require('./apps/api/src/platform/rate-limit/rate-limit-identity.ts');
const { createLocalSessionPolicy } = require('./apps/api/src/platform/authorization/local-session-policy.ts');
const { createDatabasePool } = require('./apps/api/src/platform/persistence/database-pool.ts');
const { createSessionSeal, readCookie: getCookie, createSessionCookieWriter } = require('./apps/api/src/platform/authorization/session-cookie.ts');
const { createDatabaseLifecycle } = require('./apps/api/src/platform/persistence/database-lifecycle.ts');
const localSessionPolicy = createLocalSessionPolicy();
const { SingleUseStore } = require('./apps/api/src/platform/rate-limit/single-use-store.ts');
const { RateLimitStore } = require('./apps/api/src/platform/rate-limit/rate-limit-store.ts');
const { createAuthorizationResolver } = require('./apps/api/src/platform/authorization/authorization-resolver.ts');
const {
  activePolicySetStepEvaluator,
  createGovernanceApiService,
  createGovernanceContext,
  OWN_WORK,
  createGovernanceRuntime,
  GovernanceStore,
  normalizePolicyScope,
  startWebhookWorker, registerGovernanceRoutes, registerGovernanceLifecycleRoutes
} = require('./apps/api/src/modules/kepler/index.ts');
const { createMutationGateway } = require('./apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const { createRepositoryMutationContext } = require('./apps/api/src/platform/mutation-gateway/mutation-context.ts');
const { PROFILES: GUARDED_PROFILES, createGuardedSession } = require('./apps/api/src/platform/network/guarded-fetch.ts');
const {
  auditTriage: { VOCABULARY: TRIAGE_VOCABULARY },
  createCodeAuditService, mergeFactsFor, registerCodeAuditRoutes
} = require('./apps/api/src/modules/uranus/index.ts');
const { registerParallaxRoutes } = require('./apps/api/src/modules/parallax/index.ts');
const { securityContact } = require('./src/public-assets');
const {
  DEFAULT_BUDGETS: EXPOSURE_BUDGETS, startExposureWorker, resolveExposureSession: resolveStoredExposureSession,
  exposureSeverityOf, safeDisplayPath, credentialVerifier, readabilityProbe,
  exposureReader, ExposureStore, registerExposureRoutes
} = require('./apps/api/src/modules/quasar/index.ts');
const { verifyCredential } = credentialVerifier;
const { probeAnonymousReadability } = readabilityProbe;
const {
  registerWorkspacePostureRoutes, registerBranchProtectionRoutes
} = require('./apps/api/src/modules/posture/index.ts');
const {
  createCommitWriter, createRepositoryList, createLfsTransfer, createNativePush, createUploadIntake,
  assertExpectedHead, branchChangedError, requireAggregateExpectedHead,
  registerCodeownersRoute, registerRepositoryRoutes, registerContentRoutes, registerHistoryRoutes,
  registerCollaborationRoutes, registerUploadRoutes, registerFolderMoveRoute, registerDependencyAuditRoute
} = require('./apps/api/src/modules/workbench/index.ts');

const app = express();
app.set('trust proxy', loadTrustedProxies(process.env.NV_TRUSTED_PROXIES));
/* The secrets and the keys derived from them (apps/api/src/platform/config/server-settings.ts). */
const {
  port: PORT, secret: SECRET, hostingProfile: HOSTING_PROFILE, databaseMigrationMode: DATABASE_MIGRATION_MODE,
  keys: {
    sessionContent: SESSION_CONTENT_KEY, offlineCacheScope: OFFLINE_CACHE_SCOPE_KEY, githubAppStateReplay: GITHUB_APP_STATE_REPLAY_KEY,
    csrf: CSRF_SECRET, stepUp: STEP_UP_SECRET, githubAppState: GITHUB_APP_STATE_SECRET, evidenceLedger: EVIDENCE_LEDGER_SECRET,
    rateLimitIdentity: RATE_LIMIT_IDENTITY_KEY, exposureFingerprint: EXPOSURE_FINGERPRINT_KEY,
    exposureVerification: EXPOSURE_VERIFICATION_KEY, exposureVerificationSubject: EXPOSURE_VERIFICATION_SUBJECT_KEY,
    exposureReadability: EXPOSURE_READABILITY_KEY
  }
} = loadServerSecrets(process.env);
/*
 * Evidence verification holds two keyrings, assembled together in
 * Corona's evidence ledger so their retired lists cannot drift apart.
 *
 * Rows written before key separation were hashed with the raw session secret,
 * and rows written before a SESSION_SECRET rotation with a key derived from the
 * previous secret. Accepting the raw secret unconditionally would undo half the
 * point of separating the keys -- a leaked SESSION_SECRET could forge records
 * that verify, permanently -- so production accepts it only on an explicit
 * opt-in, the rule Corona's snapshot signatures already apply to legacy
 * snapshot keys. Development keeps the compatibility path.
 *
 * A deployment that declines the opt-in is not left guessing: the probe reports
 * legacyKeyRequired, so the operator can tell an unmigrated chain from real
 * tampering without having to accept the key to find out.
 */
const EVIDENCE_KEYRINGS = evidenceKeyrings(process.env, {
  sessionSecret: SECRET,
  ledgerSecret: EVIDENCE_LEDGER_SECRET
});
const SNAPSHOT_SIGNATURES = createSnapshotSignatures(loadSnapshotSigningConfig(process.env, {
  production: process.env.NODE_ENV === 'production',
  // Production uses this only to reject active-key reuse. Legacy verification
  // requires the explicit NV_SNAPSHOT_LEGACY_KEYS_JSON operator keyring.
  sessionSecret: SECRET
}));
/* Everything else the environment sets at startup (apps/api/src/platform/config/server-settings.ts). */
const {
  githubApp: GITHUB_APP_CONFIG, governanceRuntimeFailureMode: GOVERNANCE_RUNTIME_FAILURE_MODE,
  publicAlphaLimits: PUBLIC_ALPHA_LIMITS, gitDataMaxMb: GIT_DATA_MAX_MB, nativePushMaxMb: NATIVE_PUSH_MAX_MB,
  uploadMaxMb: UPLOAD_MAX_MB, uploadConcurrency: UPLOAD_CONCURRENCY, uploadTimeoutMinutes: UPLOAD_TIMEOUT_MINUTES, staleUploadHours: STALE_UPLOAD_HOURS,
  databaseUrl: DB_URL, alphaAccess: ALPHA_CONFIG, eventRetentionDays: EVENT_RETENTION_DAYS, sessionRetentionDays: SESSION_RETENTION_DAYS,
  governanceAuditSecret: GOVERNANCE_AUDIT_SECRET, liveClientsPerRepo: MAX_LIVE_CLIENTS_PER_KEY, liveClientsTotal: MAX_LIVE_CLIENTS_TOTAL,
  oauth: { clientId: OAUTH_ID, clientSecret: OAUTH_SECRET }, snapshotManifestMax: SNAPSHOT_MANIFEST_MAX, snapshotRetentionCount: SNAPSHOT_RETENTION_COUNT
} = loadServerSettings(process.env, { secret: SECRET, hostingProfile: HOSTING_PROFILE });
/* The one pool, the store's readiness and its upkeep (apps/api/src/platform/persistence/database-lifecycle.ts). */
const database = createDatabaseLifecycle({
  databaseUrl: DB_URL, migrationMode: DATABASE_MIGRATION_MODE, migrationsDirectory: path.join(__dirname, 'db', 'migrations'),
  productName: PRODUCT_NAME, eventRetentionDays: EVENT_RETENTION_DAYS, sessionRetentionDays: SESSION_RETENTION_DAYS,
  openPool: createDatabasePool, migrations: { load: loadMigrations, run: runMigrations, verify: verifyMigrations },
  onReady: () => alphaPrivacyRetention.start()
});
const { pool, ready: dbReady, invalidate: invalidateDatabaseReady } = database;
/* The session cookie, sealed under the session's own key (apps/api/src/platform/authorization/session-cookie.ts). */
const { seal, unseal } = createSessionSeal(SESSION_CONTENT_KEY);
/* The alpha's access and privacy stores (identity-access/persistence). */
const alphaStore = ALPHA_CONFIG.enabled ? new AlphaAccessStore({
  pool: {
    connect: () => pool().connect(),
    query: (...args) => pool().query(...args)
  },
  pepper: ALPHA_CONFIG.pepper,
  inviteTtlMs: ALPHA_CONFIG.inviteTtlMs,
  sessionTtlMs: ALPHA_CONFIG.sessionAbsoluteTtlMs,
  idleTtlMs: ALPHA_CONFIG.sessionIdleTtlMs
}) : null;
const alphaPrivacyStore = ALPHA_CONFIG.enabled ? new AlphaPrivacyStore({
  pool: {
    connect: () => pool().connect(),
    query: (...args) => pool().query(...args)
  },
  sessionCodec: {
    encode: seal,
    decode: unseal,
    identityKey
  }
}) : null;
const setCookieRaw = createSessionCookieWriter(() => process.env.NODE_ENV === 'production');
/* Where the provider session is kept: a row, the alpha's privacy store, or the cookie (identity-access/application/provider-sessions.ts). */
const { setSession, sessionOf, destroySession, sessionIdFromRequest: sessionSidFromRequest } = createProviderSessions({
  databaseConfigured: Boolean(DB_URL), ready: dbReady, pool, config: ALPHA_CONFIG, privacyStore: alphaPrivacyStore,
  seal, unseal, readCookie: getCookie, writeCookie: setCookieRaw, localSessionPolicy, closeLiveSessions
});
/* The session's own security: CSRF, step-up and the offline cache's scope (identity-access/application/session-security.ts). */
const {
  sessionSecurityState, clearStepUpAuthorization, ensureSessionSecurity, requestSecurityContext,
  verifyRequestCsrf, consumeStepUpAuthorization, offlineCacheScope, offlineCacheResponseBinding
} = createSessionSecurity({
  databaseConfigured: Boolean(DB_URL), durableSingleUseStore, setSession, csrfSecret: CSRF_SECRET, stepUpSecret: STEP_UP_SECRET,
  safeMethods: SAFE_API_METHODS, offlineCacheScopeKey: OFFLINE_CACHE_SCOPE_KEY, readCookie: getCookie, sessionIdFromRequest: sessionSidFromRequest
});
/*
 * A person's safety controls, kept for the identity where there is a
 * database, and the repository's evidence chain (Corona says how both are
 * kept).
 */
const { loadPersistentSafety, savePersistentSafety, saveSessionSafetyCopy, protectedPatternsForIdentity } = createSafetyState({
  databaseConfigured: Boolean(DB_URL), ready: dbReady, pool, identityKey, setSession
});
const { appendEvidence, verifyEvidenceChain } = createEvidenceChain({
  ready: dbReady, pool, ledgerSecret: EVIDENCE_LEDGER_SECRET, keyring: EVIDENCE_KEYRINGS.keyring,
  legacyProbe: EVIDENCE_KEYRINGS.legacyProbe, legacyAccepted: EVIDENCE_KEYRINGS.legacyAccepted
});
/* The live streams open on this instance (apps/api/src/modules/pulsar/application/live-hub.ts). */
const liveHub = createLiveHub({ maxTotal: MAX_LIVE_CLIENTS_TOTAL, maxPerKey: MAX_LIVE_CLIENTS_PER_KEY });
const githubAppBroker = GITHUB_APP_CONFIG.enabled ? new GithubAppBroker(GITHUB_APP_CONFIG, {
  audit(event) {
    return recordGithubAppAudit(
      String(event && event.identityKey || 'system:github-app'),
      String(event && event.type || 'authorization.refreshed'),
      event && event.installationId,
      event || {}
    );
  }
}) : null;
const governanceRuntime = createGovernanceRuntime({
  failureMode: GOVERNANCE_RUNTIME_FAILURE_MODE,
  onError(event) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), warn: 'runtime policy evaluation unavailable',
      code: event && event.code || 'POLICY_EVALUATION_FAILED',
      action: event && event.action || 'unknown',
      scopeKey: event && event.scopeKey || 'unknown',
      failureMode: GOVERNANCE_RUNTIME_FAILURE_MODE
    }));
  },
  store: {
    async evaluateAndAppendPolicyDecision(input) {
      if (!(await dbReady())) {
        throw Object.assign(new Error('Governance runtime requires PostgreSQL'), {
          status: 503, code: 'GOVERNANCE_DATABASE_REQUIRED'
        });
      }
      return ensureGovernanceStore().evaluateAndAppendPolicyDecision(input);
    }
  }
});
/* The gateway is handed its policy port here, the one place both are built; it imports no policy module. */
const mutationGateway = createMutationGateway({
  policyEvaluator: governanceRuntime,
  eventSink(event) {
    if (!event || !['policy.evaluated', 'policy.blocked'].includes(event.type)) return;
    console.log(JSON.stringify({
      t: new Date().toISOString(), event: event.type, mutationId: event.mutationId, action: event.action,
      scopeKey: event.scopeKey, outcome: event.enforcementOutcome || null, blockCode: event.blockCode || null,
      warningCodes: event.warningCodes || [], decisionId: event.decisionId || null
    }));
  }
});
const authorizationResolver = createAuthorizationResolver({
  request: async ({ account, apiPath }) => gh(account, apiPath)
});

const MB = 1024 * 1024;
const CONTENTS_MAX = 40 * MB;
const BLOB_MAX = GIT_DATA_MAX_MB * MB;
const GIT_PUSH_MAX = NATIVE_PUSH_MAX_MB * MB; /* Memory-safe ceiling; GitHub's absolute non-LFS object ceiling is 100 MB. */
const UPLOAD_MAX = UPLOAD_MAX_MB * MB;
const UPLOAD_TIMEOUT_MS = UPLOAD_TIMEOUT_MINUTES * 60 * 1000;
async function scanUploadOrThrow(req, tmp, repoPath, size) {
  const result = await scanUploadFile(tmp, { repoPath, size });
  if (result.blocked) {
    const matches = (result.matches || []).map(match => ({
      engine: cleanText(match.engine || 'signature', 40),
      rule: cleanText(match.rule || 'MATCH', 128),
      severity: cleanText(match.severity || 'critical', 20)
    }));
    if (req.params && req.params.owner && req.params.repo) {
      appendEvidence(scopedEvidenceKey(req.gh.provider || 'github', req.params.owner, req.params.repo, identityKey(req.gh)), 'malware-blocked', crypto.randomUUID(), {
        actor: retainedActor(req),
        path: cleanText(repoPath || 'batch blob', 500),
        size: Number(size || 0),
        matches,
        blockedAt: new Date().toISOString()
      }).catch(() => {});
    }
    const error = new Error(`Upload blocked by malware signature rule: ${matches.map(match => match.rule).join(', ')}`);
    error.status = 422;
    error.code = 'MALWARE_DETECTED';
    throw error;
  }
  return {
    builtin: { available: true, matches: (result.builtin && result.builtin.matches || []).length },
    yara: {
      configured: !!(result.yara && result.yara.configured),
      available: !!(result.yara && result.yara.available),
      matches: (result.yara && result.yara.matches || []).length,
      ...(result.yara && result.yara.error ? { error: cleanText(result.yara.error, 240) } : {})
    }
  };
}

const STALE_UPLOAD_AGE_MS = STALE_UPLOAD_HOURS * 60 * 60 * 1000;
async function cleanupStaleUploads() {
  const tempRoot = os.tmpdir();
  let names = [];
  try { names = await fsp.readdir(tempRoot); } catch { return; }
  const cutoff = Date.now() - STALE_UPLOAD_AGE_MS;
  await Promise.allSettled(names
    .filter(name => /^nv-[0-9a-f]{16}$/.test(name))
    .map(async name => {
      const file = path.join(tempRoot, name);
      const stat = await fsp.lstat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
    }));
}
function startTempMaintenance() {
  cleanupStaleUploads().catch(() => {});
  const timer = setInterval(() => cleanupStaleUploads().catch(() => {}), Math.max(STALE_UPLOAD_AGE_MS, 60 * 60 * 1000));
  if (typeof timer.unref === 'function') timer.unref();
}

app.disable('x-powered-by');
/*
 * The global pipeline, in the order the route policy records. Each step is
 * built in apps/api/src/http/pipeline; where it is installed among the routes
 * is policy, so that stays here.
 */
app.use(retireLegacyCookies(process.env));
app.use(correlationId());
app.use(structuredLogging());
app.use(securityHeaders(process.env));
app.use('/api', apiNoStore(offlineCacheResponseBinding));
app.use('/api', apiSameOrigin(process.env));
/*
 * Per-session rate limit: 300 API req/min.
 *
 * The bucket key is derived from the unsealed session rather than from the
 * cookie as it arrived. A caller cannot forge a sealed payload without
 * SESSION_SECRET, so it cannot mint bucket identities, and the fields the
 * derivation reads survive a reseal, so writing a session back no longer
 * returns it to zero. apps/api/src/platform/rate-limit/rate-limit-identity.ts records what the previous
 * key did instead.
 */
function apiRateLimitStore() {
  if (!DB_URL) return null;
  if (!_rateLimitStore) _rateLimitStore = new RateLimitStore({ pool: pool() });
  return _rateLimitStore;
}
app.use('/api', apiRateAdmission({
  identify: req => rateLimitIdentity({
    session: unseal(getCookie(req, 'nv_session') || ''),
    address: req.ip,
    hmacKey: RATE_LIMIT_IDENTITY_KEY,
    namespace: 'api'
  }).key,
  counter: apiRateLimitStore
}));
/* Maintenance mode, read once at startup (apps/api/src/http/pipeline/maintenance.ts says why). */
const MAINTENANCE_MODE = maintenanceMode(process.env);

/*
 * Opaque and fresh each time the process starts: a restart is something an
 * operator has to be able to see happen, without the process saying how long
 * it has been up.
 */
const BOOT_ID = crypto.randomUUID();
/* The platform's probes: liveness and readiness (apps/api/src/http/routes/probes.ts). */
registerProbeRoutes(app, {
  maintenance: MAINTENANCE_MODE, bootId: BOOT_ID, hostedAlpha: HOSTING_PROFILE === 'hosted-alpha',
  databaseConfigured: () => Boolean(DB_URL), databaseReady: () => dbReady(), selectOne: () => pool().query('SELECT 1'),
  readiness: database.readiness, migration: database.migration, invalidateDatabaseReady
});
/* The public files: security.txt, robots.txt and the home-screen icon (apps/api/src/http/routes/public-files.ts). */
registerPublicFileRoutes(app, {
  securityContact: () => securityContact(process.env.NV_SECURITY_CONTACT),
  configuredOrigin: () => String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''),
  webRoot: WEB_ROOT
});

/* The browser's libraries and fonts from this origin (apps/api/src/http/routes/vendor.ts). */
registerVendorRoute(app, { fetch: fetchT, vendorRoot: path.join(__dirname, 'public', 'vendor') });
/* GitHub's webhook deliveries: the sender's rate, then the delivery (Pulsar's webhook limiter and intake). */
const { allowWebhookRequest } = createWebhookLimiter({ counter: apiRateLimitStore });
const { receiveGithubWebhook } = createWebhookIntake({
  allow: allowWebhookRequest, ready: dbReady, pool, unseal, protectedPatternsForIdentity,
  evidenceKey: scopedEvidenceKey, appendEvidence, liveHub
});
/* Read raw for their signature, before the JSON parser (http/routes/webhook-intake.ts). */
registerWebhookIntakeRoute(app, { receiveGithubWebhook });
app.use(jsonBody());
/* The page and its service worker (http/routes/public-files.ts). */
registerWebShellRoutes(app, { webBuild: WEB_BUILD });
app.use('/api', apiMaintenance(MAINTENANCE_MODE));
app.use(staticFiles(WEB_ROOT));

const ALPHA_SESSION_ID = Symbol('alpha session id');

const alphaSessions = createAlphaSessions({
  config: ALPHA_CONFIG,
  store: alphaStore,
  seal,
  unseal,
  getCookie,
  sessionIdKey: ALPHA_SESSION_ID,
  production: () => process.env.NODE_ENV === 'production'
});

registerAlphaAccessRoutes(app, { sessions: alphaSessions, config: ALPHA_CONFIG, store: alphaStore, seal, getCookie });

const alphaPrivacyRetention = createAlphaPrivacyRetention({ config: ALPHA_CONFIG, store: alphaPrivacyStore });

let _governanceStore = null;
let _governanceApiService = null;
let governanceWebhookWorker = null;
let governanceWebhookBootstrapTimer = null;
function ensureGovernanceStore() {
  if (!_governanceStore) {
    _governanceStore = new GovernanceStore(pool(), { secret: GOVERNANCE_AUDIT_SECRET });
    _governanceApiService = createGovernanceApiService({ store: _governanceStore });
    governanceWebhookWorker = startWebhookWorker({
      store: _governanceStore,
      masterSecret: GOVERNANCE_AUDIT_SECRET,
      onError(error) {
        console.error(JSON.stringify({
          t: new Date().toISOString(), warn: 'governance webhook delivery worker failed',
          code: cleanText(String(error && error.code || 'GOVERNANCE_WEBHOOK_WORKER_FAILED'), 100)
        }));
      }
    });
  }
  return _governanceStore;
}
async function bootstrapGovernanceDelivery() {
  if (!DB_URL || shuttingDown || governanceWebhookWorker) return;
  if (await dbReady()) {
    ensureGovernanceStore();
    return;
  }
  governanceWebhookBootstrapTimer = setTimeout(() => { void bootstrapGovernanceDelivery(); }, 30_000);
  if (typeof governanceWebhookBootstrapTimer.unref === 'function') governanceWebhookBootstrapTimer.unref();
}
/*
 * Exposure scanning.
 *
 * The worker starts only when the capability document says the feature is
 * available for some provider, and today it says Unavailable everywhere. That
 * is deliberate rather than a missing wire: a poller asking the database for
 * work that no route can create would spend a query every fifteen seconds of a
 * free service's budget for nothing. Raising the capability starts it, and
 * nothing else here has to change -- which is the point of gating on the
 * document rather than on a flag somebody would have to remember to set in two
 * places.
 */
let exposureWorker = null;
let _exposureStore = null;

function exposureScanningAvailable() {
  const providers = (CAPABILITY_DOCUMENT && CAPABILITY_DOCUMENT.providers) || {};
  for (const deployments of Object.values(providers)) {
    const features = (deployments && deployments[DEPLOYMENT_PROFILE]) || {};
    const tuple = features['exposure.scan'];
    if (Array.isArray(tuple) && (tuple[0] === 'Supported' || tuple[0] === 'Experimental')) return true;
  }
  return false;
}

/*
 * A scan holds no credential. It holds the identity the work belongs to, and
 * the token is resolved from a session that is still signed in at the moment
 * the scan runs -- so a disconnect, a sign-out or a revocation simply stops the
 * next read, rather than leaving a copied token in a job row for something to
 * remember to clean up.
 *
 * The identity is read from the row here rather than carried on the scan object
 * the store returns, because that object is passed around and a hashed identity
 * is not something the rest of a scan needs to hold.
 */
async function resolveExposureSession(input) {
  if (!DB_URL) return null;
  return resolveStoredExposureSession(input, {
    pool: pool(), unseal, identityKey, providerAuthority,
    resolveAccount: account => resolveProviderAccount(account, { githubAppBroker }),
    alphaEnabled: ALPHA_CONFIG.enabled,
    readAlphaSession: id => alphaStore.readSession(id, { touch: false }),
    readOwnedSession: input => alphaPrivacyStore.readHostedProviderSession(input),
    repositoryAllowed: (access, scope) => inviteUnbound(access.repositoryScopes)
      || repositoryAllowed(access.repositoryScopes, scope)
  });
}

function ensureExposureWorker() {
  if (exposureWorker || !DB_URL || shuttingDown || !exposureScanningAvailable()) return exposureWorker;
  _exposureStore = new ExposureStore({ pool: pool(), cursorKey: EXPOSURE_FINGERPRINT_KEY });
  exposureWorker = startExposureWorker({
    store: _exposureStore,
    reader: exposureReader,
    fingerprintKey: EXPOSURE_FINGERPRINT_KEY,
    sessionResolver: resolveExposureSession,
    /*
     * One connection pool per scan, pinned to validated addresses. Without it
     * every file costs a DNS lookup and a TLS handshake, which for a scan of
     * small files is most of the time the scan takes.
     */
    createTransport: () => createGuardedSession({
      profile: GUARDED_PROFILES.PROVIDER_READ,
      maxSockets: EXPOSURE_BUDGETS.readConcurrency
    })
  });
  return exposureWorker;
}

/*
 * Start the scan now rather than at the worker's next tick. The worker is
 * already one-at-a-time -- a run while one is in flight is refused -- so a
 * nudge can never overlap two scans; it only stops a reader waiting up to a
 * poll interval for work that was ready.
 */
function nudgeExposureWorker() {
  const worker = ensureExposureWorker();
  if (worker && typeof worker.run === 'function') {
    Promise.resolve().then(() => worker.run()).catch(() => { /* the next tick tries again */ });
  }
}

async function governanceService() {
  if (!(await dbReady())) {
    throw Object.assign(new Error('Governance requires the configured PostgreSQL DATABASE_URL'), {
      status: 503, code: 'GOVERNANCE_DATABASE_REQUIRED'
    });
  }
  ensureGovernanceStore();
  return _governanceApiService;
}

function safeGithubAppAuditDetails(value) {
  const source = value && typeof value === 'object' ? value : {};
  const clean = {};
  for (const field of ['actor', 'accountType', 'repositorySelection', 'status', 'expiresAt', 'reasonCode']) {
    if (source[field] != null) clean[field] = cleanText(String(source[field]), field === 'expiresAt' ? 80 : 120);
  }
  if (source.permissions && typeof source.permissions === 'object' && !Array.isArray(source.permissions)) {
    clean.permissions = Object.fromEntries(Object.entries(source.permissions)
      .filter(([key, permission]) => /^[a-z_]{1,80}$/.test(key) && ['read', 'write', 'admin'].includes(String(permission)))
      .slice(0, 100));
  }
  return clean;
}
async function retainedProviderActor(identity) {
  if (!ALPHA_CONFIG.enabled || !(await dbReady())) return '';
  const result = await pool().query(
    `SELECT DISTINCT tester_id FROM nv_alpha_provider_bindings
      WHERE identity_key=$1 AND disconnected_at IS NULL
      ORDER BY tester_id LIMIT 2`,
    [identity]
  );
  return result.rows.length === 1
    ? alphaActorLabel({ testerId: result.rows[0].tester_id })
    : '';
}
async function recordGithubAppAudit(identity, eventType, installationId, details = {}) {
  const identityKeyValue = cleanText(String(identity || 'system:github-app'), 128);
  const type = cleanText(String(eventType || 'github-app.event'), 100);
  const id = Number(installationId);
  const safeId = !ALPHA_CONFIG.enabled && Number.isSafeInteger(id) && id > 0 ? id : null;
  const safeDetails = safeGithubAppAuditDetails(details);
  if (ALPHA_CONFIG.enabled) {
    const supplied = /^alpha:[0-9a-f]{12}$/.test(String(safeDetails.actor || ''))
      ? safeDetails.actor
      : '';
    const actor = supplied || await retainedProviderActor(identityKeyValue);
    if (actor) safeDetails.actor = actor;
    else delete safeDetails.actor;
  }
  console.log(JSON.stringify({
    t: new Date().toISOString(), event: 'github-app-lifecycle', type,
    identityKey: identityKeyValue, installationId: safeId, details: safeDetails
  }));
  if (!(await dbReady())) return false;
  await pool().query(
    `INSERT INTO nv_github_app_audit(event_id,identity_key,event_type,installation_id,details,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,now())`,
    [crypto.randomUUID(), identityKeyValue, type, safeId, JSON.stringify(safeDetails)]
  );
  return true;
}
async function persistGithubAppInstallation(identity, installation, authorizedUser, status = 'connected') {
  if (ALPHA_CONFIG.enabled) return false;
  if (!(await dbReady())) return false;
  await pool().query(
    `INSERT INTO nv_github_app_installations(
       identity_key,installation_id,account_login,account_id,account_type,authorized_by_login,authorized_by_id,
       repository_selection,permissions,status,suspended_at,connected_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now(),now())
     ON CONFLICT(identity_key,installation_id) DO UPDATE SET
       account_login=EXCLUDED.account_login,account_id=EXCLUDED.account_id,account_type=EXCLUDED.account_type,
       authorized_by_login=EXCLUDED.authorized_by_login,authorized_by_id=EXCLUDED.authorized_by_id,
       repository_selection=EXCLUDED.repository_selection,permissions=EXCLUDED.permissions,status=EXCLUDED.status,
       suspended_at=EXCLUDED.suspended_at,updated_at=now()`,
    [
      identity, installation.id, installation.account.login, installation.account.id, installation.account.type,
      authorizedUser.login, authorizedUser.id, installation.repositorySelection,
      JSON.stringify(installation.permissions || {}), status, installation.suspendedAt || null
    ]
  );
  return true;
}
async function removeGithubAppInstallation(identity, installationId) {
  if (!(await dbReady())) return false;
  await pool().query(
    'DELETE FROM nv_github_app_installations WHERE identity_key=$1 AND installation_id=$2',
    [identity, installationId]
  );
  return true;
}
const ACCOUNT_CAP = () => (DB_URL ? 10 : 3);

function closeLiveSessions(sessionIds, reason = 'session-revoked') {
  return liveHub.closeSessions(sessionIds, reason);
}
let _singleUseStore = null;
let _rateLimitStore = null;
/*
 * The shared single-use guard: the step-up grants' where a database is
 * configured, and the GitHub App's and the recovery's OAuth and authorization
 * claims (identity-access/application/session-security.ts says why the guard
 * is chosen by configuration).
 */
function durableSingleUseStore() {
  if (!_singleUseStore) _singleUseStore = new SingleUseStore({ pool: pool() });
  return _singleUseStore;
}
/* The guards a request passes before a route reads or changes anything (identity-access/application/request-guards.ts). */
const { providerSessionAccess, auth, signedOutWithoutGithub, accountAuth } = createRequestGuards({
  sessionOf, resolveAccount: account => resolveProviderAccount(account, { githubAppBroker }), ensureSessionSecurity, verifyRequestCsrf,
  consumeStepUpAuthorization, loadSafety: loadPersistentSafety, guardSafety
});

/* GitHub's REST API and the archive transport (apps/api/src/modules/github-provider/client/github-rest.ts). */
const { gh, githubArchiveResponse } = createGithubRestClient({
  fetch: fetchT, assertProviderMutation: descriptor => mutationGateway.assertProviderMutation(descriptor),
  userAgent: `${PRODUCT_NAME}/${APP_VERSION}`, transferTimeoutMs: UPLOAD_TIMEOUT_MS, appBroker: githubAppBroker, alphaEnabled: ALPHA_CONFIG.enabled
});
/* A failed request's answer (apps/api/src/http/errors.ts). */
const fail = sendFailure;
/* Which repositories a request may reach, and the guards around a repository's own lifecycle (identity-access/application/repository-access.ts). */
const {
  retainedActor, alphaRepositoryAccess, alphaRepositoryListAllowed, alphaRepositoryListAccess, repositoryCreationAccess,
  repositoryDeletionConfirmation, githubSearchAccess, alphaStepUpRepositoryAccess, alphaSafetyView, alphaSafetyMutationAccess
} = createRepositoryAccess({
  alphaEnabled: ALPHA_CONFIG.enabled, fail, defaultSafety,
  validateRepositoryCreation, validateCodeQuery, githubRepositoryScopes, scopedCodeQuery
});
/* What the account can do here, by the capability document (platform/authorization/capability-access.ts). */
const {
  providerCapabilities, providerCapabilityContext, capabilityAccess, capabilityAccessWhen, requestSupportsCapability, assertProviderBoundLfs
} = createCapabilityAccess({
  document: CAPABILITY_DOCUMENT, qualification: QUALIFICATION_CAPABILITIES, deployment: DEPLOYMENT_PROFILE,
  registry: { resolveCapability, assertCapabilityAvailable, legacyCapsFor, CapabilityError }, providerAuthority, githubTokenKind
});

/* The context a repository change runs in (platform/mutation-gateway/mutation-context.ts). */
const { mutationContext } = createRepositoryMutationContext({
  gateway: mutationGateway, identityKey, retainedActor, resolveAuthorization: input => authorizationResolver.resolve(input),
  alphaEnabled: ALPHA_CONFIG.enabled, alphaActorLabel,
  mergeFacts: req => mergeFactsFor(codeAudit, { account: req.gh, owner: req.params.owner, repo: req.params.repo }, req.params.num),
  inspectRestoreAuthorization: (target, authorization) => recovery.inspectRestoreAuthorization(target, authorization),
  ready: dbReady, resolveActivePolicySet: input => ensureGovernanceStore().resolveActivePolicySetInScope(input),
  stepEvaluator: activePolicySetStepEvaluator, fail
});
/* Who may read and change a repository's governance, and the context a governance change runs in (Kepler's governance context). */
const { governanceAccess, governanceMutationContext } = createGovernanceContext({
  gateway: mutationGateway, governanceService, resolveAuthorization: input => authorizationResolver.resolve(input), identityKey, retainedActor
});

/* An account's life in a session: who it is, signing it in, disconnecting it, and the identity's sessions elsewhere (identity-access/application/account-lifecycle.ts). */
const {
  providerIdentity, disconnectAlphaProviderAccount, clearProviderSessionCookie, revokeContainedSessions, addAccount, sessionsForIdentity
} = createAccountLifecycle({
  alphaEnabled: ALPHA_CONFIG.enabled, databaseConfigured: Boolean(DB_URL), accountCap: ACCOUNT_CAP, ready: dbReady, pool, gh,
  resolveAccount: account => resolveProviderAccount(account, { githubAppBroker }), appBroker: githubAppBroker,
  removeGithubAppInstallation, recordGithubAppAudit, retainedActor,
  forgetJobs: account => { codeAudit.jobs.forget(identityKey(account)); siteJobs.forget(identityKey(account)); renderedJobs.forget(identityKey(account)); },
  sessionOf, setSession, sessionIdFromRequest: sessionSidFromRequest, clearStepUpAuthorization,
  readCookie: getCookie, writeCookie: setCookieRaw, seal, unseal, closeLiveSessions, privacyStore: alphaPrivacyStore
});
/* An App connection as the browser sees it (apps/api/src/modules/identity-access/http/github-app-routes.ts). */
const githubAppConnectionView = createGithubAppConnectionView({ config: ALPHA_CONFIG, identityKey });
/* Accounts: sign-in with a token, the list, switching and removing one (apps/api/src/modules/identity-access/http/account-routes.ts). */
const accountDeps = {
  accountAuth, config: ALPHA_CONFIG, fail, providerIdentity, addAccount, signedOutWithoutGithub, retainedActor,
  githubAppConnectionView, isGithubAccount, clearStepUpAuthorization, setSession, sessionOf, destroySession,
  disconnectProviderAccounts: disconnectAlphaProviderAccount, clearProviderSessionCookie
};
registerAccountRoutes(app, accountDeps);
/* ---- OAuth (activates when GITHUB_CLIENT_ID/SECRET env vars are set) ---- */
/* The deployment's configuration and capabilities, and the account's (apps/api/src/http/routes/config.ts). */
registerConfigRoutes(app, {
  providerSessionAccess,
  hostedConfig: () => ({
    profile: HOSTING_PROFILE, alphaMode: ALPHA_CONFIG.mode, termsVersion: ALPHA_CONFIG.termsVersion,
    limits: PUBLIC_ALPHA_LIMITS, database: database.readiness()
  }),
  oauth: !!(OAUTH_ID && OAUTH_SECRET),
  githubApp: { enabled: !!GITHUB_APP_CONFIG.enabled, webhookConfigured: !!GITHUB_APP_CONFIG.webhookConfigured },
  /* Published because the browser labels queued files against them; a copy
   * written into the browser would be a second source of truth. */
  uploads: { uploadMaxMb: UPLOAD_MAX_MB, gitDataMaxMb: GIT_DATA_MAX_MB, nativePushMaxMb: NATIVE_PUSH_MAX_MB, contentsMaxMb: CONTENTS_MAX / MB },
  qualificationCapabilities: QUALIFICATION_CAPABILITIES,
  projectCapabilities: context => projectCapabilities(CAPABILITY_DOCUMENT, context),
  deployment: DEPLOYMENT_PROFILE,
  accountCapabilityContext: providerCapabilityContext, account: req => req.gh
});
/* A GitHub App connection, the session's own security and OAuth sign-in (apps/api/src/modules/identity-access/http). */
registerGithubAppRoutes(app, {
  auth, accountAuth, fail, config: ALPHA_CONFIG, identityKey, githubApp: GITHUB_APP_CONFIG, broker: () => githubAppBroker,
  client: { AppError: GithubAppError, createState: createGithubAppState, verifyState: verifyGithubAppState },
  stateSecret: GITHUB_APP_STATE_SECRET, replayKey: GITHUB_APP_STATE_REPLAY_KEY,
  databaseConfigured: () => Boolean(DB_URL), durableSingleUseStore, connectionView: githubAppConnectionView,
  providerIdentity, requestSecurityContext, sessionSecurityState, ensureSessionSecurity, sessionOf, setSession, destroySession,
  addAccount, clearStepUpAuthorization, disconnectProviderAccounts: disconnectAlphaProviderAccount, clearProviderSessionCookie,
  persistGithubAppInstallation, recordGithubAppAudit, retainedActor
});
registerSecurityRoutes(app, {
  auth, accountAuth, providerSessionAccess, capabilityAccess, alphaStepUpRepositoryAccess, fail,
  csrf: { secret: CSRF_SECRET, ttlMs: CSRF_TTL_MS }, stepUp: { secret: STEP_UP_SECRET, ttlMs: STEP_UP_TTL_MS },
  requestSecurityContext, sessionSecurityState, setSession, providerIdentity,
  getInstallation: installationId => githubAppBroker.getInstallation(installationId), identityKey, scannerStatus
});
registerOAuthRoutes(app, {
  oauth: { clientId: OAUTH_ID, clientSecret: OAUTH_SECRET }, production: () => process.env.NODE_ENV === 'production',
  getCookie, fetch: fetchT, gh, addAccount
});
/* A tester's own data, signing out and who the account is (apps/api/src/modules/identity-access/http). */
registerAlphaPrivacyRoutes(app, { config: ALPHA_CONFIG, privacyStore: alphaPrivacyStore, releaseVersion: APP_VERSION });
registerSignOutRoute(app, accountDeps);
registerAlphaDisconnectRoutes(app, {
  config: ALPHA_CONFIG, privacyStore: alphaPrivacyStore, accountAuth, fail, sessions: alphaSessions,
  disconnectProviderAccounts: disconnectAlphaProviderAccount, clearProviderSessionCookie
});
registerMeRoute(app, {
  accountAuth, config: ALPHA_CONFIG, fail, signedOutWithoutGithub, isGithubAccount, retainedActor,
  githubAppConnectionView, gh, providerCapabilities, offlineCacheScope, releaseVersion: APP_VERSION
});
/* The account's GitHub API budget (apps/api/src/http/routes/provider-rate.ts). */
registerProviderRateRoute(app, { auth, capabilityAccess, account: req => req.gh, fail, gh });

/* Posture: the workspace posture, the security posture and the findings inbox (apps/api/src/modules/posture/http/posture-routes.ts). */
registerWorkspacePostureRoutes(app, {
  providerSessionAccess, capabilityAccess, auth, account: req => req.gh, fail,
  gh, dbReady, pool, identityKey, normalizePolicyScope,
  databaseConfigured: Boolean(DB_URL), maintenance: MAINTENANCE_MODE, hostedAlpha: HOSTING_PROFILE === 'hosted-alpha',
  auditHistory: () => codeAudit.history(), exposureService, governanceStore: ensureGovernanceStore,
  severityOf: exposureSeverityOf, displayPath: safeDisplayPath, triageVocabulary: TRIAGE_VOCABULARY
});

/*
 * The workbench's services: the commit writer every content change goes
 * through, Corona's recoveries included; the repositories a session may see,
 * through the hosted alpha's list filter; Git LFS storage; the native Git
 * push; and the intake every upload arrives through.
 */
const commitWriter = createCommitWriter(gh);
const { commitTree } = commitWriter;
const listRepositories = createRepositoryList({ gh, account: req => req.gh, listAllowed: alphaRepositoryListAllowed });
const assertProviderMutation = target => mutationGateway.assertProviderMutation(target);
const lfsTransfer = createLfsTransfer({
  fetch: fetchT, gh, commits: commitWriter, assertProviderBoundLfs, assertProviderMutation, transferTimeoutMs: UPLOAD_TIMEOUT_MS
});
const nativePush = createNativePush({
  gh, fetch: fetchT, assertProviderMutation, assertGithubAccount, maxBytes: GIT_PUSH_MAX, maxMegabytes: NATIVE_PUSH_MAX_MB
});
const uploadIntake = createUploadIntake({ concurrency: UPLOAD_CONCURRENCY, timeoutMs: UPLOAD_TIMEOUT_MS });

/* Workbench: who owns what in a repository, by its CODEOWNERS file (apps/api/src/modules/workbench/http/codeowners-route.ts). */
registerCodeownersRoute(app, { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account: req => req.gh, fail, gh });

/* Kepler: governance -- templates and baselines, the digital twin, notifications, webhooks, exports, policies, reviews and exceptions (apps/api/src/modules/kepler/http/governance-routes.ts). */
registerGovernanceRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, governanceAccess, governanceMutationContext,
  governance: req => req.governance, account: req => req.gh, gh
});

/*
 * Quasar's store of exposure scans, the one the scan worker writes. Without the
 * configured database there is none, and every route that reads it says so.
 */
function exposureService() {
  if (!DB_URL) {
    throw Object.assign(new Error('Exposure scanning requires the configured PostgreSQL DATABASE_URL'), {
      status: 503, code: 'EXPOSURE_DATABASE_REQUIRED'
    });
  }
  if (!_exposureStore) _exposureStore = new ExposureStore({ pool: pool(), cursorKey: EXPOSURE_FINGERPRINT_KEY });
  return _exposureStore;
}

/* Quasar: exposure scans, their findings, and the questions a finding can be asked (apps/api/src/modules/quasar/http/exposure-routes.ts). */
registerExposureRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth,
  governanceAccess, OWN_WORK, governanceMutationContext,
  governance: req => req.governance, account: req => req.gh,
  retainedActor, publicErrorBody, exposureService, nudgeWorker: nudgeExposureWorker,
  keys: {
    fingerprint: EXPOSURE_FINGERPRINT_KEY, verification: EXPOSURE_VERIFICATION_KEY,
    verificationSubject: EXPOSURE_VERIFICATION_SUBJECT_KEY, readability: EXPOSURE_READABILITY_KEY
  },
  reader: exposureReader, verifyCredential, probeReadability: probeAnonymousReadability
});

/* Kepler: the rest of a policy's life -- revocation, activation and rollback, deactivation, archive and restore, withdrawal, and a reset (http/governance-routes.ts). */
registerGovernanceLifecycleRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, governanceAccess, governanceMutationContext,
  governance: req => req.governance, account: req => req.gh, gh
});

/* Workbench: repositories, branches and comparisons; folders, files and their writes; commits and a revert (apps/api/src/modules/workbench/http/). */
registerRepositoryRoutes(app, {
  providerSessionAccess, alphaRepositoryListAccess, alphaRepositoryAccess, capabilityAccess,
  repositoryCreationAccess, repositoryDeletionConfirmation, auth, mutationContext, account: req => req.gh, fail, gh,
  listRepositories, archiveResponse: githubArchiveResponse
});
registerContentRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  ghRaw: (acct, apiPath, options) => gh(acct, apiPath, { ...options, raw: true }),
  commits: commitWriter, lfs: lfsTransfer, assertProviderBoundLfs,
  executionSnapshot: () => mutationGateway.executionSnapshot()
});
registerHistoryRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  commits: commitWriter, protectedPathError
});
/* Corona: a repository or some of its paths restored as a new commit, a commit's file listing, and a branch moved back (apps/api/src/modules/corona/http/recovery-routes.ts). */
registerCommitRecoveryRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  commitTree, enforceProtectedPaths, assertExpectedHead, branchChangedError, requireAggregateExpectedHead
});

/* Workbench: code search, pull requests, issues, notifications and global search, stars, workflow runs and releases (apps/api/src/modules/workbench/http/collaboration-routes.ts). */
registerCollaborationRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, githubSearchAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  alphaRepositories: req => (ALPHA_CONFIG.enabled ? githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes) : null),
  protectedPatternsForReq, enforceProtectedPaths
});
/* Workbench: a blob for a batch commit, and one file uploaded by the transport its size allows (http/upload-routes.ts). */
registerUploadRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, capabilityAccessWhen, auth, mutationContext, account: req => req.gh, fail, gh,
  commits: commitWriter, intake: uploadIntake, nativePush, lfs: lfsTransfer,
  limits: { blobMaxBytes: BLOB_MAX, uploadMaxBytes: UPLOAD_MAX, gitPushMaxBytes: GIT_PUSH_MAX, gitDataMaxBytes: CONTENTS_MAX },
  scanUpload: scanUploadOrThrow, enforceProtectedPaths
});
/* Workbench: a folder moved in one commit (http/folder-move-route.ts). */
registerFolderMoveRoute(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  commits: commitWriter, enforceProtectedPaths
});

/* ================= SAFEGUARDS (v5.0.0) ================= */
/* Corona: the session's safeguards (apps/api/src/modules/corona/http/safeguard-routes.ts). */
registerSafeguardRoutes(app, {
  providerSessionAccess, alphaSafetyMutationAccess, accountAuth, account: req => req.gh, fail,
  safetyOf, alphaSafetyView, savePersistentSafety, saveSessionSafetyCopy, appendEvidence, retainedActor, identityKey
});

/*
 * Corona: snapshots of a repository's references, their comparison, and the
 * single-use grant a restore preview hands to its restore
 * (apps/api/src/modules/corona/application/recovery.ts); the mutation
 * descriptor reads that grant too, so the server builds it here.
 */
const recovery = createRecovery({
  gh, seal, unseal, identityKey, databaseConfigured: Boolean(DB_URL), durableSingleUse: durableSingleUseStore,
  manifestMax: SNAPSHOT_MANIFEST_MAX
});
/* Corona: snapshots, signed snapshots, the emergency manifest, and the restore a preview authorized (http/recovery-routes.ts). */
registerSnapshotRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail, gh,
  recovery, dbReady, pool, identityKey, scopedEvidenceKey, appendEvidence, signatures: SNAPSHOT_SIGNATURES,
  retentionCount: SNAPSHOT_RETENTION_COUNT, safetyOf, protectedPatternsForReq, alphaEnabled: ALPHA_CONFIG.enabled,
  savePersistentSafety, saveSessionSafetyCopy, sessionsForIdentity, revokeContainedSessions, closeLiveSessions, retainedActor,
  executionSnapshot: () => mutationGateway.executionSnapshot()
});

/* Pulsar: one repository's recent activity, and the overview's feed (apps/api/src/modules/pulsar/http/activity-routes.ts). */
registerActivityRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, alphaRepositoryListAccess, capabilityAccess, auth, account: req => req.gh, fail,
  gh: (acct, apiPath) => gh(acct, apiPath), supportsCapability: requestSupportsCapability,
  listRepositories: req => listRepositories(req), publicErrorBody
});

/* Corona: who and what can reach a repository (apps/api/src/modules/corona/http/access-surface-routes.ts). */
registerAccessSurfaceRoutes(app, { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account: req => req.gh, fail, gh });

/*
 * Uranus: the repository audit, its kept history and watch, the team's
 * decisions and the merge gate (apps/api/src/modules/uranus/application/
 * code-audit-service.ts), built once because the governed merge, sign-out and
 * shutdown reach it as well as its routes (http/code-audit-routes.ts).
 */
const codeAudit = createCodeAuditService({
  databaseConfigured: Boolean(DB_URL), pool, identityKey, gh, dbReady, governanceStore: ensureGovernanceStore,
  resolveAuthorization: input => authorizationResolver.resolve(input), reader: exposureReader
});
registerCodeAuditRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, accountAuth,
  governanceAccess, OWN_WORK, governanceMutationContext,
  governance: req => req.governance, account: req => req.gh,
  fail, publicErrorBody, retainedActor, identityKey, service: codeAudit
});

/* Parallax: the rendered audit and the anonymous site check (apps/api/src/modules/parallax/http/parallax-routes.ts). */
const { site: siteJobs, rendered: renderedJobs } = registerParallaxRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, viewer: req => identityKey(req.gh), fail
});

/* Posture: a branch's provider rules beside the server's own safeguards. */
registerBranchProtectionRoutes(app, { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account: req => req.gh, fail, gh });

/* Workbench: a repository's dependencies against the OSV database and Dependabot (apps/api/src/modules/workbench/http/dependency-audit-route.ts). */
registerDependencyAuditRoute(app, { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account: req => req.gh, fail, gh, fetch: fetchT });

/* ================= LIVE INTELLIGENCE + EVIDENCE (v5.2) ================= */
/* Pulsar: verified live events -- connection, stored events and the stream (apps/api/src/modules/pulsar/http/live-event-routes.ts). */
registerLiveEventRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account: req => req.gh, fail,
  gh, dbReady, pool, identityKey, databaseConfigured: Boolean(DB_URL), publicBase: req => publicCallbackBase(req, process.env), seal,
  scopedEvidenceKey, appendEvidence, retainedActor, providerResourceKeyHash, providerAuthority,
  alphaEnabled: ALPHA_CONFIG.enabled, alphaTesterId: req => req.alpha.testerId, alphaSessionId: req => req[ALPHA_SESSION_ID],
  readAlphaSession: (sessionId, options) => alphaStore.readSession(sessionId, options), alphaWebhooks: alphaPrivacyStore,
  sessionSid: sessionSidFromRequest, hub: liveHub
});

/* Corona: the identity's evidence chain for a repository, its events and signed snapshots (apps/api/src/modules/corona/http/evidence-routes.ts). */
registerEvidenceRoutes(app, {
  providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account: req => req.gh, fail,
  identityKey, scopedEvidenceKey, verifyEvidenceChain, dbReady, pool, signatures: SNAPSHOT_SIGNATURES
});

/* The sessions an identity holds elsewhere, and ending them (apps/api/src/modules/identity-access/http/security-routes.ts). */
registerSessionContainmentRoutes(app, { auth, fail, sessionsForIdentity, revokeContainedSessions, closeLiveSessions });

/* The build's identity, by digest (apps/api/src/http/routes/release.ts). */
registerVersionRoute(app, {
  product: PRODUCT_NAME, releaseTreeSha256: RELEASE_TREE_SHA256, servedAssetsSha256: WEB_BUILD.servedAssetsSha256,
  serverRuntime: { mode: SERVER_RUNTIME.mode, buildSha256: SERVER_RUNTIME.buildSha256 }
});
/* Last of all: the page for any route the browser owns, and a 404 for anything else (http/routes/public-files.ts). */
registerShellFallback(app, { webBuild: WEB_BUILD });
startTempMaintenance();
const httpServer = app.listen(PORT, () => console.log(`${PRODUCT_NAME} v${APP_VERSION} orbiting on :${PORT}`));
let shuttingDown = false;
void bootstrapGovernanceDelivery();
ensureExposureWorker();
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  renderedJobs.close();
  siteJobs.close();
  codeAudit.jobs.close();
  console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal }));
  liveHub.shutdown(signal);
  if (governanceWebhookBootstrapTimer) clearTimeout(governanceWebhookBootstrapTimer);
  /*
   * Drained before the pool closes. A delivery in flight has already sent its
   * request; if the pool goes first it cannot record the attempt, so its row
   * stays leased and the receiver is sent the same event again once the lease
   * expires. The force timer below still bounds this -- a batch that outlasts
   * it is cut off regardless -- but the common case, a batch part-way through,
   * now finishes.
   */
  const drainedWebhookWorker = governanceWebhookWorker ? governanceWebhookWorker.stop() : null;
  /*
   * A scan in flight is drained for a different reason than a delivery: it has
   * sent nothing irreversible, and an abandoned scan is recovered by its lease
   * expiring. Finishing the one in hand is simply cheaper than reading the
   * repository again.
   */
  const drainedExposureWorker = exposureWorker ? exposureWorker.stop() : null;
  const force = setTimeout(() => process.exit(1), 10000);
  if (typeof force.unref === 'function') force.unref();
  httpServer.close(async () => {
    try { await drainedWebhookWorker; } catch {}
    try { await drainedExposureWorker; } catch {}
    try { await database.close(); } catch {}
    clearTimeout(force);
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
