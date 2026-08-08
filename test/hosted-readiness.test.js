'use strict';

const assert = require('assert');
const {
  loadHostedAlphaLimits,
  databaseReadiness,
  hostedConfigProjection
} = require('../src/hosted-readiness');

const expectedLimits = {
  eventRetentionDays: 30,
  sessionRetentionDays: 7,
  liveClientsPerRepo: 2,
  liveClientsTotal: 10,
  snapshotRetentionCount: 10,
  snapshotManifestMax: 5000,
  gitDataMaxMb: 16,
  nativePushMaxMb: 16,
  uploadMaxMb: 25,
  uploadConcurrency: 1,
  uploadTimeoutMinutes: 10,
  staleUploadHours: 2
};

assert.deepStrictEqual(loadHostedAlphaLimits({}), expectedLimits);
assert(Object.isFrozen(loadHostedAlphaLimits({})));
assert.strictEqual(loadHostedAlphaLimits({ NV_EVENT_RETENTION_DAYS: '14' }).eventRetentionDays, 14);
assert.throws(
  () => loadHostedAlphaLimits({ NV_EVENT_RETENTION_DAYS: '31' }),
  /between 1 and 30/
);
assert.throws(
  () => loadHostedAlphaLimits({ NV_UPLOAD_MAX_MB: '25.5' }),
  /must be an integer/
);

const readinessCases = [
  [{ required: true, connected: true, waking: false, migrationMatch: true, quotaWarning: false },
    { state: 'connected', ok: true, retryable: false, message: 'Database is connected.' }],
  [{ required: true, connected: false, waking: true, migrationMatch: true, quotaWarning: false },
    { state: 'waking', ok: false, retryable: true, message: 'Database is waking; retry shortly.' }],
  [{ required: true, connected: true, waking: false, migrationMatch: true, quotaWarning: true },
    { state: 'quota-warning', ok: true, retryable: false, message: 'Database is connected with a quota warning.' }],
  [{ required: true, connected: false, waking: false, migrationMatch: true, quotaWarning: false },
    { state: 'unavailable', ok: false, retryable: true, message: 'Database is unavailable.' }],
  [{ required: true, connected: true, waking: false, migrationMatch: false, quotaWarning: false },
    { state: 'migration-mismatch', ok: false, retryable: false, message: 'Database migration state does not match this release.' }]
];

for (const [input, expected] of readinessCases) {
  assert.deepStrictEqual(databaseReadiness(input), expected);
  assert(Object.isFrozen(databaseReadiness(input)));
}

const projection = hostedConfigProjection({
  profile: 'hosted-alpha',
  alphaMode: 'invite',
  termsVersion: '2026-07-29',
  limits: expectedLimits,
  database: { state: 'connected' },
  DATABASE_URL: 'postgresql://secret.example/db',
  NV_ALPHA_INVITE_PEPPER: 'not-public'
});
assert.deepStrictEqual(projection, {
  profile: 'hosted-alpha',
  alphaMode: 'invite',
  termsVersion: '2026-07-29',
  limits: expectedLimits,
  database: { state: 'connected' }
});
assert(!JSON.stringify(projection).includes('secret.example'));
assert(Object.isFrozen(projection));

console.log('hosted readiness model tests passed');
