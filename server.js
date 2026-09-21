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
const zlib = require('zlib');
const dns = require('dns').promises;
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
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const {
  CapabilityError, loadCapabilityDocument, projectCapabilities,
  resolveCapability, assertCapabilityAvailable, legacyCapsFor
} = require('./src/capability-registry');
const {
  githubTokenKind, validateRepositoryCreation, githubRepositoryScopes, validateCodeQuery, scopedCodeQuery,
  createVerifiedRepository, searchAccessibleCode, listAccessibleNotifications,
  verifyRepositoryDeletion
} = require('./src/github-account-operations');
const CAPABILITY_DOCUMENT = loadCapabilityDocument(
  path.join(__dirname, 'config', 'public-alpha-capabilities.json')
);
const DEPLOYMENT_PROFILE = 'hosted-alpha';
const {
  stableJson, hashJson, evidenceRecordHash,
  verifyEvidenceRecord, evidenceKeyrings, verifyGithubSignature, normalizeGithubWebhook,
  riskForEvent, riskForAccessSurface, compareSnapshots, pathMatches, protectedPatternsForRepository, referenceSha, canAcceptLiveClient,
  cleanText, normalizeRepoPath, normalizeBranchName, normalizeCommitSha, lfsAttributePattern, normalizeProviderBranches
} = require('./src/intelligence');
const {
  normalizeDatabaseUrl,
  normalizeGovernanceRuntimeFailureMode,
  loadHostedAlphaLimits,
  loadGithubAppConfig,
  loadAlphaAccessConfig
} = require('./src/config');
const {
  databaseReadiness,
  hostedConfigProjection
} = require('./src/hosted-readiness');
const { AlphaAccessStore } = require('./src/alpha-access-store');
const { AlphaPrivacyStore } = require('./src/alpha-privacy-store');
const { alphaActorLabel, alphaRetentionPolicy, sanitizeFeedback } = require('./src/alpha-privacy');
const {
  disconnectProviderAccount,
  providerResourceKeyHash
} = require('./src/provider-disconnect');
const {
  AlphaAccessError,
  canonicalRepositoryScope,
  repositoryAllowed,
  inviteUnbound
} = require('./src/alpha-access');
const { PRODUCT_NAME, APP_VERSION, ASSET_VERSION } = require('./src/version');
const { computeReleaseFingerprint } = require('./src/release-fingerprint');
const { assetStampFor } = require('./src/asset-stamp');
const OFFLINE_CACHE_POLICY = require('./public/offline-cache-policy');
const { normalizeTransportChoice, planUploadTransport } = require('./public/upload-planning');
// ADR-067/ADR-072 deliberately bind /api/version to bytes observed at startup.
// An embedded build-time digest would be circular and could attest different bytes.
const RELEASE_TREE_SHA256 = computeReleaseFingerprint(__dirname);
/*
 * Bound to the tree rather than the version, so every build invalidates the
 * shell cache it replaces. A stamp that only names the version leaves a
 * returning browser with new HTML and cache-first scripts from an older build.
 */
const ASSET_STAMP = assetStampFor(RELEASE_TREE_SHA256);
const { createCorrelationId, publicErrorBody } = require('./src/public-errors');
const { loadMigrations, runMigrations, verifyMigrations } = require('./src/migrations');
const { scanUploadFile, scannerStatus } = require('./src/file-security');
const {
  createCsrfToken, verifyCsrfToken, createStepUpGrant, verifyStepUpGrant,
  normalizeStepUpRequest, sensitiveOperationFor, consumePendingStepUp, scopeHash
} = require('./src/security-foundation');
const {
  GithubAppError, createGithubAppState, verifyGithubAppState, GithubAppBroker
} = require('./src/github-app');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('./src/key-derivation');
const { rateLimitIdentity } = require('./src/rate-limit-identity');
const { SingleUseStore, memorySingleUseStore } = require('./src/single-use-store');
const { resolveProviderAccount } = require('./src/provider-credentials');
const { createAuthorizationResolver, createUnavailableAuthorizationSnapshot } = require('./src/authorization-resolver');
const { projectGovernanceInterfaceAccess } = require('./src/governance-interface');
const { createMutationGateway, normalizeMutationDescriptor } = require('./src/mutation-gateway');
const { createGiteaFileMutationAdapter } = require('./src/provider-file-mutations');
const { normalizeFileBatch, summarizeBatchItems } = require('./src/mutation-coverage');
const { pathFactsForAction } = require('./src/protected-paths');
const { offerSafePassage } = require('./src/safe-passage');
const {
  selectRepositories: selectActivityRepositories,
  feed: buildActivityFeed
} = require('./src/activity-feed');
const { createGovernanceRuntime } = require('./src/governance-enforcement');
const { GovernanceStore } = require('./src/governance-store');
const { assertGovernanceAuthorization, createGovernanceApiService } = require('./src/governance-api');
const { startWebhookWorker } = require('./src/governance-webhook-worker');
const {
  createSnapshotSignatures,
  loadSnapshotSigningConfig
} = require('./src/snapshot-signatures');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 10000;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const HOSTING_PROFILE = String(process.env.NV_DEPLOYMENT_PROFILE || 'local').trim().toLowerCase();
if (!['local', 'hosted-alpha'].includes(HOSTING_PROFILE)) {
  throw new Error('NV_DEPLOYMENT_PROFILE must be local or hosted-alpha');
}
const DATABASE_MIGRATION_MODE = String(process.env.NV_DATABASE_MIGRATION_MODE || 'apply').trim().toLowerCase();
if (!['apply', 'verify'].includes(DATABASE_MIGRATION_MODE)) {
  throw new Error('NV_DATABASE_MIGRATION_MODE must be apply or verify');
}
if (HOSTING_PROFILE === 'hosted-alpha' && process.env.NODE_ENV === 'production' && DATABASE_MIGRATION_MODE !== 'verify') {
  throw new Error('hosted-alpha production requires NV_DATABASE_MIGRATION_MODE=verify');
}
if (process.env.NODE_ENV === 'production' && SECRET === 'dev-secret-change-me') {
  throw new Error(
    'SESSION_SECRET must be configured in production. Set it in the Render dashboard under Environment, ' +
    'or let render.yaml generate one automatically.'
  );
}
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(SECRET, 'utf8') < 32) {
  throw new Error(
    'SESSION_SECRET must contain at least 32 bytes in production. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" ' +
    'then set it in the Render dashboard under Environment.'
  );
}
/*
 * Every keyed construction below derives its own key from SECRET through a
 * distinct HKDF purpose. See src/key-derivation.js for why the previous shared
 * key was a hazard even though nothing was exploitable.
 */
const SESSION_CONTENT_KEY = deriveKey(SECRET, KEY_PURPOSES.SESSION_CONTENT);
const OFFLINE_CACHE_SCOPE_KEY = deriveKey(SECRET, KEY_PURPOSES.OFFLINE_CACHE_SCOPE);
const GITHUB_APP_STATE_REPLAY_KEY = deriveKey(SECRET, KEY_PURPOSES.GITHUB_APP_STATE_REPLAY);
const CSRF_SECRET = deriveSecret(SECRET, KEY_PURPOSES.CSRF_TOKEN);
const STEP_UP_SECRET = deriveSecret(SECRET, KEY_PURPOSES.STEP_UP_GRANT);
const GITHUB_APP_STATE_SECRET = deriveSecret(SECRET, KEY_PURPOSES.GITHUB_APP_STATE);
const EVIDENCE_LEDGER_SECRET = deriveSecret(SECRET, KEY_PURPOSES.EVIDENCE_LEDGER);
const RATE_LIMIT_IDENTITY_KEY = deriveKey(SECRET, KEY_PURPOSES.RATE_LIMIT_IDENTITY);
/*
 * Evidence verification holds two keyrings, assembled together in
 * src/intelligence.js so their retired lists cannot drift apart.
 *
 * Rows written before key separation were hashed with the raw session secret,
 * and rows written before a SESSION_SECRET rotation with a key derived from the
 * previous secret. Accepting the raw secret unconditionally would undo half the
 * point of separating the keys -- a leaked SESSION_SECRET could forge records
 * that verify, permanently -- so production accepts it only on an explicit
 * opt-in, the rule src/snapshot-signatures.js already applies to legacy
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
const GITHUB_APP_CONFIG = loadGithubAppConfig(process.env, { production: process.env.NODE_ENV === 'production' });
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
const GOVERNANCE_RUNTIME_FAILURE_MODE = normalizeGovernanceRuntimeFailureMode(process.env.NV_GOVERNANCE_RUNTIME_FAILURE_MODE);
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
const mutationGateway = createMutationGateway({
  policyEvaluator: descriptor => governanceRuntime.evaluate(descriptor),
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
  request: async ({ account, provider, apiPath }) =>
    provider === 'gitlab' ? glFetch(account, apiPath) : gh(account, apiPath)
});
const GH_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const MB = 1024 * 1024;
const CONTENTS_MAX = 40 * MB;
const HOSTED_LIMITS = HOSTING_PROFILE === 'hosted-alpha' ? loadHostedAlphaLimits(process.env) : null;
const PUBLIC_ALPHA_LIMITS = HOSTED_LIMITS || loadHostedAlphaLimits({});
const GIT_DATA_MAX_MB = HOSTED_LIMITS?.gitDataMaxMb ?? Math.min(Math.max(parseInt(process.env.NV_GIT_DATA_MAX_MB || '64', 10) || 64, 10), 95);
const BLOB_MAX = GIT_DATA_MAX_MB * MB;
const NATIVE_PUSH_MAX_MB = HOSTED_LIMITS?.nativePushMaxMb ?? Math.min(Math.max(parseInt(process.env.NV_NATIVE_PUSH_MAX_MB || '64', 10) || 64, 10), 95);
const GIT_PUSH_MAX = NATIVE_PUSH_MAX_MB * MB; /* Memory-safe ceiling; GitHub's absolute non-LFS object ceiling is 100 MB. */
const UPLOAD_MAX_MB = HOSTED_LIMITS?.uploadMaxMb ?? Math.min(Math.max(parseInt(process.env.NV_UPLOAD_MAX_MB || '2048', 10) || 2048, 25), 2048);
const UPLOAD_MAX = UPLOAD_MAX_MB * MB;
const UPLOAD_CONCURRENCY = HOSTED_LIMITS?.uploadConcurrency ?? Math.min(Math.max(parseInt(process.env.NV_UPLOAD_CONCURRENCY || '1', 10) || 1, 1), 4);
const UPLOAD_TIMEOUT_MINUTES = HOSTED_LIMITS?.uploadTimeoutMinutes ?? Math.min(Math.max(parseInt(process.env.NV_UPLOAD_TIMEOUT_MINUTES || '20', 10) || 20, 2), 60);
const UPLOAD_TIMEOUT_MS = UPLOAD_TIMEOUT_MINUTES * 60 * 1000;
let activeUploads = 0;

async function acquireUploadSlot(req, maxBytes) {
  const rawLength = req.headers['content-length'];
  const declared = rawLength == null ? 0 : Number(rawLength);
  if (!Number.isFinite(declared) || declared < 0) throw Object.assign(new Error('Invalid Content-Length'), { status: 400 });
  if (declared > maxBytes) throw Object.assign(new Error(`Upload exceeds the ${Math.floor(maxBytes / MB)} MB route limit`), { status: 413 });
  if (activeUploads >= UPLOAD_CONCURRENCY) throw Object.assign(new Error('Another upload is already in progress — retry shortly'), { status: 429 });
  if (declared) {
    try {
      const st = await fsp.statfs(os.tmpdir());
      const available = Number(st.bavail) * Number(st.bsize);
      if (Number.isFinite(available) && declared + 32 * MB > available) {
        throw Object.assign(new Error('Not enough temporary disk space for this upload on the current hosting plan'), { status: 507 });
      }
    } catch (error) {
      if (error && error.status === 507) throw error;
      /* Some filesystems do not expose statfs; the streamed hard limit still applies. */
    }
  }
  activeUploads += 1;
  req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error('Upload timed out')));
  let released = false;
  return () => { if (!released) { released = true; activeUploads = Math.max(0, activeUploads - 1); } };
}

function receiveRawFile(req, tmp, maxBytes, hash) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const w = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const finishError = error => {
      if (settled) return;
      settled = true;
      req.unpipe(w);
      w.destroy();
      req.resume();
      reject(error);
    };
    req.on('aborted', () => finishError(Object.assign(new Error('Upload was aborted'), { status: 499 })));
    req.on('error', finishError);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finishError(Object.assign(new Error(`Upload exceeds the ${Math.floor(maxBytes / MB)} MB route limit`), { status: 413 }));
      if (hash) hash.update(chunk);
    });
    w.on('error', finishError);
    w.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
    req.pipe(w);
  });
}


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


const STALE_UPLOAD_HOURS = HOSTED_LIMITS?.staleUploadHours ?? Math.min(Math.max(parseInt(process.env.NV_STALE_UPLOAD_HOURS || '6', 10) || 6, 1), 72);
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
/* Retire old owner cookies without adopting them into provider authentication. */
app.use((req, res, next) => {
  const cookies = String(req.headers.cookie || '').split(';').map(item => item.trim());
  for (const [name, scope] of [
    ['nv_workspace_session', '/api/workspace'],
    ['nv_workspace_challenge', '/api/workspace'],
    ['nv_workspace_oauth', '/api/workspace'],
    ['nv_workspace_oauth_intent', '/']
  ]) {
    if (cookies.some(item => item.startsWith(`${name}=`))) {
      res.clearCookie(name, { path: scope, httpOnly: true, secure: process.env.NODE_ENV === 'production' });
    }
  }
  next();
});
/* one safe request identity shared by logs and tester-facing errors */
app.use((req, res, next) => {
  const supplied = String(req.headers['x-nebulaverse-correlation-id'] || '');
  const correlationId = /^nvx-[0-9a-f]{16}$/.test(supplied)
    ? supplied
    : createCorrelationId();
  res.locals.correlationId = correlationId;
  res.setHeader('X-Nebulaverse-Correlation-Id', correlationId);
  next();
});
/* structured request logging */
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) console.log(JSON.stringify({
      t: new Date().toISOString(), correlationId: res.locals.correlationId,
      m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0
    }));
  });
  next();
});
/* security headers */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://*.githubusercontent.com https://*.gravatar.com https://gitlab.com",
    "media-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});
/* Private offline reads are opt-in and bound to the authenticated session,
   provider identity, and repository. All other API responses stay no-store. */
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const writeHead = res.writeHead;
  res.writeHead = function writeOfflineCacheHeaders(...args) {
    const responseStatus = Number(args[0] || res.statusCode);
    const binding = responseStatus === 200 ? offlineCacheResponseBinding(req) : null;
    if (binding) {
      res.setHeader('X-NV-Offline-Scope', binding.scope);
      res.setHeader('X-NV-Offline-Repo', binding.repoKey);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      for (const name of ['Cookie', 'X-NV-Offline-Scope', 'X-NV-Offline-Repo']) res.vary(name);
    } else {
      res.removeHeader('X-NV-Offline-Scope');
      res.removeHeader('X-NV-Offline-Repo');
      res.setHeader('Cache-Control', 'no-store');
    }
    return writeHead.apply(this, args);
  };
  next();
});
/* Browser request boundary: unsafe API calls must be intentional and same-origin. */
const SAFE_API_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
  if (SAFE_API_METHODS.has(req.method)) return next();
  if (req.headers['x-nv'] !== '1') {
    return res.status(403).json({ error: 'Missing app header', code: 'APP_HEADER_REQUIRED' });
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site API requests are not allowed', code: 'CROSS_SITE_REQUEST' });
  }
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
    for (const configured of [process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL]) {
      try { if (configured) allowed.add(new URL(configured).origin); } catch {}
    }
    let parsedOrigin = '';
    try { parsedOrigin = new URL(origin).origin; } catch {}
    if (!parsedOrigin || !allowed.has(parsedOrigin)) {
      return res.status(403).json({ error: 'Request origin does not match Nebulaverse-X', code: 'CROSS_SITE_REQUEST' });
    }
  }
  next();
});
/*
 * Per-session rate limit: 300 API req/min.
 *
 * The bucket key is derived from the unsealed session rather than from the
 * cookie as it arrived. A caller cannot forge a sealed payload without
 * SESSION_SECRET, so it cannot mint bucket identities, and the fields the
 * derivation reads survive a reseal, so writing a session back no longer
 * returns it to zero. src/rate-limit-identity.js records what the previous
 * key did instead.
 */
const _buckets = new Map();
app.use('/api', (req, res, next) => {
  const { key } = rateLimitIdentity({
    session: unseal(getCookie(req, 'nv_session') || ''),
    address: req.ip,
    hmacKey: RATE_LIMIT_IDENTITY_KEY,
    namespace: 'api'
  });
  const now = Date.now();
  let b = _buckets.get(key);
  if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; _buckets.set(key, b); }
  if (++b.n > 300) return res.status(429).json({ error: 'Rate limit: slow down a little' });
  if (_buckets.size > 5000) {
    for (const [bucketKey, value] of _buckets) {
      if (now - value.t > 120000) _buckets.delete(bucketKey);
    }
    while (_buckets.size > 5000) _buckets.delete(_buckets.keys().next().value);
  }
  next();
});
/*
 * Maintenance mode.
 *
 * render.yaml has carried NV_MAINTENANCE_MODE since the blueprint was written
 * and a contract test asserted it was set, but nothing read it: turning it on
 * did nothing whatsoever. An operator reaching for it during an incident would
 * have had a documented switch, a passing test, and a fully serving
 * application.
 *
 * What it must not do is take the health check down with it. The host restarts
 * an instance that fails health, so a maintenance switch that answers 503 to
 * everything removes the very thing the operator just reached for. Health stays
 * green and discloses the state; readiness reports not-ready, which is the
 * honest answer and the one load balancers act on.
 *
 * Read once at startup rather than per request: on the hosted platform an
 * environment change redeploys the service, so there is no state to poll for,
 * and a per-request read would invite the value to change midway through one.
 */
const MAINTENANCE_MODE = /^(1|true|on|yes)$/i.test(String(process.env.NV_MAINTENANCE_MODE || '').trim());

/*
 * No version here. This answers "is the process up" to anyone who asks, with
 * no session and no invitation, which makes it the cheapest place in the
 * product to read the build number off. Liveness does not depend on knowing
 * which release is alive, and the operator checklist verifies that this route
 * answers, not what it says about the release.
 */
app.get('/healthz', (req, res) => res.json({
  ok: true,
  service: MAINTENANCE_MODE ? 'maintenance' : 'alive',
  maintenance: MAINTENANCE_MODE
}));
app.get('/readyz', async (req, res) => {
  /*
   * Not ready, deliberately. Readiness is what a load balancer drains on, and
   * during maintenance draining is exactly the intent -- unlike health, which
   * has to stay green so the host does not recycle the instance out from under
   * the operator.
   */
  if (MAINTENANCE_MODE) {
    res.setHeader('Retry-After', '120');
    return res.status(503).json({ ok: false, service: 'maintenance', maintenance: true });
  }
  if (!DB_URL) {
    if (HOSTING_PROFILE === 'hosted-alpha') {
      return res.status(503).json({
        ok: false,
        database: 'unavailable',
        migration: _databaseMigration
      });
    }
    return res.json({ ok: true, database: 'optional-not-configured' });
  }
  try {
    const ready = await dbReady();
    if (!ready) return res.status(503).json({
      ok: false,
      database: _databaseReadiness.state,
      migration: _databaseMigration
    });
    await pool().query('SELECT 1');
    return res.json({
      ok: _databaseReadiness.ok,
      database: _databaseReadiness.state,
      migration: _databaseMigration
    });
  } catch (error) {
    invalidateDatabaseReady('unavailable');
    return res.status(503).json({
      ok: false,
      database: _databaseReadiness.state,
      migration: _databaseMigration
    });
  }
});
/* iOS requests these at the root by convention when adding to home screen */
for (const alias of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
  app.get(alias, (req, res) => res.sendFile(path.join(__dirname, 'public', 'assets', 'apple-touch-icon.png')));
}

/* ============ same-origin vendor proxy (server fetches, memory-caches, serves) ============ */
const VCACHE = new Map();
let vBytes = 0;
const SAFE_ASSET = /^[A-Za-z0-9@._/+-]+$/;
const VENDOR_ALLOWLIST = new Set([
  'codemirror/5.65.16/codemirror.min.js',
  'codemirror/5.65.16/codemirror.min.css',
  'codemirror/5.65.16/mode/meta.min.js',
  'codemirror/5.65.16/mode/javascript/javascript.min.js',
  'codemirror/5.65.16/mode/xml/xml.min.js',
  'codemirror/5.65.16/mode/css/css.min.js',
  'codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js',
  'codemirror/5.65.16/mode/markdown/markdown.min.js',
  'codemirror/5.65.16/mode/python/python.min.js',
  'codemirror/5.65.16/mode/shell/shell.min.js',
  'codemirror/5.65.16/mode/yaml/yaml.min.js',
  'codemirror/5.65.16/addon/search/searchcursor.min.js',
  'codemirror/5.65.16/theme/ayu-mirage.min.css',
  'codemirror/5.65.16/theme/base16-light.min.css',
  'codemirror/5.65.16/theme/dracula.min.css',
  'codemirror/5.65.16/theme/eclipse.min.css',
  'codemirror/5.65.16/theme/material-ocean.min.css',
  'codemirror/5.65.16/theme/monokai.min.css',
  'codemirror/5.65.16/theme/nord.min.css',
  'marked/15.0.12/marked.min.js',
  'three/0.185.1/three.module.min.js',
  'three/0.185.1/three.core.min.js',
  'dompurify/3.4.13/purify.min.js',
  'fonts/archivo-variable-latin.woff2',
  'fonts/public-sans-variable-latin.woff2',
  'fonts/jetbrains-mono-variable-latin.woff2',
  'fonts/fira-code-variable-latin.woff2',
  'fonts/source-code-pro-variable-latin.woff2',
  'fonts/ibm-plex-mono-400-latin.woff2',
  'fonts/ibm-plex-mono-500-latin.woff2',
  'fonts/dm-mono-400-latin.woff2',
  'fonts/dm-mono-500-latin.woff2'
]);
async function readBoundedResponse(response, maxBytes = 2 * MB) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('Vendor asset exceeds the response limit'), { status: 502 });
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel('response limit exceeded'); } catch {}
      throw Object.assign(new Error('Vendor asset exceeds the response limit'), { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
async function proxyAsset(res, upstream) {
  const hit = VCACHE.get(upstream);
  if (hit) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(hit.buf);
  }
  const r = await fetchT(upstream, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
  });
  if (!r.ok) return res.status(502).json({ error: `Vendor upstream ${r.status}` });
  let buf = await readBoundedResponse(r, 2 * MB);
  const type = r.headers.get('content-type') || 'application/octet-stream';
  if (buf.length <= 2 * MB) {
    vBytes += buf.length;
    VCACHE.set(upstream, { buf, type });
    while (vBytes > 24 * MB && VCACHE.size) {
      const k = VCACHE.keys().next().value;
      vBytes -= VCACHE.get(k).buf.length;
      VCACHE.delete(k);
    }
  }
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(buf);
}
app.get('/vendor/*', async (req, res) => {
  try {
    const p = req.params[0] || '';
    if (!SAFE_ASSET.test(p) || p.includes('..') || !VENDOR_ALLOWLIST.has(p)) return res.status(404).end();
    const localRoot = path.join(__dirname, 'public', 'vendor');
    const localPath = path.resolve(localRoot, p);
    if (localPath.startsWith(localRoot + path.sep) && fs.existsSync(localPath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(localPath);
    }
    /* Exact allowlisted CDN fallback only; normal deployments bundle every vendor asset. */
    await proxyAsset(res, 'https://cdnjs.cloudflare.com/ajax/libs/' + p);
  } catch (e) { res.status(502).json({ error: e.message }); }
});
/* GitHub sends the exact bytes used to calculate X-Hub-Signature-256. */
app.post('/hooks/github/:hookId', express.raw({ type: 'application/json', limit: '2mb' }), receiveGithubWebhook);
app.use(express.json({ limit: '30mb' }));
const INDEX_TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const SW_TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
function renderReleaseTemplate(template) {
  return template
    .replaceAll('__NV_PRODUCT_NAME__', PRODUCT_NAME)
    .replaceAll('__NV_VERSION__', APP_VERSION)
    .replaceAll('__NV_ASSET_VERSION__', ASSET_STAMP);
}
app.get(['/','/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderReleaseTemplate(INDEX_TEMPLATE));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript').send(renderReleaseTemplate(SW_TEMPLATE));
});
/*
 * Placed after health and readiness and before everything else: those two have
 * to answer during maintenance, and nothing else may. Static assets are served
 * below this line so the shell can still render and show the notice rather
 * than a bare browser error.
 */
app.use('/api', (req, res, next) => {
  if (!MAINTENANCE_MODE) return next();
  res.setHeader('Retry-After', '120');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(503).json({
    error: 'SERVICE_IN_MAINTENANCE',
    message: 'Nebulaverse-X is in maintenance and is not accepting requests right now.',
    nextAction: 'Retry once maintenance has finished. No data has been changed by this request.'
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800'); // safe: URLs are version-stamped
  }
}));

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
function secureTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* ===== session store: Postgres (Neon/any) when DATABASE_URL is set, sealed cookie otherwise ===== */
const DB_URL = normalizeDatabaseUrl(process.env.DATABASE_URL || '', {
  production: process.env.NODE_ENV === 'production',
  insecure: process.env.NV_DB_INSECURE === '1'
});
let _pool = null;
function pool() {
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool({
      connectionString: DB_URL,
      max: 3,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      enableChannelBinding: true
    });
  }
  return _pool;
}
const ALPHA_CONFIG = loadAlphaAccessConfig(process.env, {
  production: process.env.NODE_ENV === 'production',
  databaseUrl: DB_URL
});
const ALPHA_COOKIE = 'nv_alpha_access';
const ALPHA_SESSION_ID = Symbol('alpha session id');
const HOSTED_SESSION_BASE = Symbol('hosted provider session base');
const HOSTED_SESSION_REVISION = Symbol('hosted provider session revision');
const ALPHA_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const ALPHA_PUBLIC_API = new Set([
  'GET /api/version',
  'GET /api/config',
  'GET /api/capabilities',
  'GET /api/alpha/status',
  'POST /api/alpha/redeem'
]);
const ALPHA_SESSION_HTTP_CODES = new Set([
  'ALPHA_ACCESS_REQUIRED',
  'ALPHA_SESSION_EXPIRED',
  'ALPHA_ACCESS_REVOKED'
]);
const ALPHA_REDEMPTION_HTTP_CODES = new Set([
  'ALPHA_INVITE_REJECTED',
  'ALPHA_REDEMPTION_LOCKED'
]);
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

function setAlphaCookie(res, value, maxAge = ALPHA_COOKIE_MAX_AGE) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ALPHA_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
  );
}

function alphaOperationalFailure(res) {
  return res.status(500).json({
    error: 'Alpha access operation could not be completed'
  });
}

function alphaSessionFailure(res, error) {
  const code = String(error && error.code || '');
  if (!ALPHA_SESSION_HTTP_CODES.has(code)) return alphaOperationalFailure(res);
  const response = {
    ALPHA_ACCESS_REQUIRED: {
      status: 401,
      error: 'Alpha access is required'
    },
    ALPHA_SESSION_EXPIRED: {
      status: 401,
      error: 'Alpha session expired'
    },
    ALPHA_ACCESS_REVOKED: {
      status: 403,
      error: 'Alpha access was revoked'
    }
  }[code];
  return res.status(response.status).json({ error: response.error, code });
}

function alphaRedemptionFailure(res, error) {
  const code = String(error && error.code || '');
  if (!ALPHA_REDEMPTION_HTTP_CODES.has(code)) return alphaOperationalFailure(res);
  return res.status(code === 'ALPHA_REDEMPTION_LOCKED' ? 429 : 403).json({
    error: 'Invitation could not be redeemed',
    code
  });
}

function alphaSessionView(session) {
  if (
    !session
    || typeof session !== 'object'
    || typeof session.testerLabel !== 'string'
    || !Array.isArray(session.repositoryScopes)
    || typeof session.termsVersion !== 'string'
    || typeof session.expiresAt !== 'string'
  ) {
    throw new TypeError('alpha access store returned an invalid session');
  }
  return {
    testerLabel: session.testerLabel,
    repositoryScopes: [...session.repositoryScopes],
    termsVersion: session.termsVersion,
    expiresAt: session.expiresAt
  };
}

function alphaRequestPath(req) {
  return String(req.originalUrl || req.url || '').split('?', 1)[0];
}

function alphaRequestKey(req) {
  return `${String(req.method || '').toUpperCase()} ${alphaRequestPath(req)}`;
}

async function readAlphaRequestSession(req) {
  const payload = unseal(getCookie(req, ALPHA_COOKIE) || '');
  if (!payload || typeof payload.alphaSid !== 'string' || !payload.alphaSid) {
    throw Object.assign(new Error('Alpha access is required'), {
      status: 401,
      code: 'ALPHA_ACCESS_REQUIRED'
    });
  }
  const stored = await alphaStore.readSession(payload.alphaSid);
  const testerId = String(stored && stored.testerId || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(testerId)) {
    throw new TypeError('alpha access store returned an invalid tester id');
  }
  if (
    payload.testerId !== undefined
    && String(payload.testerId || '').toLowerCase() !== testerId
  ) {
    throw new TypeError('alpha access cookie tester does not match its session');
  }
  return {
    sessionId: payload.alphaSid,
    session: { ...alphaSessionView(stored), testerId }
  };
}

function readAlphaDeletionRecovery(req) {
  if (
    alphaRequestKey(req) !== 'POST /api/alpha/delete'
    || !req.body
    || req.body.confirm !== 'DELETE ALPHA DATA'
  ) return null;
  const payload = unseal(getCookie(req, ALPHA_COOKIE) || '');
  const testerId = String(payload && payload.testerId || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(testerId)) {
    return null;
  }
  return Object.freeze({ testerId, deletionRecovery: true });
}

async function alphaAccessBoundary(req, res, next) {
  if (!ALPHA_CONFIG.enabled || ALPHA_PUBLIC_API.has(alphaRequestKey(req))) {
    return next();
  }
  try {
    const access = await readAlphaRequestSession(req);
    req.alpha = access.session;
    req[ALPHA_SESSION_ID] = access.sessionId;
    return next();
  } catch (error) {
    const recovery = readAlphaDeletionRecovery(req);
    if (recovery) {
      req.alpha = recovery;
      return next();
    }
    setAlphaCookie(res, '', 0);
    return alphaSessionFailure(res, error);
  }
}

function alphaStatusBody(session = null) {
  return {
    mode: ALPHA_CONFIG.mode,
    authenticated: !!session,
    termsVersion: ALPHA_CONFIG.termsVersion,
    testerLabel: session ? session.testerLabel : null,
    repositoryScopes: session ? [...session.repositoryScopes] : [],
    expiresAt: session ? session.expiresAt : null
  };
}

app.use('/api', alphaAccessBoundary);

app.get('/api/alpha/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ALPHA_CONFIG.enabled || !getCookie(req, ALPHA_COOKIE)) {
    return res.json(alphaStatusBody());
  }
  try {
    const access = await readAlphaRequestSession(req);
    return res.json(alphaStatusBody(access.session));
  } catch (error) {
    setAlphaCookie(res, '', 0);
    if (!ALPHA_SESSION_HTTP_CODES.has(String(error && error.code || ''))) {
      return alphaOperationalFailure(res);
    }
    return res.json(alphaStatusBody());
  }
});

app.post('/api/alpha/redeem', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ALPHA_CONFIG.enabled || !alphaStore) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const redeemed = await alphaStore.redeemInvite({
      code: req.body && req.body.code,
      termsVersion: req.body && req.body.acceptedTermsVersion,
      ip: req.ip
    });
    const session = alphaSessionView({
      ...redeemed.tester,
      expiresAt: redeemed.expiresAt
    });
    if (typeof redeemed.sessionId !== 'string' || !redeemed.sessionId) {
      throw new TypeError('alpha access store returned an invalid session id');
    }
    const testerId = String(redeemed.tester && redeemed.tester.testerId || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(testerId)) {
      throw new TypeError('alpha access store returned an invalid tester id');
    }
    setAlphaCookie(res, seal({ alphaSid: redeemed.sessionId, testerId }));
    return res.json({
      ok: true,
      testerLabel: session.testerLabel,
      repositoryScopes: session.repositoryScopes,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    return alphaRedemptionFailure(res, error);
  }
});

app.post('/api/alpha/end', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  setAlphaCookie(res, '', 0);
  res.json({ ok: true });
});

let _dbReady = null;
let _dbRetryAfter = 0;
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
const EVENT_RETENTION_DAYS = HOSTED_LIMITS?.eventRetentionDays ?? Math.min(Math.max(parseInt(process.env.NV_EVENT_RETENTION_DAYS || '90', 10) || 90, 7), 730);
const SESSION_RETENTION_DAYS = HOSTED_LIMITS?.sessionRetentionDays ?? Math.min(Math.max(parseInt(process.env.NV_SESSION_RETENTION_DAYS || '35', 10) || 35, 7), 365);
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
  _dbReady = initializeDatabase()
    .then(ok => {
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

const GOVERNANCE_AUDIT_SECRET_SOURCE = process.env.NV_GOVERNANCE_AUDIT_SECRET || SECRET;
if (process.env.NODE_ENV === 'production' && process.env.NV_GOVERNANCE_AUDIT_SECRET &&
    Buffer.byteLength(process.env.NV_GOVERNANCE_AUDIT_SECRET, 'utf8') < 32) {
  throw new Error('NV_GOVERNANCE_AUDIT_SECRET must contain at least 32 bytes in production when configured.');
}
const GOVERNANCE_AUDIT_SECRET = deriveKey(
  GOVERNANCE_AUDIT_SECRET_SOURCE,
  KEY_PURPOSES.GOVERNANCE_AUDIT
).toString('hex');
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
async function setSession(req, res, data) {
  if (DB_URL) {
    if (!(await dbReady())) throw Object.assign(new Error('Session database is temporarily unavailable'), { status: 503 });
    let sid = null;
    const cur = unseal(getCookie(req, 'nv_session') || '');
    if (cur && cur.sid) sid = cur.sid;
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
      });
      req.session = result.session;
      req[HOSTED_SESSION_BASE] = structuredClone(result.session);
      req[HOSTED_SESSION_REVISION] = result.revision;
      setCookieRaw(res, seal({ sid }));
      return;
    }
    const identityKeys = [...new Set((Array.isArray(data.accounts) ? data.accounts : []).map(identityKey))];
    await pool().query(
      `INSERT INTO nv_sessions (sid, data, identity_keys, updated) VALUES ($1,$2,$3::text[],now())
       ON CONFLICT (sid) DO UPDATE SET data=EXCLUDED.data, identity_keys=EXCLUDED.identity_keys,
         revision=nv_sessions.revision+1,updated=now()`,
      [sid, seal(data), identityKeys]
    );
    setCookieRaw(res, seal({ sid }));
    return;
  }
  setCookieRaw(res, seal(data));
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
  if (sid) closeLiveSessions([sid], 'session-ended');
  setCookieRaw(res, '', 0);
}
async function sessionOf(req) {
  const s = unseal(getCookie(req, 'nv_session') || '');
  if (!s) return null;
  if (DB_URL && !s.sid) return null;
  if (s.sid) {
    if (!(await dbReady())) throw Object.assign(new Error('Session database is temporarily unavailable'), { status: 503 });
    if (ALPHA_CONFIG.enabled) {
      if (!req.alpha || !req.alpha.testerId) {
        throw Object.assign(new Error('Alpha access is required'), { status: 401, code: 'ALPHA_ACCESS_REQUIRED' });
      }
      const owned = await alphaPrivacyStore.readHostedProviderSession({
        testerId: req.alpha.testerId,
        sessionId: s.sid
      });
      req[HOSTED_SESSION_BASE] = structuredClone(owned.session);
      req[HOSTED_SESSION_REVISION] = owned.revision;
      return owned.session;
    }
    const r = await pool().query('SELECT data FROM nv_sessions WHERE sid=$1', [s.sid]).catch(() => null);
    if (!r || !r.rows.length) return null;
    const d = unseal(r.rows[0].data);
    return (d && Array.isArray(d.accounts) && d.accounts.length) ? d : null;
  }
  if (s.token) return { accounts: [{ token: s.token, login: s.login }], active: 0 }; /* v3 cookie */
  if (Array.isArray(s.accounts) && s.accounts.length) return s;
  return null;
}

const LIVE_CLIENTS = new Map();
const MAX_LIVE_CLIENTS_PER_KEY = HOSTED_LIMITS?.liveClientsPerRepo ?? Math.min(Math.max(parseInt(process.env.NV_LIVE_CLIENTS_PER_REPO || '5', 10) || 5, 1), 20);
const MAX_LIVE_CLIENTS_TOTAL = HOSTED_LIMITS?.liveClientsTotal ?? Math.min(Math.max(parseInt(process.env.NV_LIVE_CLIENTS_TOTAL || '100', 10) || 100, 10), 500);
function liveClientCount() {
  let total = 0;
  for (const clients of LIVE_CLIENTS.values()) total += clients.size;
  return total;
}
function closeLiveSessions(sessionIds, reason = 'session-revoked') {
  const ids = new Set((sessionIds || []).filter(Boolean));
  if (!ids.size) return 0;
  let closed = 0;
  for (const [key, clients] of LIVE_CLIENTS) {
    for (const client of [...clients]) {
      if (!ids.has(client.nvSessionSid)) continue;
      try { client.write(`event: session-revoked\ndata: ${JSON.stringify({ reason, at: new Date().toISOString() })}\n\n`); } catch {}
      try { client.end(); } catch {}
      clients.delete(client);
      closed += 1;
    }
    if (!clients.size) LIVE_CLIENTS.delete(key);
  }
  return closed;
}
function closeAlphaLiveSession(key, client) {
  const clients = LIVE_CLIENTS.get(key);
  if (clients) {
    clients.delete(client);
    if (!clients.size) LIVE_CLIENTS.delete(key);
  }
  if (client.writableEnded) return;
  try {
    client.write(`event: alpha-access-ended\ndata: ${JSON.stringify({
      reason: 'access-invalid',
      at: new Date().toISOString()
    })}\n\n`);
  } catch {}
  try { client.end(); } catch {}
}
const WEBHOOK_BUCKETS = new Map();
function allowWebhookRequest(req, hookId) {
  const now = Date.now();
  const key = `${String(req.ip || 'unknown').slice(0, 80)}|${hookId}`;
  let bucket = WEBHOOK_BUCKETS.get(key);
  if (!bucket || now - bucket.startedAt >= 60000) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  WEBHOOK_BUCKETS.set(key, bucket);
  if (WEBHOOK_BUCKETS.size > 2000) {
    for (const [k, value] of WEBHOOK_BUCKETS) if (now - value.startedAt >= 120000) WEBHOOK_BUCKETS.delete(k);
  }
  return bucket.count <= 120;
}
function repoKey(provider, owner, repo) { return `${provider || 'github'}:${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`; }
function encodeEventCursor(createdAt, eventId) {
  const timestamp = new Date(createdAt || 0);
  if (!Number.isFinite(timestamp.getTime()) || !eventId) return '';
  return Buffer.from(JSON.stringify({ t: timestamp.toISOString(), id: String(eventId) }), 'utf8').toString('base64url');
}
function decodeEventCursor(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const timestamp = new Date(parsed && parsed.t);
    const eventId = String(parsed && parsed.id || '');
    if (Number.isFinite(timestamp.getTime()) && eventId) return { createdAt: timestamp.toISOString(), eventId };
  } catch {}
  const legacy = new Date(raw);
  return Number.isFinite(legacy.getTime()) ? { createdAt: legacy.toISOString(), eventId: '' } : null;
}
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
async function loadPersistentSafety(req) {
  const fallback = defaultSafety(req.session && req.session.safety);
  if (!(await dbReady())) return fallback;
  const key = identityKey(req.gh);
  const r = await pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [key]).catch(() => null);
  if (!r || !r.rows.length) return fallback;
  return defaultSafety(r.rows[0].state);
}
async function savePersistentSafety(req, state) {
  const clean = defaultSafety(state);
  if (await dbReady()) {
    await pool().query(
      `INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2::jsonb,now())
       ON CONFLICT(identity_key) DO UPDATE SET state=EXCLUDED.state, updated=now()`,
      [identityKey(req.gh), JSON.stringify(clean)]
    );
  }
  req.session.safety = clean;
  return clean;
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
  const key = liveStreamKey(provider, owner, repo, identity);
  for (const client of LIVE_CLIENTS.get(key) || []) {
    try { client.write(`id: ${String(event.id || '').replace(/[^0-9a-f-]/gi, '')}\nevent: intelligence\ndata: ${JSON.stringify(event)}\n\n`); } catch {}
  }
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
    if (!allowWebhookRequest(req, hookId)) return res.status(429).json({ error: 'Webhook delivery rate exceeded' });
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
  const patterns = method === 'PATCH'
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
          new RegExp('^/api/repo/[^/]+/[^/]+/governance/exceptions/[^/]+/revoke$')
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
async function attachProviderSession(req) {
  const s = req.session || await sessionOf(req);
  if (!s) {
    throw Object.assign(new Error('Not signed in'), { status: 401, code: 'AUTH_REQUIRED' });
  }
  req.session = s;
  req.sessionAccount = s.accounts[Math.min(s.active || 0, s.accounts.length - 1)];
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
async function accountAuth(req, res, next) {
  try {
    await attachProviderSession(req);
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
 * completed". Neither provider helper attached one, so every refusal GitHub or
 * GitLab explained -- a workflow file rejected for want of scope, a conflict,
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

async function gh(acct, apiPath, opts = {}) {
  if (typeof acct === 'string') acct = { provider: 'github', token: acct };
  const provider = acct.provider || 'github';
  if (provider === 'gitlab') {
    const err = new Error('This feature is not yet supported for GitLab accounts');
    err.status = 501; throw err;
  }
  const token = acct.token;
  const API_BASE = provider === 'gitea'
    ? (await assertPublicBaseCached(acct.baseUrl)) + '/api/v1'
    : GH_API;
  const AUTH = provider === 'gitea' ? `token ${token}` : `Bearer ${token}`;
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
    err.status = r.status; err.body = data;
    err.code = providerFailureCode(r.status);
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
  const status = error && error.status >= 400 && error.status < 600 ? error.status : 500;
  const body = publicErrorBody(error, { correlationId: res.locals.correlationId });
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
    case 'pull.merge': return { pullNumber: Number(params.num || 0), mergeMethod: text(body.method || 'merge', 20) };
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
      const inspected = inspectRestoreAuthorization(req, body.authorization);
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
      scope: normalized.authorization.scope,
      activePolicies: resolved.activePolicies,
      activeExceptions: resolved.activeExceptions,
      evaluatedAt: resolved.resolvedAt
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

function mutationContext(action) {
  return async function enterMutationContext(req, res, next) {
    let descriptor;
    try {
      req.authorization = await resolveMutationAuthorization(req, action);
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

function governanceFailure(res, error) {
  const code = String(error && error.code || '');
  const known = /^(?:GOVERNANCE|MUTATION|AUTHORIZATION|SIMULATION|POLICY)_/.test(code);
  const rawStatus = Number(error && error.status);
  const status = known && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (!known) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), warn: 'governance operation failed',
      code: code || 'GOVERNANCE_OPERATION_FAILED'
    }));
  }
  return res.status(status).json({
    error: known ? cleanText(String(error.message || 'Governance operation failed'), 300) : 'Governance operation failed',
    code: known ? code : 'GOVERNANCE_OPERATION_FAILED'
  });
}

function governanceAccess(requiredRole) {
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
      req.governance = { ...context, service };
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
const requireRepoPath = normalizeRepoPath;
const requireBranchName = normalizeBranchName;
const requireCommitSha = normalizeCommitSha;
const encodePath = p => (p || '').split('/').map(encodeURIComponent).join('/');
const R = (req) => `/repos/${req.params.owner}/${req.params.repo}`;

/* ================= AUTH ================= */
/* ================= PROVIDERS ================= */
const PRIVATE_HOST_RX = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/i;
const IP_RX = /^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i;
function privateIp(ip) {
  const value = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (value.includes(':')) {
    const mapped = value.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return privateIp(mapped[1]);
    return value === '::' || value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) ||
      /^ff/.test(value) || /^2001:db8(?::|$)/.test(value);
  }
  const o = value.split('.').map(Number);
  if (o.length !== 4 || o.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224 ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
    (o[0] === 169 && o[1] === 254) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && (o[1] === 0 || o[1] === 168)) ||
    (o[0] === 198 && (o[1] === 18 || o[1] === 19 || o[1] === 51 && o[2] === 100)) ||
    (o[0] === 203 && o[1] === 0 && o[2] === 113);
}
const PUBLIC_BASE_CACHE = new Map();
async function assertPublicBaseCached(raw) {
  const key = String(raw || '').replace(/\/+$/, '');
  const cached = PUBLIC_BASE_CACHE.get(key);
  if (cached && Date.now() - cached.checkedAt < 60000) return cached.value;
  const value = await assertPublicBase(key);
  PUBLIC_BASE_CACHE.set(key, { value, checkedAt: Date.now() });
  if (PUBLIC_BASE_CACHE.size > 100) PUBLIC_BASE_CACHE.delete(PUBLIC_BASE_CACHE.keys().next().value);
  return value;
}
async function assertPublicBase(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Invalid server URL'), { status: 400 }); }
  if (u.protocol !== 'https:') throw Object.assign(new Error('Server URL must use https'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Server URL must not embed credentials'), { status: 400 });
  const host = u.hostname;
  const allow = String(process.env.NV_GIT_HOST_ALLOWLIST || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const canonicalHostedProvider = host.toLowerCase() === 'gitlab.com';
  if (process.env.NODE_ENV === 'production' && !canonicalHostedProvider && !allow.length) {
    throw Object.assign(new Error('Self-hosted Git servers require NV_GIT_HOST_ALLOWLIST in production'), { status: 403 });
  }
  if (allow.length && !allow.includes(host.toLowerCase())) throw Object.assign(new Error('That Git server is not in NV_GIT_HOST_ALLOWLIST'), { status: 403 });
  if (PRIVATE_HOST_RX.test(host)) throw Object.assign(new Error('Private or local server addresses are not allowed'), { status: 400 });
  if (IP_RX.test(host)) {
    if (privateIp(host.replace(/[[\]]/g, ''))) throw Object.assign(new Error('Private or local server addresses are not allowed'), { status: 400 });
    throw Object.assign(new Error('Use a hostname, not a raw IP address'), { status: 400 });
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some(a => privateIp(a.address)))
      throw Object.assign(new Error('That hostname resolves to a private address'), { status: 400 });
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error('Git server hostname could not be resolved'), { status: 400 });
  }
  return raw.replace(/\/+$/, '');
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

function alphaSafetyView(req, state) {
  const view = defaultSafety(state);
  if (!ALPHA_CONFIG.enabled) return view;
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
  return { ...view, protected: protectedRepositories };
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

function capabilityAccess(feature, options = {}) {
  return function enforceCapability(req, res, next) {
    try {
      req.capability = assertProviderCapability(req.gh, feature, options);
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
function providerCapabilityContext(account, feature, options = {}) {
  return {
    provider: account && account.provider || 'github',
    authority: providerAuthority(account),
    deployment: DEPLOYMENT_PROFILE,
    feature,
    authMethod: account && account.authMethod,
    tokenKind: githubTokenKind(account || {}),
    allowExperimental: options.allowExperimental === true
  };
}
function assertProviderCapability(account, feature, options = {}) {
  return assertCapabilityAvailable(
    CAPABILITY_DOCUMENT,
    providerCapabilityContext(account, feature, options)
  );
}
function requestSupportsCapability(req, feature) {
  return resolveCapability(
    CAPABILITY_DOCUMENT,
    providerCapabilityContext(req.gh, feature)
  ).status === 'Supported';
}
function assertProviderBoundLfs(account) {
  const context = providerCapabilityContext(account, 'lfs', { allowExperimental: true });
  if (context.provider !== 'github' || context.authority !== 'github.com') {
    throw new CapabilityError(
      'LFS is not qualified for this provider and deployment.',
      'PROVIDER_CAPABILITY_UNAVAILABLE'
    );
  }
  return assertCapabilityAvailable(CAPABILITY_DOCUMENT, context);
}
async function glFetch(acct, apiPath, opts = {}) {
  const method = opts.method || 'GET';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    mutationGateway.assertProviderMutation({ provider: 'gitlab', baseUrl: acct.baseUrl || 'https://gitlab.com', method, apiPath, body: opts.body });
  }
  const base = (await assertPublicBaseCached(acct.baseUrl || 'https://gitlab.com')) + '/api/v4';
  const r = await fetchT(base + apiPath, {
    method,
    headers: {
      'PRIVATE-TOKEN': acct.token, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'error'
  }, opts.timeoutMs || (opts.raw ? UPLOAD_TIMEOUT_MS : 20000));
  if (opts.raw) return r;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || `GitLab error ${r.status}`);
    err.status = r.status; err.code = providerFailureCode(r.status); throw err;
  }
  return data;
}
const glId = req => encodeURIComponent(`${req.params.owner}/${req.params.repo}`);
async function glLastCommit(acct, id, branch) {
  try { const c = await glFetch(acct, `/projects/${id}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`); return c[0] && c[0].id; }
  catch { return null; }
}
async function providerIdentity(acct) {
  if ((acct.provider || 'github') === 'gitlab') {
    const user = await glFetch(acct, '/user');
    return { login: user.username, name: user.name, avatar_url: user.avatar_url, id: user.id };
  }
  if (acct && acct.authMethod === 'github-app') {
    return { login: acct.login, name: acct.login, avatar_url: acct.avatar, id: acct.installationAccountId };
  }
  return gh(acct, '/user');
}
async function disconnectAlphaProviderAccount(req, accountOrAccounts) {
  const accounts = (Array.isArray(accountOrAccounts) ? accountOrAccounts : [accountOrAccounts])
    .filter(account => account && typeof account === 'object');
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
    req.session.accounts = req.session.accounts.filter(account => !targetKeys.has(hostedAccountKey(account)));
    req.session.active = req.session.accounts.length
      ? Math.min(Math.max(Number(req.session.active) || 0, 0), req.session.accounts.length - 1)
      : 0;
    clearStepUpAuthorization(req.session);
    return Object.freeze({ complete: true, legacy: true, results: Object.freeze([]) });
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
      finalizeDisconnect: input => alphaPrivacyStore.finalizeProviderDisconnect(input)
    });
    results.push(result);
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
  return Object.freeze({
    complete: results.length === accounts.length
      && results.every(result => result.providerStateRemoved),
    legacy: false,
    results: Object.freeze(results)
  });
}

function providerDisconnectPending(res, cleanup) {
  return res.status(202).json({
    ok: false,
    status: 'pending',
    results: cleanup.results
  });
}

const ALPHA_FEEDBACK_FIELDS = new Set([
  'feature', 'correlationId', 'provider', 'capabilityStatus', 'errorCode', 'runtime'
]);

function alphaFeedbackInput(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !ALPHA_FEEDBACK_FIELDS.has(key))
  ) {
    throw Object.assign(new Error('Feedback contains unsupported fields'), {
      status: 400,
      code: 'ALPHA_FEEDBACK_FIELDS_REJECTED'
    });
  }
  return value;
}

function alphaFeedbackFailure(res, error) {
  const code = String(error && error.code || '');
  if (code === 'ALPHA_FEEDBACK_FIELDS_REJECTED') {
    return res.status(400).json({
      error: 'Feedback contains unsupported fields',
      code
    });
  }
  if (['ALPHA_TESTER_DELETING', 'ALPHA_TESTER_REVOKED', 'ALPHA_TESTER_UNAVAILABLE'].includes(code)) {
    return res.status(409).json({
      error: 'Feedback is unavailable for this alpha session',
      code: 'ALPHA_FEEDBACK_UNAVAILABLE'
    });
  }
  if (error instanceof TypeError) {
    return res.status(400).json({
      error: 'Feedback fields are invalid',
      code: 'ALPHA_FEEDBACK_INVALID'
    });
  }
  return res.status(500).json({ error: 'Feedback could not be recorded' });
}

function alphaDeletionConfirmation(req, res, next) {
  if (!ALPHA_CONFIG.enabled) return next();
  if (!req.body || req.body.confirm !== 'DELETE ALPHA DATA') {
    return res.status(400).json({
      error: 'Exact deletion confirmation is required',
      code: 'ALPHA_DELETION_CONFIRMATION_REQUIRED'
    });
  }
  return next();
}

function alphaDeletionAuthentication(req, res, next) {
  if (!ALPHA_CONFIG.enabled || (req.alpha && req.alpha.deletionRecovery === true)) {
    return next();
  }
  return accountAuth(req, res, next);
}

function alphaDeletionBlocked(res, result) {
  const cleanupBlocks = (Array.isArray(result && result.cleanupBlocks)
    ? result.cleanupBlocks
    : [])
    .filter(item => item && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(item.code || '')))
    .slice(0, 20)
    .map(item => Object.freeze({
      code: String(item.code),
      count: Math.max(0, Math.min(Number(item.count) || 0, 1000))
    }));
  return res.status(409).json({
    error: 'Alpha deletion is blocked until provider cleanup is verified',
    code: 'ALPHA_DELETION_BLOCKED',
    cleanupBlocks
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
  const s = (await sessionOf(req)) || { accounts: [], active: 0 };
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
    const sid = current && typeof current.sid === 'string' && current.sid
      ? current.sid
      : crypto.randomBytes(24).toString('hex');
    const connected = await alphaPrivacyStore.connectHostedProviderAccount({
      testerId: req.alpha.testerId,
      sessionId: sid,
      account,
      authority: providerAuthority(account),
      capacity: ACCOUNT_CAP()
    });
    req.session = connected.session;
    req[HOSTED_SESSION_BASE] = structuredClone(connected.session);
    req[HOSTED_SESSION_REVISION] = connected.revision;
    setCookieRaw(res, seal({ sid }));
    return;
  }
  while (s.accounts.length > ACCOUNT_CAP()) s.accounts.shift();
  s.active = s.accounts.length - 1;
  clearStepUpAuthorization(s);
  await setSession(req, res, s);
}
app.post('/api/login', async (req, res) => {
  try {
    const token = ((req.body && req.body.token) || '').trim();
    const provider = ['github', 'gitlab', 'gitea'].includes(req.body && req.body.provider) ? req.body.provider : 'github';
    const baseUrl = ((req.body && req.body.baseUrl) || '').trim();
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (provider === 'gitea' && !/^https?:\/\//.test(baseUrl)) return res.status(400).json({ error: 'Gitea needs your server URL (https://…)' });
    let safeBase = baseUrl;
    if (baseUrl && (provider === 'gitea' || provider === 'gitlab')) safeBase = await assertPublicBase(baseUrl);
    const acct = { provider, token, baseUrl: safeBase };
    const user = await providerIdentity(acct);
    await addAccount(req, res, token, user, provider, (typeof safeBase !== 'undefined' && safeBase) || baseUrl, { authMethod: 'token' });
    res.json({ login: user.login, name: user.name, avatar: user.avatar_url, provider, authMethod: 'token' });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: 'Invalid token for that provider.' });
    fail(res, e);
  }
});
app.get('/api/accounts', accountAuth, (req, res) => {
  const activeIdx = Math.min(req.session.active || 0, req.session.accounts.length - 1);
  res.json({
    active: activeIdx,
    accounts: req.session.accounts.map((a, index) => {
      if (ALPHA_CONFIG.enabled && a.authMethod === 'github-app') {
        return {
          login: retainedActor(req),
          avatar: '',
          provider: 'github',
          authMethod: 'github-app',
          ...githubAppConnectionView(a, index === activeIdx)
        };
      }
      return {
        login: a.login, avatar: a.avatar,
        provider: a.provider || 'github',
        authMethod: a.authMethod || 'token',
        host: a.baseUrl ? String(a.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null,
        ...(a.authMethod === 'github-app' ? {
          installationId: Number(a.installationId),
          repositorySelection: a.repositorySelection === 'all' ? 'all' : 'selected',
          authorizedByLogin: String(a.authorizedByLogin || ''),
          status: String(a.installationStatus || 'connected')
        } : {})
      };
    })
  });
});
app.post('/api/accounts/switch-idx', accountAuth, async (req, res) => {
  try {
    const i = req.body && req.body.idx;
    if (!(i >= 0 && i < req.session.accounts.length)) return res.status(400).json({ error: 'Bad index' });
    req.session.active = i;
    clearStepUpAuthorization(req.session);
    await setSession(req, res, req.session);
    res.json({ ok: true, login: req.session.accounts[i].login });
  } catch (e) { fail(res, e); }
});
/* remove ONE account, keep the rest signed in */
app.post('/api/accounts/remove', accountAuth, async (req, res) => {
  try {
    const i = req.body && req.body.idx;
    if (!(i >= 0 && i < req.session.accounts.length)) return res.status(400).json({ error: 'Bad index' });
    const removed = req.session.accounts[i];
    const previousCount = req.session.accounts.length;
    const cleanup = await disconnectAlphaProviderAccount(req, removed);
    if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
    if (ALPHA_CONFIG.enabled) {
      if (previousCount === 1) {
        clearProviderSessionCookie(req, res);
        return res.json({ ok: true, empty: true });
      }
      req.session = await sessionOf(req);
      return res.json({ ok: true, active: Number(req.session.active) || 0 });
    }
    if (!req.session.accounts.length) {
      await destroySession(req, res);
      return res.json({ ok: true, removed: removed.login, empty: true });
    }
    await setSession(req, res, req.session);
    res.json({ ok: true, removed: removed.login, active: req.session.accounts[req.session.active].login });
  } catch (e) { fail(res, e); }
});
app.post('/api/accounts/switch', accountAuth, async (req, res) => {
  try {
    const i = req.session.accounts.findIndex(a => a.login === (req.body && req.body.login));
    if (i < 0) return res.status(404).json({ error: 'Account not in session' });
    req.session.active = i;
    clearStepUpAuthorization(req.session);
    await setSession(req, res, req.session);
    res.json({ ok: true, login: req.session.accounts[i].login });
  } catch (e) { fail(res, e); }
});
/* ---- OAuth (activates when GITHUB_CLIENT_ID/SECRET env vars are set) ---- */
const OAUTH_ID = (process.env.GITHUB_CLIENT_ID || '').trim();
const OAUTH_SECRET = (process.env.GITHUB_CLIENT_SECRET || '').trim();
const GITHUB_APP_FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_USED_GITHUB_APP_STATES = 10000;
const USED_GITHUB_APP_STATES = new Map();
/*
 * The same guard the step-up grant uses, under its own kind. Without a
 * database this stays the bounded in-process Map it has always been; with one,
 * an OAuth state consumed on any instance is consumed on all of them.
 */
function githubAppStateStore() {
  if (!DB_URL) {
    return memorySingleUseStore(USED_GITHUB_APP_STATES, { maxEntries: MAX_USED_GITHUB_APP_STATES });
  }
  return durableSingleUseStore();
}
function githubAppStateReplayKey(slot, nonce, identity) {
  return crypto.createHmac('sha256', GITHUB_APP_STATE_REPLAY_KEY)
    .update(`${String(slot)}|${String(nonce)}|${String(identity)}`)
    .digest('base64url');
}
function requireGithubAppFeature(req, res, next) {
  if (!GITHUB_APP_CONFIG.enabled || !githubAppBroker) {
    return res.status(404).json({ error: 'GitHub App authentication is not configured', code: 'GITHUB_APP_DISABLED' });
  }
  next();
}
function githubAppPending(session) {
  const security = sessionSecurityState(session);
  if (!security.githubApp || typeof security.githubApp !== 'object') security.githubApp = {};
  return security.githubApp;
}
async function consumeGithubAppPending(session, slot, nonce, identity, now = Date.now()) {
  const store = githubAppPending(session);
  const pending = store[slot];
  /*
   * The pending state is spent before it is checked, and stays that way even
   * when the check fails. That is deliberate and older than this change: an
   * attempt against a state is the state's one use, so a wrong nonce cannot be
   * retried until it is guessed.
   */
  delete store[slot];
  if (!pending || !secureTextEqual(pending.nonce, nonce) || !secureTextEqual(pending.identityKey, identity) || Number(pending.expiresAt) < Number(now)) {
    throw new GithubAppError('GitHub App authorization state is missing, expired, or already used', 'GITHUB_APP_STATE_REPLAY', 403);
  }
  const replayKey = githubAppStateReplayKey(slot, nonce, identity);
  let claimed;
  try {
    claimed = await githubAppStateStore().consumeOnce({
      kind: 'github-app-state',
      key: replayKey,
      expiresAt: Number(pending.expiresAt),
      now: Number(now)
    });
  } catch (error) {
    /* Unverifiable is not the same as replayed: this one is worth retrying and
       a replay never is, so they must not share a code or a status. */
    throw new GithubAppError(
      'GitHub App authorization state cannot be verified right now', 'GITHUB_APP_STATE_UNAVAILABLE', 503
    );
  }
  if (!claimed) {
    throw new GithubAppError('GitHub App authorization state is missing, expired, or already used', 'GITHUB_APP_STATE_REPLAY', 403);
  }
  return pending;
}
async function githubAppCallbackContext(req, res) {
  const session = await sessionOf(req);
  if (!session) throw new GithubAppError('Sign in before connecting a GitHub App', 'AUTH_REQUIRED', 401);
  req.session = session;
  req.sessionAccount = session.accounts[Math.min(session.active || 0, session.accounts.length - 1)];
  req.gh = { ...req.sessionAccount };
  await ensureSessionSecurity(req, res);
  return requestSecurityContext(req);
}
function githubAppRedirect(res, result, code = '') {
  const target = new URL('/', 'https://nebulaverse.invalid');
  target.searchParams.set('githubApp', result);
  if (code) target.searchParams.set('code', cleanText(code, 100));
  res.redirect(`${target.pathname}${target.search}`);
}
function githubAppConnectionView(account, active) {
  if (ALPHA_CONFIG.enabled) {
    return {
      connectionKey: identityKey(account),
      accountType: String(account.installationAccountType || 'User'),
      repositorySelection: account.repositorySelection === 'all' ? 'all' : 'selected',
      status: String(account.installationStatus || 'connected'),
      lastVerifiedAt: String(account.lastVerifiedAt || ''),
      active: !!active
    };
  }
  return {
    installationId: Number(account.installationId),
    accountLogin: String(account.login || ''),
    accountType: String(account.installationAccountType || 'User'),
    avatar: String(account.avatar || ''),
    repositorySelection: account.repositorySelection === 'all' ? 'all' : 'selected',
    permissions: account.permissions && typeof account.permissions === 'object' ? { ...account.permissions } : {},
    authorizedByLogin: String(account.authorizedByLogin || ''),
    status: String(account.installationStatus || 'connected'),
    lastVerifiedAt: String(account.lastVerifiedAt || ''),
    installationUrl: String(account.installationHtmlUrl || ''),
    active: !!active
  };
}
app.get('/api/config', (req, res) => res.json({
  ...hostedConfigProjection({
    profile: HOSTING_PROFILE,
    alphaMode: ALPHA_CONFIG.mode,
    termsVersion: ALPHA_CONFIG.termsVersion,
    limits: PUBLIC_ALPHA_LIMITS,
    database: _databaseReadiness
  }),
  oauth: !!(OAUTH_ID && OAUTH_SECRET),
  githubApp: { enabled: !!GITHUB_APP_CONFIG.enabled, webhookConfigured: !!GITHUB_APP_CONFIG.webhookConfigured },
  uploadMaxMb: UPLOAD_MAX_MB,
  gitDataMaxMb: GIT_DATA_MAX_MB,
  nativePushMaxMb: NATIVE_PUSH_MAX_MB,
  /* The boundary above which an upload leaves the blob API for a native push.
   * Published because the browser labels queued files against it; a copy
   * written into the browser would be a second source of truth. */
  contentsMaxMb: CONTENTS_MAX / MB
}));
app.get('/api/capabilities', (req, res) => {
  const provider = ['github', 'gitlab', 'gitea'].includes(req.query.provider)
    ? req.query.provider : 'github';
  const authority = provider === 'github'
    ? 'github.com' : String(req.query.authority || '').toLowerCase();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(projectCapabilities(CAPABILITY_DOCUMENT, {
    provider, authority, deployment: DEPLOYMENT_PROFILE
  }));
});
app.get('/api/account/capabilities', providerSessionAccess, (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.json(projectCapabilities(CAPABILITY_DOCUMENT, providerCapabilityContext(req.gh)));
});
app.post('/api/github-app/connect', requireGithubAppFeature, auth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if ((req.gh.provider || 'github') !== 'github' || req.gh.authMethod === 'github-app') {
      return res.status(400).json({
        error: 'Switch to a GitHub PAT or GitHub OAuth account before connecting the GitHub App',
        code: 'GITHUB_APP_USER_ACCOUNT_REQUIRED'
      });
    }
    const user = await providerIdentity(req.gh);
    const userId = Number(user && user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !user.login) {
      throw new GithubAppError('GitHub returned incomplete user identity data', 'GITHUB_APP_USER_INVALID', 502);
    }
    const context = requestSecurityContext(req);
    const nonce = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    const state = createGithubAppState(GITHUB_APP_STATE_SECRET, { ...context, purpose: 'user-auth' }, {
      now, ttlMs: GITHUB_APP_FLOW_TTL_MS, nonce
    });
    githubAppPending(req.session).userAuth = {
      nonce,
      expiresAt: now + GITHUB_APP_FLOW_TTL_MS,
      identityKey: context.identityKey,
      userId,
      login: String(user.login)
    };
    await setSession(req, res, req.session);
    res.json({ url: githubAppBroker.authorizationUrl(state) });
  } catch (error) {
    recordGithubAppAudit(identityKey(req.sessionAccount), 'authorization.rejected', null, {
      actor: retainedActor(req), reasonCode: error.code || 'CONNECT_FAILED'
    }).catch(() => {});
    fail(res, error);
  }
});
app.get('/api/github-app/oauth/callback', requireGithubAppFeature, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const context = await githubAppCallbackContext(req, res);
    const claims = verifyGithubAppState(GITHUB_APP_STATE_SECRET, req.query && req.query.state, { ...context, purpose: 'user-auth' });
    const pending = await consumeGithubAppPending(req.session, 'userAuth', claims.nonce, context.identityKey);
    await setSession(req, res, req.session);
    const exchange = await githubAppBroker.exchangeUserCode(req.query && req.query.code);
    const user = await githubAppBroker.getAuthorizedUser(exchange.token);
    if (Number(user.id) !== Number(pending.userId) || String(user.login).toLowerCase() !== String(pending.login).toLowerCase()) {
      throw new GithubAppError('GitHub App authorization belongs to a different user', 'GITHUB_APP_USER_MISMATCH', 403);
    }
    const nonce = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    const tokenLifetime = exchange.expiresIn > 0 ? Math.min(GITHUB_APP_FLOW_TTL_MS, exchange.expiresIn * 1000) : GITHUB_APP_FLOW_TTL_MS;
    const state = createGithubAppState(GITHUB_APP_STATE_SECRET, { ...context, purpose: 'installation-claim' }, {
      now, ttlMs: tokenLifetime, nonce
    });
    githubAppPending(req.session).installation = {
      nonce,
      expiresAt: now + tokenLifetime,
      identityKey: context.identityKey,
      userToken: exchange.token,
      userId: user.id,
      login: user.login
    };
    await setSession(req, res, req.session);
    res.redirect(githubAppBroker.installationUrl(state));
  } catch (error) {
    recordGithubAppAudit('github-app-callback', 'authorization.rejected', null, {
      actor: retainedActor(req), reasonCode: error.code || 'CALLBACK_FAILED'
    }).catch(() => {});
    githubAppRedirect(res, 'error', error.code || 'GITHUB_APP_CALLBACK_FAILED');
  }
});
app.get('/api/github-app/setup', requireGithubAppFeature, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const context = await githubAppCallbackContext(req, res);
    const claims = verifyGithubAppState(GITHUB_APP_STATE_SECRET, req.query && req.query.state, { ...context, purpose: 'installation-claim' });
    const pending = await consumeGithubAppPending(req.session, 'installation', claims.nonce, context.identityKey);
    await setSession(req, res, req.session);
    const installationId = Number(req.query && req.query.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new GithubAppError('GitHub App installation ID is invalid', 'GITHUB_APP_INSTALLATION_INVALID', 400);
    }
    const userVisibleInstallation = await githubAppBroker.findUserInstallation(pending.userToken, installationId);
    const installation = await githubAppBroker.getInstallation(installationId);
    if (userVisibleInstallation.account.id !== installation.account.id ||
        String(userVisibleInstallation.account.login).toLowerCase() !== String(installation.account.login).toLowerCase()) {
      throw new GithubAppError('GitHub App installation ownership verification failed', 'GITHUB_APP_INSTALLATION_OWNERSHIP', 403);
    }
    const authorizedUser = { id: Number(pending.userId), login: String(pending.login) };
    await addAccount(req, res, '', {
      login: installation.account.login,
      avatar_url: installation.account.avatarUrl
    }, 'github', '', {
      authMethod: 'github-app',
      account: {
        installationId: installation.id,
        installationAccountId: installation.account.id,
        installationAccountType: installation.account.type,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        authorizedByLogin: authorizedUser.login,
        authorizedById: authorizedUser.id,
        authorizedByIdentityKey: context.identityKey,
        installationHtmlUrl: installation.htmlUrl,
        installationStatus: 'connected',
        lastVerifiedAt: new Date().toISOString()
      }
    });
    const connectedAccount = req.session.accounts.find(item => (
      item.authMethod === 'github-app' && Number(item.installationId) === installation.id
    ));
    if (!connectedAccount || !/^[0-9a-f]{64}$/.test(String(connectedAccount.identityKey || ''))) {
      throw new GithubAppError(
        'GitHub App connection identity is unavailable',
        'GITHUB_APP_ACCOUNT_INVALID',
        500
      );
    }
    const installationIdentity = ALPHA_CONFIG.enabled
      ? connectedAccount.identityKey
      : context.identityKey;
    await Promise.allSettled([
      persistGithubAppInstallation(installationIdentity, installation, authorizedUser, 'connected'),
      recordGithubAppAudit(installationIdentity, 'installation.connected', installation.id, {
        actor: retainedActor(req),
        accountType: installation.account.type,
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        status: 'connected'
      })
    ]);
    githubAppRedirect(res, 'connected');
  } catch (error) {
    recordGithubAppAudit('github-app-setup', 'authorization.rejected', req.query && req.query.installation_id, {
      actor: retainedActor(req), reasonCode: error.code || 'SETUP_FAILED'
    }).catch(() => {});
    githubAppRedirect(res, 'error', error.code || 'GITHUB_APP_SETUP_FAILED');
  }
});
app.get('/api/github-app/status', accountAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const active = Math.min(req.session.active || 0, req.session.accounts.length - 1);
  const connections = req.session.accounts
    .map((account, index) => account.authMethod === 'github-app' ? githubAppConnectionView(account, index === active) : null)
    .filter(Boolean);
  res.json({
    enabled: !!GITHUB_APP_CONFIG.enabled,
    webhookConfigured: !!GITHUB_APP_CONFIG.webhookConfigured,
    connections
  });
});
app.post('/api/github-app/refresh', requireGithubAppFeature, accountAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const requestedConnectionKey = String(req.body && req.body.connectionKey || '');
  const requestedInstallationId = Number(req.body && req.body.installationId);
  const account = req.session.accounts.find(item => item.authMethod === 'github-app' && (
    ALPHA_CONFIG.enabled
      ? identityKey(item) === requestedConnectionKey
      : Number(item.installationId) === requestedInstallationId
  ));
  if (!account) return res.status(404).json({ error: 'GitHub App installation is not connected in this session', code: 'GITHUB_APP_CONNECTION_NOT_FOUND' });
  const installationId = Number(account.installationId);
  try {
    const installation = await githubAppBroker.getInstallation(installationId);
    Object.assign(account, {
      login: installation.account.login,
      avatar: installation.account.avatarUrl,
      installationAccountId: installation.account.id,
      installationAccountType: installation.account.type,
      repositorySelection: installation.repositorySelection,
      permissions: { ...installation.permissions },
      installationHtmlUrl: installation.htmlUrl,
      installationStatus: 'connected',
      lastVerifiedAt: new Date().toISOString()
    });
    if (!ALPHA_CONFIG.enabled) githubAppBroker.invalidate(installationId);
    clearStepUpAuthorization(req.session);
    await setSession(req, res, req.session);
    const authorizedUser = { id: Number(account.authorizedById), login: String(account.authorizedByLogin || '') };
    const installationIdentity = ALPHA_CONFIG.enabled
      ? account.identityKey
      : account.authorizedByIdentityKey;
    await Promise.allSettled([
      persistGithubAppInstallation(installationIdentity, installation, authorizedUser, 'connected'),
      recordGithubAppAudit(installationIdentity, 'installation.refreshed', installation.id, {
        actor: retainedActor(req),
        repositorySelection: installation.repositorySelection,
        permissions: installation.permissions,
        status: 'connected'
      })
    ]);
    res.json({ connection: githubAppConnectionView(account, req.sessionAccount === account) });
  } catch (error) {
    if (error.code === 'GITHUB_APP_INSTALLATION_SUSPENDED') account.installationStatus = 'suspended';
    recordGithubAppAudit(
      ALPHA_CONFIG.enabled ? account.identityKey : account.authorizedByIdentityKey,
      error.code === 'GITHUB_APP_INSTALLATION_SUSPENDED' ? 'installation.suspended' : 'authorization.rejected', installationId, {
      actor: retainedActor(req), status: account.installationStatus || 'unavailable', reasonCode: error.code || 'REFRESH_FAILED'
    }).catch(() => {});
    fail(res, error);
  }
});
app.post('/api/github-app/disconnect', accountAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const requestedConnectionKey = String(req.body && req.body.connectionKey || '');
    const requestedInstallationId = Number(req.body && req.body.installationId);
    if (ALPHA_CONFIG.enabled && !/^[0-9a-f]{64}$/.test(requestedConnectionKey)) {
      return res.status(400).json({ error: 'GitHub App connection key is invalid', code: 'GITHUB_APP_CONNECTION_INVALID' });
    }
    if (!ALPHA_CONFIG.enabled && (!Number.isSafeInteger(requestedInstallationId) || requestedInstallationId <= 0)) {
      return res.status(400).json({ error: 'GitHub App installation ID is invalid', code: 'GITHUB_APP_INSTALLATION_INVALID' });
    }
    const index = req.session.accounts.findIndex(item => item.authMethod === 'github-app' && (
      ALPHA_CONFIG.enabled
        ? identityKey(item) === requestedConnectionKey
        : Number(item.installationId) === requestedInstallationId
    ));
    if (index < 0) return res.status(404).json({ error: 'GitHub App installation is not connected in this session', code: 'GITHUB_APP_CONNECTION_NOT_FOUND' });
    const removed = req.session.accounts[index];
    const installationId = Number(removed.installationId);
    const previousCount = req.session.accounts.length;
    const cleanup = await disconnectAlphaProviderAccount(req, removed);
    if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
    if (ALPHA_CONFIG.enabled) {
      if (previousCount === 1) {
        clearProviderSessionCookie(req, res);
        return res.json({ ok: true, empty: true });
      }
      req.session = await sessionOf(req);
      return res.json({ ok: true, active: Number(req.session.active) || 0 });
    }
    if (!req.session.accounts.length) {
      await destroySession(req, res);
      return res.json({ ok: true, empty: true, installationId });
    }
    await setSession(req, res, req.session);
    res.json({ ok: true, installationId, active: req.session.accounts[req.session.active].login });
  } catch (error) { fail(res, error); }
});
app.get('/api/security/scanner-status', auth, capabilityAccess('upload-security'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const status = scannerStatus();
  res.json({ ...status, note: status.yara.configured ? 'Configured YARA rules are applied to raw uploads before provider writes.' : 'Built-in bounded signatures are active. Configure NV_YARA_RULES_PATH and a trusted YARA binary to enable optional YARA rules.' });
});
app.get('/api/security/csrf', accountAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const token = createCsrfToken(CSRF_SECRET, requestSecurityContext(req), { now, ttlMs: CSRF_TTL_MS });
  res.json({ token, expiresAt: new Date(now + CSRF_TTL_MS).toISOString() });
});
app.post('/api/security/step-up', providerSessionAccess, alphaStepUpRepositoryAccess, auth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { action, scope, confirm, credential } = req.body || {};
    if (String(confirm || '').trim() !== String(req.gh.login || '')) {
      return res.status(400).json({ error: 'Type the active account login exactly to continue', code: 'STEP_UP_CONFIRMATION_REQUIRED' });
    }
    const authMethod = req.gh.authMethod || 'token';
    let assurance;
    if (authMethod === 'token') {
      const freshCredential = String(credential || '').trim();
      if (!freshCredential || freshCredential.length > 1024) {
        return res.status(400).json({ error: 'Re-enter the active provider token', code: 'STEP_UP_CREDENTIAL_REQUIRED' });
      }
      let verified;
      try { verified = await providerIdentity({ ...req.gh, token: freshCredential }); }
      catch (error) {
        if (error && error.status === 401) return res.status(401).json({ error: 'The provider token could not re-authenticate this account', code: 'STEP_UP_CREDENTIAL_INVALID' });
        throw error;
      }
      if (String(verified.login || '').toLowerCase() !== String(req.gh.login || '').toLowerCase()) {
        return res.status(403).json({ error: 'The credential belongs to a different provider identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
      }
      assurance = 'credential';
    } else if (authMethod === 'github-app') {
      const installation = await githubAppBroker.getInstallation(req.gh.installationId);
      if (String(installation.account.login || '').toLowerCase() !== String(req.gh.login || '').toLowerCase()) {
        return res.status(403).json({ error: 'The GitHub App installation no longer matches this identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
      }
      assurance = 'github-app';
    } else {
      const verified = await providerIdentity(req.gh);
      if (String(verified.login || '').toLowerCase() !== String(req.gh.login || '').toLowerCase()) {
        return res.status(403).json({ error: 'The active provider authorization no longer matches this identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
      }
      assurance = 'oauth-session';
    }
    const operation = req.alphaStepUpOperation || normalizeStepUpRequest(action, scope, {
      provider: req.gh.provider || 'github', identityKey: identityKey(req.gh)
    });
    const now = Date.now();
    const expiresAt = now + STEP_UP_TTL_MS;
    const jti = crypto.randomUUID();
    const grant = createStepUpGrant(STEP_UP_SECRET, {
      ...requestSecurityContext(req), action: operation.action, scope: operation.scope, assurance
    }, { now, ttlMs: STEP_UP_TTL_MS, jti });
    sessionSecurityState(req.session).stepUp = {
      jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt, assurance
    };
    await setSession(req, res, req.session);
    res.json({ grant, action: operation.action, assurance, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) { fail(res, error); }
});
app.get('/api/oauth/login', (req, res) => {
  if (!OAUTH_ID) return res.status(404).json({ error: 'OAuth not configured' });
  const stateVal = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `nv_oauth=${stateVal}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  const scope = req.query.permission === 'repository-delete' ? 'repo delete_repo' : 'repo';
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(OAUTH_ID)}&scope=${encodeURIComponent(scope)}&state=${stateVal}`);
});
app.get('/api/oauth/callback', async (req, res) => {
  /*
   * Every failure here used to end on a bare page: a sentence of unstyled text
   * on white, no navigation, nothing to press. The only way back into the
   * application was to edit the address bar by hand, which is not a recovery
   * a reader on a phone should be asked to perform.
   *
   * So a failed sign-in returns to the application and says what happened. The
   * state cookie is cleared on the way out, because a second attempt must start
   * a fresh exchange: an authorization code is single-use, and retrying with a
   * spent one is itself one of the failures being reported.
   */
  const abandon = reason => {
    res.append('Set-Cookie', `nv_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return res.redirect(`/?oauth=${encodeURIComponent(String(reason || 'failed').slice(0, 64))}`);
  };
  try {
    const state = getCookie(req, 'nv_oauth');
    if (!req.query.code || !state || req.query.state !== state) return abandon('state_mismatch');
    const tr = await fetchT('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: OAUTH_ID, client_secret: OAUTH_SECRET, code: req.query.code }),
      redirect: 'error'
    });
    /*
     * Read the body once, as text, and parse it here. The provider answers this
     * endpoint with an HTML page when it refuses the request outright rather
     * than the exchange -- a rate limit, an unrecognised client, an outage --
     * and handing that to a JSON parser throws "Unexpected token '<'", which
     * then surfaced as the literal text of the failure page.
     */
    const raw = await tr.text();
    let td;
    try { td = JSON.parse(raw); }
    catch { return abandon('provider_unreadable'); }
    /* The provider names its own refusal; an expired or already-spent code
       arrives here as bad_verification_code rather than as a bare failure. */
    if (!td.access_token) return abandon(td.error || 'exchange_failed');
    const user = await gh(td.access_token, '/user');
    await addAccount(req, res, td.access_token, user, 'github', '', { authMethod: 'oauth' });
    /*
     * Marked as entered. Signing in with the provider is a full page trip --
     * away to GitHub and back to a fresh load -- and the front door is where a
     * fresh load begins. With entry open the door stays put by design, so a
     * reader who had just finished signing in was returned to it and asked to
     * continue to sign in. The marker says this load is the far side of a
     * completed sign-in, not a new arrival, and carries no identity of its
     * own: the session cookie is what admits anyone.
     */
    res.redirect('/?entered=1');
  } catch (e) { return abandon('unexpected'); }
});
app.get('/api/alpha/privacy', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ALPHA_CONFIG.enabled) return res.status(404).json({ error: 'Not found' });
  return res.json({
    termsVersion: ALPHA_CONFIG.termsVersion,
    retention: alphaRetentionPolicy(),
    retainedIntegrityMetadata: true,
    sourceContentUsedForAnalytics: false
  });
});
app.post('/api/alpha/feedback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ALPHA_CONFIG.enabled) return res.status(404).json({ error: 'Not found' });
  try {
    const input = alphaFeedbackInput(req.body);
    const sanitized = sanitizeFeedback(
      { feature: input.feature },
      {
        releaseVersion: APP_VERSION,
        correlationId: input.correlationId,
        provider: input.provider,
        capabilityStatus: input.capabilityStatus,
        errorCode: input.errorCode,
        runtime: input.runtime,
        timestamp: new Date()
      }
    );
    const recorded = await alphaPrivacyStore.recordFeedback({
      testerId: req.alpha.testerId,
      releaseVersion: APP_VERSION,
      correlationId: sanitized.correlationId,
      provider: sanitized.provider,
      feature: sanitized.feature,
      capabilityStatus: sanitized.capabilityStatus,
      errorCode: sanitized.errorCode,
      runtime: sanitized.runtime,
      occurredAt: sanitized.timestamp
    });
    return res.status(201).json({
      ok: recorded.recorded === true,
      createdAt: recorded.createdAt
    });
  } catch (error) {
    return alphaFeedbackFailure(res, error);
  }
});
app.post('/api/logout', accountAuth, async (req, res) => {
  try {
    const cleanup = await disconnectAlphaProviderAccount(req, req.session.accounts);
    if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
    if (ALPHA_CONFIG.enabled) clearProviderSessionCookie(req, res);
    else await destroySession(req, res);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.post('/api/alpha/providers/disconnect-all', accountAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!ALPHA_CONFIG.enabled) return res.status(404).json({ error: 'Not found' });
    const cleanup = await disconnectAlphaProviderAccount(req, req.session.accounts);
    if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
    const revocationGuidance = cleanup.results.map(result => result.revocationGuidance);
    clearProviderSessionCookie(req, res);
    return res.json({ ok: true, revocationGuidance });
  } catch (error) { fail(res, error); }
});
app.post('/api/alpha/delete', alphaDeletionConfirmation, alphaDeletionAuthentication, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!ALPHA_CONFIG.enabled) return res.status(404).json({ error: 'Not found' });
    const recovery = req.alpha.deletionRecovery === true;
    if (!recovery) {
      const cleanup = await disconnectAlphaProviderAccount(req, req.session.accounts);
      if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
      const deletion = await alphaPrivacyStore.createDeletionRequest({
        testerId: req.alpha.testerId
      });
      if (deletion.status === 'blocked') return alphaDeletionBlocked(res, deletion);
    }
    const purge = await alphaPrivacyStore.purgeTester({ testerId: req.alpha.testerId });
    if (purge.status !== 'complete' || !purge.providerCleanupVerified) {
      return alphaDeletionBlocked(res, purge);
    }
    clearProviderSessionCookie(req, res);
    const providerCookie = res.getHeader('Set-Cookie');
    setAlphaCookie(res, '', 0);
    const alphaCookie = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [providerCookie, alphaCookie]);
    return res.json({
      ok: true,
      ...purge
    });
  } catch (error) { fail(res, error); }
});
app.get('/api/me', accountAuth, async (req, res) => {
  try {
    const provider = req.gh.provider || 'github';
    let out;
    if (provider === 'gitlab') {
      const u = await glFetch(req.gh, '/user');
      out = { login: u.username, name: u.name, avatar: u.avatar_url };
    } else if (req.gh.authMethod === 'github-app') {
      out = ALPHA_CONFIG.enabled
        ? {
            login: retainedActor(req),
            name: retainedActor(req),
            avatar: '',
            ...githubAppConnectionView(req.sessionAccount, true)
          }
        : {
            login: req.sessionAccount.login,
            name: req.sessionAccount.login,
            avatar: req.sessionAccount.avatar,
            installationId: Number(req.sessionAccount.installationId),
            authorizedByLogin: String(req.sessionAccount.authorizedByLogin || ''),
            repositorySelection: req.sessionAccount.repositorySelection === 'all' ? 'all' : 'selected'
          };
    } else {
      const u = await gh(req.gh, '/user');
      out = { login: u.login, name: u.name, avatar: u.avatar_url };
    }
    res.setHeader('Cache-Control', 'no-store');
    /* The build a tester quotes in a fault report. It rides an authenticated
       response so the landing page no longer has to publish it to everyone. */
    res.json({ ...out, provider, authMethod: req.gh.authMethod || 'token', caps: providerCapabilities(req.gh), offlineCacheScope: offlineCacheScope(req), release: APP_VERSION });
  } catch (e) { fail(res, e); }
});
app.get('/api/rate', auth, capabilityAccess('rate.read', { allowExperimental: true }), async (req, res) => {
  try {
    const r = await gh(req.gh, '/rate_limit');
    res.json({ remaining: r.resources.core.remaining, limit: r.resources.core.limit, reset: r.resources.core.reset });
  } catch (e) { fail(res, e); }
});

async function governanceRepositoryFacts(req) {
  let info;
  let branches;
  if (req.gh.provider === 'gitlab') {
    const id = glId(req);
    [info, branches] = await Promise.all([
      glFetch(req.gh, `/projects/${id}`),
      glFetch(req.gh, `/projects/${id}/repository/branches?per_page=100`)
    ]);
    info = {
      defaultBranch: info.default_branch || null,
      visibility: info.visibility || 'unknown',
      archived: !!info.archived,
      pullRequestsEnabled: info.merge_requests_enabled !== false
    };
  } else {
    const branchesPath = req.gh.provider === 'gitea' ? `${R(req)}/branches?limit=100&page=1` : `${R(req)}/branches?per_page=100`;
    const result = await Promise.all([
      gh(req.gh, R(req)),
      gh(req.gh, branchesPath)
    ]);
    const repository = result[0] || {};
    branches = result[1];
    info = {
      defaultBranch: repository.default_branch || null,
      visibility: repository.visibility || (repository.private ? 'private' : 'public'),
      archived: !!repository.archived,
      pullRequestsEnabled: true
    };
  }
  const branchRows = Array.isArray(branches) ? branches : [];
  const protectedCandidates = branchRows
    .filter(branch => branch && branch.protected === true && branch.name)
    .map(branch => String(branch.name))
    .sort((a, b) => a.localeCompare(b));
  const protectedBranches = protectedCandidates.slice(0, 50);
  return {
    schemaVersion: 1,
    defaultBranch: info.defaultBranch,
    protectedBranches,
    pullRequestsEnabled: info.pullRequestsEnabled,
    visibility: info.visibility,
    archived: info.archived,
    branchesComplete: branchRows.length < 100,
    protectedBranchesTruncated: protectedCandidates.length > 50,
    resolvedForScopeKey: req.governance.scope.scopeKey
  };
}

/* ================= GOVERNANCE API (Phase 1 Tasks 6-8) ================= */
app.get('/api/repo/:owner/:repo/governance/templates', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const templates = await req.governance.service.listPolicyTemplates({ scope: req.governance.scope, authorization: req.governance.authorization });
    res.json({ templates });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/templates/:templateId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const template = await req.governance.service.getPolicyTemplate({ scope: req.governance.scope, authorization: req.governance.authorization, templateId: req.params.templateId });
    res.json({ template });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/baselines/generate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const repositoryFacts = await governanceRepositoryFacts(req);
    const baseline = await req.governance.service.generateRepositoryBaseline({
      scope: req.governance.scope,
      authorization: req.governance.authorization,
      input: req.body,
      repositoryFacts
    });
    res.json({ baseline });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/digital-twin', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const digitalTwin = await req.governance.service.getPolicyDigitalTwin({
      scope: req.governance.scope,
      authorization: req.governance.authorization,
      historyLimit: req.query.historyLimit,
      afterDecisionSeq: req.query.afterDecisionSeq
    });
    const access = projectGovernanceInterfaceAccess(req.governance.authorization);
    res.json({ digitalTwin, access });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/notifications/preferences', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const preferences = await req.governance.service.getNotificationPreferences({ scope: req.governance.scope, authorization: req.governance.authorization });
    res.json({ preferences });
  } catch (error) { governanceFailure(res, error); }
});

app.put('/api/repo/:owner/:repo/governance/notifications/preferences', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.notification.preferences.update'), async (req, res) => {
  try {
    const preferences = await req.governance.service.updateNotificationPreferences({
      scope: req.governance.scope, authorization: req.governance.authorization, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.json({ preferences });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/notifications', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const notifications = await req.governance.service.listNotifications({
      scope: req.governance.scope, authorization: req.governance.authorization,
      limit: req.query.limit, afterSeq: req.query.afterSeq
    });
    res.json(notifications);
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/notifications/read', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.notification.read'), async (req, res) => {
  try {
    const preferences = await req.governance.service.markNotificationsRead({
      scope: req.governance.scope, authorization: req.governance.authorization, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.json({ preferences });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/webhooks', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('administrator'), async (req, res) => {
  try {
    const webhooks = await req.governance.service.listWebhooks({ scope: req.governance.scope, authorization: req.governance.authorization });
    res.json({ webhooks });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/webhooks', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.create'), async (req, res) => {
  try {
    const result = await req.governance.service.createWebhook({
      scope: req.governance.scope, authorization: req.governance.authorization, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json(result);
  } catch (error) { governanceFailure(res, error); }
});

app.patch('/api/repo/:owner/:repo/governance/webhooks/:webhookId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.update'), async (req, res) => {
  try {
    const webhook = await req.governance.service.updateWebhook({
      scope: req.governance.scope, authorization: req.governance.authorization,
      webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
    });
    res.json({ webhook });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.rotate'), async (req, res) => {
  try {
    const result = await req.governance.service.rotateWebhookSecret({
      scope: req.governance.scope, authorization: req.governance.authorization,
      webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
    });
    res.json(result);
  } catch (error) { governanceFailure(res, error); }
});

app.delete('/api/repo/:owner/:repo/governance/webhooks/:webhookId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.webhook.delete'), async (req, res) => {
  try {
    const webhook = await req.governance.service.deleteWebhook({
      scope: req.governance.scope, authorization: req.governance.authorization,
      webhookId: req.params.webhookId, input: req.body, idempotencyKey: req.get('Idempotency-Key')
    });
    res.json({ webhook });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/webhooks/:webhookId/deliveries', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('administrator'), async (req, res) => {
  try {
    const deliveries = await req.governance.service.listWebhookDeliveries({
      scope: req.governance.scope, authorization: req.governance.authorization,
      webhookId: req.params.webhookId, limit: req.query.limit
    });
    res.json({ deliveries });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/exports', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const exports = await req.governance.service.listEvidenceExports({
      scope: req.governance.scope, authorization: req.governance.authorization, limit: req.query.limit
    });
    res.json({ exports });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/exports', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), governanceMutationContext('governance.audit.export.create'), async (req, res) => {
  try {
    const evidenceExport = await req.governance.service.createEvidenceExport({
      scope: req.governance.scope, authorization: req.governance.authorization, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ export: evidenceExport });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/exports/:exportId/verify', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const verification = await req.governance.service.verifyEvidenceExport({
      scope: req.governance.scope, authorization: req.governance.authorization, exportId: req.params.exportId
    });
    res.json({ verification });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/exports/:exportId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const evidenceExport = await req.governance.service.getEvidenceExport({
      scope: req.governance.scope, authorization: req.governance.authorization, exportId: req.params.exportId
    });
    res.setHeader('Content-Disposition', `attachment; filename="nebulaverse-governance-${req.params.exportId}.json"`);
    res.type('application/vnd.nebulaverse.governance-evidence-envelope+json').send(JSON.stringify(evidenceExport));
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const policies = await req.governance.service.listPolicies({
      scope: req.governance.scope, authorization: req.governance.authorization, limit: req.query.limit
    });
    res.json({ policies });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/decisions/verify', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const verification = await req.governance.service.verifyPolicyDecisionChain({
      scope: req.governance.scope, authorization: req.governance.authorization, limit: req.query.limit
    });
    res.json({ verification });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/decisions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const result = await req.governance.service.listPolicyDecisions({
      scope: req.governance.scope, authorization: req.governance.authorization, limit: req.query.limit, afterSeq: req.query.afterSeq
    });
    res.json(result);
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.policy.create'), async (req, res) => {
  try {
    const policy = await req.governance.service.createPolicy({
      scope: req.governance.scope, authorization: req.governance.authorization, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ policy });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const policy = await req.governance.service.getPolicy({
      scope: req.governance.scope, authorization: req.governance.authorization, policyId: req.params.policyId
    });
    res.json({ policy });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/validate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), async (req, res) => {
  try {
    const validation = await req.governance.service.validatePolicyVersion({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, input: req.body
    });
    res.json({ validation });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.create'), async (req, res) => {
  try {
    const draft = await req.governance.service.createDraft({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ draft });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('author'), async (req, res) => {
  try {
    const draft = await req.governance.service.getDraft({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, draftId: req.params.draftId
    });
    res.json({ draft });
  } catch (error) { governanceFailure(res, error); }
});

app.patch('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.update'), async (req, res) => {
  try {
    const draft = await req.governance.service.updateDraft({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, draftId: req.params.draftId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.json({ draft });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/validate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), async (req, res) => {
  try {
    const validation = await req.governance.service.validateDraft({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, draftId: req.params.draftId
    });
    res.json({ validation });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/submit', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.draft.submit'), async (req, res) => {
  try {
    const version = await req.governance.service.submitDraft({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, draftId: req.params.draftId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ version });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const versions = await req.governance.service.listVersions({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, limit: req.query.limit
    });
    res.json({ versions });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const version = await req.governance.service.getVersion({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId
    });
    res.json({ version });
  } catch (error) { governanceFailure(res, error); }
});


app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/simulate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const simulation = await req.governance.service.simulateVersion({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body
    });
    res.json({ simulation });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/review', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const review = await req.governance.service.getReviewState({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId
    });
    res.json({ review });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reviewer'), governanceMutationContext('governance.reviewer.assign'), async (req, res) => {
  try {
    const result = await req.governance.service.claimReviewer({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json(result);
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('reviewer'), governanceMutationContext('governance.approval.decide'), async (req, res) => {
  try {
    const result = await req.governance.service.recordReviewDecision({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json(result);
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const exceptions = await req.governance.service.listExceptions({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, limit: req.query.limit
    });
    res.json({ exceptions });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('author'), governanceMutationContext('governance.exception.request'), async (req, res) => {
  try {
    const exception = await req.governance.service.createException({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ exception });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/exceptions/:exceptionId', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const exception = await req.governance.service.getException({
      scope: req.governance.scope, authorization: req.governance.authorization,
      exceptionId: req.params.exceptionId
    });
    res.json({ exception });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/exceptions/:exceptionId/decision', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.exception.decide'), async (req, res) => {
  try {
    const exception = await req.governance.service.decideException({
      scope: req.governance.scope, authorization: req.governance.authorization,
      exceptionId: req.params.exceptionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ exception });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('administrator'), governanceMutationContext('governance.exception.revoke'), async (req, res) => {
  try {
    const exception = await req.governance.service.revokeException({
      scope: req.governance.scope, authorization: req.governance.authorization,
      exceptionId: req.params.exceptionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ exception });
  } catch (error) { governanceFailure(res, error); }
});

app.get('/api/repo/:owner/:repo/governance/policies/:policyId/activations', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance', { allowExperimental: true }), auth, governanceAccess('reader'), async (req, res) => {
  try {
    const activations = await req.governance.service.listActivationHistory({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, limit: req.query.limit
    });
    res.json({ activations });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/activate', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('activator'), governanceMutationContext('governance.policy.activate'), async (req, res) => {
  try {
    const activation = await req.governance.service.activateVersion({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ activation });
  } catch (error) { governanceFailure(res, error); }
});

app.post('/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/rollback', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, governanceAccess('activator'), governanceMutationContext('governance.policy.rollback'), async (req, res) => {
  try {
    const activation = await req.governance.service.rollbackVersion({
      scope: req.governance.scope, authorization: req.governance.authorization,
      policyId: req.params.policyId, versionId: req.params.versionId, input: req.body,
      idempotencyKey: req.get('Idempotency-Key')
    });
    res.status(201).json({ activation });
  } catch (error) { governanceFailure(res, error); }
});

/* ================= REPOS ================= */
/*
 * The inventory a session may see, in one place.
 *
 * Two screens read this list now -- the repositories page and the overview's
 * activity feed -- and the filter it applies is a security boundary, not a
 * convenience: alphaRepositoryListAllowed is what keeps a cohort session from
 * being told about repositories its invitation does not reach. A second copy
 * of this logic is a second place for that filter to be forgotten, so both
 * callers come through here.
 */
async function listRepositoriesFor(req, query = {}) {
  if (req.gh.provider === 'gitlab') {
    const list = await glFetch(req.gh, '/projects?membership=true&order_by=last_activity_at&per_page=100');
    return list.filter(p => alphaRepositoryListAllowed(
      req,
      p && p.namespace && p.namespace.full_path,
      p && p.path
    )).map(p => ({
      full_name: p.path_with_namespace, name: p.path,
      private: p.visibility !== 'public', default_branch: p.default_branch,
      pushed_at: p.last_activity_at, description: p.description,
      stargazers_count: p.star_count, language: null,
      owner: { login: (p.namespace && p.namespace.full_path) || '' }
    }));
  }
  const page = parseInt(query.page || '1', 10);
  const sort = ['pushed', 'created', 'updated', 'full_name'].includes(query.sort) ? query.sort : 'pushed';
  const result = req.gh.authMethod === 'github-app'
    ? await gh(req.gh, `/installation/repositories?per_page=30&page=${page}`)
    : await gh(req.gh, `/user/repos?sort=${sort}&per_page=30&page=${page}&affiliation=owner,collaborator,organization_member`);
  const repos = req.gh.authMethod === 'github-app' ? (Array.isArray(result && result.repositories) ? result.repositories : []) : result;
  return repos.filter(r => alphaRepositoryListAllowed(
    req,
    r && r.owner && r.owner.login,
    r && r.name
  )).map(r => ({
    full_name: r.full_name, name: r.name, owner: r.owner.login,
    private: r.private, description: r.description, language: r.language,
    default_branch: r.default_branch, pushed_at: r.pushed_at,
    stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count
  }));
}

app.get('/api/repos', providerSessionAccess, alphaRepositoryListAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    res.json(await listRepositoriesFor(req, req.query));
  } catch (e) { fail(res, e); }
});
app.post('/api/repos', providerSessionAccess, capabilityAccess('repository.create', { allowExperimental: true }), repositoryCreationAccess, auth, mutationContext('repository.create'), async (req, res) => {
  try {
    const result = await createVerifiedRepository((route, options) => gh(req.gh, route, options), req.gh, req.body);
    res.status(201).json(result);
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const id = glId(req);
      const [p3, brs] = await Promise.all([
        glFetch(req.gh, `/projects/${id}`),
        glFetch(req.gh, `/projects/${id}/repository/branches?per_page=100`)
      ]);
      return res.json({
        full_name: p3.path_with_namespace, default_branch: p3.default_branch,
        private: p3.visibility !== 'public', description: p3.description,
        branches: normalizeProviderBranches('gitlab', brs)
      });
    }
    const [info, branches] = await Promise.all([
      gh(req.gh, R(req)),
      gh(req.gh, `${R(req)}/branches?per_page=100`)
    ]);
    res.json({
      full_name: info.full_name, default_branch: info.default_branch,
      private: info.private, description: info.description,
      branches: normalizeProviderBranches(req.gh.provider || 'github', branches)
    });
  } catch (e) { fail(res, e); }
});
/* delete repository (requires PAT with delete_repo scope or OAuth) */
app.delete('/api/repo/:owner/:repo', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.delete', { allowExperimental: true }), repositoryDeletionConfirmation, auth, mutationContext('repository.delete'), async (req, res) => {
  try {
    await verifyRepositoryDeletion((route, options) => gh(req.gh, route, options), `${req.params.owner}/${req.params.repo}`, req.gh);
    await gh(req.gh, R(req), { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    if (e.status === 403 && e.code === 'PROVIDER_FORBIDDEN') {
      e.nextAction = 'For OAuth, use Accounts → Allow repository deletion on GitHub. Otherwise check repository administrator access and deletion permission on the connected credential.';
      e.providerChanged = false;
    }
    fail(res, e);
  }
});
/* download repo as zip */
app.get('/api/repo/:owner/:repo/zip', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    const ref = req.query.ref || '';
    const r = (req.gh.provider || 'github') === 'github'
      ? await githubArchiveResponse(req.gh, req.params.owner, req.params.repo, ref)
      : await gh(req.gh, `${R(req)}/zipball/${encodeURIComponent(ref)}`, { raw: true });
    if (!r.ok) return res.status(r.status).json({ error: 'Could not download archive' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="${req.params.repo}-${(ref || 'default').replace(/[^\w.-]/g, '_')}.zip"`);
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { fail(res, e); }
});

/* ================= BRANCHES ================= */
app.post('/api/repo/:owner/:repo/branches', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('branches.write'), auth, mutationContext('branch.create'), async (req, res) => {
  try {
    let { name, from } = req.body || {};
    if (!name || !from) return res.status(400).json({ error: 'name and from required' });
    name = requireBranchName(name, 'new branch');
    from = requireBranchName(from, 'source branch');
    const ref = await gh(req.gh, `${R(req)}/git/ref/heads/${encodeURIComponent(from)}`);
    await gh(req.gh, `${R(req)}/git/refs`, {
      method: 'POST', body: { ref: `refs/heads/${name}`, sha: ref.object.sha }
    });
    res.json({ ok: true, name, sha: ref.object.sha });
  } catch (e) { fail(res, e); }
});
app.delete('/api/repo/:owner/:repo/branches/:name', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('branches.write'), auth, mutationContext('branch.delete'), async (req, res) => {
  try {
    const name = requireBranchName(req.params.name);
    await gh(req.gh, `${R(req)}/git/refs/heads/${encodeURIComponent(name)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
/* compare two refs */
app.get('/api/repo/:owner/:repo/compare', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const { base, head } = req.query;
    const c = await gh(req.gh,
      `${R(req)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    res.json({
      status: c.status, ahead_by: c.ahead_by, behind_by: c.behind_by, total_commits: c.total_commits,
      commits: (c.commits || []).slice(-20).map(x => ({ sha: x.sha, message: x.commit.message.split('\n')[0], author: x.commit.author && x.commit.author.name })),
      files: (c.files || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }))
    });
  } catch (e) { fail(res, e); }
});

/* ================= TREE / FILES ================= */
app.get('/api/repo/:owner/:repo/tree', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('tree.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const qp = new URLSearchParams({ ref: req.query.ref, path: req.query.path || '', per_page: '100' });
      const list = await glFetch(req.gh, `/projects/${glId(req)}/repository/tree?${qp}`);
      return res.json(list.map(t => ({
        name: t.name, path: t.path, type: t.type === 'tree' ? 'dir' : 'file', sha: t.id, size: 0
      })));
    }
    const p = req.query.path ? requireRepoPath(req.query.path) : '';
    const items = await gh(req.gh,
      `${R(req)}/contents/${encodePath(p)}?ref=${encodeURIComponent(req.query.ref)}`);
    const list = Array.isArray(items) ? items : [items];
    list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json(list.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size, sha: i.sha })));
  } catch (e) { fail(res, e); }
});
/* flat recursive file list (for command-palette fuzzy finder) */
app.get('/api/repo/:owner/:repo/files', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('tree.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const ref = req.query.ref;
    const br = await gh(req.gh, `${R(req)}/branches/${encodeURIComponent(ref)}`);
    const tree = await gh(req.gh,
      `${R(req)}/git/trees/${br.commit.sha}?recursive=1`);
    res.json({
      truncated: !!tree.truncated,
      files: (tree.tree || []).filter(t => t.type === 'blob').map(t => t.path).slice(0, 8000)
    });
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.read'), auth, async (req, res) => {
  try {
    const requestedPath = requireRepoPath(req.query.path);
    if (req.gh.provider === 'gitlab') {
      const f = await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${encodeURIComponent(requestedPath)}?ref=${encodeURIComponent(req.query.ref)}`);
      if (f.size > MB) return res.json({ tooLarge: true, name: f.file_name, path: requestedPath, sha: f.blob_id, size: f.size });
      return res.json({ name: f.file_name, path: requestedPath, sha: f.blob_id, size: f.size, content: Buffer.from(f.content || '', 'base64').toString('utf8') });
    }
    const meta = await gh(req.gh,
      `${R(req)}/contents/${encodePath(requestedPath)}?ref=${encodeURIComponent(req.query.ref)}`);
    if (meta.content) {
      const txt = Buffer.from(meta.content, 'base64').toString('utf8');
      const lm = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\s*$/.exec(txt);
      if (lm) return res.json({ lfs: true, name: meta.name, path: meta.path, sha: meta.sha, size: parseInt(lm[2], 10), oid: lm[1] });
    }
    if (meta.size > MB) return res.json({ tooLarge: true, name: meta.name, path: meta.path, sha: meta.sha, size: meta.size });
    res.json({ name: meta.name, path: meta.path, sha: meta.sha, size: meta.size, content: meta.content, encoding: meta.encoding });
  } catch (e) { fail(res, e); }
});
const ACTIVE_CONTENT_RX = /\.(html?|xhtml|svg|svgz|xml|xslt?)$/i;
function setRawHeaders(res, p) {
  const fname = path.basename(p).replace(/"/g, '');
  if (ACTIVE_CONTENT_RX.test(p)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  } else {
    res.setHeader('Content-Type', guessMime(p));
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
  }
}
app.get('/api/repo/:owner/:repo/raw', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.read'), auth, async (req, res) => {
  try {
    const requestedPath = requireRepoPath(req.query.path);
    if (req.gh.provider === 'gitlab') {
      const p2 = requestedPath;
      const r2 = await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${encodeURIComponent(p2)}/raw?ref=${encodeURIComponent(req.query.ref)}`, { raw: true });
      if (!r2.ok) return res.status(r2.status).json({ error: 'Could not fetch raw content' });
      setRawHeaders(res, p2);
      Readable.fromWeb(r2.body).pipe(res);
      return;
    }
    const p = requestedPath;
    const r = await gh(req.gh,
      `${R(req)}/contents/${encodePath(p)}?ref=${encodeURIComponent(req.query.ref)}`,
      { accept: 'application/vnd.github.raw+json', raw: true });
    if (!r.ok) return res.status(r.status).json({ error: 'Could not fetch raw content' });
    /* peek the head: LFS pointers are ~130 bytes of text */
    const reader = r.body.getReader();
    const headChunks = [];
    let total = 0, ended = false;
    while (total < 400) {
      const { value, done } = await reader.read();
      if (done) { ended = true; break; }
      headChunks.push(Buffer.from(value));
      total += value.length;
    }
    const headBuf = Buffer.concat(headChunks);
    const lm = ended && /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\s*$/.exec(headBuf.toString('utf8'));
    if (lm) {
      assertProviderBoundLfs(req.gh);
      setRawHeaders(res, p);
      /* it's a pointer — fetch the real bytes from LFS storage */
      const stream = await lfsDownloadStream(req.gh, req.params.owner, req.params.repo, lm[1], parseInt(lm[2], 10));
      res.setHeader('Content-Length', lm[2]);
      Readable.fromWeb(stream).pipe(res);
      return;
    }
    setRawHeaders(res, p);
    res.write(headBuf);
    if (ended) return res.end();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(rs => res.once('drain', rs));
    }
    res.end();
  } catch (e) { fail(res, e); }
});
function requireHttpsLfsActionUrl(raw, action) {
  let target;
  try { target = new URL(String(raw || '')); }
  catch { throw Object.assign(new Error(`LFS ${action} URL is invalid`), { status: 502 }); }
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw Object.assign(new Error(`LFS ${action} URL must use HTTPS without embedded credentials`), { status: 502 });
  }
  return target;
}
async function lfsDownloadStream(sess, owner, repo, oid, size) {
  assertProviderBoundLfs(sess);
  const basic = Buffer.from(`${sess.login}:${sess.token}`).toString('base64');
  const batchRes = await fetchT(`https://github.com/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json',
      Authorization: `Basic ${basic}`, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
    },
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size }] }),
    redirect: 'error'
  });
  if (!batchRes.ok) throw Object.assign(new Error('LFS download negotiation failed'), { status: 502 });
  const batch = await batchRes.json();
  const obj = batch.objects && batch.objects[0];
  const act = obj && obj.actions && obj.actions.download;
  if (!act) throw Object.assign(new Error('LFS object not found in storage'), { status: 404 });
  const downloadUrl = requireHttpsLfsActionUrl(act.href, 'download');
  const dl = await fetchT(downloadUrl, { headers: act.header || {}, redirect: 'error' }, UPLOAD_TIMEOUT_MS);
  if (!dl.ok) throw Object.assign(new Error(`LFS storage fetch failed (${dl.status})`), { status: 502 });
  return dl.body;
}
app.put('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.write'), auth, mutationContext('file.write'), async (req, res) => {
  try {
    if (req.body) {
      req.body.path = requireRepoPath(req.body.path);
      req.body.branch = requireBranchName(req.body.branch);
    }
    if (req.gh.provider === 'gitlab') {
      const { path: p, content, message, branch, expectedHeadSha } = req.body || {};
      const enc = encodeURIComponent(p);
      if (expectedHeadSha) assertExpectedHead(expectedHeadSha, await glLastCommit(req.gh, glId(req), branch));
      let exists = true;
      try { await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${enc}?ref=${encodeURIComponent(branch)}`); }
      catch (e) { if (e.status === 404) exists = false; else throw e; }
      await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${enc}`, {
        method: exists ? 'PUT' : 'POST',
        body: {
          branch, content: String(content ?? ''), commit_message: message || `Update ${p} via ${PRODUCT_NAME}`,
          ...(exists && expectedHeadSha ? { last_commit_id: expectedHeadSha } : {})
        }
      });
      const f2 = await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${enc}?ref=${encodeURIComponent(branch)}`);
      const last = await glLastCommit(req.gh, glId(req), branch);
      return res.json({ ok: true, commit: last || 'committed', content: { sha: f2.blob_id } });
    }
    const { path: p, content, message, branch, expectedHeadSha } = req.body || {};
    if (!p || content == null || !branch) return res.status(400).json({ error: 'path, content, branch required' });
    if (req.gh.provider === 'gitea') {
      const adapter = createGiteaFileMutationAdapter({
        request: (apiPath, options) => gh(req.gh, apiPath, options)
      });
      const result = await adapter.write({
        owner: req.params.owner,
        repo: req.params.repo,
        path: p,
        content,
        message: message || `Update ${p} via ${PRODUCT_NAME}`,
        branch,
        expectedHeadSha
      });
      return res.json({ ok: true, sha: result.sha, commit: result.commit });
    }
    const blob = await gh(req.gh, `${R(req)}/git/blobs`, {
      method: 'POST', body: { content: Buffer.from(String(content), 'utf8').toString('base64'), encoding: 'base64' }
    });
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch,
      message || `Update ${p} via ${PRODUCT_NAME}`, [{ path: p, sha: blob.sha }], expectedHeadSha);
    res.json({ ok: true, sha: blob.sha, commit });
  } catch (e) { fail(res, e); }
});
app.delete('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.delete'), auth, mutationContext('file.delete'), async (req, res) => {
  try {
    if (req.body) {
      req.body.path = requireRepoPath(req.body.path);
      req.body.branch = requireBranchName(req.body.branch);
    }
    if (req.gh.provider === 'gitlab') {
      const { path: p, branch, expectedHeadSha } = req.body || {};
      if (expectedHeadSha) assertExpectedHead(expectedHeadSha, await glLastCommit(req.gh, glId(req), branch));
      await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${encodeURIComponent(p)}`, {
        method: 'DELETE', body: {
          branch, commit_message: `Delete ${p} via ${PRODUCT_NAME}`,
          ...(expectedHeadSha ? { last_commit_id: expectedHeadSha } : {})
        }
      });
      return res.json({ ok: true, commit: await glLastCommit(req.gh, glId(req), branch) || 'committed' });
    }
    const { path: p, message, branch, sha, expectedHeadSha } = req.body || {};
    if (req.gh.provider === 'gitea') {
      if (!p || !branch) return res.status(400).json({ error: 'path, branch required' });
      const adapter = createGiteaFileMutationAdapter({
        request: (apiPath, options) => gh(req.gh, apiPath, options)
      });
      const result = await adapter.delete({
        owner: req.params.owner,
        repo: req.params.repo,
        path: p,
        message: message || `Delete ${p} via ${PRODUCT_NAME}`,
        branch,
        expectedHeadSha
      });
      return res.json({ ok: true, commit: result.commit });
    }
    if (!p || !branch || !sha) return res.status(400).json({ error: 'path, branch, sha required' });
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch,
      message || `Delete ${p} via ${PRODUCT_NAME}`, [{ path: p, sha: null }], expectedHeadSha);
    res.json({ ok: true, commit });
  } catch (e) { fail(res, e); }
});
/* rename/move (any size — reuses blob sha, no re-upload) */
app.post('/api/repo/:owner/:repo/rename', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.rename', { allowExperimental: true }), auth, mutationContext('file.rename'), async (req, res) => {
  try {
    let { from, to, branch, message, expectedHeadSha } = req.body || {};
    if (!from || !to || !branch) return res.status(400).json({ error: 'from, to, branch required' });
    from = requireRepoPath(from, 'source path');
    to = requireRepoPath(to, 'destination path');
    branch = requireBranchName(branch);
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const listing = await gh(req.gh, `${R(req)}/contents/${encodePath(dir)}?ref=${encodeURIComponent(branch)}`);
    const entry = (Array.isArray(listing) ? listing : [listing]).find(i => i.path === from);
    if (!entry) return res.status(404).json({ error: 'Source file not found' });
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch,
      message || `Rename ${from} → ${to} via ${PRODUCT_NAME}`, [
        { path: to, sha: entry.sha, preserveFrom: from },
        { path: from, sha: null, preserveFrom: from }
      ], expectedHeadSha);
    res.json({ ok: true, commit });
  } catch (e) { fail(res, e); }
});
/* batch: commit many staged operations atomically */
app.post('/api/repo/:owner/:repo/batch', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.batch', { allowExperimental: true }), auth, mutationContext('file.batch'), async (req, res) => {
  try {
    let { branch, message, ops, expectedHeadSha } = req.body || {};
    if (!branch || !Array.isArray(ops) || !ops.length) return res.status(400).json({ error: 'branch and ops required' });
    branch = requireBranchName(branch);
    expectedHeadSha = requireAggregateExpectedHead(expectedHeadSha);
    const normalizedBatch = normalizeFileBatch(ops);
    ops = normalizedBatch.items;
    const entries = [];
    for (const op of ops) {
      const itemPath = requireRepoPath(op.path);
      if (op.op === 'put' && op.sha) entries.push({ path: itemPath, mode: '100644', type: 'blob', sha: op.sha });
      else if (op.op === 'put') entries.push({ path: itemPath, mode: '100644', type: 'blob', content: String(op.content ?? '') });
      else entries.push({ path: itemPath, mode: '100644', type: 'blob', sha: null });
    }
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch,
      message || `Batch commit (${ops.length} changes) via ${PRODUCT_NAME}`, entries, expectedHeadSha);
    const execution = mutationGateway.executionSnapshot();
    res.json({
      ok: true, commit, count: ops.length, batchHash: normalizedBatch.batchHash, itemIds: normalizedBatch.itemIds,
      providerOperationIds: execution ? execution.operationIds : []
    });
  } catch (e) { fail(res, e); }
});

/* ================= COMMITS ================= */
app.get('/api/repo/:owner/:repo/commits', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const qp = new URLSearchParams({ ref_name: req.query.ref || '', per_page: '30' });
      if (req.query.path) qp.set('path', req.query.path);
      const list = await glFetch(req.gh, `/projects/${glId(req)}/repository/commits?${qp}`);
      return res.json(list.map(c => ({
        sha: c.id, message: c.message,
        author: { name: c.author_name, date: c.authored_date, avatar: null },
        html_url: c.web_url
      })));
    }
    const page = parseInt(req.query.page || '1', 10);
    const pathFilter = req.query.path ? `&path=${encodeURIComponent(req.query.path)}` : '';
    const commits = await gh(req.gh,
      `${R(req)}/commits?sha=${encodeURIComponent(req.query.ref)}&per_page=25&page=${page}${pathFilter}`);
    res.json(commits.map(c => ({
      sha: c.sha, message: c.commit.message,
      author: (c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '?',
      avatar: c.author && c.author.avatar_url,
      date: c.commit.author && c.commit.author.date
    })));
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/commit/:sha', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const id = glId(req);
      const c = await glFetch(req.gh, `/projects/${id}/repository/commits/${req.params.sha}`);
      const diffs = await glFetch(req.gh, `/projects/${id}/repository/commits/${req.params.sha}/diff`);
      return res.json({
        sha: c.id, message: c.message, author: { name: c.author_name, date: c.authored_date },
        stats: c.stats || {}, files: (diffs || []).map(d => ({
          filename: d.new_path,
          status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
          additions: 0, deletions: 0, patch: d.diff
        }))
      });
    }
    const c = await gh(req.gh, `${R(req)}/commits/${encodeURIComponent(req.params.sha)}`);
    res.json({
      sha: c.sha, message: c.commit.message, stats: c.stats,
      files: (c.files || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }))
    });
  } catch (e) { fail(res, e); }
});

/* ================= TIME MACHINE (rollback) ================= */
/* Revert one commit: apply its inverse on top of the current branch head */
app.post('/api/repo/:owner/:repo/revert', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.revert'), async (req, res) => {
  try {
    let { sha, branch, expectedHeadSha } = req.body || {};
    if (!sha || !branch) return res.status(400).json({ error: 'sha and branch required' });
    sha = requireCommitSha(sha);
    branch = requireBranchName(branch);
    const c = await gh(req.gh, `${R(req)}/commits/${sha}`);
    if ((c.parents || []).length !== 1)
      return res.status(400).json({ error: 'Only non-merge commits can be reverted (this one has ' + (c.parents || []).length + ' parents)' });
    const parentSha = c.parents[0].sha;
    const parent = await gh(req.gh, `${R(req)}/commits/${parentSha}`);
    const ptree = await gh(req.gh, `${R(req)}/git/trees/${parent.commit.tree.sha}?recursive=1`);
    if (ptree.truncated) return res.status(400).json({ error: 'Repository too large for automatic revert' });
    const parentMap = new Map((ptree.tree || []).filter(t => t.type === 'blob' || t.type === 'commit')
      .map(t => [t.path, { sha: t.sha, mode: t.mode, type: t.type }]));
    const entries = [];
    for (const f of (c.files || [])) {
      const prev = parentMap.get(f.filename);
      if (f.status === 'added' || f.status === 'copied') {
        entries.push({ path: f.filename, mode: '100644', type: 'blob', sha: null });
      } else if (f.status === 'renamed') {
        entries.push({ path: f.filename, mode: '100644', type: 'blob', sha: null });
        const old = parentMap.get(f.previous_filename);
        if (old) entries.push({ path: f.previous_filename, mode: old.mode, type: old.type, sha: old.sha, forceMode: true });
      } else if (prev) { /* removed | modified | changed */
        entries.push({ path: f.filename, mode: prev.mode, type: prev.type, sha: prev.sha, forceMode: true });
      }
    }
    if (!entries.length) return res.status(400).json({ error: 'Nothing to revert in that commit' });
    const protectedError = protectedPathError(req, entries.map(entry => entry.path));
    if (protectedError) return res.status(423).json({ error: protectedError, locked: true });
    const msg = `Revert "${(c.commit.message || '').split('\n')[0]}" (${sha.slice(0, 7)}) via ${PRODUCT_NAME}`;
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch, msg, entries, expectedHeadSha);
    res.json({ ok: true, commit, changed: entries.length });
  } catch (e) { fail(res, e); }
});
/* Restore the whole repo to how it was at a commit — as a NEW commit (history preserved) */
app.post('/api/repo/:owner/:repo/restore', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.restore'), async (req, res) => {
  try {
    let { sha, branch, expectedHeadSha } = req.body || {};
    if (!sha || !branch) return res.status(400).json({ error: 'sha and branch required' });
    sha = requireCommitSha(sha);
    branch = requireBranchName(branch);
    const target = await gh(req.gh, `${R(req)}/commits/${sha}`);
    const ref = await gh(req.gh, `${R(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
    assertExpectedHead(expectedHeadSha, ref.object.sha);
    const commit = await gh(req.gh, `${R(req)}/git/commits`, {
      method: 'POST',
      body: {
        message: `Restore repository to ${sha.slice(0, 7)} ("${(target.commit.message || '').split('\n')[0]}") via ${PRODUCT_NAME}`,
        tree: target.commit.tree.sha,
        parents: [ref.object.sha]
      }
    });
    try {
      await gh(req.gh, `${R(req)}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false }
      });
    } catch (error) {
      if (error.status === 409 || error.status === 422) throw branchChangedError();
      throw error;
    }
    res.json({ ok: true, commit: commit.sha });
  } catch (e) { fail(res, e); }
});
/* Restore specific files/folders from an old commit onto the current branch */
app.post('/api/repo/:owner/:repo/restore-paths', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('commit.restore-paths'), async (req, res) => {
  try {
    let { sha, branch, prefix, expectedHeadSha } = req.body || {};
    if (!sha || !branch || !prefix) return res.status(400).json({ error: 'sha, branch and prefix required' });
    sha = requireCommitSha(sha);
    branch = requireBranchName(branch);
    expectedHeadSha = requireAggregateExpectedHead(expectedHeadSha);
    const safePrefix = requireRepoPath(prefix, 'restore path');
    const target = await gh(req.gh, `${R(req)}/commits/${sha}`);
    const ttree = await gh(req.gh, `${R(req)}/git/trees/${target.commit.tree.sha}?recursive=1`);
    if (ttree.truncated) return res.status(400).json({ error: 'Repository too large for path restore' });
    const clean = safePrefix;
    const matches = (ttree.tree || []).filter(t =>
      (t.type === 'blob' || t.type === 'commit') && (t.path === clean || t.path.startsWith(clean + '/')));
    if (!matches.length) return res.status(404).json({ error: `Nothing at "${clean}" in commit ${sha.slice(0, 7)}` });
    if (matches.length > 500) return res.status(400).json({ error: `${matches.length} files match — restore a narrower path (max 500)` });
    enforceProtectedPaths(req, matches.map(item => item.path));
    const entries = matches.map(t => ({ path: t.path, mode: t.mode, type: t.type, sha: t.sha, forceMode: true }));
    const commit = await commitTree(req.gh, req.params.owner, req.params.repo, branch,
      `Restore ${clean} from ${sha.slice(0, 7)} via ${PRODUCT_NAME}`, entries, expectedHeadSha);
    res.json({ ok: true, commit, restored: entries.length });
  } catch (e) { fail(res, e); }
});
/* Snapshot: the full file listing of the repo as it existed at a commit */
app.get('/api/repo/:owner/:repo/snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try {
    let sha = req.query.sha;
    if (!sha) return res.status(400).json({ error: 'sha required' });
    sha = requireCommitSha(sha);
    const c = await gh(req.gh, `${R(req)}/commits/${sha}`);
    const t = await gh(req.gh, `${R(req)}/git/trees/${c.commit.tree.sha}?recursive=1`);
    const files = (t.tree || []).filter(x => x.type === 'blob' || x.type === 'commit')
      .map(x => ({ path: x.path, sha: x.sha, size: x.size || 0, mode: x.mode, type: x.type }));
    res.json({
      sha, truncated: !!t.truncated, count: files.length,
      files: files.slice(0, 4000)
    });
  } catch (e) { fail(res, e); }
});

/* Hard reset: move the branch pointer back, ERASING later commits from it */
app.post('/api/repo/:owner/:repo/reset', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('branch.reset'), async (req, res) => {
  try {
    let { sha, branch, expectedHeadSha } = req.body || {};
    if (!sha || !branch) return res.status(400).json({ error: 'sha and branch required' });
    sha = requireCommitSha(sha);
    branch = requireBranchName(branch);
    if (expectedHeadSha) {
      const ref = await gh(req.gh, `${R(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
      assertExpectedHead(expectedHeadSha, ref.object.sha);
    }
    await gh(req.gh, `${R(req)}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', body: { sha, force: true }
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

/* ================= SEARCH ================= */
app.get('/api/repo/:owner/:repo/search', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('search', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const out = await gh(req.gh,
      `/search/code?q=${encodeURIComponent(`${q} repo:${req.params.owner}/${req.params.repo}`)}&per_page=30`);
    res.json((out.items || []).map(i => ({ name: i.name, path: i.path })));
  } catch (e) { fail(res, e); }
});


async function enforceProtectedPullMerge(req, number) {
  if (!protectedPatternsForReq(req).length) return;
  const changedPaths = [];
  if (req.gh.provider === 'gitlab') {
    const data = await glFetch(req.gh, `/projects/${glId(req)}/merge_requests/${encodeURIComponent(number)}/changes`);
    if (data && data.overflow) {
      throw Object.assign(new Error('This merge request has too many changed files to verify protected paths safely.'), { status: 423, code: 'PROTECTED_PATH_SCAN_INCOMPLETE' });
    }
    for (const item of Array.isArray(data && data.changes) ? data.changes : []) {
      if (item && item.old_path) changedPaths.push(item.old_path);
      if (item && item.new_path) changedPaths.push(item.new_path);
    }
  } else {
    const pr = await gh(req.gh, `${R(req)}/pulls/${encodeURIComponent(number)}`);
    if (Number(pr.changed_files || 0) > 1000) {
      throw Object.assign(new Error('This pull request has more than 1,000 changed files, so protected-path verification cannot be completed safely.'), { status: 423, code: 'PROTECTED_PATH_SCAN_INCOMPLETE' });
    }
    for (let page = 1; page <= 10; page++) {
      const batch = await gh(req.gh, `${R(req)}/pulls/${encodeURIComponent(number)}/files?per_page=100&page=${page}`);
      for (const item of Array.isArray(batch) ? batch : []) {
        if (item && item.previous_filename) changedPaths.push(item.previous_filename);
        if (item && item.filename) changedPaths.push(item.filename);
      }
      if (!Array.isArray(batch) || batch.length < 100) break;
    }
  }
  enforceProtectedPaths(req, [...new Set(changedPaths)]);
}

/* ================= PULL REQUESTS ================= */
const glState = q => q === 'open' ? 'opened' : q;
const glDiffCounts = d => { let a = 0, r = 0; for (const l of String(d || '').split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) a++; else if (l.startsWith('-') && !l.startsWith('---')) r++; } return [a, r]; };
app.get('/api/repo/:owner/:repo/pulls', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
    if (req.gh.provider === 'gitlab') {
      const qs = state === 'all' ? '' : `state=${glState(state)}&`;
      const mrs = await glFetch(req.gh, `/projects/${glId(req)}/merge_requests?${qs}per_page=30&order_by=updated_at`);
      return res.json(mrs.map(m => ({
        number: m.iid, title: m.title, state: m.state === 'merged' ? 'closed' : (m.state === 'opened' ? 'open' : m.state),
        draft: !!m.draft, merged: m.state === 'merged',
        user: m.author && m.author.username, avatar: m.author && m.author.avatar_url,
        head: m.source_branch, base: m.target_branch, updated_at: m.updated_at
      })));
    }
    const pulls = await gh(req.gh, `${R(req)}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`);
    res.json(pulls.map(p => ({
      number: p.number, title: p.title, state: p.state, draft: p.draft, merged: !!p.merged_at,
      user: p.user && p.user.login, avatar: p.user && p.user.avatar_url,
      head: p.head.ref, base: p.base.ref, updated_at: p.updated_at
    })));
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/pulls/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const m = await glFetch(req.gh, `/projects/${glId(req)}/merge_requests/${req.params.num}/changes`);
      const files = (m.changes || []).map(c => {
        const [a, d] = glDiffCounts(c.diff);
        return { filename: c.new_path, status: c.new_file ? 'added' : c.deleted_file ? 'removed' : c.renamed_file ? 'renamed' : 'modified', additions: a, deletions: d, patch: c.diff };
      });
      return res.json({
        number: m.iid, title: m.title, body: m.description, state: m.state === 'merged' ? 'closed' : (m.state === 'opened' ? 'open' : m.state),
        draft: !!m.draft, merged: m.state === 'merged',
        mergeable: m.merge_status === 'can_be_merged', mergeable_state: m.merge_status,
        user: m.author && m.author.username, head: m.source_branch, base: m.target_branch,
        additions: files.reduce((t, f) => t + f.additions, 0), deletions: files.reduce((t, f) => t + f.deletions, 0),
        changed_files: files.length, files
      });
    }
    const [p, files] = await Promise.all([
      gh(req.gh, `${R(req)}/pulls/${req.params.num}`),
      gh(req.gh, `${R(req)}/pulls/${req.params.num}/files?per_page=100`)
    ]);
    res.json({
      number: p.number, title: p.title, body: p.body, state: p.state, draft: p.draft,
      merged: p.merged, mergeable: p.mergeable, mergeable_state: p.mergeable_state,
      user: p.user && p.user.login, head: p.head.ref, base: p.base.ref,
      additions: p.additions, deletions: p.deletions, changed_files: p.changed_files,
      files: files.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }))
    });
  } catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/pulls', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write', { allowExperimental: true }), auth, mutationContext('pull.create'), async (req, res) => {
  try {
    const { title, head, base, body, draft } = req.body || {};
    if (!title || !head || !base) return res.status(400).json({ error: 'title, head, base required' });
    if (req.gh.provider === 'gitlab') {
      const m = await glFetch(req.gh, `/projects/${glId(req)}/merge_requests`, {
        method: 'POST', body: { title, source_branch: head, target_branch: base, description: body || '' }
      });
      return res.json({ ok: true, number: m.iid });
    }
    const p = await gh(req.gh, `${R(req)}/pulls`, {
      method: 'POST', body: { title, head, base, body: body || '', draft: !!draft }
    });
    res.json({ ok: true, number: p.number });
  } catch (e) { fail(res, e); }
});
app.put('/api/repo/:owner/:repo/pulls/:num/merge', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write', { allowExperimental: true }), auth, mutationContext('pull.merge'), async (req, res) => {
  try {
    const method = ['merge', 'squash', 'rebase'].includes(req.body && req.body.method) ? req.body.method : 'merge';
    await enforceProtectedPullMerge(req, req.params.num);
    if (req.gh.provider === 'gitlab') {
      const out2 = await glFetch(req.gh, `/projects/${glId(req)}/merge_requests/${req.params.num}/merge`, {
        method: 'PUT', body: { squash: method === 'squash' }
      });
      return res.json({ ok: true, sha: out2.merge_commit_sha || out2.sha, message: 'merged' });
    }
    const out = await gh(req.gh, `${R(req)}/pulls/${req.params.num}/merge`, {
      method: 'PUT', body: { merge_method: method }
    });
    res.json({ ok: true, sha: out.sha, message: out.message });
  } catch (e) { fail(res, e); }
});

/* ================= ISSUES ================= */
app.get('/api/repo/:owner/:repo/issues', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
    if (req.gh.provider === 'gitlab') {
      const qs = state === 'all' ? '' : `state=${glState(state)}&`;
      const its = await glFetch(req.gh, `/projects/${glId(req)}/issues?${qs}per_page=30&order_by=updated_at`);
      return res.json(its.map(i => ({
        number: i.iid, title: i.title, state: i.state === 'opened' ? 'open' : i.state,
        user: i.author && i.author.username, avatar: i.author && i.author.avatar_url,
        comments: i.user_notes_count, updated_at: i.updated_at,
        labels: (i.labels || []).map(n => ({ name: n, color: '7c6df0' }))
      })));
    }
    const issues = await gh(req.gh, `${R(req)}/issues?state=${state}&per_page=30&sort=updated`);
    res.json(issues.filter(i => !i.pull_request).map(i => ({
      number: i.number, title: i.title, state: i.state,
      user: i.user && i.user.login, avatar: i.user && i.user.avatar_url,
      comments: i.comments, updated_at: i.updated_at,
      labels: (i.labels || []).map(l => ({ name: l.name, color: l.color }))
    })));
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/issues/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') {
      const [it, notes] = await Promise.all([
        glFetch(req.gh, `/projects/${glId(req)}/issues/${req.params.num}`),
        glFetch(req.gh, `/projects/${glId(req)}/issues/${req.params.num}/notes?per_page=50&sort=asc`)
      ]);
      return res.json({
        number: it.iid, title: it.title, body: it.description, state: it.state === 'opened' ? 'open' : it.state,
        user: it.author && it.author.username, created_at: it.created_at,
        labels: (it.labels || []).map(n => ({ name: n, color: '7c6df0' })),
        comments: notes.filter(n => !n.system).map(n => ({ user: n.author && n.author.username, avatar: n.author && n.author.avatar_url, body: n.body, created_at: n.created_at }))
      });
    }
    const [i, comments] = await Promise.all([
      gh(req.gh, `${R(req)}/issues/${req.params.num}`),
      gh(req.gh, `${R(req)}/issues/${req.params.num}/comments?per_page=50`)
    ]);
    res.json({
      number: i.number, title: i.title, body: i.body, state: i.state,
      user: i.user && i.user.login, created_at: i.created_at,
      labels: (i.labels || []).map(l => ({ name: l.name, color: l.color })),
      comments: comments.map(c => ({ user: c.user && c.user.login, avatar: c.user && c.user.avatar_url, body: c.body, created_at: c.created_at }))
    });
  } catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/issues', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write', { allowExperimental: true }), auth, mutationContext('issue.create'), async (req, res) => {
  try {
    const { title, body } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    if (req.gh.provider === 'gitlab') {
      const it = await glFetch(req.gh, `/projects/${glId(req)}/issues`, { method: 'POST', body: { title, description: body || '' } });
      return res.json({ ok: true, number: it.iid });
    }
    const i = await gh(req.gh, `${R(req)}/issues`, { method: 'POST', body: { title, body: body || '' } });
    res.json({ ok: true, number: i.number });
  } catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/issues/:num/comments', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write', { allowExperimental: true }), auth, mutationContext('issue.comment'), async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    if (req.gh.provider === 'gitlab') {
      await glFetch(req.gh, `/projects/${glId(req)}/issues/${req.params.num}/notes`, { method: 'POST', body: { body } });
      return res.json({ ok: true });
    }
    await gh(req.gh, `${R(req)}/issues/${req.params.num}/comments`, { method: 'POST', body: { body } });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.patch('/api/repo/:owner/:repo/issues/:num', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('issues.write', { allowExperimental: true }), auth, mutationContext('issue.update'), async (req, res) => {
  try {
    const state = req.body && req.body.state === 'closed' ? 'closed' : 'open';
    if (req.gh.provider === 'gitlab') {
      await glFetch(req.gh, `/projects/${glId(req)}/issues/${req.params.num}`, { method: 'PUT', body: { state_event: state === 'closed' ? 'close' : 'reopen' } });
      return res.json({ ok: true, state });
    }
    await gh(req.gh, `${R(req)}/issues/${req.params.num}`, { method: 'PATCH', body: { state } });
    res.json({ ok: true, state });
  } catch (e) { fail(res, e); }
});

/* ================= NOTIFICATIONS / STAR / REVIEWS / GLOBAL SEARCH ================= */
app.get('/api/notifications', providerSessionAccess, capabilityAccess('notifications', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const repositories = ALPHA_CONFIG.enabled ? githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes) : null;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await listAccessibleNotifications(route => gh(req.gh, route), repositories));
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.read', { allowExperimental: true }), auth, async (req, res) => {
  if (req.gh.authMethod === 'github-app') return res.json({ starred: false, unsupported: true });
  try { await gh(req.gh, `/user/starred/${req.params.owner}/${req.params.repo}`); res.json({ starred: true }); }
  catch (e) { if (e.status === 404) return res.json({ starred: false }); fail(res, e); }
});
app.put('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.write', { allowExperimental: true }), auth, mutationContext('repository.star'), async (req, res) => {
  if (req.gh.authMethod === 'github-app') return res.status(403).json({
    error: 'GitHub App installations cannot manage user stars', code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE'
  });
  try { await gh(req.gh, `/user/starred/${req.params.owner}/${req.params.repo}`, { method: 'PUT' }); res.json({ ok: true, starred: true }); }
  catch (e) { fail(res, e); }
});
app.delete('/api/repo/:owner/:repo/star', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('stars.write', { allowExperimental: true }), auth, mutationContext('repository.unstar'), async (req, res) => {
  if (req.gh.authMethod === 'github-app') return res.status(403).json({
    error: 'GitHub App installations cannot manage user stars', code: 'GITHUB_APP_CAPABILITY_UNAVAILABLE'
  });
  try { await gh(req.gh, `/user/starred/${req.params.owner}/${req.params.repo}`, { method: 'DELETE' }); res.json({ ok: true, starred: false }); }
  catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/pulls/:num/reviews', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('pulls.write', { allowExperimental: true }), auth, mutationContext('pull.review'), async (req, res) => {
  try {
    const event = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(req.body && req.body.event) ? req.body.event : 'COMMENT';
    await gh(req.gh, `${R(req)}/pulls/${req.params.num}/reviews`, {
      method: 'POST', body: { event, body: (req.body && req.body.body) || '' }
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.get('/api/repo/:owner/:repo/actions/:runId/jobs', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const out = await gh(req.gh, `${R(req)}/actions/runs/${req.params.runId}/jobs?per_page=20`);
    res.json((out.jobs || []).map(jb => ({
      name: jb.name, status: jb.status, conclusion: jb.conclusion,
      steps: (jb.steps || []).map(st => ({ name: st.name, status: st.status, conclusion: st.conclusion }))
    })));
  } catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/actions/:runId/rerun', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.rerun', { allowExperimental: true }), auth, mutationContext('workflow.rerun'), async (req, res) => {
  try {
    await gh(req.gh, `${R(req)}/actions/runs/${req.params.runId}/rerun`, { method: 'POST' });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.get('/api/search', providerSessionAccess, capabilityAccess('global-search', { allowExperimental: true }), githubSearchAccess, auth, async (req, res) => {
  try {
    const repositories = ALPHA_CONFIG.enabled ? githubRepositoryScopes(req.alpha && req.alpha.repositoryScopes) : null;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await searchAccessibleCode(route => gh(req.gh, route), req.query.q, repositories));
  } catch (e) { fail(res, e); }
});

/* ================= ACTIONS (CI) ================= */
app.get('/api/repo/:owner/:repo/actions', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('workflows.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const branch = req.query.branch ? `&branch=${encodeURIComponent(req.query.branch)}` : '';
    const out = await gh(req.gh, `${R(req)}/actions/runs?per_page=25${branch}`);
    res.json((out.workflow_runs || []).map(r => ({
      id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
      branch: r.head_branch, event: r.event, sha: r.head_sha,
      created_at: r.created_at, html_url: r.html_url,
      attempt: r.run_attempt, number: r.run_number
    })));
  } catch (e) { fail(res, e); }
});

/* ================= RELEASES ================= */
app.get('/api/repo/:owner/:repo/releases', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('releases.read', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const rel = await gh(req.gh, `${R(req)}/releases?per_page=20`);
    res.json(rel.map(r => ({
      id: r.id, tag: r.tag_name, name: r.name, body: r.body, draft: r.draft,
      prerelease: r.prerelease, created_at: r.created_at,
      assets: (r.assets || []).map(a => ({ name: a.name, size: a.size, downloads: a.download_count }))
    })));
  } catch (e) { fail(res, e); }
});
app.post('/api/repo/:owner/:repo/releases', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('releases.write', { allowExperimental: true }), auth, mutationContext('release.create'), async (req, res) => {
  try {
    const { tag, name, body, target, prerelease } = req.body || {};
    if (!tag) return res.status(400).json({ error: 'tag required' });
    const r = await gh(req.gh, `${R(req)}/releases`, {
      method: 'POST',
      body: { tag_name: tag, name: name || tag, body: body || '', target_commitish: target || undefined, prerelease: !!prerelease }
    });
    res.json({ ok: true, id: r.id, tag: r.tag_name });
  } catch (e) { fail(res, e); }
});

/* GITCORE-START — native git push engine (objects, pack v2, receive-pack protocol) */
function pktLine(sv) { const b = Buffer.isBuffer(sv) ? sv : Buffer.from(sv); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); }
function parsePkts(buf) {
  const out = []; let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.slice(i, i + 4).toString(), 16);
    if (!len) { out.push(null); i += 4; continue; }
    out.push(buf.slice(i + 4, i + len)); i += len;
  }
  return out;
}
function parseAdvert(buf, ref) {
  let old = null;
  for (const pk of parsePkts(buf)) {
    if (!pk) continue;
    const line = pk.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('#')) continue;
    const noCaps = line.split('\0')[0];
    if (noCaps.indexOf(' ') !== 40) continue;
    if (noCaps.slice(41) === ref) old = noCaps.slice(0, 40);
  }
  return old;
}
function gitHashObj(type, buf) {
  return crypto.createHash('sha1').update(Buffer.from(`${type} ${buf.length}\0`)).update(buf).digest('hex');
}
const PACK_TYPE = { commit: 1, tree: 2, blob: 3 };
function packEncode(objs) {
  const chunks = [Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])];
  const n = Buffer.alloc(4); n.writeUInt32BE(objs.length); chunks.push(n);
  for (const o of objs) {
    let size = o.buf.length;
    const head = [(PACK_TYPE[o.type] << 4) | (size & 15)]; size >>= 4;
    while (size) { head[head.length - 1] |= 0x80; head.push(size & 127); size >>= 7; }
    chunks.push(Buffer.from(head), zlib.deflateSync(o.buf));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}
function treeEncode(entries) {
  const key = e => e.mode === '40000' ? e.name + '/' : e.name;
  return Buffer.concat([...entries]
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')])));
}
function commitEncode(tree, parent, message, name, email) {
  const ts = Math.floor(Date.now() / 1000);
  const id = `${name} <${email}> ${ts} +0000`;
  return Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${id}\ncommitter ${id}\n\n${message}\n`);
}
function buildPushObjects(fileBuf, filePath, levels, parentSha, message, name, email) {
  const parts = filePath.split('/'); const fname = parts.pop();
  const blobSha = gitHashObj('blob', fileBuf);
  const objs = [{ type: 'blob', buf: fileBuf, sha: blobSha }];
  const prior = (levels[levels.length - 1].entries || []).find(e => e.name === fname);
  if (prior && (prior.mode === '120000' || prior.mode === '160000'))
    throw new Error('Refusing to overwrite a symlink or submodule entry — remove it first');
  let childSha = blobSha, childName = fname, childMode = (prior && prior.mode) || '100644';
  for (let i = levels.length - 1; i >= 0; i--) {
    const entries = levels[i].entries.filter(e => e.name !== childName);
    entries.push({ mode: childMode, name: childName, sha: childSha });
    const buf = treeEncode(entries);
    childSha = gitHashObj('tree', buf);
    objs.push({ type: 'tree', buf, sha: childSha });
    childMode = '40000'; childName = parts[i - 1];
  }
  const cbuf = commitEncode(childSha, parentSha, message, name, email);
  const commitSha = gitHashObj('commit', cbuf);
  objs.push({ type: 'commit', buf: cbuf, sha: commitSha });
  return { objs, commitSha, blobSha };
}
function buildReceiveBody(oldSha, newSha, branch, pack) {
  return Buffer.concat([
    pktLine(`${oldSha} ${newSha} refs/heads/${branch}\0report-status agent=nebulaverse/4.6.0`),
    Buffer.from('0000'),
    pack
  ]);
}
function parseReport(buf, branch) {
  const lines = parsePkts(buf).filter(Boolean).map(b => b.toString('utf8').replace(/\n$/, ''));
  return {
    unpackOk: lines.includes('unpack ok'),
    okRef: lines.includes(`ok refs/heads/${branch}`),
    err: (lines.find(l => l.startsWith('ng ')) || '').replace(/^ng \S+ ?/, '') || null,
    lines
  };
}
/* GITCORE-END */
let _gitPushBusy = false;
function gitRemoteBase(acct, owner, repo) {
  const prov = acct.provider || 'github';
  if (prov === 'gitlab') {
    const host = String(acct.baseUrl || 'https://gitlab.com').replace(/\/+$/, '');
    return { url: `${host}/${owner}/${repo}.git`, auth: 'Basic ' + Buffer.from(`${acct.login || 'oauth2'}:${acct.token}`).toString('base64') };
  }
  if (prov === 'gitea') {
    const host = String(acct.baseUrl || '').replace(/\/+$/, '');
    return { url: `${host}/${owner}/${repo}.git`, auth: 'Basic ' + Buffer.from(`${acct.login}:${acct.token}`).toString('base64') };
  }
  return { url: `https://github.com/${owner}/${repo}.git`, auth: 'Basic ' + Buffer.from(`x-access-token:${acct.token || acct}`).toString('base64') };
}
async function treeLevels(acct, owner, repo, oldSha, parts) {
  const prov = acct.provider || 'github';
  const levels = [];
  if (prov === 'gitlab') {
    const idGl = encodeURIComponent(owner + '/' + repo);
    let dir = '';
    for (let i = 0; i <= parts.length; i++) {
      const entries = [];
      let page = 1;
      for (;;) {
        const qs = `ref=${encodeURIComponent(oldSha)}&per_page=100&page=${page}${dir ? `&path=${encodeURIComponent(dir)}` : ''}`;
        let batch = [];
        try { batch = await glFetch(acct, `/projects/${idGl}/repository/tree?${qs}`); }
        catch (e) { if (e.status === 404) break; throw e; }
        if (!Array.isArray(batch) || !batch.length) break;
        for (const e of batch) entries.push({ mode: e.mode === '040000' ? '40000' : e.mode, name: e.name, sha: e.id });
        if (batch.length < 100) break;
        if (++page > 50) throw new Error('Directory too large for native push');
      }
      levels.push({ entries });
      if (i < parts.length) dir = dir ? dir + '/' + parts[i] : parts[i];
    }
    return levels;
  }
  let treeSha;
  if (prov === 'github') {
    const cm = await gh(acct, `/repos/${owner}/${repo}/git/commits/${oldSha}`);
    treeSha = cm.tree.sha;
  } else treeSha = oldSha; /* gitea resolves commit-ish to its tree */
  for (let i = 0; i <= parts.length; i++) {
    if (treeSha) {
      const t = await gh(acct, `/repos/${owner}/${repo}/git/trees/${treeSha}`);
      const entries = (t.tree || []).map(e => ({ mode: e.mode === '040000' ? '40000' : e.mode, name: e.path, sha: e.sha }));
      levels.push({ entries });
      if (i < parts.length) { const d = (t.tree || []).find(e => e.path === parts[i] && e.type === 'tree'); treeSha = d ? d.sha : null; }
    } else levels.push({ entries: [] });
  }
  return levels;
}
async function uploadViaGitPush(acct, owner, repo, branch, p, tmp, message, expectedHeadSha = '') {
  mutationGateway.assertProviderMutation({ provider: acct.provider || 'github', baseUrl: acct.baseUrl, method: 'POST', owner, repo, transport: 'git-receive-pack' });
  branch = requireBranchName(branch);
  p = requireRepoPath(p);
  if (_gitPushBusy) { const e = new Error('Another large native push is in flight — retry in a moment'); e.status = 429; throw e; }
  _gitPushBusy = true;
  try {
    const remote = gitRemoteBase(acct, owner, repo);
    const authH = remote.auth;
    const gitBase = remote.url;
    const ad = await fetchT(`${gitBase}/info/refs?service=git-receive-pack`, { headers: { Authorization: authH, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}` }, redirect: 'error' }, 30000);
    if (!ad.ok) throw Object.assign(new Error(`git advertisement failed (${ad.status})`), { status: ad.status });
    const oldSha = parseAdvert(Buffer.from(await ad.arrayBuffer()), `refs/heads/${branch}`);
    if (!oldSha) throw new Error(`Branch ${branch} not found on the remote`);
    assertExpectedHead(expectedHeadSha, oldSha);
    const parts = p.split('/'); parts.pop();
    const levels = await treeLevels(acct, owner, repo, oldSha, parts);
    const stat = await fsp.stat(tmp);
    if (stat.size > GIT_PUSH_MAX) throw Object.assign(new Error(`Native Git push is limited to ${NATIVE_PUSH_MAX_MB} MB on this deployment; use Git LFS for larger GitHub files`), { status: 413 });
    const fileBuf = await fsp.readFile(tmp);
    const who = acct.login || 'nebulaverse';
    const { objs, commitSha } = buildPushObjects(fileBuf, p, levels, oldSha, message, who, `${who}@users.noreply.github.com`);
    const body = buildReceiveBody(oldSha, commitSha, branch, packEncode(objs));
    const pr = await fetchT(`${gitBase}/git-receive-pack`, {
      method: 'POST',
      headers: { Authorization: authH, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result', 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}` },
      body, redirect: 'error'
    }, 300000);
    const rep2 = parseReport(Buffer.from(await pr.arrayBuffer()), branch);
    if (!pr.ok || !rep2.unpackOk || !rep2.okRef) {
      throw Object.assign(new Error('git push rejected: ' + (rep2.err || `HTTP ${pr.status}`)), { status: pr.status || 409 });
    }
    return { commit: commitSha };
  } finally { _gitPushBusy = false; }
}

/* create a git blob from a raw stream (for batch commits) — returns its sha */
app.post('/api/repo/:owner/:repo/blob', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('native-push', { allowExperimental: true }), capabilityAccess('upload-security'), auth, mutationContext('git.blob.create'), async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'nv-' + crypto.randomBytes(8).toString('hex'));
  let release = () => {};
  try {
    release = await acquireUploadSlot(req, BLOB_MAX);
    const size = await receiveRawFile(req, tmp, BLOB_MAX);
    const securityScan = await scanUploadOrThrow(req, tmp, String(req.query.path || 'batch-blob'), size);
    const b64 = (await fsp.readFile(tmp)).toString('base64');
    let blob;
    try {
      blob = await gh(req.gh, `${R(req)}/git/blobs`, { method: 'POST', body: { content: b64, encoding: 'base64' } });
    } catch (e) {
      if (/too large/i.test(e.message || ''))
        return res.status(413).json({ error: 'GitHub rejected this blob as too large for its API — this file will be pushed individually via Git LFS instead' });
      throw e;
    }
    res.json({ ok: true, sha: blob.sha, size, securityScan });
  } catch (e) { fail(res, e); }
  finally { release(); fsp.unlink(tmp).catch(() => {}); }
});

/* ============================================================
   SMART UPLOAD ROUTER (raw stream body) — the headline feature
   ============================================================ */
app.post('/api/repo/:owner/:repo/upload', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('native-push', { allowExperimental: true }), capabilityAccess('upload-security'), auth, mutationContext('file.upload'), async (req, res) => {
  const { owner, repo } = req.params;
  let p = req.query.path, branch = req.query.branch;
  const message = req.query.message || `Upload ${p} via ${PRODUCT_NAME}`;
  /*
   * auto | git | lfs. It was auto|force, which offered one direction only: a
   * reader could insist on Git LFS and could never insist on ordinary Git,
   * because the size rule settled that. An 80 MB video that pushes perfectly
   * well through Git had no way to be pushed that way.
   */
  const transportChoice = normalizeTransportChoice(req.query.lfs);
  const expectedHeadSha = String(req.query.expectedHeadSha || '');
  if (!p || !branch) return res.status(400).json({ error: 'path and branch required' });
  try { p = requireRepoPath(p); branch = requireBranchName(branch); }
  catch (error) { return fail(res, error); }

  const tmp = path.join(os.tmpdir(), 'nv-' + crypto.randomBytes(8).toString('hex'));
  let release = () => {};
  try {
    release = await acquireUploadSlot(req, UPLOAD_MAX);
    const hash = crypto.createHash('sha256');
    const size = await receiveRawFile(req, tmp, UPLOAD_MAX, hash);
    const oid = hash.digest('hex');
    const securityScan = await scanUploadOrThrow(req, tmp, p, size);
    /*
     * One decision, made once, for every provider: what the reader asked for,
     * what this deployment can carry, and -- when those differ -- which
     * transport is used instead and why. The browser labels a queued file with
     * this same function, so what is shown and what happens cannot drift.
     */
    const plan = planUploadTransport({
      size,
      requested: transportChoice,
      lfsAvailable: (req.gh.provider || 'github') === 'github',
      gitPushMaxBytes: GIT_PUSH_MAX,
      gitDataMaxBytes: CONTENTS_MAX
    });
    if (plan.refusal) throw Object.assign(new Error(plan.refusal.message), { status: plan.refusal.status });
    /* Reported on every upload, so a transport swap is never silent. */
    const transport = { requested: plan.requested, fallback: plan.fallback };
    if (req.gh.provider === 'gitlab') {
      if (plan.route === 'git-push') {
        const result2 = await uploadViaGitPush(req.gh, owner, repo, branch, p, tmp, message, expectedHeadSha);
        res.json({ ok: true, size, commit: result2.commit, strategy: 'git-push', transport, securityScan });
        return;
      }
      const b64gl = (await fsp.readFile(tmp)).toString('base64');
      const idGl = encodeURIComponent(owner + '/' + repo);
      const encGl = encodeURIComponent(p);
      let exists = true;
      try { await glFetch(req.gh, `/projects/${idGl}/repository/files/${encGl}?ref=${encodeURIComponent(branch)}`); }
      catch (e3) { if (e3.status === 404) exists = false; else throw e3; }
      await glFetch(req.gh, `/projects/${idGl}/repository/files/${encGl}`, {
        method: exists ? 'PUT' : 'POST',
        body: {
          branch, content: b64gl, encoding: 'base64', commit_message: message,
          ...(exists && expectedHeadSha ? { last_commit_id: expectedHeadSha } : {})
        }
      });
      const lastGl = await glLastCommit(req.gh, idGl, branch);
      res.json({ ok: true, size, commit: lastGl || 'committed', strategy: 'gitlab-files', transport, securityScan });
      return;
    }
    let result;
    if (plan.route === 'lfs') { enforceProtectedPaths(req, [p, '.gitattributes']); result = await uploadViaLFS(req.gh, owner, repo, branch, p, tmp, oid, size, message, expectedHeadSha); result.strategy = 'lfs'; }
    else if (plan.route === 'git-push') {
      try {
        result = await uploadViaGitPush(req.gh, owner, repo, branch, p, tmp, message, expectedHeadSha);
        result.strategy = 'git-push';
      } catch (ePush) {
        if (ePush.code === 'BRANCH_CHANGED' || ePush.status === 400 || ePush.status === 401 || ePush.status === 409) throw ePush;
        console.error(JSON.stringify({ t: new Date().toISOString(), warn: 'native push failed, laddering', status: ePush.status || 0, err: ePush.message }));
        try {
          result = await uploadViaBlob(req.gh, owner, repo, branch, p, tmp, message, expectedHeadSha);
          result.strategy = 'git-data-blob';
        } catch (e) {
          if (/too large/i.test(e.message || '')) {
            enforceProtectedPaths(req, [p, '.gitattributes']);
            result = await uploadViaLFS(req.gh, owner, repo, branch, p, tmp, oid, size, message, expectedHeadSha);
            result.strategy = 'lfs (auto-fallback)';
            /* The plan said Git and the provider disagreed at run time. That is
             * still a swap, so it is still reported. */
            transport.fallback = transport.fallback || Object.freeze({
              from: 'git', to: 'lfs',
              reason: 'the provider refused the object as too large for an ordinary Git push'
            });
          } else throw e;
        }
      }
    }
    else { result = await uploadViaBlob(req.gh, owner, repo, branch, p, tmp, message, expectedHeadSha); result.strategy = 'git-data-api'; }
    res.json({ ok: true, size, ...result, transport, securityScan });
  } catch (e) { fail(res, e); }
  finally { release(); fsp.unlink(tmp).catch(() => {}); }
});

async function uploadViaContents(token, owner, repo, branch, p, tmp, message, expectedHeadSha = '') {
  return uploadViaBlob(token, owner, repo, branch, p, tmp, message, expectedHeadSha);
}
async function uploadViaBlob(token, owner, repo, branch, p, tmp, message, expectedHeadSha = '') {
  const b64 = (await fsp.readFile(tmp)).toString('base64');
  const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, { method: 'POST', body: { content: b64, encoding: 'base64' } });
  const commit = await commitTree(token, owner, repo, branch, message, [{ path: p, mode: '100644', type: 'blob', sha: blob.sha }], expectedHeadSha);
  return { commit };
}
async function uploadViaLFS(sess, owner, repo, branch, p, tmp, oid, size, message, expectedHeadSha = '') {
  assertProviderBoundLfs(sess);
  mutationGateway.assertProviderMutation({ provider: sess.provider || 'github', baseUrl: sess.baseUrl, method: 'POST', owner, repo, transport: 'git-lfs.batch' });
  const { token, login } = sess;
  const basic = Buffer.from(`${login}:${token}`).toString('base64');
  const batchRes = await fetchT(`https://github.com/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json',
      Authorization: `Basic ${basic}`, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
    },
    body: JSON.stringify({ operation: 'upload', transfers: ['basic'], ref: { name: `refs/heads/${branch}` }, objects: [{ oid, size }] }),
    redirect: 'error'
  });
  if (!batchRes.ok) {
    const t = await batchRes.text();
    throw Object.assign(new Error(`LFS batch failed (${batchRes.status}): ${t.slice(0, 300)}`), { status: 502 });
  }
  const batch = await batchRes.json();
  const obj = batch.objects && batch.objects[0];
  if (obj && obj.error) throw Object.assign(new Error(`LFS: ${obj.error.message}`), { status: 502 });
  const uploadAction = obj && obj.actions && obj.actions.upload;
  if (uploadAction) {
    const uploadUrl = requireHttpsLfsActionUrl(uploadAction.href, 'upload');
    mutationGateway.assertProviderMutation({ provider: sess.provider || 'github', baseUrl: sess.baseUrl, method: 'PUT', owner, repo, transport: 'git-lfs.upload' });
    const up = await fetchT(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), ...(uploadAction.header || {}) },
      body: fs.createReadStream(tmp), duplex: 'half', redirect: 'error'
    }, UPLOAD_TIMEOUT_MS);
    if (!up.ok) {
      const t = await up.text();
      throw Object.assign(new Error(`LFS upload failed (${up.status}): ${t.slice(0, 300)}`), { status: 502 });
    }
    const verify = obj.actions.verify;
    if (verify) {
      const verifyUrl = requireHttpsLfsActionUrl(verify.href, 'verification');
      const verifyHeaders = {
        Accept: 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
        ...(verify.header || {})
      };
      if (verifyUrl.hostname === 'github.com' && !verifyHeaders.Authorization) {
        verifyHeaders.Authorization = `Basic ${basic}`;
      }
      mutationGateway.assertProviderMutation({ provider: sess.provider || 'github', baseUrl: sess.baseUrl, method: 'POST', owner, repo, transport: 'git-lfs.verify' });
      const verified = await fetchT(verifyUrl, {
        method: 'POST', headers: verifyHeaders, body: JSON.stringify({ oid, size }), redirect: 'error'
      });
      if (!verified.ok) {
        const text = await verified.text();
        throw Object.assign(new Error(`LFS verification failed (${verified.status}): ${text.slice(0, 300)}`), { status: 502 });
      }
    }
  }
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
  const pattern = lfsAttributePattern(p);
  const attrLine = `${pattern} filter=lfs diff=lfs merge=lfs -text`;
  let attrs = '';
  try {
    const meta = await gh(token, `/repos/${owner}/${repo}/contents/.gitattributes?ref=${encodeURIComponent(branch)}`);
    if (meta.content) attrs = Buffer.from(meta.content, 'base64').toString('utf8');
  } catch (e) { if (e.status !== 404) throw e; }
  const entries = [{ path: p, mode: '100644', type: 'blob', content: pointer }];
  if (!attrs.split('\n').some(l => l.trim().startsWith(pattern + ' '))) {
    const newAttrs = attrs ? attrs.replace(/\n?$/, '\n') + attrLine + '\n' : attrLine + '\n';
    entries.push({ path: '.gitattributes', mode: '100644', type: 'blob', content: newAttrs });
  }
  const commit = await commitTree(token, owner, repo, branch, message, entries, expectedHeadSha);
  return { commit, oid };
}
function branchChangedError() {
  return Object.assign(new Error('The branch changed since this view was loaded. Refresh the repository and retry so newer work is not overwritten.'), {
    status: 409,
    code: 'BRANCH_CHANGED'
  });
}
function assertExpectedHead(expectedHeadSha, actualHeadSha) {
  if (!expectedHeadSha) return;
  if (!/^[0-9a-f]{40}$/i.test(String(expectedHeadSha))) {
    throw Object.assign(new Error('expectedHeadSha must be a 40-character commit SHA'), { status: 400, code: 'INVALID_EXPECTED_HEAD' });
  }
  if (String(expectedHeadSha).toLowerCase() !== String(actualHeadSha || '').toLowerCase()) throw branchChangedError();
}

function requireAggregateExpectedHead(expectedHeadSha) {
  if (!/^[0-9a-f]{40}$/i.test(String(expectedHeadSha || ''))) {
    throw Object.assign(new Error('Aggregate mutations require expectedHeadSha from a fresh repository view'), {
      status: 409, code: 'AGGREGATE_EXPECTED_HEAD_REQUIRED'
    });
  }
  return String(expectedHeadSha).toLowerCase();
}
async function gitTreeEntryByPath(token, owner, repo, rootTreeSha, repoPath, cache = new Map()) {
  const parts = requireRepoPath(repoPath).split('/');
  let treeSha = rootTreeSha;
  for (let index = 0; index < parts.length; index += 1) {
    let tree = cache.get(treeSha);
    if (!tree) {
      tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${treeSha}`);
      cache.set(treeSha, tree);
    }
    const entry = (tree.tree || []).find(item => item.path === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    if (entry.type !== 'tree') return null;
    treeSha = entry.sha;
  }
  return null;
}

async function commitTree(token, owner, repo, branch, message, treeEntries, expectedHeadSha = '') {
  const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parentSha = ref.object.sha;
  assertExpectedHead(expectedHeadSha, parentSha);
  const parent = await gh(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  let existing = new Map();
  let baseTreeTruncated = false;
  try {
    const base = await gh(token, `/repos/${owner}/${repo}/git/trees/${parent.tree.sha}?recursive=1`);
    existing = new Map((base.tree || []).map(entry => [entry.path, entry]));
    baseTreeTruncated = !!base.truncated;
  } catch {}
  if (baseTreeTruncated) {
    const treeCache = new Map();
    for (const entry of treeEntries) {
      if (entry.forceMode) continue;
      const priorPath = entry.preserveFrom || entry.path;
      if (existing.has(priorPath)) continue;
      const prior = await gitTreeEntryByPath(token, owner, repo, parent.tree.sha, priorPath, treeCache);
      if (prior) existing.set(priorPath, prior);
    }
  }
  const normalizedEntries = treeEntries.map(entry => {
    const prior = existing.get(entry.preserveFrom || entry.path);
    const mode = entry.forceMode && entry.mode ? entry.mode : (prior && prior.mode) || entry.mode || '100644';
    const type = entry.forceMode && entry.type ? entry.type : (prior && prior.type) || entry.type || (mode === '160000' ? 'commit' : 'blob');
    const out = { path: entry.path, mode, type };
    if (Object.prototype.hasOwnProperty.call(entry, 'sha')) out.sha = entry.sha;
    else if (Object.prototype.hasOwnProperty.call(entry, 'content')) out.content = entry.content;
    return out;
  });
  const tree = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST', body: { base_tree: parent.tree.sha, tree: normalizedEntries }
  });
  const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST', body: { message, tree: tree.sha, parents: [parentSha] }
  });
  try {
    await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', body: { sha: commit.sha, force: false }
    });
  } catch (error) {
    if (error.status === 409 || error.status === 422) throw branchChangedError();
    throw error;
  }
  return commit.sha;
}

app.post('/api/repo/:owner/:repo/move-dir', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('folder.move', { allowExperimental: true }), auth, mutationContext('directory.move'), async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') return res.status(501).json({ error: 'Folder move is GitHub/Gitea-only for now' });
    const { owner, repo } = req.params;
    let { from, to, branch, message, expectedHeadSha } = req.body || {};
    if (!from || !to || !branch) return res.status(400).json({ error: 'from, to, branch required' });
    from = requireRepoPath(from, 'source folder');
    to = requireRepoPath(to, 'destination folder');
    branch = requireBranchName(branch);
    expectedHeadSha = requireAggregateExpectedHead(expectedHeadSha);
    const src = from, dst = to;
    if (!src || !dst) return res.status(400).json({ error: 'Invalid paths' });
    if (dst === src) return res.status(400).json({ error: 'Destination equals source' });
    if ((dst + '/').startsWith(src + '/')) return res.status(400).json({ error: 'Cannot move a folder inside itself' });
    const ref = await gh(req.gh, `${R(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
    const full = await gh(req.gh, `${R(req)}/git/trees/${ref.object.sha}?recursive=1`);
    if (full.truncated) return res.status(413).json({ error: 'Repository tree too large for folder move' });
    const inside = (full.tree || []).filter(e => (e.type === 'blob' || e.type === 'commit') && (e.path === src || e.path.startsWith(src + '/')));
    if (!inside.length) return res.status(404).json({ error: 'Folder is empty or not found' });
    if (inside.length > 800) return res.status(413).json({ error: `Folder has ${inside.length} files — over the 800-file move limit` });
    const entries = [];
    const affectedPaths = [];
    for (const e of inside) {
      const rest = e.path.slice(src.length);
      const destinationPath = dst + rest;
      affectedPaths.push(e.path, destinationPath);
      entries.push({ path: destinationPath, mode: e.mode, type: e.type, sha: e.sha, forceMode: true });
      entries.push({ path: e.path, mode: e.mode, type: e.type, sha: null, forceMode: true });
    }
    enforceProtectedPaths(req, affectedPaths);
    const commit = await commitTree(req.gh, owner, repo, branch, message || `Move ${src} -> ${dst}`, entries, expectedHeadSha);
    res.json({ ok: true, commit, moved: inside.length });
  } catch (e) { fail(res, e); }
});

/* ================= SAFEGUARDS (v5.0.0) ================= */
app.get('/api/safety', providerSessionAccess, accountAuth, (req, res) => res.json(alphaSafetyView(req, safetyOf(req))));
app.post('/api/safety', providerSessionAccess, alphaSafetyMutationAccess, accountAuth, async (req, res) => {
  try {
    const cur = safetyOf(req);
    const b = req.body || {};
    if (typeof b.readOnly === 'boolean') cur.readOnly = b.readOnly;
    if (typeof b.freezeSync === 'boolean') cur.freezeSync = b.freezeSync;
    if (b.protect && b.protect.repo && b.protect.path) {
      const key = String(b.protect.repo).trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(key)) return res.status(400).json({ error: 'Invalid repository key' });
      const list = new Set(cur.protected[key] || []);
      const protectedPath = String(b.protect.path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').trim();
      if (!protectedPath || protectedPath.length > 512 || protectedPath.includes('..')) return res.status(400).json({ error: 'Invalid protected path or pattern' });
      if (b.protect.on === false) list.delete(protectedPath); else list.add(protectedPath);
      if (list.size > 100) return res.status(413).json({ error: 'Up to 100 protected paths or patterns per repository' });
      if (list.size) cur.protected[key] = [...list].sort(); else delete cur.protected[key];
      if (Object.keys(cur.protected).length > 30) return res.status(413).json({ error: 'Up to 30 repositories with protected paths' });
    }
    req.effectiveSafety = await savePersistentSafety(req, cur);
    await setSession(req, res, req.session);
    const relatedRepo = b.protect && b.protect.repo ? b.protect.repo : 'identity';
    await appendEvidence(`safety:${identityKey(req.gh)}`, 'safety-change', crypto.randomUUID(), {
      actor: retainedActor(req), repository: relatedRepo, readOnly: cur.readOnly, freezeSync: cur.freezeSync,
      protectedCount: Object.values(cur.protected).reduce((n, x) => n + x.length, 0), changedAt: new Date().toISOString()
    }).catch(() => {});
    res.json(req.effectiveSafety);
  } catch (e) { fail(res, e); }
});

async function pagedRepoList(req, resource, maxPages = 10) {
  const pageSize = (req.gh.provider || 'github') === 'gitea' ? 50 : 100;
  const items = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const query = (req.gh.provider || 'github') === 'gitea'
      ? `limit=${pageSize}&page=${page}`
      : `per_page=${pageSize}&page=${page}`;
    const batch = await gh(req.gh, `${R(req)}/${resource}?${query}`);
    if (!Array.isArray(batch)) break;
    items.push(...batch);
    if (batch.length < pageSize) return { items, truncated: false };
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}
const SNAPSHOT_MANIFEST_MAX = HOSTED_LIMITS?.snapshotManifestMax ?? Math.min(Math.max(parseInt(process.env.NV_SNAPSHOT_MANIFEST_MAX || '10000', 10) || 10000, 1000), 50000);
const SNAPSHOT_KINDS = new Set(['nebulaverse-snapshot', 'nebulaverse-emergency-manifest']);
const SNAPSHOT_RETENTION_COUNT = HOSTED_LIMITS?.snapshotRetentionCount ?? Math.min(Math.max(parseInt(process.env.NV_SNAPSHOT_RETENTION_COUNT || '50', 10) || 50, 5), 200);
const RESTORE_AUTH_TTL_MS = 10 * 60 * 1000;
const USED_RESTORE_AUTHORIZATIONS = new Map();

function createRestoreAuthorization(req, actions) {
  const normalized = (Array.isArray(actions) ? actions : []).map(action => {
    const kind = action && action.action === 'recreate' ? 'recreate' : 'reset';
    const name = requireBranchName(action && action.name, 'recovery branch');
    const to = requireCommitSha(action && action.to, 'recovery target SHA');
    const from = kind === 'reset' ? requireCommitSha(action && action.from, 'preview branch SHA') : '';
    return { name, action: kind, from, to };
  });
  if (!normalized.length || normalized.length > 50) {
    throw Object.assign(new Error('Recovery authorization requires between 1 and 50 branch actions'), { status: 400, code: 'RESTORE_ACTION_LIMIT' });
  }
  return seal({
    kind: 'nebulaverse-restore-authorization', version: 1,
    expiresAt: Date.now() + RESTORE_AUTH_TTL_MS,
    provider: req.gh.provider || 'github', owner: req.params.owner, repo: req.params.repo,
    identityKey: identityKey(req.gh), nonce: crypto.randomUUID(), actions: normalized
  });
}

function inspectRestoreAuthorization(req, token) {
  const encoded = String(token || '');
  if (!encoded || encoded.length > 65536) {
    throw Object.assign(new Error('A valid recovery preview authorization is required'), { status: 400, code: 'RESTORE_AUTHORIZATION_REQUIRED' });
  }
  const payload = unseal(encoded);
  if (!payload || payload.kind !== 'nebulaverse-restore-authorization' || payload.version !== 1 ||
      !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
    throw Object.assign(new Error('Recovery preview authorization is invalid or expired'), { status: 409, code: 'RESTORE_AUTHORIZATION_INVALID' });
  }
  if (String(payload.owner || '').toLowerCase() !== String(req.params.owner || '').toLowerCase() ||
      String(payload.repo || '').toLowerCase() !== String(req.params.repo || '').toLowerCase() ||
      String(payload.provider || '').toLowerCase() !== String(req.gh.provider || 'github').toLowerCase() ||
      payload.identityKey !== identityKey(req.gh)) {
    throw Object.assign(new Error('Recovery preview authorization does not match this repository session'), { status: 409, code: 'RESTORE_AUTHORIZATION_SCOPE' });
  }
  const actions = (Array.isArray(payload.actions) ? payload.actions : []).map(action => {
    const kind = action && action.action === 'recreate' ? 'recreate' : 'reset';
    const name = requireBranchName(action && action.name, 'recovery branch');
    const to = requireCommitSha(action && action.to, 'recovery target SHA');
    const from = kind === 'reset' ? requireCommitSha(action && action.from, 'preview branch SHA') : '';
    return { name, action: kind, from, to };
  });
  if (!actions.length || actions.length > 50 || new Set(actions.map(action => action.name)).size !== actions.length) {
    throw Object.assign(new Error('Recovery preview authorization contains invalid actions'), { status: 400, code: 'RESTORE_AUTHORIZATION_ACTIONS' });
  }
  return { encoded, actions, expiresAt: payload.expiresAt };
}

function consumeRestoreAuthorization(req, token) {
  const inspected = inspectRestoreAuthorization(req, token);
  const tokenHash = crypto.createHash('sha256').update(inspected.encoded).digest('hex');
  const now = Date.now();
  for (const [hash, expiresAt] of USED_RESTORE_AUTHORIZATIONS) if (expiresAt <= now) USED_RESTORE_AUTHORIZATIONS.delete(hash);
  if (USED_RESTORE_AUTHORIZATIONS.has(tokenHash)) {
    throw Object.assign(new Error('Recovery preview authorization has already been used; generate a fresh preview before retrying'), { status: 409, code: 'RESTORE_AUTHORIZATION_REPLAY' });
  }
  return { actions: inspected.actions, expiresAt: inspected.expiresAt, tokenHash };
}

async function preflightRestoreActions(req, actions) {
  const conflicts = [];
  for (const action of actions) {
    let current = null;
    try { current = await gh(req.gh, `${R(req)}/git/ref/heads/${encodeURIComponent(action.name)}`); }
    catch (error) {
      if (error.status !== 404) throw error;
    }
    const currentSha = current ? referenceSha(current) : '';
    if (action.action === 'reset' && currentSha !== action.from) {
      conflicts.push({ name: action.name, expected: action.from, current: currentSha, reason: currentSha ? 'branch moved after preview' : 'branch was deleted after preview' });
    } else if (action.action === 'recreate' && currentSha) {
      conflicts.push({ name: action.name, expected: '', current: currentSha, reason: 'branch was created after preview' });
    }
  }
  return conflicts;
}
async function captureRefsSnapshot(req, includeManifest) {
  if (req.gh.provider === 'gitlab') throw Object.assign(new Error('Snapshots are GitHub/Gitea-only for now'), { status: 501 });
  const [info, branchPage] = await Promise.all([
    gh(req.gh, `${R(req)}`),
    pagedRepoList(req, 'branches')
  ]);
  let tagPage = { items: [], truncated: false };
  let tagsAvailable = true;
  let tagsError = '';
  try { tagPage = await pagedRepoList(req, 'tags'); }
  catch (error) {
    tagsAvailable = false;
    tagsError = cleanText(error && error.message || 'Tag inventory unavailable', 240);
  }
  const refs = branchPage.items.map(b => ({ name: b.name, sha: referenceSha(b), protected: !!b.protected })).filter(r => r.name && r.sha);
  let manifest = null;
  if (includeManifest) {
    const head = refs.find(r => r.name === info.default_branch) || refs[0];
    if (head) {
      const t = await gh(req.gh, `${R(req)}/git/trees/${head.sha}?recursive=1`);
      const allFiles = (t.tree || []).filter(e => e.type === 'blob' || e.type === 'commit');
      manifest = {
        branch: head.name,
        truncated: !!t.truncated || allFiles.length > SNAPSHOT_MANIFEST_MAX,
        providerTreeTruncated: !!t.truncated,
        totalFiles: allFiles.length,
        files: allFiles.slice(0, SNAPSHOT_MANIFEST_MAX).map(e => ({ path: e.path, sha: e.sha, size: e.size || 0, mode: e.mode, type: e.type }))
      };
    }
  }
  return {
    kind: 'nebulaverse-snapshot', version: 2, capturedAt: new Date().toISOString(),
    owner: req.params.owner, repo: req.params.repo, provider: req.gh.provider || 'github', defaultBranch: info.default_branch,
    refs,
    refsTruncated: branchPage.truncated,
    tags: tagPage.items.map(t => ({ name: t.name, sha: referenceSha(t) })).filter(t => t.name && t.sha),
    tagsAvailable,
    tagsError,
    tagsTruncated: tagPage.truncated,
    manifest
  };
}

app.get('/api/repo/:owner/:repo/refs-snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try { res.json(await captureRefsSnapshot(req, req.query.manifest === '1')); }
  catch (e) { fail(res, e); }
});


function validateSnapshotForRequest(req, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.refs)) {
    throw Object.assign(new Error('A valid Nebulaverse-X snapshot with refs is required'), { status: 400, code: 'INVALID_SNAPSHOT' });
  }
  if (!SNAPSHOT_KINDS.has(String(snapshot.kind || ''))) {
    throw Object.assign(new Error('Unsupported recovery snapshot kind'), { status: 400, code: 'SNAPSHOT_KIND_INVALID' });
  }
  if (String(snapshot.owner || '').toLowerCase() !== String(req.params.owner || '').toLowerCase() ||
      String(snapshot.repo || '').toLowerCase() !== String(req.params.repo || '').toLowerCase()) {
    throw Object.assign(new Error('Snapshot repository does not match the open repository'), { status: 409, code: 'SNAPSHOT_REPOSITORY_MISMATCH' });
  }
  if (snapshot.provider && String(snapshot.provider).toLowerCase() !== String(req.gh.provider || 'github').toLowerCase()) {
    throw Object.assign(new Error('Snapshot provider does not match the active repository provider'), { status: 409, code: 'SNAPSHOT_PROVIDER_MISMATCH' });
  }
  if (snapshot.refs.length > 1000) throw Object.assign(new Error('Snapshot contains too many branch refs'), { status: 413 });
  return snapshot;
}

async function snapshotComparisonForRequest(req, snapshot) {
  const baseline = validateSnapshotForRequest(req, snapshot);
  const compareManifest = !!(baseline.manifest && Array.isArray(baseline.manifest.files));
  const current = await captureRefsSnapshot(req, compareManifest);
  return { baseline, current, comparison: compareSnapshots(baseline, current) };
}

app.post('/api/repo/:owner/:repo/snapshot-compare', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const result = await snapshotComparisonForRequest(req, req.body && req.body.snapshot);
    res.json({
      kind: 'nebulaverse-snapshot-comparison', version: 1, generatedAt: new Date().toISOString(),
      baselineCapturedAt: result.baseline.capturedAt || null,
      currentCapturedAt: result.current.capturedAt,
      comparison: result.comparison
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/repo/:owner/:repo/restore-preview', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const result = await snapshotComparisonForRequest(req, req.body && req.body.snapshot);
    const currentByName = new Map((result.current.refs || []).map(ref => [ref.name, ref]));
    const actions = [];
    for (const item of result.comparison.refs.move) {
      const current = currentByName.get(item.name);
      actions.push({ name: item.name, action: 'reset', from: item.current, to: item.expected, protected: !!(current && current.protected) });
    }
    for (const item of result.comparison.refs.recreate) {
      actions.push({ name: item.name, action: 'recreate', from: '', to: item.expected, protected: false });
    }
    const warnings = [];
    if (result.baseline.refsTruncated) warnings.push('The snapshot branch inventory was truncated.');
    if (result.baseline.tagsTruncated) warnings.push('The snapshot tag inventory was truncated. Tags are compared but not changed by ref restore.');
    if (result.comparison.truncated) warnings.push('At least one file manifest is truncated, so file counts are incomplete.');
    if (actions.some(action => action.protected)) warnings.push('One or more protected provider branches would be force-updated. Provider branch rules may reject the restore.');
    if (actions.length > 50) warnings.push('This preview contains more than 50 branch changes. Split recovery into smaller, reviewed snapshots before restoring.');
    if (protectedPatternsForReq(req).length) warnings.push('Nebulaverse-X protected-path policies are active. The actual restore remains blocked until those policies are unlocked.');
    if (safetyOf(req).readOnly) warnings.push('Nebulaverse-X read-only mode is active. Disable it before restoring branch references.');
    const canRestore = result.comparison.compatible && actions.length > 0 && actions.length <= 50 && !result.baseline.refsTruncated && !protectedPatternsForReq(req).length && !safetyOf(req).readOnly;
    const authorization = canRestore ? createRestoreAuthorization(req, actions) : '';
    res.json({
      kind: 'nebulaverse-restore-preview', version: 1, generatedAt: new Date().toISOString(),
      repository: `${req.params.owner}/${req.params.repo}`,
      canRestore,
      authorization,
      authorizationExpiresInSeconds: canRestore ? Math.floor(RESTORE_AUTH_TTL_MS / 1000) : 0,
      actions,
      preservedBranches: result.comparison.refs.preserve,
      unchangedBranches: result.comparison.refs.unchanged,
      fileImpact: result.comparison.files,
      counts: result.comparison.counts,
      warnings
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/repo/:owner/:repo/signed-snapshot', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req, res) => {
  try {
    if (!(await dbReady())) return res.status(503).json({ error: 'Signed snapshots require the existing Neon DATABASE_URL' });
    const includeManifest = !(req.body && req.body.manifest === false);
    const snapshot = await captureRefsSnapshot(req, includeManifest);
    const snapshotId = crypto.randomUUID();
    const signature = SNAPSHOT_SIGNATURES.sign(snapshotId, snapshot);
    const provider = req.gh.provider || 'github';
    const identity = identityKey(req.gh);
    await pool().query(
      `INSERT INTO nv_recovery_snapshots(snapshot_id,provider,owner,repo,identity_key,snapshot,signature)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [snapshotId, provider, req.params.owner, req.params.repo, identity, JSON.stringify(snapshot), signature]
    );
    await pool().query(
      `DELETE FROM nv_recovery_snapshots WHERE snapshot_id IN (
         SELECT snapshot_id FROM nv_recovery_snapshots
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4
         ORDER BY created_at DESC, snapshot_id DESC OFFSET $5
       )`,
      [provider, req.params.owner, req.params.repo, identity, SNAPSHOT_RETENTION_COUNT]
    );
    const evidence = await appendEvidence(scopedEvidenceKey(provider, req.params.owner, req.params.repo, identity), 'recovery-snapshot', snapshotId, { snapshot, signature });
    res.status(201).json({
      snapshotId,
      signature,
      signatureKeyId: SNAPSHOT_SIGNATURES.activeKeyId,
      evidence,
      snapshot
    });
  } catch (e) { fail(res, e); }
});


app.post('/api/repo/:owner/:repo/emergency-manifest', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, async (req, res) => {
  try {
    if (String(req.body && req.body.confirm || '').toUpperCase() !== 'FREEZE') {
      return res.status(400).json({ error: 'Type FREEZE to confirm emergency containment' });
    }
    const captured = await captureRefsSnapshot(req, true);
    const currentSafety = defaultSafety(req.effectiveSafety || req.session.safety);
    currentSafety.readOnly = true;
    currentSafety.freezeSync = true;
    req.effectiveSafety = await savePersistentSafety(req, currentSafety);
    await setSession(req, res, req.session);

    const inventory = await sessionsForIdentity(req);
    const requestedRevocations = inventory.available
      ? inventory.rows.filter(row => !row.current).map(row => row.sid)
      : [];
    const revokedIds = await revokeContainedSessions(req, requestedRevocations);
    const streamsClosed = closeLiveSessions(revokedIds, 'emergency-containment');

    const manifestId = crypto.randomUUID();
    const manifest = {
      ...captured,
      kind: 'nebulaverse-emergency-manifest',
      version: 1,
      incidentId: manifestId,
      activatedAt: new Date().toISOString(),
      activatedBy: retainedActor(req),
      controls: {
        readOnly: true,
        freezeSync: true,
        sessionsRevoked: revokedIds.length,
        streamsClosed,
        sessionRevocationAvailable: !!inventory.available
      }
    };
    const signature = SNAPSHOT_SIGNATURES.sign(manifestId, manifest);
    const signatureVerification = SNAPSHOT_SIGNATURES.verify(signature, manifestId, manifest);
    if (!signatureVerification.valid) {
      const error = new Error('Emergency manifest signature verification failed');
      error.code = 'SNAPSHOT_SIGNATURE_VERIFICATION_FAILED';
      throw error;
    }
    let persisted = false;
    let evidence = null;
    if (await dbReady()) {
      const provider = req.gh.provider || 'github';
      const identity = identityKey(req.gh);
      await pool().query(
        `INSERT INTO nv_recovery_snapshots(snapshot_id,provider,owner,repo,identity_key,snapshot,signature)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [manifestId, provider, req.params.owner, req.params.repo, identity, JSON.stringify(manifest), signature]
      );
      await pool().query(
        `DELETE FROM nv_recovery_snapshots WHERE snapshot_id IN (
           SELECT snapshot_id FROM nv_recovery_snapshots
           WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4
           ORDER BY created_at DESC, snapshot_id DESC OFFSET $5
         )`,
        [provider, req.params.owner, req.params.repo, identity, SNAPSHOT_RETENTION_COUNT]
      );
      evidence = await appendEvidence(scopedEvidenceKey(provider, req.params.owner, req.params.repo, identity), 'emergency-manifest', manifestId, { manifest, signature });
      persisted = true;
    }
    res.status(201).json({
      manifestId,
      signature,
      signatureKeyId: signatureVerification.keyId,
      signatureValid: signatureVerification.valid,
      persisted,
      evidence,
      manifest
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/repo/:owner/:repo/signed-snapshots', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery', { allowExperimental: true }), auth, async (req, res) => {
  try {
    if (!(await dbReady())) return res.json({ available: false, snapshots: [] });
    const r = await pool().query(
      `SELECT snapshot_id,snapshot,signature,created_at FROM nv_recovery_snapshots
       WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4
       ORDER BY created_at DESC LIMIT 25`,
      [req.gh.provider || 'github', req.params.owner, req.params.repo, identityKey(req.gh)]
    );
    res.json({ available: true, snapshots: r.rows.map(x => {
      const verification = SNAPSHOT_SIGNATURES.verify(x.signature, x.snapshot_id, x.snapshot);
      return {
        snapshotId: x.snapshot_id,
        signature: x.signature,
        signatureValid: verification.valid,
        signatureKeyId: verification.keyId,
        signatureLegacy: verification.legacy,
        createdAt: x.created_at,
        snapshot: x.snapshot
      };
    }) });
  } catch (e) { fail(res, e); }
});

app.post('/api/repo/:owner/:repo/restore-refs', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), auth, mutationContext('recovery.restore-refs'), async (req, res) => {
  try {
    if (req.gh.provider === 'gitlab') return res.status(501).json({ error: 'Ref restore is GitHub/Gitea-only for now' });
    const { authorization, confirm } = req.body || {};
    if (String(confirm || '').toUpperCase() !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm recovery', code: 'RESTORE_CONFIRMATION_REQUIRED' });
    const grant = consumeRestoreAuthorization(req, authorization);
    const conflicts = await preflightRestoreActions(req, grant.actions);
    if (conflicts.length) {
      return res.status(409).json({
        error: 'Repository branch heads changed after the recovery preview. Generate a new preview before restoring.',
        code: 'RESTORE_PREVIEW_STALE', conflicts
      });
    }
    USED_RESTORE_AUTHORIZATIONS.set(grant.tokenHash, grant.expiresAt);
    const report = [];
    for (const action of grant.actions) {
      try {
        if (action.action === 'recreate') {
          await gh(req.gh, `${R(req)}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${action.name}`, sha: action.to } });
        } else {
          await gh(req.gh, `${R(req)}/git/refs/heads/${encodeURIComponent(action.name)}`, { method: 'PATCH', body: { sha: action.to, force: true } });
        }
        const execution = mutationGateway.executionSnapshot();
        report.push({
          name: action.name, ok: true, action: action.action === 'recreate' ? 'recreated' : 'reset',
          operationId: execution && execution.operationIds[execution.operationIds.length - 1] || null
        });
      } catch (error) {
        const execution = mutationGateway.executionSnapshot();
        report.push({
          name: action.name, ok: false,
          operationId: execution && execution.operationIds[execution.operationIds.length - 1] || null,
          error: cleanText(error.message || 'Provider rejected branch recovery', 300)
        });
      }
    }
    const ok = report.every(item => item.ok);
    res.json({
      ok, partialFailure: !ok && report.some(item => item.ok), previewBound: true,
      batchHash: req.mutation && req.mutation.metadata && req.mutation.metadata.batchHash || null,
      report
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/repo/:owner/:repo/activity', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '14', 10) || 14, 1), 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const base = {
      kind: 'nebulaverse-activity', version: 1, generatedAt: new Date().toISOString(),
      owner: req.params.owner, repo: req.params.repo, days, since
    };
    if (req.gh.provider === 'gitlab') {
      const cs = await glFetch(req.gh, `/projects/${glId(req)}/repository/commits?since=${encodeURIComponent(since)}&per_page=100`);
      return res.json({ ...base, commits: cs.map(c => ({ sha: c.id, message: c.title, author: c.author_name, date: c.created_at })), pulls: [], issues: [], releases: [] });
    }
    const includePulls = requestSupportsCapability(req, 'pulls.read');
    const includeIssues = requestSupportsCapability(req, 'issues.read');
    const includeReleases = requestSupportsCapability(req, 'releases.read');
    const [commits, pulls, issues] = await Promise.all([
      gh(req.gh, `${R(req)}/commits?since=${encodeURIComponent(since)}&per_page=100`).catch(() => []),
      includePulls
        ? gh(req.gh, `${R(req)}/pulls?state=all&sort=updated&direction=desc&per_page=30`).catch(() => [])
        : Promise.resolve([]),
      includeIssues
        ? gh(req.gh, `${R(req)}/issues?state=all&sort=updated&direction=desc&per_page=30`).catch(() => [])
        : Promise.resolve([])
    ]);
    let releases = [];
    if (includeReleases) {
      try { releases = await gh(req.gh, `${R(req)}/releases?per_page=20`); } catch {}
    }
    const fresh = d => d && new Date(d) >= new Date(since);
    res.json({
      ...base,
      commits: (commits || []).map(c => ({
        sha: c.sha, message: ((c.commit && c.commit.message) || '').split('\n')[0],
        author: (c.commit && c.commit.author && c.commit.author.name) || '',
        date: c.commit && c.commit.author && c.commit.author.date
      })),
      pulls: (pulls || []).filter(p => fresh(p.updated_at)).map(p => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, updated: p.updated_at })),
      issues: (issues || []).filter(i => !i.pull_request && fresh(i.updated_at)).map(i => ({ number: i.number, title: i.title, state: i.state, updated: i.updated_at })),
      releases: (releases || []).filter(r => fresh(r.published_at || r.created_at)).map(r => ({ tag: r.tag_name, name: r.name, published: r.published_at || r.created_at }))
    });
  } catch (e) { fail(res, e); }
});

/*
 * The overview's activity feed.
 *
 * The overview has no repository in hand -- that is the whole difficulty. The
 * cheap cross-repository source, GitHub's per-user event stream, is one request
 * for everything, and it is not usable here: it does not exist for a GitHub App
 * installation, which has no user to attribute events to, and it would be a new
 * provider read that this project does not let itself claim as verified until a
 * live run has earned it. So the feed is assembled from reads already earned,
 * over a bounded set of repositories.
 *
 * Bounded is the operative word. Every repository here is a separate round trip
 * against someone's rate limit, and an inventory of two hundred repositories
 * must not turn opening the overview into two hundred requests. src/activity-feed.js
 * caps the fan-out; this asks only for commits, because commits are the signal
 * a feed is mostly made of and pulls, issues and releases would triple the cost
 * of a screen the reader has not asked to drill into. The response says which
 * kinds it carries so the card can describe itself truthfully rather than imply
 * it is showing everything that happened.
 *
 * One repository failing is not the feed failing. Each read is settled
 * independently and a repository that refused is named in the payload, because
 * a card that quietly shows the other five is telling the reader the sixth was
 * quiet when it was in fact unreadable.
 */
app.get('/api/activity/recent', providerSessionAccess, alphaRepositoryListAccess, capabilityAccess('repository.read'), auth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '14', 10) || 14, 1), 90);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const inventory = await listRepositoriesFor(req);
    /* How many repositories to fan out over, not which ones -- the module
       caps it either way. Named so nobody reads it as a list of names. */
    const selected = selectActivityRepositories(inventory, req.query.repositoryLimit);

    const results = await Promise.all(selected.map(async entry => {
      try {
        const commits = req.gh.provider === 'gitlab'
          ? (await glFetch(req.gh, `/projects/${encodeURIComponent(entry.full_name)}/repository/commits?since=${encodeURIComponent(since)}&per_page=20`))
            .map(c => ({ sha: c.id, message: c.title, author: c.author_name, date: c.created_at }))
          : (await gh(req.gh, `/repos/${entry.owner}/${entry.name}/commits?since=${encodeURIComponent(since)}&per_page=20`))
            .map(c => ({
              sha: c.sha,
              message: ((c.commit && c.commit.message) || '').split('\n')[0],
              author: (c.commit && c.commit.author && c.commit.author.name) || '',
              date: (c.commit && c.commit.committer && c.commit.committer.date)
                || (c.commit && c.commit.author && c.commit.author.date)
            }));
        return { repo: entry.full_name, commits };
      } catch (error) {
        /*
         * The reason, not a stack. publicErrorBody is what every other route
         * uses to decide what a caller may be told, so the feed does not invent
         * its own disclosure rule for the same provider errors.
         */
        const body = publicErrorBody(error, { correlationId: res.locals.correlationId });
        return { repo: entry.full_name, error: (body && body.error) || 'unavailable' };
      }
    }));

    res.json({
      kind: 'nebulaverse-activity-feed',
      version: 1,
      generatedAt: new Date().toISOString(),
      days,
      since,
      kinds: ['commit'],
      perRepositoryLimit: 20,
      inventoryScope: 'first-page',
      inventoryCount: inventory.length,
      ...buildActivityFeed(results, { limit: req.query.limit })
    });
  } catch (e) { fail(res, e); }
});

const MANIFESTS = ['package-lock.json', 'package.json', 'requirements.txt', 'go.mod', 'Cargo.lock', 'Gemfile.lock'];
function cleanVer(v) { return String(v || '').replace(/^[\^~>=<v\s]+/, '').split(/[\s,]/)[0].trim(); }
function parseManifest(name, text) {
  const out = [];
  const add = (n, v, eco) => { const ver = cleanVer(v); if (n && /^\d/.test(ver)) out.push({ name: n, version: ver, ecosystem: eco }); };
  try {
    if (name === 'package-lock.json') {
      const j = JSON.parse(text);
      if (j.packages) {
        for (const [k, v] of Object.entries(j.packages)) {
          if (!k.startsWith('node_modules/')) continue;
          add(k.slice('node_modules/'.length), v.version, 'npm');
        }
      } else if (j.dependencies) {
        for (const [k, v] of Object.entries(j.dependencies)) add(k, v.version, 'npm');
      }
    } else if (name === 'package.json') {
      const j = JSON.parse(text);
      for (const grp of [j.dependencies, j.devDependencies]) if (grp) for (const [k, v] of Object.entries(grp)) add(k, v, 'npm');
    } else if (name === 'requirements.txt') {
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;#]*)/);
        if (m) add(m[1], m[2], 'PyPI');
      }
    } else if (name === 'go.mod') {
      for (const line of text.split('\n')) {
        if (/^\s*module\s/.test(line)) continue;
        const m = line.match(/^\s*([a-zA-Z0-9./_-]+)\s+v([0-9][^\s/]*)/);
        if (m) add(m[1], m[2], 'Go');
      }
    } else if (name === 'Cargo.lock') {
      for (const b of text.split('[[package]]')) {
        const n = (b.match(/name\s*=\s*"([^"]+)"/) || [])[1];
        const v = (b.match(/version\s*=\s*"([^"]+)"/) || [])[1];
        if (n && v) add(n, v, 'crates.io');
      }
    } else if (name === 'Gemfile.lock') {
      for (const line of text.split('\n')) {
        const m = line.match(/^\s{4}([A-Za-z0-9._-]+)\s+\(([0-9][^)]*)\)/);
        if (m) add(m[1], m[2], 'RubyGems');
      }
    }
  } catch {}
  return out;
}

async function pagedGithubCollection(req, resource, maxPages = 3) {
  const items = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const join = resource.includes('?') ? '&' : '?';
    const batch = await gh(req.gh, `${R(req)}/${resource}${join}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

function permissionFromCollaborator(item) {
  if (item && item.role_name) return cleanText(item.role_name, 40).toLowerCase();
  const p = item && item.permissions || {};
  if (p.admin) return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push) return 'write';
  if (p.triage) return 'triage';
  if (p.pull) return 'read';
  return 'unknown';
}

function webhookHost(raw) {
  try {
    const u = new URL(String(raw || ''));
    return ['http:', 'https:'].includes(u.protocol) ? u.hostname.toLowerCase().slice(0, 253) : '';
  } catch { return ''; }
}

app.get('/api/repo/:owner/:repo/access-surface', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('access-surface'), auth, async (req, res) => {
  try {
    if ((req.gh.provider || 'github') !== 'github') {
      return res.json({ available: false, partial: true, reason: 'Shadow Access Radar currently uses GitHub administration APIs.', collaborators: [], deployKeys: [], webhooks: [], risk: riskForAccessSurface({ partial: true }) });
    }
    const settled = await Promise.allSettled([
      gh(req.gh, `${R(req)}`),
      pagedGithubCollection(req, 'collaborators?affiliation=all', 3),
      pagedGithubCollection(req, 'keys', 3),
      pagedGithubCollection(req, 'hooks', 3)
    ]);
    const errors = [];
    const repo = settled[0].status === 'fulfilled' ? settled[0].value : null;
    if (settled[0].status === 'rejected') errors.push(`repository: ${cleanText(settled[0].reason && settled[0].reason.message, 160)}`);
    const collaboratorPage = settled[1].status === 'fulfilled' ? settled[1].value : { items: [], truncated: false };
    if (settled[1].status === 'rejected') errors.push(`collaborators: ${cleanText(settled[1].reason && settled[1].reason.message, 160)}`);
    const keyPage = settled[2].status === 'fulfilled' ? settled[2].value : { items: [], truncated: false };
    if (settled[2].status === 'rejected') errors.push(`deploy keys: ${cleanText(settled[2].reason && settled[2].reason.message, 160)}`);
    const hookPage = settled[3].status === 'fulfilled' ? settled[3].value : { items: [], truncated: false };
    if (settled[3].status === 'rejected') errors.push(`webhooks: ${cleanText(settled[3].reason && settled[3].reason.message, 160)}`);

    const collaborators = collaboratorPage.items.slice(0, 300).map(item => ({
      login: cleanText(item.login || '', 100),
      avatar: cleanText(item.avatar_url || '', 500),
      permission: permissionFromCollaborator(item),
      type: cleanText(item.type || 'User', 40),
      siteAdmin: !!item.site_admin
    })).filter(item => item.login);
    const deployKeys = keyPage.items.slice(0, 300).map(item => ({
      id: Number(item.id || 0),
      title: cleanText(item.title || 'Deploy key', 160),
      readOnly: item.read_only !== false,
      verified: item.verified !== false,
      enabled: item.enabled !== false,
      addedBy: cleanText(item.added_by || '', 100),
      createdAt: item.created_at || null,
      lastUsed: item.last_used || null
    })).filter(item => item.id);
    const webhooks = hookPage.items.slice(0, 300).map(item => ({
      id: Number(item.id || 0),
      name: cleanText(item.name || 'web', 80),
      active: item.active !== false,
      events: Array.isArray(item.events) ? item.events.slice(0, 50).map(event => cleanText(event, 80)) : [],
      host: webhookHost(item.config && item.config.url),
      insecureSsl: String(item.config && item.config.insecure_ssl || '0') === '1',
      updatedAt: item.updated_at || null
    })).filter(item => item.id);
    const partial = errors.length > 0 || collaboratorPage.truncated || keyPage.truncated || hookPage.truncated;
    const surface = {
      available: true,
      partial,
      errors,
      currentIdentity: cleanText(req.gh.login || '', 100),
      currentPermission: repo && repo.permissions ? permissionFromCollaborator({ permissions: repo.permissions }) : 'unknown',
      collaborators,
      deployKeys,
      webhooks,
      truncated: { collaborators: collaboratorPage.truncated, deployKeys: keyPage.truncated, webhooks: hookPage.truncated }
    };
    surface.risk = riskForAccessSurface(surface);
    res.setHeader('Cache-Control', 'no-store');
    res.json(surface);
  } catch (e) { fail(res, e); }
});

app.get('/api/repo/:owner/:repo/audit-deps', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('dependency-audit', { allowExperimental: true }), auth, async (req, res) => {
  try {
    const branch = req.query.ref || '';
    const found = [], sources = [];
    for (const name of MANIFESTS) {
      try {
        let text = '';
        if (req.gh.provider === 'gitlab') {
          const f = await glFetch(req.gh, `/projects/${glId(req)}/repository/files/${encodeURIComponent(name)}?ref=${encodeURIComponent(branch || 'HEAD')}`);
          text = Buffer.from(f.content || '', 'base64').toString('utf8');
        } else {
          const f = await gh(req.gh, `${R(req)}/contents/${encodeURIComponent(name)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
          text = Buffer.from(f.content || '', 'base64').toString('utf8');
        }
        const pkgs = parseManifest(name, text);
        if (pkgs.length) { sources.push({ file: name, packages: pkgs.length, approximate: name === 'package.json' }); found.push(...pkgs); }
        if (name === 'package-lock.json' && pkgs.length) break;
      } catch {}
    }
    const seen = new Set();
    const pkgs = found.filter(p => {
      const k = `${p.ecosystem}:${p.name}@${p.version}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 400);
    const vulnerable = [];
    const osv = { available: pkgs.length === 0, queried: pkgs.length, error: '' };
    if (pkgs.length) {
      try {
        const r = await fetchT('https://api.osv.dev/v1/querybatch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: pkgs.map(p => ({ version: p.version, package: { name: p.name, ecosystem: p.ecosystem } })) })
        }, 25000);
        if (!r.ok) {
          osv.error = `OSV service returned HTTP ${r.status}`;
        } else {
          const data = await r.json();
          if (!Array.isArray(data.results)) osv.error = 'OSV returned an unexpected response';
          else {
            osv.available = true;
            data.results.forEach((row, i) => {
              if (row && row.vulns && row.vulns.length && pkgs[i]) vulnerable.push({ ...pkgs[i], ids: row.vulns.map(v => v.id).slice(0, 8) });
            });
          }
        }
      } catch (error) {
        osv.error = cleanText(error && error.message || 'OSV request failed', 240);
      }
    }
    const ids = [...new Set(vulnerable.flatMap(v => v.ids))].slice(0, 20);
    const details = {};
    await Promise.allSettled(ids.map(async id => {
      const r2 = await fetchT(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {}, 12000);
      if (r2.ok) {
        const v = await r2.json();
        details[id] = {
          summary: v.summary || String(v.details || '').slice(0, 160),
          severity: (v.severity || []).map(x => x.score).join(' ') || ((v.database_specific && v.database_specific.severity) || ''),
          aliases: (v.aliases || []).slice(0, 3)
        };
      }
    }));
    let dependabot = { available: false, alerts: [] };
    if ((req.gh.provider || 'github') === 'github') {
      try {
        const al = await gh(req.gh, `${R(req)}/dependabot/alerts?state=open&per_page=50`);
        dependabot = {
          available: true,
          alerts: (al || []).map(a => ({
            severity: a.security_advisory && a.security_advisory.severity,
            package: a.dependency && a.dependency.package && a.dependency.package.name,
            summary: a.security_advisory && a.security_advisory.summary
          }))
        };
      } catch { dependabot = { available: false, alerts: [], note: 'Token lacks security_events scope, or alerts are off for this repo' }; }
    }
    res.json({
      kind: 'nebulaverse-audit', generatedAt: new Date().toISOString(),
      owner: req.params.owner, repo: req.params.repo,
      scanned: pkgs.length, sources, vulnerable, details, dependabot, osv,
      complete: pkgs.length === 0 || osv.available,
      approximate: sources.some(s => s.approximate) && !sources.some(s => s.file === 'package-lock.json')
    });
  } catch (e) { fail(res, e); }
});

/* ---------------- utils ---------------- */
function guessMime(p) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.json': 'application/json', '.html': 'text/html; charset=utf-8'
  };
  return map[path.extname(p || '').toLowerCase()] || 'application/octet-stream';
}


/* ================= LIVE INTELLIGENCE + EVIDENCE (v5.2) ================= */
app.get('/api/repo/:owner/:repo/live-events/status', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events', { allowExperimental: true }), auth, async (req, res) => {
  try {
    if ((req.gh.provider || 'github') !== 'github') return res.json({ available: false, connected: false, reason: 'GitHub-only in v5.2' });
    if (!(await dbReady())) return res.json({ available: false, connected: false, reason: 'Connect the existing Neon DATABASE_URL to persist verified events' });
    const r = await pool().query(
      `SELECT hook_id,provider_hook_id,active,created_at,updated_at FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
      [req.params.owner, req.params.repo, identityKey(req.gh)]
    );
    const row = r.rows[0];
    res.json({ available: true, connected: !!(row && row.active), createdAt: row && row.created_at });
  } catch (e) { fail(res, e); }
});

async function removeOrphanedProviderHook(acct, req, providerHookId) {
  if (!providerHookId) return;
  try {
    await gh(acct, `${R(req)}/hooks/${providerHookId}`, { method: 'DELETE' });
  } catch (cleanupError) {
    if (cleanupError.status !== 404) console.error(JSON.stringify({
      t: new Date().toISOString(), warn: 'orphaned GitHub webhook cleanup failed', providerHookId, error: cleanupError.message
    }));
  }
}

app.post('/api/repo/:owner/:repo/live-events/connect', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events', { allowExperimental: true }), auth, mutationContext('webhook.connect'), async (req, res) => {
  try {
    if ((req.gh.provider || 'github') !== 'github') return res.status(501).json({ error: 'Verified live events are GitHub-only in v5.2' });
    if (!(await dbReady())) return res.status(503).json({ error: 'Live events require the existing Neon DATABASE_URL' });
    const key = identityKey(req.gh);
    const existing = await pool().query(
      `SELECT hook_id,provider_hook_id,active,alpha_resource_key_hash FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
      [req.params.owner, req.params.repo, key]
    );
    if (existing.rows[0] && existing.rows[0].active) {
      if (ALPHA_CONFIG.enabled && existing.rows[0].provider_hook_id) {
        const resourceKeyHash = providerResourceKeyHash({
          provider: 'github',
          authority: providerAuthority(req.gh),
          resourceType: 'provider-webhook',
          resourceReference: existing.rows[0].provider_hook_id
        });
        if (!existing.rows[0].alpha_resource_key_hash) {
          await pool().query(
            'UPDATE nv_webhooks SET alpha_resource_key_hash=$1,updated_at=now() WHERE hook_id=$2',
            [resourceKeyHash, existing.rows[0].hook_id]
          );
        }
        await alphaPrivacyStore.claimProviderWebhookOwnership({
          testerId: req.alpha.testerId,
          identityKey: key,
          provider: 'github',
          resourceKeyHash
        });
      }
      return res.status(409).json({ error: 'Verified live events are already connected for this repository' });
    }
    if (existing.rows[0] && !existing.rows[0].active) await pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [existing.rows[0].hook_id]);
    const hookId = crypto.randomBytes(24).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const callback = `${publicBase(req)}/hooks/github/${hookId}`;
    await pool().query(
      `INSERT INTO nv_webhooks(hook_id,provider,owner,repo,identity_key,secret_enc,active)
       VALUES($1,'github',$2,$3,$4,$5,true)
       ON CONFLICT(provider,owner,repo,identity_key) DO UPDATE SET hook_id=EXCLUDED.hook_id,secret_enc=EXCLUDED.secret_enc,active=true,provider_hook_id=NULL,updated_at=now()`,
      [hookId, String(req.params.owner).toLowerCase(), String(req.params.repo).toLowerCase(), key, seal({ secret })]
    );
    let providerHookId = null;
    try {
      const hook = await gh(req.gh, `${R(req)}/hooks`, {
        method: 'POST',
        body: {
          name: 'web', active: true,
          events: ['push', 'pull_request', 'workflow_run', 'issues', 'release', 'create', 'delete', 'deployment', 'deployment_status', 'repository_vulnerability_alert'],
          config: { url: callback, content_type: 'json', insecure_ssl: '0', secret }
        }
      });
      providerHookId = hook.id;
      const alphaResourceKeyHash = ALPHA_CONFIG.enabled
        ? providerResourceKeyHash({
            provider: 'github',
            authority: providerAuthority(req.gh),
            resourceType: 'provider-webhook',
            resourceReference: providerHookId
          })
        : null;
      await pool().query(
        `UPDATE nv_webhooks
            SET provider_hook_id=$1,alpha_resource_key_hash=$2,updated_at=now()
          WHERE hook_id=$3`,
        [providerHookId, alphaResourceKeyHash, hookId]
      );
      if (ALPHA_CONFIG.enabled) {
        await alphaPrivacyStore.claimProviderWebhookOwnership({
          testerId: req.alpha.testerId,
          identityKey: key,
          provider: 'github',
          resourceKeyHash: alphaResourceKeyHash
        });
      }
      await appendEvidence(scopedEvidenceKey('github', req.params.owner, req.params.repo, key), 'live-events-connected', hookId, {
        repository: `${req.params.owner}/${req.params.repo}`, actor: retainedActor(req), connectedAt: new Date().toISOString()
      }).catch(error => console.error('Evidence append failed after webhook connection:', error.message));
      res.status(201).json({ available: true, connected: true });
    } catch (error) {
      await removeOrphanedProviderHook(req.gh, req, providerHookId);
      await pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [hookId]).catch(() => {});
      if (error.status === 403 || error.status === 404) {
        error.message = 'GitHub refused webhook creation. The token needs repository Webhooks: write permission and repository administration access.';
      }
      throw error;
    }
  } catch (e) { fail(res, e); }
});

app.delete('/api/repo/:owner/:repo/live-events', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events', { allowExperimental: true }), auth, mutationContext('webhook.disconnect'), async (req, res) => {
  try {
    if (!(await dbReady())) return res.status(503).json({ error: 'Live event storage is unavailable' });
    const key = identityKey(req.gh);
    const r = await pool().query(
      `SELECT hook_id,provider_hook_id,alpha_resource_key_hash FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
      [req.params.owner, req.params.repo, key]
    );
    const row = r.rows[0];
    if (!row) return res.json({ ok: true, disconnected: false });
    let evidenceSubject = row.hook_id;
    if (ALPHA_CONFIG.enabled) {
      const pending = cleanupId => res.status(202).json({
        ok: false,
        status: 'pending',
        ...(cleanupId ? { cleanupId } : {})
      });
      const resourceKeyHash = providerResourceKeyHash({
        provider: 'github',
        authority: providerAuthority(req.gh),
        resourceType: 'provider-webhook',
        resourceReference: row.provider_hook_id ?? row.hook_id
      });
      const storedResourceKeyHash = String(row.alpha_resource_key_hash || '');
      if (storedResourceKeyHash && storedResourceKeyHash !== resourceKeyHash) {
        return pending('');
      }
      if (!storedResourceKeyHash) {
        try {
          const backfill = await pool().query(
            `UPDATE nv_webhooks
                SET alpha_resource_key_hash=$1,updated_at=now()
              WHERE hook_id=$2 AND alpha_resource_key_hash IS NULL
              RETURNING alpha_resource_key_hash`,
            [resourceKeyHash, row.hook_id]
          );
          if (backfill.rows.length !== 1
              || backfill.rows[0].alpha_resource_key_hash !== resourceKeyHash) {
            return pending('');
          }
        } catch {
          return pending('');
        }
      }
      let cleanupTask;
      try {
        cleanupTask = await alphaPrivacyStore.createCleanupTask({
          testerId: req.alpha.testerId,
          identityKey: key,
          provider: 'github',
          resourceType: 'provider-webhook',
          resourceKeyHash,
          reasonCode: ''
        });
      } catch {
        return pending('');
      }
      let inspection;
      try {
        inspection = await alphaPrivacyStore.inspectProviderWebhookCleanup({
          testerId: req.alpha.testerId,
          identityKey: key,
          provider: 'github',
          cleanupId: cleanupTask.cleanupId,
          resourceKeyHash
        });
      } catch {
        return pending(cleanupTask.cleanupId);
      }
      let verifiedAbsent = false;
      if (!inspection.verified && !inspection.shared && row.provider_hook_id) {
        try {
          await gh(req.gh, `${R(req)}/hooks/${row.provider_hook_id}`, { method: 'DELETE' });
        } catch (error) {
          if (error.status === 404) verifiedAbsent = true;
          else return pending(cleanupTask.cleanupId);
        }
        if (!verifiedAbsent) {
          try {
            await gh(req.gh, `${R(req)}/hooks/${row.provider_hook_id}`);
          } catch (error) {
            if (error.status === 404) verifiedAbsent = true;
            else return pending(cleanupTask.cleanupId);
          }
        }
        if (!verifiedAbsent) {
          return pending(cleanupTask.cleanupId);
        }
      }
      let completion;
      try {
        completion = await alphaPrivacyStore.completeProviderWebhookCleanup({
          testerId: req.alpha.testerId,
          identityKey: key,
          provider: 'github',
          cleanupId: cleanupTask.cleanupId,
          resourceKeyHash,
          providerVerifiedAbsent: verifiedAbsent
        });
      } catch {
        return pending(cleanupTask.cleanupId);
      }
      if (!completion.verified) {
        return pending(cleanupTask.cleanupId);
      }
      evidenceSubject = resourceKeyHash;
    } else {
      if (row.provider_hook_id) {
        try { await gh(req.gh, `${R(req)}/hooks/${row.provider_hook_id}`, { method: 'DELETE' }); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      await pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [row.hook_id]);
    }
    await appendEvidence(scopedEvidenceKey('github', req.params.owner, req.params.repo, key), 'live-events-disconnected', evidenceSubject, {
      actor: retainedActor(req), disconnectedAt: new Date().toISOString()
    }).catch(() => {});
    res.json({ ok: true, disconnected: true });
  } catch (e) { fail(res, e); }
});

app.get('/api/repo/:owner/:repo/intelligence/events', providerSessionAccess, alphaRepositoryAccess, auth, async (req, res) => {
  try {
    if (!(await dbReady())) return res.json({ available: false, events: [], hasMore: false, truncatedBefore: false, cursor: '' });
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500);
    const after = decodeEventCursor(req.query.after);
    const values = [req.gh.provider || 'github', req.params.owner, req.params.repo, identityKey(req.gh), limit + 1];
    let where = 'provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4';
    if (after) {
      values.push(after.createdAt, after.eventId);
      where += ` AND (created_at > $${values.length - 1} OR (created_at = $${values.length - 1} AND event_id > $${values.length}))`;
    }
    const order = after ? 'ASC' : 'DESC';
    const r = await pool().query(
      `SELECT event_id,event_type,action,actor,target_type,target_id,ref,before_sha,after_sha,severity,risk_score,reasons,summary,paths,metadata,delivery_id,created_at
       FROM nv_intelligence_events WHERE ${where} ORDER BY created_at ${order}, event_id ${order} LIMIT $5`, values
    );
    const hasMore = !!after && r.rows.length > limit;
    const truncatedBefore = !after && r.rows.length > limit;
    let rows = r.rows.slice(0, limit);
    if (!after) rows = rows.reverse();
    const events = rows.map(row => ({
      id: row.event_id, eventType: row.event_type, action: row.action, actor: row.actor,
      targetType: row.target_type, targetId: row.target_id, ref: row.ref, beforeSha: row.before_sha,
      afterSha: row.after_sha, severity: row.severity, score: row.risk_score, reasons: row.reasons || [],
      summary: row.summary, paths: row.paths || [], metadata: row.metadata || {}, deliveryId: row.delivery_id, createdAt: row.created_at
    }));
    const lastRow = rows[rows.length - 1];
    res.json({ available: true, events, hasMore, truncatedBefore, cursor: lastRow ? encodeEventCursor(lastRow.created_at, lastRow.event_id) : String(req.query.after || '') });
  } catch (e) { fail(res, e); }
});

app.get('/api/repo/:owner/:repo/live-events/stream', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events', { allowExperimental: true }), auth, async (req, res) => {
  const key = liveStreamKey(req.gh.provider || 'github', req.params.owner, req.params.repo, identityKey(req.gh));
  const scopedClients = LIVE_CLIENTS.get(key);
  if (!canAcceptLiveClient(liveClientCount(), scopedClients ? scopedClients.size : 0, MAX_LIVE_CLIENTS_TOTAL, MAX_LIVE_CLIENTS_PER_KEY)) {
    return res.status(429).json({ error: 'Too many live event streams are open. Close another Neural tab and retry.' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.nvSessionSid = sessionSidFromRequest(req);
  res[ALPHA_SESSION_ID] = req[ALPHA_SESSION_ID];
  res.write(`event: ready
data: ${JSON.stringify({ repository: `${req.params.owner}/${req.params.repo}`, at: new Date().toISOString() })}

`);
  if (!LIVE_CLIENTS.has(key)) LIVE_CLIENTS.set(key, new Set());
  LIVE_CLIENTS.get(key).add(res);
  let keepAliveTicks = 0;
  let sessionCheckBusy = false;
  const keepAlive = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}

`); } catch {}
    keepAliveTicks += 1;
    /* revocation check runs every 20th tick (~5 min), not every minute: a 60s poll would
       keep a free-tier Neon compute instance from ever auto-suspending. */
    if (keepAliveTicks % 20 !== 0 || sessionCheckBusy) return;
    const checks = [];
    if (res.nvSessionSid && DB_URL) {
      checks.push(
        pool().query('SELECT 1 FROM nv_sessions WHERE sid=$1', [res.nvSessionSid])
          .then(result => {
            if (!result.rowCount) {
              closeLiveSessions([res.nvSessionSid], 'session-revoked');
            }
          })
          .catch(() => {})
      );
    }
    if (ALPHA_CONFIG.enabled) {
      checks.push(
        alphaStore.readSession(res[ALPHA_SESSION_ID], { touch: false })
          .catch(() => closeAlphaLiveSession(key, res))
      );
    }
    if (!checks.length) return;
    sessionCheckBusy = true;
    Promise.all(checks)
      .finally(() => { sessionCheckBusy = false; });
  }, 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    const set = LIVE_CLIENTS.get(key);
    if (set) { set.delete(res); if (!set.size) LIVE_CLIENTS.delete(key); }
  });
});

app.get('/api/repo/:owner/:repo/evidence', providerSessionAccess, alphaRepositoryAccess, auth, async (req, res) => {
  try {
    const identity = identityKey(req.gh);
    const key = scopedEvidenceKey(req.gh.provider || 'github', req.params.owner, req.params.repo, identity);
    const chain = await verifyEvidenceChain(key, 5000);
    if (!(await dbReady())) return res.json({ available: false, chain, events: [], snapshots: [] });
    const [events, snapshots] = await Promise.all([
      pool().query(
        `SELECT event_id,event_type,actor,severity,risk_score,summary,reasons,created_at FROM nv_intelligence_events
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4 ORDER BY created_at DESC LIMIT 500`,
        [req.gh.provider || 'github', req.params.owner, req.params.repo, identity]
      ),
      pool().query(
        `SELECT snapshot_id,signature,created_at,snapshot FROM nv_recovery_snapshots
         WHERE provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4 ORDER BY created_at DESC LIMIT 50`,
        [req.gh.provider || 'github', req.params.owner, req.params.repo, identity]
      )
    ]);
    const evidenceRecords = chain.records || [];
    const chainSummary = { ...chain };
    delete chainSummary.records;
    res.json({
      kind: 'nebulaverse-evidence', version: 1, generatedAt: new Date().toISOString(),
      repository: `${req.params.owner}/${req.params.repo}`, chain: chainSummary,
      records: evidenceRecords,
      events: events.rows,
      snapshots: snapshots.rows.map(row => {
        const verification = SNAPSHOT_SIGNATURES.verify(row.signature, row.snapshot_id, row.snapshot);
        return {
          ...row,
          signature_valid: verification.valid,
          signature_key_id: verification.keyId,
          signature_legacy: verification.legacy
        };
      })
    });
  } catch (e) { fail(res, e); }
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
app.get('/api/security/sessions', auth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const inv = await sessionsForIdentity(req);
    if (!inv.available) return res.json({ available: false, login: req.gh.login, sessions: [{ current: true, updated: new Date().toISOString(), provider: req.gh.provider || 'github' }] });
    res.json({
      available: true, login: inv.login,
      sessions: inv.rows.map(r => ({ current: r.current, updated: r.updated, provider: r.provider }))
    });
  } catch (e) { fail(res, e); }
});
app.post('/api/security/revoke-others', auth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!(req.body && req.body.confirm)) return res.status(400).json({ error: 'Confirmation required' });
    const inv = await sessionsForIdentity(req);
    if (!inv.available) return res.json({ available: false, login: req.gh.login, revoked: 0 });
    const ids = await revokeContainedSessions(
      req,
      inv.rows.filter(r => !r.current).map(r => r.sid)
    );
    const streamsClosed = closeLiveSessions(ids, 'session-revoked');
    res.json({ available: true, login: inv.login, revoked: ids.length, streamsClosed });
  } catch (e) { fail(res, e); }
});

/*
 * Identity, not a version number.
 *
 * This route is deliberately readable before an invitation -- the hosted
 * alpha.17 validator and the operator checklist both probe it anonymously --
 * so whatever it says is said to everyone. releaseTreeSha256 is what those
 * callers actually read: ci/run-hosted-alpha17-validation.js takes the
 * fingerprint and nothing else, and the qualification manual records it at
 * the start and end of a run. It names the build exactly without publishing
 * the semantic version, which is the half an attacker can line up against a
 * list of known vulnerabilities.
 *
 * The version itself is not secret and is not being hidden from the people
 * running the alpha: it travels on /api/me, behind a session, and Settings
 * shows it to the tester who needs to quote it in a report.
 */
app.get('/api/version', (req, res) => res.json({
  product: PRODUCT_NAME,
  releaseTreeSha256: RELEASE_TREE_SHA256
}));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderReleaseTemplate(INDEX_TEMPLATE));
});
startTempMaintenance();
const httpServer = app.listen(PORT, () => console.log(`${PRODUCT_NAME} v${APP_VERSION} orbiting on :${PORT}`));
let shuttingDown = false;
void bootstrapGovernanceDelivery();
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal }));
  for (const clients of LIVE_CLIENTS.values()) {
    for (const client of clients) {
      try { client.write(`event: shutdown\ndata: ${JSON.stringify({ signal, at: new Date().toISOString() })}\n\n`); } catch {}
      try { client.end(); } catch {}
    }
  }
  LIVE_CLIENTS.clear();
  if (governanceWebhookBootstrapTimer) clearTimeout(governanceWebhookBootstrapTimer);
  if (governanceWebhookWorker) governanceWebhookWorker.stop();
  const force = setTimeout(() => process.exit(1), 10000);
  if (typeof force.unref === 'function') force.unref();
  httpServer.close(async () => {
    try { if (_pool) await _pool.end(); } catch {}
    clearTimeout(force);
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
