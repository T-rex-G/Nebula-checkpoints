'use strict';

const assert = require('assert');
const {
  DATABASE_VERIFICATION_OPTIONS,
  parseArgs,
  assertSafeOutputDirectory,
  assertRestoreTargetDifferent,
  assertIsolatedRestoreTarget,
  databaseEnvironment,
  databaseConnectionString,
  redactErrorMessage,
  restoreTargetFingerprint,
  migrateCommand,
  restoreCommand
} = require('../scripts/alpha-db');

assert(DATABASE_VERIFICATION_OPTIONS.connectionTimeoutMillis > 0,
  'migration and restore database connections must have a finite connection timeout');
assert(DATABASE_VERIFICATION_OPTIONS.statement_timeout > 0,
  'migration and restore verification statements must have a finite server-side timeout');
assert(
  DATABASE_VERIFICATION_OPTIONS.query_timeout
    > DATABASE_VERIFICATION_OPTIONS.statement_timeout,
  'the client query timeout must leave time for the server statement timeout to cancel first'
);
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

const sourceDatabaseUrl = 'postgresql://source:one@ep-source-pooler.us-east-2.aws.neon.tech/cohort?sslmode=verify-full';
const restoreDatabaseUrl = 'postgresql://restore:two@ep-restore.us-east-2.aws.neon.tech/cohort_restore?sslmode=verify-full';
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
assert.match(restoreFingerprint, /^[0-9a-f]{64}$/);
assert.throws(
  () => restoreTargetFingerprint(sourceDatabaseUrl, restoreDatabaseUrl, {
    ...restoreContext,
    restoreNeonBranchId: restoreContext.cohortNeonBranchId
  }),
  /isolated Neon branch must differ/i,
  'the preview fingerprint must reject the cohort branch'
);
assert.throws(
  () => restoreTargetFingerprint(sourceDatabaseUrl, restoreDatabaseUrl, {
    ...restoreContext,
    cohortNeonBranchId: restoreContext.restoreNeonBranchId
  }),
  /isolated Neon branch must differ/i,
  'the preview fingerprint must reject a cohort declaration that aliases the restore branch'
);
assert.notStrictEqual(
  restoreTargetFingerprint(
    sourceDatabaseUrl.replace('source:one@', 'source-reviewer:one@'),
    restoreDatabaseUrl,
    restoreContext
  ),
  restoreFingerprint,
  'the reviewed fingerprint must bind the source database role'
);
assert.notStrictEqual(
  restoreTargetFingerprint(
    sourceDatabaseUrl,
    restoreDatabaseUrl.replace('restore:two@', 'restore-reviewer:two@'),
    restoreContext
  ),
  restoreFingerprint,
  'the reviewed fingerprint must bind the restore database role'
);
assert.throws(
  () => assertRestoreTargetDifferent(
    'postgresql://source:one@db.example/db?sslmode=verify-full',
    'postgresql://restore:two@db.example/db?sslmode=verify-full'
  ),
  /must differ/
);

const childEnv = databaseEnvironment(
  'postgresql://operator:secret@db.example:5433/cohort?sslmode=verify-full',
  {
    PATH: '/usr/bin',
    PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt',
    DATABASE_URL: 'must-disappear',
    NV_BACKUP_KEY_BASE64: 'must-disappear',
    NEON_API_KEY: 'must-disappear'
  }
);
assert.deepStrictEqual(childEnv, {
  PATH: '/usr/bin',
  PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt',
  PGHOST: 'db.example',
  PGPORT: '5433',
  PGUSER: 'operator',
  PGPASSWORD: 'secret',
  PGDATABASE: 'cohort',
  PGSSLMODE: 'verify-full'
});
assert.strictEqual(
  new URL(databaseConnectionString(
    'postgresql://operator:secret@db.example/cohort?sslmode=verify-full',
    { PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt' }
  )).searchParams.get('sslrootcert'),
  '/etc/ssl/certs/ca-certificates.crt',
  'Node pg must use the same explicit trusted CA as libpq children'
);
assert.strictEqual(
  databaseEnvironment(
    'postgresql://operator:secret@db.example/cohort?sslmode=verify-full&sslrootcert=%2Ftmp%2Fprivate-ca.pem',
    { PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt' }
  ).PGSSLROOTCERT,
  '/tmp/private-ca.pem',
  'an explicit connection-string CA must be preserved for libpq children'
);
assert.throws(
  () => databaseEnvironment(
    'postgresql://operator:secret@db.example/cohort?sslmode=verify-full&sslrootcert=system'
  ),
  /absolute trusted CA file/i
);
assert.throws(
  () => databaseEnvironment('postgresql://operator:secret@db.example/cohort?sslmode=disable'),
  /certificate|sslmode/i
);
for (const insecureUrl of [
  'postgresql://operator:secret@db.example/cohort',
  'postgresql://operator:secret@db.example/cohort?sslmode=require',
  'postgresql://operator:secret@db.example/cohort?sslmode=verify-ca'
]) {
  assert.throws(() => databaseEnvironment(insecureUrl), /sslmode=verify-full/i);
}
const redacted = redactErrorMessage(
  'failed for postgresql://operator:secret@db.example/cohort with must-disappear',
  ['must-disappear']
);
assert(!redacted.includes('secret'));
assert(!redacted.includes('must-disappear'));

const neonApiKey = ['neon', 'operator', 'fixture', '0123456789abcdef'].join('-');
const controlPlaneUris = new Map([
  [restoreContext.cohortNeonBranchId, sourceDatabaseUrl],
  [restoreContext.restoreNeonBranchId, restoreDatabaseUrl]
]);

function ownershipDependencies(overrides = {}) {
  const requests = [];
  let sessionQueries = 0;
  return {
    requests,
    get sessionQueries() { return sessionQueries; },
    neonApiKey,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.strictEqual(url.origin, 'https://console.neon.tech');
      assert.strictEqual(init.redirect, 'error');
      assert.strictEqual(init.headers.authorization, `Bearer ${neonApiKey}`);
      const branchId = url.searchParams.get('branch_id');
      const expectedProject = branchId === restoreContext.cohortNeonBranchId
        ? restoreContext.cohortNeonProjectId
        : restoreContext.restoreNeonProjectId;
      assert.strictEqual(url.pathname, `/api/v2/projects/${expectedProject}/connection_uri`);
      assert.strictEqual(
        url.searchParams.get('database_name'),
        branchId === restoreContext.cohortNeonBranchId ? 'cohort' : 'cohort_restore'
      );
      assert.strictEqual(
        url.searchParams.get('role_name'),
        branchId === restoreContext.cohortNeonBranchId ? 'source' : 'restore'
      );
      assert.strictEqual(
        url.searchParams.get('pooled'),
        branchId === restoreContext.cohortNeonBranchId ? 'true' : 'false'
      );
      return new Response(JSON.stringify({ uri: controlPlaneUris.get(branchId) }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    connectDatabaseImpl: async (databaseUrl, options) => {
      assert.strictEqual(databaseUrl, restoreDatabaseUrl);
      assert.deepStrictEqual(options, DATABASE_VERIFICATION_OPTIONS);
      return {
        async query(statement) {
          sessionQueries += 1;
          assert.match(statement, /current_database\(\).*current_user/is);
          return { rows: [{ database: 'cohort_restore', role: 'restore' }] };
        },
        async end() {}
      };
    },
    ...overrides
  };
}

(async () => {
  const observedVerificationOptions = [];
  const fakeClient = {
    async query() {
      return { rows: [{ testers: '0', invites: '0', feedback: '0', cleanup_tasks: '0', deletion_requests: '0' }] };
    },
    async end() {}
  };
  const connectDatabaseImpl = async (_databaseUrl, options) => {
    observedVerificationOptions.push(options);
    return fakeClient;
  };
  await migrateCommand({ backupManifest: '/tmp/nvx-backups/backup.nvxbackup.json' }, {
    DATABASE_URL: sourceDatabaseUrl,
    NV_BACKUP_KEY_BASE64: 'fixture-key'
  }, {
    decodeBackupKeyImpl: () => Buffer.alloc(32),
    readBackupRecordImpl: async () => ({
      record: { backupFile: 'backup.nvxenc' },
      manifest: { metadata: { createdAt: new Date().toISOString() } }
    }),
    withVerifiedPlaintextImpl: async (_input, operation) => operation('/tmp/verified.dump'),
    connectDatabaseImpl,
    runMigrationsImpl: async () => ({ applied: [] }),
    verifyMigrationsImpl: async () => ({ ok: true, expectedLatest: '015_alpha_privacy' }),
    printResultImpl() {}
  });
  await restoreCommand({
    backup: '/tmp/nvx-backups/backup.nvxenc',
    manifest: '/tmp/nvx-backups/backup.nvxbackup.json'
  }, {
    DATABASE_URL: sourceDatabaseUrl,
    NV_RESTORE_DATABASE_URL: restoreDatabaseUrl,
    NV_BACKUP_KEY_BASE64: 'fixture-key',
    NEON_API_KEY: 'fixture-neon-key',
    NV_COHORT_NEON_PROJECT_ID: restoreContext.cohortNeonProjectId,
    NV_COHORT_NEON_BRANCH_ID: restoreContext.cohortNeonBranchId,
    NV_RESTORE_NEON_PROJECT_ID: restoreContext.restoreNeonProjectId,
    NV_RESTORE_NEON_BRANCH_ID: restoreContext.restoreNeonBranchId,
    NV_RESTORE_TARGET_KIND: restoreContext.restoreTargetKind,
    NV_RESTORE_TARGET_FINGERPRINT: restoreFingerprint
  }, {
    assertIsolatedRestoreTargetImpl: async () => true,
    decodeBackupKeyImpl: () => Buffer.alloc(32),
    readBackupRecordImpl: async () => ({ manifest: {} }),
    withVerifiedPlaintextImpl: async (_input, operation) => operation('/tmp/verified.dump'),
    spawnCheckedImpl: async () => true,
    connectDatabaseImpl,
    verifyMigrationsImpl: async () => ({ ok: true, expectedLatest: '015_alpha_privacy' }),
    printResultImpl() {}
  });
  assert.strictEqual(observedVerificationOptions.length, 2);
  for (const options of observedVerificationOptions) {
    assert.deepStrictEqual(options, DATABASE_VERIFICATION_OPTIONS,
      'migrate and restore must inject the finite database verification timeouts');
  }

  const dependencies = ownershipDependencies();
  const verified = await assertIsolatedRestoreTarget(
    sourceDatabaseUrl,
    restoreDatabaseUrl,
    { ...restoreContext, restoreTargetFingerprint: restoreFingerprint },
    dependencies
  );
  assert.strictEqual(verified.fingerprint, restoreFingerprint);
  assert.strictEqual(dependencies.requests.length, 2, 'both declared Neon branches must be control-plane bound');
  assert.strictEqual(dependencies.sessionQueries, 1, 'the destructive target must be verified through a live session');

  const missingApiKey = ownershipDependencies({ neonApiKey: '' });
  await assert.rejects(
    () => assertIsolatedRestoreTarget(
      sourceDatabaseUrl,
      restoreDatabaseUrl,
      { ...restoreContext, restoreTargetFingerprint: restoreFingerprint },
      missingApiKey
    ),
    /NEON_API_KEY is required/i
  );
  assert.strictEqual(missingApiKey.requests.length, 0, 'a missing Neon API key must fail before control-plane access');
  assert.strictEqual(missingApiKey.sessionQueries, 0, 'a missing Neon API key must fail before target-session access');

  for (const [label, fetchImpl, expected] of [
    [
      'non-200 status',
      async () => new Response(JSON.stringify({ error: 'synthetic outage' }), { status: 503 }),
      /control-plane ownership verification failed/i
    ],
    [
      'oversized response',
      async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) }
      }),
      /response exceeds the safe limit/i
    ],
    [
      'missing connection URI',
      async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      /control-plane response is invalid/i
    ]
  ]) {
    const rejected = ownershipDependencies({ fetchImpl });
    await assert.rejects(
      () => assertIsolatedRestoreTarget(
        sourceDatabaseUrl,
        restoreDatabaseUrl,
        { ...restoreContext, restoreTargetFingerprint: restoreFingerprint },
        rejected
      ),
      expected,
      `${label} must reject restore ownership verification`
    );
    assert.strictEqual(rejected.sessionQueries, 0, `${label} must fail before target-session access`);
  }

  await assert.rejects(
    () => assertIsolatedRestoreTarget(sourceDatabaseUrl, restoreDatabaseUrl, {
      ...restoreContext,
      restoreNeonBranchId: restoreContext.cohortNeonBranchId,
      restoreTargetFingerprint: restoreFingerprint
    }, ownershipDependencies()),
    /isolated Neon branch must differ/i
  );
  for (const malformed of ['f'.repeat(64), 'abc', 'z'.repeat(64)]) {
    await assert.rejects(
      () => assertIsolatedRestoreTarget(sourceDatabaseUrl, restoreDatabaseUrl, {
        ...restoreContext,
        restoreTargetFingerprint: malformed
      }, ownershipDependencies()),
      /fingerprint does not match/i
    );
  }

  const insecureTarget = restoreDatabaseUrl.replace('sslmode=verify-full', 'sslmode=disable');
  const insecureDependencies = ownershipDependencies();
  assert.throws(
    () => restoreTargetFingerprint(sourceDatabaseUrl, insecureTarget, restoreContext),
    /sslmode=verify-full/i
  );
  await assert.rejects(
    () => assertIsolatedRestoreTarget(
      sourceDatabaseUrl,
      insecureTarget,
      { ...restoreContext, restoreTargetFingerprint: 'a'.repeat(64) },
      insecureDependencies
    ),
    /sslmode=verify-full/i
  );
  assert.strictEqual(insecureDependencies.requests.length, 0, 'invalid TLS must fail before control-plane access');

  const mismatchedControlPlane = ownershipDependencies({
    fetchImpl: async (url, init) => {
      const expected = controlPlaneUris.get(url.searchParams.get('branch_id'));
      const mismatched = expected.replace('ep-restore.us-east-2.aws.neon.tech', 'ep-wrong.us-east-2.aws.neon.tech');
      return new Response(JSON.stringify({ uri: mismatched }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await assert.rejects(
    () => assertIsolatedRestoreTarget(
      sourceDatabaseUrl,
      restoreDatabaseUrl,
      { ...restoreContext, restoreTargetFingerprint: restoreFingerprint },
      mismatchedControlPlane
    ),
    /control-plane connection identity/i
  );

  const mismatchedSession = ownershipDependencies({
    connectDatabaseImpl: async () => ({
      async query() { return { rows: [{ database: 'cohort_restore', role: 'wrong-role' }] }; },
      async end() {}
    })
  });
  await assert.rejects(
    () => assertIsolatedRestoreTarget(
      sourceDatabaseUrl,
      restoreDatabaseUrl,
      { ...restoreContext, restoreTargetFingerprint: restoreFingerprint },
      mismatchedSession
    ),
    /live restore session identity/i
  );

  console.log('alpha database CLI tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
