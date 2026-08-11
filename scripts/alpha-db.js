'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  decodeBackupKey,
  encryptBackupFile,
  decryptBackupFile,
  validateBackupManifest
} = require('../src/backup-format');
const { runMigrations, verifyMigrations } = require('../src/migrations');

const COMMANDS = Object.freeze({
  backup: Object.freeze({ '--output-dir': 'outputDir' }),
  verify: Object.freeze({ '--backup': 'backup', '--manifest': 'manifest' }),
  migrate: Object.freeze({ '--backup-manifest': 'backupManifest' }),
  'restore-target': Object.freeze({}),
  restore: Object.freeze({ '--backup': 'backup', '--manifest': 'manifest' })
});
const REQUIRED = Object.freeze({
  backup: Object.freeze(['outputDir']),
  verify: Object.freeze(['backup', 'manifest']),
  migrate: Object.freeze(['backupManifest']),
  'restore-target': Object.freeze([]),
  restore: Object.freeze(['backup', 'manifest'])
});
const SAFE_CHILD_ENV_KEYS = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR'
]);

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv : [];
  const command = String(values[0] || '').trim();
  const spec = COMMANDS[command];
  if (!spec) throw new TypeError('Command must be backup, verify, migrate, restore-target, or restore');
  const parsed = { command };
  for (let index = 1; index < values.length; index += 2) {
    const option = String(values[index] || '');
    const property = spec[option];
    if (!property) throw new TypeError(`Unknown option for ${command}: ${option}`);
    if (Object.hasOwn(parsed, property)) throw new TypeError(`Duplicate option: ${option}`);
    const value = String(values[index + 1] || '');
    if (!value || value.startsWith('--')) throw new TypeError(`${option} requires a value`);
    if (!path.isAbsolute(value)) throw new TypeError(`${option} must use an absolute path`);
    parsed[property] = path.normalize(value);
  }
  for (const property of REQUIRED[command]) {
    if (!parsed[property]) {
      const option = Object.entries(spec).find(([, name]) => name === property)?.[0] || property;
      throw new TypeError(`${command} requires ${option}`);
    }
  }
  return parsed;
}

function assertSafeOutputDirectory(raw) {
  const resolved = path.resolve(String(raw || ''));
  const root = path.parse(resolved).root;
  if (!path.isAbsolute(String(raw || '')) || resolved === root || path.dirname(resolved) === root) {
    throw new TypeError('Backup output directory is too broad or unsafe');
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError('Backup output directory must be a real directory');
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function parseDatabaseUrl(raw, label = 'database URL') {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new TypeError(`${label} is not a valid PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new TypeError(`${label} is not a valid PostgreSQL URL`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) throw new TypeError(`${label} must name one database`);
  return { url, database };
}

function databaseIdentity(raw) {
  const { url, database } = parseDatabaseUrl(raw);
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${database}`;
}

function assertRestoreTargetDifferent(source, target) {
  if (databaseIdentity(source) === databaseIdentity(target)) {
    throw new TypeError('NV_RESTORE_DATABASE_URL must differ from DATABASE_URL');
  }
}

function normalizeRestoreContext(input = {}) {
  const context = {
    cohortNeonProjectId: String(input.cohortNeonProjectId || '').trim().toLowerCase(),
    cohortNeonBranchId: String(input.cohortNeonBranchId || '').trim().toLowerCase(),
    restoreNeonProjectId: String(input.restoreNeonProjectId || '').trim().toLowerCase(),
    restoreNeonBranchId: String(input.restoreNeonBranchId || '').trim().toLowerCase(),
    restoreTargetKind: String(input.restoreTargetKind || '').trim().toLowerCase()
  };
  if (
    !/^[a-z0-9][a-z0-9-]{2,127}$/.test(context.cohortNeonProjectId) ||
    !/^br-[a-z0-9][a-z0-9-]{2,127}$/.test(context.cohortNeonBranchId) ||
    !/^[a-z0-9][a-z0-9-]{2,127}$/.test(context.restoreNeonProjectId) ||
    !/^br-[a-z0-9][a-z0-9-]{2,127}$/.test(context.restoreNeonBranchId) ||
    context.restoreTargetKind !== 'isolated-neon-branch'
  ) {
    throw new TypeError('Restore target requires explicit valid Neon project, branch, and isolated-target context');
  }
  return context;
}

function restoreTargetFingerprint(source, target, input) {
  assertRestoreTargetDifferent(source, target);
  const context = normalizeRestoreContext(input);
  if (
    context.cohortNeonProjectId === context.restoreNeonProjectId &&
    context.cohortNeonBranchId === context.restoreNeonBranchId
  ) {
    throw new TypeError('The isolated Neon branch must differ from the cohort branch');
  }
  const preimage = {
    schemaVersion: 'nvx-isolated-restore-target.v1',
    source: {
      databaseIdentity: databaseIdentity(source),
      neonProjectId: context.cohortNeonProjectId,
      neonBranchId: context.cohortNeonBranchId
    },
    target: {
      databaseIdentity: databaseIdentity(target),
      neonProjectId: context.restoreNeonProjectId,
      neonBranchId: context.restoreNeonBranchId,
      kind: context.restoreTargetKind
    }
  };
  return crypto.createHash('sha256').update(JSON.stringify(preimage), 'utf8').digest('hex');
}

function assertIsolatedRestoreTarget(source, target, input) {
  const context = normalizeRestoreContext(input);
  const supplied = String(input?.restoreTargetFingerprint || '').trim().toLowerCase();
  const expected = restoreTargetFingerprint(source, target, context);
  if (
    !/^[0-9a-f]{64}$/.test(supplied) ||
    !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
  ) {
    throw new TypeError('NV_RESTORE_TARGET_FINGERPRINT does not match the reviewed isolated restore target');
  }
  return Object.freeze({ ...context, fingerprint: expected });
}

function restoreContextFromEnvironment(env) {
  return {
    cohortNeonProjectId: requireEnvironment(env, 'NV_COHORT_NEON_PROJECT_ID'),
    cohortNeonBranchId: requireEnvironment(env, 'NV_COHORT_NEON_BRANCH_ID'),
    restoreNeonProjectId: requireEnvironment(env, 'NV_RESTORE_NEON_PROJECT_ID'),
    restoreNeonBranchId: requireEnvironment(env, 'NV_RESTORE_NEON_BRANCH_ID'),
    restoreTargetKind: requireEnvironment(env, 'NV_RESTORE_TARGET_KIND'),
    restoreTargetFingerprint: String(env.NV_RESTORE_TARGET_FINGERPRINT || '').trim()
  };
}

function databaseEnvironment(raw, baseEnv = process.env) {
  const { url, database } = parseDatabaseUrl(raw);
  const env = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (baseEnv[key] != null && String(baseEnv[key])) env[key] = String(baseEnv[key]);
  }
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = database;
  const sslmode = String(url.searchParams.get('sslmode') || 'verify-full').toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    throw new TypeError('PostgreSQL sslmode must require TLS');
  }
  env.PGSSLMODE = sslmode;
  return env;
}

function redactErrorMessage(raw, secrets = []) {
  let message = String(raw || 'Operation failed')
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted-database-url]')
    .replace(/(?:password|token|secret|key)=\S+/gi, '$1=[redacted]');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value) message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 240);
}

function requireEnvironment(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new TypeError(`${key} is required`);
  return value;
}

async function spawnChecked(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    child.once('error', () => reject(new Error(`${command} could not be started`)));
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed (${signal || `exit ${code}`})`));
    });
  });
}

function createTemporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-alpha-db-'));
  fs.chmodSync(root, 0o700);
  return root;
}

async function writeJsonExclusive(filePath, value) {
  const handle = await fsp.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  await fsp.chmod(filePath, 0o600);
}

async function readBackupRecord(manifestPath) {
  const stat = await fsp.lstat(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('Backup manifest must be a regular file');
  const record = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const manifest = validateBackupManifest(record);
  return Object.freeze({ record, manifest });
}

function backupPathFromRecord(manifestPath, record) {
  const name = String(record.backupFile || '');
  if (!name || path.basename(name) !== name || !name.endsWith('.nvxenc')) {
    throw new TypeError('Backup manifest does not contain a safe backupFile name');
  }
  return path.join(path.dirname(manifestPath), name);
}

function assertFreshBackup(manifest, now = Date.now()) {
  const created = Date.parse(manifest.metadata.createdAt);
  const age = now - created;
  if (!Number.isFinite(created) || age < -5 * 60 * 1000 || age > 60 * 60 * 1000) {
    throw new TypeError('Migration requires a backup created within the last 60 minutes');
  }
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function withVerifiedPlaintext({ backupPath, manifest, key }, operation) {
  const temporaryRoot = createTemporaryRoot();
  const plaintextPath = path.join(temporaryRoot, 'verified.dump');
  try {
    await decryptBackupFile({
      inputPath: backupPath,
      outputPath: plaintextPath,
      key,
      manifest
    });
    return await operation(plaintextPath);
  } finally {
    await fsp.rm(plaintextPath, { force: true }).catch(() => {});
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function backupCommand(args, env, now = new Date()) {
  const databaseUrl = requireEnvironment(env, 'DATABASE_URL');
  const key = decodeBackupKey(requireEnvironment(env, 'NV_BACKUP_KEY_BASE64'));
  const outputDir = assertSafeOutputDirectory(args.outputDir);
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputStat = await fsp.lstat(outputDir);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new TypeError('Backup output directory must be a real directory');
  }
  await fsp.chmod(outputDir, 0o700);

  const temporaryRoot = createTemporaryRoot();
  const plaintextPath = path.join(temporaryRoot, 'cohort.dump');
  const handle = fs.openSync(plaintextPath, 'wx', 0o600);
  fs.closeSync(handle);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = path.join(outputDir, `nvx-alpha17-${stamp}.dump.nvxenc`);
  const manifestPath = path.join(outputDir, `nvx-alpha17-${stamp}.nvxbackup.json`);
  try {
    await spawnChecked('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file', plaintextPath
    ], databaseEnvironment(databaseUrl, env));
    await fsp.chmod(plaintextPath, 0o600);
    const manifest = await encryptBackupFile({
      inputPath: plaintextPath,
      outputPath: backupPath,
      key,
      metadata: {
        format: 'postgres-custom',
        schemaVersion: '015_alpha_privacy',
        createdAt: now.toISOString()
      }
    });
    await writeJsonExclusive(manifestPath, {
      ...manifest,
      backupFile: path.basename(backupPath)
    });
    printResult({
      command: 'backup',
      backupPath,
      manifestPath,
      schemaVersion: manifest.metadata.schemaVersion,
      sizeBytes: manifest.sizeBytes,
      plaintextSha256: manifest.plaintextSha256,
      ciphertextSha256: manifest.ciphertextSha256
    });
  } finally {
    await fsp.rm(plaintextPath, { force: true }).catch(() => {});
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function verifyCommand(args, env) {
  const key = decodeBackupKey(requireEnvironment(env, 'NV_BACKUP_KEY_BASE64'));
  const { manifest } = await readBackupRecord(args.manifest);
  await withVerifiedPlaintext({ backupPath: args.backup, manifest, key }, async plaintextPath => {
    await spawnChecked('pg_restore', ['--list', plaintextPath], databaseEnvironment(
      'postgresql://localhost/verification-only',
      env
    ));
  });
  printResult({
    command: 'verify',
    backupPath: args.backup,
    manifestPath: args.manifest,
    schemaVersion: manifest.metadata.schemaVersion,
    sizeBytes: manifest.sizeBytes,
    plaintextSha256: manifest.plaintextSha256,
    ciphertextSha256: manifest.ciphertextSha256
  });
}

async function connectDatabase(databaseUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function migrateCommand(args, env) {
  const databaseUrl = requireEnvironment(env, 'DATABASE_URL');
  const key = decodeBackupKey(requireEnvironment(env, 'NV_BACKUP_KEY_BASE64'));
  const { record, manifest } = await readBackupRecord(args.backupManifest);
  assertFreshBackup(manifest);
  const backupPath = backupPathFromRecord(args.backupManifest, record);
  await withVerifiedPlaintext({ backupPath, manifest, key }, async () => {});
  const client = await connectDatabase(databaseUrl);
  try {
    const migration = await runMigrations(client, {
      directory: path.join(__dirname, '..', 'db', 'migrations'),
      logger: { info() {} }
    });
    const verification = await verifyMigrations(client, {
      directory: path.join(__dirname, '..', 'db', 'migrations')
    });
    if (!verification.ok) throw new Error('Database migration verification failed');
    printResult({
      command: 'migrate',
      applied: migration.applied,
      migration: verification.expectedLatest
    });
  } finally {
    await client.end().catch(() => {});
  }
}

async function restoreCommand(args, env) {
  const sourceUrl = requireEnvironment(env, 'DATABASE_URL');
  const targetUrl = requireEnvironment(env, 'NV_RESTORE_DATABASE_URL');
  assertIsolatedRestoreTarget(sourceUrl, targetUrl, restoreContextFromEnvironment(env));
  const key = decodeBackupKey(requireEnvironment(env, 'NV_BACKUP_KEY_BASE64'));
  const { manifest } = await readBackupRecord(args.manifest);
  const target = parseDatabaseUrl(targetUrl, 'NV_RESTORE_DATABASE_URL');
  await withVerifiedPlaintext({ backupPath: args.backup, manifest, key }, async plaintextPath => {
    await spawnChecked('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--dbname', target.database,
      plaintextPath
    ], databaseEnvironment(targetUrl, env));
  });
  const client = await connectDatabase(targetUrl);
  try {
    const verification = await verifyMigrations(client, {
      directory: path.join(__dirname, '..', 'db', 'migrations')
    });
    if (!verification.ok) throw new Error('Restored database migration verification failed');
    const counts = await client.query(`SELECT
      (SELECT count(*)::bigint FROM nv_alpha_testers) AS testers,
      (SELECT count(*)::bigint FROM nv_alpha_invites) AS invites,
      (SELECT count(*)::bigint FROM nv_alpha_feedback) AS feedback,
      (SELECT count(*)::bigint FROM nv_alpha_cleanup_tasks) AS cleanup_tasks,
      (SELECT count(*)::bigint FROM nv_alpha_deletion_requests) AS deletion_requests`);
    printResult({
      command: 'restore',
      migration: verification.expectedLatest,
      counts: counts.rows[0]
    });
  } finally {
    await client.end().catch(() => {});
  }
}

function restoreTargetCommand(env) {
  const sourceUrl = requireEnvironment(env, 'DATABASE_URL');
  const targetUrl = requireEnvironment(env, 'NV_RESTORE_DATABASE_URL');
  assertRestoreTargetDifferent(sourceUrl, targetUrl);
  const context = normalizeRestoreContext(restoreContextFromEnvironment(env));
  const fingerprint = restoreTargetFingerprint(sourceUrl, targetUrl, context);
  printResult({
    command: 'restore-target',
    kind: context.restoreTargetKind,
    cohortNeonProjectId: context.cohortNeonProjectId,
    cohortNeonBranchId: context.cohortNeonBranchId,
    restoreNeonProjectId: context.restoreNeonProjectId,
    restoreNeonBranchId: context.restoreNeonBranchId,
    restoreDatabaseIdentity: databaseIdentity(targetUrl),
    fingerprint
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.command === 'backup') return backupCommand(args, env);
  if (args.command === 'verify') return verifyCommand(args, env);
  if (args.command === 'migrate') return migrateCommand(args, env);
  if (args.command === 'restore-target') return restoreTargetCommand(env);
  return restoreCommand(args, env);
}

if (require.main === module) {
  main().catch(error => {
    const secrets = [
      process.env.DATABASE_URL,
      process.env.NV_RESTORE_DATABASE_URL,
      process.env.NV_BACKUP_KEY_BASE64
    ];
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: redactErrorMessage(error && error.message, secrets)
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  assertSafeOutputDirectory,
  assertRestoreTargetDifferent,
  assertIsolatedRestoreTarget,
  databaseEnvironment,
  redactErrorMessage,
  restoreTargetFingerprint,
  main
};
