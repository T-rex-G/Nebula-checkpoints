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
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR',
  'PGSSLROOTCERT'
]);
const NEON_API_ORIGIN = 'https://console.neon.tech';
const NEON_RESPONSE_MAX_BYTES = 64 * 1024;
const NEON_REQUEST_TIMEOUT_MS = 10_000;

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
  let database;
  try { database = decodeURIComponent(url.pathname.replace(/^\//, '')); }
  catch { throw new TypeError(`${label} contains invalid encoding`); }
  if (!database || database.includes('/')) throw new TypeError(`${label} must name one database`);
  return { url, database };
}

function neonConnectionIdentity(raw, label = 'database URL', options = {}) {
  const { url, database } = parseDatabaseUrl(raw, label);
  let role;
  try { role = decodeURIComponent(url.username || ''); }
  catch { throw new TypeError(`${label} contains invalid role encoding`); }
  if (!role) throw new TypeError(`${label} must name one database role`);
  const hostname = url.hostname.toLowerCase();
  const sslmode = String(url.searchParams.get('sslmode') || '').toLowerCase();
  if (options.requireVerifiedTls !== false && sslmode !== 'verify-full') {
    throw new TypeError(`${label} must explicitly use sslmode=verify-full for certificate and hostname verification`);
  }
  if (options.requireVerifiedTls === false && sslmode && !['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    throw new TypeError(`${label} contains an invalid TLS mode`);
  }
  return Object.freeze({
    hostname,
    port: url.port || '5432',
    database,
    role,
    sslmode,
    pooled: hostname.split('.')[0].endsWith('-pooler')
  });
}

function sameNeonConnectionIdentity(left, right) {
  return left.hostname === right.hostname
    && left.port === right.port
    && left.database === right.database
    && left.role === right.role
    && left.pooled === right.pooled;
}

function neonConnectionIdentitySha256(raw, projectId, branchId, label = 'database URL') {
  const project = String(projectId || '').trim().toLowerCase();
  const branch = String(branchId || '').trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9-]{2,127}$/.test(project) ||
    !/^br-[a-z0-9][a-z0-9-]{2,127}$/.test(branch)
  ) {
    throw new TypeError(`${label} identity requires valid Neon project and branch IDs`);
  }
  const preimage = {
    schemaVersion: 'nvx-neon-connection-identity.v1',
    connection: neonConnectionIdentity(raw, label),
    projectId: project,
    branchId: branch
  };
  return crypto.createHash('sha256').update(JSON.stringify(preimage), 'utf8').digest('hex');
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
  const sourceIdentity = neonConnectionIdentity(source, 'DATABASE_URL');
  const targetIdentity = neonConnectionIdentity(target, 'NV_RESTORE_DATABASE_URL');
  if (
    context.cohortNeonProjectId === context.restoreNeonProjectId &&
    context.cohortNeonBranchId === context.restoreNeonBranchId
  ) {
    throw new TypeError('The isolated Neon branch must differ from the cohort branch');
  }
  const preimage = {
    schemaVersion: 'nvx-isolated-restore-target.v2',
    source: {
      connectionIdentity: sourceIdentity,
      neonProjectId: context.cohortNeonProjectId,
      neonBranchId: context.cohortNeonBranchId
    },
    target: {
      connectionIdentity: targetIdentity,
      neonProjectId: context.restoreNeonProjectId,
      neonBranchId: context.restoreNeonBranchId,
      kind: context.restoreTargetKind
    }
  };
  return crypto.createHash('sha256').update(JSON.stringify(preimage), 'utf8').digest('hex');
}

function assertReviewedRestoreFingerprint(source, target, input) {
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

async function readBoundedJsonResponse(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > NEON_RESPONSE_MAX_BYTES) {
    throw new TypeError('Neon control-plane response exceeds the safe limit');
  }
  if (!response.body) throw new TypeError('Neon control-plane response is empty');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > NEON_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new TypeError('Neon control-plane response exceeds the safe limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new TypeError('Neon control-plane response is empty');
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new TypeError('Neon control-plane response is invalid');
  }
}

async function retrieveNeonConnectionIdentity({
  projectId,
  branchId,
  configuredUrl,
  neonApiKey,
  fetchImpl,
  timeoutMs
}) {
  const expected = neonConnectionIdentity(configuredUrl);
  const endpoint = new URL(`/api/v2/projects/${encodeURIComponent(projectId)}/connection_uri`, NEON_API_ORIGIN);
  endpoint.searchParams.set('branch_id', branchId);
  endpoint.searchParams.set('database_name', expected.database);
  endpoint.searchParams.set('role_name', expected.role);
  endpoint.searchParams.set('pooled', String(expected.pooled));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let record;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${neonApiKey}`
      },
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status !== 200) {
      throw new TypeError('Neon control-plane ownership verification failed');
    }
    record = await readBoundedJsonResponse(response);
  } catch (error) {
    if (error instanceof TypeError && /^Neon control-plane (?:ownership|response)/.test(error.message)) {
      throw error;
    }
    throw new TypeError('Neon control-plane ownership verification failed');
  } finally {
    clearTimeout(timer);
  }
  let observed;
  try {
    observed = neonConnectionIdentity(record && record.uri, 'Neon control-plane connection URI', {
      requireVerifiedTls: false
    });
  }
  catch { throw new TypeError('Neon control-plane response is invalid'); }
  if (!sameNeonConnectionIdentity(expected, observed)) {
    throw new TypeError('Configured database URL does not match the Neon control-plane connection identity');
  }
  return expected;
}

async function verifyNeonRestoreOwnership(source, target, input, dependencies = {}) {
  const context = normalizeRestoreContext(input);
  const neonApiKey = String(dependencies.neonApiKey || '').trim();
  if (!neonApiKey) throw new TypeError('NEON_API_KEY is required for restore ownership verification');
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const connectDatabaseImpl = dependencies.connectDatabaseImpl || (databaseUrl => connectDatabase(databaseUrl, {
    connectionTimeoutMillis: NEON_REQUEST_TIMEOUT_MS,
    query_timeout: NEON_REQUEST_TIMEOUT_MS
  }, dependencies.databaseEnv || process.env));
  const timeoutMs = Number.isInteger(dependencies.timeoutMs) && dependencies.timeoutMs > 0
    ? Math.min(dependencies.timeoutMs, NEON_REQUEST_TIMEOUT_MS)
    : NEON_REQUEST_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function' || typeof connectDatabaseImpl !== 'function') {
    throw new TypeError('Restore ownership verification dependencies are unavailable');
  }
  // Validate both URLs completely before making either control-plane request.
  neonConnectionIdentity(source, 'DATABASE_URL');
  neonConnectionIdentity(target, 'NV_RESTORE_DATABASE_URL');
  const [sourceIdentity, targetIdentity] = await Promise.all([
    retrieveNeonConnectionIdentity({
      projectId: context.cohortNeonProjectId,
      branchId: context.cohortNeonBranchId,
      configuredUrl: source,
      neonApiKey,
      fetchImpl,
      timeoutMs
    }),
    retrieveNeonConnectionIdentity({
      projectId: context.restoreNeonProjectId,
      branchId: context.restoreNeonBranchId,
      configuredUrl: target,
      neonApiKey,
      fetchImpl,
      timeoutMs
    })
  ]);
  const client = await connectDatabaseImpl(target);
  try {
    const result = await client.query('SELECT current_database() AS database, current_user AS role');
    const observed = result && result.rows && result.rows[0];
    if (
      !observed ||
      String(observed.database || '') !== targetIdentity.database ||
      String(observed.role || '') !== targetIdentity.role
    ) {
      throw new TypeError('The live restore session identity does not match the reviewed target');
    }
  } finally {
    await client.end().catch(() => {});
  }
  return Object.freeze({ source: sourceIdentity, target: targetIdentity });
}

async function assertIsolatedRestoreTarget(source, target, input, dependencies = {}) {
  const reviewed = assertReviewedRestoreFingerprint(source, target, input);
  await verifyNeonRestoreOwnership(source, target, reviewed, dependencies);
  return reviewed;
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

function trustedSslRootCertificate(url, baseEnv = process.env) {
  const urlValue = url.searchParams.get('sslrootcert');
  const configured = String(urlValue === null ? baseEnv.PGSSLROOTCERT || '' : urlValue).trim();
  if (!configured) {
    if (urlValue !== null) throw new TypeError('sslrootcert must name an absolute trusted CA file');
    return '';
  }
  if (
    /[\u0000\r\n]/.test(configured) ||
    !path.isAbsolute(configured)
  ) {
    throw new TypeError('PGSSLROOTCERT/sslrootcert must name an absolute trusted CA file');
  }
  return path.normalize(configured);
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
  const sslmode = String(url.searchParams.get('sslmode') || '').toLowerCase();
  if (sslmode !== 'verify-full') {
    throw new TypeError('PostgreSQL URLs must explicitly use sslmode=verify-full for certificate and hostname verification');
  }
  env.PGSSLMODE = sslmode;
  const sslRootCertificate = trustedSslRootCertificate(url, baseEnv);
  if (sslRootCertificate) env.PGSSLROOTCERT = sslRootCertificate;
  else delete env.PGSSLROOTCERT;
  return env;
}

function databaseConnectionString(raw, baseEnv = process.env) {
  const childEnv = databaseEnvironment(raw, baseEnv);
  const { url } = parseDatabaseUrl(raw);
  if (childEnv.PGSSLROOTCERT && !url.searchParams.has('sslrootcert')) {
    url.searchParams.set('sslrootcert', childEnv.PGSSLROOTCERT);
  }
  return url.toString();
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
      'postgresql://localhost/verification-only?sslmode=verify-full',
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

async function connectDatabase(databaseUrl, options = {}, env = process.env) {
  const { Client } = require('pg');
  const client = new Client({ ...options, connectionString: databaseConnectionString(databaseUrl, env) });
  await client.connect();
  return client;
}

async function migrateCommand(args, env) {
  const databaseUrl = requireEnvironment(env, 'DATABASE_URL');
  databaseEnvironment(databaseUrl, env);
  const key = decodeBackupKey(requireEnvironment(env, 'NV_BACKUP_KEY_BASE64'));
  const { record, manifest } = await readBackupRecord(args.backupManifest);
  assertFreshBackup(manifest);
  const backupPath = backupPathFromRecord(args.backupManifest, record);
  await withVerifiedPlaintext({ backupPath, manifest, key }, async () => {});
  const client = await connectDatabase(databaseUrl, {}, env);
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
  await assertIsolatedRestoreTarget(sourceUrl, targetUrl, restoreContextFromEnvironment(env), {
    neonApiKey: requireEnvironment(env, 'NEON_API_KEY'),
    databaseEnv: env
  });
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
  const client = await connectDatabase(targetUrl, {}, env);
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

async function restoreTargetCommand(env) {
  const sourceUrl = requireEnvironment(env, 'DATABASE_URL');
  const targetUrl = requireEnvironment(env, 'NV_RESTORE_DATABASE_URL');
  assertRestoreTargetDifferent(sourceUrl, targetUrl);
  const context = normalizeRestoreContext(restoreContextFromEnvironment(env));
  await verifyNeonRestoreOwnership(sourceUrl, targetUrl, context, {
    neonApiKey: requireEnvironment(env, 'NEON_API_KEY'),
    databaseEnv: env
  });
  const fingerprint = restoreTargetFingerprint(sourceUrl, targetUrl, context);
  printResult({
    command: 'restore-target',
    kind: context.restoreTargetKind,
    cohortNeonProjectId: context.cohortNeonProjectId,
    cohortNeonBranchId: context.cohortNeonBranchId,
    restoreNeonProjectId: context.restoreNeonProjectId,
    restoreNeonBranchId: context.restoreNeonBranchId,
    restoreDatabaseIdentitySha256: neonConnectionIdentitySha256(
      targetUrl,
      context.restoreNeonProjectId,
      context.restoreNeonBranchId,
      'NV_RESTORE_DATABASE_URL'
    ),
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
      process.env.NV_BACKUP_KEY_BASE64,
      process.env.NEON_API_KEY
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
  verifyNeonRestoreOwnership,
  neonConnectionIdentity,
  neonConnectionIdentitySha256,
  databaseEnvironment,
  databaseConnectionString,
  redactErrorMessage,
  restoreTargetFingerprint,
  main
};
