/*
 * The server's settings, read from the environment once at startup.
 *
 * Two readings, because the server reads them in two places and a
 * misconfigured deployment is told about the first thing wrong: the secrets
 * and the keys derived from them first (after the trusted proxies, which the
 * server sets on the application before anything else), then, after Corona
 * has read its evidence keyrings and snapshot signing keys, everything else.
 * Each check runs in the order it always has, and throws the message it
 * always has.
 *
 * Every keyed construction derives its own key from SESSION_SECRET through a
 * distinct HKDF purpose (see ../crypto/key-derivation.ts for why the previous
 * shared key was a hazard even though nothing was exploitable). The limits a
 * hosted alpha publishes win over the local variables, which are clamped to
 * the ranges the server can honour.
 */
import { deriveKey, deriveSecret, KEY_PURPOSES } from '../crypto/key-derivation.ts';
import {
  loadAlphaAccessConfig, loadGithubAppConfig, loadHostedAlphaLimits, normalizeDatabaseUrl, normalizeGovernanceRuntimeFailureMode
} from './config.ts';
import type { HostedAlphaLimits } from '../persistence/hosted-readiness.ts';

type Environment = Readonly<Record<string, string | undefined>>;

const DEVELOPMENT_SECRET = 'dev-secret-change-me';

export interface ServerSecrets {
  readonly port: string | number;
  readonly secret: string;
  readonly hostingProfile: 'local' | 'hosted-alpha';
  readonly databaseMigrationMode: 'apply' | 'verify';
  readonly keys: {
    readonly sessionContent: Buffer;
    readonly offlineCacheScope: Buffer;
    readonly githubAppStateReplay: Buffer;
    readonly csrf: string;
    readonly stepUp: string;
    readonly githubAppState: string;
    readonly evidenceLedger: string;
    readonly rateLimitIdentity: Buffer;
    /*
     * Derived once at startup, like every other key here, so a finding's
     * identity does not depend on when it was computed. It is also why a scan
     * records the key version: rotating SESSION_SECRET changes every
     * fingerprint, and the store refuses to compare across that rather than
     * reporting the entire backlog resolved.
     */
    readonly exposureFingerprint: Buffer;
    /*
     * The grant a verification probe requires, and the key that digests the
     * provider account it comes back with. Separate purposes because one is a
     * MAC over a grant this server issued and the other a MAC over a value a
     * provider told us.
     */
    readonly exposureVerification: Buffer;
    readonly exposureVerificationSubject: Buffer;
    /*
     * And the grant a readability probe requires, which is a third purpose
     * rather than a reuse of the second. A grant to ask a provider "is this
     * credential yours" is not a grant to ask a project "may the public read
     * this table", and a shared key would make one signature satisfy both
     * checks.
     */
    readonly exposureReadability: Buffer;
  };
}

/* A local variable's whole number, defaulted and clamped, as `Math.min(Math.max(parseInt(v || d, 10) || d, lo), hi)`. */
function clamped(raw: string | undefined, fallback: number, low: number, high: number): number {
  return Math.min(Math.max(parseInt(raw || String(fallback), 10) || fallback, low), high);
}

export function loadServerSecrets(env: Environment): ServerSecrets {
  const production = env.NODE_ENV === 'production';
  const port = env.PORT || 10000;
  const secret = env.SESSION_SECRET || DEVELOPMENT_SECRET;
  const hostingProfile = String(env.NV_DEPLOYMENT_PROFILE || 'local').trim().toLowerCase();
  if (hostingProfile !== 'local' && hostingProfile !== 'hosted-alpha') {
    throw new Error('NV_DEPLOYMENT_PROFILE must be local or hosted-alpha');
  }
  const databaseMigrationMode = String(env.NV_DATABASE_MIGRATION_MODE || 'apply').trim().toLowerCase();
  if (databaseMigrationMode !== 'apply' && databaseMigrationMode !== 'verify') {
    throw new Error('NV_DATABASE_MIGRATION_MODE must be apply or verify');
  }
  if (hostingProfile === 'hosted-alpha' && production && databaseMigrationMode !== 'verify') {
    throw new Error('hosted-alpha production requires NV_DATABASE_MIGRATION_MODE=verify');
  }
  if (production && secret === DEVELOPMENT_SECRET) {
    throw new Error(
      'SESSION_SECRET must be configured in production. Set it in the Render dashboard under Environment, ' +
      'or let render.yaml generate one automatically.'
    );
  }
  if (production && Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(
      'SESSION_SECRET must contain at least 32 bytes in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" ' +
      'then set it in the Render dashboard under Environment.'
    );
  }
  return Object.freeze({
    port, secret, hostingProfile, databaseMigrationMode,
    keys: Object.freeze({
      sessionContent: deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT),
      offlineCacheScope: deriveKey(secret, KEY_PURPOSES.OFFLINE_CACHE_SCOPE),
      githubAppStateReplay: deriveKey(secret, KEY_PURPOSES.GITHUB_APP_STATE_REPLAY),
      csrf: deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN),
      stepUp: deriveSecret(secret, KEY_PURPOSES.STEP_UP_GRANT),
      githubAppState: deriveSecret(secret, KEY_PURPOSES.GITHUB_APP_STATE),
      evidenceLedger: deriveSecret(secret, KEY_PURPOSES.EVIDENCE_LEDGER),
      rateLimitIdentity: deriveKey(secret, KEY_PURPOSES.RATE_LIMIT_IDENTITY),
      exposureFingerprint: deriveKey(secret, KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT),
      exposureVerification: deriveKey(secret, KEY_PURPOSES.EXPOSURE_VERIFICATION_AUTHORIZATION),
      exposureVerificationSubject: deriveKey(secret, KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT),
      exposureReadability: deriveKey(secret, KEY_PURPOSES.EXPOSURE_READABILITY_AUTHORIZATION)
    })
  });
}

export interface ServerSettings {
  readonly githubApp: ReturnType<typeof loadGithubAppConfig>;
  readonly governanceRuntimeFailureMode: 'warn' | 'block';
  /* The hosted alpha's published limits, or none locally; the limits a page shows either way. */
  readonly hostedLimits: HostedAlphaLimits | null;
  readonly publicAlphaLimits: HostedAlphaLimits;
  readonly gitDataMaxMb: number;
  readonly nativePushMaxMb: number;
  readonly uploadMaxMb: number;
  readonly uploadConcurrency: number;
  readonly uploadTimeoutMinutes: number;
  readonly staleUploadHours: number;
  readonly databaseUrl: string;
  readonly alphaAccess: ReturnType<typeof loadAlphaAccessConfig>;
  readonly eventRetentionDays: number;
  readonly sessionRetentionDays: number;
  /* The governance audit's own key, from its own secret when one is configured. */
  readonly governanceAuditSecret: string;
  readonly liveClientsPerRepo: number;
  readonly liveClientsTotal: number;
  readonly oauth: { readonly clientId: string; readonly clientSecret: string };
  readonly snapshotManifestMax: number;
  readonly snapshotRetentionCount: number;
}

export function loadServerSettings(env: Environment, secrets: Pick<ServerSecrets, 'secret' | 'hostingProfile'>): ServerSettings {
  const production = env.NODE_ENV === 'production';
  const githubApp = loadGithubAppConfig(env, { production });
  const governanceRuntimeFailureMode = normalizeGovernanceRuntimeFailureMode(env.NV_GOVERNANCE_RUNTIME_FAILURE_MODE);
  const hostedLimits = secrets.hostingProfile === 'hosted-alpha' ? loadHostedAlphaLimits(env) : null;
  const publicAlphaLimits = hostedLimits || loadHostedAlphaLimits({});
  const gitDataMaxMb = hostedLimits?.gitDataMaxMb ?? clamped(env.NV_GIT_DATA_MAX_MB, 64, 10, 95);
  const nativePushMaxMb = hostedLimits?.nativePushMaxMb ?? clamped(env.NV_NATIVE_PUSH_MAX_MB, 64, 10, 95);
  const uploadMaxMb = hostedLimits?.uploadMaxMb ?? clamped(env.NV_UPLOAD_MAX_MB, 2048, 25, 2048);
  const uploadConcurrency = hostedLimits?.uploadConcurrency ?? clamped(env.NV_UPLOAD_CONCURRENCY, 1, 1, 4);
  const uploadTimeoutMinutes = hostedLimits?.uploadTimeoutMinutes ?? clamped(env.NV_UPLOAD_TIMEOUT_MINUTES, 20, 2, 60);
  const staleUploadHours = hostedLimits?.staleUploadHours ?? clamped(env.NV_STALE_UPLOAD_HOURS, 6, 1, 72);
  const databaseUrl = normalizeDatabaseUrl(env.DATABASE_URL || '', { production, insecure: env.NV_DB_INSECURE === '1' });
  const alphaAccess = loadAlphaAccessConfig(env, { databaseUrl });
  const eventRetentionDays = hostedLimits?.eventRetentionDays ?? clamped(env.NV_EVENT_RETENTION_DAYS, 90, 7, 730);
  const sessionRetentionDays = hostedLimits?.sessionRetentionDays ?? clamped(env.NV_SESSION_RETENTION_DAYS, 35, 7, 365);
  const auditSecret = env.NV_GOVERNANCE_AUDIT_SECRET;
  if (production && auditSecret && Buffer.byteLength(auditSecret, 'utf8') < 32) {
    throw new Error('NV_GOVERNANCE_AUDIT_SECRET must contain at least 32 bytes in production when configured.');
  }
  const governanceAuditSecret = deriveKey(auditSecret || secrets.secret, KEY_PURPOSES.GOVERNANCE_AUDIT).toString('hex');
  return Object.freeze({
    githubApp, governanceRuntimeFailureMode, hostedLimits, publicAlphaLimits,
    gitDataMaxMb, nativePushMaxMb, uploadMaxMb, uploadConcurrency, uploadTimeoutMinutes, staleUploadHours,
    databaseUrl, alphaAccess, eventRetentionDays, sessionRetentionDays, governanceAuditSecret,
    liveClientsPerRepo: hostedLimits?.liveClientsPerRepo ?? clamped(env.NV_LIVE_CLIENTS_PER_REPO, 5, 1, 20),
    liveClientsTotal: hostedLimits?.liveClientsTotal ?? clamped(env.NV_LIVE_CLIENTS_TOTAL, 100, 10, 500),
    oauth: Object.freeze({ clientId: (env.GITHUB_CLIENT_ID || '').trim(), clientSecret: (env.GITHUB_CLIENT_SECRET || '').trim() }),
    snapshotManifestMax: hostedLimits?.snapshotManifestMax ?? clamped(env.NV_SNAPSHOT_MANIFEST_MAX, 10000, 1000, 50000),
    snapshotRetentionCount: hostedLimits?.snapshotRetentionCount ?? clamped(env.NV_SNAPSHOT_RETENTION_COUNT, 50, 5, 200)
  });
}
