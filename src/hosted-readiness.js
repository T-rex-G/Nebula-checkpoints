'use strict';

const HOSTED_ALPHA_LIMITS = Object.freeze([
  ['eventRetentionDays', 'NV_EVENT_RETENTION_DAYS', 30],
  ['sessionRetentionDays', 'NV_SESSION_RETENTION_DAYS', 7],
  ['liveClientsPerRepo', 'NV_LIVE_CLIENTS_PER_REPO', 2],
  ['liveClientsTotal', 'NV_LIVE_CLIENTS_TOTAL', 10],
  ['snapshotRetentionCount', 'NV_SNAPSHOT_RETENTION_COUNT', 10],
  ['snapshotManifestMax', 'NV_SNAPSHOT_MANIFEST_MAX', 5000],
  ['gitDataMaxMb', 'NV_GIT_DATA_MAX_MB', 16],
  ['nativePushMaxMb', 'NV_NATIVE_PUSH_MAX_MB', 16],
  ['uploadMaxMb', 'NV_UPLOAD_MAX_MB', 25],
  ['uploadConcurrency', 'NV_UPLOAD_CONCURRENCY', 1],
  ['uploadTimeoutMinutes', 'NV_UPLOAD_TIMEOUT_MINUTES', 10],
  ['staleUploadHours', 'NV_STALE_UPLOAD_HOURS', 2]
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
  for (const [property, key, maximum] of HOSTED_ALPHA_LIMITS) {
    limits[property] = boundedInteger(env, key, maximum, 1, maximum);
  }
  return Object.freeze(limits);
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
  databaseReadiness,
  hostedConfigProjection
};
