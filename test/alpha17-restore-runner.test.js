'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_COMMAND_DURATION_MS,
  executeAlphaDb,
  runRestoreValidation
} = require('../ci/run-alpha17-restore-validation');
const { neonConnectionIdentitySha256 } = require('../scripts/alpha-db');

const SUBJECT = 'a'.repeat(64);
const SOURCE = 'b'.repeat(40);
const FINGERPRINT = 'c'.repeat(64);
const NOW = new Date('2026-07-29T20:00:00.000Z');
const neonApiProbe = ['neon', 'api', 'fixture', 'must', 'not', 'leak'].join('-');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

let observedSpawnOptions;
assert.deepStrictEqual(
  executeAlphaDb(['restore-target'], {}, path.resolve(__dirname, '..'), (command, args, options) => {
    assert.strictEqual(command, process.execPath);
    assert(args[0].endsWith(path.join('scripts', 'alpha-db.js')));
    observedSpawnOptions = options;
    return { status: 0, signal: null, error: null, stdout: '{}\n', stderr: '' };
  }),
  {}
);
assert.strictEqual(observedSpawnOptions.timeout, MAX_COMMAND_DURATION_MS);
assert.strictEqual(observedSpawnOptions.killSignal, 'SIGKILL');
assert.throws(
  () => executeAlphaDb(['restore'], {}, path.resolve(__dirname, '..'), () => ({
    status: null,
    signal: 'SIGKILL',
    error: null,
    stdout: '',
    stderr: ''
  })),
  error => error && error.code === 'ALPHA17_RESTORE_RUNNER_FAILED',
  'a timed-out or signalled alpha-db child must fail through the restore-runner boundary'
);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-restore-runner-test-'));
try {
  const runnerTemp = path.join(temporaryRoot, 'runner');
  fs.mkdirSync(runnerTemp, { mode: 0o700 });
  const candidateRoot = path.join(runnerTemp, 'subject', 'candidate');
  fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
  const attestationPath = path.join(runnerTemp, 'restore-attestation.json');
  const commands = [];
  let observedBackupDirectory = null;
  const env = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'must-not-reach-the-restore-process',
    RUNNER_TEMP: runnerTemp,
    NV_ALPHA17_RESTORE_ATTESTATION_PATH: attestationPath,
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: SUBJECT,
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: SOURCE,
    NV_ALPHA17_WORKFLOW_RUN_ID: '2048',
    DATABASE_URL: 'postgresql://source:secret@ep-source-pooler.example.test/cohort?sslmode=verify-full',
    NV_RESTORE_DATABASE_URL: 'postgresql://restore:secret@ep-restore.example.test/cohort_restore?sslmode=verify-full',
    NV_BACKUP_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    NEON_API_KEY: neonApiProbe,
    NV_COHORT_NEON_PROJECT_ID: 'quiet-rain-12345678',
    NV_COHORT_NEON_BRANCH_ID: 'br-main-111111',
    NV_RESTORE_NEON_PROJECT_ID: 'quiet-rain-12345678',
    NV_RESTORE_NEON_BRANCH_ID: 'br-restore-222222',
    NV_RESTORE_TARGET_KIND: 'isolated-neon-branch',
    NV_RESTORE_TARGET_FINGERPRINT: FINGERPRINT
  };

  const executeCommand = (args, commandEnv) => {
    commands.push(args[0]);
    assert.strictEqual(Object.hasOwn(commandEnv, 'GITHUB_TOKEN'), false);
    assert.strictEqual(commandEnv.DATABASE_URL, env.DATABASE_URL);
    if (args[0] === 'backup') {
      observedBackupDirectory = args[2];
      const backupPath = path.join(observedBackupDirectory, 'fixture.dump.nvxenc');
      const manifestPath = path.join(observedBackupDirectory, 'fixture.nvxbackup.json');
      const backup = Buffer.from('encrypted-fixture-backup');
      const manifest = Buffer.from('{"schemaVersion":"1.0.0"}\n');
      fs.writeFileSync(backupPath, backup, { mode: 0o600 });
      fs.writeFileSync(manifestPath, manifest, { mode: 0o600 });
      return {
        command: 'backup',
        backupPath,
        manifestPath,
        schemaVersion: '015_alpha_privacy',
        sizeBytes: backup.length,
        plaintextSha256: '1'.repeat(64),
        ciphertextSha256: sha256(backup)
      };
    }
    if (args[0] === 'restore-target') {
      return {
        command: 'restore-target',
        kind: commandEnv.NV_RESTORE_TARGET_KIND,
        cohortNeonProjectId: commandEnv.NV_COHORT_NEON_PROJECT_ID,
        cohortNeonBranchId: commandEnv.NV_COHORT_NEON_BRANCH_ID,
        restoreNeonProjectId: commandEnv.NV_RESTORE_NEON_PROJECT_ID,
        restoreNeonBranchId: commandEnv.NV_RESTORE_NEON_BRANCH_ID,
        restoreDatabaseIdentitySha256: neonConnectionIdentitySha256(
          commandEnv.NV_RESTORE_DATABASE_URL,
          commandEnv.NV_RESTORE_NEON_PROJECT_ID,
          commandEnv.NV_RESTORE_NEON_BRANCH_ID,
          'NV_RESTORE_DATABASE_URL'
        ),
        fingerprint: commandEnv.NV_RESTORE_TARGET_FINGERPRINT
      };
    }
    if (args[0] === 'restore') {
      return {
        command: 'restore',
        migration: '015_alpha_privacy',
        counts: {
          testers: '1', invites: '1', feedback: '0', cleanup_tasks: '0', deletion_requests: '0'
        }
      };
    }
    throw new Error(`unexpected alpha-db command: ${args[0]}`);
  };

  const result = runRestoreValidation({ env, executeCommand, candidateRoot, now: () => NOW });
  assert.deepStrictEqual(commands, ['restore-target', 'backup', 'restore']);
  assert.strictEqual(fs.existsSync(observedBackupDirectory), false, 'encrypted backup material must be erased');
  assert.strictEqual(result.cleanupVerified, true);
  assert.strictEqual(result.check.backupRemoved, true);
  assert.strictEqual(result.check.restoreTargetFingerprint, FINGERPRINT);
  assert.strictEqual(result.check.latestMigration, '015_alpha_privacy');
  assert.match(result.check.backupManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(result.check.backupCiphertextSha256, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(result.check.sourceIdentitySha256, result.check.targetIdentitySha256);
  assert.strictEqual(fs.existsSync(attestationPath), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(attestationPath, 'utf8')), result);
  const serialized = JSON.stringify(result);
  for (const secret of ['source:secret', 'restore:secret', env.NV_BACKUP_KEY_BASE64, env.NEON_API_KEY]) {
    assert.strictEqual(serialized.includes(secret), false, 'runner evidence must not contain secret material');
  }

  const unsafeRunnerTemp = path.join(candidateRoot, 'unsafe-runner-temp');
  fs.mkdirSync(unsafeRunnerTemp, { mode: 0o700 });
  assert.throws(
    () => runRestoreValidation({
      env: {
        ...env,
        RUNNER_TEMP: unsafeRunnerTemp,
        NV_ALPHA17_RESTORE_ATTESTATION_PATH: path.join(unsafeRunnerTemp, 'attestation.json')
      },
      executeCommand,
      candidateRoot,
      now: () => NOW
    }),
    /temporary storage must be outside the candidate source tree/
  );

  const sameIdentityAttestationPath = path.join(runnerTemp, 'same-identity-attestation.json');
  const sameIdentityEnv = {
    ...env,
    NV_ALPHA17_RESTORE_ATTESTATION_PATH: sameIdentityAttestationPath,
    NV_RESTORE_DATABASE_URL: env.DATABASE_URL,
    NV_RESTORE_NEON_PROJECT_ID: env.NV_COHORT_NEON_PROJECT_ID,
    NV_RESTORE_NEON_BRANCH_ID: env.NV_COHORT_NEON_BRANCH_ID
  };
  const commandsBeforeSameIdentity = commands.length;
  assert.throws(
    () => runRestoreValidation({ env: sameIdentityEnv, executeCommand, candidateRoot, now: () => NOW }),
    /restore source and target identities are not distinct/,
    'a target-only kind label must not make identical source and target infrastructure appear distinct'
  );
  assert.strictEqual(commands.length, commandsBeforeSameIdentity,
    'an identical target must fail before restore-target, backup, or restore executes');
  assert.strictEqual(fs.existsSync(sameIdentityAttestationPath), false);

  const mismatchedTargetAttestationPath = path.join(runnerTemp, 'mismatched-target-attestation.json');
  const commandsBeforeMismatchedTarget = commands.length;
  assert.throws(
    () => runRestoreValidation({
      env: {
        ...env,
        NV_ALPHA17_RESTORE_ATTESTATION_PATH: mismatchedTargetAttestationPath
      },
      executeCommand(args, commandEnv) {
        const result = executeCommand(args, commandEnv);
        return args[0] === 'restore-target'
          ? { ...result, restoreDatabaseIdentitySha256: 'f'.repeat(64) }
          : result;
      },
      candidateRoot,
      now: () => NOW
    }),
    /identity does not match the configured restore connection/
  );
  assert.deepStrictEqual(
    commands.slice(commandsBeforeMismatchedTarget),
    ['restore-target'],
    'a control-plane identity mismatch must fail before backup or restore executes'
  );
  assert.strictEqual(fs.existsSync(mismatchedTargetAttestationPath), false);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('alpha17 restore runner tests passed');
