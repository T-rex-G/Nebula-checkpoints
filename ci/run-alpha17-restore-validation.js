#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { neonConnectionIdentitySha256 } = require('../scripts/alpha-db');
const { runSmoke } = require('../scripts/alpha-smoke');
const {
  signRunnerRestoreAttestation,
  validateRunnerRestoreAttestation
} = require('./alpha17-restore-attestation');
const { hasExactKeys, isPlainObject, stableJson } = require('./alpha17-json');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_DURATION_MS = 15 * 60 * 1000;
const SAFE_COMMAND_ENV_KEYS = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR',
  'PGSSLROOTCERT',
  'DATABASE_URL', 'NV_RESTORE_DATABASE_URL', 'NV_BACKUP_KEY_BASE64',
  'NEON_API_KEY', 'NV_COHORT_NEON_PROJECT_ID', 'NV_COHORT_NEON_BRANCH_ID',
  'NV_RESTORE_NEON_PROJECT_ID', 'NV_RESTORE_NEON_BRANCH_ID',
  'NV_RESTORE_TARGET_KIND', 'NV_RESTORE_TARGET_FINGERPRINT'
]);
const REQUIRED_COMMAND_ENV_KEYS = Object.freeze([
  'DATABASE_URL', 'NV_RESTORE_DATABASE_URL', 'NV_BACKUP_KEY_BASE64',
  'NEON_API_KEY', 'NV_COHORT_NEON_PROJECT_ID', 'NV_COHORT_NEON_BRANCH_ID',
  'NV_RESTORE_NEON_PROJECT_ID', 'NV_RESTORE_NEON_BRANCH_ID',
  'NV_RESTORE_TARGET_KIND', 'NV_RESTORE_TARGET_FINGERPRINT'
]);
const COUNT_KEYS = Object.freeze([
  'testers', 'invites', 'feedback', 'cleanup_tasks', 'deletion_requests'
]);

function fail(message, code = 'ALPHA17_RESTORE_RUNNER_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail('restore runner input must be a non-empty regular file');
  }
  return sha256(fs.readFileSync(filePath));
}

function requireEnvironment(env, key) {
  const value = String(env[key] || '').trim();
  if (!value || /[\u0000\r\n]/.test(value)) fail(`${key} is required`);
  return value;
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertRunnerDirectory(raw, candidateRoot) {
  const resolved = path.resolve(String(raw || ''));
  const metadata = fs.lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('RUNNER_TEMP must be a real directory');
  const real = fs.realpathSync(resolved);
  const candidateReal = fs.realpathSync(candidateRoot);
  if (candidateReal === real || isPathWithin(candidateReal, real)) {
    fail('restore runner temporary storage must be outside the candidate source tree');
  }
  return real;
}

function commandEnvironment(env) {
  const output = {};
  for (const key of SAFE_COMMAND_ENV_KEYS) {
    if (env[key] == null || !String(env[key])) continue;
    const value = String(env[key]);
    if (/[\u0000\r\n]/.test(value)) fail(`restore command environment ${key} is invalid`);
    output[key] = value;
  }
  for (const key of REQUIRED_COMMAND_ENV_KEYS) requireEnvironment(output, key);
  return Object.freeze(output);
}

function executeAlphaDb(args, env, candidateRoot, runner = spawnSync) {
  const script = path.join(candidateRoot, 'scripts', 'alpha-db.js');
  const result = runner(process.execPath, [script, ...args], {
    cwd: candidateRoot,
    env,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: MAX_COMMAND_DURATION_MS,
    killSignal: 'SIGKILL'
  });
  if (result.error || result.signal || result.status !== 0) fail(`alpha-db ${args[0]} failed`);
  const output = String(result.stdout || '').trim();
  if (!output || Buffer.byteLength(output, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    fail(`alpha-db ${args[0]} output is invalid`);
  }
  try {
    const parsed = JSON.parse(output);
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    fail(`alpha-db ${args[0]} output is invalid`);
  }
}

function assertOutputFile(backupDirectory, filePath, label) {
  const resolved = path.resolve(String(filePath || ''));
  if (!isPathWithin(backupDirectory, resolved)) fail(`${label} escaped the runner backup directory`);
  const metadata = fs.lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail(`${label} must be a non-empty regular file`);
  }
  return resolved;
}

function validateBackupResult(value, backupDirectory) {
  if (!hasExactKeys(value, [
    'command', 'backupPath', 'manifestPath', 'schemaVersion', 'sizeBytes',
    'plaintextSha256', 'ciphertextSha256'
  ]) || value.command !== 'backup' || value.schemaVersion !== '015_alpha_privacy') {
    fail('backup result does not match the restore runner contract');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) fail('backup size is invalid');
  if (![value.plaintextSha256, value.ciphertextSha256].every(item => SHA256_PATTERN.test(String(item || '')))) {
    fail('backup digest is invalid');
  }
  const backupPath = assertOutputFile(backupDirectory, value.backupPath, 'encrypted backup');
  const manifestPath = assertOutputFile(backupDirectory, value.manifestPath, 'backup manifest');
  if (hashFile(backupPath) !== value.ciphertextSha256) fail('encrypted backup digest does not match');
  return Object.freeze({ ...value, backupPath, manifestPath });
}

function validateTargetResult(value, env, expectedIdentitySha256) {
  if (!hasExactKeys(value, [
    'command', 'kind', 'cohortNeonProjectId', 'cohortNeonBranchId',
    'restoreNeonProjectId', 'restoreNeonBranchId', 'restoreDatabaseIdentitySha256', 'fingerprint'
  ]) || value.command !== 'restore-target') fail('restore-target result does not match the runner contract');
  const expected = {
    kind: env.NV_RESTORE_TARGET_KIND,
    cohortNeonProjectId: env.NV_COHORT_NEON_PROJECT_ID,
    cohortNeonBranchId: env.NV_COHORT_NEON_BRANCH_ID,
    restoreNeonProjectId: env.NV_RESTORE_NEON_PROJECT_ID,
    restoreNeonBranchId: env.NV_RESTORE_NEON_BRANCH_ID,
    fingerprint: env.NV_RESTORE_TARGET_FINGERPRINT
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail(`restore-target ${key} does not match the reviewed target`);
  }
  if (
    !SHA256_PATTERN.test(String(value.restoreDatabaseIdentitySha256 || '')) ||
    value.restoreDatabaseIdentitySha256 !== expectedIdentitySha256
  ) {
    fail('restore-target identity does not match the configured restore connection');
  }
  return value;
}

function validateRestoreResult(value) {
  if (!hasExactKeys(value, ['command', 'migration', 'counts']) ||
      value.command !== 'restore' || value.migration !== '015_alpha_privacy' ||
      !hasExactKeys(value.counts, COUNT_KEYS)) {
    fail('restore result does not match the runner contract');
  }
  for (const key of COUNT_KEYS) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(String(value.counts[key] || ''))) {
      fail(`restore count ${key} is invalid`);
    }
  }
  return value;
}

function writeExclusive(filePath, value) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

async function runRestoreValidation(options = {}) {
  const env = options.env || process.env;
  const candidateRoot = path.resolve(options.candidateRoot || path.join(__dirname, '..'));
  const runnerTemp = assertRunnerDirectory(requireEnvironment(env, 'RUNNER_TEMP'), candidateRoot);
  const attestationPath = path.resolve(requireEnvironment(env, 'NV_ALPHA17_RESTORE_ATTESTATION_PATH'));
  if (path.dirname(attestationPath) !== runnerTemp || fs.existsSync(attestationPath)) {
    fail('restore attestation must be a new direct child of RUNNER_TEMP');
  }
  const subjectSha256 = requireEnvironment(env, 'NV_PUBLIC_ALPHA_SUBJECT_SHA256').toLowerCase();
  const sourceCommit = requireEnvironment(env, 'NV_PUBLIC_ALPHA_SOURCE_COMMIT').toLowerCase();
  const runId = requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_RUN_ID');
  const restoreAppBaseUrl = requireEnvironment(env, 'NV_ALPHA17_RESTORE_APP_BASE_URL');
  const restoreAppDeployId = requireEnvironment(env, 'NV_ALPHA17_RESTORE_APP_DEPLOY_ID');
  if (!SHA256_PATTERN.test(subjectSha256) || /^0{64}$/.test(subjectSha256)) fail('restore subject is invalid');
  if (!COMMIT_PATTERN.test(sourceCommit) || /^0{40}$/.test(sourceCommit)) fail('restore source commit is invalid');
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(runId)) fail('restore workflow run ID is invalid');
  const commandEnv = commandEnvironment(env);
  const executeCommand = options.executeCommand || ((args, childEnv) => executeAlphaDb(args, childEnv, candidateRoot));
  const sourceIdentitySha256 = neonConnectionIdentitySha256(
    commandEnv.DATABASE_URL,
    commandEnv.NV_COHORT_NEON_PROJECT_ID,
    commandEnv.NV_COHORT_NEON_BRANCH_ID,
    'DATABASE_URL'
  );
  const targetIdentitySha256 = neonConnectionIdentitySha256(
    commandEnv.NV_RESTORE_DATABASE_URL,
    commandEnv.NV_RESTORE_NEON_PROJECT_ID,
    commandEnv.NV_RESTORE_NEON_BRANCH_ID,
    'NV_RESTORE_DATABASE_URL'
  );
  if (sourceIdentitySha256 === targetIdentitySha256) {
    fail('restore source and target identities are not distinct');
  }
  const target = validateTargetResult(
    executeCommand(['restore-target'], commandEnv),
    commandEnv,
    targetIdentitySha256
  );
  const backupDirectory = fs.mkdtempSync(path.join(runnerTemp, 'nvx-alpha17-restore-'));
  fs.chmodSync(backupDirectory, 0o700);

  /*
   * The backup directory holds decryptable database material, so it must not
   * outlive this function.
   *
   * A catch block covers the failure path but leaves the directory behind when
   * the operation returns early, so removal happens in a finally instead.
   *
   * Cancellation is deliberately not handled here. Every alpha-db command runs
   * through execFileSync, which blocks the event loop, so a JavaScript signal
   * handler could not run during the work it would need to clean up after --
   * and installing one would suppress Node's default termination, leaving a
   * cancelled run hanging instead of exiting. The workflow's EXIT trap removes
   * the directory on cancellation, which is the layer that can.
   *
   * removeBackupDirectory is idempotent: rmSync with force treats an absent
   * path as already done.
   */
  let backupRemoved = false;
  const removeBackupDirectory = () => {
    if (backupRemoved) return null;
    try {
      fs.rmSync(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      return error;
    }
    if (fs.existsSync(backupDirectory)) return new Error('restore backup cleanup failed');
    backupRemoved = true;
    return null;
  };

  let proof;
  let operationError = null;
  let cleanupError = null;
  try {
    const backup = validateBackupResult(
      executeCommand(['backup', '--output-dir', backupDirectory], commandEnv),
      backupDirectory
    );
    const restore = validateRestoreResult(executeCommand([
      'restore', '--backup', backup.backupPath, '--manifest', backup.manifestPath
    ], commandEnv));
    const smoke = await (options.runSmokeImpl || runSmoke)(restoreAppBaseUrl);
    if (!smoke || smoke.ok !== true) fail('restore-backed application smoke failed');
    const backupManifestSha256 = hashFile(backup.manifestPath);
    proof = {
      status: 'pass',
      latestMigration: restore.migration,
      backupManifestSha256,
      backupCiphertextSha256: backup.ciphertextSha256,
      restoreTargetFingerprint: target.fingerprint,
      restoreAppDeployIdSha256: sha256(Buffer.from(restoreAppDeployId, 'utf8')),
      restoreEvidenceSha256: sha256(Buffer.from(stableJson({
        backup: {
          schemaVersion: backup.schemaVersion,
          sizeBytes: backup.sizeBytes,
          plaintextSha256: backup.plaintextSha256,
          ciphertextSha256: backup.ciphertextSha256,
          manifestSha256: backupManifestSha256
        },
        target: {
          kind: target.kind,
          fingerprint: target.fingerprint,
          sourceIdentitySha256,
          targetIdentitySha256
        },
        restore
      }), 'utf8')),
      sourceIdentitySha256,
      targetIdentitySha256,
      sourceTargetDistinct: true,
      controlPlaneVerified: true,
      liveTargetVerified: true,
      smokePassed: true,
      backupRemoved: true
    };
  } catch (error) {
    operationError = error;
  } finally {
    cleanupError = removeBackupDirectory();
  }
  /*
   * Cleanup must never replace the reason the operation failed. A workflow told
   * only that cleanup failed would be debugging the symptom.
   */
  if (operationError) {
    if (cleanupError) operationError.cleanupFailed = true;
    throw operationError;
  }
  if (cleanupError) fail('restore backup cleanup failed');
  const completedAt = (options.now ? options.now() : new Date()).toISOString();
  const signedAttestation = signRunnerRestoreAttestation({
    schemaVersion: '1.0.0',
    artifactType: 'hosted-restore-runner',
    subjectSha256,
    sourceCommit,
    originId: `workflow-${runId}-restore`,
    completedAt,
    cleanupVerified: true,
    check: proof
  }, {
    workflowRepository: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_REPOSITORY'),
    workflowPath: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_PATH'),
    workflowRunId: runId,
    attestationKeyBase64: requireEnvironment(env, 'NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64')
  });
  const attestation = validateRunnerRestoreAttestation(signedAttestation, {
    expectedSubjectHash: subjectSha256,
    expectedSourceCommit: sourceCommit,
    expectedOriginId: `workflow-${runId}-restore`,
    expectedRestoreTargetFingerprint: commandEnv.NV_RESTORE_TARGET_FINGERPRINT,
    expectedRestoreAppDeployIdSha256: sha256(Buffer.from(restoreAppDeployId, 'utf8')),
    workflowRepository: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_REPOSITORY'),
    workflowPath: requireEnvironment(env, 'NV_ALPHA17_WORKFLOW_PATH'),
    workflowRunId: runId,
    attestationKeyBase64: requireEnvironment(env, 'NV_ALPHA17_RESTORE_ATTESTATION_KEY_BASE64'),
    now: new Date(completedAt)
  });
  writeExclusive(attestationPath, attestation);
  return attestation;
}

async function main() {
  try {
    const result = await runRestoreValidation();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      subjectSha256: result.subjectSha256,
      sourceCommit: result.sourceCommit,
      cleanupVerified: result.cleanupVerified
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  MAX_COMMAND_DURATION_MS,
  commandEnvironment,
  executeAlphaDb,
  validateBackupResult,
  validateTargetResult,
  validateRestoreResult,
  runRestoreValidation
});
