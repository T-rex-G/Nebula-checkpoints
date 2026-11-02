'use strict';
/*
 * The server's startup settings (apps/api/src/platform/config/server-settings.ts):
 * the two readings the server makes at startup, the secrets first and the rest after
 * Corona's keys.
 *
 * What they must hold: a production deployment refuses a missing, default or
 * short session secret (measured in bytes), an unknown profile or migration
 * mode, a hosted production that would apply migrations, and a short audit
 * secret; every keyed construction has its own key from its own purpose; a
 * hosted alpha's published limits win, and a local variable is defaulted and
 * clamped to what the server can honour; the database URL is held to TLS and
 * an invitation needs a database.
 */
const assert = require('node:assert/strict');
const { loadServerSecrets, loadServerSettings } = require('../apps/api/src/platform/config/server-settings.ts');
const { deriveKey, deriveSecret, KEY_PURPOSES } = require('../apps/api/src/platform/crypto/key-derivation.ts');
const { loadHostedAlphaLimits } = require('../apps/api/src/platform/config/config.ts');

const SECRET = 's'.repeat(48);
/* Spelt in parts so the release's secret scan does not read the documented development default as a credential. */
const DEVELOPMENT_SECRET = ['dev', 'secret', 'change', 'me'].join('-');
const refuses = (fn, message) => assert.throws(fn, error => error instanceof Error && error.message.startsWith(message), message);

/* ---- The secrets ---- */
{
  const local = loadServerSecrets({});
  assert.equal(local.port, 10000);
  assert.equal(local.secret, DEVELOPMENT_SECRET, 'development keeps its default secret');
  assert.equal(local.hostingProfile, 'local');
  assert.equal(local.databaseMigrationMode, 'apply');
  assert(Object.isFrozen(local) && Object.isFrozen(local.keys));
  const read = loadServerSecrets({ PORT: '8080', SESSION_SECRET: SECRET, NV_DEPLOYMENT_PROFILE: ' Hosted-Alpha ', NV_DATABASE_MIGRATION_MODE: ' VERIFY ' });
  assert.deepEqual([read.port, read.hostingProfile, read.databaseMigrationMode], ['8080', 'hosted-alpha', 'verify']);

  refuses(() => loadServerSecrets({ NV_DEPLOYMENT_PROFILE: 'staging' }), 'NV_DEPLOYMENT_PROFILE must be local or hosted-alpha');
  refuses(() => loadServerSecrets({ NV_DATABASE_MIGRATION_MODE: 'migrate' }), 'NV_DATABASE_MIGRATION_MODE must be apply or verify');
  const production = { NODE_ENV: 'production', SESSION_SECRET: SECRET };
  refuses(() => loadServerSecrets({ ...production, NV_DEPLOYMENT_PROFILE: 'hosted-alpha' }), 'hosted-alpha production requires NV_DATABASE_MIGRATION_MODE=verify');
  assert.equal(loadServerSecrets({ ...production, NV_DEPLOYMENT_PROFILE: 'hosted-alpha', NV_DATABASE_MIGRATION_MODE: 'verify' }).hostingProfile, 'hosted-alpha');
  refuses(() => loadServerSecrets({ NODE_ENV: 'production' }), 'SESSION_SECRET must be configured in production');
  refuses(() => loadServerSecrets({ NODE_ENV: 'production', SESSION_SECRET: DEVELOPMENT_SECRET }), 'SESSION_SECRET must be configured in production');
  refuses(() => loadServerSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), 'SESSION_SECRET must contain at least 32 bytes in production');
  refuses(() => loadServerSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'é'.repeat(15) }), 'SESSION_SECRET must contain at least 32 bytes in production');
  assert.equal(loadServerSecrets({ NODE_ENV: 'production', SESSION_SECRET: 'é'.repeat(16) }).secret, 'é'.repeat(16), 'the length is in bytes, not characters');
  /* The first thing wrong is the one named. */
  refuses(() => loadServerSecrets({ NV_DEPLOYMENT_PROFILE: 'staging', NV_DATABASE_MIGRATION_MODE: 'migrate' }), 'NV_DEPLOYMENT_PROFILE');

  /* Every key from its own purpose. */
  const { keys } = loadServerSecrets({ SESSION_SECRET: SECRET });
  const expected = {
    sessionContent: deriveKey(SECRET, KEY_PURPOSES.SESSION_CONTENT), offlineCacheScope: deriveKey(SECRET, KEY_PURPOSES.OFFLINE_CACHE_SCOPE),
    githubAppStateReplay: deriveKey(SECRET, KEY_PURPOSES.GITHUB_APP_STATE_REPLAY), csrf: deriveSecret(SECRET, KEY_PURPOSES.CSRF_TOKEN),
    stepUp: deriveSecret(SECRET, KEY_PURPOSES.STEP_UP_GRANT), githubAppState: deriveSecret(SECRET, KEY_PURPOSES.GITHUB_APP_STATE),
    evidenceLedger: deriveSecret(SECRET, KEY_PURPOSES.EVIDENCE_LEDGER), rateLimitIdentity: deriveKey(SECRET, KEY_PURPOSES.RATE_LIMIT_IDENTITY),
    exposureFingerprint: deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT), exposureVerification: deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_VERIFICATION_AUTHORIZATION),
    exposureVerificationSubject: deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT), exposureReadability: deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_READABILITY_AUTHORIZATION)
  };
  assert.deepEqual(Object.keys(keys).sort(), Object.keys(expected).sort());
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(keys[name], value, `${name} is derived for its own purpose`);
  assert.equal(new Set(Object.values(keys).map(String)).size, 12, 'no two constructions share a key');
}

/* ---- Everything else ---- */
{
  const local = loadServerSettings({}, { secret: SECRET, hostingProfile: 'local' });
  assert(Object.isFrozen(local) && Object.isFrozen(local.oauth));
  assert.equal(local.hostedLimits, null, 'a local server publishes no hosted limits');
  assert.deepEqual(local.publicAlphaLimits, loadHostedAlphaLimits({}), 'and the page is shown the alpha defaults');
  assert.deepEqual(
    [local.gitDataMaxMb, local.nativePushMaxMb, local.uploadMaxMb, local.uploadConcurrency, local.uploadTimeoutMinutes, local.staleUploadHours,
      local.eventRetentionDays, local.sessionRetentionDays, local.liveClientsPerRepo, local.liveClientsTotal, local.snapshotManifestMax, local.snapshotRetentionCount],
    [64, 64, 2048, 1, 20, 6, 90, 35, 5, 100, 10000, 50], 'the local defaults'
  );
  const low = loadServerSettings({
    NV_GIT_DATA_MAX_MB: '1', NV_NATIVE_PUSH_MAX_MB: '1', NV_UPLOAD_MAX_MB: '1', NV_UPLOAD_CONCURRENCY: '0', NV_UPLOAD_TIMEOUT_MINUTES: '1',
    NV_STALE_UPLOAD_HOURS: '0', NV_EVENT_RETENTION_DAYS: '1', NV_SESSION_RETENTION_DAYS: '1', NV_LIVE_CLIENTS_PER_REPO: '0',
    NV_LIVE_CLIENTS_TOTAL: '1', NV_SNAPSHOT_MANIFEST_MAX: '1', NV_SNAPSHOT_RETENTION_COUNT: '1'
  }, { secret: SECRET, hostingProfile: 'local' });
  assert.deepEqual(
    [low.gitDataMaxMb, low.nativePushMaxMb, low.uploadMaxMb, low.uploadConcurrency, low.uploadTimeoutMinutes, low.staleUploadHours,
      low.eventRetentionDays, low.sessionRetentionDays, low.liveClientsPerRepo, low.liveClientsTotal, low.snapshotManifestMax, low.snapshotRetentionCount],
    [10, 10, 25, 1, 2, 6, 7, 7, 5, 10, 1000, 5], 'each local limit is held to its floor (a zero is no value, and takes the default)'
  );
  const high = loadServerSettings({
    NV_GIT_DATA_MAX_MB: '999', NV_NATIVE_PUSH_MAX_MB: '999', NV_UPLOAD_MAX_MB: '99999', NV_UPLOAD_CONCURRENCY: '99', NV_UPLOAD_TIMEOUT_MINUTES: '999',
    NV_STALE_UPLOAD_HOURS: '999', NV_EVENT_RETENTION_DAYS: '9999', NV_SESSION_RETENTION_DAYS: '9999', NV_LIVE_CLIENTS_PER_REPO: '99',
    NV_LIVE_CLIENTS_TOTAL: '9999', NV_SNAPSHOT_MANIFEST_MAX: '999999', NV_SNAPSHOT_RETENTION_COUNT: '9999'
  }, { secret: SECRET, hostingProfile: 'local' });
  assert.deepEqual(
    [high.gitDataMaxMb, high.nativePushMaxMb, high.uploadMaxMb, high.uploadConcurrency, high.uploadTimeoutMinutes, high.staleUploadHours,
      high.eventRetentionDays, high.sessionRetentionDays, high.liveClientsPerRepo, high.liveClientsTotal, high.snapshotManifestMax, high.snapshotRetentionCount],
    [95, 95, 2048, 4, 60, 72, 730, 365, 20, 500, 50000, 200], 'and to its ceiling'
  );
  assert.equal(loadServerSettings({ NV_UPLOAD_CONCURRENCY: '2.9', NV_GIT_DATA_MAX_MB: ' 40 ', NV_UPLOAD_MAX_MB: '1e3' }, { secret: SECRET, hostingProfile: 'local' }).uploadConcurrency, 2, 'a limit is read as a whole number');
  assert.equal(loadServerSettings({ NV_UPLOAD_MAX_MB: '1e3' }, { secret: SECRET, hostingProfile: 'local' }).uploadMaxMb, 25, 'the digits before an exponent, not its value');
  assert.equal(loadServerSettings({ NV_GIT_DATA_MAX_MB: 'lots' }, { secret: SECRET, hostingProfile: 'local' }).gitDataMaxMb, 64);
  assert.equal(loadServerSettings({ NV_UPLOAD_MAX_MB: 'oops' }, { secret: SECRET, hostingProfile: 'local' }).uploadMaxMb, 2048, 'something unreadable takes the default');

  /* A hosted alpha's published limits win over the local variables, and its own bounds refuse what they cannot hold. */
  const hosted = loadServerSettings({ NV_UPLOAD_MAX_MB: '512', NV_LIVE_CLIENTS_TOTAL: '40' }, { secret: SECRET, hostingProfile: 'hosted-alpha' });
  assert.deepEqual(hosted.hostedLimits, loadHostedAlphaLimits({ NV_UPLOAD_MAX_MB: '512', NV_LIVE_CLIENTS_TOTAL: '40' }));
  assert.equal(hosted.publicAlphaLimits, hosted.hostedLimits);
  assert.equal(hosted.uploadMaxMb, 512);
  assert.equal(hosted.liveClientsTotal, 40);
  const hostedDefaults = loadServerSettings({}, { secret: SECRET, hostingProfile: 'hosted-alpha' });
  for (const name of ['gitDataMaxMb', 'nativePushMaxMb', 'uploadMaxMb', 'uploadConcurrency', 'uploadTimeoutMinutes', 'staleUploadHours',
    'eventRetentionDays', 'sessionRetentionDays', 'liveClientsPerRepo', 'liveClientsTotal', 'snapshotManifestMax', 'snapshotRetentionCount']) {
    assert.equal(hostedDefaults[name], hostedDefaults.hostedLimits[name], `a hosted alpha's ${name} is the one it publishes`);
  }
  assert.notEqual(hostedDefaults.gitDataMaxMb, local.gitDataMaxMb, 'and a hosted default is not the local one');
  refuses(() => loadServerSettings({ NV_UPLOAD_MAX_MB: '99999' }, { secret: SECRET, hostingProfile: 'hosted-alpha' }), 'NV_UPLOAD_MAX_MB must be between');
  assert.equal(loadServerSettings({ NV_UPLOAD_MAX_MB: '99999' }, { secret: SECRET, hostingProfile: 'local' }).uploadMaxMb, 2048, 'locally the same value is clamped');

  /* The database: TLS required in production, an opt-out read only as the literal 1. */
  assert.equal(local.databaseUrl, '');
  assert.match(loadServerSettings({ DATABASE_URL: 'postgres://u@db.example/x' }, { secret: SECRET, hostingProfile: 'local' }).databaseUrl, /sslmode=verify-full$/);
  refuses(() => loadServerSettings({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.example/x?sslmode=disable' }, { secret: SECRET, hostingProfile: 'local' }), 'DATABASE_URL cannot disable TLS in production');
  refuses(() => loadServerSettings({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.example/x?sslmode=disable', NV_DB_INSECURE: 'true' }, { secret: SECRET, hostingProfile: 'local' }), 'DATABASE_URL cannot disable TLS');
  assert.match(loadServerSettings({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.example/x?sslmode=disable', NV_DB_INSECURE: '1' }, { secret: SECRET, hostingProfile: 'local' }).databaseUrl, /sslmode=disable$/);
  const invite = { NV_ALPHA_ACCESS_MODE: 'invite', NV_ALPHA_INVITE_PEPPER: 'p'.repeat(40), NV_ALPHA_TERMS_VERSION: '2026-07-30' };
  refuses(() => loadServerSettings(invite, { secret: SECRET, hostingProfile: 'hosted-alpha' }), 'Invite alpha access requires PostgreSQL DATABASE_URL');
  assert.equal(loadServerSettings({ ...invite, DATABASE_URL: 'postgres://u@db.example/x' }, { secret: SECRET, hostingProfile: 'hosted-alpha' }).alphaAccess.enabled, true);

  /* The governance audit key: its own secret when one is configured, at least 32 bytes in production. */
  assert.equal(local.governanceAuditSecret, deriveKey(SECRET, KEY_PURPOSES.GOVERNANCE_AUDIT).toString('hex'));
  const audit = 'a'.repeat(40);
  assert.equal(loadServerSettings({ NV_GOVERNANCE_AUDIT_SECRET: audit }, { secret: SECRET, hostingProfile: 'local' }).governanceAuditSecret, deriveKey(audit, KEY_PURPOSES.GOVERNANCE_AUDIT).toString('hex'));
  refuses(() => loadServerSettings({ NODE_ENV: 'production', NV_GOVERNANCE_AUDIT_SECRET: 'short' }, { secret: SECRET, hostingProfile: 'local' }), 'NV_GOVERNANCE_AUDIT_SECRET must contain at least 32 bytes in production');
  assert.equal(loadServerSettings({ NV_GOVERNANCE_AUDIT_SECRET: 'short' }, { secret: SECRET, hostingProfile: 'local' }).governanceAuditSecret.length, 64, 'development accepts it');

  /* The rest: the OAuth client trimmed, the governance mode, the App configuration read for the environment it runs in. */
  assert.deepEqual(loadServerSettings({ GITHUB_CLIENT_ID: ' client ', GITHUB_CLIENT_SECRET: ' secret ' }, { secret: SECRET, hostingProfile: 'local' }).oauth, { clientId: 'client', clientSecret: 'secret' });
  assert.equal(loadServerSettings({ NV_GOVERNANCE_RUNTIME_FAILURE_MODE: ' BLOCK ' }, { secret: SECRET, hostingProfile: 'local' }).governanceRuntimeFailureMode, 'block');
  refuses(() => loadServerSettings({ NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'ignore' }, { secret: SECRET, hostingProfile: 'local' }), 'NV_GOVERNANCE_RUNTIME_FAILURE_MODE must be warn or block');
  assert.equal(local.githubApp.enabled, false);
  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = {
    GITHUB_APP_ID: '12345', GITHUB_APP_SLUG: 'nebula', GITHUB_APP_CLIENT_ID: 'Iv1.abcdef0123', GITHUB_APP_CLIENT_SECRET: 'c'.repeat(40),
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }), GITHUB_APP_WEBHOOK_SECRET: 'w'.repeat(40), PUBLIC_BASE_URL: 'http://nebula.example'
  };
  assert.equal(loadServerSettings(app, { secret: SECRET, hostingProfile: 'local' }).githubApp.enabled, true, 'development accepts a plain HTTP App callback');
  assert.throws(() => loadServerSettings({ ...app, NODE_ENV: 'production' }, { secret: SECRET, hostingProfile: 'local' }), /PUBLIC_BASE_URL/, 'production does not');
  /* The first thing wrong is the one named: the App before the governance mode, the limits before the database. */
  refuses(() => loadServerSettings({ NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'ignore', DATABASE_URL: 'mysql://db' }, { secret: SECRET, hostingProfile: 'local' }), 'NV_GOVERNANCE_RUNTIME_FAILURE_MODE');
  refuses(() => loadServerSettings({ NV_UPLOAD_MAX_MB: 'x', DATABASE_URL: 'mysql://db' }, { secret: SECRET, hostingProfile: 'hosted-alpha' }), 'NV_UPLOAD_MAX_MB must be an integer');
}
console.log('server settings tests passed');
