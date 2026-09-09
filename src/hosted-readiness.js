'use strict';

/*
 * property, environment key, hosted default, absolute maximum.
 *
 * The default and the maximum used to be one number, so a hosted deployment
 * could only ever lower a limit. Raising one -- the ordinary reason to touch
 * these at all -- killed the process at boot, and it did so on the next deploy
 * rather than when the value was set, so five consecutive deploys of unrelated
 * commits died on a setting nobody had touched that day.
 *
 * The maximum is now the same absolute bound the self-hosted path already
 * clamps to, because that is where the real constraint lives: 95 MB for a Git
 * Data blob against GitHub's 100 MB object ceiling, 2,048 MB for a streamed
 * upload, and so on. The hosted default stays conservative. An operator can
 * raise a limit to the bound the code can actually honour, and is refused
 * above it -- rather than being refused above a default they never chose.
 *
 * The minimum stays 1 for every entry. Raising it to the self-hosted minimum
 * would refuse settings that are legal today, which is a different change and
 * not one anybody asked for.
 */
const HOSTED_ALPHA_LIMITS = Object.freeze([
  ['eventRetentionDays', 'NV_EVENT_RETENTION_DAYS', 30, 730],
  ['sessionRetentionDays', 'NV_SESSION_RETENTION_DAYS', 7, 365],
  ['liveClientsPerRepo', 'NV_LIVE_CLIENTS_PER_REPO', 2, 20],
  ['liveClientsTotal', 'NV_LIVE_CLIENTS_TOTAL', 10, 500],
  ['snapshotRetentionCount', 'NV_SNAPSHOT_RETENTION_COUNT', 10, 200],
  ['snapshotManifestMax', 'NV_SNAPSHOT_MANIFEST_MAX', 5000, 50000],
  ['gitDataMaxMb', 'NV_GIT_DATA_MAX_MB', 16, 95],
  ['nativePushMaxMb', 'NV_NATIVE_PUSH_MAX_MB', 16, 95],
  ['uploadMaxMb', 'NV_UPLOAD_MAX_MB', 25, 2048],
  ['uploadConcurrency', 'NV_UPLOAD_CONCURRENCY', 1, 4],
  ['uploadTimeoutMinutes', 'NV_UPLOAD_TIMEOUT_MINUTES', 10, 60],
  ['staleUploadHours', 'NV_STALE_UPLOAD_HOURS', 2, 72]
]);

function boundedInteger(env, key, fallback, minimum, maximum) {
  const raw = String(env[key] == null ? fallback : env[key]).trim();
  if (!/^\d+$/.test(raw)) throw new TypeError(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function loadHostedAlphaLimits(env = process.env) {
  const limits = {};
  for (const [property, key, fallback, maximum] of HOSTED_ALPHA_LIMITS) {
    limits[property] = boundedInteger(env, key, fallback, 1, maximum);
  }
  return Object.freeze(limits);
}

/*
 * The bounds themselves, so documentation and its guard can be derived from
 * this table rather than restating it. Returned as plain data because a caller
 * that had to parse the source would be the second source of truth again.
 */
function hostedAlphaLimitBounds() {
  return Object.freeze(HOSTED_ALPHA_LIMITS.map(([property, key, fallback, maximum]) =>
    Object.freeze({ property, key, fallback, minimum: 1, maximum })));
}

function databaseReadiness(input = {}) {
  let state = 'connected';
  if (input.required && input.connected && input.migrationMatch === false) {
    state = 'migration-mismatch';
  } else if (input.required && !input.connected && input.waking) {
    state = 'waking';
  } else if (input.required && !input.connected) {
    state = 'unavailable';
  } else if (input.connected && input.quotaWarning) {
    state = 'quota-warning';
  }

  const states = {
    connected: { ok: true, retryable: false, message: 'Database is connected.' },
    waking: { ok: false, retryable: true, message: 'Database is waking; retry shortly.' },
    'quota-warning': { ok: true, retryable: false, message: 'Database is connected with a quota warning.' },
    unavailable: { ok: false, retryable: true, message: 'Database is unavailable.' },
    'migration-mismatch': {
      ok: false,
      retryable: false,
      message: 'Database migration state does not match this release.'
    }
  };
  return Object.freeze({ state, ...states[state] });
}

function hostedConfigProjection(input = {}) {
  return Object.freeze({
    profile: String(input.profile || ''),
    alphaMode: String(input.alphaMode || ''),
    termsVersion: String(input.termsVersion || ''),
    limits: input.limits,
    database: Object.freeze({ state: String(input.database?.state || 'unavailable') })
  });
}

module.exports = {
  boundedInteger,
  loadHostedAlphaLimits,
  hostedAlphaLimitBounds,
  databaseReadiness,
  hostedConfigProjection
};
