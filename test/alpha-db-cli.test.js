'use strict';

const assert = require('assert');
const {
  parseArgs,
  assertSafeOutputDirectory,
  assertRestoreTargetDifferent,
  assertIsolatedRestoreTarget,
  databaseEnvironment,
  redactErrorMessage,
  restoreTargetFingerprint
} = require('../scripts/alpha-db');

assert.deepStrictEqual(parseArgs(['backup', '--output-dir', '/tmp/nvx-backups']), {
  command: 'backup',
  outputDir: '/tmp/nvx-backups'
});
assert.deepStrictEqual(parseArgs([
  'migrate', '--backup-manifest', '/tmp/nvx-backups/backup.nvxbackup.json'
]), {
  command: 'migrate',
  backupManifest: '/tmp/nvx-backups/backup.nvxbackup.json'
});
assert.deepStrictEqual(parseArgs([
  'restore',
  '--backup', '/tmp/nvx-backups/backup.nvxenc',
  '--manifest', '/tmp/nvx-backups/backup.nvxbackup.json'
]), {
  command: 'restore',
  backup: '/tmp/nvx-backups/backup.nvxenc',
  manifest: '/tmp/nvx-backups/backup.nvxbackup.json'
});
assert.deepStrictEqual(parseArgs(['restore-target']), { command: 'restore-target' });
assert.throws(() => parseArgs(['backup']), /--output-dir/);
assert.throws(() => parseArgs(['backup', '--database-url', 'postgresql:\/\/a\/db']), /unknown option/i);
assert.throws(() => parseArgs(['verify', '--backup', 'relative', '--manifest', '/tmp/m.json']), /absolute/i);
assert.throws(() => assertSafeOutputDirectory('/'), /broad|unsafe/i);
assert.throws(() => assertSafeOutputDirectory('/tmp'), /broad|unsafe/i);
assert.doesNotThrow(() => assertSafeOutputDirectory('/tmp/nvx-backups'));
assert.throws(
  () => assertRestoreTargetDifferent('postgresql://a/db', 'postgresql://a/db'),
  /must differ/
);

const sourceDatabaseUrl = 'postgresql://source:one@source.example/cohort?sslmode=require';
const restoreDatabaseUrl = 'postgresql://restore:two@restore.example/cohort_restore?sslmode=verify-full';
const restoreContext = {
  cohortNeonProjectId: 'quiet-rain-12345678',
  cohortNeonBranchId: 'br-main-111111',
  restoreNeonProjectId: 'quiet-rain-12345678',
  restoreNeonBranchId: 'br-restore-222222',
  restoreTargetKind: 'isolated-neon-branch'
};
const restoreFingerprint = restoreTargetFingerprint(
  sourceDatabaseUrl,
  restoreDatabaseUrl,
  restoreContext
);
assert.strictEqual(
  restoreFingerprint,
  'acc5f2f666cc7bf7f7f984b73e8ddb92c480d831165be8fa81314f3a0ede6364'
);
assert.throws(
  () => restoreTargetFingerprint(sourceDatabaseUrl, restoreDatabaseUrl, {
    ...restoreContext,
    restoreNeonBranchId: restoreContext.cohortNeonBranchId
  }),
  /isolated Neon branch must differ/i,
  'the preview fingerprint must reject the cohort branch'
);
assert.doesNotThrow(() => assertIsolatedRestoreTarget(
  sourceDatabaseUrl,
  restoreDatabaseUrl,
  { ...restoreContext, restoreTargetFingerprint: restoreFingerprint }
));
assert.throws(
  () => assertIsolatedRestoreTarget(sourceDatabaseUrl, restoreDatabaseUrl, {
    ...restoreContext,
    restoreNeonBranchId: restoreContext.cohortNeonBranchId,
    restoreTargetFingerprint: restoreFingerprint
  }),
  /isolated Neon branch must differ/i
);
assert.throws(
  () => assertIsolatedRestoreTarget(sourceDatabaseUrl, restoreDatabaseUrl, {
    ...restoreContext,
    restoreTargetFingerprint: 'f'.repeat(64)
  }),
  /fingerprint does not match/i
);
assert.throws(
  () => assertRestoreTargetDifferent(
    'postgresql://source:one@db.example/db?sslmode=require',
    'postgresql://restore:two@db.example/db?sslmode=verify-full'
  ),
  /must differ/
);

const childEnv = databaseEnvironment(
  'postgresql://operator:secret@db.example:5433/cohort?sslmode=verify-full',
  { PATH: '/usr/bin', DATABASE_URL: 'must-disappear', NV_BACKUP_KEY_BASE64: 'must-disappear' }
);
assert.deepStrictEqual(childEnv, {
  PATH: '/usr/bin',
  PGHOST: 'db.example',
  PGPORT: '5433',
  PGUSER: 'operator',
  PGPASSWORD: 'secret',
  PGDATABASE: 'cohort',
  PGSSLMODE: 'verify-full'
});
assert.throws(
  () => databaseEnvironment('postgresql://operator:secret@db.example/cohort?sslmode=disable'),
  /TLS|sslmode/i
);
const redacted = redactErrorMessage(
  'failed for postgresql://operator:secret@db.example/cohort with must-disappear',
  ['must-disappear']
);
assert(!redacted.includes('secret'));
assert(!redacted.includes('must-disappear'));

console.log('alpha database CLI tests passed');
