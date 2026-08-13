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
    DATABASE_URL: 'must-disappear',
    NV_BACKUP_KEY_BASE64: 'must-disappear',
    NEON_API_KEY: 'must-disappear'
  }
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
    connectDatabaseImpl: async databaseUrl => {
      assert.strictEqual(databaseUrl, restoreDatabaseUrl);
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
