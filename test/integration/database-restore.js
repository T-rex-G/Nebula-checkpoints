'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Client } = require('pg');
const { runMigrations, loadMigrations } = require('../../src/migrations');
const { restoreCommand } = require('../../scripts/alpha-db');
const { validateBackupResult, validateRestoreResult } = require('../../ci/run-alpha17-restore-validation');

const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');

// A test-only PostgreSQL SSLRequest bridge lets the standard PostgreSQL CI
// service use a short-lived trusted certificate. Both CLI and Node clients do
// real certificate/hostname verification; only the local upstream is plaintext.
// This proves dump/encryption/restore contracts, not Neon ownership or hosting.
async function tlsBridge(upstream, directory) {
  const key = path.join(directory, 'server.key');
  const cert = path.join(directory, 'server.crt');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', key, '-out', cert], { timeout: 10000 });
  fs.chmodSync(key, 0o600);
  const secureContext = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  const sockets = new Set();
  function track(socket) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  }
  const server = net.createServer(socket => {
    track(socket);
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let prefix = Buffer.alloc(0);
    function negotiate(chunk) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 8) return;
      socket.removeListener('data', negotiate);
      if (prefix.length !== 8 || prefix.readUInt32BE(0) !== 8 || prefix.readUInt32BE(4) !== 80877103) {
        socket.destroy(); return;
      }
      socket.write('S');
      const secured = track(new tls.TLSSocket(socket, { isServer: true, secureContext }));
      const database = track(net.connect({ host: upstream.hostname, port: Number(upstream.port || 5432) }));
      const close = () => { secured.destroy(); database.destroy(); };
      secured.on('error', close);
      database.on('error', close);
      secured.on('close', () => database.destroy());
      database.on('close', () => secured.destroy());
      secured.pipe(database).pipe(secured);
    }
    socket.on('data', negotiate);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { cert, port: server.address().port, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

async function main() {
  if (!process.env.NV_TEST_DATABASE_URL) throw new Error('NV_TEST_DATABASE_URL is required for restore integration');
  const adminUrl = new URL(process.env.NV_TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(adminUrl.hostname)) throw new Error('Restore integration requires a disposable loopback PostgreSQL server');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-restore-integration-'));
  const sourceName = `nv_backup_${crypto.randomBytes(8).toString('hex')}`;
  const targetName = `nv_restore_${crypto.randomBytes(8).toString('hex')}`;
  const created = [];
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000, query_timeout: 10000 });
  let bridge;
  try {
    await admin.connect();
    for (const name of [sourceName, targetName]) { await admin.query(`CREATE DATABASE ${name}`); created.push(name); }
    const urlFor = name => { const url = new URL(adminUrl); url.pathname = `/${name}`; url.searchParams.set('sslmode', 'disable'); return url.toString(); };
    const source = new Client({ connectionString: urlFor(sourceName) });
    await source.connect();
    try {
      await runMigrations(source, { directory: path.join(root, 'db/migrations'), logger: { info() {} } });
      await source.query('CREATE TABLE restore_probe(id integer PRIMARY KEY, value text NOT NULL)');
      await source.query('INSERT INTO restore_probe VALUES ($1, $2)', [7, 'Restored through encryption Ω']);
    } finally { await source.end(); }
    bridge = await tlsBridge(adminUrl, directory);
    const secured = name => {
      const url = new URL(adminUrl);
      url.hostname = '127.0.0.1'; url.port = String(bridge.port); url.pathname = `/${name}`;
      url.search = '?sslmode=verify-full';
      return url.toString();
    };
    const env = { PATH: process.env.PATH, PGSSLROOTCERT: bridge.cert,
      DATABASE_URL: secured(sourceName), NV_RESTORE_DATABASE_URL: secured(targetName),
      NV_BACKUP_KEY_BASE64: crypto.randomBytes(32).toString('base64'), NEON_API_KEY: 'local-adapter-only',
      NV_COHORT_NEON_PROJECT_ID: 'local-project', NV_COHORT_NEON_BRANCH_ID: 'br-local-source',
      NV_RESTORE_NEON_PROJECT_ID: 'local-project', NV_RESTORE_NEON_BRANCH_ID: 'br-local-restore',
      NV_RESTORE_TARGET_KIND: 'isolated-neon-branch', NV_RESTORE_TARGET_FINGERPRINT: '0'.repeat(64) };
    const outputDir = path.join(directory, 'backup');
    const command = async args => {
      const result = await execute(process.execPath, [path.join(root, 'scripts/alpha-db.js'), ...args],
        { cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout);
    };
    const latest = loadMigrations(path.join(root, 'db/migrations')).at(-1).id;
    const backup = validateBackupResult(await command(['backup', '--output-dir', outputDir]), outputDir, latest);
    assert.throws(() => validateBackupResult({ ...backup, schemaVersion: '015_alpha_privacy' }, outputDir, latest), /contract/);
    const verified = await command(['verify', '--backup', backup.backupPath, '--manifest', backup.manifestPath]);
    assert.equal(verified.plaintextSha256, backup.plaintextSha256);
    let restored;
    const restore = () => restoreCommand({ backup: backup.backupPath, manifest: backup.manifestPath }, env, {
      // Only the Neon control-plane check is replaced. This adapter authorizes
      // precisely the two scratch databases this test just created.
      async assertIsolatedRestoreTargetImpl(sourceUrl, targetUrl) {
        assert.equal(sourceUrl, secured(sourceName)); assert.equal(targetUrl, secured(targetName));
        assert.notEqual(sourceName, targetName);
      },
      printResultImpl(result) { restored = result; }
    });
    const key = env.NV_BACKUP_KEY_BASE64;
    env.NV_BACKUP_KEY_BASE64 = crypto.randomBytes(32).toString('base64');
    await assert.rejects(restore(), /authentic|decrypt|Unsupported state/i);
    env.NV_BACKUP_KEY_BASE64 = key;
    await restore();
    validateRestoreResult(restored, latest);
    assert.throws(() => validateRestoreResult({ ...restored, migration: '015_alpha_privacy' }, latest), /contract/);
    const target = new Client({ connectionString: urlFor(targetName) });
    await target.connect();
    try { assert.deepEqual((await target.query('SELECT * FROM restore_probe')).rows, [{ id: 7, value: 'Restored through encryption Ω' }]); }
    finally { await target.end(); }
    console.log(JSON.stringify({ ok: true, migration: latest, backupCli: true, verifyCli: true,
      encryptedRoundTrip: true, realPgRestore: true, restoredRowVerified: true, liveNeonQualification: false }));
  } finally {
    if (bridge) await bridge.close();
    for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
