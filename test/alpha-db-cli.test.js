'use strict';

const assert = require('assert');
const {
  parseArgs,
  assertSafeOutputDirectory,
  assertRestoreTargetDifferent,
  databaseEnvironment,
  redactErrorMessage
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
