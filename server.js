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
async function fetchT(url, opts = {}, ms = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Upstream timeout after ${ms / 1000}s`)), ms);
  if (typeof timeout.unref === 'function') timeout.unref();
  let response;
  try {
    response = await fetch(url, { ...opts, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  if (!response.body) {
    clearTimeout(timeout);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timeout);
          streamController.close();
        } else streamController.enqueue(value);
      } catch (error) {
        clearTimeout(timeout);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timeout);
      try { await reader.cancel(reason); } catch {}
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
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
  resolveProviderAccount
} = require('./apps/api/src/modules/github-provider/index.ts');
const CAPABILITY_DOCUMENT = loadCapabilityDocument(
  path.join(__dirname, 'config', 'public-alpha-capabilities.json')
);
const DEPLOYMENT_PROFILE = 'hosted-alpha';
/* A staging deployment's capabilities awaiting the proof only it can give; empty everywhere else. */
const QUALIFICATION_CAPABILITIES = require('./src/qualification-capabilities')
  .loadQualificationCapabilities(process.env, CAPABILITY_DOCUMENT, { deployment: DEPLOYMENT_PROFILE });
const {
  evidenceRecordHash, verifyEvidenceRecord, evidenceKeyrings,
  protectedPatternsForRepository,
  createSnapshotSignatures, loadSnapshotSigningConfig, createRecovery,
  registerCommitRecoveryRoutes, registerSafeguardRoutes, registerSnapshotRoutes, registerAccessSurfaceRoutes, registerEvidenceRoutes
} = require('./apps/api/src/modules/corona/index.ts');
const { stableJson, hashJson } = require('./apps/api/src/platform/values/stable-hash.ts');
const { cleanText } = require('./apps/api/src/platform/values/text.ts');
const { pathMatches } = require('./apps/api/src/platform/values/path-patterns.ts');
const {
  verifyGithubSignature, normalizeGithubWebhook, riskForEvent,
  createLiveHub, registerActivityRoutes, registerLiveEventRoutes
} = require('./apps/api/src/modules/pulsar/index.ts');
const { loadTrustedProxies } = require('./apps/api/src/platform/config/config.ts');
const { loadServerSecrets, loadServerSettings } = require('./apps/api/src/platform/config/server-settings.ts');
const { databaseReadiness } = require('./apps/api/src/platform/persistence/hosted-readiness.ts');
const {
  AlphaAccessStore,
  AlphaPrivacyStore,
  alphaActorLabel,
  providerRevocationGuidance,
  disconnectProviderAccount,
  providerResourceKeyHash,
  AlphaAccessError,
  canonicalRepositoryScope,
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
  registerOAuthRoutes
} = require('./apps/api/src/modules/identity-access/index.ts');
const { PRODUCT_NAME, APP_VERSION } = require('./apps/api/src/platform/release/version.ts');
const { computeReleaseFingerprint } = require('./apps/api/src/platform/release/release-fingerprint.ts');
const { describeServerRuntime } = require('./apps/api/src/platform/release/server-runtime.ts');
const { loadWebBuild } = require('./apps/api/src/platform/release/web-build.ts');
const OFFLINE_CACHE_POLICY = require('./packages/contracts/src/offline-cache-policy.ts');
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
const { publicErrorBody } = require('./apps/api/src/http/errors.ts');
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
const {
  verifyCsrfToken, verifyStepUpGrant,
  normalizeStepUpRequest, sensitiveOperationFor, consumePendingStepUp
} = require('./apps/api/src/platform/authorization/security-foundation.ts');
const { rateLimitIdentity } = require('./apps/api/src/platform/rate-limit/rate-limit-identity.ts');
const { createLocalSessionPolicy } = require('./apps/api/src/platform/authorization/local-session-policy.ts');
const { createDatabasePool } = require('./apps/api/src/platform/persistence/database-pool.ts');
const localSessionPolicy = createLocalSessionPolicy();
const { SingleUseStore } = require('./apps/api/src/platform/rate-limit/single-use-store.ts');
const { RateLimitStore } = require('./apps/api/src/platform/rate-limit/rate-limit-store.ts');
const { createAuthorizationResolver, createUnavailableAuthorizationSnapshot, isPublicReaderAccess } = require('./apps/api/src/platform/authorization/authorization-resolver.ts');
const {
  activePolicySetStepEvaluator,
  assertGovernanceAuthorization,
  createGovernanceApiService,
  createGovernanceRuntime,
  GovernanceStore,
  normalizePolicyScope,
  startWebhookWorker, governanceFailure, registerGovernanceRoutes, registerGovernanceLifecycleRoutes
} = require('./apps/api/src/modules/kepler/index.ts');
const { createMutationGateway, normalizeMutationDescriptor } = require('./apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
const { normalizeFileBatch, summarizeBatchItems } = require('./apps/api/src/platform/mutation-gateway/mutation-coverage.ts');
const { pathFactsForAction } = require('./apps/api/src/platform/mutation-gateway/protected-paths.ts');
const { offerSafePassage } = require('./apps/api/src/platform/mutation-gateway/safe-passage.ts');
const { PROFILES: GUARDED_PROFILES, createGuardedSession } = require('./apps/api/src/platform/network/guarded-fetch.ts');
const {
  auditTriage: { unavailableGate, gateAttributes, mergeAttributes, VOCABULARY: TRIAGE_VOCABULARY },
  createCodeAuditService, registerCodeAuditRoutes
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
const EVIDENCE_LEGACY_SESSION_KEY_ACCEPTED = EVIDENCE_KEYRINGS.legacyAccepted;
const EVIDENCE_KEYRING = EVIDENCE_KEYRINGS.keyring;
const EVIDENCE_LEGACY_PROBE = EVIDENCE_KEYRINGS.legacyProbe;
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
const GH_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

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
  readiness: () => _databaseReadiness, migration: () => _databaseMigration, invalidateDatabaseReady
});
/* The public files: security.txt, robots.txt and the home-screen icon (apps/api/src/http/routes/public-files.ts). */
registerPublicFileRoutes(app, {
  securityContact: () => securityContact(process.env.NV_SECURITY_CONTACT),
  configuredOrigin: () => String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''),
  webRoot: WEB_ROOT
});

/* The browser's libraries and fonts from this origin (apps/api/src/http/routes/vendor.ts). */
registerVendorRoute(app, { fetch: fetchT, vendorRoot: path.join(__dirname, 'public', 'vendor') });
/* GitHub's webhook deliveries, read raw for their signature, before the JSON parser (http/routes/webhook-intake.ts). */
registerWebhookIntakeRoute(app, { receiveGithubWebhook });
app.use(jsonBody());
/* The page and its service worker (http/routes/public-files.ts). */
registerWebShellRoutes(app, { webBuild: WEB_BUILD });
app.use('/api', apiMaintenance(MAINTENANCE_MODE));
app.use(staticFiles(WEB_ROOT));

/* ---------------- encrypted cookie session ---------------- */
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SESSION_CONTENT_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function unseal(str) {
  try {
    const raw = Buffer.from(str, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', SESSION_CONTENT_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
/* ===== session store: Postgres (Neon/any) when DATABASE_URL is set, sealed cookie otherwise ===== */
let _pool = null;
function pool() {
  if (!_pool) {
    _pool = createDatabasePool(DB_URL, error => {
      invalidateDatabaseReady('unavailable');
      console.error(JSON.stringify({ t: new Date().toISOString(), event: 'database-idle-disconnect',
        code: /^[A-Z0-9]{5}$/.test(String(error && error.code || '')) ? error.code : 'DB_CONNECTION_FAILED' }));
    });
  }
  return _pool;
}
const ALPHA_SESSION_ID = Symbol('alpha session id');
const HOSTED_SESSION_BASE = Symbol('hosted provider session base');
const HOSTED_SESSION_REVISION = Symbol('hosted provider session revision');
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

let _dbReady = null;
let _dbRetryAfter = 0;
let _databaseGeneration = 0;
let _databaseReadiness = databaseReadiness({
  required: !!DB_URL,
  connected: !DB_URL,
  waking: !!DB_URL,
  migrationMatch: true,
  quotaWarning: false
});
let _databaseMigration = loadMigrations(path.join(__dirname, 'db', 'migrations')).at(-1)?.id || '';
async function initializeDatabase() {
  const client = await pool().connect();
  try {
    if (DATABASE_MIGRATION_MODE === 'verify') {
      const verification = await verifyMigrations(client, {
        directory: path.join(__dirname, 'db', 'migrations')
      });
      _databaseMigration = verification.expectedLatest;
      _databaseReadiness = databaseReadiness({
        required: true,
        connected: true,
        waking: false,
        migrationMatch: verification.ok,
        quotaWarning: false
      });
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        db: `${PRODUCT_NAME} migration verification complete`,
        migration: verification.expectedLatest,
        missingCount: verification.missing.length,
        changedCount: verification.changed.length,
        unknownCount: verification.unknown.length
      }));
      return verification.ok;
    }
    const result = await runMigrations(client, {
      directory: path.join(__dirname, 'db', 'migrations'),
      logger: { info(message) { console.log(JSON.stringify({ t: new Date().toISOString(), db: message })); } }
    });
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      db: `${PRODUCT_NAME} intelligence store ready`,
      migrationsApplied: result.applied.length,
      migrationsTotal: result.total
    }));
    _databaseReadiness = databaseReadiness({
      required: true,
      connected: true,
      waking: false,
      migrationMatch: true,
      quotaWarning: false
    });
    return true;
  } finally { client.release(); }
}
let _maintenanceStarted = false;
let _alphaPrivacyRetentionStarted = false;
async function cleanupDatabase() {
  if (!_pool) return;
  await Promise.all([
    pool().query(`DELETE FROM nv_intelligence_events WHERE created_at < now() - ($1::int * interval '1 day')`, [EVENT_RETENTION_DAYS]),
    pool().query(`DELETE FROM nv_sessions WHERE updated < now() - ($1::int * interval '1 day')`, [SESSION_RETENTION_DAYS]),
    pool().query(`DELETE FROM nv_governance_idempotency WHERE created_at < now() - interval '24 hours'`)
  ]).catch(error => console.error('Database retention cleanup failed:', error.message));
}
function startDatabaseMaintenance() {
  if (_maintenanceStarted) return;
  _maintenanceStarted = true;
  cleanupDatabase().catch(() => {});
  const timer = setInterval(() => cleanupDatabase().catch(() => {}), 12 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
async function runAlphaPrivacyRetention() {
  if (!ALPHA_CONFIG.enabled || !alphaPrivacyStore) return;
  try {
    const result = await alphaPrivacyStore.runRetention();
    const counts = Object.fromEntries(Object.entries(result)
      .filter(([, value]) => Number.isSafeInteger(value)));
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      alphaRetention: counts
    }));
  } catch (error) {
    console.error(JSON.stringify({
      t: new Date().toISOString(),
      warn: 'alpha privacy retention failed',
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(error && error.code || ''))
        ? error.code
        : 'ALPHA_RETENTION_FAILED'
    }));
  }
}
function startAlphaPrivacyRetention() {
  if (!ALPHA_CONFIG.enabled || !alphaPrivacyStore) return;
  if (_alphaPrivacyRetentionStarted) return;
  _alphaPrivacyRetentionStarted = true;
  void runAlphaPrivacyRetention();
  const timer = setInterval(() => { void runAlphaPrivacyRetention(); }, 24 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
function invalidateDatabaseReady(state = 'unavailable') {
  _databaseGeneration += 1;
  _dbReady = null;
  _dbRetryAfter = Date.now() + 15000;
  _databaseReadiness = databaseReadiness({
    required: true,
    connected: false,
    waking: state === 'waking',
    migrationMatch: state !== 'migration-mismatch',
    quotaWarning: false
  });
}
function dbReady() {
  if (!DB_URL) return Promise.resolve(false);
  if (_dbReady) return _dbReady;
  if (Date.now() < _dbRetryAfter) return Promise.resolve(false);
  _databaseReadiness = databaseReadiness({
    required: true,
    connected: false,
    waking: true,
    migrationMatch: true,
    quotaWarning: false
  });
  const generation = _databaseGeneration;
  _dbReady = initializeDatabase()
    .then(ok => {
      if (generation !== _databaseGeneration) {
        invalidateDatabaseReady('unavailable');
        return false;
      }
      if (ok) {
        startDatabaseMaintenance();
        startAlphaPrivacyRetention();
      }
      return ok;
    })
    .catch(e => {
      console.error('DB unavailable; retrying after a short backoff:', e.message);
      invalidateDatabaseReady('unavailable');
      return false;
    });
  return _dbReady;
}

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
function setCookieRaw(res, value, maxAge = 2592000) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nv_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
function mergeHostedSessionValue(base, desired, current) {
  if (stableJson(base) === stableJson(desired)) return structuredClone(current);
  if (
    base && desired && current
    && typeof base === 'object' && !Array.isArray(base)
    && typeof desired === 'object' && !Array.isArray(desired)
    && typeof current === 'object' && !Array.isArray(current)
  ) {
    const merged = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(desired)])) {
      if (!(key in desired) && key in base) continue;
      if (!(key in desired)) {
        merged[key] = structuredClone(current[key]);
        continue;
      }
      merged[key] = mergeHostedSessionValue(base[key], desired[key], current[key]);
    }
    return merged;
  }
  return structuredClone(desired);
}
function hostedAccountKey(account) {
  return `${String(account && account.provider || 'github')}\0${identityKey(account)}`;
}
function recomputeHostedSessionMutation(base, desired, current) {
  if (!base || !Array.isArray(base.accounts)) return structuredClone(desired);
  const next = mergeHostedSessionValue(
    { ...base, accounts: undefined, active: undefined },
    { ...desired, accounts: undefined, active: undefined },
    { ...current, accounts: undefined, active: undefined }
  );
  const currentAccounts = new Map((current.accounts || []).map(account => [hostedAccountKey(account), account]));
  const baseAccounts = new Map((base.accounts || []).map(account => [hostedAccountKey(account), account]));
  const desiredAccounts = new Map((desired.accounts || []).map(account => [hostedAccountKey(account), account]));
  for (const key of baseAccounts.keys()) if (!desiredAccounts.has(key)) currentAccounts.delete(key);
  for (const [key, account] of desiredAccounts) {
    if (!baseAccounts.has(key) || stableJson(baseAccounts.get(key)) !== stableJson(account)) {
      currentAccounts.set(key, structuredClone(account));
    }
  }
  const desiredOrder = [...desiredAccounts.keys()];
  const mergedOrder = [
    ...desiredOrder.filter(key => currentAccounts.has(key)),
    ...[...currentAccounts.keys()].filter(key => !desiredAccounts.has(key))
  ];
  next.accounts = mergedOrder.map(key => currentAccounts.get(key));
  const desiredActive = desired.accounts && desired.accounts[desired.active];
  const desiredActiveKey = desiredActive ? hostedAccountKey(desiredActive) : '';
  next.active = Math.max(0, mergedOrder.indexOf(desiredActiveKey));
  return next;
}
/*
 * retiredSelection is computed by githubSession() on each read, from the
 * accounts the session holds. Stored, it would outlive the choice that cleared
 * it, and every provider route would keep asking for an account.
 */
function persistedSession(data) {
  if (!data || typeof data !== 'object' || !('retiredSelection' in data)) return data;
  const { retiredSelection, ...stored } = data;
  return stored;
}
async function setSession(req, res, data, { createNew = false } = {}) {
  data = persistedSession(data);
  if (DB_URL) {
    if (!(await dbReady())) throw Object.assign(new Error('Session database is temporarily unavailable'), { status: 503 });
    let sid = null;
    const cur = unseal(getCookie(req, 'nv_session') || '');
    if (!createNew && cur && cur.sid) sid = cur.sid;
    const existingSid = Boolean(sid);
    if (!sid) sid = crypto.randomBytes(24).toString('hex');
    if (ALPHA_CONFIG.enabled) {
      if (!req.alpha || !req.alpha.testerId || !cur || !cur.sid) {
        throw Object.assign(new Error('Owned provider session is unavailable'), {
          status: 401, code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
        });
      }
      const base = req[HOSTED_SESSION_BASE] || structuredClone(data);
      const result = await alphaPrivacyStore.mutateHostedProviderSession({
        testerId: req.alpha.testerId,
        sessionId: sid,
        mutate(current) {
          return recomputeHostedSessionMutation(base, data, current);
        }
      }).catch(error => {
        /* Ended between the read and this write: signed out, as on the read. */
        if (error && error.code === 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') throw Object.assign(error, { status: 401 });
        throw ownedSessionRefusal(error);
      });
      req.session = result.session;
      req[HOSTED_SESSION_BASE] = structuredClone(result.session);
      req[HOSTED_SESSION_REVISION] = result.revision;
      setCookieRaw(res, seal({ sid }));
      return;
    }
    const identityKeys = [...new Set((Array.isArray(data.accounts) ? data.accounts : []).map(identityKey))];
    if (existingSid) {
      const saved = await pool().query(
        `UPDATE nv_sessions SET data=$2,identity_keys=$3::text[],revision=revision+1,updated=now() WHERE sid=$1`,
        [sid, seal(data), identityKeys]
      );
      if (!saved.rowCount) throw Object.assign(new Error('This session ended. Sign in again.'), { status: 401, code: 'SESSION_REVOKED' });
    } else {
      await pool().query('INSERT INTO nv_sessions (sid,data,identity_keys,updated) VALUES ($1,$2,$3::text[],now())', [sid, seal(data), identityKeys]);
    }
    setCookieRaw(res, seal({ sid }));
    return;
  }
  const bounded = localSessionPolicy.prepare(data);
  // Retain the original lifetime through security/account session writes.
  req.session = bounded;
  setCookieRaw(res, seal(bounded), Math.max(0, Math.ceil((bounded.lifetime.expiresAt - Date.now()) / 1000)));
}
function sessionSidFromRequest(req) {
  const current = unseal(getCookie(req, 'nv_session') || '');
  return current && typeof current.sid === 'string' ? current.sid : '';
}
async function destroySession(req, res) {
  const sid = sessionSidFromRequest(req);
  if (sid && DB_URL) {
    if (!(await dbReady())) throw Object.assign(new Error('Session database is temporarily unavailable; sign-out was not completed'), { status: 503 });
    await pool().query('DELETE FROM nv_sessions WHERE sid=$1', [sid]);
  }
  if (!DB_URL) localSessionPolicy.revoke(unseal(getCookie(req, 'nv_session') || ''));
  if (sid) closeLiveSessions([sid], 'session-ended');
  setCookieRaw(res, '', 0);
}
function githubSession(session) {
  if (!session || !Array.isArray(session.accounts)) return null;
  const selected = session.accounts[Math.min(Math.max(Number(session.active) || 0, 0), session.accounts.length - 1)];
  const accounts = session.accounts.filter(account => {
    try { assertGithubAccount(account); return true; } catch { return false; }
  });
  if (!accounts.length) return null;
  if (accounts.length === session.accounts.length) return session;
  const index = accounts.indexOf(selected);
  // Keep historical bindings for retention/privacy cleanup. Session writes
  // persist only the supported accounts; an old cookie cannot dispatch them.
  // A retired account that is still the selected one is not quietly replaced
  // by a GitHub account: the person chooses which identity acts.
  return { ...session, accounts, active: Math.max(0, index), retiredSelection: index < 0, security: { ...session.security, stepUp: null } };
}
function isGithubAccount(account) {
  try { assertGithubAccount(account); return true; } catch { return false; }
}
/*
 * The store's refusals of an owned provider session, as answers rather than
 * server faults. An ended session is handled by the caller (it is no session);
 * these are the rest: a session another tester holds, and a tester whose
 * access is gone or whose data is being deleted.
 */
function ownedSessionRefusal(error) {
  const code = error && error.code;
  if (code === 'ALPHA_PROVIDER_SESSION_OWNERSHIP_CONFLICT') {
    return Object.assign(new Error('This sign-in belongs to another alpha session'), { status: 403, code });
  }
  if (code === 'ALPHA_TESTER_REVOKED' || code === 'ALPHA_TESTER_UNAVAILABLE') {
    return Object.assign(new Error('Alpha access is required'), { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
  }
  if (code === 'ALPHA_TESTER_DELETING') {
    return Object.assign(new Error('Alpha data deletion is in progress'), { status: 409, code });
  }
  return error;
}
/*
 * An account this alpha access disconnected keeps its cleanup evidence, and is
 * not bound to the access again. That is a refusal with a way forward, made
 * before anything was connected -- not a fault to retry.
 */
function alphaConnectionRefusal(error) {
  const code = error && error.code;
  if (code === 'ALPHA_PROVIDER_LIFECYCLE_STARTED' || code === 'ALPHA_PROVIDER_BINDING_CONFLICT') {
    return Object.assign(new Error('This GitHub account was disconnected from this alpha access and cannot be connected to it again.'), {
      status: 409,
      code: 'ALPHA_PROVIDER_IDENTITY_RETIRED',
      providerChanged: false,
      safeState: 'Nothing was connected. The disconnected account stays disconnected.',
      nextAction: 'Sign in with another GitHub account, or end the alpha session and ask the operator for a new invitation to use this one.'
    });
  }
  if (code === 'ALPHA_PROVIDER_ACCOUNT_CAPACITY') {
    return Object.assign(new Error('This session already holds the most accounts it can. Remove one first.'), {
      status: 409, code, providerChanged: false, safeState: 'Nothing was connected.'
    });
  }
  return ownedSessionRefusal(error);
}
async function sessionOf(req, { retainRetiredAccounts = false } = {}) {
  const supported = session => (retainRetiredAccounts && session && Array.isArray(session.accounts) && session.accounts.length
    ? session
    : githubSession(session));
  const s = unseal(getCookie(req, 'nv_session') || '');
  if (!s) return null;
  if (DB_URL && !s.sid) return null;
  if (s.sid) {
    if (!(await dbReady())) throw Object.assign(new Error('Session database is temporarily unavailable'), { status: 503 });
    if (ALPHA_CONFIG.enabled) {
      if (!req.alpha || !req.alpha.testerId) {
        throw Object.assign(new Error('Alpha access is required'), { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
      }
      let owned;
      try {
        owned = await alphaPrivacyStore.readHostedProviderSession({
          testerId: req.alpha.testerId,
          sessionId: s.sid
        });
      } catch (error) {
        if (error && error.code === 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') return null;
        throw ownedSessionRefusal(error);
      }
      req[HOSTED_SESSION_BASE] = structuredClone(owned.session);
      req[HOSTED_SESSION_REVISION] = owned.revision;
      return supported(owned.session);
    }
    /*
     * A store that cannot answer is unavailable, not empty. Read as "no
     * session", a fault here let a sign-in delete the row it could not read.
     */
    const r = await pool().query('SELECT data FROM nv_sessions WHERE sid=$1', [s.sid]).catch(() => {
      throw Object.assign(new Error('Session database is temporarily unavailable'), { status: 503 });
    });
    if (!r.rows.length) return null;
    const d = unseal(r.rows[0].data);
    return (d && Array.isArray(d.accounts) && d.accounts.length) ? supported(d) : null;
  }
  if (!localSessionPolicy.valid(s)) return null;
  if (Array.isArray(s.accounts) && s.accounts.length) return supported(s);
  return null;
}

/* The live streams open on this instance (apps/api/src/modules/pulsar/application/live-hub.ts). */
const liveHub = createLiveHub({ maxTotal: MAX_LIVE_CLIENTS_TOTAL, maxPerKey: MAX_LIVE_CLIENTS_PER_KEY });
function closeLiveSessions(sessionIds, reason = 'session-revoked') {
  return liveHub.closeSessions(sessionIds, reason);
}
const WEBHOOK_BUCKETS = new Map();
const WEBHOOK_RATE_WINDOW_MS = 60000;
const WEBHOOK_RATE_LIMIT = 120;
/*
 * The same two-layer shape as the API limiter, and the same reason for it: the
 * shared counter makes a hundred and twenty mean a hundred and twenty rather
 * than that many per instance, and the local bucket in front of it means a
 * sender being throttled costs no queries.
 *
 * This limiter keys on the address and the hook rather than on a session --
 * a provider delivering a webhook has no session -- so the identity is already
 * unforgeable behind trust proxy and needs no derivation.
 *
 * Its window rule is not the API limiter's. This one reopens once sixty
 * seconds have passed; that one reopens once MORE than sixty seconds have.
 * The difference is one millisecond a minute and exists only because both were
 * written by hand, but preserving each is cheaper than explaining an
 * unreproducible 429 to whoever hits the boundary.
 */
async function allowWebhookRequest(req, hookId) {
  const now = Date.now();
  const key = `${String(req.ip || 'unknown').slice(0, 80)}|${hookId}`;
  let bucket = WEBHOOK_BUCKETS.get(key);
  if (!bucket || now - bucket.startedAt >= WEBHOOK_RATE_WINDOW_MS) bucket = { startedAt: now, count: 0, refusedUntil: 0 };
  bucket.count += 1;
  WEBHOOK_BUCKETS.set(key, bucket);
  if (WEBHOOK_BUCKETS.size > 2000) {
    for (const [k, value] of WEBHOOK_BUCKETS) if (now - value.startedAt >= 120000) WEBHOOK_BUCKETS.delete(k);
  }

  if (bucket.refusedUntil > now) return false;
  if (bucket.count > WEBHOOK_RATE_LIMIT + 30) {
    bucket.refusedUntil = bucket.startedAt + WEBHOOK_RATE_WINDOW_MS;
    return false;
  }

  const store = apiRateLimitStore();
  if (!store) return bucket.count <= WEBHOOK_RATE_LIMIT;

  let verdict;
  try {
    verdict = await store.count({
      namespace: 'webhook', key, windowMs: WEBHOOK_RATE_WINDOW_MS, limit: WEBHOOK_RATE_LIMIT,
      inclusiveReset: true
    });
  } catch (error) {
    /* Unanswerable is not permission. The caller turns a false into a 429,
       which is the safe reading for a sender that can retry. */
    return false;
  }
  if (!verdict.allowed) bucket.refusedUntil = bucket.startedAt + WEBHOOK_RATE_WINDOW_MS;
  return verdict.allowed;
}
function repoKey(provider, owner, repo) { return `${provider || 'github'}:${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`; }
function scopedEvidenceKey(provider, owner, repo, identity) { return `${repoKey(provider, owner, repo)}:${String(identity || 'anonymous').slice(0, 80)}`; }
function identityKey(acct) {
  if (acct && /^[0-9a-f]{64}$/.test(String(acct.identityKey || ''))) {
    return String(acct.identityKey);
  }
  const base = { provider: acct && acct.provider || 'github', baseUrl: acct && acct.baseUrl || '', login: acct && acct.login || '' };
  if (acct && acct.authMethod === 'github-app') {
    return hashJson({
      ...base,
      authMethod: 'github-app',
      installationId: Number(acct.installationId || 0),
      authorizedByLogin: String(acct.authorizedByLogin || '').toLowerCase()
    });
  }
  return hashJson(base);
}
function stableProviderIdentityKey(acct) {
  const provider = String(acct && acct.provider || 'github');
  const authority = providerAuthority(acct);
  if (acct && acct.authMethod === 'github-app') {
    return hashJson({
      domain: 'nv-alpha-provider-identity/github-app/v1',
      provider,
      authority,
      authMethod: 'github-app',
      installationId: Number(acct.installationId || 0),
      installationAccountId: Number(acct.installationAccountId || 0)
    });
  }
  const providerAccountId = Number(acct && acct.providerAccountId || 0);
  if (Number.isSafeInteger(providerAccountId) && providerAccountId > 0) {
    return hashJson({
      domain: 'nv-alpha-provider-identity/account/v1',
      provider,
      authority,
      providerAccountId
    });
  }
  return identityKey(acct);
}
const CSRF_TTL_MS = 30 * 60 * 1000;
const STEP_UP_TTL_MS = 5 * 60 * 1000;
/*
 * The in-process guard, kept for the profile that is allowed to run without a
 * database. There it is honest: one process, and the guard covers everything
 * that process can be replayed against.
 */
const USED_STEP_UP_GRANTS = new Map();
let _singleUseStore = null;
let _rateLimitStore = null;
/*
 * Which guard answers is decided by configuration, never by whether the
 * database happens to be reachable. A deployment that has a database has one
 * shared guard; if it cannot be reached, the claim fails and the sensitive
 * action is refused. Falling back to the Map at that moment would be the worst
 * of both: every instance would answer "unspent" for a grant another instance
 * had already spent, and a replay would go through precisely during an outage.
 */
function durableSingleUseStore() {
  if (!_singleUseStore) _singleUseStore = new SingleUseStore({ pool: pool() });
  return _singleUseStore;
}
function stepUpReplayStore() {
  if (!DB_URL) return USED_STEP_UP_GRANTS;
  return durableSingleUseStore();
}
function sessionSecurityState(session) {
  if (!session.security || typeof session.security !== 'object') session.security = {};
  return session.security;
}
function clearStepUpAuthorization(session) {
  sessionSecurityState(session).stepUp = null;
}
async function ensureSessionSecurity(req, res) {
  const state = sessionSecurityState(req.session);
  if (/^[0-9a-f]{48}$/i.test(String(state.sessionNonce || ''))) return state;
  state.sessionNonce = crypto.randomBytes(24).toString('hex');
  state.stepUp = null;
  await setSession(req, res, req.session);
  return state;
}
function requestSecurityContext(req) {
  const state = sessionSecurityState(req.session || {});
  const sessionBinding = String(state.sessionNonce || '');
  const activeIdentityKey = req.gh ? identityKey(req.gh) : '';
  if (!sessionBinding || !activeIdentityKey) {
    throw Object.assign(new Error('Security context is unavailable for this session'), { status: 401, code: 'SECURITY_CONTEXT_REQUIRED' });
  }
  return { sessionBinding, identityKey: activeIdentityKey };
}
function verifyRequestCsrf(req) {
  if (SAFE_API_METHODS.has(req.method)) return null;
  const token = String(req.headers['x-nv-csrf'] || '');
  if (!token) throw Object.assign(new Error('A fresh CSRF token is required'), { status: 403, code: 'CSRF_REQUIRED' });
  return verifyCsrfToken(CSRF_SECRET, token, requestSecurityContext(req));
}
async function consumeStepUpAuthorization(req, res, operation) {
  const token = String(req.headers['x-nv-step-up'] || '');
  if (!token) throw Object.assign(new Error('This sensitive action requires step-up authorization'), { status: 403, code: 'STEP_UP_REQUIRED' });
  const context = requestSecurityContext(req);
  const claims = verifyStepUpGrant(STEP_UP_SECRET, token, { ...context, action: operation.action, scope: operation.scope });
  const state = sessionSecurityState(req.session);
  /*
   * Awaited, because the guard behind this may not be in this process. An
   * un-awaited call assigns a Promise, and a Promise is truthy: the audit
   * record at the end of a sensitive action would read it as an authorization
   * and write undefined for every field it carries.
   */
  req.stepUp = await consumePendingStepUp(state, claims, operation, { replayStore: stepUpReplayStore() });
  await setSession(req, res, req.session);
  return req.stepUp;
}
function offlineCacheScope(req) {
  const sid = sessionSidFromRequest(req);
  const cookie = getCookie(req, 'nv_session') || '';
  const sessionBinding = sid || crypto.createHash('sha256').update(cookie).digest('hex');
  if (!sessionBinding || !req.gh) return '';
  return crypto.createHmac('sha256', OFFLINE_CACHE_SCOPE_KEY)
    .update(`${sessionBinding}|${identityKey(req.gh)}`)
    .digest('base64url')
    .slice(0, 32);
}
function offlineCacheResponseBinding(req) {
  if (req.method !== 'GET' || !req.gh) return null;
  let url;
  try { url = new URL(req.originalUrl || req.url, 'https://nebulaverse.invalid'); }
  catch { return null; }
  const decision = OFFLINE_CACHE_POLICY.classifyApiRequest(url, req.method, {
    get(name) { return String(req.headers[String(name).toLowerCase()] || ''); }
  });
  if (decision.mode !== 'private-cache') return null;
  let expectedRepoKey = '';
  if (/^\/api\/repos(?:\/|$)/.test(url.pathname)) {
    expectedRepoKey = 'account';
  } else {
    const match = /^\/api\/repo\/([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    try {
      expectedRepoKey = `${req.gh.provider || 'github'}:${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
    } catch { return null; }
  }
  const expectedScope = offlineCacheScope(req);
  if (!expectedScope || decision.scope !== expectedScope || decision.repoKey !== expectedRepoKey) return null;
  return { scope: expectedScope, repoKey: expectedRepoKey };
}
function defaultSafety(value) {
  const sf = value && typeof value === 'object' ? value : {};
  return { readOnly: !!sf.readOnly, freezeSync: !!sf.freezeSync, protected: sf.protected && typeof sf.protected === 'object' ? sf.protected : {} };
}
function safetyUnavailable() {
  return Object.assign(new Error('Safety controls could not be loaded or saved. Try again when the database is available.'), {
    status: 503, code: 'SAFETY_STATE_UNAVAILABLE', providerChanged: false
  });
}
async function loadPersistentSafety(req) {
  const fallback = defaultSafety(req.session && req.session.safety);
  if (!DB_URL) return fallback;
  if (!(await dbReady())) throw safetyUnavailable();
  try {
    const r = await pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [identityKey(req.gh)]);
    return r.rows.length ? defaultSafety(r.rows[0].state) : fallback;
  } catch { throw safetyUnavailable(); }
}
function applySafetyPatch(state, patch) {
  const cur = defaultSafety(state);
  cur.protected = { ...cur.protected };
  const b = patch || {};
  if (typeof b.readOnly === 'boolean') cur.readOnly = b.readOnly;
  if (typeof b.freezeSync === 'boolean') cur.freezeSync = b.freezeSync;
  if (b.protect && b.protect.repo && b.protect.path) {
    const key = String(b.protect.repo).trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(key)) throw Object.assign(new Error('Invalid repository key'), { status: 400, code: 'SAFETY_INPUT_INVALID', providerChanged: false });
    const list = new Set(cur.protected[key] || []);
    const protectedPath = String(b.protect.path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').trim();
    if (!protectedPath || protectedPath.length > 512 || protectedPath.includes('..')) throw Object.assign(new Error('Invalid protected path or pattern'), { status: 400, code: 'SAFETY_INPUT_INVALID', providerChanged: false });
    if (b.protect.on === false) list.delete(protectedPath); else list.add(protectedPath);
    if (list.size > 100) throw Object.assign(new Error('Up to 100 protected paths or patterns per repository'), { status: 413, code: 'SAFETY_INPUT_INVALID', providerChanged: false });
    if (list.size) cur.protected[key] = [...list].sort(); else delete cur.protected[key];
    if (Object.keys(cur.protected).length > 30) throw Object.assign(new Error('Up to 30 repositories with protected paths'), { status: 413, code: 'SAFETY_INPUT_INVALID', providerChanged: false });
  }
  return cur;
}
async function savePersistentSafety(req, patch) {
  let clean;
  if (DB_URL && !(await dbReady())) throw safetyUnavailable();
  if (DB_URL) {
    let client;
    try { client = await pool().connect(); } catch { throw safetyUnavailable(); }
    try {
      await client.query('BEGIN');
      const key = identityKey(req.gh);
      // Serialize absent rows too. Apply only the requested changes to the
      // latest controls, never the snapshot captured by request middleware.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`safety:${key}`]);
      const current = await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1 FOR UPDATE', [key]);
      clean = applySafetyPatch(current.rows.length ? current.rows[0].state : req.session.safety, patch);
      await client.query(
        `INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2::jsonb,now())
         ON CONFLICT(identity_key) DO UPDATE SET state=EXCLUDED.state, updated=now()`,
        [key, JSON.stringify(clean)]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      /* A refused change says why; whatever the database did instead is "unavailable", never an unexplained failure. */
      if (error && Number(error.status) >= 400 && Number(error.status) < 500) throw error;
      throw safetyUnavailable();
    } finally { client.release(); }
  } else clean = applySafetyPatch(req.session.safety, patch);
  req.session.safety = clean;
  return clean;
}
/*
 * With a database the identity's controls live in nv_security_state and the
 * session holds a copy. A copy that cannot be written because the session
 * ended meanwhile does not undo a change that has already committed.
 */
async function saveSessionSafetyCopy(req, res) {
  if (!DB_URL) { await setSession(req, res, req.session); return true; }
  try { await setSession(req, res, req.session); return true; }
  catch (error) {
    const ended = error && (Number(error.status) === 401 || Number(error.status) === 503
      || ['SESSION_REVOKED', 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', 'ALPHA_SESSION_REVISION_CONFLICT'].includes(error.code));
    if (!ended) throw error;
    return false;
  }
}
async function appendEvidence(repoK, kind, recordId, payload) {
  if (!(await dbReady())) return null;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [repoK]);
    const existing = await client.query(
      `SELECT seq,created_at,previous_hash,record_hash,payload_hash FROM nv_evidence_chain
       WHERE repo_key=$1 AND kind=$2 AND record_id=$3 ORDER BY seq ASC LIMIT 1`,
      [repoK, kind, recordId]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { ...existing.rows[0], deduplicated: true };
    }
    const prev = await client.query('SELECT record_hash FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq DESC LIMIT 1', [repoK]);
    const previousHash = prev.rows[0] && prev.rows[0].record_hash || 'NEBULAVERSE-EVIDENCE-GENESIS-V2';
    const payloadHash = hashJson(payload);
    const recordHash = evidenceRecordHash(EVIDENCE_LEDGER_SECRET, previousHash, repoK, kind, recordId, payloadHash);
    const out = await client.query(
      `INSERT INTO nv_evidence_chain(repo_key,kind,record_id,previous_hash,record_hash,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING seq,created_at`,
      [repoK, kind, recordId, previousHash, recordHash, payloadHash]
    );
    await client.query('COMMIT');
    return { ...out.rows[0], previousHash, recordHash, payloadHash };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function verifyEvidenceChain(repoK, limit = 1000) {
  if (!(await dbReady())) return { available: false, valid: false, complete: false, checked: 0, total: 0 };
  const capped = Math.min(Math.max(limit, 1), 5000);
  const [r, count] = await Promise.all([
    pool().query(
      'SELECT seq,kind,record_id,previous_hash,record_hash,payload_hash,created_at FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq ASC LIMIT $2',
      [repoK, capped]
    ),
    pool().query('SELECT count(*)::int AS total FROM nv_evidence_chain WHERE repo_key=$1', [repoK])
  ]);
  const total = count.rows[0] ? Number(count.rows[0].total || 0) : 0;
  let previousHash = 'NEBULAVERSE-EVIDENCE-GENESIS-V2';
  /* Records written before the hashing key was separated by purpose still
     verify, under the retired key, and are counted so the export can say so. */
  let legacyRecords = 0;
  for (const row of r.rows) {
    const check = verifyEvidenceRecord(
      EVIDENCE_KEYRING, row.record_hash, previousHash, repoK, row.kind, row.record_id, row.payload_hash
    );
    if (check.legacy) legacyRecords += 1;
    if (row.previous_hash !== previousHash || !check.valid) {
      /* Distinguish an unmigrated pre-separation chain from real tampering. */
      const legacyKeyRequired = !EVIDENCE_LEGACY_SESSION_KEY_ACCEPTED &&
        row.previous_hash === previousHash &&
        verifyEvidenceRecord(
          EVIDENCE_LEGACY_PROBE, row.record_hash, previousHash, repoK,
          row.kind, row.record_id, row.payload_hash
        ).valid;
      return {
        available: true, valid: false, complete: r.rows.length === total,
        checked: r.rows.indexOf(row) + 1, total, failedAt: row.seq, legacyRecords,
        legacyKeyRequired,
        records: r.rows
      };
    }
    previousHash = row.record_hash;
  }
  return { available: true, valid: true, complete: r.rows.length === total, checked: r.rows.length, total, head: previousHash, legacyRecords, legacyKeyRequired: false, records: r.rows };
}
function liveStreamKey(provider, owner, repo, identity) {
  return scopedEvidenceKey(provider, owner, repo, identity);
}
function broadcastLive(provider, owner, repo, identity, event) {
  const payload = `id: ${String(event.id || '').replace(/[^0-9a-f-]/gi, '')}\nevent: intelligence\ndata: ${JSON.stringify(event)}\n\n`;
  liveHub.broadcast(liveStreamKey(provider, owner, repo, identity), payload);
}
function publicBase(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const inferred = `${req.protocol}://${req.get('host')}`;
  if (process.env.NODE_ENV === 'production' && !configured) {
    throw Object.assign(new Error('Set PUBLIC_BASE_URL for verified live events on non-Render production hosts'), { status: 400 });
  }
  const value = configured || inferred;
  const u = new URL(value);
  if (process.env.NODE_ENV === 'production' && u.protocol !== 'https:') throw Object.assign(new Error('Live events require an HTTPS public URL'), { status: 400 });
  if (u.username || u.password || !['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Invalid public callback URL'), { status: 400 });
  return value;
}

async function receiveGithubWebhook(req, res) {
  try {
    const hookId = String(req.params.hookId || '');
    if (!/^[0-9a-f]{32,64}$/i.test(hookId)) return res.status(404).end();
    if (!(await allowWebhookRequest(req, hookId))) return res.status(429).json({ error: 'Webhook delivery rate exceeded' });
    if (!(await dbReady())) return res.status(503).json({ error: 'Live events require the existing Neon DATABASE_URL' });
    const found = await pool().query(
      'SELECT hook_id,owner,repo,identity_key,secret_enc,active FROM nv_webhooks WHERE hook_id=$1 AND provider=$2',
      [hookId, 'github']
    );
    const hook = found.rows[0];
    if (!hook || !hook.active) return res.status(404).end();
    const sealed = unseal(hook.secret_enc);
    const secret = sealed && sealed.secret;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!verifyGithubSignature(secret, raw, String(req.headers['x-hub-signature-256'] || ''))) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    const deliveryId = cleanText(req.headers['x-github-delivery'] || '', 100);
    const eventName = cleanText(req.headers['x-github-event'] || '', 80);
    if (!deliveryId || !eventName) return res.status(400).json({ error: 'Missing GitHub delivery headers' });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }
    const event = normalizeGithubWebhook(eventName, payload, deliveryId);
    event.metadata = { ...(event.metadata || {}), rawPayloadHash: crypto.createHash('sha256').update(raw).digest('hex') };
    if (String(event.owner).toLowerCase() !== String(hook.owner).toLowerCase() || String(event.repo).toLowerCase() !== String(hook.repo).toLowerCase()) {
      return res.status(409).json({ error: 'Webhook repository mismatch' });
    }
    const sf = await pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [hook.identity_key]);
    const state = defaultSafety(sf.rows[0] && sf.rows[0].state);
    const patterns = protectedPatternsForRepository(state.protected, hook.owner, hook.repo);
    const risk = riskForEvent(event, { protectedPatterns: patterns, defaultBranch: event.defaultBranch });
    const providerEventId = event.id;
    const storedEventId = hashJson({ identityKey: hook.identity_key, deliveryId: providerEventId });
    const stored = await pool().query(
      `INSERT INTO nv_intelligence_events(
        event_id,provider,owner,repo,identity_key,event_type,action,actor,target_type,target_id,ref,before_sha,after_sha,
        severity,risk_score,reasons,summary,paths,metadata,delivery_id,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19::jsonb,$20,now())
      ON CONFLICT(event_id) DO NOTHING RETURNING created_at`,
      [storedEventId, event.provider, hook.owner, hook.repo, hook.identity_key, event.eventType, event.action, event.actor,
       event.targetType, event.targetId, event.ref, event.beforeSha, event.afterSha, risk.severity, risk.score,
       JSON.stringify(risk.reasons), event.summary, JSON.stringify(event.paths || []), JSON.stringify({ ...(event.metadata || {}), providerEventId }), deliveryId]
    );
    const enriched = {
      ...event, id: storedEventId, providerEventId, owner: hook.owner, repo: hook.repo, ...risk,
      createdAt: stored.rows[0] && stored.rows[0].created_at || new Date().toISOString()
    };
    /* Evidence is idempotent by repository/kind/record ID. If an append fails after
       event persistence, GitHub can retry the delivery and complete the chain. */
    const evidence = await appendEvidence(scopedEvidenceKey('github', hook.owner, hook.repo, hook.identity_key), 'webhook', storedEventId, enriched);
    if (stored.rowCount || !evidence.deduplicated) broadcastLive('github', hook.owner, hook.repo, hook.identity_key, enriched);
    res.status(eventName === 'ping' ? 200 : 202).json({ ok: true, accepted: !!stored.rowCount, event: eventName });
  } catch (error) {
    console.error('Webhook intake failed:', error.message);
    res.status(500).json({ error: 'Webhook intake failed' });
  }
}
const SAFETY_EXEMPT = ['/api/safety', '/api/security', '/api/logout', '/api/accounts', '/api/github-app'];
function safetyOf(req) {
  return defaultSafety(req.effectiveSafety || req.session && req.session.safety);
}
function candidatePaths(req) {
  const b = req.body || {}, q = req.query || {};
  const out = [];
  for (const v of [b.path, b.from, b.to, b.newPath, b.oldPath, b.prefix, q.path, q.p]) if (typeof v === 'string' && v) out.push(v);
  if (Array.isArray(b.paths)) for (const v of b.paths) if (typeof v === 'string') out.push(v);
  if (Array.isArray(b.files)) for (const f of b.files) if (f && typeof f.path === 'string') out.push(f.path);
  if (Array.isArray(b.ops)) for (const op of b.ops) if (op && typeof op.path === 'string') out.push(op.path);
  return out.map(p => p.replace(/^\/+/, ''));
}
function protectedPatternsForReq(req) {
  const sf = safetyOf(req);
  const { owner, repo } = req.params || {};
  if (!owner || !repo) return [];
  return protectedPatternsForRepository(sf.protected, owner, repo);
}
function protectedPathHit(req, paths) {
  const list = protectedPatternsForReq(req);
  return (paths || []).find(p => list.some(pattern => pathMatches(pattern, p))) || '';
}
function protectedPathError(req, paths) {
  const hit = protectedPathHit(req, paths);
  return hit ? `${hit} is a protected file — unlock it in Safeguards to change it.` : '';
}
function enforceProtectedPaths(req, paths) {
  const error = protectedPathError(req, paths);
  if (error) throw Object.assign(new Error(error), { status: 423, code: 'PROTECTED_PATH' });
}
function isCurrentGovernanceControlPlaneRequest(req) {
  const method = String(req.method || '').toUpperCase();
  const route = String(req.path || '');
  const prefix = '^/api/repo/[^/]+/[^/]+/governance/policies';
  /*
   * Governance changes rows this server owns, not the repository, so read-only
   * containment and protected paths do not apply to them -- and without the
   * lifecycle routes listed here, "/restore" and "/reset" were read as
   * repository-wide writes and refused whenever any path was protected.
   */
  const patterns = method === 'PATCH'
    ? [new RegExp(`${prefix}/[^/]+/drafts/[^/]+$`)]
    : method === 'DELETE'
      ? [new RegExp(`${prefix}/[^/]+/drafts/[^/]+$`)]
    : method === 'POST'
      ? [
          new RegExp(`${prefix}$`),
          new RegExp(`${prefix}/[^/]+/validate$`),
          new RegExp(`${prefix}/[^/]+/drafts$`),
          new RegExp(`${prefix}/[^/]+/drafts/[^/]+/validate$`),
          new RegExp(`${prefix}/[^/]+/drafts/[^/]+/submit$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/simulate$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/reviewers/me$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/decisions$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/activate$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/rollback$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/exceptions$`),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/baselines/generate$'),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/exceptions/[^/]+/decision$'),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/exceptions/[^/]+/revoke$'),
          new RegExp(`${prefix}/[^/]+/deactivate$`),
          new RegExp(`${prefix}/[^/]+/archive$`),
          new RegExp(`${prefix}/[^/]+/restore$`),
          new RegExp(`${prefix}/[^/]+/versions/[^/]+/withdraw$`),
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/reset$')
        ]
      : [];
  return patterns.some(pattern => pattern.test(route));
}

function guardSafety(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null;
  if (isCurrentGovernanceControlPlaneRequest(req)) return null;
  if (req.path.endsWith('/snapshot-compare') || req.path.endsWith('/restore-preview') || req.path.endsWith('/emergency-manifest')) return null;
  if (SAFETY_EXEMPT.some(p => req.path.startsWith(p))) return null;
  const sf = safetyOf(req);
  if (sf.readOnly) return 'Read-only mode is on — writes are disabled. Turn it off in Safeguards.';
  const list = protectedPatternsForReq(req);
  if (list.length) {
    const hit = protectedPathError(req, candidatePaths(req));
    if (hit) return hit;
    const repositoryWide = req.path.endsWith('/restore') || req.path.endsWith('/reset') ||
      req.path.endsWith('/restore-refs') ||
      (req.method === 'DELETE' && /^\/api\/repo\/[^/]+\/[^/]+$/.test(req.path)) ||
      (req.method === 'DELETE' && req.path.includes('/branches/'));
    if (repositoryWide) return 'This repository contains protected paths. Unlock them before a repository-wide restore, reset, branch/reference deletion, or repository deletion.';
  }
  return null;
}
/*
 * Provider routes see only GitHub accounts. Account management (the list,
 * switching, removal, sign-out, the CSRF token) sees retired accounts too, so
 * they can be replaced, and their cleanup evidence recorded, rather than lost.
 */
async function attachProviderSession(req, { retainRetired = false } = {}) {
  const s = req.session || await sessionOf(req, { retainRetiredAccounts: retainRetired });
  if (!s) {
    throw Object.assign(new Error('Not signed in'), { status: 401, code: 'AUTH_REQUIRED' });
  }
  if (!retainRetired && s.retiredSelection) {
    throw Object.assign(new Error('The selected account is no longer supported. Choose a GitHub account.'), {
      status: 409, code: 'ACCOUNT_SELECTION_REQUIRED'
    });
  }
  req.session = s;
  req.sessionAccount = s.accounts[Math.min(s.active || 0, s.accounts.length - 1)];
  if (!retainRetired) assertGithubAccount(req.sessionAccount);
  req.gh = { ...req.sessionAccount };
}

function providerAuthenticationFailure(res, error) {
  return res.status(error.status || 500).json({
    error: error.message || 'Security check failed',
    ...(error.code ? { code: error.code } : {})
  });
}

async function providerSessionAccess(req, res, next) {
  try {
    await attachProviderSession(req);
    next();
  } catch (error) {
    providerAuthenticationFailure(res, error);
  }
}

async function auth(req, res, next) {
  try {
    await attachProviderSession(req);
    req.gh = await resolveProviderAccount(req.sessionAccount, { githubAppBroker });
    await ensureSessionSecurity(req, res);
    verifyRequestCsrf(req);
    req.effectiveSafety = await loadPersistentSafety(req);
    const blocked = guardSafety(req);
    if (blocked) return res.status(423).json({ error: blocked, locked: true });
    const operation = sensitiveOperationFor({
      method: req.method, path: req.path, params: req.params, body: req.body,
      provider: req.gh.provider || 'github', identityKey: identityKey(req.gh)
    });
    if (operation) await consumeStepUpAuthorization(req, res, operation);
    next();
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || 'Security check failed',
      ...(e.code ? { code: e.code } : {})
    });
  }
}
/*
 * A session with no GitHub account left is signed out for every product read:
 * there is nothing to choose. Sign-out and account removal still accept it, so
 * its stored credentials can be cleaned up.
 */
function signedOutWithoutGithub(req, res) {
  if (req.session && Array.isArray(req.session.accounts) && req.session.accounts.some(isGithubAccount)) return false;
  res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
  return true;
}
async function accountAuth(req, res, next) {
  try {
    await attachProviderSession(req, { retainRetired: true });
    await ensureSessionSecurity(req, res);
    verifyRequestCsrf(req);
    req.effectiveSafety = await loadPersistentSafety(req);
    const blocked = guardSafety(req);
    if (blocked) return res.status(423).json({ error: blocked, locked: true });
    next();
  } catch (e) {
    providerAuthenticationFailure(res, e);
  }
}

/* ---------------- GitHub helper ---------------- */
const _etags = new Map(); // key → { etag, body } (LRU-ish, capped)
/*
 * A code for a provider's own refusal, so its explanation survives.
 *
 * publicErrorBody only passes an error's message through when the error
 * carries a recognised code; anything else becomes "Operation could not be
 * completed". The GitHub helper attached no code, so every refusal GitHub
 * explained -- a workflow file rejected for want of scope, a conflict,
 * a rate limit -- reached the operator as that one sentence, and the reason
 * they had actually been given was thrown away at the last step.
 *
 * The redaction in publicErrorBody is unchanged and still runs: a message that
 * looks like it carries a credential is still suppressed. This only stops a
 * message being discarded merely for having no code.
 */
function providerFailureCode(status) {
  const value = Number(status);
  if (value === 401 || value === 403) return 'PROVIDER_FORBIDDEN';
  if (value === 404) return 'PROVIDER_NOT_FOUND';
  if (value === 409) return 'PROVIDER_CONFLICT';
  if (value === 422) return 'PROVIDER_REJECTED';
  if (value === 429) return 'PROVIDER_RATE_LIMITED';
  if (value >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_FAILED';
}

/*
 * GitHub answers an exhausted primary rate limit, and every secondary limit,
 * with 403 as often as with 429. Read as a 403 it told the reader their
 * credential could not do what it had just been doing, sent the deletion and
 * webhook routes into permission advice, and gave no time to try again. A
 * limit is recognised by what GitHub documents for it -- a retry-after, an
 * exhausted x-ratelimit-remaining, or its own words -- and the wait is the one
 * GitHub gives: retry-after, else the reset, else a minute. The server does not
 * retry on the reader's behalf; it says when, and the client decides.
 */
function providerRateLimit(status, headers, body, now = Date.now()) {
  const retryAfter = headers.get('retry-after');
  const limited = status === 429 || (status === 403 && (
    retryAfter != null || headers.get('x-ratelimit-remaining') === '0'
    || /\brate limit\b/i.test(String(body && body.message || ''))));
  if (!limited) return null;
  let seconds = /^\d+$/.test(String(retryAfter || '').trim()) ? Number(retryAfter) : NaN;
  if (!Number.isFinite(seconds) && headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) seconds = Math.ceil(reset - now / 1000);
  }
  if (!Number.isFinite(seconds)) seconds = 60;
  return Object.freeze({ retryAfterSeconds: Math.min(Math.max(Math.trunc(seconds), 1), 3600) });
}

async function gh(acct, apiPath, opts = {}) {
  if (typeof acct === 'string') acct = { provider: 'github', token: acct };
  assertGithubAccount(acct);
  const provider = 'github';
  const token = acct.token;
  const API_BASE = GH_API;
  const AUTH = `Bearer ${token}`;
  const method = opts.method || 'GET';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    mutationGateway.assertProviderMutation({ provider, baseUrl: acct.baseUrl, method, apiPath, body: opts.body });
  }
  const cacheable = method === 'GET' && !opts.raw && !opts.accept;
  const ck = cacheable ? crypto.createHash('sha1').update(`${provider}|${acct.baseUrl || ''}|${token}|${apiPath}`).digest('hex') : null;
  const cached = ck ? _etags.get(ck) : null;
  const r = await fetchT(API_BASE + apiPath, {
    method,
    headers: {
      Authorization: AUTH,
      Accept: opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`,
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: opts.redirect === 'manual' ? 'manual' : 'error'
  }, opts.timeoutMs || (opts.raw ? UPLOAD_TIMEOUT_MS : 20000));
  if (opts.raw) return r;
  if (cached && r.status === 304) return JSON.parse(cached.body);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    if (!ALPHA_CONFIG.enabled && acct.authMethod === 'github-app' && githubAppBroker && r.status === 401) {
      githubAppBroker.invalidate(acct.installationId);
    }
    const err = new Error((data && data.message) || `GitHub error ${r.status}`);
    const limit = providerRateLimit(r.status, r.headers, data);
    err.status = limit ? 429 : r.status; err.body = data;
    err.code = providerFailureCode(err.status);
    if (limit) err.retryAfterSeconds = limit.retryAfterSeconds;
    throw err;
  }
  if (ck && r.headers.get('etag')) {
    if (_etags.size > 400) _etags.delete(_etags.keys().next().value);
    _etags.set(ck, { etag: r.headers.get('etag'), body: text });
  }
  return data;
}

async function githubArchiveResponse(acct, owner, repo, ref) {
  if ((acct.provider || 'github') !== 'github') {
    throw Object.assign(new Error('GitHub archive transport requires a GitHub account'), { status: 400 });
  }
  const initial = await gh(acct, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(ref)}`, {
    raw: true,
    redirect: 'manual'
  });
  if (![301, 302, 303, 307, 308].includes(initial.status)) return initial;
  if (initial.body) await initial.body.cancel();
  const location = initial.headers.get('location');
  let target;
  try { target = new URL(String(location || '')); }
  catch { throw Object.assign(new Error('GitHub archive redirect is invalid'), { status: 502 }); }
  const segments = target.pathname.split('/').filter(Boolean);
  let redirectedOwner = '';
  let redirectedRepo = '';
  try {
    redirectedOwner = decodeURIComponent(segments[0] || '');
    redirectedRepo = decodeURIComponent(segments[1] || '');
  } catch {
    throw Object.assign(new Error('GitHub archive redirect is invalid'), { status: 502 });
  }
  if (
    target.origin !== 'https://codeload.github.com' ||
    target.username ||
    target.password ||
    target.hash ||
    segments[2] !== 'legacy.zip' ||
    redirectedOwner.toLowerCase() !== String(owner).toLowerCase() ||
    redirectedRepo.toLowerCase() !== String(repo).toLowerCase()
  ) {
    throw Object.assign(new Error('GitHub archive redirect target is not trusted'), { status: 502 });
  }
  return fetchT(target, {
    headers: {
      Accept: 'application/zip',
      'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
    },
    redirect: 'error'
  }, UPLOAD_TIMEOUT_MS);
}
const fail = (res, error) => {
  // Once a download starts, a second JSON response cannot be sent. End the
  // broken transfer without letting ERR_HTTP_HEADERS_SENT escape the handler.
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }
  const status = error && error.status >= 400 && error.status < 600 ? error.status : 500;
  const body = publicErrorBody(error, { correlationId: res.locals.correlationId });
  /* A limit that named its own wait passes it on, so a client waits that long and no longer. */
  if (status === 429 && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  /* A refusal that has a compliant route carries it alongside the refusal. The
   * public error body itself is left exactly as it was. */
  const passage = error && error.safePassage;
  return res.status(status).json(passage ? { ...body, safePassage: passage } : body);
};

/*
 * Every content-changing action reports the complete set of repository paths it
 * touches, so a path-scoped policy rule reaches a rename, a batch and a
 * directory move the same way it reaches a single write. See src/protected-paths.js.
 */
function mutationMetadataFor(req, action) {
  const base = baseMutationMetadataFor(req, action);
  return { ...base, ...pathFactsForAction(action, base) };
}

function baseMutationMetadataFor(req, action) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const query = req.query || {};
  const params = req.params || {};
  const text = (value, max = 500) => cleanText(value == null ? '' : String(value), max).replace(/[\r\n\0]/g, ' ');
  const count = value => Array.isArray(value) ? value.length : 0;
  switch (action) {
    case 'repository.create': return { name: text(body.name, 100), private: body.isPrivate !== false, autoInit: body.autoInit !== false };
    case 'branch.create': return { branch: text(body.name, 255), sourceBranch: text(body.from, 255) };
    case 'branch.delete': return { branch: text(params.name, 255) };
    case 'branch.reset': return { branch: text(body.branch, 255), targetSha: text(body.sha, 40), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'file.write':
    case 'file.delete': return { branch: text(body.branch, 255), path: text(body.path, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'file.rename': return { branch: text(body.branch, 255), from: text(body.from, 1000), to: text(body.to, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'file.batch': {
      const batch = normalizeFileBatch(body.ops);
      return { branch: text(body.branch, 255), ...batch.summary, expectedHeadSha: text(body.expectedHeadSha, 40) };
    }
    case 'commit.revert':
    case 'commit.restore': return { branch: text(body.branch, 255), commitSha: text(body.sha, 40), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'commit.restore-paths': return { branch: text(body.branch, 255), commitSha: text(body.sha, 40), pathPrefix: text(body.prefix, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'pull.create': return { head: text(body.head, 255), base: text(body.base, 255), draft: !!body.draft };
    case 'pull.merge': {
      /* The branches and the audit gate's attributes, read before the policy is (mergeFactsFor), so a rule can name them. */
      const facts = req.mergeFacts || {};
      return {
        pullNumber: Number(params.num || 0), mergeMethod: text(body.method || 'merge', 20),
        ...(facts.branch ? { branch: text(facts.branch, 255) } : {}),
        ...(facts.head ? { head: text(facts.head, 255) } : {}),
        ...(facts.audit ? { audit: facts.audit } : {})
      };
    }
    case 'pull.review': return { pullNumber: Number(params.num || 0), event: text(body.event, 30) };
    case 'issue.create': return {};
    case 'issue.comment': return { issueNumber: Number(params.num || 0) };
    case 'issue.update': return { issueNumber: Number(params.num || 0), state: text(body.state, 20) };
    case 'workflow.rerun': return { runId: text(params.runId, 100) };
    case 'release.create': return { tag: text(body.tag || body.tag_name, 255), target: text(body.target || body.target_commitish, 255) };
    case 'git.blob.create': return { path: text(query.path, 1000) };
    case 'file.upload': return { path: text(query.path, 1000), branch: text(query.branch, 255), lfsMode: text(query.lfs || 'auto', 20), expectedHeadSha: text(query.expectedHeadSha, 40) };
    case 'directory.move': return { branch: text(body.branch, 255), from: text(body.from, 1000), to: text(body.to, 1000), expectedHeadSha: text(body.expectedHeadSha, 40) };
    case 'recovery.restore-refs': {
      const inspected = recovery.inspectRestoreAuthorization({ account: req.gh, owner: req.params.owner, repo: req.params.repo }, body.authorization);
      return { confirmation: text(body.confirm, 20), ...summarizeBatchItems('recovery.restore-refs', inspected.actions) };
    }
    default: return {};
  }
}

function mutationDescriptorFor(req, action) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const createRepository = action === 'repository.create';
  return {
    action,
    provider: req.gh.provider || 'github',
    baseUrl: req.gh.baseUrl || '',
    owner: createRepository ? req.gh.login : req.params.owner,
    repo: createRepository ? body.name : req.params.repo,
    actorIdentityKey: identityKey(req.gh),
    actorLogin: retainedActor(req),
    method: req.method,
    route: req.route && req.route.path ? String(req.route.path) : req.path,
    metadata: mutationMetadataFor(req, action),
    security: req.stepUp ? {
      stepUpAction: req.stepUp.action,
      assurance: req.stepUp.assurance,
      authorizedAt: req.stepUp.authorizedAt
    } : {},
    authorization: req.authorization
  };
}

async function resolveMutationAuthorization(req, action) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const createRepository = action === 'repository.create';
  const owner = createRepository ? req.gh.login : req.params.owner;
  const repo = createRepository ? body.name : req.params.repo;
  const input = { account: req.gh, owner, repo, actorIdentityKey: identityKey(req.gh) };
  if (createRepository) {
    const snapshot = createUnavailableAuthorizationSnapshot({
      ...input, reasonCode: 'AUTHORIZATION_SCOPE_NOT_APPLICABLE'
    });
    return retainedMutationAuthorization(req, snapshot);
  }
  const snapshot = await authorizationResolver.resolve(input);
  return retainedMutationAuthorization(req, snapshot);
}

function retainedMutationAuthorization(req, snapshot) {
  if (!ALPHA_CONFIG.enabled || !req.alpha) return snapshot;
  const actor = alphaActorLabel(req.alpha);
  return {
    ...snapshot,
    executionPrincipal: { ...snapshot.executionPrincipal, login: actor },
    governanceActor: { ...snapshot.governanceActor, login: actor }
  };
}

function applyPolicyDecisionHeaders(res, decision) {
  if (!decision) return;
  res.setHeader('X-Nebulaverse-Policy-Outcome', decision.enforcementOutcome);
  res.setHeader('X-Nebulaverse-Policy-Mode', decision.rolloutMode);
  if (decision.decisionId) res.setHeader('X-Nebulaverse-Policy-Decision', decision.decisionId);
  if (decision.warningCodes && decision.warningCodes.length) {
    res.setHeader('X-Nebulaverse-Policy-Warning', decision.warningCodes.slice(0, 8).join(','));
  }
}

/*
 * When policy refuses a change because it needs approval, offer the route to
 * approval rather than a dead end. The route is judged by the same active
 * policy set that just refused the original, read without writing so that no
 * decision is recorded for a mutation nobody performed.
 *
 * This runs on the way to a 403 that is already decided. It must never change
 * that outcome, so every failure here simply means no offer.
 */
async function safePassageFor(req, action, descriptor, error) {
  try {
    if (!error || error.code !== 'POLICY_APPROVAL_REQUIRED' || !descriptor) return null;
    if (action !== 'file.write') return null;
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || typeof body.content !== 'string') return null;
    if (!(await dbReady())) return null;
    const normalized = normalizeMutationDescriptor(descriptor);
    const resolved = await ensureGovernanceStore().resolveActivePolicySetInScope({
      scope: normalized.authorization.scope,
      action: normalized.action
    });
    const offer = offerSafePassage({
      descriptor: normalized,
      blockCode: error.code,
      content: body.content,
      evaluateStep: activePolicySetStepEvaluator({
        scope: normalized.authorization.scope,
        activePolicies: resolved.activePolicies,
        activeExceptions: resolved.activeExceptions,
        evaluatedAt: resolved.resolvedAt
      })
    });
    return offer && offer.available ? offer : null;
  } catch (offerError) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), warn: 'safe passage offer could not be built',
      action, code: cleanText(String(offerError && offerError.code || 'SAFE_PASSAGE_UNAVAILABLE'), 100)
    }));
    return null;
  }
}

/*
 * A merge's facts for the policy: the branch it merges into, the branch it
 * comes from, and what the merging person's latest audit of that head says
 * (the merge gate). Read once, before the descriptor is built, so the policy
 * judges the same facts the ledger records. A pull request that cannot be
 * read leaves the gate unavailable rather than failing the merge here; the
 * provider will say why it cannot merge it.
 */
async function mergeFactsFor(req) {
  const number = Number.parseInt(String(req.params.num || ''), 10);
  let pull;
  try { pull = await codeAudit.readPullFacts({ account: req.gh, owner: req.params.owner, repo: req.params.repo }, number); }
  catch { return { audit: gateAttributes(unavailableGate()) }; }
  const gate = await codeAudit.mergeGateFor(req.gh, req.params.owner, req.params.repo, pull);
  return mergeAttributes(pull, gate);
}

function mutationContext(action) {
  return async function enterMutationContext(req, res, next) {
    let descriptor;
    try {
      req.authorization = await resolveMutationAuthorization(req, action);
      if (action === 'pull.merge') req.mergeFacts = await mergeFactsFor(req);
      descriptor = mutationDescriptorFor(req, action);
    } catch (error) { return fail(res, error); }
    mutationGateway.run(descriptor, () => new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        res.removeListener('finish', finish);
        res.removeListener('close', finish);
        resolve();
      };
      res.once('finish', finish);
      res.once('close', finish);
      req.mutation = mutationGateway.current();
      applyPolicyDecisionHeaders(res, req.mutation && req.mutation.policyDecision);
      try { next(); }
      catch (error) {
        res.removeListener('finish', finish);
        res.removeListener('close', finish);
        reject(error);
      }
    })).catch(async error => {
      if (!res.headersSent) {
        const passage = await safePassageFor(req, action, descriptor, error);
        if (passage) error.safePassage = passage;
        return fail(res, error);
      }
      console.error(JSON.stringify({
        t: new Date().toISOString(), warn: 'mutation gateway context failed after headers',
        action, code: error && error.code || 'MUTATION_GATEWAY_FAILED'
      }));
    });
  };
}

/*
 * `publicRepositories` lets a route accept the reader access everyone has on
 * a public repository (src/authorization-resolver.js). Only routes whose data
 * is the reader's own -- their audits and their scans, keyed by identity --
 * opt in; everything the repository's collaborators share stays theirs.
 */
const OWN_WORK = Object.freeze({ publicRepositories: true });
function governanceAccess(requiredRole, options = {}) {
  return async function authorizeGovernance(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const service = await governanceService();
      const authorization = await authorizationResolver.resolve({
        account: req.gh,
        owner: req.params.owner,
        repo: req.params.repo,
        actorIdentityKey: identityKey(req.gh)
      });
      const context = assertGovernanceAuthorization({
        authorization,
        scope: {
          provider: req.gh.provider || 'github',
          baseUrl: req.gh.baseUrl || '',
          owner: req.params.owner,
          repo: req.params.repo
        },
        requiredRole
      });
      if (isPublicReaderAccess(context.authorization) && options.publicRepositories !== true) {
        throw Object.assign(new Error('This is shared by the repository’s collaborators, and reading a public repository does not make you one'), {
          status: 403, code: 'GOVERNANCE_COLLABORATORS_ONLY'
        });
      }
      req.governance = { ...context, service, publicReader: isPublicReaderAccess(context.authorization) };
      next();
    } catch (error) { return governanceFailure(res, error); }
  };
}

function governanceMutationMetadata(req, action) {
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const boundedId = value => cleanText(String(value || ''), 80);
  switch (action) {
    case 'governance.policy.create':
      return { policyKey: cleanText(String(body.policyKey || ''), 64) };
    case 'governance.draft.create':
      return { policyId: boundedId(req.params.policyId) };
    case 'governance.draft.update':
    case 'governance.draft.submit': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(req.params.policyId),
        draftId: boundedId(req.params.draftId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.reviewer.assign':
      return {
        policyId: boundedId(req.params.policyId),
        versionId: boundedId(req.params.versionId)
      };
    case 'governance.approval.decide':
      return {
        policyId: boundedId(req.params.policyId),
        versionId: boundedId(req.params.versionId),
        decision: cleanText(String(body.decision || ''), 16).toLowerCase()
      };
    case 'governance.exception.request': {
      const rawRuleIds = Array.isArray(body.ruleIds) ? body.ruleIds : [];
      const ruleIds = rawRuleIds.slice(0, 51)
        .map(value => cleanText(String(value || ''), 64).toLowerCase())
        .sort();
      return {
        policyId: boundedId(req.params.policyId),
        versionId: boundedId(req.params.versionId),
        kind: cleanText(String(body.kind || ''), 16).toLowerCase(),
        action: cleanText(String(body.action || ''), 100).toLowerCase(),
        ruleIds: ruleIds,
        target: body.target && typeof body.target === 'object' && !Array.isArray(body.target) ? body.target : null,
        ruleCount: rawRuleIds.length,
        expiresAt: cleanText(String(body.expiresAt || ''), 80)
      };
    }
    case 'governance.exception.decide':
      return {
        exceptionId: boundedId(req.params.exceptionId),
        decision: cleanText(String(body.decision || ''), 16).toLowerCase()
      };
    case 'governance.exception.revoke':
      return { exceptionId: boundedId(req.params.exceptionId) };
    case 'governance.policy.deactivate':
    case 'governance.policy.archive': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(req.params.policyId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.policy.restore':
      return { policyId: boundedId(req.params.policyId) };
    case 'governance.draft.discard': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(req.params.policyId),
        draftId: boundedId(req.params.draftId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.version.withdraw':
      return { policyId: boundedId(req.params.policyId), versionId: boundedId(req.params.versionId) };
    case 'governance.reset':
      /* Whether the typed confirmation matched, not what was typed. */
      return {
        confirmed: cleanText(String(body.confirm || ''), 400).toLowerCase() === `${req.params.owner}/${req.params.repo}`.toLowerCase()
      };
    case 'governance.policy.activate':
    case 'governance.policy.rollback': {
      const expectedRevision = Number(body.expectedRevision);
      const simulation = body.simulation && typeof body.simulation === 'object' ? body.simulation : {};
      return {
        policyId: boundedId(req.params.policyId),
        versionId: boundedId(req.params.versionId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null,
        simulationHash: cleanText(String(simulation.simulationHash || ''), 64).toLowerCase()
      };
    }
    /*
     * The two exposure actions that contact somebody else. Every other one
     * records only that it happened, which is right for a decision this server
     * makes about its own rows -- but a request refused before it reached the
     * store (an unconfirmed press, a key that is not the anonymous one, a file
     * with no project beside it) leaves no attempt row anywhere, so the ledger
     * is the only place that remembers it was asked for.
     *
     * The column names stay out. The count bounds the request, and the probe
     * table already holds the names for the probes that actually ran.
     */
    case 'exposure.credential.verify':
      return { fingerprint: boundedId(req.params.fingerprint) };
    /* The decision as asked for: the words chosen from the list, never anything the repository wrote. */
    case 'code-audit.finding.triage': {
      const days = Number(body.expiresInDays);
      return {
        findingId: boundedId(req.params.findingId),
        rule: cleanText(String(body.rule || ''), 16),
        disposition: cleanText(String(body.disposition || ''), 20).toLowerCase(),
        reason: cleanText(String(body.reason || ''), 40).toLowerCase(),
        expiresInDays: Number.isSafeInteger(days) && days > 0 && days <= 3650 ? days : null
      };
    }
    case 'code-audit.finding.reopen':
      return { findingId: boundedId(req.params.findingId) };
    case 'exposure.readability.probe':
      return {
        fingerprint: boundedId(req.params.fingerprint),
        relation: cleanText(String(body.relation || ''), 64),
        columnCount: Array.isArray(body.projection) ? Math.min(body.projection.length, 100) : 0
      };
    case 'governance.notification.preferences.update':
      return {
        enabled: body.enabled === true,
        eventCount: Array.isArray(body.eventTypes) ? Math.min(body.eventTypes.length, 100) : 0
      };
    case 'governance.notification.read': {
      const throughSeq = Number(body.throughSeq);
      return { throughSeq: Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : null };
    }
    case 'governance.webhook.create':
    case 'governance.webhook.update':
      return {
        webhookId: boundedId(req.params.webhookId),
        destinationHash: crypto.createHash('sha256').update(String(body.url || '')).digest('hex'),
        eventCount: Array.isArray(body.eventTypes) ? Math.min(body.eventTypes.length, 100) : 0,
        enabled: body.enabled !== false
      };
    case 'governance.webhook.rotate':
    case 'governance.webhook.delete':
      return { webhookId: boundedId(req.params.webhookId) };
    case 'governance.audit.export.create': {
      const afterEventSeq = Number(body.afterEventSeq);
      const throughEventSeq = Number(body.throughEventSeq);
      return {
        format: cleanText(String(body.format || ''), 8).toLowerCase(),
        afterEventSeq: Number.isSafeInteger(afterEventSeq) && afterEventSeq >= 0 ? afterEventSeq : null,
        throughEventSeq: Number.isSafeInteger(throughEventSeq) && throughEventSeq >= 0 ? throughEventSeq : null
      };
    }
    default:
      return {};
  }
}

function governanceMutationContext(action) {
  return async function enterGovernanceMutationContext(req, res, next) {
    let descriptor;
    try {
      if (!req.governance) throw Object.assign(new Error('Governance authorization is required'), { status: 403, code: 'GOVERNANCE_AUTHORIZATION_REQUIRED' });
      descriptor = {
        action,
        provider: req.governance.scope.provider,
        baseUrl: req.gh.baseUrl || '',
        owner: req.governance.scope.owner,
        repo: req.governance.scope.repo,
        actorIdentityKey: req.governance.actor.identityKey,
        actorLogin: retainedActor(req),
        method: req.method,
        route: req.route && req.route.path ? String(req.route.path) : req.path,
        metadata: governanceMutationMetadata(req, action),
        security: {},
        authorization: req.governance.authorization
      };
    } catch (error) { return governanceFailure(res, error); }
    mutationGateway.run(descriptor, () => new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        res.removeListener('finish', finish);
        res.removeListener('close', finish);
        resolve();
      };
      res.once('finish', finish);
      res.once('close', finish);
      req.mutation = mutationGateway.current();
      applyPolicyDecisionHeaders(res, req.mutation && req.mutation.policyDecision);
      try { next(); }
      catch (error) {
        res.removeListener('finish', finish);
        res.removeListener('close', finish);
        reject(error);
      }
    })).catch(error => {
      if (!res.headersSent) return governanceFailure(res, error);
      console.error(JSON.stringify({
        t: new Date().toISOString(), warn: 'governance mutation context failed after headers',
        action, code: error && error.code || 'GOVERNANCE_MUTATION_FAILED'
      }));
    });
  };
}

/* ================= AUTH ================= */
/* ================= GITHUB IDENTITY ================= */
function assertGithubAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account) ||
      (account.provider !== undefined && account.provider !== 'github')) {
    throw Object.assign(new Error('Only GitHub accounts are supported. Sign in with GitHub.'), {
      status: 401, code: 'PROVIDER_UNSUPPORTED'
    });
  }
  if (account.baseUrl && account.baseUrl !== 'https://github.com') {
    throw Object.assign(new Error('Custom Git server URLs are not supported'), {
      status: 401, code: 'PROVIDER_AUTHORITY_UNSUPPORTED'
    });
  }
}

function providerAuthority(account) {
  if ((account && account.provider || 'github') === 'github') return 'github.com';
  try { return new URL(account && account.baseUrl || '').host.toLowerCase(); }
  catch { return ''; }
}

function retainedActor(req) {
  return ALPHA_CONFIG.enabled && req.alpha
    ? alphaActorLabel(req.alpha)
    : String(req.gh && req.gh.login || 'unknown');
}

function alphaRepositoryTarget(account, owner, repo) {
  const provider = account && account.provider || 'github';
  return {
    provider,
    authority: provider === 'github'
      ? 'github.com'
      : account && account.baseUrl,
    owner,
    repo
  };
}

function alphaRepositoryDecision(alpha, account, owner, repo) {
  const target = alphaRepositoryTarget(account, owner, repo);
  const canonical = canonicalRepositoryScope(target);
  return {
    allowed: !ALPHA_CONFIG.enabled
      || inviteUnbound(alpha && alpha.repositoryScopes)
      || repositoryAllowed(alpha && alpha.repositoryScopes, target),
    canonical
  };
}

function alphaRepositoryDenied() {
  return Object.assign(
    new Error('This repository is not allowed for this alpha invitation'),
    { status: 403, code: 'ALPHA_REPOSITORY_NOT_ALLOWED' }
  );
}

function assertAlphaRepositoryAllowed(alpha, account, owner, repo) {
  try {
    const decision = alphaRepositoryDecision(alpha, account, owner, repo);
    if (!decision.allowed) throw alphaRepositoryDenied();
    return decision;
  } catch (error) {
    if (error && error.code === 'ALPHA_REPOSITORY_NOT_ALLOWED') throw error;
    if (error instanceof AlphaAccessError || error instanceof TypeError) {
      throw alphaRepositoryDenied();
    }
    throw error;
  }
}

function alphaRepositoryAccess(req, res, next) {
  if (!ALPHA_CONFIG.enabled) return next();
  try {
    req.alphaRepository = assertAlphaRepositoryAllowed(
      req.alpha,
      req.gh,
      req.params.owner,
      req.params.repo
    );
    return next();
  } catch {
    const error = alphaRepositoryDenied();
    return res.status(error.status).json({
      error: error.message,
      code: error.code
    });
  }
}

function alphaRepositoryListAllowed(req, owner, repo) {
  if (!ALPHA_CONFIG.enabled) return true;
  try {
    return alphaRepositoryDecision(
      req.alpha,
      req.gh,
      owner,
      repo
    ).allowed;
  } catch {
    return false;
  }
}

function alphaRepositoryListAccess(req, res, next) {
  if (!ALPHA_CONFIG.enabled) return next();
  try {
    canonicalRepositoryScope(
      alphaRepositoryTarget(req.gh, 'alpha-authority', 'root-validation')
    );
    return next();
  } catch {
    const error = alphaRepositoryDenied();
    return res.status(error.status).json({
      error: error.message,
      code: error.code
    });
  }
}

function repositoryCreationAccess(req, res, next) {
  try {
    validateRepositoryCreation(req.body);
    // Pre-authorized exact names work even before the repository exists.
    // Existing invitations never acquire a broader grant as a side effect.
    if (ALPHA_CONFIG.enabled) assertAlphaRepositoryAllowed(req.alpha, req.gh, req.gh.login, req.body.name);
    next();
  } catch (error) { fail(res, error); }
}

function repositoryDeletionConfirmation(req, res, next) {
  const expected = `${req.params.owner}/${req.params.repo}`;
  if (!req.body || req.body.confirmation !== expected) {
    return fail(res, Object.assign(new Error('Type the full owner/repository name to confirm deletion.'), {
      status: 400, code: 'REPOSITORY_DELETE_CONFIRMATION_REQUIRED', providerChanged: false
    }));
  }
  next();
}

function githubSearchAccess(req, res, next) {
  try {
    validateCodeQuery(req.query.q);
    if (ALPHA_CONFIG.enabled) {
      for (const repository of githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes)) {
        scopedCodeQuery(req.query.q, repository);
      }
    }
    next();
  } catch (error) { fail(res, error); }
}

function alphaStepUpRepositoryAccess(req, res, next) {
  try {
    const body = req.body || {};
    const operation = normalizeStepUpRequest(body.action, body.scope, {
      provider: req.gh.provider || 'github',
      identityKey: identityKey(req.gh)
    });
    if (ALPHA_CONFIG.enabled && operation.scope.owner && operation.scope.repo) {
      req.alphaRepository = assertAlphaRepositoryAllowed(
        req.alpha,
        req.gh,
        operation.scope.owner,
        operation.scope.repo
      );
    }
    req.alphaStepUpOperation = operation;
    next();
  } catch (error) {
    fail(res, error);
  }
}

/*
 * The safety state a reader may see. `globalControls` says whether read-only
 * and the sync freeze can be changed from here: a hosted alpha scopes every
 * change to a repository and refuses the global switches, so the Safeguards
 * panel shows them as the deployment's rather than as switches that bounce.
 */
function alphaSafetyView(req, state) {
  const view = defaultSafety(state);
  if (!ALPHA_CONFIG.enabled) return { ...view, globalControls: true };
  const protectedRepositories = {};
  for (const [repository, patterns] of Object.entries(view.protected)) {
    const match = String(repository).match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) continue;
    try {
      if (alphaRepositoryDecision(req.alpha, req.gh, match[1], match[2]).allowed) {
        protectedRepositories[repository] = patterns;
      }
    } catch {}
  }
  return { ...view, protected: protectedRepositories, globalControls: false };
}

function alphaSafetyMutationAccess(req, res, next) {
  if (!ALPHA_CONFIG.enabled) return next();
  const body = req.body || {};
  if (typeof body.readOnly === 'boolean' || typeof body.freezeSync === 'boolean') {
    return res.status(403).json({
      error: 'Global safety changes require an unscoped deployment',
      code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED'
    });
  }
  const repository = body.protect && body.protect.repo;
  const match = String(repository || '').trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    return res.status(repository ? 400 : 403).json(repository
      ? { error: 'Invalid repository key' }
      : {
          error: 'A repository scope is required for hosted-alpha safety changes',
          code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED'
        });
  }
  try {
    req.alphaRepository = assertAlphaRepositoryAllowed(
      req.alpha,
      req.gh,
      match[1],
      match[2]
    );
    next();
  } catch (error) {
    fail(res, error);
  }
}

function providerCapabilities(account) {
  const context = {
    provider: String(account && account.provider || 'github'),
    authority: providerAuthority(account),
    deployment: DEPLOYMENT_PROFILE,
    authMethod: account && account.authMethod,
    tokenKind: githubTokenKind(account || {})
  };
  const legacy = legacyCapsFor(CAPABILITY_DOCUMENT, context);
  if (context.provider === 'github' && account && account.authMethod === 'github-app') {
    return { ...legacy, notif: false };
  }
  return { ...legacy, notif: resolveCapability(CAPABILITY_DOCUMENT, { ...context, feature: 'notifications' }).status !== 'Unavailable' };
}

function capabilityAccess(feature) {
  return function enforceCapability(req, res, next) {
    try {
      req.capability = assertProviderCapability(req.gh, feature);
      next();
    } catch (error) {
      res.status(error.status || 409).json({
        error: error.message,
        code: error.code || 'PROVIDER_CAPABILITY_UNAVAILABLE',
        feature
      });
    }
  };
}
/*
 * A capability only some of a route's requests use, checked before the body
 * is read whenever the request asks for it; the handler still asserts it at
 * the point of use for the requests that come to need it on their own.
 */
function capabilityAccessWhen(feature, applies) {
  const check = capabilityAccess(feature);
  return function enforceCapabilityWhen(req, res, next) {
    if (!applies(req)) return next();
    return check(req, res, next);
  };
}
function providerCapabilityContext(account, feature) {
  return {
    provider: account && account.provider || 'github',
    authority: providerAuthority(account),
    deployment: DEPLOYMENT_PROFILE,
    feature,
    authMethod: account && account.authMethod,
    tokenKind: githubTokenKind(account || {})
  };
}
function assertProviderCapability(account, feature) {
  return assertCapabilityAvailable(
    CAPABILITY_DOCUMENT,
    providerCapabilityContext(account, feature),
    { qualification: QUALIFICATION_CAPABILITIES }
  );
}
function requestSupportsCapability(req, feature) {
  return resolveCapability(
    CAPABILITY_DOCUMENT,
    providerCapabilityContext(req.gh, feature)
  ).status === 'Supported';
}
function assertProviderBoundLfs(account) {
  const context = providerCapabilityContext(account, 'lfs');
  if (context.provider !== 'github' || context.authority !== 'github.com') {
    throw new CapabilityError(
      'LFS is not qualified for this provider and deployment.',
      'PROVIDER_CAPABILITY_UNAVAILABLE'
    );
  }
  return assertCapabilityAvailable(CAPABILITY_DOCUMENT, context);
}

async function providerIdentity(acct) {
  if (acct && acct.authMethod === 'github-app') {
    return { login: acct.login, name: acct.login, avatar_url: acct.avatar, id: acct.installationAccountId };
  }
  return gh(acct, '/user');
}
const RETIRED_CLEANUP = 'PROVIDER_RETIRED_MANUAL_CLEANUP_REQUIRED';
async function disconnectAlphaProviderAccount(req, accountOrAccounts) {
  const accounts = (Array.isArray(accountOrAccounts) ? accountOrAccounts : [accountOrAccounts])
    .filter(account => account && typeof account === 'object');
  /* An audit held for an account that is leaving goes with it. */
  for (const account of accounts) { codeAudit.jobs.forget(identityKey(account)); siteJobs.forget(identityKey(account)); renderedJobs.forget(identityKey(account)); }
  if (!ALPHA_CONFIG.enabled) {
    const targetKeys = new Set(accounts.map(hostedAccountKey));
    for (const account of accounts) {
      if (account.authMethod !== 'github-app') continue;
      if (githubAppBroker) githubAppBroker.invalidate(account.installationId);
      await removeGithubAppInstallation(
        account.authorizedByIdentityKey,
        Number(account.installationId)
      );
      await recordGithubAppAudit(
        account.authorizedByIdentityKey,
        'installation.disconnected',
        Number(account.installationId),
        { actor: retainedActor(req), status: 'disconnected' }
      );
    }
    /*
     * The selected identity stays selected when an account before it leaves;
     * an index that merely clamps hands the session to whichever account slid
     * into its place. If the selected one is the account leaving, a GitHub
     * account is chosen, never a retired one -- the same rule the hosted path
     * follows.
     */
    const before = req.session.accounts;
    const selected = before[Math.min(Math.max(Number(req.session.active) || 0, 0), Math.max(before.length - 1, 0))];
    req.session.accounts = before.filter(account => !targetKeys.has(hostedAccountKey(account)));
    const kept = req.session.accounts.indexOf(selected);
    req.session.active = kept >= 0 ? kept : Math.max(0, req.session.accounts.findIndex(isGithubAccount));
    clearStepUpAuthorization(req.session);
    const manualCleanup = accounts.filter(account => !isGithubAccount(account)).map(account => providerRevocationGuidance(account));
    return Object.freeze({ complete: true, supportedComplete: true, legacy: true, results: Object.freeze([]), manualCleanup: Object.freeze(manualCleanup) });
  }

  const sid = sessionSidFromRequest(req);
  if (!sid || !req.alpha || !req.alpha.testerId) {
    throw Object.assign(new Error('Owned provider session is unavailable'), {
      status: 401, code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE'
    });
  }
  const results = [];
  for (const account of accounts) {
    const bindingIdentityKey = identityKey(account);
    let resolvedAccount = null;
    const transportAccount = async () => {
      if (!resolvedAccount) {
        resolvedAccount = await resolveProviderAccount(account, { githubAppBroker });
      }
      return resolvedAccount;
    };
    const result = await disconnectProviderAccount({
      account,
      tester: req.alpha,
      binding: {
        testerId: req.alpha.testerId,
        identityKey: bindingIdentityKey,
        provider: account.provider || 'github',
        authority: providerAuthority(account)
      },
      sessionId: sid,
      async enumerateProviderWebhooks() {
        const inventory = await pool().query(
          `SELECT hook_id,provider_hook_id,owner,repo,alpha_resource_key_hash
             FROM nv_webhooks
            WHERE provider=$1 AND identity_key=$2
            ORDER BY hook_id`,
          [account.provider || 'github', bindingIdentityKey]
        );
        return inventory.rows.map(row => ({
          hookId: row.hook_id,
          providerHookId: row.provider_hook_id,
          owner: row.owner,
          repo: row.repo,
          alphaResourceKeyHash: row.alpha_resource_key_hash
        }));
      },
      prepareDisconnect: input => alphaPrivacyStore.prepareProviderDisconnect(input),
      async removeProviderWebhook({ webhook }) {
        if ((account.provider || 'github') !== 'github' || !webhook.providerHookId) {
          return { verifiedAbsent: false };
        }
        const providerAccount = await transportAccount();
        await gh(
          providerAccount,
          `/repos/${encodeURIComponent(webhook.owner)}/${encodeURIComponent(webhook.repo)}/hooks/${webhook.providerHookId}`,
          { method: 'DELETE' }
        );
        return { verifiedAbsent: false };
      },
      async readProviderWebhook({ webhook }) {
        if ((account.provider || 'github') !== 'github' || !webhook.providerHookId) {
          return { absent: false };
        }
        const providerAccount = await transportAccount();
        await gh(
          providerAccount,
          `/repos/${encodeURIComponent(webhook.owner)}/${encodeURIComponent(webhook.repo)}/hooks/${webhook.providerHookId}`
        );
        return { absent: false };
      },
      completeProviderWebhookCleanup: input => (
        alphaPrivacyStore.completeProviderWebhookCleanup(input)
      ),
      invalidateBroker() {
        if (account.authMethod === 'github-app' && githubAppBroker) {
          githubAppBroker.invalidate(account.installationId);
        }
      },
      finalizeDisconnect: input => alphaPrivacyStore.finalizeProviderDisconnect(input),
      /* What cannot be cleaned up through a provider any more is recorded for the operator's privacy cleanup. */
      recordPendingEvidence: input => alphaPrivacyStore.createCleanupTask({
        testerId: input.testerId,
        identityKey: bindingIdentityKey,
        provider: String(account.provider || 'github'),
        resourceType: 'provider-session',
        resourceKeyHash: input.resourceKeyHash,
        reasonCode: input.reasonCode
      })
    });
    results.push(result);
    /* A retired account's local state waits for the operator; the accounts after it are still disconnected. */
    if (result.reasonCode === RETIRED_CLEANUP) continue;
    if (!result.providerStateRemoved) break;
    if (account.authMethod === 'github-app') {
      await recordGithubAppAudit(
        bindingIdentityKey,
        'installation.disconnected',
        Number(account.installationId),
        { actor: retainedActor(req), status: 'disconnected' }
      );
    }
  }
  const retiredKeys = new Set(accounts
    .filter((account, index) => results[index] && results[index].reasonCode === RETIRED_CLEANUP)
    .map(hostedAccountKey));
  if (retiredKeys.size) {
    /* The operator's cleanup task is recorded; the retired credential itself leaves the session now. */
    const dropped = await alphaPrivacyStore.mutateHostedProviderSession({
      testerId: req.alpha.testerId,
      sessionId: sid,
      mutate(current) {
        const before = Array.isArray(current.accounts) ? current.accounts : [];
        const selected = before[Number(current.active) || 0];
        const kept = before.filter(account => !retiredKeys.has(hostedAccountKey(account)));
        const index = kept.indexOf(selected);
        return { ...current, accounts: kept, active: index >= 0 ? index : Math.max(0, kept.findIndex(isGithubAccount)) };
      }
    });
    req.session = dropped.session;
    req[HOSTED_SESSION_BASE] = structuredClone(dropped.session);
    req[HOSTED_SESSION_REVISION] = dropped.revision;
  }
  return Object.freeze({
    complete: results.length === accounts.length
      && results.every(result => result.providerStateRemoved),
    supportedComplete: results.length === accounts.length
      && results.every(result => result.providerStateRemoved || result.reasonCode === RETIRED_CLEANUP),
    legacy: false,
    results: Object.freeze(results),
    manualCleanup: Object.freeze(results.filter(result => result.reasonCode === RETIRED_CLEANUP).map(result => result.revocationGuidance))
  });
}

function clearProviderSessionCookie(req, res) {
  const sid = sessionSidFromRequest(req);
  if (sid) closeLiveSessions([sid], 'session-ended');
  setCookieRaw(res, '', 0);
}

async function revokeContainedSessions(req, sessionIds) {
  if (!sessionIds.length) return [];
  if (ALPHA_CONFIG.enabled) {
    const result = await alphaPrivacyStore.revokeOwnedProviderSessions({
      testerId: req.alpha.testerId,
      sessionIds
    });
    return [...result.revokedSessionIds];
  }
  await pool().query('DELETE FROM nv_sessions WHERE sid = ANY($1::text[])', [sessionIds]);
  return sessionIds;
}

async function addAccount(req, res, token, user, provider = 'github', baseUrl = '', options = { authMethod: 'token' }) {
  const authMethod = ['token', 'oauth', 'github-app'].includes(options && options.authMethod) ? options.authMethod : 'token';
  const existingSession = await sessionOf(req);
  const s = existingSession || { accounts: [], active: 0 };
  const account = {
    login: String(user && user.login || '').trim(),
    avatar: String(user && user.avatar_url || ''),
    providerAccountId: Number(user && user.id || 0),
    provider,
    baseUrl,
    authMethod
  };
  if (!account.login) throw Object.assign(new Error('Provider identity is incomplete'), { status: 502 });
  if (authMethod === 'github-app') {
    const extra = options && options.account && typeof options.account === 'object' ? options.account : {};
    const installationId = Number(extra.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw Object.assign(new Error('GitHub App installation account is invalid'), { status: 400, code: 'GITHUB_APP_ACCOUNT_INVALID' });
    }
    Object.assign(account, {
      installationId,
      installationAccountId: Number(extra.installationAccountId || 0),
      installationAccountType: cleanText(extra.installationAccountType || 'User', 40),
      repositorySelection: extra.repositorySelection === 'all' ? 'all' : 'selected',
      permissions: extra.permissions && typeof extra.permissions === 'object' ? { ...extra.permissions } : {},
      authorizedByLogin: cleanText(extra.authorizedByLogin || '', 100),
      authorizedById: Number(extra.authorizedById || 0),
      authorizedByIdentityKey: cleanText(extra.authorizedByIdentityKey || '', 128),
      installationHtmlUrl: cleanText(extra.installationHtmlUrl || '', 500),
      installationStatus: cleanText(extra.installationStatus || 'connected', 40),
      lastVerifiedAt: cleanText(extra.lastVerifiedAt || new Date().toISOString(), 80)
    });
    s.accounts = s.accounts.filter(a => !(
      a.authMethod === 'github-app' && Number(a.installationId) === installationId &&
      String(a.authorizedByIdentityKey || '') === account.authorizedByIdentityKey
    ));
  } else {
    account.token = String(token || '');
    if (!account.token) throw Object.assign(new Error('Provider credential is unavailable'), { status: 401 });
    s.accounts = s.accounts.filter(a => !(
      a.authMethod !== 'github-app' && a.login === account.login && (a.provider || 'github') === provider
    ));
  }
  account.identityKey = ALPHA_CONFIG.enabled
    ? stableProviderIdentityKey(account)
    : identityKey(account);
  s.accounts.push(account);
  if (ALPHA_CONFIG.enabled) {
    const current = unseal(getCookie(req, 'nv_session') || '');
    const held = current && typeof current.sid === 'string' && current.sid ? current.sid : '';
    const connect = sessionId => alphaPrivacyStore.connectHostedProviderAccount({
      testerId: req.alpha.testerId,
      sessionId,
      account,
      authority: providerAuthority(account),
      capacity: ACCOUNT_CAP()
    });
    let sid = held || crypto.randomBytes(24).toString('hex');
    let connected;
    try {
      connected = await connect(sid).catch(error => {
        /* A cookie naming a session that ended: this sign-in starts a new one. */
        if (!held || !error || error.code !== 'ALPHA_PROVIDER_SESSION_UNAVAILABLE') throw error;
        sid = crypto.randomBytes(24).toString('hex');
        return connect(sid);
      });
    } catch (error) {
      throw alphaConnectionRefusal(error);
    }
    req.session = connected.session;
    req[HOSTED_SESSION_BASE] = structuredClone(connected.session);
    req[HOSTED_SESSION_REVISION] = connected.revision;
    setCookieRaw(res, seal({ sid }));
    return;
  }
  while (s.accounts.length > ACCOUNT_CAP()) s.accounts.shift();
  s.active = s.accounts.length - 1;
  /* Signing in with GitHub is the choice a retired selection asked for. */
  delete s.retiredSelection;
  clearStepUpAuthorization(s);
  if (!existingSession && DB_URL) {
    /* The cookie may still name a row this sign-in replaces, such as one that
       holds only retired provider accounts; its credentials go with it. */
    const replaced = sessionSidFromRequest(req);
    if (replaced) {
      await pool().query('DELETE FROM nv_sessions WHERE sid=$1', [replaced]);
      closeLiveSessions([replaced], 'session-ended');
    }
  }
  await setSession(req, res, s, { createNew: !existingSession });
}
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
    limits: PUBLIC_ALPHA_LIMITS, database: _databaseReadiness
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
  gh, dbReady, pool, identityKey, databaseConfigured: Boolean(DB_URL), publicBase, seal,
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

/* ================= SESSION CONTAINMENT (Neural Command Center) ================= */
async function sessionsForIdentity(req) {
  const current = unseal(getCookie(req, 'nv_session') || '');
  const currentSid = current && current.sid ? current.sid : '';
  if (!currentSid || !(await dbReady())) return { available: false, currentSid: '', rows: [] };
  const login = String((req.gh && req.gh.login) || '');
  const provider = String((req.gh && req.gh.provider) || 'github');
  const baseUrl = String((req.gh && req.gh.baseUrl) || '');
  const targetIdentity = identityKey(req.gh);
  let candidates;
  if (ALPHA_CONFIG.enabled) {
    const owned = await pool().query(
      `SELECT DISTINCT session.sid,session.data,session.updated
         FROM nv_sessions session
         JOIN nv_alpha_provider_session_ownership ownership
           ON ownership.session_key_hash=session.session_key_hash
        WHERE ownership.tester_id=$1
          AND ownership.identity_key=$2
          AND ownership.provider=$3
          AND ownership.released_at IS NULL
        ORDER BY session.updated DESC LIMIT 1000`,
      [req.alpha.testerId, targetIdentity, provider]
    );
    candidates = owned.rows || [];
  } else {
    const [indexed, legacy] = await Promise.all([
      pool().query(
        'SELECT sid, data, updated FROM nv_sessions WHERE identity_keys @> ARRAY[$1]::text[] ORDER BY updated DESC LIMIT 1000',
        [targetIdentity]
      ),
      pool().query(
        "SELECT sid, data, updated FROM nv_sessions WHERE cardinality(identity_keys)=0 ORDER BY updated DESC LIMIT 500"
      )
    ]);
    candidates = [...(indexed.rows || []), ...(legacy.rows || [])];
  }
  const rows = [];
  const seen = new Set();
  for (const row of candidates) {
    if (seen.has(row.sid)) continue;
    seen.add(row.sid);
    const decoded = unseal(row.data);
    if (!decoded || !Array.isArray(decoded.accounts)) continue;
    const matches = decoded.accounts.some(a => identityKey(a) === targetIdentity);
    if (matches) rows.push({ sid: row.sid, updated: row.updated, current: row.sid === currentSid, provider });
  }
  return { available: true, currentSid, login, provider, rows };
}
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
    try { if (_pool) await _pool.end(); } catch {}
    clearTimeout(force);
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
